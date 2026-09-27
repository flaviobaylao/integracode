// =============================================================================
// COMO A MENSAGEM CHAMA O CLIENTE — uma regra só, para todos os canais
// -----------------------------------------------------------------------------
// Decisão do Flavio (21/set/2026): quando o cliente NÃO tem nome de contato
// cadastrado, a mensagem usa o NOME FANTASIA. Antes cada rotina resolvia isso
// por conta própria e as três resolviam diferente:
//
//   painel de comunicação ... contato → fantasia → razão
//   régua de recompra ....... customers.name (nunca olhava contato nem fantasia)
//   aviso de entrega ........ fantasia → nome
//
// E todas cometiam o mesmo erro: pegavam a PRIMEIRA PALAVRA. Para uma pessoa
// ("João Silva" → "João") está certo; para um estabelecimento é desastre:
//
//   "2 IRMAOS SUPERMERCADO" ................. → "2"
//   "23.063.609 JORDANA INACIO DE ALMEIDA" .. → "23.063.609"
//   "@MARKETPLACE MINI MERCADO VILLE" ....... → "@MARKETPLACE"
//
// Então a regra é por NATUREZA do que se está lendo:
//   • nome de PESSOA (o contato) ....... primeiro nome
//   • nome de EMPRESA (o fantasia) ..... o nome inteiro, limpo
//
// "Limpo" é o que um humano faria antes de mandar: tira o CNPJ/CPF que veio
// grudado na frente, tira sufixo societário do fim (LTDA, ME, EPP, EIRELI),
// e desliga o CAIXA ALTA — "Oi, 2 IRMAOS SUPERMERCADO!" chega gritando.
// =============================================================================

/** Palavras que ficam minúsculas no meio do nome (nunca na primeira posição). */
const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "em", "no", "na", "para", "a", "o"]);

/** Sufixos societários e ruído de cadastro que não se fala numa mensagem. */
const SUFIXO_RUIDO =
  /\s*(?:[-–]\s*)?(?:LTDA\.?|L\s?TDA|ME|MEI|EPP|EIRELI|S[\/.]?A|S\.?\s?A\.?|CPF|CNPJ|NC|\(\s*NOVO\s*\)|\(\s*NOVA\s*\))\s*$/i;

/** Mantém a caixa quando alguém já digitou direito; só arruma o GRITO. */
function arrumarCaixa(s: string): string {
  const temMinuscula = /[a-záàâãéêíóôõúç]/.test(s);
  const temMaiuscula = /[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(s);
  if (temMinuscula && temMaiuscula) return s; // já veio em caixa mista: não mexe
  return s
    .toLocaleLowerCase("pt-BR")
    .split(/\s+/)
    .map((p, i) => {
      if (i > 0 && MINUSCULAS.has(p)) return p;
      // Sigla curta continua em caixa alta ("BM", "CDI", "AGT").
      if (p.length <= 3 && !/[aeiouáéíóú]/.test(p)) return p.toLocaleUpperCase("pt-BR");
      return p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1);
    })
    .join(" ");
}

/** Tira documento colado na frente, arroba de marketplace e sufixo societário. */
export function limparNomeDeEmpresa(bruto: any): string {
  let s = String(bruto || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^@\s*\S+\s+/, "");                 // "@MARKETPLACE MINI MERCADO" → "MINI MERCADO"
  // Documento colado na frente: "23.063.609 JORDANA..." → "JORDANA...".
  // Exige 8+ dígitos, senão "2 IRMAOS SUPERMERCADO" perderia o "2", que é parte
  // do nome. Número curto no começo fica.
  s = s.replace(/^(\d[\d.\-\/]*)\s+/, (m, tok) => (String(tok).replace(/\D/g, "").length >= 8 ? "" : m));
  for (let i = 0; i < 2 && SUFIXO_RUIDO.test(s); i++) s = s.replace(SUFIXO_RUIDO, "");
  s = s.replace(/\s*[-–,]\s*$/, "").trim();
  return arrumarCaixa(s).slice(0, 40).trim();
}

/** Primeiro nome de uma PESSOA, com a caixa arrumada. */
export function primeiroNomeDePessoa(bruto: any): string {
  const s = String(bruto || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const tok = s.split(" ")[0];
  // "Sr. Paulo" / "Dra Ana": o tratamento não é o nome.
  const trata = /^(sr|sra|srta|dr|dra|seu|dona|dom)\.?$/i.test(tok);
  const escolhido = trata ? (s.split(" ")[1] || tok) : tok;
  // Token que não parece nome (número, código) derruba para o nome inteiro.
  if (/^\W*\d/.test(escolhido) || escolhido.replace(/\W/g, "").length < 2) return limparNomeDeEmpresa(s);
  return arrumarCaixa(escolhido);
}

/**
 * Como a mensagem vai chamar este cliente.
 * Contato cadastrado → primeiro nome da pessoa.
 * Sem contato → nome fantasia (inteiro e limpo), depois razão social, depois nome.
 * Sem nada que sirva → `padrao` ("tudo bem" fecha "Oi, tudo bem!").
 */
export function saudacaoDoCliente(
  c: { contato?: any; contact?: any; fantasia?: any; fantasy_name?: any; razao?: any; company_name?: any; nome?: any; name?: any },
  padrao = "tudo bem",
): string {
  const contato = String(c.contato ?? c.contact ?? "").trim();
  if (contato) {
    const p = primeiroNomeDePessoa(contato);
    if (p) return p;
  }
  for (const cand of [c.fantasia ?? c.fantasy_name, c.razao ?? c.company_name, c.nome ?? c.name]) {
    const limpo = limparNomeDeEmpresa(cand);
    if (limpo) return limpo;
  }
  return padrao;
}
