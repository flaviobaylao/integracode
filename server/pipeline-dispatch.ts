// ============================================================================
// INTEGRA 2.0 — Fase 3: gatilho dos disparos de PEDIDO no 1841
// Transforma acontecimento do pipeline em aviso ao cliente. Ate aqui os templates
// existiam e nada os disparava: `enqueueOfficialDispatch` so era chamado pela rota do dia.
//
// Cinco momentos:
//   1. pedido implantado, sem bloqueio          -> pedido_confirmado
//   2. pedido nasce retido por debito           -> pedido_confirmado_debito
//   3. pedido nasce retido por prazo/aprovacao  -> pedido_confirmado_analise
//   4. pedido liberado (debito regularizado)    -> pedido_liberado
//   5. pedido faturado com NF e data de entrega -> entrega_programada
//
// Decisoes que valem a leitura:
//   - LISTA DE PERMISSAO por tipo de operacao: so 'venda' fala com o cliente. Troca,
//     amostra, transferencia (e qualquer tipo novo) nascem em silencio.
//   - So bloqueio por DEBITO e assunto do cliente. Amostra/troca e aprovacao interna:
//     dizer "seu pedido esta bloqueado" cria um problema que nao existia.
//   - IDEMPOTENCIA por evento: campaign = 'card:<id>:<evento>'. O mesmo pedido nunca
//     avisa duas vezes, mesmo com a varredura repetindo.
//   - MARCO ZERO: na primeira execucao grava 'pipeline_inicio' e ignora tudo que e
//     anterior. Sem isso, ligar o gatilho dispararia para meses de pedidos passados.
//   - PISO ENTRE AVISOS DE DEBITO: quem fecha tres pedidos na semana com o mesmo debito
//     recebe UM aviso, nao tres.
//
// Wiring: chamado por registerOfficialDispatch(app) em ./official-dispatch.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
      VALUES (${key}, ${value}, 'pipeline-dispatch') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  } catch { /* noop */ }
}

const brl = (v: any) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBR = (d: any) => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
const nomeDe = (r: any) => String(r.fantasy_name || r.name || 'Cliente').slice(0, 60);
const numeroDe = (r: any) => String(r.order_number || ('INT-' + String(r.sales_card_id || r.id || '').substring(0, 8)));

// Variavel de template nao aceita quebra de linha, tab nem 4+ espacos seguidos.
function limpo(s: any): string {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// Marco zero: nada anterior a esta marca dispara. Gravado na primeira execucao.
async function inicio(): Promise<Date> {
  const v = await getSetting('pipeline_inicio', '');
  if (v) { const t = Date.parse(v); if (!isNaN(t)) return new Date(t); }
  const agora = new Date();
  await setSetting('pipeline_inicio', agora.toISOString());
  console.log('[PIPELINE-DISPATCH] marco zero gravado:', agora.toISOString());
  return agora;
}

// O template ja existe e esta ligado? Sem isso, cada evento de entrega entraria na fila
// so para falhar com "template nao encontrado" enquanto os textos nao sao aprovados.
async function templatePronto(label: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT umbler_id, COALESCE(is_active, true) AS ativo
      FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
    const row = r.rows?.[0];
    return !!(row && row.umbler_id && row.ativo !== false);
  } catch { return false; }
}

// Confere a quantidade de variaveis contra o texto APROVADO antes de enfileirar.
// O texto pode voltar da aprovacao diferente do que foi proposto (aconteceu com o
// pedido_saiu_entrega, que perdeu a variavel de horario) — e parametro a mais ou a
// menos e recusado pela Meta com erro 132000, gastando a tentativa.
async function paramsBatem(label: string, params: string[]): Promise<{ ok: boolean; motivo?: string }> {
  try {
    const r: any = await db.execute(sql`SELECT corpo FROM whatsapp_templates WHERE label = ${label} LIMIT 1`);
    const corpo = String(r.rows?.[0]?.corpo || '');
    if (!corpo) return { ok: true };                    // sem copia do texto, segue
    let max = 0;
    for (const m of corpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, parseInt(m[1], 10) || 0);
    if (max && params.length !== max) {
      return { ok: false, motivo: `template ${label} usa ${max} variavel(is) e o gatilho mandou ${params.length}` };
    }
    return { ok: true };
  } catch { return { ok: true }; }
}

// Motivo da falha em linguagem de cliente. O rotulo interno nao serve: "customer_absent"
// vira "nao havia ninguem no local".
const MOTIVO_FALHA: Record<string, string> = {
  customer_absent: 'não havia ninguém no local para receber',
  address_incorrect: 'divergência no endereço de entrega',
  customer_refused: 'o pedido não pôde ser recebido',
  payment_issue: 'pendência no pagamento',
  product_damaged: 'avaria identificada no produto',
  other: 'um imprevisto na rota',
};

async function jaAvisado(campaign: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT 1 FROM official_dispatches WHERE campaign = ${campaign} LIMIT 1`);
    return !!r.rows?.length;
  } catch { return false; }
}

// Um aviso de debito por cliente a cada N horas, mesmo com varios pedidos.
async function avisoDeDebitoRecente(phone: string, horas: number): Promise<boolean> {
  try {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 8) return false;
    const r: any = await db.execute(sql`SELECT 1 FROM official_dispatches
      WHERE right(customer_phone, 8) = ${d.slice(-8)}
        AND template_label = 'pedido_confirmado_debito'
        AND created_at > now() - make_interval(hours => ${horas}) LIMIT 1`);
    return !!r.rows?.length;
  } catch { return false; }
}

type Resumo = { confirmado: number; debito: number; analise: number; liberado: number; entrega: number; pulados: string[] };


// ---------------------------------------------------------------------------
// DISPARO IMEDIATO — o aviso sai quando o pedido acontece, nao na hora da varredura.
// Os disparos sairam 18:49, 17:49, 16:49, 14:19: sempre poucos minutos depois das
// varreduras de :15/:45. Nao era agendamento de proposito — era a varredura de 2 min
// sendo, na pratica, o unico gatilho. Agora quem cria o pedido chama aqui na hora.
//
// O debounce de 3s existe porque um lote (importacao, liberacao em massa) chamaria isto
// dezenas de vezes seguidas; uma varredura so ja cobre o lote inteiro.
// ---------------------------------------------------------------------------
let _pendente: NodeJS.Timeout | null = null;
let _rodando = false;
export function dispararAgora(motivo: string): void {
  if (_pendente) return;                       // ja tem uma passada marcada
  _pendente = setTimeout(async () => {
    _pendente = null;
    if (_rodando) return;                      // nao empilha varredura
    _rodando = true;
    try {
      const r = await pipelineTick();
      const n = (r.confirmado || 0) + (r.debito || 0) + (r.analise || 0) + (r.liberado || 0) + (r.entrega || 0);
      if (n > 0) console.log(`[PIPELINE-DISPATCH] disparo imediato (${motivo}): ${n} aviso(s) enfileirado(s)`);
    } catch (e: any) { console.error('[PIPELINE-DISPATCH] disparo imediato', e?.message || e); }
    finally { _rodando = false; }
  }, 3000);
  if (typeof (_pendente as any)?.unref === 'function') (_pendente as any).unref();
}

export async function pipelineTick(force = false): Promise<{ ran: boolean; motivo?: string } & Partial<Resumo>> {
  const out: Resumo = { confirmado: 0, debito: 0, analise: 0, liberado: 0, entrega: 0, pulados: [] };
  try {
    if ((await getSetting('pipeline_tick_on', 'on')) !== 'on' && !force) return { ran: false, motivo: 'gatilho_off' };
    if ((await getSetting('oficial_pipeline', 'off')) !== 'on' && !force) return { ran: false, motivo: 'caso_de_uso_off' };

    const desde = await inicio();
    const janela = Math.max(5, parseInt(await getSetting('pipeline_janela_min', '120'), 10) || 120);
    const corte = new Date(Math.max(desde.getTime(), Date.now() - janela * 60000));
    const debitoHoras = Math.max(1, parseInt(await getSetting('pipeline_debito_horas', '48'), 10) || 48);
    const { enqueueOfficialDispatch } = await import('./official-dispatch');
    const { linhaDebitos } = await import('./official-templates');

    // ---------------------------------------------------------------- 1) implantado
    const novos: any = await db.execute(sql`
      SELECT bp.sales_card_id, bp.order_number, bp.sale_value, bp.created_at,
             c.id AS cid, c.name, c.fantasy_name, c.phone
      FROM billing_pipeline bp
      JOIN customers c ON c.id = bp.customer_id
      WHERE bp.created_at > ${corte.toISOString()}::timestamptz
        AND COALESCE(bp.operation_type, 'venda') = 'venda'
        AND COALESCE(c.phone, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM blocked_orders bo
                        WHERE bo.sales_card_id = bp.sales_card_id AND bo.status = 'blocked')
      ORDER BY bp.created_at LIMIT 100`);
    for (const r of (novos.rows || [])) {
      const campaign = 'card:' + r.sales_card_id + ':confirmado';
      if (await jaAvisado(campaign)) continue;
      const p1 = [nomeDe(r), limpo(numeroDe(r)), brl(r.sale_value)];
      const c1 = await paramsBatem('pedido_confirmado', p1);
      if (!c1.ok) { out.pulados.push(`confirmado ${r.sales_card_id}: ${c1.motivo}`); continue; }
      const res = await enqueueOfficialDispatch({
        customerId: r.cid, customerPhone: r.phone, templateLabel: 'pedido_confirmado',
        params: p1,
        useCase: 'pipeline', campaign, category: 'UTILITY',
      });
      if (res === 'enfileirado') out.confirmado++; else out.pulados.push(`confirmado ${r.sales_card_id}: ${res}`);
    }

    // ------------------------------------------------- 2 e 3) nasceu bloqueado
    const bloqueados: any = await db.execute(sql`
      SELECT bo.sales_card_id, bo.block_reason, bo.total_amount, bo.blocked_at, bo.boleto_days,
             bp.order_number, sc.payment_method,
             c.id AS cid, c.name, c.fantasy_name, c.phone, c.cnpj, c.cpf
      FROM blocked_orders bo
      JOIN customers c ON c.id = bo.customer_id
      LEFT JOIN sales_cards sc ON sc.id = bo.sales_card_id
      LEFT JOIN LATERAL (SELECT order_number FROM billing_pipeline b
                         WHERE b.sales_card_id = bo.sales_card_id ORDER BY created_at DESC LIMIT 1) bp ON true
      WHERE bo.status = 'blocked'
        AND bo.blocked_at > ${corte.toISOString()}::timestamptz
        AND COALESCE(bo.operation_type::text, 'venda') = 'venda'
        AND COALESCE(c.phone, '') <> ''
      ORDER BY bo.blocked_at LIMIT 100`);
    for (const r of (bloqueados.rows || [])) {
      const motivo = String(r.block_reason || '');
      // Amostra/troca e bloqueio manual sao aprovacao interna: o cliente nao e avisado.
      if (motivo === 'overdue_debt') {
        const campaign = 'card:' + r.sales_card_id + ':debito';
        if (await jaAvisado(campaign)) continue;
        if (await avisoDeDebitoRecente(r.phone, debitoHoras)) {
          out.pulados.push(`debito ${r.sales_card_id}: aviso recente (piso de ${debitoHoras}h)`);
          continue;
        }
        const dbt = await linhaDebitos(String(r.cnpj || r.cpf || ''));
        if (!dbt.linha) { out.pulados.push(`debito ${r.sales_card_id}: sem titulos para listar`); continue; }
        const p2 = [nomeDe(r), limpo(numeroDe(r)), brl(r.total_amount), limpo(dbt.linha), dbt.total];
        const c2 = await paramsBatem('pedido_confirmado_debito', p2);
        if (!c2.ok) { out.pulados.push(`debito ${r.sales_card_id}: ${c2.motivo}`); continue; }
        const res = await enqueueOfficialDispatch({
          customerId: r.cid, customerPhone: r.phone, templateLabel: 'pedido_confirmado_debito',
          params: p2,
          useCase: 'pipeline', campaign, category: 'UTILITY',
        });
        if (res === 'enfileirado') out.debito++; else out.pulados.push(`debito ${r.sales_card_id}: ${res}`);
      } else if (motivo === 'payment_terms' || motivo === 'boleto_days_exceeded') {
        const campaign = 'card:' + r.sales_card_id + ':analise';
        if (await jaAvisado(campaign)) continue;
        const cond = r.boleto_days ? `boleto ${r.boleto_days} dias`
          : (r.payment_method ? String(r.payment_method).replace(/_/g, ' ') : 'a combinar');
        const p3 = [nomeDe(r), limpo(numeroDe(r)), brl(r.total_amount), limpo(cond)];
        const c3 = await paramsBatem('pedido_confirmado_analise', p3);
        if (!c3.ok) { out.pulados.push(`analise ${r.sales_card_id}: ${c3.motivo}`); continue; }
        const res = await enqueueOfficialDispatch({
          customerId: r.cid, customerPhone: r.phone, templateLabel: 'pedido_confirmado_analise',
          params: p3,
          useCase: 'pipeline', campaign, category: 'UTILITY',
        });
        if (res === 'enfileirado') out.analise++; else out.pulados.push(`analise ${r.sales_card_id}: ${res}`);
      }
    }

    // ------------------------------------------------------------- 4) liberado
    const liberados: any = await db.execute(sql`
      SELECT bo.sales_card_id, bo.released_at, c.id AS cid, c.name, c.fantasy_name, c.phone
      FROM blocked_orders bo
      JOIN customers c ON c.id = bo.customer_id
      WHERE bo.status = 'released'
        AND bo.block_reason = 'overdue_debt'
        AND bo.released_at > ${corte.toISOString()}::timestamptz
        AND COALESCE(c.phone, '') <> ''
      ORDER BY bo.released_at LIMIT 100`);
    for (const r of (liberados.rows || [])) {
      const campaign = 'card:' + r.sales_card_id + ':liberado';
      if (await jaAvisado(campaign)) continue;
      // So avisa a liberacao de quem foi avisado do bloqueio — senao o cliente recebe
      // "seu pedido foi liberado" sem nunca ter sabido que estava retido.
      if (!(await jaAvisado('card:' + r.sales_card_id + ':debito'))) {
        out.pulados.push(`liberado ${r.sales_card_id}: nao foi avisado do bloqueio`);
        continue;
      }
      const res = await enqueueOfficialDispatch({
        customerId: r.cid, customerPhone: r.phone, templateLabel: 'pedido_liberado',
        params: [nomeDe(r)], useCase: 'pipeline', campaign, category: 'UTILITY',
      });
      if (res === 'enfileirado') out.liberado++; else out.pulados.push(`liberado ${r.sales_card_id}: ${res}`);
    }

    // -------------------------------------------------- 5) faturado com entrega
    const entregas: any = await db.execute(sql`
      SELECT bp.sales_card_id, bp.invoice_number, bp.updated_at,
             sc.delivery_scheduled_date, c.id AS cid, c.name, c.fantasy_name, c.phone
      FROM billing_pipeline bp
      JOIN customers c ON c.id = bp.customer_id
      LEFT JOIN sales_cards sc ON sc.id = bp.sales_card_id
      WHERE bp.updated_at > ${corte.toISOString()}::timestamptz
        AND COALESCE(bp.operation_type, 'venda') = 'venda'
        AND COALESCE(bp.invoice_number, '') <> ''
        AND bp.stage IN ('faturado','impresso','aguardando_rota')
        AND sc.delivery_scheduled_date IS NOT NULL
        AND COALESCE(c.phone, '') <> ''
      ORDER BY bp.updated_at LIMIT 100`);
    for (const r of (entregas.rows || [])) {
      const campaign = 'card:' + r.sales_card_id + ':entrega';
      if (await jaAvisado(campaign)) continue;
      const p5 = [nomeDe(r), limpo(r.invoice_number), dataBR(r.delivery_scheduled_date)];
      const c5 = await paramsBatem('entrega_programada', p5);
      if (!c5.ok) { out.pulados.push(`entrega ${r.sales_card_id}: ${c5.motivo}`); continue; }
      const res = await enqueueOfficialDispatch({
        customerId: r.cid, customerPhone: r.phone, templateLabel: 'entrega_programada',
        params: p5,
        useCase: 'pipeline', campaign, category: 'UTILITY',
      });
      if (res === 'enfileirado') out.entrega++; else out.pulados.push(`entrega ${r.sales_card_id}: ${res}`);
    }

    // ------------------------------------------- 6, 7 e 8) ciclo da entrega
    // Fonte: delivery_history — uma linha por transicao, venha do app do motorista, do
    // painel ou do Omie. Um lugar so cobre todas as origens.
    const EVENTOS_ENTREGA: Record<string, { label: string; evento: string }> = {
      in_transit: { label: 'pedido_saiu_entrega', evento: 'saiu' },
      delivered: { label: 'pedido_entregue', evento: 'entregue' },
      failed: { label: 'entrega_nao_realizada', evento: 'falhou' },
    };
    const movs: any = await db.execute(sql`
      SELECT dh.sales_card_id, dh.status::text AS status, dh.timestamp, dh.notes,
             bp.order_number, sc.delivery_failure_reason::text AS motivo,
             c.id AS cid, c.name, c.fantasy_name, c.phone
      FROM delivery_history dh
      JOIN customers c ON c.id = dh.customer_id
      LEFT JOIN sales_cards sc ON sc.id = dh.sales_card_id
      LEFT JOIN LATERAL (SELECT order_number, operation_type FROM billing_pipeline b
                         WHERE b.sales_card_id = dh.sales_card_id ORDER BY created_at DESC LIMIT 1) bp ON true
      WHERE dh.timestamp > ${corte.toISOString()}::timestamptz
        AND dh.status::text IN ('in_transit','delivered','failed')
        AND COALESCE(sc.operation_type::text, bp.operation_type, 'venda') = 'venda'
        AND COALESCE(c.phone, '') <> ''
      ORDER BY dh.timestamp LIMIT 200`);
    for (const r of (movs.rows || [])) {
      const ev = EVENTOS_ENTREGA[String(r.status)];
      if (!ev) continue;
      const campaign = 'card:' + r.sales_card_id + ':' + ev.evento;
      if (await jaAvisado(campaign)) continue;
      if (!(await templatePronto(ev.label))) {
        out.pulados.push(`${ev.evento} ${r.sales_card_id}: template ${ev.label} nao cadastrado/ativo`);
        continue;
      }
      let params: string[];
      if (ev.evento === 'saiu') {
        // O texto aprovado ficou com DUAS variaveis (nome e pedido) — sem a janela de
        // horario que eu tinha proposto. Mandar tres derruba o envio com erro 132000.
        params = [nomeDe(r), limpo(numeroDe(r))];
      } else if (ev.evento === 'entregue') {
        params = [nomeDe(r), limpo(numeroDe(r))];
      } else {
        const motivo = MOTIVO_FALHA[String(r.motivo || 'other')] || MOTIVO_FALHA.other;
        params = [nomeDe(r), limpo(numeroDe(r)), limpo(motivo)];
      }
      const cx = await paramsBatem(ev.label, params);
      if (!cx.ok) { out.pulados.push(`${ev.evento} ${r.sales_card_id}: ${cx.motivo}`); continue; }
      const res = await enqueueOfficialDispatch({
        customerId: r.cid, customerPhone: r.phone, templateLabel: ev.label,
        params, useCase: 'pipeline', campaign, category: 'UTILITY',
      });
      if (res === 'enfileirado') out.entrega++;
      else out.pulados.push(`${ev.evento} ${r.sales_card_id}: ${res}`);

      // Entrega que falha nao se resolve com template: quem vendeu precisa remarcar.
      // Telemarketing recebe alerta em tela; vendedor externo, WhatsApp.
      if (ev.evento === 'falhou') {
        try {
          const { avisarFalhaDeEntrega } = await import('./entrega-avisos');
          const av = await avisarFalhaDeEntrega({
            salesCardId: String(r.sales_card_id),
            numeroPedido: numeroDe(r),
            cliente: nomeDe(r),
            motivo: MOTIVO_FALHA[String(r.motivo || 'other')] || MOTIVO_FALHA.other,
          });
          if (!av.ok && av.motivo && av.motivo !== 'ja avisado') {
            out.pulados.push(`aviso-vendedor ${r.sales_card_id}: ${av.motivo}`);
          }
        } catch (e: any) { out.pulados.push(`aviso-vendedor ${r.sales_card_id}: ${e?.message || e}`); }
      }
    }

    const total = out.confirmado + out.debito + out.analise + out.liberado + out.entrega;
    if (total || out.pulados.length) {
      console.log(`[PIPELINE-DISPATCH] confirmado=${out.confirmado} debito=${out.debito} analise=${out.analise} liberado=${out.liberado} entrega=${out.entrega} pulados=${out.pulados.length}`);
    }
    return { ran: true, ...out };
  } catch (e: any) {
    console.error('[PIPELINE-DISPATCH]', e?.message || e);
    return { ran: false, motivo: e?.message || String(e), ...out };
  }
}

export function registerPipelineDispatch(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // Roda a varredura na hora (diagnostico). ?force=1 ignora os liga/desliga.
  app.get('/api/admin/oficial/pipeline/run', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json(await pipelineTick(String(req.query.force || '') === '1'));
  });

  // O que a varredura ENXERGA agora, sem enfileirar nada.
  app.get('/api/admin/oficial/pipeline/previa', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const janela = Math.max(5, parseInt(String(req.query.min || await getSetting('pipeline_janela_min', '120')), 10) || 120);
      const corte = new Date(Date.now() - janela * 60000).toISOString();
      const q = async (s: any) => ((await db.execute(s)).rows || []);
      res.json({
        janelaMin: janela,
        marcoZero: await getSetting('pipeline_inicio', '(ainda nao gravado)'),
        gatilho: await getSetting('pipeline_tick_on', 'on'),
        casoDeUso: await getSetting('oficial_pipeline', 'off'),
        implantados: await q(sql`SELECT count(*)::int n FROM billing_pipeline bp JOIN customers c ON c.id = bp.customer_id
          WHERE bp.created_at > ${corte}::timestamptz AND COALESCE(bp.operation_type,'venda')='venda' AND COALESCE(c.phone,'')<>''`),
        bloqueados: await q(sql`SELECT block_reason, count(*)::int n FROM blocked_orders
          WHERE status='blocked' AND blocked_at > ${corte}::timestamptz GROUP BY block_reason`),
        liberados: await q(sql`SELECT count(*)::int n FROM blocked_orders
          WHERE status='released' AND block_reason='overdue_debt' AND released_at > ${corte}::timestamptz`),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Move o marco zero (ex.: 'agora' para nao pegar backlog ao ligar).
  app.get('/api/admin/oficial/pipeline/marco', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const v = String(req.query.quando || '') === 'agora' ? new Date().toISOString() : String(req.query.quando || '');
    if (!v || isNaN(Date.parse(v))) return res.status(400).json({ error: 'use ?quando=agora ou uma data ISO' });
    await setSetting('pipeline_inicio', new Date(v).toISOString());
    res.json({ ok: true, marcoZero: await getSetting('pipeline_inicio', '') });
  });

  // O gatilho de verdade agora e o dispararAgora(), chamado por quem cria o pedido.
  // Esta varredura vira REDE DE SEGURANCA: pega o que entrou por algum caminho que ainda
  // nao chama o hook (importacao, correcao manual no banco). 30s para o atraso maximo
  // ser de meio minuto quando o hook nao pegar.
  setTimeout(() => {
    pipelineTick().catch(() => {});
    setInterval(() => { pipelineTick().catch(() => {}); }, 30000);
  }, 180000);

  console.log('[PIPELINE-DISPATCH] registrado (disparo imediato + rede de seguranca a cada 30s)');
}
