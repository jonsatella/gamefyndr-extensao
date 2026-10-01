/**
 * Cliente da PSN (PlayStation Network) via `psn-api` package.
 *
 * Sony NÃO tem API pública pra dev individual. O `psn-api` package usa
 * a mesma API interna que o app PSN oficial, auth flow legítimo via
 * NPSSO cookie (que o user pega manualmente do site da Sony).
 *
 * Auth flow:
 *   1. User faz login em https://www.playstation.com
 *   2. Vai em https://ca.account.sony.com/api/v1/ssocookie → JSON com
 *      o valor `npsso` (64 chars hex)
 *   3. Cola esse npsso aqui
 *   4. Backend troca: npsso → accessCode → authTokens (accessToken,
 *      refreshToken, expiresAt)
 *   5. Salvamos os tokens em user_platform_links.extra pra evitar
 *      re-exchange a cada sync (npsso tem rate limit)
 *
 * Token TTL:
 *   - accessToken: ~1 hora
 *   - refreshToken: ~60 dias (durante esse período, conseguimos refresh
 *     sem precisar do npsso de novo)
 *   - npsso: ~60 dias, mas refresh quando o user usa o app PSN no
 *     celular (logout invalida)
 *
 * No /sync, verificamos expiresAt, se expirou, usa refreshToken pra
 * pegar novo accessToken. Se nem isso funcionar, manda erro pedindo o
 * user pra reconectar com novo npsso.
 *
 * Quanto a privacidade: os trophies + games só ficam visíveis pelo
 * user dono do npsso (NÃO conseguimos consultar perfis alheios sem
 * o npsso deles).
 */

import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  exchangeRefreshTokenForAuthTokens,
  getProfileFromAccountId,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
  getTitleTrophies,
  getUserTrophyProfileSummary,
  getUserPlayedGames,
  type AuthorizationPayload,
} from "psn-api";
import { soHttps, type ConquistaLida, type LeituraDoJogo } from "./tipos-de-conquista";

/** Bundle dos tokens armazenados em user_platform_links.extra.psnAuth.
 * Espelha o que o psn-api retorna do exchangeAccessCodeForAuthTokens
 * + um campo derivado `expiresAt` pra checagem fácil. */
export interface PsnAuth {
  accessToken: string;
  refreshToken: string;
  // ISO string de quando o accessToken expira. Vem do `expiresIn` (segundos)
  // mais Date.now() no momento do exchange.
  expiresAt: string;
  // refreshToken TTL, ~60 dias. Usado pra detectar quando precisa pedir
  // novo npsso.
  refreshTokenExpiresAt: string;
}

/**
 * Troca o NPSSO pelo bundle completo de tokens (access + refresh + TTLs).
 *
 * Esse é o passo MAIS LENTO do fluxo (2 round-trips Sony). Rodado uma
 * vez no /connect. Não precisa rodar de novo durante /sync (a gente
 * cacheia tokens em extra).
 *
 * Retorna null em qualquer falha, caller distingue via PsnAuth presente.
 */
export async function authenticateWithNpsso(npsso: string): Promise<PsnAuth | null> {
  try {
    const accessCode = await exchangeNpssoForAccessCode(npsso.trim());
    return await authComCodigoDaPsn(accessCode);
  } catch (err) {
    console.error("PSN authenticateWithNpsso failed:", err);
    return null;
  }
}

/**
 * O pedido de autorização que devolve o código, com os mesmos parâmetros da
 * psn-api. A EXTENSÃO do GameFyndr chama este endereço com o login da Sony
 * que a pessoa já tem no navegador e lê o código no redirecionamento (o
 * navegador esconde o cabeçalho `Location` de quem fez o fetch; a extensão
 * lê pela API webRequest).
 */
export const LINK_DE_AUTORIZACAO_DA_PSN = "https://ca.account.sony.com/api/authz/v3/oauth/authorize?" + new URLSearchParams({
  access_type: "offline",
  client_id: "09515159-7237-4370-9b40-3806e67c0891",
  redirect_uri: "com.scee.psxandroid.scecompcall://redirect",
  response_type: "code",
  scope: "psn:mobile.v2.core psn:clientapp",
}).toString();

/** O código do redirecionamento (`...redirect/?code=v3.XXX&cid=...`), ou null. */
export function codigoDoRedirecionamentoDaPsn(location: string | null | undefined): string | null {
  if (!location || !location.includes("?code=")) return null;
  return new URLSearchParams(location.split("redirect/")[1] ?? "").get("code");
}

/** Troca o código de autorização pelos tokens. Usado pelo servidor (via
 *  NPSSO) e pela extensão (via o login do navegador). */
export async function authComCodigoDaPsn(accessCode: string): Promise<PsnAuth | null> {
  try {
    const tokens = await exchangeAccessCodeForAuthTokens(accessCode);
    const now = Date.now();
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(now + tokens.expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + tokens.refreshTokenExpiresIn * 1000).toISOString(),
    };
  } catch (err) {
    console.error("PSN troca do código falhou:", err instanceof Error ? err.message : "erro");
    return null;
  }
}

/**
 * Renova accessToken via refreshToken. Usado quando o access expirou
 * (>1h após o connect). Mais barato que re-fazer o NPSSO exchange.
 *
 * Retorna null se o refresh tb expirou, daí o user precisa pedir
 * NPSSO de novo (UI deve avisar "reconecte sua conta PSN").
 */
export async function refreshPsnAuth(refreshToken: string): Promise<PsnAuth | null> {
  try {
    const tokens = await exchangeRefreshTokenForAuthTokens(refreshToken);
    const now = Date.now();
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(now + tokens.expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(now + tokens.refreshTokenExpiresIn * 1000).toISOString(),
    };
  } catch (err) {
    console.error("PSN refreshPsnAuth failed:", err);
    return null;
  }
}

/**
 * Garante que o auth tem accessToken válido. Se expirou, renova via
 * refresh. Helper pra usar nos endpoints, retorna o auth válido pra
 * passar pras chamadas, OU null se nem refresh funcionou.
 *
 * Mutate side effect: nada aqui, caller é responsável por persistir o
 * auth atualizado de volta no DB se foi renovado.
 */
export async function ensureValidPsnAuth(auth: PsnAuth): Promise<{ auth: PsnAuth; refreshed: boolean } | null> {
  const expiresAt = new Date(auth.expiresAt).getTime();
  // Buffer de 60s pra evitar usar token que tá expirando no meio da call.
  if (Date.now() < expiresAt - 60_000) {
    return { auth, refreshed: false };
  }
  const refreshed = await refreshPsnAuth(auth.refreshToken);
  if (!refreshed) return null;
  return { auth: refreshed, refreshed: true };
}

/** Perfil resumido do user, campos consumidos pra UI/cache.
 * Vem do getProfileFromAccountId. */
export interface PsnProfile {
  accountId: string;          // ID numérico PSN (immutable)
  onlineId: string;           // Display ID público (mutável, pode mudar 1x grátis)
  avatarUrl: string;          // Avatar large
  aboutMe: string;            // Bio do user (geralmente vazio)
  countryCode: string | null; // ISO-2
  isPlus: boolean;            // Subscriber PS Plus
}

/**
 * Busca perfil do user pelo accountId.
 *
 * Detalhe importante: `getProfileFromAccountId` NÃO aceita "me", só
 * accountIds numéricos. Se chamado com "me", resolvemos primeiro via
 * `getUserTrophyProfileSummary` (que aceita "me" e retorna accountId).
 *
 * Retorna null em falha (token revogado, account deletado, etc).
 */
export async function fetchPsnProfile(auth: PsnAuth, accountId: string = "me"): Promise<PsnProfile | null> {
  try {
    const authPayload = { accessToken: auth.accessToken } as AuthorizationPayload;
    // Resolve "me" → accountId numérico via trophyProfileSummary.
    let resolvedAccountId = accountId;
    if (accountId === "me") {
      const summary = await getUserTrophyProfileSummary(authPayload, "me");
      resolvedAccountId = summary.accountId;
    }
    // psn-api retorna o profile DIRETO (sem wrapper `.profile`). E os
    // avatars vêm com campo `url` (não `avatarUrl` como nas typings).
    const profile = await getProfileFromAccountId(authPayload, resolvedAccountId) as unknown as {
      onlineId?: string;
      aboutMe?: string;
      avatars?: Array<{ size?: string; url?: string }>;
      languages?: string[];
      isPlus?: boolean;
    };
    if (!profile || !profile.onlineId) return null;
    const avatars = profile.avatars ?? [];
    const avatarUrl = (avatars.find(a => a.size === "xl") ?? avatars.find(a => a.size === "l") ?? avatars[0])?.url ?? "";
    return {
      accountId: resolvedAccountId,
      onlineId: profile.onlineId,
      avatarUrl,
      aboutMe: profile.aboutMe ?? "",
      // languages[0] vem como locale ("pt-BR"). Extrai só os 2 chars
      // depois do hífen pra country code (ISO-2).
      countryCode: profile.languages?.[0]?.split("-")[1]?.toUpperCase() ?? null,
      isPlus: !!profile.isPlus,
    };
  } catch (err) {
    console.error("PSN fetchPsnProfile failed:", err);
    return null;
  }
}

/** Game jogado pelo user, formato compat com user_platform_games.
 *
 * PSN trabalha com TROPHIES (Bronze/Silver/Gold/Platinum), não pontos
 * como Steam. Pra simplificar a representação no nosso schema único,
 * convertemos:
 *   - achievementsTotal/Earned = soma de TODOS os trophies (4 tipos)
 *   - hasPlatinum = true se a definedTrophies tem platinum (>0)
 *   - completionPct = `progress` direto (vem 0-100 do PSN)
 */
export interface PsnGame {
  npCommunicationId: string;   // ID do "title" no PSN (NPWR12345_00), usado pra trophy details
  titleId: string;             // Sinônimo, usado pra storage
  name: string;                // Game name
  imageUrl: string | null;     // Trophy title icon
  platform: string;            // "PS5" | "PS4" | "PS3" | "PSVITA" | combo
  achievementsTotal: number;   // Soma de todos os trophies definidos
  achievementsEarned: number;  // Soma earned
  completionPct: number;       // 0-100 (progress direto do PSN)
  hasPlatinum: boolean;        // True se o game tem trophy platinum (1+ definida)
  earnedPlatinum: boolean;     // True se o user platinou
  lastPlayedAt: string | null; // lastUpdatedDateTime (ISO)
  /** "trophy2" pra PS5, "trophy" pra PS3/PS4/Vita. As chamadas de troféu
   *  de um jogo exigem o certo. */
  npServiceName: "trophy" | "trophy2";
}

/**
 * Lista de games jogados pelo user (com trophy progress).
 *
 * PSN ordena por lastUpdatedDateTime DESC (jogos com trophy recente
 * primeiro). Limite padrão de 800 por call, paginação se passar disso.
 * Pra MVP, fazemos uma call só com limit=800 (cobre maioria dos users;
 * casos extremos com 800+ games precisariam de paginação).
 */
export async function fetchPsnGames(auth: PsnAuth, accountId: string = "me"): Promise<PsnGame[]> {
  try {
    const r = await getUserTitles({ accessToken: auth.accessToken } as AuthorizationPayload, accountId, { limit: 800 });
    return (r.trophyTitles ?? []).map(t => {
      const total = (t.definedTrophies.bronze ?? 0) + (t.definedTrophies.silver ?? 0) + (t.definedTrophies.gold ?? 0) + (t.definedTrophies.platinum ?? 0);
      const earned = (t.earnedTrophies.bronze ?? 0) + (t.earnedTrophies.silver ?? 0) + (t.earnedTrophies.gold ?? 0) + (t.earnedTrophies.platinum ?? 0);
      return {
        npCommunicationId: t.npCommunicationId,
        titleId: t.npCommunicationId,
        name: t.trophyTitleName,
        imageUrl: t.trophyTitleIconUrl || null,
        platform: t.trophyTitlePlatform,
        achievementsTotal: total,
        achievementsEarned: earned,
        completionPct: t.progress,
        hasPlatinum: (t.definedTrophies.platinum ?? 0) > 0,
        earnedPlatinum: (t.earnedTrophies.platinum ?? 0) > 0,
        lastPlayedAt: t.lastUpdatedDateTime || null,
        npServiceName: (t.npServiceName === "trophy2" ? "trophy2" : "trophy") as PsnGame["npServiceName"],
      };
    }).filter(g => g.npCommunicationId && g.name);
  } catch (err) {
    console.error("PSN fetchPsnGames failed:", err);
    return [];
  }
}

/**
 * Jogo da biblioteca JOGADA da PSN, pela lista de jogos jogados (não pela de
 * troféus). É esta que serve pra importar, por duas razões que a de troféus
 * não tem:
 * - traz o id de CONCEPT da PlayStation Store, que é exatamente o id que o
 *   IGDB guarda (`external_games`, fonte 36), então o casamento é exato;
 * - diz COMO a pessoa tem o jogo (`service`): comprado ou pelo PS Plus. É
 *   isso que separa "Tenho" de "Já joguei".
 * Jogo sem troféu (muito indie, app de streaming) também aparece aqui.
 */
export interface PsnPlayedGame {
  titleId: string;              // "CUSA01433_00", a versão jogada
  conceptId: string | null;     // "10002648", o id que casa com o IGDB
  name: string;
  imageUrl: string | null;
  category: string;             // "ps4_game" | "ps5_native_game" | "pspc_game" | "unknown"
  /** 'comprado' | 'assinatura' (PS Plus). "none" sem mais nada conta como
   *  comprado: é o valor de jogo de disco e de jogo antigo. */
  posse: "comprado" | "assinatura";
  playtimeMinutes: number | null;
  lastPlayedAt: string | null;
}

/** "PT12H34M56S" → minutos. Duração ausente ou torta vira null. */
function minutosDeDuracaoIso(d: string | undefined | null): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d);
  if (!m) return null;
  const min = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
  return min > 0 ? Math.round(min) : null;
}

/**
 * Todos os jogos jogados, paginando de 200 em 200 (teto de 5 mil, que ninguém
 * passa). Lança em falha de rede ou de token, pra quem chama distinguir
 * "biblioteca vazia" de "não deu pra ler".
 */
export async function fetchPsnPlayedGames(auth: PsnAuth): Promise<PsnPlayedGame[]> {
  const authPayload = { accessToken: auth.accessToken } as AuthorizationPayload;
  const out: PsnPlayedGame[] = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const r = await getUserPlayedGames(authPayload, "me", { limit: 200, offset });
    for (const t of r.titles ?? []) {
      if (!t.titleId || !t.name) continue;
      const imagem = t.concept?.media?.images?.find((i) => i.type === "MASTER")?.url ?? t.imageUrl ?? null;
      out.push({
        titleId: t.titleId,
        conceptId: t.concept?.id ? String(t.concept.id) : null,
        name: t.localizedName || t.name,
        imageUrl: imagem,
        category: t.category ?? "unknown",
        posse: t.service === "ps_plus" ? "assinatura" : "comprado",
        playtimeMinutes: minutosDeDuracaoIso(t.playDuration),
        lastPlayedAt: t.lastPlayedDateTime || null,
      });
    }
    if (!r.nextOffset || (r.titles ?? []).length < 200) break;
  }
  return out;
}

/** Tipo de troféu vira "pontos", pra unificar com Steam/Xbox/RA. É a
 * tabela que a Sony usa pro nível de troféus. */
const TROPHY_POINTS: Record<string, number> = {
  bronze: 15,
  silver: 30,
  gold: 90,
  platinum: 180,
};

type TrofeuDoSchema = { trophyId: number; trophyName?: string; trophyDetail?: string; trophyType?: string; trophyIconUrl?: string };
type TrofeuDoUsuario = { trophyId: number; earned?: boolean; earnedDateTime?: string };

/**
 * Junta o schema de um jogo (nome, descrição, ícone, tipo) com o que a
 * pessoa ganhou, no formato comum. Separado da busca pra o smoke conferir
 * sem credencial de verdade.
 */
export function lerTrofeus(schema: TrofeuDoSchema[], usuario: TrofeuDoUsuario[]): ConquistaLida[] {
  const ganhos = new Map<number, TrofeuDoUsuario>();
  for (const u of usuario) ganhos.set(u.trophyId, u);
  return schema.map((t) => {
    const u = ganhos.get(t.trophyId);
    const d = u?.earned && u.earnedDateTime ? new Date(u.earnedDateTime) : null;
    const quando = u?.earned ? (d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString()) : null;
    const tipo = t.trophyType ?? "bronze";
    return {
      id: String(t.trophyId),
      nome: t.trophyName ?? "",
      descricao: t.trophyDetail ?? "",
      icone: soHttps(t.trophyIconUrl),
      pontos: TROPHY_POINTS[tipo] ?? 15,
      trueRatio: null,
      hardcore: false,
      desbloqueadaEm: quando,
    };
  }).filter((t) => t.id && t.nome);
}

/**
 * Troféus de UM jogo pra pessoa dona do token, de TODOS os grupos ("all",
 * ou seja jogo base e DLC). Duas chamadas em paralelo: o schema e o que ela
 * ganhou. O psn-api às vezes devolve `{ error }` no corpo em vez de lançar,
 * então os dois jeitos viram `falha`; token vencido ou recusado vira `limite`,
 * pra parar o lote.
 */
export async function buscarTrofeusDoJogo(
  auth: PsnAuth,
  npCommunicationId: string,
  npServiceName: "trophy" | "trophy2",
): Promise<LeituraDoJogo> {
  try {
    const authPayload = { accessToken: auth.accessToken } as AuthorizationPayload;
    const [schemaR, userR] = await Promise.all([
      getTitleTrophies(authPayload, npCommunicationId, "all", { npServiceName }),
      getUserTrophiesEarnedForTitle(authPayload, "me", npCommunicationId, "all", { npServiceName }),
    ]);
    const erro = (schemaR as { error?: { code?: number; message?: string } }).error
      ?? (userR as { error?: { code?: number; message?: string } }).error;
    if (erro) {
      const msg = String(erro.message ?? "").toLowerCase();
      if (/unauthori|expired|forbidden|too many|rate/.test(msg)) return { tipo: "limite", status: erro.code ?? 0 };
      return { tipo: "falha" };
    }
    return {
      tipo: "ok",
      conquistas: lerTrofeus((schemaR.trophies ?? []) as TrofeuDoSchema[], (userR.trophies ?? []) as TrofeuDoUsuario[]),
      jogadorOk: true,
    };
  } catch (err) {
    const msg = String((err as Error)?.message ?? "").toLowerCase();
    if (/401|403|429|unauthori|expired|forbidden|too many/.test(msg)) return { tipo: "limite", status: 0 };
    console.error("PSN buscarTrofeusDoJogo falhou em " + npCommunicationId + ":", err);
    return { tipo: "falha" };
  }
}
