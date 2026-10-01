/**
 * Chave de COMPARAÇÃO de título de jogo, pra casar o nome que a loja manda
 * com o nome do catálogo quando não há id de loja.
 *
 * O `gf_normalize_name` do banco é literal demais pra isso, e os 4 jogos da
 * Epic que ficaram sem casar na primeira importação real (27/09/2026) eram
 * todos o MESMO jogo com grafia diferente:
 *
 *   loja                                  catálogo
 *   "Wonder Boy The Dragons Trap"         "Wonder Boy: The Dragon's Trap"
 *   "Shenmue 3"                           "Shenmue III"
 *   "BioShock Infinite: Complete Edition" "BioShock Infinite: The Complete Edition"
 *   "Nioh: The Complete Edition"          "Nioh: Complete Edition"
 *
 * A chave resolve os três motivos: apóstrofo SOME (em vez de virar espaço,
 * senão "dragon's" vira "dragon s" e nunca encontra "dragons"), numeral
 * romano vira arábico, e o artigo "the" sai. Os dois lados passam pela mesma
 * função, então ela só precisa ser CONSISTENTE, não "correta".
 *
 * `semEdicao` tira o sufixo de edição ("Complete Edition", "GOTY"), que é o
 * que a pessoa comprou, não outro jogo. Quem usa isso casa com o jogo BASE.
 * Remaster, remake e "Enhanced" ficam de fora de propósito: esses são jogos
 * próprios no IGDB.
 */

const ROMANOS: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16",
};

export function chaveDoTitulo(titulo: string): string {
  const limpo = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/['’‘`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!limpo) return "";
  return limpo
    .split(" ")
    .filter((w) => w && w !== "the")
    .map((w) => ROMANOS[w] ?? w)
    .join(" ");
}

const SUFIXO_DE_EDICAO =
  / (?:(?:digital )?(?:complete|deluxe|standard|gold|ultimate|premium|definitive|special|collectors?|legendary|launch|day one) edition|game of year(?: edition)?|goty(?: edition)?)$/;

/** A chave sem o sufixo de edição. Igual à chave quando não há sufixo. */
export function semEdicao(chave: string): string {
  const base = chave.replace(SUFIXO_DE_EDICAO, "").trim();
  return base || chave;
}

/**
 * O quanto um nome do catálogo casa com o título da loja:
 * 2 = mesma chave; 1 = mesmo jogo tirando a edição; 0 = não casa.
 */
export function casamentoDoTitulo(daLoja: string, doCatalogo: string): 0 | 1 | 2 {
  const a = chaveDoTitulo(daLoja);
  const b = chaveDoTitulo(doCatalogo);
  if (!a || !b) return 0;
  if (a === b) return 2;
  const baseA = semEdicao(a);
  if (baseA === b || baseA === semEdicao(b)) return 1;
  return 0;
}
