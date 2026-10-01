/**
 * Segundo plano da extensão: é AQUI, e só aqui, que as sessões das
 * plataformas existem.
 *
 * Uma importação, em qualquer plataforma:
 *   1. Usa o login que a pessoa JÁ TEM neste navegador (nada é colado).
 *   2. Lê biblioteca, lista de desejos e conquistas.
 *   3. Descarta tudo que dava acesso à conta: na Epic a sessão é ENCERRADA
 *      na própria Epic; na PlayStation os tokens só existem na memória desta
 *      função e somem com ela; na GOG nem existe token (é o cookie do
 *      próprio navegador, que a extensão nunca lê).
 *   4. Devolve à página do GameFyndr só o resultado (a lista de jogos).
 *
 * A leitura é o MESMO código que o servidor do GameFyndr usava
 * (`src/vendor/`, copiado de lá pelo build), então as regras não divergem.
 */
import {
  extrairCodigoDaEpic,
  trocarCodigoDaEpic,
  buscarBibliotecaDaEpic,
  buscarWishlistDaEpic,
  buscarConquistasDaEpic,
  encerrarSessaoDaEpic,
  type EpicAuth,
  type JogoDaEpic,
} from "./vendor/epic";
import { fetchGogUserData, fetchGogOwnedGames, fetchGogWishlist, LOGIN_DO_NAVEGADOR } from "./vendor/gog";
import {
  LINK_DE_AUTORIZACAO_DA_PSN,
  codigoDoRedirecionamentoDaPsn,
  authComCodigoDaPsn,
  fetchPsnProfile,
  fetchPsnPlayedGames,
  fetchPsnGames,
  buscarTrofeusDoJogo,
  type PsnAuth,
} from "./vendor/psn";
import type { LeituraDoJogo } from "./vendor/tipos-de-conquista";

declare const chrome: any;

/** Só páginas do GameFyndr podem pedir uma importação. O build troca a lista
 *  de desenvolvimento pela de produção. */
declare const ORIGENS_PERMITIDAS: string[];

type Plataforma = "epic" | "gog" | "psn";
export const PLATAFORMAS: Plataforma[] = ["epic", "gog", "psn"];

type Etapa = "codigo" | "biblioteca" | "wishlist" | "conquistas" | "encerrando";
type Mensagem =
  | { tipo: "progresso"; etapa: Etapa; feito?: number; total?: number }
  | { tipo: "resultado"; dados: unknown }
  | { tipo: "precisa_entrar" }
  | { tipo: "erro"; motivo: string };
type Enviar = (m: Mensagem) => void;

/** Teto de jogos lidos pra conquistas numa importação (os mais jogados). */
const TETO_DE_CONQUISTAS = 300;
const PAUSA_ENTRE_JOGOS_MS = 300;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// Cabeçalhos: só nas requisições DA EXTENSÃO (tabIds: [-1] são as que não
// saem de aba nenhuma) e só enquanto a importação roda. As abas da pessoa
// nunca são tocadas.
// =====================================================================

const ID_DA_REGRA = 1;
const USER_AGENT_DO_LAUNCHER_DA_EPIC = "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live";

const HOSTS: Record<Plataforma, string[]> = {
  // A Epic espera o User-Agent do launcher (com o do navegador o Cloudflare
  // da loja recusa). O `www.epicgames.com` fica de fora: ali vai o login da
  // pessoa, com o navegador como ele é.
  epic: [
    "account-public-service-prod03.ol.epicgames.com",
    "library-service.live.use1a.on.epicgames.com",
    "catalog-public-service-prod06.ol.epicgames.com",
    "launcher.store.epicgames.com",
  ],
  gog: ["embed.gog.com"],
  psn: ["ca.account.sony.com", "m.np.playstation.com"],
};

async function ligarCabecalhos(plataforma: Plataforma): Promise<void> {
  const requestHeaders: Array<Record<string, string>> = [{ header: "origin", operation: "remove" }];
  if (plataforma === "epic") requestHeaders.push({ header: "user-agent", operation: "set", value: USER_AGENT_DO_LAUNCHER_DA_EPIC });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ID_DA_REGRA],
    addRules: [{
      id: ID_DA_REGRA,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders },
      condition: { requestDomains: HOSTS[plataforma], tabIds: [-1] },
    }],
  });
}

async function desligarCabecalhos(): Promise<void> {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ID_DA_REGRA] }); } catch { /* nada */ }
}

/** Lê conquistas jogo a jogo, com pausa, parando se a plataforma recusar. */
async function lerConquistas(
  ids: string[],
  ler: (id: string) => Promise<LeituraDoJogo>,
  enviar: Enviar,
): Promise<Record<string, LeituraDoJogo>> {
  const out: Record<string, LeituraDoJogo> = {};
  for (let i = 0; i < ids.length; i++) {
    enviar({ tipo: "progresso", etapa: "conquistas", feito: i, total: ids.length });
    const lido = await ler(ids[i]);
    if (lido.tipo === "limite") break;
    out[ids[i]] = lido;
    await esperar(PAUSA_ENTRE_JOGOS_MS);
  }
  return out;
}

// =====================================================================
// Epic
// =====================================================================

const LINK_DO_CODIGO_DA_EPIC =
  "https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code";

async function importarEpic(enviar: Enviar): Promise<void> {
  let auth: EpicAuth | null = null;
  try {
    enviar({ tipo: "progresso", etapa: "codigo" });
    const r = await fetch(LINK_DO_CODIGO_DA_EPIC, { credentials: "include", headers: { Accept: "application/json" } });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const codigo = extrairCodigoDaEpic(typeof j?.authorizationCode === "string" ? j.authorizationCode : "");
    if (!codigo) { enviar({ tipo: "precisa_entrar" }); return; }

    await ligarCabecalhos("epic");
    auth = await trocarCodigoDaEpic(codigo);
    if (!auth) { enviar({ tipo: "erro", motivo: "codigo_recusado" }); return; }

    enviar({ tipo: "progresso", etapa: "biblioteca" });
    const jogos = await buscarBibliotecaDaEpic(auth);
    enviar({ tipo: "progresso", etapa: "wishlist" });
    const wishlist = await buscarWishlistDaEpic(auth);

    // Um jogo por namespace (a Epic chama de sandbox), o mais jogado; jogo
    // nunca aberto não tem conquista ganha.
    const porNs = new Map<string, number>();
    for (const g of jogos as JogoDaEpic[]) {
      const m = g.playtimeMinutes ?? 0;
      if (m > 0 && m > (porNs.get(g.namespace) ?? 0)) porNs.set(g.namespace, m);
    }
    const namespaces = [...porNs.entries()].sort((a, b) => b[1] - a[1]).slice(0, TETO_DE_CONQUISTAS).map(([ns]) => ns);
    const sessao = auth;
    const conquistas = await lerConquistas(namespaces, (ns) => buscarConquistasDaEpic(sessao, ns), enviar);

    enviar({ tipo: "progresso", etapa: "encerrando" });
    enviar({ tipo: "resultado", dados: { conta: { accountId: auth.accountId, displayName: auth.displayName }, jogos, wishlist, conquistas } });
  } finally {
    // ⚠️ Sempre: a sessão não sobrevive à importação, deu certo ou não.
    if (auth) await encerrarSessaoDaEpic(auth);
  }
}

// =====================================================================
// GOG: tudo pelo cookie do próprio navegador, que a extensão nunca lê.
// =====================================================================

async function importarGog(enviar: Enviar): Promise<void> {
  enviar({ tipo: "progresso", etapa: "codigo" });
  await ligarCabecalhos("gog");
  const usuario = await fetchGogUserData(LOGIN_DO_NAVEGADOR);
  if (!usuario?.isLoggedIn) { enviar({ tipo: "precisa_entrar" }); return; }

  enviar({ tipo: "progresso", etapa: "biblioteca" });
  const jogos = await fetchGogOwnedGames(LOGIN_DO_NAVEGADOR);
  if (jogos === null) { enviar({ tipo: "erro", motivo: "gog_lista_ilegivel" }); return; }
  enviar({ tipo: "progresso", etapa: "wishlist" });
  const wishlist = await fetchGogWishlist(LOGIN_DO_NAVEGADOR);

  enviar({ tipo: "progresso", etapa: "encerrando" });
  enviar({
    tipo: "resultado",
    dados: {
      // O e-mail que a GOG devolve fica de fora: o GameFyndr não precisa dele.
      conta: { userId: usuario.userId, username: usuario.username, avatarUrl: usuario.avatarUrl, country: usuario.country || null },
      jogos,
      wishlist,
    },
  });
}

// =====================================================================
// PlayStation
// =====================================================================

/**
 * O código de autorização sai no REDIRECIONAMENTO do pedido de autorização,
 * feito com o login da Sony que já está no navegador. O fetch não deixa ler
 * o `Location` (resposta opaca), então ele é lido pela API webRequest, só
 * nesse endereço e só em requisição da própria extensão.
 */
async function pedirCodigoDaPsn(): Promise<string | null> {
  let location: string | null = null;
  const ouvir = (d: any) => {
    const h = (d.responseHeaders ?? []).find((x: any) => String(x.name).toLowerCase() === "location");
    if (h?.value) location = h.value;
  };
  chrome.webRequest.onHeadersReceived.addListener(
    ouvir,
    { urls: ["https://ca.account.sony.com/api/authz/v3/oauth/authorize*"], tabId: -1 },
    ["responseHeaders"],
  );
  try {
    await fetch(LINK_DE_AUTORIZACAO_DA_PSN, { credentials: "include", redirect: "manual" }).catch(() => null);
    return codigoDoRedirecionamentoDaPsn(location);
  } finally {
    chrome.webRequest.onHeadersReceived.removeListener(ouvir);
  }
}

async function importarPsn(enviar: Enviar): Promise<void> {
  let auth: PsnAuth | null = null;
  try {
    enviar({ tipo: "progresso", etapa: "codigo" });
    await ligarCabecalhos("psn");
    const codigo = await pedirCodigoDaPsn();
    if (!codigo) { enviar({ tipo: "precisa_entrar" }); return; }
    auth = await authComCodigoDaPsn(codigo);
    if (!auth) { enviar({ tipo: "erro", motivo: "codigo_recusado" }); return; }

    const perfil = await fetchPsnProfile(auth);
    if (!perfil) { enviar({ tipo: "erro", motivo: "perfil" }); return; }

    enviar({ tipo: "progresso", etapa: "biblioteca" });
    let jogos;
    try {
      jogos = await fetchPsnPlayedGames(auth);
    } catch {
      enviar({ tipo: "erro", motivo: "psn_privado" });
      return;
    }
    const titulos = await fetchPsnGames(auth);
    // Troféus só de jogo com algum ganho, dos mais recentes pros mais antigos.
    const comTrofeu = titulos
      .filter((x) => x.achievementsEarned > 0)
      .sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""))
      .slice(0, TETO_DE_CONQUISTAS);
    const servico = new Map(comTrofeu.map((x) => [x.npCommunicationId, x.npServiceName]));
    const sessao = auth;
    const trofeus = await lerConquistas(
      comTrofeu.map((x) => x.npCommunicationId),
      (id) => buscarTrofeusDoJogo(sessao, id, servico.get(id) ?? "trophy"),
      enviar,
    );

    enviar({ tipo: "progresso", etapa: "encerrando" });
    enviar({
      tipo: "resultado",
      dados: {
        conta: { accountId: perfil.accountId, onlineId: perfil.onlineId, avatarUrl: perfil.avatarUrl || null, isPlus: perfil.isPlus, countryCode: perfil.countryCode },
        jogos,
        titulos,
        trofeus,
      },
    });
  } finally {
    // A Sony não tem como encerrar o token por fora; ele só existia nesta
    // função e some aqui, sem ter sido salvo em lugar nenhum.
    auth = null;
  }
}

// =====================================================================
// Conexão com a ponte
// =====================================================================

const IMPORTAR: Record<Plataforma, (enviar: Enviar) => Promise<void>> = {
  epic: importarEpic,
  gog: importarGog,
  psn: importarPsn,
};

let emAndamento = false;

function origemPermitida(url: string | undefined): boolean {
  if (!url) return false;
  try { return ORIGENS_PERMITIDAS.includes(new URL(url).origin); } catch { return false; }
}

chrome.runtime.onConnect.addListener((porta: any) => {
  if (porta.name !== "importar") return;
  // Quem conecta é a ponte (content script) de uma aba do GameFyndr.
  if (!origemPermitida(porta.sender?.url)) { porta.disconnect(); return; }

  let aberta = true;
  porta.onDisconnect.addListener(() => { aberta = false; });
  const enviar: Enviar = (m) => { if (aberta) { try { porta.postMessage(m); } catch { aberta = false; } } };

  porta.onMessage.addListener(async (msg: any) => {
    if (msg?.tipo !== "comecar") return;
    const plataforma = msg.plataforma as Plataforma;
    if (!PLATAFORMAS.includes(plataforma)) { enviar({ tipo: "erro", motivo: "plataforma" }); return; }
    if (emAndamento) { enviar({ tipo: "erro", motivo: "ja_em_andamento" }); return; }
    emAndamento = true;
    // Segunda garantia contra o desligamento por ociosidade (a primeira é o
    // pulso da ponte): chamar uma API da extensão também conta como atividade.
    const acordado = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* nada */ } }, 20_000);
    try {
      await IMPORTAR[plataforma](enviar);
    } catch (err) {
      enviar({ tipo: "erro", motivo: err instanceof Error ? err.message.slice(0, 200) : "erro" });
    } finally {
      clearInterval(acordado);
      await desligarCabecalhos();
      emAndamento = false;
    }
  });
});
