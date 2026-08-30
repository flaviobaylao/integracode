// Padronização ÚNICA da nomenclatura de Cidade em TODO o Integra.
// - Pick-lists / filtros de cidade (qualquer módulo) devem exibir o nome por `cidadeCanonica`.
// - Cidades de GO/DF são mapeadas para o nome OFICIAL (IBGE, com acento) da base CIDADES_GO_DF.
// - Demais cidades caem em Título (preposições minúsculas) e SEM sufixo de UF "(GO)"/"(TO)".
import { CIDADES_GO_DF } from "./cidadesGoDf";

// Chave canônica p/ agrupar variações: sem acento, MAIÚSCULO, sem sufixo "(UF)", espaços colapsados.
// Ex.: "CALDAS NOVAS (GO)", "caldas novas", "Caldas Novas" -> "CALDAS NOVAS".
export const chaveCidade = (s: any): string =>
  String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

// Preposições ficam em minúscula: "Aparecida de Goiânia", não "De".
const MINUSCULAS_CIDADE = new Set(["de", "da", "do", "das", "dos", "e", "d'"]);

// Título limpo, sem sufixo de UF. Ex.: "BELA VISTA DE GOIAS (GO)" -> "Bela Vista de Goias".
export const tituloCidade = (s: any): string =>
  String(s ?? "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) => (i > 0 && MINUSCULAS_CIDADE.has(w) ? w : w.charAt(0).toLocaleUpperCase("pt-BR") + w.slice(1)))
    .join(" ");

// Dicionário canônico: chave -> nome oficial (com acento) da base GO/DF.
const CANON_BY_KEY: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of CIDADES_GO_DF) m.set(chaveCidade(c), c);
  return m;
})();

// Nome PADRONIZADO para exibição/pick-list. Usa o oficial GO/DF quando a chave bate;
// senão, Título sem sufixo de UF. Entrada vazia -> "".
export const cidadeCanonica = (s: any): string => {
  const k = chaveCidade(s);
  if (!k) return "";
  return CANON_BY_KEY.get(k) || tituloCidade(s);
};

export { CIDADES_GO_DF };
