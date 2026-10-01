/**
 * Build da extensão.
 *
 *   node build.mjs          -> dist/chrome e dist/firefox (produção: só gamefyndr.com)
 *   node build.mjs --dev    -> idem, aceitando também http://localhost:3001
 *
 * Passos:
 *   1. Copia a leitura da Epic do servidor (`api-server/src/lib/platforms`)
 *      pra `src/vendor/`, quando o servidor está ao lado (no monorepo). No
 *      repositório público a cópia já vem versionada, e é ela que vale.
 *   2. Empacota `background.ts` e `ponte.ts` SEM minificar: o código que a
 *      pessoa instala tem que poder ser lido e comparado com este repositório.
 *   3. Escreve um manifesto por navegador (o Firefox não tem service worker
 *      de extensão e exige um id próprio).
 */
import { createRequire } from "node:module";
// No repositório público vem do próprio node_modules; no monorepo, a extensão
// fica fora do workspace e usa o esbuild do api-server ao lado.
const { build } = await import("esbuild").catch(() =>
  createRequire(new URL("../api-server/package.json", import.meta.url))("esbuild"));
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const versao = JSON.parse(readFileSync(join(aqui, "package.json"), "utf8")).version;

// 1. A leitura da Epic, a mesma do servidor.
const doServidor = join(aqui, "..", "api-server", "src", "lib", "platforms");
const vendor = join(aqui, "src", "vendor");
if (existsSync(doServidor)) {
  mkdirSync(vendor, { recursive: true });
  for (const f of ["epic.ts", "gog.ts", "psn.ts", "titulo-do-jogo.ts", "tipos-de-conquista.ts"]) {
    copyFileSync(join(doServidor, f), join(vendor, f));
  }
}

const ORIGENS = ["https://gamefyndr.com", "https://www.gamefyndr.com", ...(dev ? ["http://localhost:3001"] : [])];
// Um endereço por linha, e cada um explicado no README. Nada de curinga.
const HOSTS = [
  // Epic
  "https://www.epicgames.com/*",
  "https://account-public-service-prod03.ol.epicgames.com/*",
  "https://library-service.live.use1a.on.epicgames.com/*",
  "https://catalog-public-service-prod06.ol.epicgames.com/*",
  "https://launcher.store.epicgames.com/*",
  // GOG
  "https://embed.gog.com/*",
  // PlayStation
  "https://ca.account.sony.com/*",
  "https://m.np.playstation.com/*",
];

const base = {
  manifest_version: 3,
  name: "GameFyndr: importar jogos",
  version: versao,
  description:
    // Até 132 caracteres: é o limite da Chrome Web Store pro resumo.
    "Importa jogos, lista de desejos e conquistas da Epic, GOG e PlayStation pro GameFyndr. Nada do seu login sai do navegador.",
  icons: { 16: "icones/16.png", 32: "icones/32.png", 48: "icones/48.png", 128: "icones/128.png" },
  // webRequest: só pra ler o redirecionamento do login da PlayStation (ver
  // pedirCodigoDaPsn em background.ts).
  permissions: ["declarativeNetRequestWithHostAccess", "webRequest"],
  host_permissions: HOSTS,
  content_scripts: [{ matches: ORIGENS.map((o) => `${o}/*`), js: ["ponte.js"], run_at: "document_start" }],
};

const manifestos = {
  chrome: { ...base, background: { service_worker: "background.js" }, minimum_chrome_version: "116" },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: "extensao@gamefyndr.com",
        strict_min_version: "140.0",
        // Exigido pela Mozilla pra extensão nova desde 03/11/2025. O que sai
        // do navegador: a conta na loja (id, nome, avatar) e o conteúdo que
        // a extensão lê dos sites das lojas (a lista de jogos). Nada mais.
        data_collection_permissions: { required: ["personallyIdentifyingInfo", "websiteContent"] },
      },
    },
  },
};

for (const [navegador, manifesto] of Object.entries(manifestos)) {
  const saida = join(aqui, "dist", navegador);
  rmSync(saida, { recursive: true, force: true });
  mkdirSync(saida, { recursive: true });
  await build({
    entryPoints: { background: join(aqui, "src", "background.ts"), ponte: join(aqui, "src", "ponte.ts") },
    outdir: saida,
    bundle: true,
    platform: "browser",
    // psn-api: no repositório público vem do node_modules daqui; no monorepo,
    // do api-server ao lado.
    nodePaths: [join(aqui, "node_modules"), join(aqui, "..", "api-server", "node_modules")],
    format: "iife",
    target: "es2022",
    minify: false,
    legalComments: "inline",
    define: { ORIGENS_PERMITIDAS: JSON.stringify(ORIGENS) },
    logLevel: "warning",
  });
  writeFileSync(join(saida, "manifest.json"), JSON.stringify(manifesto, null, 2));
  cpSync(join(aqui, "icones"), join(saida, "icones"), { recursive: true });
}
console.log(`Extensão ${versao}${dev ? " (dev, aceita localhost:3001)" : ""} em dist/chrome e dist/firefox.`);
