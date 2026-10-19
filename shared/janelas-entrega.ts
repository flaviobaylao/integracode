// ============================================================================
// JANELAS DE RECEBIMENTO DO CLIENTE (horários em que aceita receber entrega)
// ----------------------------------------------------------------------------
// FORMATO ATUAL (desde 17/10/2026): até DOIS PERÍODOS livres por cadastro,
// guardados como intervalo "HH:MM-HH:MM" em customers.delivery_time_slots
// (seg-sex) e delivery_saturday_time_slots (sábado), ex.:
//   ["08:15-11:45", "13:30-17:00"]   → "8h15 às 11h45 + 13h30 às 17h"
// Se só um período estiver cadastrado, só ele vale.
//
// FORMATO ANTIGO (checkboxes de HORA CHEIA): ["08:00","09:00",...]. Ainda é
// lido por parseJanelas (cada hora = bloco [HH:00, HH+1:00)), e
// periodosDoCadastro() o converte para períodos para a tela de cadastro.
//
// Compartilhado entre servidor (sequenciamento da rota) e cliente (romaneio).
// ============================================================================

export interface JanelaMin {
  /** minuto do dia em que começa a receber (inclusive) */
  ini: number;
  /** minuto do dia em que para de receber (exclusive) */
  fim: number;
}

export function hhmmParaMin(s: any): number | null {
  const m = String(s ?? '').trim().match(/^(\d{1,2})(?::|h)?(\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (!Number.isFinite(h) || h < 0 || h > 24 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

export function minParaHHMM(m: number): string {
  const t = Math.max(0, Math.round(m));
  const h = Math.floor(t / 60) % 24;
  const mm = t % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function paraLista(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        const j = JSON.parse(t.startsWith('{') ? '[' + t.slice(1, -1) + ']' : t);
        if (Array.isArray(j)) return j.map((x) => String(x ?? '').replace(/"/g, '').trim()).filter(Boolean);
      } catch {
        return t.replace(/[{}\[\]"]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
    return t.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/** Converte os slots do cadastro em intervalos de minutos, ordenados e fundidos. */
export function parseJanelas(slots: any): JanelaMin[] {
  const brutos: JanelaMin[] = [];
  for (const s of paraLista(slots)) {
    if (s.includes('-')) {
      const [a, b] = s.split('-');
      const ini = hhmmParaMin(a);
      const fim = hhmmParaMin(b);
      if (ini != null && fim != null && fim > ini) brutos.push({ ini, fim });
    } else {
      const ini = hhmmParaMin(s);
      if (ini != null) brutos.push({ ini, fim: Math.min(24 * 60, ini + 60) });
    }
  }
  brutos.sort((x, y) => x.ini - y.ini);
  const out: JanelaMin[] = [];
  for (const j of brutos) {
    const ult = out[out.length - 1];
    if (ult && j.ini <= ult.fim) ult.fim = Math.max(ult.fim, j.fim);
    else out.push({ ...j });
  }
  return out;
}

/** 0=domingo … 6=sábado, a partir de 'YYYY-MM-DD' (sem depender do fuso do servidor). */
export function diaDaSemana(data: string | Date): number {
  if (data instanceof Date) {
    const iso = new Date(data.getTime() - data.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    return diaDaSemana(iso);
  }
  const m = String(data || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date().getDay();
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * Slots válidos para a data da rota: sábado usa os horários de sábado
 * (cai para os de seg-sex se o cliente não cadastrou sábado); os demais dias
 * usam os de seg-sex.
 */
export function slotsDoDia(semana: any, sabado: any, data: string | Date): string[] {
  const s = paraLista(semana);
  if (diaDaSemana(data) === 6) {
    const sab = paraLista(sabado);
    return sab.length ? sab : s;
  }
  return s;
}

function fmtHora(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${String(mm).padStart(2, '0')}` : `${h}h`;
}

/** "8h às 12h + 14h às 16h" — vazio quando não há restrição cadastrada. */
export function formatarJanelas(j: JanelaMin[] | any): string {
  const lista: JanelaMin[] = Array.isArray(j) && j.length && typeof j[0] === 'object' ? j : parseJanelas(j);
  return lista.map((x) => `${fmtHora(x.ini)} às ${fmtHora(x.fim)}`).join(' + ');
}

/** Atalho: texto da janela do cliente para a data informada. */
export function janelaTextoDoDia(semana: any, sabado: any, data: string | Date): string {
  return formatarJanelas(janelasDoDia(semana, sabado, data));
}

// ----------------------------------------------------------------------------
// PERÍODOS DO CADASTRO (tela de cadastro: até 2 períodos por grupo de dias)
// ----------------------------------------------------------------------------

export const MAX_PERIODOS_RECEBIMENTO = 2;

/** Período como a tela edita: horários "HH:MM" (vazio = não preenchido). */
export interface PeriodoRecebimento {
  ini: string;
  fim: string;
}

/** Última hora das grades antigas de checkbox: seg-sex ia até 18:00, sábado até 12:00. */
export const FIM_GRADE_ANTIGA_SEMANA = 18 * 60;
export const FIM_GRADE_ANTIGA_SABADO = 12 * 60;

/** true quando o cadastro ainda está no formato antigo (horas cheias marcadas). */
export function ehCadastroAntigo(slots: any): boolean {
  const l = paraLista(slots);
  return l.length > 0 && l.some((s) => !s.includes('-'));
}

/**
 * Converte o cadastro (novo ou antigo) em intervalos de minutos.
 * Horas cheias consecutivas viram um período que vai da primeira hora marcada
 * até uma hora depois da última — exceto quando a última é a hora final da
 * grade antiga (18:00 seg-sex / 12:00 sábado), que era lida como "até 18h"
 * (o padrão gravado em massa era 08:00…18:00 = "08:00 às 18:00").
 */
export function intervalosDoCadastro(slots: any, fimGrade: number = FIM_GRADE_ANTIGA_SEMANA): JanelaMin[] {
  const brutos: JanelaMin[] = [];
  const horas: number[] = [];
  for (const s of paraLista(slots)) {
    if (s.includes('-')) {
      const [a, b] = s.split('-');
      const ini = hhmmParaMin(a);
      const fim = hhmmParaMin(b);
      if (ini != null && fim != null && fim > ini) brutos.push({ ini, fim });
    } else {
      const h = hhmmParaMin(s);
      if (h != null) horas.push(h);
    }
  }
  const hs = Array.from(new Set(horas)).sort((x, y) => x - y);
  let i = 0;
  while (i < hs.length) {
    let j = i;
    while (j + 1 < hs.length && hs[j + 1] - hs[j] <= 60) j++;
    const ini = hs[i];
    let fim = hs[j] + 60;
    if (fim > fimGrade && hs[j] >= fimGrade && ini < fimGrade) fim = fimGrade;
    brutos.push({ ini, fim });
    i = j + 1;
  }
  brutos.sort((x, y) => x.ini - y.ini);
  const out: JanelaMin[] = [];
  for (const j of brutos) {
    const ult = out[out.length - 1];
    if (ult && j.ini <= ult.fim) ult.fim = Math.max(ult.fim, j.fim);
    else out.push({ ...j });
  }
  return out;
}

/** Períodos para a tela de cadastro (lê o formato novo e o antigo). */
export function periodosDoCadastro(slots: any, fimGrade?: number): PeriodoRecebimento[] {
  return intervalosDoCadastro(slots, fimGrade).map((j) => ({ ini: minParaHHMM(j.ini), fim: minParaHHMM(j.fim) }));
}

/**
 * Valida os períodos digitados. Período totalmente vazio é ignorado.
 * Retorna a mensagem do primeiro problema, ou null se estiver tudo certo.
 */
export function validarPeriodos(periodos: PeriodoRecebimento[]): string | null {
  const preenchidos: JanelaMin[] = [];
  for (let k = 0; k < periodos.length; k++) {
    const p = periodos[k] || { ini: '', fim: '' };
    const temIni = !!String(p.ini || '').trim();
    const temFim = !!String(p.fim || '').trim();
    if (!temIni && !temFim) continue;
    const n = k + 1;
    if (!temIni || !temFim) return `${n}º período incompleto: informe o horário de início e o de fim.`;
    const ini = hhmmParaMin(p.ini);
    const fim = hhmmParaMin(p.fim);
    if (ini == null || fim == null) return `${n}º período com horário inválido.`;
    if (fim <= ini) return `${n}º período: o fim precisa ser depois do início.`;
    preenchidos.push({ ini, fim });
  }
  if (preenchidos.length > MAX_PERIODOS_RECEBIMENTO) return `No máximo ${MAX_PERIODOS_RECEBIMENTO} períodos.`;
  const ord = preenchidos.slice().sort((a, b) => a.ini - b.ini);
  for (let k = 1; k < ord.length; k++) {
    if (ord[k].ini < ord[k - 1].fim) return 'Os dois períodos se sobrepõem. Ajuste os horários.';
  }
  return null;
}

/** Períodos válidos → formato gravado no cadastro: ["08:15-11:45", "13:30-17:00"]. */
export function serializarPeriodos(periodos: PeriodoRecebimento[]): string[] {
  const out: JanelaMin[] = [];
  for (const p of periodos || []) {
    const ini = hhmmParaMin(p?.ini);
    const fim = hhmmParaMin(p?.fim);
    if (ini != null && fim != null && fim > ini) out.push({ ini, fim });
  }
  return out
    .sort((a, b) => a.ini - b.ini)
    .slice(0, MAX_PERIODOS_RECEBIMENTO)
    .map((j) => `${minParaHHMM(j.ini)}-${minParaHHMM(j.fim)}`);
}

/**
 * Janelas (minutos) do cliente para a data da rota, lendo o formato novo
 * (períodos) e o antigo (horas cheias) pela mesma regra da tela de cadastro.
 */
export function janelasDoDia(semana: any, sabado: any, data: string | Date): JanelaMin[] {
  if (diaDaSemana(data) === 6 && paraLista(sabado).length) return intervalosDoCadastro(sabado, FIM_GRADE_ANTIGA_SABADO);
  return intervalosDoCadastro(semana, FIM_GRADE_ANTIGA_SEMANA);
}

// ----------------------------------------------------------------------------
// HORÁRIO PREFERENCIAL × HORÁRIO DE RECEBIMENTO NA ROTEIRIZAÇÃO
// ----------------------------------------------------------------------------
// 18/out: o preferencial (calculado das entregas efetuadas —
// customers.entrega_horarios_pref, ver server/horarios-preferenciais.ts) virou
// janela OBRIGATÓRIA (∩ recebimento). 19/out (caso BELLA MILÃO, VIRSON): isso
// cortou a manhã de um cliente que recebe 8h–11h e 14h–18h só porque, no
// passado, a rota passava lá à tarde — e a entrega foi para a 21ª posição em
// vez de sair junto do vizinho IGM. O preferencial descreve o HÁBITO da rota,
// não uma restrição do cliente. Regra atual:
//   • OBRIGATÓRIO = horário de recebimento cadastrado (sem cadastro = livre);
//   • PREFERENCIAL = preferência suave: o sequenciador tenta cumprir quando não
//     custa desvio (pequena penalidade por minuto fora — PESO_PREF), nunca
//     espera nem marca "fora do horário" por causa dele.
// Sábado usa os períodos de sábado; os demais dias, os de seg–sex.
// ----------------------------------------------------------------------------

export type OrigemJanela = 'preferencial' | 'recebimento' | 'livre';

function lerPref(pref: any): any {
  if (!pref) return null;
  if (typeof pref === 'string') { try { return JSON.parse(pref); } catch { return null; } }
  return pref;
}

/** Períodos preferenciais (minutos) para a data da rota. */
export function janelasPreferenciaisDoDia(pref: any, data: string | Date): JanelaMin[] {
  const p = lerPref(pref);
  if (!p) return [];
  const grupo = diaDaSemana(data) === 6 ? p.sabado : p.semana;
  const out: JanelaMin[] = [];
  for (const per of (Array.isArray(grupo?.periodos) ? grupo.periodos : [])) {
    const ini = hhmmParaMin(per?.ini);
    const fim = hhmmParaMin(per?.fim);
    if (ini != null && fim != null && fim > ini) out.push({ ini, fim });
  }
  return out.sort((a, b) => a.ini - b.ini);
}

function intersecao(a: JanelaMin[], b: JanelaMin[], minimo = 15): JanelaMin[] {
  const out: JanelaMin[] = [];
  for (const x of a) for (const y of b) {
    const ini = Math.max(x.ini, y.ini);
    const fim = Math.min(x.fim, y.fim);
    if (fim - ini >= minimo) out.push({ ini, fim });
  }
  return out.sort((p, q) => p.ini - q.ini);
}

/**
 * Janelas da roteirização para o cliente na data da rota.
 * `janelas` = OBRIGATÓRIAS (recebimento cadastrado). `preferencial` = suave
 * (só dentro do recebimento, quando há cadastro; senão o preferencial todo).
 */
export function janelasRoteirizacao(
  semana: any,
  sabado: any,
  pref: any,
  data: string | Date,
): { janelas: JanelaMin[]; origem: OrigemJanela; recebimento: JanelaMin[]; preferencial: JanelaMin[] } {
  const recebimento = janelasDoDia(semana, sabado, data);
  const prefBruto = janelasPreferenciaisDoDia(pref, data);
  const preferencial = recebimento.length ? intersecao(prefBruto, recebimento) : prefBruto;
  return { janelas: recebimento, origem: recebimento.length ? 'recebimento' : 'livre', recebimento, preferencial };
}

/** Texto para tela/romaneio: "8h às 11h + 14h às 18h · pref. 14h às 16h30". Vazio = livre sem preferência. */
export function textoJanelaRoteirizacao(semana: any, sabado: any, pref: any, data: string | Date): string {
  const r = janelasRoteirizacao(semana, sabado, pref, data);
  return textoJanelaComPreferencia(r.janelas, r.preferencial);
}

export function textoJanelaComPreferencia(janelas: JanelaMin[], preferencial?: JanelaMin[] | null): string {
  const t = formatarJanelas(janelas || []);
  const p = preferencial && preferencial.length ? formatarJanelas(preferencial) : '';
  if (!p) return t;
  return `${t || 'Livre'} · pref. ${p}`;
}

/** Janelas → slots "HH:MM-HH:MM" (formato do cadastro). */
export function janelasParaSlots(j: JanelaMin[]): string[] {
  return (j || []).map((x) => `${minParaHHMM(x.ini)}-${minParaHHMM(x.fim)}`);
}
