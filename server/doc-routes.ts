// ============================================================================
// INTEGRA 2.0 — ROTAS DO ENVIO DE DOCUMENTOS
//
//   GET  /api/doc/:token[/:filename]           PUBLICO — o Umbler baixa a midia aqui.
//   GET  /api/admin/doc-delivery/status        diagnostico (SMTP + WhatsApp + ultimas entregas)
//   POST /api/admin/doc-delivery/test-email    envia um e-mail de teste
//   POST /api/admin/doc-delivery/send          reenvio MANUAL de um documento ao cliente
//
// A rota publica e a unica sem login (o Umbler baixa o arquivo sem cookie). Ela
// e segura por token opaco de 24 bytes + validade; nao aceita id de cliente nem
// id de nota, entao nao da para varrer documentos alheios.
// ============================================================================
import type { Express } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser, requireRole } from './authMiddleware';
import { entregarDocumento, testarSmtp, smtpConfigurado, ensureDocDeliverySchema, type DocKind } from './doc-delivery';
import { montarDanfePdf, montarXmlNfe, montarCobrancaPdf, montarPedidoPdf } from './doc-builders';
import { storage } from './storage';

export function registerDocRoutes(app: Express) {
  // ---- PUBLICO: download do documento por token -----------------------------
  app.get(['/api/doc/:token', '/api/doc/:token/:filename'], async (req: any, res: any) => {
    try {
      const token = String(req.params.token || '');
      if (!token || token.length < 16) return res.status(404).send('nao encontrado');
      const q: any = await db.execute(sql`
        SELECT filename, mime, data, expires_at FROM document_blobs WHERE token = ${token} LIMIT 1`);
      const row = q.rows?.[0];
      if (!row) return res.status(404).send('nao encontrado');
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(410).send('link expirado');
      }
      const buf = Buffer.from(String(row.data), 'base64');
      res.setHeader('Content-Type', row.mime || 'application/octet-stream');
      // inline: o WhatsApp/e-mail abre o PDF sem forcar download.
      res.setHeader('Content-Disposition', `inline; filename="${String(row.filename || 'documento').replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buf);
    } catch (e: any) {
      return res.status(500).send('erro');
    }
  });

  // ---- Diagnostico ----------------------------------------------------------
  app.get('/api/admin/doc-delivery/status', authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      await ensureDocDeliverySchema();
      const smtp = await testarSmtp();
      let ultimas: any[] = [];
      try {
        const q: any = await db.execute(sql`
          SELECT kind, channel, destination, status, error, created_at
          FROM document_deliveries ORDER BY created_at DESC LIMIT 30`);
        ultimas = q.rows || [];
      } catch { /* tabela recem-criada */ }
      let clientesComEnvio = 0;
      try {
        const q: any = await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM customers
          WHERE (notification_email IS NOT NULL AND notification_email <> ''
                 AND (send_danfe_email OR send_xml_email OR send_boleto_pix_email OR send_pedido_email))
             OR (send_danfe_whatsapp OR send_xml_whatsapp OR send_boleto_pix_whatsapp OR send_pedido_whatsapp)`);
        clientesComEnvio = q.rows?.[0]?.n || 0;
      } catch { /* colunas recem-criadas */ }
      res.json({
        smtp: { configurado: smtpConfigurado(), ...smtp },
        whatsapp: { configurado: !!process.env.UMBLER_TALK_TOKEN },
        clientesComEnvio,
        ultimasEntregas: ultimas,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/admin/doc-delivery/test-email', authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const para = String(req.body?.to || '').trim();
      if (!para) return res.status(400).json({ error: 'informe "to"' });
      if (!smtpConfigurado()) return res.status(422).json({ error: 'SMTP nao configurado (SMTP_USER/SMTP_PASS no Railway)' });
      const mod: any = await import('nodemailer');
      const nodemailer = mod.default || mod;
      const port = Number(process.env.SMTP_PORT || 465);
      const t = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtpout.secureserver.net',
        port, secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await t.sendMail({
        from: process.env.SMTP_FROM || `Honest Sucos <${process.env.SMTP_USER}>`,
        to: para,
        subject: 'INTEGRA 2.0 — teste de envio de documentos',
        html: '<p>Se você recebeu este e-mail, o envio automático de documentos está configurado corretamente.</p>',
      });
      res.json({ ok: true, to: para });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // ---- Reenvio MANUAL -------------------------------------------------------
  // body: { kind: 'danfe'|'xml'|'boleto_pix'|'pedido', invoiceId? , boletoChargeId?,
  //         pixChargeId?, pipelineItemId?, customerId?, ignorarPreferencia?: boolean }
  app.post('/api/admin/doc-delivery/send', authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'industria']), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const kind = String(b.kind || '') as DocKind;
      if (!['danfe', 'xml', 'boleto_pix', 'pedido'].includes(kind)) {
        return res.status(400).json({ error: 'kind invalido' });
      }
      const r = await montarEEnviar(kind, b);
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}

/** Monta o documento a partir dos ids recebidos e entrega pelos canais do cadastro. */
async function montarEEnviar(kind: DocKind, b: any) {
  const forcar = true; // reenvio manual sempre passa por cima da dedup
  const ignorarPreferencia = b.ignorarPreferencia === true;

  if (kind === 'danfe' || kind === 'xml') {
    if (!b.invoiceId) return { enviado: false, motivo: 'invoiceId obrigatorio' };
    const invoice: any = await storage.getFiscalInvoice(b.invoiceId);
    if (!invoice) return { enviado: false, motivo: 'NF-e nao encontrada' };
    const items = await storage.getFiscalInvoiceItems(b.invoiceId);
    const customerId = b.customerId || invoice.customerId;
    if (!customerId) return { enviado: false, motivo: 'NF-e sem cliente vinculado' };
    const arq = kind === 'danfe'
      ? [montarDanfePdf({ ...invoice, items })]
      : [montarXmlNfe(invoice)].filter(Boolean) as any[];
    if (!arq.length) return { enviado: false, motivo: 'XML de autorizacao indisponivel' };
    return entregarDocumento({ customerId, kind, refId: invoice.id, arquivos: arq, forcar, ignorarPreferencia });
  }

  if (kind === 'boleto_pix') {
    if (b.boletoChargeId) {
      const q: any = await db.execute(sql`
        SELECT id, nosso_numero, linha_digitavel, valor_original, data_vencimento, debtor_name,
               debtor_document, pix_copia_e_cola, pix_qr_code_base64, customer_id
        FROM boleto_charges WHERE id = ${b.boletoChargeId} LIMIT 1`);
      const c = q.rows?.[0];
      if (!c) return { enviado: false, motivo: 'boleto nao encontrado' };
      const customerId = b.customerId || c.customer_id;
      if (!customerId) return { enviado: false, motivo: 'boleto sem cliente vinculado' };
      const pdf = montarCobrancaPdf({
        tipo: 'boleto', pagador: c.debtor_name, documento: c.debtor_document, valor: c.valor_original,
        vencimento: c.data_vencimento, linhaDigitavel: c.linha_digitavel, nossoNumero: c.nosso_numero,
        pixCopiaECola: c.pix_copia_e_cola, qrBase64: c.pix_qr_code_base64,
      });
      return entregarDocumento({ customerId, kind, refId: String(c.id), arquivos: [pdf], forcar, ignorarPreferencia });
    }
    if (b.pixChargeId) {
      const q: any = await db.execute(sql`
        SELECT id, amount, due_date, debtor_name, debtor_document, pix_copia_e_cola, qr_code_base64, customer_id
        FROM pix_charges WHERE id = ${b.pixChargeId} LIMIT 1`);
      const c = q.rows?.[0];
      if (!c) return { enviado: false, motivo: 'PIX nao encontrado' };
      const customerId = b.customerId || c.customer_id;
      if (!customerId) return { enviado: false, motivo: 'PIX sem cliente vinculado' };
      const pdf = montarCobrancaPdf({
        tipo: 'pix', pagador: c.debtor_name, documento: c.debtor_document, valor: c.amount,
        vencimento: c.due_date, pixCopiaECola: c.pix_copia_e_cola, qrBase64: c.qr_code_base64,
      });
      return entregarDocumento({ customerId, kind, refId: String(c.id), arquivos: [pdf], forcar, ignorarPreferencia });
    }
    return { enviado: false, motivo: 'boletoChargeId ou pixChargeId obrigatorio' };
  }

  // pedido
  if (!b.pipelineItemId) return { enviado: false, motivo: 'pipelineItemId obrigatorio' };
  const q: any = await db.execute(sql`
    SELECT id, customer_id, customer_name, customer_document, seller_name, order_number,
           sale_value, payment_method, products, notes, created_at
    FROM billing_pipeline WHERE id = ${b.pipelineItemId} LIMIT 1`);
  const it = q.rows?.[0];
  if (!it) return { enviado: false, motivo: 'item do pipeline nao encontrado' };
  const customerId = b.customerId || it.customer_id;
  if (!customerId) return { enviado: false, motivo: 'pedido sem cliente vinculado' };
  const pdf = montarPedidoPdf({
    numero: it.order_number, cliente: it.customer_name, documento: it.customer_document,
    vendedor: it.seller_name, data: it.created_at, valor: it.sale_value,
    formaPagamento: it.payment_method, observacao: it.notes, produtos: it.products,
  });
  return entregarDocumento({ customerId, kind: 'pedido', refId: String(it.id), arquivos: [pdf], forcar, ignorarPreferencia });
}
