/**
 * Cliente "minimalista" do GOG via scraping de perfil público.
 *
 * Por que minimalista: GOG descontinuou a API Galaxy em 2022 e não tem
 * mais nenhum endpoint público que devolva owned games de um user
 * anônimo. Os únicos endpoints autenticados (`embed.gog.com/account/...`)
 * exigem cookie de sessão do PRÓPRIO user, frágil e a UX seria pior
 * que NPSSO do PSN (cookie GOG rotaciona binding com frequência).
 *
 * O que CONSEGUIMOS via scrape de `https://www.gog.com/u/<username>`:
 *   - userId numérico (canonical)
 *   - avatarUrl
 *   - games_owned (apenas COUNT, não lista)
 *   - existência do perfil (404 vs 200)
 *
 * O que NÃO conseguimos:
 *   - lista de jogos
 *   - achievements
 *   - playtime real (sempre 0 pra anônimos)
 *   - bio/motto (GOG removeu o campo)
 *
 * Então usamos só pra:
 *   1. Validar username existe ao conectar
 *   2. Cachear avatar pro display
 *   3. Mostrar "X jogos owned" no card (referência pra manual-add)
 *
 * Games continuam manual-add (igual Nintendo).
 */

const GOG_BASE = "https://www.gog.com";

/** Subset do JSON `window.user` que aparece embedded na HTML do perfil GOG.
 * Só os campos que de fato consumimos. */
/**
 * Como pedir à GOG em nome da pessoa: o cookie `gog-al` colado (servidor,
 * método antigo) ou o login que ela JÁ tem no navegador (a extensão do
 * GameFyndr, que pede com `credentials: "include"` e nunca vê o cookie).
 */
export const LOGIN_DO_NAVEGADOR = { doNavegador: true } as const;
export type AcessoAoGog = string | typeof LOGIN_DO_NAVEGADOR;

function pedidoAoGog(acesso: AcessoAoGog, extras: Record<string, string> = {}): RequestInit | null {
  if (typeof acesso === "string") {
    if (!acesso.trim()) return null;
    return { headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Cookie": `gog-al=${acesso.trim()}`,
      "Accept": "application/json",
      ...extras,
    } };
  }
  return { credentials: "include", headers: { "Accept": "application/json", ...extras } };
}

export interface GogProfile {
  userId: string;
  username: string;
  avatarUrl: string;
  gamesOwned: number;       // Soma agregada (sem lista discriminada)
  hoursPlayed: number;      // Sempre 0 pra anônimos, mas extraímos pra futuro
}

/**
 * Busca perfil público GOG via scrape da página /u/<username>.
 *
 * GOG renderiza no SSR um chunk `window.user = {...}` com os dados
 * básicos do perfil. Extraímos via regex (sem precisar de DOM parser).
 *
 * Retorna null se:
 *   - HTTP != 200 (user não existe ou perfil privado)
 *   - HTML não tem o JSON embedded (mudança no layout do GOG)
 *   - Parse falhou
 *
 * Privacy: GOG mudou em 2022 pra default-private. Users precisam ir
 * em Settings → Privacy e habilitar "Public Profile" + "Games owned"
 * pra a gente conseguir ver. Se for private, retorna 404.
 */
/**
 * UserData básico do user autenticado, retornado por embed.gog.com/userData.json.
 * Usado pra (a) validar que o cookie tá válido (`isLoggedIn=true`),
 * (b) extrair country/currency, (c) ler `userId` quando disponível.
 */
export interface GogUserData {
  isLoggedIn: boolean;
  country: string;          // ISO-2 (ex: "BR")
  selectedCurrency: string; // ex: "BRL"
  preferredLanguage: string; // ex: "en"
  // Esses só vêm quando logado:
  userId: string | null;
  username: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/**
 * Chama `embed.gog.com/userData.json` com o cookie `gog-al`.
 * Endpoint super leve (~400 bytes) que retorna `isLoggedIn`, usado
 * pra validar que o cookie é válido E pra extrair user ID.
 *
 * Sem cookie → isLoggedIn: false. Com cookie inválido/expirado → idem.
 * Com cookie válido → vem com `userId`, `username`, `email` aninhados.
 *
 * Retorna null em falha de rede.
 */
export async function fetchGogUserData(cookie: AcessoAoGog): Promise<GogUserData | null> {
  const pedido = pedidoAoGog(cookie);
  if (!pedido) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://embed.gog.com/userData.json", { ...pedido, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json() as Record<string, unknown>;
    // Quando logado, GOG retorna `username` ou `userName`, mais aninhados
    // em `users` etc. Tentamos os caminhos comuns.
    const userId = (j.userId as string | undefined)
      ?? (j.user_id as string | undefined)
      ?? null;
    const username = (j.username as string | undefined)
      ?? (j.userName as string | undefined)
      ?? null;
    // GOG retorna `avatar` como URL SEM extensão (só o hash SHA-256).
    // Pra renderizar precisa adicionar `_avl.jpg` (large variant). Outras
    // variants disponíveis: `_avs.jpg` (small), `_avm.jpg` (medium).
    // Detecta se já tem extensão pra ser idempotente com URLs completas.
    const rawAvatar = (j.avatar as string | undefined)
      ?? ((j.avatars as Record<string, string> | undefined)?.menu_small)
      ?? null;
    const avatarRaw = rawAvatar
      ? (/\.(jpg|png|webp)$/i.test(rawAvatar) ? rawAvatar : `${rawAvatar}_avl.jpg`)
      : null;
    return {
      isLoggedIn: Boolean(j.isLoggedIn),
      country: String(j.country ?? ""),
      selectedCurrency: typeof j.selectedCurrency === "object" && j.selectedCurrency
        ? String((j.selectedCurrency as { code?: string }).code ?? "")
        : "",
      preferredLanguage: typeof j.preferredLanguage === "object" && j.preferredLanguage
        ? String((j.preferredLanguage as { code?: string }).code ?? "")
        : "",
      userId,
      username,
      email: (j.email as string | undefined) ?? null,
      avatarUrl: avatarRaw,
    };
  } catch (err) {
    console.error("GOG fetchGogUserData failed:", err);
    return null;
  }
}

/** Game owned vindo do GOG, formato compat com user_platform_games. */
export interface GogOwnedGame {
  productId: string;       // GOG product ID (numérico, mas guardamos como text)
  title: string;
  imageUrl: string | null; // boxart vertical
  category: string | null; // "Action", "RPG", etc, GOG main genre
  // Stats que o endpoint expõe (quando autenticado):
  rating: number | null;   // 0-100 (média de reviews)
  releaseDate: string | null; // ISO
  // GOG não expõe playtime na page de owned (só no Galaxy app, que requer
  // OAuth diferente). achievementsTotal/Earned idem, só Galaxy expõe.
  // Esses ficam null no nosso schema.
}

/**
 * Lista de owned games do user autenticado via cookie `gog-al`.
 *
 * Endpoint: embed.gog.com/account/getFilteredProducts
 *   mediaType=1 → só Games (mediaType=2 seria Movies)
 *   page=N → paginação. 1ª resposta indica `totalPages`.
 *   sortBy=title → ordenação alfabética
 *
 * ⚠️ `sortBy=title_asc` passou a dar 400 "Bad request" (visto em
 * 29/09/2026), e a falha virava "0 jogos" sem nada no log: a conta
 * conectada tinha 9 jogos e nunca importou um. Hoje falha de leitura
 * devolve NULL (quem chama transforma em erro de sync), nunca lista vazia.
 *
 * Faz paginação completa, coletar tudo numa lista. Pra users com 100+
 * games, são 2-3 calls (50 games por page). Pra 500+ games, 10 calls.
 * Calls paralelas após a primeira (que retorna totalPages).
 */
/**
 * Data de lançamento como a GOG manda, que já veio de três jeitos: segundos
 * Unix, texto ("2011-08-23 00:00:00.000000") e objeto { date, timezone }
 * com um dos dois dentro. Formato que não dá pra ler vira null: uma data
 * estranha derrubava a página inteira (toISOString de data inválida lança),
 * e a biblioteca saía vazia.
 */
function dataDoGog(v: unknown): string | null {
  const bruto = v && typeof v === "object" ? (v as { date?: unknown }).date : v;
  let d: Date | null = null;
  if (typeof bruto === "number" && bruto > 0) d = new Date(bruto * 1000);
  else if (typeof bruto === "string" && bruto.trim()) {
    const n = Number(bruto);
    d = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(bruto.trim().replace(" ", "T").slice(0, 19) + "Z");
  }
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export async function fetchGogOwnedGames(cookie: AcessoAoGog): Promise<GogOwnedGame[] | null> {
  const pedido = pedidoAoGog(cookie, { "X-Requested-With": "XMLHttpRequest" });
  if (!pedido) return null;

  // Helper pra fetch + parse de uma página.
  const fetchPage = async (page: number): Promise<{ products: GogOwnedGame[]; totalPages: number } | null> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const url = `https://embed.gog.com/account/getFilteredProducts?mediaType=1&sortBy=title&page=${page}`;
      const r = await fetch(url, { ...pedido, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) {
        console.error(`GOG getFilteredProducts página ${page} respondeu ${r.status}`);
        return null;
      }
      const j = await r.json() as {
        totalPages?: number;
        products?: Array<Record<string, unknown>>;
      };
      const products = (j.products ?? []).map(p => ({
        productId: String(p.id ?? ""),
        title: String(p.title ?? ""),
        imageUrl: p.image
          ? (`https:${String(p.image)}_product_tile_136.jpg`)
          : null,
        category: (p.category as string | undefined) ?? null,
        rating: typeof p.rating === "number" ? p.rating : null,
        releaseDate: dataDoGog(p.releaseDate),
      })).filter(g => g.productId && g.title);
      return { products, totalPages: Number(j.totalPages ?? 1) };
    } catch (err) {
      console.error("GOG fetchPage failed:", err);
      return null;
    }
  };

  // Primeira page pra descobrir totalPages.
  const first = await fetchPage(1);
  if (!first) return null;
  const all: GogOwnedGame[] = [...first.products];

  // Restante em paralelo (chunks de 5 pra não martelar o GOG).
  const pagesRemaining = first.totalPages - 1;
  if (pagesRemaining > 0) {
    const pageNums = Array.from({ length: pagesRemaining }, (_, i) => i + 2);
    const CHUNK = 5;
    for (let i = 0; i < pageNums.length; i += CHUNK) {
      const slice = pageNums.slice(i, i + CHUNK);
      const results = await Promise.all(slice.map(p => fetchPage(p)));
      // Página que falhou deixaria a biblioteca pela metade sem aviso.
      if (results.some((r) => !r)) return null;
      for (const r of results) if (r) all.push(...r.products);
    }
  }
  return all;
}

/**
 * A wishlist do GOG da pessoa logada, como lista de product ids. O endpoint
 * devolve `{ wishlist: { "<productId>": true, ... } }`, só com os ids.
 *
 * Devolve null em falha (cookie vencido, GOG fora do ar), pra quem chama
 * distinguir "wishlist vazia" de "não deu pra ler".
 */
export async function fetchGogWishlist(cookie: AcessoAoGog): Promise<string[] | null> {
  const pedido = pedidoAoGog(cookie);
  if (!pedido) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch("https://embed.gog.com/user/wishlist.json", { ...pedido, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json() as { wishlist?: Record<string, unknown> };
    if (!j || typeof j.wishlist !== "object" || j.wishlist === null) return null;
    return Object.entries(j.wishlist).filter(([, v]) => v).map(([k]) => k).filter((k) => /^\d+$/.test(k));
  } catch (err) {
    console.error("GOG fetchGogWishlist failed:", err);
    return null;
  }
}

export async function fetchGogProfile(username: string): Promise<GogProfile | null> {
  const clean = username.trim();
  if (!clean) return null;
  const url = `${GOG_BASE}/u/${encodeURIComponent(clean)}`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // GOG detecta UAs de bot/curl/lib e bloqueia (retorna HTML sem o
        // JSON embedded). Precisa UA de browser realista, Chrome desktop
        // funciona consistentemente.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const html = await r.text();

    // GOG SSR ainda embeda os dados do perfil num blob JSON dentro de
    // `<script>` tags (var `window.profilesData` ou similar). Em vez de
    // parsear o JSON inteiro (que pode quebrar com whitespace/escapes
    // inconsistentes), fazemos regex direto nos campos chave.
    //
    // O blob inclui o user atual (que estamos visitando) + dados do
    // viewer (se logado), então pegamos os 1ºs valores que aparecem ,
    // sempre são do user-alvo do perfil porque é o primeiro hidratado.
    const userIdMatch = html.match(/"userId"\s*:\s*"([^"]+)"/);
    const usernameMatch = html.match(/"username"\s*:\s*"([^"]+)"/);
    if (!userIdMatch || !usernameMatch) return null;

    // Avatar: pega o primeiro path do bucket de avatars (urls vêm
    // escapadas com \/ no JSON literal, desescapamos pra URL válida).
    const avatarMatch = html.match(/"avatar"\s*:\s*"([^"]+)"/);
    const avatarUrl = avatarMatch ? avatarMatch[1]!.replace(/\\\//g, "/") : "";

    // stats.games_owned + stats.hours_played: server-rendered. Pra
    // profiles privados, achievements = null mas games_owned ainda
    // aparece se o user enabled "Public games owned" nas settings.
    const gamesMatch = html.match(/"games_owned"\s*:\s*(\d+)/);
    const hoursMatch = html.match(/"hours_played"\s*:\s*(\d+)/);

    return {
      userId: userIdMatch[1]!,
      username: usernameMatch[1]!,
      avatarUrl,
      gamesOwned: gamesMatch ? Number(gamesMatch[1]) : 0,
      hoursPlayed: hoursMatch ? Number(hoursMatch[1]) : 0,
    };
  } catch (err) {
    console.error("GOG fetchGogProfile failed:", err);
    return null;
  }
}
