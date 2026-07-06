// Validação de documentos fiscais (CPF/CNPJ) por dígitos verificadores.
//
// Conferir apenas o COMPRIMENTO (11 ou 14 dígitos) não basta: um documento
// com a quantidade certa de dígitos mas DV errado (ex.: dígito trocado em
// importação de planilha) passa na checagem de tamanho e só é rejeitado pela
// SEFAZ ("CNPJ do destinatário inválido"). Use estas funções antes de emitir
// uma NF-e ou de gravar o documento no cadastro do cliente.

export function isValidCpf(value: string): boolean {
  const cpf = (value || '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i], 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(cpf[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i], 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(cpf[10], 10);
}

export function isValidCnpj(value: string): boolean {
  const cnpj = (value || '').replace(/\D/g, '');
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const calcDigit = (len: number): number => {
    let sum = 0;
    let pos = len - 7;
    for (let i = len; i >= 1; i--) {
      sum += parseInt(cnpj[len - i], 10) * pos--;
      if (pos < 2) pos = 9;
    }
    const res = sum % 11;
    return res < 2 ? 0 : 11 - res;
  };
  if (calcDigit(12) !== parseInt(cnpj[12], 10)) return false;
  return calcDigit(13) === parseInt(cnpj[13], 10);
}

// Documento fiscal válido = CPF (11) ou CNPJ (14) com dígitos verificadores corretos.
export function isValidFiscalDoc(value: string): boolean {
  const d = (value || '').replace(/\D/g, '');
  if (d.length === 11) return isValidCpf(d);
  if (d.length === 14) return isValidCnpj(d);
  return false;
}
