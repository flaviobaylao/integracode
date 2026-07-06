// Resolução da UF (estado) do destinatário para fins fiscais.
//
// Usado na emissão de NF-e para classificar a operação como interna (CFOP 5xxx)
// ou interestadual (CFOP 6xxx). REGRA IMPORTANTE: nunca "fabricar" a UF do
// emitente quando a UF do destinatário for desconhecida — isso já fez vendas
// interestaduais (ex.: emitente em GO, cliente em DF) saírem como internas.
// Quando não há UF confiável, a emissão deve ser bloqueada.

const UF_SET = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

// Retorna a sigla da UF (maiúscula) se for válida, senão null.
export function normalizeUf(uf?: string | null): string | null {
  const u = (uf || '').toString().trim().toUpperCase();
  return UF_SET.has(u) ? u : null;
}

// Deriva a UF a partir do CEP (faixas dos Correios). Aceita CEP com ou sem
// máscara. Retorna null quando o CEP não tem 8 dígitos ou está fora das faixas.
export function ufFromCep(cep?: string | null): string | null {
  const digits = (cep || '').toString().replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const n = parseInt(digits, 10);
  if (isNaN(n) || n <= 0) return null;
  const ranges: Array<[number, number, string]> = [
    [1000000, 19999999, 'SP'],
    [20000000, 28999999, 'RJ'],
    [29000000, 29999999, 'ES'],
    [30000000, 39999999, 'MG'],
    [40000000, 48999999, 'BA'],
    [49000000, 49999999, 'SE'],
    [50000000, 56999999, 'PE'],
    [57000000, 57999999, 'AL'],
    [58000000, 58999999, 'PB'],
    [59000000, 59999999, 'RN'],
    [60000000, 63999999, 'CE'],
    [64000000, 64999999, 'PI'],
    [65000000, 65999999, 'MA'],
    [66000000, 68899999, 'PA'],
    [68900000, 68999999, 'AP'],
    [69000000, 69299999, 'AM'],
    [69300000, 69399999, 'RR'],
    [69400000, 69899999, 'AM'],
    [69900000, 69999999, 'AC'],
    [70000000, 72799999, 'DF'],
    [72800000, 72999999, 'GO'],
    [73000000, 73699999, 'DF'],
    [73700000, 76799999, 'GO'],
    [76800000, 76999999, 'RO'],
    [77000000, 77999999, 'TO'],
    [78000000, 78899999, 'MT'],
    [78900000, 78999999, 'RO'],
    [79000000, 79999999, 'MS'],
    [80000000, 87999999, 'PR'],
    [88000000, 89999999, 'SC'],
    [90000000, 99999999, 'RS'],
  ];
  for (const [lo, hi, uf] of ranges) {
    if (n >= lo && n <= hi) return uf;
  }
  return null;
}

// Resolve a UF do destinatário a partir do estado cadastrado ou, em falta dele,
// do CEP. Retorna null quando não é possível determinar com segurança — nesse
// caso o chamador deve bloquear a emissão da NF-e.
export function resolveDestinationUf(opts: { state?: string | null; cep?: string | null }): string | null {
  return normalizeUf(opts.state) || ufFromCep(opts.cep);
}
