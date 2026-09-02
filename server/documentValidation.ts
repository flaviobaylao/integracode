/**
 * Validação e normalização de CPF/CNPJ do cadastro de clientes.
 * INTEGRA 2.0 — 02/set/2026
 *
 * Motivo: até aqui o cadastro aceitava QUALQUER coisa no campo CNPJ. A única
 * validação real acontecia no serviço de NF-e, ou seja, o erro só aparecia na
 * hora de emitir a nota — quando o pedido já estava no pipeline e o cliente
 * esperando. Dois defeitos reais que isso deixou passar:
 *
 *   1) ZOI MICRO PADARIA ARTESANAL — CNPJ com 15 dígitos ("501229057000163",
 *      um "2" digitado duas vezes). Faturamento travou com 422.
 *   2) MERCADINHO JAO / CASA OESTE DE PAES / SUPERMERCADO CARAMURU — CNPJ que
 *      começa com "000" gravado como NÚMERO em algum ponto do caminho: os zeros
 *      à esquerda somem, sobram 11 dígitos e o valor ainda vai parar no campo
 *      CPF por causa da regra "length <= 11 ? cpf : cnpj".
 *
 * Este módulo resolve os dois: valida o dígito verificador e recupera zeros à
 * esquerda perdidos antes de recusar.
 */

/** Só os dígitos, sempre como string (nunca deixa o valor virar Number). */
export function apenasDigitos(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\D/g, '');
}

export function validarCNPJ(valor: unknown): boolean {
  const c = apenasDigitos(valor);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false; // 00000000000000, 11111111111111, ...
  const dv = (len: number): number => {
    let soma = 0;
    let peso = len - 7;
    for (let i = len; i >= 1; i--) {
      soma += Number(c[len - i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

export function validarCPF(valor: unknown): boolean {
  const s = apenasDigitos(valor);
  if (s.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(s)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(s[i]) * (10 - i);
  const d1 = ((soma * 10) % 11) % 10;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(s[i]) * (11 - i);
  const d2 = ((soma * 10) % 11) % 10;
  return d1 === Number(s[9]) && d2 === Number(s[10]);
}

export type ResultadoDocumento =
  | { ok: true; vazio: true }
  | { ok: true; vazio: false; tipo: 'cpf' | 'cnpj'; digitos: string; recuperado: boolean }
  | { ok: false; erro: string };

/**
 * Normaliza um CPF/CNPJ vindo do cadastro.
 *
 * Recuperação de zeros à esquerda: um CNPJ com 12 ou 13 dígitos quase sempre é
 * um CNPJ que passou por uma conversão numérica em algum ponto. Antes de
 * recusar, tentamos completar com zeros à esquerda — se o DV fechar, era isso
 * mesmo e o valor é aceito (com recuperado = true, para o log).
 *
 * Um valor de 11 dígitos é ambíguo: pode ser um CPF legítimo OU um CNPJ que
 * perdeu 3 zeros. Resolvemos na ordem: CPF válido vence; senão tenta CNPJ.
 */
export function normalizarDocumento(valor: unknown, campo: 'cpf' | 'cnpj'): ResultadoDocumento {
  const d = apenasDigitos(valor);
  if (!d) return { ok: true, vazio: true };

  if (d.length === 14) {
    if (validarCNPJ(d)) return { ok: true, vazio: false, tipo: 'cnpj', digitos: d, recuperado: false };
    return { ok: false, erro: `CNPJ inválido (${formatarCNPJ(d)}): o dígito verificador não confere. Confira o número no cartão CNPJ do cliente.` };
  }

  if (d.length === 11) {
    if (validarCPF(d)) return { ok: true, vazio: false, tipo: 'cpf', digitos: d, recuperado: false };
    const comZeros = d.padStart(14, '0');
    if (validarCNPJ(comZeros)) {
      return { ok: true, vazio: false, tipo: 'cnpj', digitos: comZeros, recuperado: true };
    }
    return { ok: false, erro: `CPF inválido (${formatarCPF(d)}): o dígito verificador não confere.` };
  }

  if (d.length === 12 || d.length === 13) {
    const comZeros = d.padStart(14, '0');
    if (validarCNPJ(comZeros)) {
      return { ok: true, vazio: false, tipo: 'cnpj', digitos: comZeros, recuperado: true };
    }
    return { ok: false, erro: `CNPJ incompleto: ${d.length} dígitos (o correto são 14). Valor recebido: "${d}".` };
  }

  const esperado = campo === 'cnpj' ? '14 dígitos (CNPJ)' : '11 dígitos (CPF)';
  return {
    ok: false,
    erro: `Documento com ${d.length} dígitos — esperado ${esperado}. Valor recebido: "${d}". Confira se não sobrou ou faltou algum dígito.`,
  };
}

export function formatarCNPJ(valor: unknown): string {
  const c = apenasDigitos(valor).padStart(14, '0');
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

export function formatarCPF(valor: unknown): string {
  const s = apenasDigitos(valor).padStart(11, '0');
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`;
}

/**
 * Aplica a validação sobre o corpo de uma requisição de cadastro/edição.
 * - Só olha os campos que vierem no payload (PATCH parcial continua funcionando).
 * - Campo enviado vazio = limpar o documento (vira null), continua permitido.
 * - Devolve os dígitos JÁ NORMALIZADOS, e move o valor para a coluna certa
 *   quando o conteúdo não corresponde ao campo (CPF digitado no campo CNPJ).
 *
 * Uso: const v = validarDocumentosDoPayload(req.body);
 *      if (!v.ok) return res.status(400).json({ message: v.erro });
 *      Object.assign(req.body, v.campos);
 */
export function validarDocumentosDoPayload(
  body: Record<string, any>
): { ok: true; campos: Record<string, string | null>; avisos: string[] } | { ok: false; erro: string } {
  const campos: Record<string, string | null> = {};
  const avisos: string[] = [];

  for (const campo of ['cpf', 'cnpj'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, campo)) continue;

    const r = normalizarDocumento(body[campo], campo);
    if (!r.ok) return { ok: false, erro: r.erro };
    if (r.vazio) { campos[campo] = null; continue; }

    if (r.recuperado) {
      avisos.push(`[DOC] ${campo.toUpperCase()} recuperado com zeros à esquerda: "${apenasDigitos(body[campo])}" -> "${r.digitos}"`);
    }

    // Conteúdo vai para a coluna que corresponde ao que ele realmente é.
    if (r.tipo !== campo) {
      avisos.push(`[DOC] valor enviado em "${campo}" é na verdade um ${r.tipo.toUpperCase()} — gravado na coluna correta.`);
      campos[r.tipo] = r.digitos;
      campos[campo] = null;
    } else {
      campos[campo] = r.digitos;
    }
  }

  // Um cliente não pode ter CPF e CNPJ ao mesmo tempo.
  if (campos.cpf && campos.cnpj) {
    return { ok: false, erro: 'Informe CPF ou CNPJ, não os dois. Apague o documento que não se aplica a este cliente.' };
  }

  return { ok: true, campos, avisos };
}
