/**
 * O formato comum das conquistas lidas de qualquer plataforma (Steam, PSN,
 * Xbox, RetroAchievements). Cada cliente (steam.ts, psn.ts, xbox.ts, ra.ts)
 * devolve isto, e lib/platforms/conquistas-de-plataforma.ts grava.
 */

export interface ConquistaLida {
  /** Id da conquista NA PLATAFORMA (texto: a Steam usa "ACH_WIN_MATCH"). */
  id: string;
  nome: string;
  descricao: string;
  /** Ícone da conquista desbloqueada. Só https é gravado. */
  icone: string | null;
  /** Steam: 0 (não tem pontos). PSN: 15/30/90/180 por tipo de troféu.
   *  Xbox: gamerscore. RA: pontos. */
  pontos: number;
  /** RA: o peso ajustado pela raridade. As outras: null. */
  trueRatio: number | null;
  /** RA: desbloqueada no modo hardcore (sem save state). */
  hardcore: boolean;
  /** ISO. null = bloqueada. */
  desbloqueadaEm: string | null;
}

/**
 * O que a leitura de UM jogo conseguiu saber:
 *   - `ok` com `jogadorOk: true`: a lista vale.
 *   - `ok` com `jogadorOk: false`: o jogo TEM conquistas mas a plataforma não
 *     disse quais a pessoa tem (privacidade, erro deles). Não se grava "0 de N".
 *   - `ok` com lista vazia: o jogo não tem conquistas.
 *   - `limite`: recusa por excesso (429) ou chave negada (401/403). O lote para,
 *     senão cada pedido seguinte falha igual. ⚠️ Só quando a recusa é da
 *     CONTA inteira: na Steam o 403 é por jogo (app retirado) e não entra aqui.
 *   - `falha`: rede, timeout, corpo estranho. Volta na próxima rodada.
 */
export type LeituraDoJogo =
  | { tipo: "ok"; conquistas: ConquistaLida[]; jogadorOk: boolean }
  | { tipo: "limite"; status: number }
  | { tipo: "falha" };

/** Só URL https vira `badge_url` (ela é `<img src>` numa página nossa). */
export const soHttps = (u: string | null | undefined): string | null =>
  typeof u === "string" && /^https:\/\//.test(u) ? u : null;
