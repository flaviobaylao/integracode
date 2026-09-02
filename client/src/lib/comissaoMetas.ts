// client/src/lib/comissaoMetas.ts
// -----------------------------------------------------------------------------
// REGRA DE COMISSAO EXIBIDA NO BOX "Gerenciar Metas de Faturamento".
// Aprovada por Flavio em 18/08/2026:
//   Gilmar ................. 7,0% sobre o valor
//   Carlos e Jhonatan ...... 8,0% sobre o valor
//   Radilton e Cleber ...... 4,5% sobre o valor
//   Robson, Natalia e Maria Eduarda ... faixa de comissao do tipo (telemarketing)
//   Leticia ................ 8,0% sobre o valor MENOS R$ 1.400,00 (piso zero)
//                            (diferenca do salario bruto Leticia x Natalia)
//   Quem nao esta na lista . sem regra -> a tela mostra "—", nunca um numero
//                            inventado que alguem possa cobrar depois.
//
// Decisoes de calculo (confirmadas):
//   Comissao ............... percentual aplicado sobre a META
//   Comissao Conquistada ... percentual aplicado sobre o FATURAMENTO ATUAL
//   Projecao da Comissao ... percentual aplicado sobre a PROJECAO
//   Nas faixas, a aliquota segue o % de atingimento de cada coluna:
//   a coluna Meta usa 100% (a faixa de quem bate a meta), Conquistada usa
//   atual/meta e Projecao usa projetado/meta.
// -----------------------------------------------------------------------------

export type RegraComissao =
  | { tipo: 'fixo'; pct: number; descontoFixo?: number }
  | { tipo: 'faixa' }
  | null;

/** Faixas vindas do backend: thresholds em % de atingimento -> rates em %. */
export interface FaixaComissao {
  thresholds: number[];
  rates: number[];
}

const semAcento = (s: string) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Regra por vendedor. A busca e por PRIMEIRO NOME normalizado — os cadastros
 *  usam sobrenome abreviado e inconsistente ("Carlos T.", "Cleber s", "Maria E."). */
const REGRAS: Array<{ chaves: string[]; regra: RegraComissao }> = [
  { chaves: ['gilmar'], regra: { tipo: 'fixo', pct: 7 } },
  { chaves: ['carlos', 'jhonatan', 'jonatan', 'jhonathan'], regra: { tipo: 'fixo', pct: 8 } },
  { chaves: ['radilton', 'cleber'], regra: { tipo: 'fixo', pct: 4.5 } },
  { chaves: ['robson', 'natalia', 'maria'], regra: { tipo: 'faixa' } },
  { chaves: ['leticia'], regra: { tipo: 'fixo', pct: 8, descontoFixo: 1400 } },
];

/** Devolve a regra do vendedor, ou null quando nao ha regra definida. */
export function regraDoVendedor(sellerName: string): RegraComissao {
  const nome = semAcento(sellerName);
  if (!nome) return null;
  const primeiro = nome.split(/\s+/)[0];
  for (const { chaves, regra } of REGRAS) {
    if (chaves.includes(primeiro)) return regra;
  }
  return null;
}

/** Aliquota (%) da faixa correspondente ao atingimento informado. */
export function aliquotaDaFaixa(faixa: FaixaComissao | undefined, atingimentoPct: number): number {
  if (!faixa || !faixa.thresholds?.length || !faixa.rates?.length) return 0;
  let rate = faixa.rates[0];
  for (let i = 0; i < faixa.thresholds.length; i++) {
    if (atingimentoPct >= faixa.thresholds[i]) rate = faixa.rates[i];
  }
  return rate;
}

/** Comissao de UMA coluna. `base` e o valor da coluna (meta, atual ou projetado);
 *  `atingimentoPct` so importa quando a regra e por faixa.
 *  Devolve null quando nao ha regra -> a tela mostra "—". */
export function calcularComissao(
  regra: RegraComissao,
  base: number,
  atingimentoPct: number,
  faixa?: FaixaComissao,
): number | null {
  if (!regra) return null;
  const valor = Number(base) || 0;
  if (regra.tipo === 'faixa') {
    const pct = aliquotaDaFaixa(faixa, atingimentoPct);
    return (valor * pct) / 100;
  }
  const bruto = (valor * regra.pct) / 100;
  const liquido = bruto - (regra.descontoFixo || 0);
  return liquido > 0 ? liquido : 0; // piso zero
}

/** Texto curto da regra, para o title/tooltip da coluna. */
export function descricaoRegra(regra: RegraComissao): string {
  if (!regra) return 'Sem regra de comissao definida para este vendedor';
  if (regra.tipo === 'faixa') return 'Segue as Faixas de Comissao do tipo (Vendas Internas)';
  const base = `${regra.pct.toString().replace('.', ',')}% sobre o valor`;
  return regra.descontoFixo ? `${base} menos R$ ${regra.descontoFixo.toLocaleString('pt-BR')} fixos` : base;
}
