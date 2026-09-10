// ============================================================================
// Repescagem — Ciclos de efetividade em vendas (compartilhado entre o Resumo de
// Visitas e o gatilho da repescagem, para que as bolinhas e a regra batam).
//
// Um CICLO = uma visita agendada (por weekdays + periodicidade). VERDE se houve
// venda real dentro da janela do ciclo (semana/quinzena/mes), seg-sex. VERMELHO
// se nao houve. Regra de repescagem:
//   - Semanal/Quinzenal: 2 ciclos vermelhos CONSECUTIVOS -> repescagem no dia
//     seguinte a 2a visita sem venda.
//   - Mensal: 1 ciclo vermelho -> notifica (2 dias de tolerancia); se nao
//     atendido, repescagem no 3o dia apos a visita.
// ============================================================================

export const CYCLE_PERIODICITY_DAYS: Record<string, number> = { semanal: 7, quinzenal: 14, mensal: 28 };

export function cyclesToShow(periodicity: string): number {
  const p = String(periodicity || '').toLowerCase();
  if (p.indexOf('mens') >= 0 || p.indexOf('bime') >= 0) return 1; // Mensal: 1
  if (p.indexOf('quinz') >= 0) return 2;                          // Quinzenal: 2
  return 4;                                                       // Semanal: 4
}

export function parseDows(weekdays: any): number[] {
  const DOW: Record<string, number> = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
  let arr: any = weekdays;
  try { if (typeof weekdays === 'string') arr = JSON.parse(weekdays); } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const x of arr) {
    const k = String(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3);
    if (DOW[k] !== undefined) out.push(DOW[k]);
  }
  return out;
}

const iso = (dt: Date) => dt.toISOString().slice(0, 10);
const mkUTC = (dateStr: string) => new Date(dateStr + 'T12:00:00Z');
const firstDowOfMonth = (dt: Date, dow: number): number => {
  const first = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
  const shift = (dow - first.getUTCDay() + 7) % 7;
  return 1 + shift;
};

// Mesma logica do Resumo de Visitas: uma data e "agendada" para o cliente?
export function isPlanned(dateStr: string, dows: number[], periodicity: string): boolean {
  const dt = mkUTC(dateStr);
  const dow = dt.getUTCDay();
  if (!dows.includes(dow)) return false;
  const p = String(periodicity || 'semanal').toLowerCase();
  if (p.indexOf('quinz') >= 0) {
    const weekIdx = Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) / (7 * 864e5));
    return weekIdx % 2 === 0;
  }
  if (p.indexOf('mens') >= 0) return dt.getUTCDate() === firstDowOfMonth(dt, dow);
  if (p.indexOf('bime') >= 0) return dt.getUTCDate() === firstDowOfMonth(dt, dow) && (dt.getUTCMonth() % 2 === 0);
  return true; // semanal
}

// Janela de vendas de um ciclo ancorado numa visita (seg-sex).
function cycleWindow(anchor: string, periodicity: string): { start: string; end: string } {
  const p = String(periodicity || 'semanal').toLowerCase();
  const dt = mkUTC(anchor);
  if (p.indexOf('mens') >= 0 || p.indexOf('bime') >= 0) {
    const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
    const end = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0));
    return { start: iso(start), end: iso(end) };
  }
  // Semana (seg-sex) da ancora
  const dow = dt.getUTCDay(); // 0=Dom..6=Sab
  const monShift = (dow === 0 ? -6 : 1 - dow);
  const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() + monShift);
  let endOffset = 4; // sexta da mesma semana
  if (p.indexOf('quinz') >= 0) endOffset = 11; // sexta da 2a semana (quinzena)
  const end = new Date(mon); end.setUTCDate(mon.getUTCDate() + endOffset);
  return { start: iso(mon), end: iso(end) };
}

// Houve venda (data em saleDates) dentro da janela [start,end], em dia util (seg-sex)?
function saleInWindow(saleDates: Set<string>, start: string, end: string): boolean {
  for (const d of saleDates) {
    if (d < start || d > end) continue;
    const dow = mkUTC(d).getUTCDay();
    if (dow >= 1 && dow <= 5) return true; // seg-sex
  }
  return false;
}

// attended = houve check-in/atendimento virtual na janela, mas NAO houve pedido (bolinha amarela).
// pending  = o dia da visita ainda nao passou e nada aconteceu ainda -> bolinha SEM COR.
export type Cycle = { anchor: string; start: string; end: string; green: boolean; isPast: boolean; attended?: boolean; pending?: boolean };

// Retorna os ultimos N ciclos (mais antigo -> mais recente) do cliente ate hoje.
// saleDates = Set de datas 'YYYY-MM-DD' de VENDAS reais do cliente.
export function computeCycles(dows: number[], periodicity: string, saleDates: Set<string>, todayStr: string, n: number): Cycle[] {
  if (dows.length === 0) return [];
  const periodDays = CYCLE_PERIODICITY_DAYS[String(periodicity || 'semanal').toLowerCase()] || 7;
  const lookbackDays = n * periodDays + 21; // folga
  const startScan = iso(new Date(mkUTC(todayStr).getTime() - lookbackDays * 864e5));
  // Ancoras agendadas passadas (<= hoje)
  const anchors: string[] = [];
  { const d = mkUTC(startScan); const end = mkUTC(todayStr);
    while (d <= end) { const ds = iso(d); if (isPlanned(ds, dows, periodicity)) anchors.push(ds); d.setUTCDate(d.getUTCDate() + 1); } }
  const lastN = anchors.slice(-n);
  return lastN.map(anchor => {
    const { start, end } = cycleWindow(anchor, periodicity);
    return { anchor, start, end, green: saleInWindow(saleDates, start, end), isPast: anchor < todayStr };
  });
}

// ============================================================================
// Ciclos para EXIBICAO (as bolinhas de "Efetividade em vendas").
//
// Diferente do computeCycles acima (que so olha ancoras passadas e alimenta o
// GATILHO da repescagem — nao mexer), aqui a ultima bolinha e a do ciclo
// CORRENTE: aquele cuja janela ja comecou, mesmo que o dia da visita ainda nao
// tenha chegado. Cores:
//   verde    = houve PEDIDO na janela do ciclo;
//   amarelo  = houve ATENDIMENTO (check-in ou virtual) e nenhum pedido;
//   vermelho = passou o dia da visita e nao houve nem atendimento nem pedido;
//   sem cor  = o dia da visita ainda nao passou e nada aconteceu (pending).
// O proprio dia da visita ainda conta como "em andamento" — so vira vermelho no
// dia seguinte, a mesma tolerancia que a repescagem ja usa.
// ============================================================================
export function computeCyclesDisplay(
  dows: number[],
  periodicity: string,
  saleDates: Set<string>,
  attendanceDates: Set<string>,
  todayStr: string,
  n: number,
): Cycle[] {
  if (dows.length === 0) return [];
  const periodDays = CYCLE_PERIODICITY_DAYS[String(periodicity || 'semanal').toLowerCase()] || 7;
  const lookbackDays = n * periodDays + 21; // folga
  const startScan = iso(new Date(mkUTC(todayStr).getTime() - lookbackDays * 864e5));
  const endScan = iso(new Date(mkUTC(todayStr).getTime() + 21 * 864e5)); // alcanca a ancora do ciclo corrente
  const anchors: string[] = [];
  { const d = mkUTC(startScan); const end = mkUTC(endScan);
    while (d <= end) { const ds = iso(d); if (isPlanned(ds, dows, periodicity)) anchors.push(ds); d.setUTCDate(d.getUTCDate() + 1); } }
  // So ciclos cuja JANELA ja comecou (start <= hoje). Isso inclui o ciclo corrente mesmo
  // quando o dia da visita e mais adiante na semana/mes, e exclui os ciclos seguintes.
  const emCurso = anchors.filter((a) => cycleWindow(a, periodicity).start <= todayStr);
  return emCurso.slice(-n).map((anchor) => {
    const { start, end } = cycleWindow(anchor, periodicity);
    const green = saleInWindow(saleDates, start, end);
    const attended = !green && saleInWindow(attendanceDates, start, end);
    const pending = !green && !attended && anchor >= todayStr;
    return { anchor, start, end, green, attended, pending, isPast: anchor < todayStr };
  });
}

// Avalia a regra de repescagem a partir dos ciclos. Retorna null se NAO cai,
// ou { lastRedDate, reason, phaseKind } se cai/deve notificar.
// kind: 'repescagem' (cai na lista) — usado pelo gatilho.
export function evaluateRepescagem(
  cycles: Cycle[], periodicity: string, todayStr: string
): { falls: boolean; lastRedAnchor: string | null; redStreak: number } {
  if (cycles.length === 0) return { falls: false, lastRedAnchor: null, redStreak: 0 };
  // streak de vermelhos consecutivos terminando no ciclo mais recente (informativo)
  let streak = 0;
  for (let i = cycles.length - 1; i >= 0; i--) { if (!cycles[i].green) streak++; else break; }
  const lastCycle = cycles[cycles.length - 1];
  const daysSinceAnchor = Math.floor((mkUTC(todayStr).getTime() - mkUTC(lastCycle.anchor).getTime()) / 864e5);

  // REGRA UNICA (igual ao Resumo de Visitas): o cliente cai em repescagem SE E SOMENTE SE a
  // ULTIMA bolinha (ciclo mais recente, por periodicidade/dia de rota) estiver VERMELHA — ou seja,
  // a visita agendada mais recente nao teve venda na janela do ciclo. Cai no dia seguinte a essa
  // visita (daysSinceAnchor >= 1, dando o proprio dia de rota para vender). Assim que houver venda
  // na janela (ultima bolinha verde), o cliente sai. Vale para semanal, quinzenal e mensal.
  const falls = !lastCycle.green && daysSinceAnchor >= 1;
  return { falls, lastRedAnchor: falls ? lastCycle.anchor : null, redStreak: streak };
}
