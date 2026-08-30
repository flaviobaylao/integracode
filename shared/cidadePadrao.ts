// Padronização ÚNICA da nomenclatura de Cidade (versão compartilhável — server + client).
// Mesma lógica de client/src/lib/cidadePadrao.ts, para o backend também normalizar.
import { CIDADES_GO_DF } from "./cidadesGoDf";

export const chaveCidade = (s: any): string =>
  String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

const MINUSCULAS_CIDADE = new Set(["de", "da", "do", "das", "dos", "e", "d'"]);

export const tituloCidade = (s: any): string =>
  String(s ?? "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) => (i > 0 && MINUSCULAS_CIDADE.has(w) ? w : w.charAt(0).toLocaleUpperCase("pt-BR") + w.slice(1)))
    .join(" ");

const CANON_BY_KEY: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of CIDADES_GO_DF) m.set(chaveCidade(c), c);
  return m;
})();

export const cidadeCanonica = (s: any): string => {
  const k = chaveCidade(s);
  if (!k) return "";
  return CANON_BY_KEY.get(k) || tituloCidade(s);
};

export { CIDADES_GO_DF };
