// ============================================================================
// INTEGRA 2.0 — IA · Financeiro do cliente (consulta + envio de boleto/PIX + NF)
//
// Pedido do Flavio (11/10/2026): o agente do WhatsApp deve responder sozinho, com dados
// do sistema, sobre debitos, titulos vencidos E a vencer, pagamentos ja feitos e notas
// fiscais — e enviar boleto / 2a via ao cliente. Antes so existia o recorte "vencido".
//
// Ferramentas (registradas em agent-runtime.ts):
//   consultar_financeiro  -> extrato: vencidos, a vencer, pagos recentes, ultimas NFs
//   enviar_boleto         -> manda link do boleto (BB) + PIX copia-e-cola dos titulos em
//                            aberto (vencidos e/ou a vencer; ou um titulo especifico)
//   enviar_nota_fiscal    -> manda link publico (com token) do DANFE em PDF
//
// Rota publica: GET /api/nf-view/:id?t=<token>  (DANFE PDF; token = HMAC do id)
//
// Fonte unica de "titulo em aberto": receivables com a MESMA regra de divida viva usada
// no bloqueio de credito (divida-viva.ts), sem o corte de data — o corte vencido/a vencer
// e feito aqui pela due_date.
// ============================================================================
import { createHmac } from 'crypto';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { ehDividaVivaText } from './divida-viva';
import { naoEFantasmaText } from './ghost-receivables';

const APP_URL = process.env.APP_URL || 'https://integracode-production.up.railway.app';
const TZ = 'America/Sao_Paulo';

function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function onlyDigits(s: any) { return String(s || '').replace(/\D/g, ''); }
function dmy(d: any) { return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ }) : '-'; }

// Token do link publico da NF: nao expoe nada sem o token, e o token so sai daqui.
function segredo(): string {
  return process.env.NF_VIEW_SECRET || process.env.OFICIAL_ADMIN_KEY || process.env.SESSION_SECRET || process.env.DATABASE_URL || 'integra-nf';
}
export function tokenNf(id: string): string {
  return createHmac('sha256', segredo()).update('nf:' + id).digest('hex').slice(0, 20);
}
export function linkNf(id: string): string { return `${APP_URL}/api/nf-view/${id}?t=${tokenNf(id)}`; }

// Titulos em aberto do cliente (por id OU por documento), classificados.
function whereAbertoText(a: string): string {
  return `(
    ${a}.deleted_at IS NULL
    AND (${a}.amount - COALESCE(${a}.amount_paid, 0)) > 0
    AND ${naoEFantasmaText(a)}
    AND ${ehDividaVivaText(a)}
    AND COALESCE(${a}.import_origin, '') <> 'omie_historico'
    AND ${a}.status IN ('a_vencer', 'vencida')
  )`;
}

async function dadosCliente(cid: string): Promise<{ nome: string; doc: string }> {
  const c: any = await db.execute(sql`SELECT name, fantasy_name, cnpj, cpf FROM customers WHERE id = ${cid} LIMIT 1`);
  const cli = c.rows?.[0];
  return { nome: String(cli?.fantasy_name || cli?.name || '').slice(0, 60), doc: onlyDigits(cli?.cnpj || cli?.cpf || '') };
}

type Titulo = { id: string; titulo: string; venc: Date | null; dias: number; saldo: number; amount: number; boleto_id: string | null; boleto_status: string | null; linha: string | null };

async function titulosAbertos(cid: string, doc: string): Promise<Titulo[]> {
  const r: any = await db.execute(sql`
    SELECT r.id, r.title_number, r.due_date, r.amount::float AS amount,
           (r.amount - COALESCE(r.amount_paid,0))::float AS saldo,
           ((now() AT TIME ZONE 'America/Sao_Paulo')::date - (r.due_date)::date) AS dias,
           b.id AS boleto_id, b.status AS boleto_status, b.linha_digitavel
    FROM receivables r
    LEFT JOIN LATERAL (SELECT id, status, linha_digitavel FROM boleto_charges bc
                       WHERE bc.receivable_id = r.id AND bc.deleted_at IS NULL
                         AND COALESCE(bc.status,'') NOT IN ('cancelado','CANCELADO','liquidado','PAGO','pago')
                       ORDER BY created_at DESC LIMIT 1) b ON true
    WHERE ${sql.raw(whereAbertoText('r'))}
      AND (r.customer_id = ${cid} OR regexp_replace(COALESCE(r.customer_document,''),'[^0-9]','','g') = ${doc || '___'})
    ORDER BY r.due_date
    LIMIT 30`);
  return (r.rows || []).map((t: any) => ({
    id: String(t.id), titulo: String(t.title_number || '').trim() || 'titulo', venc: t.due_date ? new Date(t.due_date) : null,
    dias: Number(t.dias || 0), saldo: Math.round(Number(t.saldo || 0) * 100) / 100, amount: Number(t.amount || 0),
    boleto_id: t.boleto_id || null, boleto_status: t.boleto_status || null, linha: t.linha_digitavel || null,
  }));
}

// ---------------------------------------------------------------------------
// consultar_financeiro
// ---------------------------------------------------------------------------
export async function consultarFinanceiro(ctx: any, input: any): Promise<string> {
  try {
    const { resolveCustomerId } = await import('./agent-runtime');
    const cid = await resolveCustomerId(ctx, input?.documento);
    if (!cid) return 'Cliente nao identificado nesta conversa. Peca o CPF/CNPJ e chame a ferramenta de novo. NAO invente valores.';
    const { nome, doc } = await dadosCliente(cid);
    const abertos = await titulosAbertos(cid, doc);
    const vencidos = abertos.filter(t => t.dias > 0);
    const aVencer = abertos.filter(t => t.dias <= 0);

    const pg: any = await db.execute(sql`
      SELECT r.title_number, r.due_date, COALESCE(r.paid_date, r.updated_at) AS pago_em, r.amount_paid::float AS pago, r.payment_method::text AS forma
      FROM receivables r
      WHERE r.deleted_at IS NULL AND r.status = 'recebida' AND COALESCE(r.amount_paid,0) > 0
        AND COALESCE(r.import_origin,'') <> 'omie_historico'
        AND (r.customer_id = ${cid} OR regexp_replace(COALESCE(r.customer_document,''),'[^0-9]','','g') = ${doc || '___'})
        AND COALESCE(r.paid_date, r.updated_at) > now() - interval '90 days'
      ORDER BY COALESCE(r.paid_date, r.updated_at) DESC LIMIT 6`);
    const pagos = pg.rows || [];

    const nf: any = await db.execute(sql`
      SELECT id, invoice_number, status, emission_date, total_invoice::float AS total
      FROM fiscal_invoices
      WHERE (customer_id = ${cid} OR regexp_replace(COALESCE(customer_cnpj_cpf,''),'[^0-9]','','g') = ${doc || '___'})
        AND status IN ('authorized','cancelled')
      ORDER BY COALESCE(emission_date, created_at) DESC LIMIT 5`);
    const notas = nf.rows || [];

    const L: string[] = [`FINANCEIRO DE ${nome || 'cliente'} (dados do sistema agora — responda SO com isto, nunca invente valor ou data):`];
    if (vencidos.length) {
      const tot = vencidos.reduce((s, t) => s + t.saldo, 0);
      L.push(`VENCIDOS: ${vencidos.length} titulo(s), total ${brl(tot)}:`);
      for (const t of vencidos) L.push(`  - ${t.titulo} · venceu ${dmy(t.venc)} (${t.dias} dia(s) de atraso) · ${brl(t.saldo)}${t.boleto_id ? ' · tem boleto' : ''}`);
    } else L.push('VENCIDOS: nenhum. (Cliente em dia com o que ja venceu.)');
    if (aVencer.length) {
      const tot = aVencer.reduce((s, t) => s + t.saldo, 0);
      L.push(`A VENCER: ${aVencer.length} titulo(s), total ${brl(tot)}:`);
      for (const t of aVencer) L.push(`  - ${t.titulo} · vence ${dmy(t.venc)}${t.dias === 0 ? ' (HOJE)' : ''} · ${brl(t.saldo)}${t.boleto_id ? ' · tem boleto' : ''}`);
    } else L.push('A VENCER: nenhum titulo em aberto.');
    if (pagos.length) {
      L.push('PAGOS (ultimos 90 dias):');
      for (const p of pagos) L.push(`  - ${String(p.title_number || '').trim() || 'titulo'} · venc. ${dmy(p.due_date)} · pago em ${dmy(p.pago_em)} · ${brl(p.pago)}${p.forma ? ' · ' + p.forma : ''}`);
    } else L.push('PAGOS (ultimos 90 dias): nenhum pagamento registrado.');
    if (notas.length) {
      L.push('NOTAS FISCAIS (ultimas):');
      for (const n of notas) L.push(`  - NF ${n.invoice_number} · ${dmy(n.emission_date)} · ${brl(n.total)} · ${n.status === 'cancelled' ? 'CANCELADA' : 'autorizada'} · PDF: ${linkNf(String(n.id))}`);
    } else L.push('NOTAS FISCAIS: nenhuma encontrada para este cadastro.');
    L.push('Para mandar boleto/PIX use enviar_boleto; para mandar a nota use enviar_nota_fiscal (ou envie o link do PDF acima).');
    return L.join('\n');
  } catch (e: any) {
    console.error('[IA-FIN] consultar', e?.message || e);
    return 'Nao consegui consultar o financeiro agora (erro interno). Peca desculpas e transfira para um atendente.';
  }
}

// ---------------------------------------------------------------------------
// enviar_boleto  — quais: 'vencidos' | 'a_vencer' | 'todos'; titulo: filtro opcional
// ---------------------------------------------------------------------------
export async function enviarBoleto(ctx: any, input: any): Promise<string> {
  try {
    const { resolveCustomerId } = await import('./agent-runtime');
    const cid = await resolveCustomerId(ctx, input?.documento);
    if (!cid) return 'Cliente nao identificado nesta conversa. Peca o CPF/CNPJ e chame a ferramenta de novo.';
    const { nome, doc } = await dadosCliente(cid);
    const quais = String(input?.quais || 'todos').toLowerCase();
    const filtro = String(input?.titulo || '').trim().toLowerCase();
    let lista = await titulosAbertos(cid, doc);
    if (quais === 'vencidos') lista = lista.filter(t => t.dias > 0);
    else if (quais === 'a_vencer') lista = lista.filter(t => t.dias <= 0);
    if (filtro) {
      const f = lista.filter(t => t.titulo.toLowerCase().includes(filtro) || t.titulo.toLowerCase().replace(/\D/g, '') === filtro.replace(/\D/g, ''));
      if (f.length) lista = f;
    }
    lista = lista.slice(0, 8);
    if (!lista.length) return quais === 'vencidos'
      ? 'Nenhum titulo VENCIDO em aberto para este cliente. Diga isso de forma simpatica.'
      : 'Nenhum titulo em aberto (vencido ou a vencer) para este cliente. Diga isso de forma simpatica.';

    const acc: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_pix_enabled = true AND pix_key IS NOT NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1`);
    const accountId = acc.rows?.[0]?.id;
    let createImmediateCharge: any = null;
    try { ({ createImmediateCharge } = await import('./bb-pix-service')); } catch {}

    const envios: Array<{ t: Titulo; link: string | null; copia: string }> = [];
    let total = 0, falhas = 0;
    for (const t of lista) {
      if (!(t.saldo > 0)) continue;
      const link = t.boleto_id ? `${APP_URL}/api/boleto-view/${t.boleto_id}` : null;
      let copia = '';
      // 1) boleto registrado ja tem PIX proprio
      if (t.boleto_id) {
        try {
          const b: any = await db.execute(sql`SELECT pix_copia_e_cola FROM boleto_charges WHERE id = ${t.boleto_id} LIMIT 1`);
          copia = String(b.rows?.[0]?.pix_copia_e_cola || '');
        } catch {}
      }
      // 2) cobranca PIX ativa do titulo
      if (!copia) {
        try {
          const ex: any = await db.execute(sql`SELECT pix_copia_e_cola, expires_at, amount FROM pix_charges
            WHERE receivable_id = ${t.id} AND status = 'ATIVA' ORDER BY created_at DESC LIMIT 1`);
          const e = ex.rows?.[0];
          const exp = e?.expires_at ? new Date(e.expires_at).getTime() < Date.now() : false;
          if (e && !exp && Math.abs(Number(e.amount) - t.saldo) < 0.01) copia = String(e.pix_copia_e_cola || '');
        } catch {}
      }
      // 3) gera PIX novo (24h)
      if (!copia && accountId && createImmediateCharge) {
        try {
          const ch: any = await createImmediateCharge(accountId, {
            amount: t.saldo, debtorName: nome || undefined, debtorDocument: doc || undefined,
            description: ('Honest - ' + t.titulo).slice(0, 100), expirationSeconds: 86400,
            receivableId: t.id, customerId: cid, createdBy: 'ia:' + String(ctx?.channel || 'whatsapp'),
          });
          copia = String(ch?.pixCopiaECola || '');
        } catch (e: any) { console.error('[IA-FIN] pix', t.titulo, e?.message || e); }
      }
      if (!copia && !link) { falhas++; continue; }
      envios.push({ t, link, copia });
      total += t.saldo;
    }
    if (!envios.length) return 'Nao consegui gerar as cobrancas agora. Peca desculpas ao cliente e transfira para um atendente.';

    if (ctx?.sendText) {
      const n = envios.length;
      const temVencido = envios.some(e => e.t.dias > 0);
      await ctx.sendText(ctx.phone, n > 1
        ? `Segue ${temVencido ? 'a 2ª via' : 'o boleto'} de ${n} títulos, total ${brl(total)}:`
        : `Segue ${temVencido ? 'a 2ª via do título' : 'o boleto'} de ${brl(total)}:`);
      for (const e of envios) {
        const st = e.t.dias > 0 ? `vencido em ${dmy(e.t.venc)}` : (e.t.dias === 0 ? 'vence HOJE' : `vence em ${dmy(e.t.venc)}`);
        await ctx.sendText(ctx.phone, `${e.t.titulo} · ${st} · ${brl(e.t.saldo)}${e.link ? '\nBoleto (PDF/linha digitável + PIX): ' + e.link : ''}`);
        if (e.copia) await ctx.sendText(ctx.phone, e.copia);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`[IA-FIN] enviar_boleto cliente=${cid} titulos=${envios.length} total=${total.toFixed(2)} falhas=${falhas}`);
    return `OK: JA FORAM ENVIADOS ao cliente ${envios.length} titulo(s) (link do boleto e/ou PIX copia-e-cola), total ${brl(total)}`
      + (falhas ? `; ${falhas} titulo(s) falharam` : '')
      + '. NAO reescreva links nem codigos. Confirme de forma curta que a baixa e automatica assim que o pagamento cair'
      + (falhas ? ' e avise que um atendente retorna sobre os demais.' : '.');
  } catch (e: any) {
    console.error('[IA-FIN] enviar_boleto', e?.message || e);
    return 'Nao consegui enviar o boleto agora (erro interno). Peca desculpas ao cliente e transfira para um atendente.';
  }
}

// ---------------------------------------------------------------------------
// enviar_nota_fiscal — numero opcional; sem numero manda a ultima autorizada
// ---------------------------------------------------------------------------
export async function enviarNotaFiscal(ctx: any, input: any): Promise<string> {
  try {
    const { resolveCustomerId } = await import('./agent-runtime');
    const cid = await resolveCustomerId(ctx, input?.documento);
    if (!cid) return 'Cliente nao identificado nesta conversa. Peca o CPF/CNPJ e chame a ferramenta de novo.';
    const { doc } = await dadosCliente(cid);
    const numero = onlyDigits(input?.numero);
    const r: any = await db.execute(sql`
      SELECT id, invoice_number, emission_date, total_invoice::float AS total, status
      FROM fiscal_invoices
      WHERE (customer_id = ${cid} OR regexp_replace(COALESCE(customer_cnpj_cpf,''),'[^0-9]','','g') = ${doc || '___'})
        AND status = 'authorized'
        AND (${numero} = '' OR regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g') = ${numero})
      ORDER BY COALESCE(emission_date, created_at) DESC LIMIT 1`);
    const n = r.rows?.[0];
    if (!n) return numero ? `Nao encontrei a NF ${numero} autorizada para este cliente. Confirme o numero.` : 'Nenhuma nota fiscal autorizada encontrada para este cadastro.';
    const link = linkNf(String(n.id));
    if (ctx?.sendText) await ctx.sendText(ctx.phone, `Nota fiscal ${n.invoice_number} · ${dmy(n.emission_date)} · ${brl(n.total)}\nPDF (DANFE): ${link}`);
    return `OK: JA FOI ENVIADO ao cliente o link do PDF da NF ${n.invoice_number} (${dmy(n.emission_date)}, ${brl(n.total)}). NAO reescreva o link; apenas confirme de forma curta.`;
  } catch (e: any) {
    console.error('[IA-FIN] enviar_nf', e?.message || e);
    return 'Nao consegui enviar a nota agora (erro interno). Peca desculpas e transfira para um atendente.';
  }
}

// ---------------------------------------------------------------------------
// Rota publica do DANFE (token obrigatorio)
// ---------------------------------------------------------------------------
export function registerIaFinanceiro(app: any) {
  app.get('/api/nf-view/:id', async (req: any, res: any) => {
    try {
      const id = String(req.params.id || '');
      if (!id || String(req.query.t || '') !== tokenNf(id)) return res.status(403).send('link invalido');
      const { storage } = await import('./storage');
      const inv: any = await storage.getFiscalInvoice(id);
      if (!inv) return res.status(404).send('Nota nao encontrada');
      const items = await storage.getFiscalInvoiceItems(id);
      const { montarDanfePdf } = await import('./doc-builders');
      const arq = montarDanfePdf({ ...inv, items });
      res.setHeader('Content-Type', arq.mime);
      res.setHeader('Content-Disposition', `inline; filename="${arq.filename}"`);
      res.send(arq.content);
    } catch (e: any) {
      console.error('[IA-FIN] nf-view', e?.message || e);
      res.status(500).send('erro ao gerar a nota');
    }
  });
  console.log('[IA-FIN] registrado (consultar_financeiro, enviar_boleto, enviar_nota_fiscal, /api/nf-view)');
}
