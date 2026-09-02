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

/**
 * Escolhe o CPF/CNPJ que vai para a NF-e, tratando o CADASTRO como fonte de
 * verdade e a copia do card como fallback.
 *
 * Motivo (ZOI MICRO PADARIA ARTESANAL, 01-02/set/2026): a criacao da NF-e fazia
 *   `item.customerDocument || customer?.cnpj || customer?.cpf || ''`
 * ou seja, a COPIA CONGELADA do card vencia o cadastro. Quando essa copia estava
 * errada (15 digitos) ou vazia, a nota nascia com o valor ruim — e corrigir o
 * cadastro depois NAO consertava a nota, porque o documento ja tinha sido
 * copiado. O retry falhava de novo com a mesma mensagem, indefinidamente.
 *
 * Ordem: cadastro valido > copia valida > recuperacao de zeros a esquerda > vazio.
 * Devolver '' e proposital: a montagem do XML ja trata destinatario nao
 * identificado, e um documento invalido no XML e rejeitado pela SEFAZ.
 */
export function escolherDocumentoFiscal(docCadastro: string, docCopia: string): string {
  const cad = (docCadastro || '').replace(/\D/g, '');
  const cop = (docCopia || '').replace(/\D/g, '');

  if (isValidFiscalDoc(cad)) return cad;
  if (isValidFiscalDoc(cop)) return cop;

  // Recupera zeros a esquerda perdidos numa conversao numerica em algum ponto do
  // caminho (ex.: "65979000186" -> "00065979000186", caso MERCADINHO JAO).
  for (const d of [cad, cop]) {
    if (d.length >= 11 && d.length < 14) {
      const comZeros = d.padStart(14, '0');
      if (isValidCnpj(comZeros)) return comZeros;
    }
  }

  return '';
}
