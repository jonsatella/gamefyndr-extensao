/**
 * Ponte entre a página do GameFyndr e o segundo plano da extensão.
 *
 * Roda só nas páginas do GameFyndr (ver `content_scripts` no manifesto).
 * A página não fala com a extensão direto: ela manda `window.postMessage`,
 * e esta ponte repassa. Por aqui passa só o PEDIDO de importar e o
 * RESULTADO (lista de jogos); token e cookie das plataformas nunca saem do
 * segundo plano.
 */
declare const chrome: any;

const DA_PAGINA = "gamefyndr-site";
const DA_EXTENSAO = "gamefyndr-extensao";
const versao: string = chrome.runtime.getManifest().version;
/** O que esta versão sabe importar. A página só oferece o botão pra estas. */
const PLATAFORMAS = ["epic", "gog", "psn"];

function avisarPagina(msg: Record<string, unknown>) {
  window.postMessage({ fonte: DA_EXTENSAO, ...msg }, window.location.origin);
}

const pronta = () => avisarPagina({ tipo: "pronta", versao, plataformas: PLATAFORMAS });
pronta();

window.addEventListener("message", (e: MessageEvent) => {
  // Só mensagem da PRÓPRIA página, nunca de iframe ou outra janela.
  if (e.source !== window || e.origin !== window.location.origin) return;
  const msg = e.data;
  if (!msg || msg.fonte !== DA_PAGINA) return;

  if (msg.tipo === "ping") { pronta(); return; }

  if (msg.tipo === "importar" && typeof msg.pedido === "string" && PLATAFORMAS.includes(msg.plataforma)) {
    const pedido = msg.pedido.slice(0, 64);
    const porta = chrome.runtime.connect({ name: "importar" });
    porta.onMessage.addListener((m: Record<string, unknown>) => {
      avisarPagina({ ...m, pedido });
      if (m.tipo !== "progresso") porta.disconnect();
    });
    porta.onDisconnect.addListener(() => avisarPagina({ tipo: "fim", pedido }));
    porta.postMessage({ tipo: "comecar", plataforma: msg.plataforma });
  }
});
