/**
 * Cliente da Epic Games Store: login, biblioteca, tempo de jogo e wishlist.
 *
 * A Epic NÃO tem API pública pra terceiro ler biblioteca. O caminho é o
 * mesmo que o Legendary, o Heroic e o Playnite usam há anos: o cliente OAuth
 * do PRÓPRIO launcher da Epic.
 *
 * O login, e por que ele é seguro pra pessoa:
 *   1. Ela entra no site da Epic, neste link (o do launcher):
 *      https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode
 *   2. A página mostra um JSON com `authorizationCode` (32 hex). Ela copia
 *      e cola aqui. A senha nunca passa por nós.
 *   3. O servidor troca o código por tokens (grant_type=authorization_code)
 *      e DESCARTA o código: ele vale uma vez só e por poucos minutos.
 *   4. Guardamos o access token e o refresh token CIFRADOS
 *      (credenciais.ts), como a PSN.
 *
 * ⚠️ O refresh token GIRA a cada renovação: a resposta traz um novo e o
 * antigo pode parar de valer. Quem renova grava na hora (sync-runner.ts),
 * antes de qualquer outra chamada poder falhar. Vida medida por terceiros:
 * access de horas, refresh de meses (não é garantia, a Epic revoga quando
 * a pessoa troca a senha ou sai de todas as sessões).
 *
 * Endpoints (fonte: legendary/api/egs.py, derrod/legendary, e
 * CommonPluginsStores/Epic/EpicApi.cs, Lacro59/playnite-plugincommon):
 *   - token:     POST account-public-service-prod03.ol.epicgames.com/account/api/oauth/token
 *   - biblioteca GET library-service.live.use1a.on.epicgames.com/library/api/public/items (cursor)
 *   - tempo:     GET library-service.../library/api/public/playtime/account/{id}/all
 *   - ofertas:   POST launcher.store.epicgames.com/graphql, Catalog.catalogOffers(namespace)
 *   - catálogo:  GET catalog-public-service-prod06.ol.epicgames.com/.../bulk/items (reserva)
 *   - wishlist:  POST launcher.store.epicgames.com/graphql, Wishlist.wishlistItems
 *
 * O id que CASA com o catálogo é o id da OFERTA (`offerId`): é o `uid` que o
 * IGDB grava em `external_games` pra fonte 26 (Epic Games Store), conferido
 * contra a página da loja em 24/09/2026 (Ready or Not: uid
 * eef3d0539f55422c9bef333d79c04e4c = offerId da página). A biblioteca não
 * traz a oferta, traz o `catalogItemId`; a ponte é a consulta de ofertas por
 * namespace, que lista cada oferta com os itens dela.
 */

/** Cliente OAuth do launcher da Epic (público, embutido no launcher; o mesmo
 *  do Legendary). Não é segredo nosso. */
import { logger } from "../logger";
import { casamentoDoTitulo } from "./titulo-do-jogo";
import { soHttps, type ConquistaLida, type LeituraDoJogo } from "./tipos-de-conquista";

const CLIENTE_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENTE_SEGREDO = "daafbccc737745039dffe53d94fc76cf";
// `btoa` e não Buffer: este arquivo também roda na extensão do navegador.
const BASICO = btoa(`${CLIENTE_ID}:${CLIENTE_SEGREDO}`);

const HOST_OAUTH = "https://account-public-service-prod03.ol.epicgames.com";
const HOST_BIBLIOTECA = "https://library-service.live.use1a.on.epicgames.com";
const HOST_CATALOGO = "https://catalog-public-service-prod06.ol.epicgames.com";
const GRAPHQL = "https://launcher.store.epicgames.com/graphql";
const USER_AGENT = "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live";

/** O link de login que a pessoa abre. Mesmo do Legendary (`get_auth_url`). */
export const LINK_DE_LOGIN_DA_EPIC =
  "https://www.epicgames.com/id/login?redirectUrl=" +
  encodeURIComponent(`https://www.epicgames.com/id/api/redirect?clientId=${CLIENTE_ID}&responseType=code`);

export interface EpicAuth {
  accessToken: string;
  refreshToken: string;
  /** ISO de quando o access token vence. */
  expiresAt: string;
  /** ISO de quando o refresh token vence. */
  refreshExpiresAt: string;
  accountId: string;
  displayName: string | null;
}

/** Algo que se comporta como `fetch`. Injetável pra o smoke rodar com
 *  resposta gravada, sem tocar na Epic. */
export type Buscador = (url: string, init?: RequestInit) => Promise<Response>;
const fetchPadrao: Buscador = (url, init) => fetch(url, init);

async function comPrazo(buscar: Buscador, url: string, init: RequestInit, ms = 12_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await buscar(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Tira o código do que a pessoa colou. Aceita o JSON inteiro da página
 * (`{"redirectUrl":"...","authorizationCode":"...","sid":null}`), só o
 * valor, ou o valor entre aspas. Devolve null se não houver um código com a
 * forma certa (32 caracteres hex): mandar lixo pra Epic só gasta a chamada.
 */
export function extrairCodigoDaEpic(bruta: string): string | null {
  const s = String(bruta ?? "").trim();
  const doJson = /"authorizationCode"\s*:\s*"([^"]*)"/.exec(s)?.[1];
  const candidato = (doJson ?? s).replace(/^["']|["']$/g, "").trim();
  return /^[0-9a-f]{32}$/i.test(candidato) ? candidato.toLowerCase() : null;
}

/** Resposta do endpoint de token, só o que usamos. */
interface RespostaDeToken {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
  refresh_expires_at?: string;
  refresh_expires?: number;
  account_id?: string;
  displayName?: string;
  errorCode?: string;
}

export function tokenParaAuth(j: RespostaDeToken, agora = Date.now()): EpicAuth | null {
  if (!j?.access_token || !j.refresh_token || !j.account_id) return null;
  const expiresAt = j.expires_at ?? new Date(agora + (j.expires_in ?? 3600) * 1000).toISOString();
  const refreshExpiresAt = j.refresh_expires_at ?? new Date(agora + (j.refresh_expires ?? 86_400) * 1000).toISOString();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt,
    refreshExpiresAt,
    accountId: j.account_id,
    displayName: j.displayName ?? null,
  };
}

async function pedirToken(corpo: Record<string, string>, buscar: Buscador): Promise<EpicAuth | null> {
  try {
    const r = await comPrazo(buscar, `${HOST_OAUTH}/account/api/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `basic ${BASICO}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ ...corpo, token_type: "eg1" }).toString(),
    });
    const j = (await r.json().catch(() => ({}))) as RespostaDeToken;
    if (!r.ok) {
      // ⚠️ Só o código do erro vai pro log, nunca o corpo do pedido.
      console.warn("Epic oauth recusou:", r.status, j?.errorCode ?? "");
      return null;
    }
    return tokenParaAuth(j);
  } catch (err) {
    console.error("Epic oauth falhou:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Troca o código de autorização (uma vez só) pelos tokens. */
export function trocarCodigoDaEpic(codigo: string, buscar: Buscador = fetchPadrao): Promise<EpicAuth | null> {
  return pedirToken({ grant_type: "authorization_code", code: codigo }, buscar);
}

/** Renova pelo refresh token. Null quando ele venceu ou foi revogado. */
export function renovarEpic(refreshToken: string, buscar: Buscador = fetchPadrao): Promise<EpicAuth | null> {
  return pedirToken({ grant_type: "refresh_token", refresh_token: refreshToken }, buscar);
}

/**
 * Garante um access token válido, renovando se faltar menos de 5 minutos.
 * Quem chama grava o `auth` novo quando `renovado` (o refresh token girou).
 */
export async function garantirEpicValido(
  auth: EpicAuth,
  buscar: Buscador = fetchPadrao,
): Promise<{ auth: EpicAuth; renovado: boolean } | null> {
  if (Date.now() < new Date(auth.expiresAt).getTime() - 5 * 60_000) return { auth, renovado: false };
  const novo = await renovarEpic(auth.refreshToken, buscar);
  if (!novo) return null;
  // A resposta do refresh às vezes vem sem o displayName: mantém o que havia.
  return { auth: { ...novo, displayName: novo.displayName ?? auth.displayName }, renovado: true };
}

/**
 * Encerra a sessão na própria Epic (o mesmo que o Legendary faz no logout).
 * Chamado ao desconectar, ao reconectar por cima e ao excluir a conta: sem
 * isto, apagar a linha do banco só tirava a sessão de NÓS, e ela continuava
 * viva na Epic até vencer (inclusive em backup).
 *
 * ⚠️ Mata só ESTA sessão. Nunca `killType=OTHERS_*`, que derrubaria o
 * launcher e o navegador da pessoa.
 *
 * Melhor esforço: true quando a Epic confirmou (ou a sessão já não existia),
 * false quando não deu pra confirmar. Nunca lança e nunca loga o token.
 */
export async function encerrarSessaoDaEpic(auth: EpicAuth, buscar: Buscador = fetchPadrao): Promise<boolean> {
  try {
    // Access vencido não serve pra matar a sessão: renova antes, e a
    // sessão nova (que é a mesma conta, girada) é a que morre.
    const valido = await garantirEpicValido(auth, buscar);
    if (!valido) return true; // refresh já recusado: a sessão já está morta
    const token = valido.auth.accessToken;
    const r = await comPrazo(buscar, `${HOST_OAUTH}/account/api/oauth/sessions/kill/${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: { Authorization: `bearer ${token}`, "User-Agent": USER_AGENT },
    }, 8_000);
    if (r.ok || r.status === 401 || r.status === 404) return true;
    console.warn("Epic: encerrar sessão respondeu", r.status);
    return false;
  } catch (err) {
    console.warn("Epic: encerrar sessão falhou:", err instanceof Error ? err.message : "erro");
    return false;
  }
}

// =====================================================================
// Biblioteca
// =====================================================================

/** Um registro da biblioteca da Epic, só o que usamos. */
export interface RegistroDaBiblioteca {
  namespace: string;
  catalogItemId: string;
  appName?: string;
  productId?: string;
  sandboxType?: string;
  recordType?: string;
  acquisitionDate?: string;
}

/** Uma oferta da loja, vinda da consulta por namespace. */
export interface OfertaDaEpic {
  id: string;
  title: string;
  offerType: string | null;
  itens: string[];
  imagem: string | null;
}

/** Metadado do catálogo (reserva pra item sem oferta ativa na loja). */
export interface ItemDoCatalogo {
  title: string;
  dlc: boolean;
  mod: boolean;
  imagem: string | null;
}

/** Um jogo da biblioteca da Epic, pronto pra gravar. */
export interface JogoDaEpic {
  catalogItemId: string;
  namespace: string;
  appName: string | null;
  title: string;
  /** Oferta que representa o jogo (é o id que o IGDB conhece). */
  offerId: string | null;
  imageUrl: string | null;
  /** Minutos; null quando a Epic não informou tempo nenhum. */
  playtimeMinutes: number | null;
}

export class EpicSemAcesso extends Error {
  constructor() { super("epic_sem_acesso"); }
}

async function getAutenticado<T>(url: string, auth: EpicAuth, buscar: Buscador): Promise<T> {
  const r = await comPrazo(buscar, url, {
    headers: { Authorization: `bearer ${auth.accessToken}`, "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (r.status === 401 || r.status === 403) throw new EpicSemAcesso();
  if (!r.ok) throw new Error(`epic ${r.status}`);
  return (await r.json()) as T;
}

/** Todos os registros da biblioteca, seguindo o cursor. Teto de 50 páginas
 *  (uma página tem centenas de itens; é folga, não limite real). */
export async function buscarRegistrosDaEpic(auth: EpicAuth, buscar: Buscador = fetchPadrao): Promise<RegistroDaBiblioteca[]> {
  const out: RegistroDaBiblioteca[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 50; pagina++) {
    const q = new URLSearchParams({ includeMetadata: "true" });
    if (cursor) q.set("cursor", cursor);
    const j = await getAutenticado<{ records?: RegistroDaBiblioteca[]; responseMetadata?: { nextCursor?: string | null } }>(
      `${HOST_BIBLIOTECA}/library/api/public/items?${q}`, auth, buscar);
    out.push(...(j.records ?? []));
    cursor = j.responseMetadata?.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** appName → segundos jogados. Null se a Epic não respondeu (tempo
 *  desconhecido é diferente de zero). */
export async function buscarTempoDaEpic(auth: EpicAuth, buscar: Buscador = fetchPadrao): Promise<Map<string, number> | null> {
  try {
    const j = await getAutenticado<Array<{ artifactId?: string; totalTime?: number }>>(
      `${HOST_BIBLIOTECA}/library/api/public/playtime/account/${encodeURIComponent(auth.accountId)}/all`, auth, buscar);
    if (!Array.isArray(j)) return null;
    const m = new Map<string, number>();
    for (const x of j) if (x.artifactId) m.set(x.artifactId, (m.get(x.artifactId) ?? 0) + Number(x.totalTime ?? 0));
    return m;
  } catch (err) {
    if (err instanceof EpicSemAcesso) throw err;
    console.warn("Epic tempo de jogo indisponível:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Imagem vertical, se houver; senão qualquer uma. */
function escolherImagem(imgs: Array<{ type?: string; url?: string }> | undefined): string | null {
  // Só imagem de verdade: a lista também traz vídeo (com.epicgames.video://).
  imgs = (imgs ?? []).filter((x) => typeof x?.url === "string" && x.url.startsWith("https://"));
  if (!imgs.length) return null;
  const ordem = ["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall", "Thumbnail", "DieselGameBox", "OfferImageWide"];
  for (const tipo of ordem) {
    const i = imgs.find((x) => x.type === tipo && x.url);
    if (i?.url) return i.url;
  }
  return imgs.find((x) => x.url)?.url ?? null;
}

async function graphql<T>(query: string, variables: Record<string, unknown>, buscar: Buscador, auth?: EpicAuth): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": USER_AGENT };
  if (auth) headers.Authorization = `bearer ${auth.accessToken}`;
  const r = await comPrazo(buscar, GRAPHQL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  if (r.status === 401 || r.status === 403) throw new EpicSemAcesso();
  if (!r.ok) throw new Error(`epic graphql ${r.status}`);
  return (await r.json()) as T;
}

const NS_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * As ofertas de cada namespace, em lotes: um pedido carrega até 15
 * namespaces por ALIAS de GraphQL (n0, n1, ...), senão uma biblioteca de 300
 * jogos grátis viraria 300 idas à Epic. É consulta PÚBLICA da loja (sem
 * token).
 *
 * Reserva: com `auth`, o namespace que a GraphQL não resolveu (lote que
 * falhou, alias com erro) é pedido ao serviço de CATÁLOGO
 * (`/namespace/{ns}/offers`), o mesmo backend da biblioteca, que devolve
 * as mesmas ofertas (id, tipo, itens). Em produção a GraphQL responde
 * (medido em 27/09/2026: 70 de 74 namespaces), então isto é rede de
 * segurança, não o caminho comum.
 */
export async function buscarOfertasPorNamespace(
  namespaces: string[],
  buscar: Buscador = fetchPadrao,
  auth?: EpicAuth,
): Promise<Map<string, OfertaDaEpic[]>> {
  const out = new Map<string, OfertaDaEpic[]>();
  const validos = [...new Set(namespaces)].filter((n) => NS_VALIDO.test(n));
  const LOTE = 15;
  for (let i = 0; i < validos.length; i += LOTE) {
    const lote = validos.slice(i, i + LOTE);
    const campos = lote.map((_, k) =>
      `n${k}: catalogOffers(namespace: $ns${k}, params: {count: 100}) { elements { id title offerType items { id } keyImages { type url } } }`);
    const query = `query(${lote.map((_, k) => `$ns${k}: String!`).join(", ")}) { Catalog { ${campos.join(" ")} } }`;
    const variables = Object.fromEntries(lote.map((ns, k) => [`ns${k}`, ns]));
    try {
      const j = await graphql<{ data?: { Catalog?: Record<string, { elements?: any[] } | null> } }>(query, variables, buscar);
      const cat = j.data?.Catalog ?? {};
      lote.forEach((ns, k) => {
        // null = aquele namespace deu erro dentro da resposta: fica de fora
        // pra ser tentado pelo catálogo.
        const bloco = cat[`n${k}`];
        if (bloco) out.set(ns, lerOfertas(bloco.elements ?? []));
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), namespaces: lote.length }, "Epic: ofertas pela loja falharam num lote");
    }
    if (i + LOTE < validos.length) await new Promise((r) => setTimeout(r, 200));
  }

  const faltando = validos.filter((ns) => !out.has(ns));
  if (auth && faltando.length > 0) {
    let pelaReserva = 0;
    for (const ns of faltando) {
      try {
        const ofertas = await ofertasPeloCatalogo(ns, auth, buscar);
        if (ofertas) { out.set(ns, ofertas); pelaReserva++; }
      } catch (err) {
        if (err instanceof EpicSemAcesso) throw err;
        logger.warn({ err: err instanceof Error ? err.message : String(err), ns }, "Epic: ofertas pelo catálogo falharam");
      }
    }
    logger.info({ pelaLoja: validos.length - faltando.length, peloCatalogo: pelaReserva, semOferta: faltando.length - pelaReserva }, "Epic: ofertas por namespace");
  }
  return out;
}

function lerOfertas(els: any[]): OfertaDaEpic[] {
  return els.filter((e) => e?.id).map((e) => ({
    id: String(e.id),
    title: String(e.title ?? ""),
    offerType: e.offerType ? String(e.offerType) : null,
    itens: (e.items ?? []).map((x: { id?: string }) => String(x?.id ?? "")).filter(Boolean),
    imagem: escolherImagem(e.keyImages),
  }));
}

/** As ofertas de UM namespace pelo serviço de catálogo, com o token da
 *  pessoa. Null quando o namespace não existe lá (404). Até 300 ofertas. */
async function ofertasPeloCatalogo(ns: string, auth: EpicAuth, buscar: Buscador): Promise<OfertaDaEpic[] | null> {
  const todas: OfertaDaEpic[] = [];
  for (let start = 0; start < 300; start += 100) {
    const url = `${HOST_CATALOGO}/catalog/api/shared/namespace/${encodeURIComponent(ns)}/offers?start=${start}&count=100`;
    const r = await comPrazo(buscar, url, {
      headers: { Authorization: `bearer ${auth.accessToken}`, "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (r.status === 401 || r.status === 403) throw new EpicSemAcesso();
    if (r.status === 404) return start === 0 ? null : todas;
    if (!r.ok) throw new Error(`epic catálogo ofertas ${r.status}`);
    const j = (await r.json()) as { elements?: any[]; paging?: { total?: number } };
    const els = j.elements ?? [];
    todas.push(...lerOfertas(els));
    if (els.length < 100 || start + 100 >= Number(j.paging?.total ?? 0)) break;
  }
  return todas;
}

/** Reserva: metadado do catálogo pros itens que não têm oferta ativa (jogo
 *  tirado da loja, brinde antigo). Um pedido por namespace, com token. */
export async function buscarItensDoCatalogo(
  auth: EpicAuth,
  porNamespace: Map<string, string[]>,
  buscar: Buscador = fetchPadrao,
): Promise<Map<string, ItemDoCatalogo>> {
  const out = new Map<string, ItemDoCatalogo>();
  for (const [ns, ids] of porNamespace) {
    if (!NS_VALIDO.test(ns) || ids.length === 0) continue;
    const q = new URLSearchParams({ includeDLCDetails: "true", includeMainGameDetails: "true", country: "US", locale: "en-US" });
    for (const id of ids.slice(0, 50)) q.append("id", id);
    try {
      const j = await getAutenticado<Record<string, any>>(
        `${HOST_CATALOGO}/catalog/api/shared/namespace/${encodeURIComponent(ns)}/bulk/items?${q}`, auth, buscar);
      for (const [id, it] of Object.entries(j ?? {})) {
        if (!it || typeof it !== "object") continue;
        const categorias: string[] = (it.categories ?? []).map((c: { path?: string }) => String(c?.path ?? ""));
        out.set(id, {
          title: String(it.title ?? ""),
          dlc: !!it.mainGameItem || categorias.includes("addons"),
          mod: categorias.includes("mods"),
          imagem: escolherImagem(it.keyImages),
        });
      }
    } catch (err) {
      if (err instanceof EpicSemAcesso) throw err;
      console.warn("Epic catálogo falhou num namespace:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** Tipos de oferta que são JOGO. O resto (DLC, ADD_ON, pacote de moeda,
 *  trilha sonora) não entra na biblioteca de jogos. */
const OFERTA_DE_JOGO = new Set(["BASE_GAME", "EDITION", "BUNDLE"]);
const PRIORIDADE_DA_OFERTA: Record<string, number> = { BASE_GAME: 0, EDITION: 1, BUNDLE: 2 };

/**
 * A oferta do JOGO num namespace, pro item da biblioteca que nenhuma oferta
 * contém. Uma oferta base só: é ela. Várias (namespace com mais de um jogo):
 * a que casa com o título do item pela chave de título, senão nenhuma, pra
 * não dar a um jogo o id de outro. Sem base, vale o mesmo com as edições.
 */
export function ofertaBaseDoNamespace(ofertas: OfertaDaEpic[], titulo: string): OfertaDaEpic | null {
  for (const tipo of ["BASE_GAME", "EDITION"]) {
    const doTipo = ofertas.filter((o) => o.offerType === tipo);
    if (doTipo.length === 1) return doTipo[0];
    if (doTipo.length > 1) {
      const porTitulo = doTipo
        .map((o) => ({ o, nota: casamentoDoTitulo(titulo, o.title) }))
        .filter((x) => x.nota > 0)
        .sort((a, b) => b.nota - a.nota);
      return porTitulo[0]?.o ?? null;
    }
  }
  return null;
}

/**
 * A parte PURA da importação: registros + ofertas + catálogo + tempo viram
 * a lista de jogos. Separada de propósito, pra o smoke provar as regras com
 * resposta gravada.
 *
 * Regras (as mesmas do Legendary, `get_non_asset_library_items`):
 * - namespace `ue` (loja de assets do Unreal) e sandbox PRIVATE saem;
 * - registro sem `appName` sai (não é um aplicativo);
 * - DLC, add-on e mod saem: o que importa aqui é o JOGO. Decidido pelo
 *   `offerType` das ofertas que contêm o item e, sem oferta, pelo catálogo
 *   (`mainGameItem`, categoria `addons`/`mods`);
 * - item sem oferta E sem catálogo sai: sem nome não há o que casar.
 * - Jogo pego DE GRAÇA (os brindes semanais da Epic) está na biblioteca
 *   igual a um comprado e vira "Tenho": é posse de verdade, a Epic entrega
 *   o jogo pra sempre.
 *
 * A oferta que representa um item de EDIÇÃO é a BASE_GAME do mesmo
 * namespace, quando existe: quem comprou a Deluxe tem o jogo base, e o IGDB
 * liga o jogo à oferta base.
 *
 * ⚠️ O item que a BIBLIOTECA devolve quase nunca está DENTRO de oferta
 * nenhuma: ele é o executável (`Shenmue 3`, unsearchable, com o `appName`),
 * e a oferta contém outro item, o de "audiência" (`Shenmue III`). Medido na
 * primeira importação real (27/09/2026): 77 itens, 366 ofertas, ZERO itens
 * contidos, ou seja nenhum jogo tinha ganhado id da loja e tudo casava pelo
 * nome. A ponte é o NAMESPACE: sem oferta que contenha o item, vale a
 * oferta base do namespace (`ofertaBaseDoNamespace`).
 */
export function montarJogosDaEpic(
  registros: RegistroDaBiblioteca[],
  ofertas: Map<string, OfertaDaEpic[]>,
  catalogo: Map<string, ItemDoCatalogo>,
  tempo: Map<string, number> | null,
): JogoDaEpic[] {
  const out = new Map<string, JogoDaEpic>();
  for (const r of registros) {
    if (!r?.namespace || !r.catalogItemId) continue;
    if (r.namespace === "ue") continue;
    if (r.sandboxType === "PRIVATE") continue;
    if (!r.appName) continue;

    const doNs = ofertas.get(r.namespace) ?? [];
    const contem = doNs.filter((o) => o.itens.includes(r.catalogItemId));
    let offerId: string | null = null;
    let title = "";
    let imagem: string | null = null;

    if (contem.length > 0) {
      const deJogo = contem
        .filter((o) => o.offerType && OFERTA_DE_JOGO.has(o.offerType))
        .sort((a, b) => (PRIORIDADE_DA_OFERTA[a.offerType!] ?? 9) - (PRIORIDADE_DA_OFERTA[b.offerType!] ?? 9));
      // Só oferta de DLC/add-on contém o item: é DLC.
      if (deJogo.length === 0 && contem.every((o) => o.offerType)) continue;
      const escolhida = deJogo[0] ?? contem[0];
      const base = escolhida.offerType === "EDITION" ? doNs.find((o) => o.offerType === "BASE_GAME") : undefined;
      offerId = (base ?? escolhida).id;
      title = (base ?? escolhida).title || escolhida.title;
      imagem = (base ?? escolhida).imagem ?? escolhida.imagem;
    } else {
      const c = catalogo.get(r.catalogItemId);
      if (!c || !c.title) continue;
      if (c.dlc || c.mod) continue;
      title = c.title;
      imagem = c.imagem;
      offerId = ofertaBaseDoNamespace(doNs, c.title)?.id ?? null;
    }
    if (!title) continue;

    const segundos = tempo ? tempo.get(r.appName) ?? 0 : null;
    out.set(r.catalogItemId, {
      catalogItemId: r.catalogItemId,
      namespace: r.namespace,
      appName: r.appName,
      title: title.slice(0, 500),
      offerId,
      imageUrl: imagem,
      playtimeMinutes: segundos == null ? null : Math.round(segundos / 60),
    });
  }
  return [...out.values()];
}

/** A biblioteca inteira, já no formato de gravar. Lança `EpicSemAcesso`
 *  quando o token não vale (quem chama pede pra reconectar). */
export async function buscarBibliotecaDaEpic(auth: EpicAuth, buscar: Buscador = fetchPadrao): Promise<JogoDaEpic[]> {
  const registros = await buscarRegistrosDaEpic(auth, buscar);
  const candidatos = registros.filter((r) => r?.namespace && r.namespace !== "ue" && r.sandboxType !== "PRIVATE" && r.appName);
  const [ofertas, tempo] = await Promise.all([
    buscarOfertasPorNamespace(candidatos.map((r) => r.namespace), buscar, auth),
    buscarTempoDaEpic(auth, buscar),
  ]);
  // Reserva só pros itens sem nenhuma oferta que os contenha.
  const semOferta = new Map<string, string[]>();
  for (const r of candidatos) {
    const tem = (ofertas.get(r.namespace) ?? []).some((o) => o.itens.includes(r.catalogItemId));
    if (!tem) semOferta.set(r.namespace, [...(semOferta.get(r.namespace) ?? []), r.catalogItemId]);
  }
  const catalogo = semOferta.size > 0 ? await buscarItensDoCatalogo(auth, semOferta, buscar) : new Map();
  const jogos = montarJogosDaEpic(candidatos, ofertas, catalogo, tempo);
  // O que a importação conseguiu das ofertas: é por aqui que se vê, no log de
  // produção, se a loja ou o catálogo estão respondendo do servidor.
  logger.info({
    registros: candidatos.length,
    namespaces: new Set(candidatos.map((r) => r.namespace)).size,
    namespacesComOferta: [...ofertas.values()].filter((l) => l.length > 0).length,
    ofertas: [...ofertas.values()].reduce((s, l) => s + l.length, 0),
    itensSemOferta: [...semOferta.values()].reduce((s, l) => s + l.length, 0),
    jogos: jogos.length,
    jogosComIdDaLoja: jogos.filter((j) => j.offerId).length,
  }, "Epic: biblioteca montada");
  return jogos;
}

// =====================================================================
// Wishlist
// =====================================================================

export interface ItemDaWishlistDaEpic {
  offerId: string;
  namespace: string;
  title: string;
  criadoEm: string | null;
}

const CONSULTA_DA_WISHLIST = `query wishlistQuery {
  Wishlist { wishlistItems { elements { offerId namespace created offer { id title offerType } } } }
}`;

/** Lê a resposta da wishlist. Null quando veio erro (não logado etc.), pra
 *  quem chama distinguir "vazia" de "não deu pra ler". */
export function lerWishlistDaEpic(j: any): ItemDaWishlistDaEpic[] | null {
  const els = j?.data?.Wishlist?.wishlistItems?.elements;
  if (!Array.isArray(els)) return null;
  return els
    .filter((e: any) => e?.offerId)
    .map((e: any) => ({
      offerId: String(e.offerId),
      namespace: String(e.namespace ?? ""),
      title: String(e.offer?.title ?? ""),
      criadoEm: e.created ? String(e.created) : null,
    }));
}

/**
 * A wishlist da pessoa, pela MESMA GraphQL que o launcher usa, com o token
 * dela. Conferido em 24/09/2026: o endpoint responde do servidor (sem o
 * desafio do Cloudflare da loja web) e, sem token, devolve
 * `com.epicgames.wishlist.notLoggedIn`.
 */
export async function buscarWishlistDaEpic(auth: EpicAuth, buscar: Buscador = fetchPadrao): Promise<ItemDaWishlistDaEpic[] | null> {
  try {
    const j = await graphql<any>(CONSULTA_DA_WISHLIST, {}, buscar, auth);
    return lerWishlistDaEpic(j);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Epic: wishlist indisponível");
    return null;
  }
}

// =====================================================================
// Conquistas
// =====================================================================

const CONSULTA_DAS_CONQUISTAS = `query($sandboxId: String!, $locale: String) {
  Achievement {
    productAchievementsRecordBySandbox(sandboxId: $sandboxId, locale: $locale) {
      totalAchievements
      achievements { achievement { name unlockedDisplayName unlockedDescription unlockedIconLink XP } }
    }
  }
}`;

const CONSULTA_DO_JOGADOR = `query($epicAccountId: String!, $sandboxId: String!) {
  PlayerAchievement {
    playerAchievementGameRecordsBySandbox(epicAccountId: $epicAccountId, sandboxId: $sandboxId) {
      records { totalUnlocked playerAchievements { playerAchievement { achievementName unlocked unlockDate } } }
    }
  }
}`;

type DefinicaoDaEpic = { achievement?: { name?: string; unlockedDisplayName?: string; unlockedDescription?: string; unlockedIconLink?: string; XP?: number } };
type ConquistaDoJogadorEpic = { playerAchievement?: { achievementName?: string; unlocked?: boolean; unlockDate?: string } };

/**
 * Junta a lista de conquistas do jogo com as que a pessoa desbloqueou, no
 * formato comum. Separado da busca pra o smoke conferir sem token.
 * O XP da Epic vira os pontos.
 */
export function lerConquistasDaEpic(definicoes: DefinicaoDaEpic[], jogador: ConquistaDoJogadorEpic[]): ConquistaLida[] {
  const quando = new Map<string, string | null>();
  for (const j of jogador) {
    const p = j.playerAchievement;
    if (!p?.achievementName || !p.unlocked) continue;
    const d = p.unlockDate ? new Date(p.unlockDate) : null;
    quando.set(p.achievementName, d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString());
  }
  return definicoes.map((x) => x.achievement ?? {}).filter((a) => a.name).map((a) => ({
    id: a.name!,
    nome: a.unlockedDisplayName || a.name!,
    descricao: a.unlockedDescription ?? "",
    icone: soHttps(a.unlockedIconLink),
    pontos: Number.isFinite(Number(a.XP)) ? Number(a.XP) : 0,
    trueRatio: null,
    hardcore: false,
    desbloqueadaEm: quando.get(a.name!) ?? null,
  }));
}

/**
 * Conquistas de UM jogo (pelo namespace, que a Epic chama de sandbox) pra
 * pessoa dona do token. Duas consultas no GraphQL do launcher: a lista do
 * jogo (pública) e o que a pessoa desbloqueou (com o token). Descoberto em
 * 28/09/2026 testando campo a campo, porque a introspecção é fechada; o
 * GraphQL da LOJA (store.epicgames.com) fica atrás do desafio do Cloudflare
 * e não serve.
 *
 * Jogo sem conquista na Epic (a maioria) volta com a lista vazia. Jogo COM
 * conquista e registro do jogador nulo não diz o que a pessoa tem
 * (`jogadorOk: false`): não se grava "0 de N".
 */
export async function buscarConquistasDaEpic(auth: EpicAuth, namespace: string, buscar: Buscador = fetchPadrao): Promise<LeituraDoJogo> {
  if (!NS_VALIDO.test(namespace)) return { tipo: "falha" };
  try {
    const defs = await graphql<any>(CONSULTA_DAS_CONQUISTAS, { sandboxId: namespace, locale: "pt-BR" }, buscar, auth);
    const registro = defs?.data?.Achievement?.productAchievementsRecordBySandbox;
    if (!registro && defs?.errors) return { tipo: "falha" };
    const definicoes: DefinicaoDaEpic[] = Array.isArray(registro?.achievements) ? registro.achievements : [];
    if (definicoes.length === 0) return { tipo: "ok", conquistas: [], jogadorOk: true };
    const jog = await graphql<any>(CONSULTA_DO_JOGADOR, { epicAccountId: auth.accountId, sandboxId: namespace }, buscar, auth);
    if (jog?.errors && !jog?.data?.PlayerAchievement) return { tipo: "falha" };
    const records = jog?.data?.PlayerAchievement?.playerAchievementGameRecordsBySandbox?.records;
    if (!Array.isArray(records)) return { tipo: "ok", conquistas: lerConquistasDaEpic(definicoes, []), jogadorOk: false };
    const doJogador: ConquistaDoJogadorEpic[] = records.flatMap((r: any) => Array.isArray(r?.playerAchievements) ? r.playerAchievements : []);
    return { tipo: "ok", conquistas: lerConquistasDaEpic(definicoes, doJogador), jogadorOk: true };
  } catch (err) {
    if (err instanceof EpicSemAcesso) return { tipo: "limite", status: 401 };
    logger.warn({ err: err instanceof Error ? err.message : String(err), namespace }, "Epic: conquistas indisponíveis");
    return { tipo: "falha" };
  }
}
