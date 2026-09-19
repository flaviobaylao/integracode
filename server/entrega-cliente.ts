// ============================================================================
// Pós-venda da entrega — avisos ao CLIENTE pelo WhatsApp oficial (1841)
// ----------------------------------------------------------------------------
// Quatro momentos, todos disparados pelo app do entregador (Minhas Entregas):
//
//   1. Entregador toca "Iniciar Rota"        → entrega_saiu       (cada parada da rota)
//   2. Entregador finaliza a entrega (foto)  → entrega_feita      + agenda o follow-up
//   3. Entregador registra devolução         → entrega_devolvida
//   4. Dois dias depois da entrega efetiva   → pos_entrega_2d     (fila com scheduled_at)
//
// Tom leve e informal (templates novos, categoria UTILITY, sempre com nome + nº do
// pedido). Enquanto a Meta não aprova o template novo, cai no antigo equivalente
// (pedido_saiu_entrega / pedido_entregue / entrega_nao_realizada) — nunca fica mudo.
//
// Regras:
//   - Uma mensagem por pedido e evento: campaign 'card:<sales_card_id>:<evento>'. É a
//     MESMA chave que o pipeline-dispatch usa ao ler delivery_history, então os dois
//     caminhos nunca duplicam.
//   - Devolução pode acontecer mais de uma vez (rota de amanhã devolve de novo): a
//     chave leva a data. O follow-up de 2 dias só existe para entrega EFETUADA.
//   - Só pedidos de venda (operation_type='venda'), cliente com telefone, sem opt-out
//     (o enqueue já confere). Modo test → vai para o telefone de teste, não ao cliente.
//   - Caso de uso próprio 'entrega' (liga/desliga em oficial_entrega, modo em
//     oficial_mode_entrega). Nasce ligado, herdando o modo geral.
//   - Quando o cliente responde, o agente de IA assume (ia_disparo_reabre) — o
//     contexto dos templates novos está em agent-runtime.contextoDoAviso.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { enqueueOfficialDispatch } from './official-dispatch';

/** Mesma leitura de system_settings usada pelo disparo oficial (sem módulo próprio). */
async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value; return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

const USE_CASE = 'entrega';

/** Template preferido (tom leve) e o antigo equivalente, para o período de aprovação. */
const TEMPLATES: Record<'saiu' | 'entregue' | 'devolvida' | 'pos2d', { novo: string; antigo: string | null }> = {
  saiu: { novo: 'entrega_saiu', antigo: 'pedido_saiu_entrega' },
  entregue: { novo: 'entrega_feita', antigo: 'pedido_entregue' },
  devolvida: { novo: 'entrega_devolvida', antigo: 'entrega_nao_realizada' },
  pos2d: { novo: 'pos_entrega_2d', antigo: null },
};

/** Motivo humano da devolução (o template antigo tem uma 3ª variável). */
const MOTIVO: Record<string, string> = {
  customer_absent: 'cliente ausente', address_incorrect: 'endereco incorreto', customer_refused: 'recusado no local',
  payment_issue: 'pendencia de pagamento', product_damaged: 'produto avariado', other: 'imprevisto na rota',
};

let _schemaOk = false;
/** Fila oficial ganha um "quando enviar" (nulo = agora). Idempotente; roda no boot. */
export async function ensureEntregaClienteSchema(): Promise<void> {
  if (_schemaOk) return;
  try {
    await db.execute(sql`ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS 'entrega'`);
  } catch (e: any) { if (!/already exists/i.test(String(e?.message || ''))) console.warn('[ENTREGA-CLIENTE] enum:', e?.message); }
  try {
    await db.execute(sql`ALTER TABLE official_dispatches ADD COLUMN IF NOT EXISTS scheduled_at timestamptz`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS official_dispatches_agendado_idx ON official_dispatches (scheduled_at) WHERE status = 'fila'`);
    _schemaOk = true;
  } catch (e: any) { console.warn('[ENTREGA-CLIENTE] schema:', e?.message); }
}

export async function ligado(): Promise<boolean> {
  return (await getSetting('oficial_' + USE_CASE, 'on')) === 'on';
}

async function templateAtivo(label: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT umbler_id, COALESCE(is_active, true) AS ativo FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
    const t = r.rows?.[0];
    return !!(t && t.umbler_id && t.ativo !== false);
  } catch { return false; }
}

/** Quantas {{n}} o template cadastrado espera (0 se não souber o corpo). */
async function variaveisDo(label: string): Promise<number> {
  try {
    const r: any = await db.execute(sql`SELECT corpo FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
    const corpo = String(r.rows?.[0]?.corpo || '');
    let max = 0; (corpo.match(/\{\{\d+\}\}/g) || []).forEach(t => { max = Math.max(max, Number(t.replace(/\D/g, ''))); });
    return max;
  } catch { return 0; }
}

/** O template só vale como variante UTILITY se a Meta o classificou assim. */
async function ehUtility(label: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT upper(COALESCE(categoria,'')) AS c FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
    return String(r.rows?.[0]?.c || '') === 'UTILITY';
  } catch { return false; }
}

/**
 * Escolhe o template, nesta ordem:
 *   1. '<novo>_u' — variante reescrita em moldura transacional, SE a Meta a aprovou
 *      como UTILITY (0,04 por mensagem em vez de 0,34, e sem opt-out);
 *   2. o novo (tom leve), se estiver ativo;
 *   3. o antigo equivalente, enquanto a Meta não aprova o novo.
 * A troca acontece sozinha quando a aprovação sai — sem deploy.
 */
export async function escolherTemplate(ev: keyof typeof TEMPLATES): Promise<{ label: string; novo: boolean } | null> {
  const t = TEMPLATES[ev];
  const u = t.novo + '_u';
  if (await templateAtivo(u) && await ehUtility(u)) return { label: u, novo: true };
  if (await templateAtivo(t.novo)) return { label: t.novo, novo: true };
  if (t.antigo && await templateAtivo(t.antigo)) return { label: t.antigo, novo: false };
  return null;
}

/** Já saiu aviso equivalente há pouco? Cobre as chaves antigas do pipeline-dispatch
 *  (card:<id>:saiu / :falhou), que lê delivery_history e usaria outro nome de campanha
 *  para o mesmo fato. Sem isto o cliente poderia receber a mesma notícia duas vezes. */
async function avisadoRecentemente(campaigns: string[], horas = 12): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT 1 FROM official_dispatches
      WHERE campaign = ANY(${campaigns}) AND status <> 'falha'::dispatch_status
        AND created_at > now() - make_interval(hours => ${horas}) LIMIT 1`);
    return !!r.rows?.length;
  } catch { return false; }
}

const limpo = (s: any) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
const primeiroNome = (r: any) => limpo(String(r.fantasy_name || r.name || 'Cliente').split(' ')[0] || 'Cliente').slice(0, 60);
const numeroDe = (r: any) => limpo(r.order_number || ('INT-' + String(r.sales_card_id || '').substring(0, 8)));

type Parada = {
  stop_id: string; sales_card_id: string | null; status: string; order_number: string | null;
  cid: string | null; name: string | null; fantasy_name: string | null; phone: string | null;
  operation_type: string | null; motivo: string | null;
};

/** Paradas de uma rota (ou uma parada) com cliente, telefone e nº do pedido. */
async function paradas(where: { routeId?: string; stopId?: string }): Promise<Parada[]> {
  const cond = where.stopId ? sql`s.id = ${where.stopId}` : sql`s.route_id = ${where.routeId}`;
  const r: any = await db.execute(sql`
    SELECT s.id AS stop_id, s.sales_card_id, s.status::text AS status,
           COALESCE(s.order_number, bp.order_number) AS order_number,
           c.id AS cid, c.name, c.fantasy_name, c.phone,
           COALESCE(sc.operation_type::text, bp.operation_type, 'venda') AS operation_type,
           sc.delivery_failure_reason::text AS motivo
    FROM delivery_route_stops s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN sales_cards sc ON sc.id = s.sales_card_id
    LEFT JOIN LATERAL (SELECT order_number, operation_type FROM billing_pipeline b
                       WHERE b.sales_card_id = s.sales_card_id ORDER BY created_at DESC LIMIT 1) bp ON true
    WHERE ${cond}
    ORDER BY s.stop_order`);
  return (r.rows || []) as Parada[];
}

function elegivel(p: Parada): string | null {
  if (!p.sales_card_id) return 'parada sem pedido';
  if (String(p.operation_type || 'venda') !== 'venda') return 'nao e venda';
  if (!p.phone || !String(p.phone).replace(/\D/g, '')) return 'cliente sem telefone';
  return null;
}

async function enfileirar(p: Parada, ev: keyof typeof TEMPLATES, campaign: string, extra: { scheduledAt?: Date; motivo?: string } = {}): Promise<string> {
  const t = await escolherTemplate(ev);
  if (!t) return 'sem template ativo (' + TEMPLATES[ev].novo + ')';
  const n = await variaveisDo(t.label);
  const params: string[] = [primeiroNome(p), numeroDe(p)];
  if (n >= 3) params.push(limpo(extra.motivo || MOTIVO[String(p.motivo || 'other')] || MOTIVO.other));
  if (n > 0 && n !== params.length) return `template ${t.label} espera ${n} variaveis, tenho ${params.length}`;
  const r = await enqueueOfficialDispatch({
    customerId: p.cid || undefined, customerPhone: String(p.phone), templateLabel: t.label, params,
    useCase: USE_CASE, campaign, category: 'UTILITY',
  });
  if (r === 'enfileirado' && extra.scheduledAt) {
    // O enqueue não conhece agendamento; marca a linha recém-criada (única por campanha).
    await db.execute(sql`UPDATE official_dispatches SET scheduled_at = ${extra.scheduledAt.toISOString()}::timestamptz
      WHERE campaign = ${campaign} AND status = 'fila' AND scheduled_at IS NULL`);
  }
  return r + ' (' + t.label + ')';
}

/** 10:00 de Brasília, N dias depois de `base`. Fim de semana/feriado quem trata é o horário comercial da fila. */
export function daquiADias(base: Date, dias: number, horaBRT = 10): Date {
  const brt = new Date(base.getTime() - 3 * 3600 * 1000); // BRT = UTC-3 (sem horário de verão)
  const y = brt.getUTCFullYear(), m = brt.getUTCMonth(), d = brt.getUTCDate() + dias;
  return new Date(Date.UTC(y, m, d, horaBRT + 3, 0, 0));
}

// ----------------------------------------------------------------------------
// 1) Rota iniciada → "seu pedido saiu para entrega" para cada parada pendente
// ----------------------------------------------------------------------------
export async function avisarRotaIniciada(routeId: string): Promise<{ enviados: number; detalhes: string[] }> {
  const out = { enviados: 0, detalhes: [] as string[] };
  if (!(await ligado())) { out.detalhes.push('oficial_entrega=off'); return out; }
  await ensureEntregaClienteSchema();
  for (const p of await paradas({ routeId })) {
    if (p.status !== 'pendente') { out.detalhes.push(`${p.stop_id}: parada ${p.status}`); continue; }
    const m = elegivel(p); if (m) { out.detalhes.push(`${p.stop_id}: ${m}`); continue; }
    try {
      // A chave leva o dia: um pedido devolvido e reenviado amanha avisa de novo.
      const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      if (await avisadoRecentemente(['card:' + p.sales_card_id + ':saiu'])) { out.detalhes.push(`${numeroDe(p)}: ja avisado pelo pipeline`); continue; }
      const r = await enfileirar(p, 'saiu', 'card:' + p.sales_card_id + ':saiu:' + hoje);
      if (r.startsWith('enfileirado')) out.enviados++;
      out.detalhes.push(`${numeroDe(p)}: ${r}`);
    } catch (e: any) { out.detalhes.push(`${numeroDe(p)}: erro ${e?.message || e}`); }
  }
  console.log(`[ENTREGA-CLIENTE] rota ${routeId} iniciada: ${out.enviados} aviso(s) "saiu para entrega"`);
  return out;
}

// ----------------------------------------------------------------------------
// 2) Entrega efetuada → "entrega feita" agora + "deu tudo certo?" em 2 dias
// ----------------------------------------------------------------------------
export async function avisarEntregaEfetuada(stopId: string, quando: Date = new Date()): Promise<{ agora: string; followUp: string }> {
  const out = { agora: 'nao', followUp: 'nao' };
  if (!(await ligado())) return { agora: 'oficial_entrega=off', followUp: 'oficial_entrega=off' };
  await ensureEntregaClienteSchema();
  const [p] = await paradas({ stopId });
  if (!p) return { agora: 'parada nao encontrada', followUp: 'nao' };
  const m = elegivel(p); if (m) return { agora: m, followUp: m };
  try { out.agora = await enfileirar(p, 'entregue', 'card:' + p.sales_card_id + ':entregue'); } catch (e: any) { out.agora = 'erro ' + (e?.message || e); }
  try {
    const dias = Math.max(1, Number(await getSetting('entrega_followup_dias', '2')) || 2);
    out.followUp = await enfileirar(p, 'pos2d', 'card:' + p.sales_card_id + ':pos2d', { scheduledAt: daquiADias(quando, dias) });
  } catch (e: any) { out.followUp = 'erro ' + (e?.message || e); }
  console.log(`[ENTREGA-CLIENTE] entrega ${numeroDe(p)}: agora=${out.agora}; follow-up=${out.followUp}`);
  return out;
}

// ----------------------------------------------------------------------------
// 3) Devolução → "poxa, não conseguimos… vamos priorizar uma nova rota"
// ----------------------------------------------------------------------------
export async function avisarEntregaDevolvida(stopId: string, motivo?: string): Promise<string> {
  if (!(await ligado())) return 'oficial_entrega=off';
  await ensureEntregaClienteSchema();
  const [p] = await paradas({ stopId });
  if (!p) return 'parada nao encontrada';
  const m = elegivel(p); if (m) return m;
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (await avisadoRecentemente(['card:' + p.sales_card_id + ':falhou'])) return 'ja avisado pelo pipeline';
  try {
    const r = await enfileirar(p, 'devolvida', 'card:' + p.sales_card_id + ':devolvida:' + dia, { motivo: motivo ? limpo(motivo).slice(0, 80) : undefined });
    // Se um follow-up de 2 dias estava agendado de uma entrega anterior deste pedido, não vale mais.
    // 'falha' é o estado terminal que o enum já tem — o texto do erro diz o porquê.
    await db.execute(sql`UPDATE official_dispatches SET status = 'falha'::dispatch_status, error = 'cancelado: pedido devolvido antes do follow-up', updated_at = now()
      WHERE campaign = ${'card:' + p.sales_card_id + ':pos2d'} AND status = 'fila'`).catch(() => {});
    console.log(`[ENTREGA-CLIENTE] devolucao ${numeroDe(p)}: ${r}`);
    return r;
  } catch (e: any) { return 'erro ' + (e?.message || e); }
}

/** Painel: o que está agendado e o que já saiu por este caso de uso. */
export async function panorama(): Promise<any> {
  await ensureEntregaClienteSchema();
  const r: any = await db.execute(sql`
    SELECT template_label, status::text AS status, count(*)::int AS n,
           min(scheduled_at) AS proximo
    FROM official_dispatches WHERE use_case::text = ${USE_CASE} AND created_at > now() - interval '30 days'
    GROUP BY 1, 2 ORDER BY 1, 2`);
  const tpl: any = {};
  for (const ev of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) tpl[ev] = await escolherTemplate(ev);
  return { ligado: await ligado(), templates: tpl, ultimos30d: r.rows || [] };
}
