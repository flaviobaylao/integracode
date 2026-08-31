// shared/tempo.ts
// -----------------------------------------------------------------------------
// FONTE UNICA DE HORARIO — INTEGRA 2.0
// Hora oficial do Brasil = America/Sao_Paulo (UTC-3, sem horario de verao desde 2019).
//
// ============================ A REGRA DE OURO ================================
// Existem DOIS tipos de campo de tempo no sistema. Confundir os dois e a causa
// de praticamente todo bug de fuso do INTEGRA:
//
//  (1) INSTANTE — "quando isso aconteceu de verdade"
//      Ex.: created_at, updated_at, check_in_time, sent_at, authorization_date.
//      GRAVA .... em UTC real  -> `agora()` no JS, `now()` no Postgres.
//      LE ...... convertendo p/ BR SO na hora de exibir/agrupar por dia.
//      SQL do dia BR: (col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date
//      JS do dia BR:  new Date(col).toLocaleDateString('en-CA', { timeZone: BR_TZ })
//
//  (2) DATA DE CALENDARIO — "que dia e este", sem hora nenhuma
//      Ex.: due_date, issue_date, scheduled_date, route_date, competencia.
//      GRAVA .... meia-noite UTC -> `dataCalendario('2026-08-11')`.
//      LE ...... SEM NENHUMA conversao de fuso. Converter subtrai 3h de um valor
//                que nao tem hora e joga o dia para tras.
//      SQL do dia:    col::date
//      JS do dia:     new Date(col).toLocaleDateString('en-CA', { timeZone: 'UTC' })
//
// "HOJE" no Brasil, sempre: SQL_HOJE_BR (SQL) ou hojeBR() (JS).
//
// ============================== PROIBIDO =====================================
//  * Gravar em coluna o retorno de nowBrazil() (server ou client). nowBrazil()
//    devolve um Date DESLOCADO -3h: os getters dele mostram a hora de parede de
//    Brasilia, mas o INSTANTE que ele representa esta errado. Gravar isso numa
//    coluna `timestamp` guarda hora BR onde o resto do sistema le UTC.
//    nowBrazil() so pode ser usado para LER componentes (getFullYear/getMonth/
//    getDate/getDay). NUNCA .toISOString(), .getTime(), comparacao ou gravacao.
//  * `col AT TIME ZONE 'America/Sao_Paulo'` sozinho sobre coluna `timestamp`.
//    Numa coluna sem fuso o Postgres INTERPRETA o valor como se ja fosse BR e
//    devolve timestamptz — o efeito liquido e SOMAR 3h, nao subtrair.
//    Para instante use as DUAS etapas (AT TIME ZONE 'UTC' AT TIME ZONE ...).
//    Para data de calendario nao use nenhuma.
// -----------------------------------------------------------------------------

export const BR_TZ = 'America/Sao_Paulo';

/* ========================= GRAVACAO ========================= */

/** Instante atual, em UTC real. Use SEMPRE isto para gravar created_at,
 *  updated_at, check_in_time, sent_at, paid_at, authorization_date etc. */
export function agora(): Date {
  return new Date();
}

/** Converte 'YYYY-MM-DD' na DATA DE CALENDARIO canonica (meia-noite UTC).
 *  E o formato que due_date/scheduled_date/route_date usam no banco.
 *  Aceita tambem string ISO completa: a parte de hora e descartada. */
export function dataCalendario(iso: string): Date {
  const dia = String(iso).slice(0, 10);
  return new Date(`${dia}T00:00:00.000Z`);
}

/** Dia no Brasil deslocado de N dias, como 'YYYY-MM-DD'. Aritmetica em UTC puro,
 *  entao nao depende do fuso do processo nem do navegador.
 *  Ex.: diaMaisBR(-7) = ha uma semana; diaMaisBR(30) = daqui a 30 dias. */
export function diaMaisBR(dias: number, ref: Date = new Date()): string {
  const d = dataCalendario(hojeBR(ref));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Primeiro dia do mes de um dia 'YYYY-MM-DD'. */
export function inicioDoMes(dia: string): string {
  return `${String(dia).slice(0, 7)}-01`;
}

/** Ultimo dia do mes de um dia 'YYYY-MM-DD'. */
export function fimDoMes(dia: string): string {
  const [a, m] = String(dia).slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

/** Diferenca em DIAS de calendario entre dois dias 'YYYY-MM-DD' (a - b). */
export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/** Instante UTC correspondente a uma data+hora de parede de Brasilia.
 *  Ex.: instanteBR('2026-08-11', '08:00') -> 2026-08-11T11:00:00.000Z */
export function instanteBR(dia: string, hora = '00:00'): Date {
  const hhmmss = hora.length === 5 ? `${hora}:00` : hora;
  return new Date(`${String(dia).slice(0, 10)}T${hhmmss}-03:00`);
}

/* ========================= LEITURA ========================= */

/** Hoje no Brasil, 'YYYY-MM-DD'. Funciona em qualquer fuso de servidor/navegador. */
export function hojeBR(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: BR_TZ });
}

/** Dia BR ('YYYY-MM-DD') de um INSTANTE gravado em UTC. */
export function diaBR(v: Date | string | number): string {
  return new Date(v).toLocaleDateString('en-CA', { timeZone: BR_TZ });
}

/** Dia ('YYYY-MM-DD') de uma DATA DE CALENDARIO. SEM conversao de fuso. */
export function diaCalendario(v: Date | string): string {
  return new Date(v).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** true se a DATA DE CALENDARIO ja passou. Vence HOJE NAO esta vencido. */
export function jaVenceu(vencimento: Date | string, ref: Date = new Date()): boolean {
  return diaCalendario(vencimento) < hojeBR(ref);
}

/** Dias de atraso de uma DATA DE CALENDARIO (0 se vence hoje ou no futuro). */
export function diasDeAtraso(vencimento: Date | string, ref: Date = new Date()): number {
  const v = Date.parse(`${diaCalendario(vencimento)}T00:00:00Z`);
  const h = Date.parse(`${hojeBR(ref)}T00:00:00Z`);
  return Math.max(0, Math.round((h - v) / 86400000));
}

/* ====================== FORMATACAO (exibicao) ====================== */

/** INSTANTE -> 'dd/mm/aaaa' no fuso do Brasil. */
export function fmtDataBR(v: Date | string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleDateString('pt-BR', { timeZone: BR_TZ });
}

/** INSTANTE -> 'dd/mm/aaaa hh:mm' no fuso do Brasil. */
export function fmtDataHoraBR(v: Date | string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleString('pt-BR', {
    timeZone: BR_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** DATA DE CALENDARIO -> 'dd/mm/aaaa'. SEM conversao de fuso: e o dia gravado. */
export function fmtCalendarioBR(v: Date | string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/** INSTANTE -> ISO com offset -03:00, formato exigido pela SEFAZ (dhEmi/dhSaiEnt). */
export function isoOffsetBR(v: Date | string | number = new Date()): string {
  const d = new Date(v);
  const p = (partes: Intl.DateTimeFormatPart[], t: string) =>
    partes.find((x) => x.type === t)?.value ?? '00';
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: BR_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const hh = p(partes, 'hour') === '24' ? '00' : p(partes, 'hour');
  return `${p(partes, 'year')}-${p(partes, 'month')}-${p(partes, 'day')}`
    + `T${hh}:${p(partes, 'minute')}:${p(partes, 'second')}-03:00`;
}

/** INSTANTE -> 'YYYY-MM-DDTHH:MM:SS' na hora de parede de Brasilia, SEM offset.
 *  E a convencao usada em billing_pipeline.stage_history.changedAt, que o resto do
 *  sistema consome com LEFT(changedAt, 10) para extrair o dia. */
export function paredeBR(v: Date | string | number = new Date()): string {
  return isoOffsetBR(v).slice(0, 19);
}

/** Componentes do relogio de parede de Brasilia para um INSTANTE.
 *  Use isto em vez de nowBrazil().getMonth() & cia. */
export function componentesBR(v: Date | string | number = new Date()) {
  const [ano, mes, dia] = diaBR(new Date(v)).split('-').map(Number);
  const hora = new Date(v).toLocaleTimeString('en-GB', { timeZone: BR_TZ, hour12: false });
  const [h, mi, s] = hora.split(':').map(Number);
  return { ano, mes, dia, hora: h, minuto: mi, segundo: s };
}

/* ========================= SQL ========================= */

/** Hoje no Brasil, como expressao SQL. */
export const SQL_HOJE_BR = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

/** Dia BR de uma coluna `timestamp` que guarda um INSTANTE em UTC.
 *  As DUAS etapas sao obrigatorias: a primeira rotula o naive como UTC. */
export function sqlDiaBR(col: string): string {
  return `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date`;
}

/** Dia de uma coluna que guarda DATA DE CALENDARIO. Sem conversao — de proposito. */
export function sqlDiaCalendario(col: string): string {
  return `(${col})::date`;
}

/** Instante BR (parede) de uma coluna `timestamp` em UTC, p/ to_char de hora. */
export function sqlParedeBR(col: string): string {
  return `(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')`;
}

/** Vencido por dia-calendario. Vence HOJE NAO e vencido. */
export function sqlVencido(col = 'due_date'): string {
  return `${sqlDiaCalendario(col)} < ${SQL_HOJE_BR}`;
}

/** Dias de atraso por dia-calendario (negativo = ainda a vencer). */
export function sqlDiasAtraso(col = 'due_date'): string {
  return `(${SQL_HOJE_BR} - ${sqlDiaCalendario(col)})`;
}

/* ==================== VIRADA DE CONVENCAO ==================== */

/** Data/hora em que o sistema passou a gravar INSTANTES em UTC real.
 *  Antes disso varias colunas guardavam hora de parede de Brasilia (nowBrazil()).
 *  Os registros antigos NAO foram reescritos — por decisao do Flavio em 11/08/2026.
 *  Onde o historico precisa continuar batendo (faturamento, DRE), use
 *  `sqlDiaBRComVirada()`, que so aplica a conversao nas linhas novas. */
export const VIRADA_FUSO_UTC = '2026-08-12 00:00:00';

/** Dia BR de uma coluna de INSTANTE, respeitando a virada de convencao:
 *  linhas gravadas ANTES da virada ja estao em hora de Brasilia e sao lidas
 *  como estao; linhas novas (UTC) passam pela conversao de duas etapas.
 *  Mantem os numeros historicos IDENTICOS aos de hoje. */
export function sqlDiaBRComVirada(col: string): string {
  return `(CASE WHEN ${col} >= TIMESTAMP '${VIRADA_FUSO_UTC}'`
    + ` THEN (${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')`
    + ` ELSE ${col} END)::date`;
}

/** Versao expressao-timestamp (sem ::date) da regra acima. */
export function sqlParedeBRComVirada(col: string): string {
  return `(CASE WHEN ${col} >= TIMESTAMP '${VIRADA_FUSO_UTC}'`
    + ` THEN (${col} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')`
    + ` ELSE ${col} END)`;
}

/* ==================== DIAS UTEIS (feriados nacionais BR) ==================== */

/** Domingo de Pascoa do ano, como 'MM-DD' (algoritmo de Meeus/Jones/Butcher). */
function pascoaMMDD(ano: number): { mes: number; dia: number } {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return { mes, dia };
}

/** Feriados NACIONAIS fixos, 'MM-DD'. (20/11 = Consciencia Negra, nacional desde 2024.) */
const FERIADOS_FIXOS_MMDD = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

/** Conjunto de feriados nacionais ('YYYY-MM-DD') de um ano: fixos + moveis
 *  derivados da Pascoa (Carnaval seg/ter, Sexta-feira Santa, Corpus Christi).
 *  Calculado, nao tabelado — nao vence com a virada do ano. */
const _feriadosCache = new Map<number, Set<string>>();
export function feriadosNacionaisBR(ano: number): Set<string> {
  const cache = _feriadosCache.get(ano);
  if (cache) return cache;
  const p = pascoaMMDD(ano);
  const pascoa = Date.UTC(ano, p.mes - 1, p.dia);
  const desloca = (dias: number) => new Date(pascoa + dias * 86400000).toISOString().slice(0, 10);
  const set = new Set<string>([
    ...FERIADOS_FIXOS_MMDD.map((md) => `${ano}-${md}`),
    desloca(-48), // Carnaval (segunda)
    desloca(-47), // Carnaval (terca)
    desloca(-2),  // Sexta-feira Santa
    desloca(60),  // Corpus Christi
  ]);
  _feriadosCache.set(ano, set);
  return set;
}

/** true se 'YYYY-MM-DD' e feriado nacional brasileiro. */
export function ehFeriadoBR(dia: string): boolean {
  const d = String(dia).slice(0, 10);
  return feriadosNacionaisBR(Number(d.slice(0, 4))).has(d);
}

/** true se 'YYYY-MM-DD' e dia util no Brasil (nao e sabado, domingo nem feriado nacional). */
export function ehDiaUtilBR(dia: string): boolean {
  const d = String(dia).slice(0, 10);
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0=dom 6=sab
  if (dow === 0 || dow === 6) return false;
  return !ehFeriadoBR(d);
}

/** Quantos DIAS UTEIS se passaram de `de` ate `ate` (ambos 'YYYY-MM-DD').
 *  Conta o dia final quando util e NAO conta o inicial: mesmo dia = 0,
 *  proximo dia util = 1. Datas futuras devolvem 0. Teto de 400 dias. */
export function diasUteisEntre(de: string, ate: string): number {
  const ini = String(de).slice(0, 10);
  const fim = String(ate).slice(0, 10);
  if (!ini || !fim || fim <= ini) return 0;
  let n = 0;
  const cur = new Date(`${ini}T00:00:00Z`);
  const alvo = Date.parse(`${fim}T00:00:00Z`);
  let guarda = 0;
  while (cur.getTime() < alvo && guarda++ < 400) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (ehDiaUtilBR(cur.toISOString().slice(0, 10))) n++;
  }
  return n;
}
