// ============================================================================
// JANELAS DE RECEBIMENTO DO CLIENTE (horários em que aceita receber entrega)
// ----------------------------------------------------------------------------
// O cadastro guarda os horários como checkboxes de HORA CHEIA
// (customers.delivery_time_slots / delivery_saturday_time_slots), ex.:
//   ["08:00","09:00","10:00","11:00","14:00","15:00"]
// Cada hora marcada vale o bloco inteiro [HH:00, HH+1:00). Horas consecutivas
// viram um único intervalo → "8h às 12h + 14h às 16h".
// Também aceita o formato de intervalo "08:00-12:00" (legado).
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
  return formatarJanelas(parseJanelas(slotsDoDia(semana, sabado, data)));
}
