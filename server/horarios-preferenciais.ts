// ============================================================================
// HORÁRIOS PREFERENCIAIS DE ENTREGA DO CLIENTE (18/out/2026)
// ----------------------------------------------------------------------------
// Ao lado do tempo de entrega medido, o cadastro do cliente passa a guardar em
// que horários as entregas para ele REALMENTE acontecem — calculado a partir
// das entregas efetuadas anteriormente (horário em que o entregador iniciou a
// entrega; sem cronômetro, o check-in / conclusão).
//
// Separado em seg–sex e sábado (mesma divisão do horário de recebimento).
// Até 2 períodos por grupo, no mesmo formato do cadastro ("09:00-11:30"):
//   1. horários ordenados; intervalo > 90 min entre duas entregas separa grupos;
//   2. grupos com menos de 15% das entregas são tratados como exceção;
//   3. ficam os 2 grupos com mais entregas; em grupo com 10+ entregas as pontas
//      são aparadas (10% de cada lado) para uma entrega fora da curva não
//      esticar o período; arredonda para 15 min (mínimo 30 min de largura).
// Usa as últimas 40 visitas de cada grupo nos últimos 365 dias (vários pedidos
// entregues no mesmo dia contam como uma visita, no horário da primeira). Com menos de
// 3 entregas no grupo, mostra só a contagem/mediana (sem período sugerido).
//
// Gravado em customers.entrega_horarios_pref (jsonb) — coluna criada aqui, fora
// do schema do drizzle, para nunca quebrar os SELECTs de clientes.
// Atualizado a cada entrega efetuada e recalculável para todos (admin).
// ============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

export interface PeriodoPref { ini: string; fim: string; entregas: number }
export interface GrupoPref {
  amostras: number;
  mediana: string | null;
  primeira: string | null;
  ultima: string | null;
  periodos: PeriodoPref[];
  /** entregas por hora do dia (índice 0..23) */
  porHora: number[];
}
export interface HorariosPref {
  semana: GrupoPref;
  sabado: GrupoPref;
  /** total de entregas consideradas (seg–sáb) */
  total: number;
  ultimaEntrega: string | null;
  calculadoEm: string;
}

const MAX_AMOSTRAS = 40;
const GAP_MIN = 90;
const MIN_FATIA = 0.15;

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;
const desce15 = (m: number) => Math.floor(m / 15) * 15;
const sobe15 = (m: number) => Math.ceil(m / 15) * 15;

function quantil(ordenado: number[], q: number): number {
  if (!ordenado.length) return 0;
  const pos = (ordenado.length - 1) * q;
  const a = Math.floor(pos), b = Math.ceil(pos);
  return ordenado[a] + (ordenado[b] - ordenado[a]) * (pos - a);
}

/** Calcula o grupo (seg–sex ou sábado) a partir dos minutos do dia de cada entrega. */
export function calcularGrupo(minutos: number[]): GrupoPref {
  const xs = minutos.filter((m) => Number.isFinite(m) && m >= 0 && m < 1440).sort((a, b) => a - b);
  const porHora = new Array(24).fill(0);
  for (const m of xs) porHora[Math.floor(m / 60)]++;
  const base: GrupoPref = {
    amostras: xs.length,
    mediana: xs.length ? hhmm(quantil(xs, 0.5)) : null,
    primeira: xs.length ? hhmm(xs[0]) : null,
    ultima: xs.length ? hhmm(xs[xs.length - 1]) : null,
    periodos: [],
    porHora,
  };
  if (xs.length < 3) return base;

  // 1) grupos separados por intervalos grandes
  const grupos: number[][] = [];
  let atual: number[] = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > GAP_MIN) { grupos.push(atual); atual = [xs[i]]; } else atual.push(xs[i]);
  }
  grupos.push(atual);

  // 2) descarta exceções (se sobrar algo) e 3) fica com os 2 maiores
  let relevantes = grupos.filter((g) => g.length >= Math.max(2, Math.ceil(xs.length * MIN_FATIA)));
  if (!relevantes.length) relevantes = [grupos.reduce((a, b) => (b.length > a.length ? b : a))];
  relevantes = relevantes.sort((a, b) => b.length - a.length).slice(0, 2);

  const periodos = relevantes.map((g) => {
    const ini = g.length >= 10 ? quantil(g, 0.1) : g[0];
    const fim = g.length >= 10 ? quantil(g, 0.9) : g[g.length - 1];
    let a = desce15(ini), b = sobe15(fim);
    if (b - a < 30) { const meio = (a + b) / 2; a = desce15(meio - 15); b = sobe15(meio + 15); }
    return { ini: hhmm(Math.max(0, a)), fim: hhmm(Math.min(1439, b)), entregas: g.length };
  }).sort((p, q) => p.ini.localeCompare(q.ini));

  // períodos que se tocaram depois do arredondamento viram um só
  const unidos: PeriodoPref[] = [];
  for (const p of periodos) {
    const u = unidos[unidos.length - 1];
    if (u && p.ini <= u.fim) { u.fim = p.fim > u.fim ? p.fim : u.fim; u.entregas += p.entregas; } else unidos.push({ ...p });
  }
  return { ...base, periodos: unidos };
}

let colunaPronta = false;
export async function ensureHorariosPrefSchema(): Promise<void> {
  if (colunaPronta) return;
  await db.execute(sql.raw(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS entrega_horarios_pref jsonb`));
  colunaPronta = true;
}

/**
 * Amostras de horário das entregas efetuadas. customerId opcional (sem ele: todos).
 * Devolve linhas { cliente, dow (0=dom..6=sáb), minuto, quando }.
 */
async function carregarAmostras(customerId?: string): Promise<any[]> {
  const filtro = customerId ? sql`AND COALESCE(bp.customer_id, NULLIF(s.customer_id, '')) = ${customerId}` : sql``;
  const r: any = await db.execute(sql`
    WITH e AS (
      SELECT COALESCE(bp.customer_id, NULLIF(s.customer_id, '')) AS cliente,
             (COALESCE(s.delivery_started_at, s.check_in_time, s.completed_at, s.check_out_time)
                AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') AS t
      FROM delivery_route_stops s
      LEFT JOIN billing_pipeline bp ON bp.id = COALESCE(s.billing_id, s.sales_card_id)
      WHERE s.status = 'efetuada'
        AND COALESCE(s.delivery_started_at, s.check_in_time, s.completed_at, s.check_out_time) IS NOT NULL
        AND COALESCE(s.delivery_started_at, s.check_in_time, s.completed_at, s.check_out_time) >= NOW() - INTERVAL '365 days'
        ${filtro}
    )
    , visitas AS (
      -- Vários pedidos entregues no mesmo dia = uma visita (vale o 1º horário do dia).
      SELECT DISTINCT ON (cliente, t::date) cliente, t
      FROM e
      WHERE cliente IS NOT NULL AND cliente NOT LIKE 'billing-%'
      ORDER BY cliente, t::date, t
    )
    SELECT cliente, EXTRACT(DOW FROM t)::int AS dow,
           (EXTRACT(HOUR FROM t) * 60 + EXTRACT(MINUTE FROM t))::int AS minuto,
           to_char(t, 'YYYY-MM-DD"T"HH24:MI') AS quando
    FROM visitas
    ORDER BY cliente, t DESC`);
  return (r.rows || r) as any[];
}

function montar(linhas: any[]): HorariosPref {
  const semana: number[] = [];
  const sabado: number[] = [];
  let ultima: string | null = null;
  for (const l of linhas) { // já vem da mais recente para a mais antiga
    if (!ultima) ultima = l.quando;
    const dow = Number(l.dow);
    if (dow >= 1 && dow <= 5) { if (semana.length < MAX_AMOSTRAS) semana.push(Number(l.minuto)); }
    else if (dow === 6) { if (sabado.length < MAX_AMOSTRAS) sabado.push(Number(l.minuto)); }
  }
  return {
    semana: calcularGrupo(semana),
    sabado: calcularGrupo(sabado),
    total: semana.length + sabado.length,
    ultimaEntrega: ultima,
    calculadoEm: new Date().toISOString(),
  };
}

/** Recalcula e grava os horários preferenciais de UM cliente. */
export async function atualizarHorariosPreferenciaisCliente(customerId: string): Promise<HorariosPref | null> {
  if (!customerId || customerId.startsWith("billing-")) return null;
  try {
    await ensureHorariosPrefSchema();
    const pref = montar(await carregarAmostras(customerId));
    await db.execute(sql`UPDATE customers SET entrega_horarios_pref = ${JSON.stringify(pref)}::jsonb WHERE id = ${customerId}`);
    return pref;
  } catch (e: any) {
    console.error("[HORARIOS-PREF] cliente", customerId, e?.message);
    return null;
  }
}

/** Recalcula todos os clientes com entregas efetuadas no último ano. */
export async function recalcularHorariosPreferenciaisTodos(): Promise<{ clientes: number; comPeriodo: number }> {
  await ensureHorariosPrefSchema();
  const linhas = await carregarAmostras();
  const porCliente = new Map<string, any[]>();
  for (const l of linhas) {
    const k = String(l.cliente);
    const a = porCliente.get(k) || [];
    a.push(l);
    porCliente.set(k, a);
  }
  let comPeriodo = 0;
  for (const [cliente, ls] of Array.from(porCliente.entries())) {
    const pref = montar(ls);
    if (pref.semana.periodos.length || pref.sabado.periodos.length) comPeriodo++;
    try {
      await db.execute(sql`UPDATE customers SET entrega_horarios_pref = ${JSON.stringify(pref)}::jsonb WHERE id = ${cliente}`);
    } catch (e: any) {
      console.error("[HORARIOS-PREF] gravar", cliente, e?.message);
    }
  }
  console.log(`🕘 [HORARIOS-PREF] ${porCliente.size} cliente(s) recalculado(s), ${comPeriodo} com período preferencial`);
  return { clientes: porCliente.size, comPeriodo };
}

/** Lê o que está gravado (calcula na hora se ainda não houver). */
export async function lerHorariosPreferenciais(customerId: string): Promise<HorariosPref | null> {
  await ensureHorariosPrefSchema();
  const r: any = await db.execute(sql`SELECT entrega_horarios_pref AS p FROM customers WHERE id = ${customerId}`);
  const p = (r.rows || r)[0]?.p;
  if (p) return typeof p === "string" ? JSON.parse(p) : p;
  return await atualizarHorariosPreferenciaisCliente(customerId);
}
