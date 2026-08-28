// ============================================================================
// INTEGRA 2.0 — LOCAL PADRAO DOS CANAIS DIRETOS (Balcao, Hotsite, Instagram)
// Regra do Flavio (28/ago/2026):
//   "Para evitar erros de faturamento, os pedidos de balcao, hotsite e
//    instagram devem vir todos com a UF e a cidade preenchidos como
//    Goiania/GO."
//
// POR QUE: o faturamento barra o pedido em validateCustomerFiscalData
// (server/billing-pipeline-routes.ts) quando o cliente nao tem UF nem CEP —
// sem UF a NF-e sai com CFOP errado e e REJEITADA pela SEFAZ. Os tres canais
// diretos criam o cliente sozinhos, sem passar por cadastro manual, e ate aqui
// nasciam sem city/state. Resultado: o card ia parar na coluna "Bloqueados"
// com "Cadastro incompleto: informe a UF (estado)".
//
// PRINCIPIO: preenche SOMENTE o que veio vazio. Se o cliente informou a
// propria cidade/UF (caso do Hotsite e do Instagram, que perguntam endereco),
// o que ele informou PREVALECE — a regra e um piso, nao uma sobrescrita.
// ============================================================================

/** Cidade padrao dos canais diretos. */
export const CANAL_CIDADE_PADRAO = 'GOIÂNIA';

/** UF padrao dos canais diretos. */
export const CANAL_UF_PADRAO = 'GO';

function vazio(v: any): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

/** Compara nome de cidade ignorando caixa, acento e espaco duplo. */
function mesmaCidade(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
  return n(a) === n(b);
}

/**
 * Devolve os dados do cliente com `city`/`state` garantidos.
 *
 * - cidade vazia            -> GOIÂNIA + GO
 * - cidade = Goiania sem UF -> GO
 * - UF informada            -> mantida (normalizada: 2 letras maiusculas)
 * - OUTRA cidade sem UF     -> NAO chuta GO. Carimbar a UF errada faria a NF-e
 *   sair com CFOP interestadual trocado — imposto errado e nota valida, que e
 *   PIOR do que o card parar em "Cadastro incompleto" pedindo a UF.
 *
 * Use em TODO ponto que cria cliente pelos canais diretos (balcao, hotsite,
 * instagram).
 */
export function aplicarLocalPadraoCanal<T extends Record<string, any>>(dados: T): T {
  const ufInformada = vazio(dados.state) ? '' : String(dados.state).trim().toUpperCase().slice(0, 2);
  const cidade = vazio(dados.city) ? CANAL_CIDADE_PADRAO : String(dados.city).trim();
  const podeAssumirUf = ufInformada ? false : mesmaCidade(cidade, CANAL_CIDADE_PADRAO);
  return {
    ...dados,
    city: cidade,
    state: ufInformada || (podeAssumirUf ? CANAL_UF_PADRAO : (dados.state ?? null)),
  };
}
