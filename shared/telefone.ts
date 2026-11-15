// shared/telefone.ts
// -----------------------------------------------------------------------------
// PADRÃO DE TELEFONE DO INTEGRA (nov/2026 — regra do Flávio)
//   • o que está correto fica como está;
//   • tira o +55 do início;
//   • celular antigo sem o 9 (DDD + 8 dígitos começando com 6–9) ganha o 9;
//   • "(55) 62963-0189" (+55 + DDD + 7 dígitos): tira o 55, mantém o DDD e põe o 9
//     na frente — e, como o número fica com 8 dígitos, ganha também o 9 do celular;
//   • número de preenchimento (só 9, só 2, 0000…, sequência) → campo vazio;
//   • tamanho errado / DDD inexistente / 11 dígitos sem o 9 → campo vazio.
// Usado pela padronização em massa (servidor) e pelas travas de pedido (tela + servidor).
// -----------------------------------------------------------------------------

export const DDDS_BR = new Set(
  ("11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 " +
   "51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 " +
   "91 92 93 94 95 96 97 98 99").split(" "),
);

export type SituacaoTelefone = "vazio" | "manter" | "corrigir" | "esvaziar";

export interface AnaliseTelefone {
  situacao: SituacaoTelefone;
  /** Valor final do campo: o original (manter), o corrigido (corrigir) ou '' (vazio/esvaziar). */
  novo: string;
  /** Só dígitos do número final ('' quando vazio). */
  digitos: string;
  tipo: "celular" | "fixo" | null;
  /** true quando o número final é um telefone utilizável. */
  valido: boolean;
  motivo: string;
}

const soDigitos = (v: any) => String(v ?? "").replace(/\D/g, "");

export function formatarTelefoneBR(digitos: string): string {
  const d = soDigitos(digitos);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

function ehPreenchimento(local: string, tudo: string): boolean {
  if (!local) return true;
  if (/^(\d)\1+$/.test(local) || /^(\d)\1+$/.test(tudo)) return true; // 99999-9999, 2222-2222, 0000…
  if (/^0+$/.test(local)) return true;
  if ("01234567890123456789".includes(local) || "98765432109876543210".includes(local)) return true;
  return false;
}

export function analisarTelefoneBR(raw: any): AnaliseTelefone {
  const original = String(raw ?? "").trim();
  const base = analisarNucleo(original);
  if (base.valido || base.situacao === "vazio") return base;
  // Campo com mais de um número ("6132632010 / 000000000000") ou DDD repetido pelo
  // formatador ("(62) (62) 9954-2578", "(62) +5562996311969"): aproveita o 1º número válido.
  const partes = original.split(/\s*(?:\/|;|,|\||\be\b|\bou\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const candidatos: Array<[string, string]> = [];
  for (const pt of partes) {
    if (partes.length > 1) candidatos.push([pt, "aproveitou o 1º número válido do campo"]);
    const m = pt.match(/^\(?\d{2}\)?\s*(?=[(+]|\d{2}\s)(.+)$/);
    if (m) candidatos.push([m[1], "tirou o DDD repetido"]);
  }
  for (const [c, motivo] of candidatos) {
    const a = analisarNucleo(c);
    if (a.valido) {
      const fmt = formatarTelefoneBR(a.digitos);
      return { ...a, situacao: "corrigir", novo: fmt, motivo: a.situacao === "corrigir" ? `${motivo} + ${a.motivo}` : motivo };
    }
  }
  return base;
}

function analisarNucleo(original: string): AnaliseTelefone {
  const d0 = soDigitos(original);
  const vazio = (motivo: string, situacao: SituacaoTelefone = "esvaziar"): AnaliseTelefone =>
    ({ situacao, novo: "", digitos: "", tipo: null, valido: false, motivo });
  if (!d0) return vazio("", "vazio");
  if (/^0+$/.test(d0)) return vazio("número de preenchimento");

  let x = d0.replace(/^0+/, "");
  const passos: string[] = [];

  // +55 no início (55 + DDD + 8 ou 9 dígitos).
  if ((x.length === 12 || x.length === 13) && x.startsWith("55") && DDDS_BR.has(x.slice(2, 4))) {
    x = x.slice(2);
    passos.push("tirou o +55");
  } else if (
    x.length === 11 && x.startsWith("55") && x[2] !== "9" &&
    DDDS_BR.has(x.slice(2, 4)) && /^[6-9]/.test(x.slice(4))
  ) {
    // "(55) 62963-0189": 55 + DDD + 7 dígitos → DDD + 9 + 7 dígitos (o 9 que falta do celular antigo vem abaixo).
    x = x.slice(2, 4) + "9" + x.slice(4);
    passos.push("tirou o 55 e pôs o 9 na frente");
  }

  if (x.length !== 10 && x.length !== 11) return vazio(`tamanho errado (${d0.length} dígitos)`);
  const ddd = x.slice(0, 2);
  let local = x.slice(2);
  if (ehPreenchimento(local, x)) return vazio("número de preenchimento");
  if (!DDDS_BR.has(ddd)) return vazio(`DDD inexistente (${ddd})`);

  let tipo: "celular" | "fixo";
  if (x.length === 11) {
    if (local[0] !== "9") return vazio("11 dígitos sem o 9 do celular");
    tipo = "celular";
  } else if (/^[2-5]/.test(local)) {
    tipo = "fixo";
  } else if (/^[6-9]/.test(local)) {
    local = "9" + local;
    passos.push("incluiu o 9 do celular");
    tipo = "celular";
  } else {
    return vazio("número inválido");
  }

  const digitos = ddd + local;
  if (!passos.length) {
    return { situacao: "manter", novo: original, digitos, tipo, valido: true, motivo: "correto" };
  }
  return { situacao: "corrigir", novo: formatarTelefoneBR(digitos), digitos, tipo, valido: true, motivo: passos.join(" + ") };
}

/** true quando o telefone é utilizável (já correto ou corrigível pela regra). */
export function telefoneValidoBR(raw: any): boolean {
  return analisarTelefoneBR(raw).valido;
}
