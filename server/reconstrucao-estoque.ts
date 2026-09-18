// ═══════════════════════════════════════════════════════════════════════════
// RECONSTRUÇÃO DE ESTOQUE SEM SALDO NEGATIVO (set/2026)
//
// Saldo negativo é fisicamente impossível: onde ele aparecia na aba Contábil, o
// livro de movimentos estava incompleto (produção lançada fora do sistema,
// transferência que não gerou movimento, período anterior ao início do livro).
//
// ───────────────────────────────────────────────────────────────────────────
// O QUE SABEMOS
//   F        = saldo de HOJE (inventory_lots / raw_materials.quantity). É o
//              único número confiável, e é sempre >= 0.
//   d1..dn   = movimentos lançados, do início do período até hoje.
//   prefix(k)= soma dos k primeiros movimentos.
//
// O QUE PROCURAMOS
//   B = saldo no início do período, tal que a série B + prefix(k) nunca fique
//       negativa e feche em F.
//
// DUAS RESTRIÇÕES, E ELAS PODEM BRIGAR
//   (a) Fechar em F  ->  B_naive = F - prefix(n). Era a conta antiga da tela.
//   (b) Nunca negar  ->  B_min   = max(0, -min_k prefix(k)).
//
//   Quando B_naive < B_min, as duas não cabem juntas: os movimentos lançados são
//   incompatíveis com o saldo de hoje. Como B tem de respeitar (b) — estoque
//   negativo não existe — adotamos
//
//       B = max(B_naive, B_min)
//
//   e a diferença B - B_naive é exatamente a quantidade que SAIU sem ter sido
//   lançada (perda, venda ou transferência sem movimento). Ela vai para o campo
//   `baixaNaoRegistrada`, visível na tela: é um remendo declarado, nunca um
//   número impossível escondido.
//
//   A baixa não registrada é colocada no FIM da janela (hoje), a posição mais
//   conservadora: não contamina os saldos do período, que ficam sendo os
//   reconstruídos, e o saldo de hoje continua sendo o real.
//
// GARANTIAS (verificadas em server/__tests__/reconstrucao-estoque.test.mjs)
//   1. saldoInicial >= 0 e saldoFinal >= 0, sempre.
//   2. Repetindo a série para frente a partir de saldoInicial, ela nunca passa
//      abaixo de zero.
//   3. Sem a baixa não registrada (o caso saudável), a série fecha exatamente
//      no saldo de hoje.
// ═══════════════════════════════════════════════════════════════════════════

export type MovimentoRec = {
  t: number;        // epoch ms
  delta: number;    // + entra, - sai
  ajuste?: boolean; // conta como "ajuste" em vez de entrada/saída
};

export type ResultadoRec = {
  saldoInicial: number;
  saldoFinal: number;
  entradas: number;
  saidas: number;
  ajustes: number;
  movimentos: number;
  baixaNaoRegistrada: number;
};

const EPS = 1e-6;

export function reconstruirEstoque(
  saldoHoje: number,
  movs: MovimentoRec[],
  inicio: number,
  fim: number,
): ResultadoRec {
  const lista = movs.slice().sort((a, b) => a.t - b.t);

  // prefix(k) e o mínimo da série de prefixos (incluindo o prefixo vazio = 0).
  let acc = 0;
  let minPrefix = 0;
  let prefixNoFim = 0;
  let achouFim = false;
  for (const m of lista) {
    acc += m.delta;
    if (acc < minPrefix) minPrefix = acc;
    if (m.t <= fim) prefixNoFim = acc;
    else if (!achouFim) achouFim = true;
  }
  const prefixTotal = acc;

  const bNaive = saldoHoje - prefixTotal;
  const bMin = Math.max(0, -minPrefix);
  const B = Math.max(bNaive, bMin);
  const baixaNaoRegistrada = Math.max(0, B - bNaive);

  // Totais do período (só os movimentos entre inicio e fim).
  let entradas = 0, saidas = 0, ajustes = 0, movimentos = 0;
  for (const m of lista) {
    if (m.t < inicio || m.t > fim) continue;
    movimentos++;
    if (m.ajuste) ajustes += m.delta;
    else if (m.delta >= 0) entradas += m.delta;
    else saidas += -m.delta;
  }

  return {
    saldoInicial: Math.max(0, B),
    saldoFinal: Math.max(0, B + prefixNoFim),
    entradas,
    saidas,
    ajustes,
    movimentos,
    baixaNaoRegistrada: baixaNaoRegistrada > EPS ? baixaNaoRegistrada : 0,
  };
}
