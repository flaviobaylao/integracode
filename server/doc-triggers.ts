// ============================================================================
// INTEGRA 2.0 — GATILHOS DO ENVIO AUTOMATICO DE DOCUMENTOS
//
// Um lugar so para "quando" cada documento sai. Os pontos de chamada (SEFAZ,
// boleto BB, PIX, pipeline) importam estas funcoes de forma dinamica e SEM
// await, no padrao `void ...` — o envio nunca segura nem derruba a operacao
// que o disparou.
//
// GATILHOS (definidos com o Flavio em 21/ago/2026):
//   • DANFE + XML  -> assim que a SEFAZ AUTORIZA a NF-e.
//   • Boleto / PIX -> assim que a cobranca e registrada (BB ou PIX).
//   • Pedido       -> quando a venda entra no pipeline de faturamento.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { entregarDocumento } from './doc-delivery';
import { montarDanfePdf, montarXmlNfe, montarCobrancaPdf, montarPedidoPdf } from './doc-builders';

/** NF-e autorizada -> DANFE (PDF) e XML, cada um pelo canal marcado no cadastro. */
export async function dispararDocsNfeAutorizada(invoiceId: string): Promise<void> {
  try {
    const { storage } = await import('./storage');
    const invoice: any = await storage.getFiscalInvoice(invoiceId);
    if (!invoice || !invoice.customerId) return;
    if (String(invoice.status || '') !== 'authorized') return;
    // Homologacao NAO vale para o cliente — nao mandar nota de teste.
    if (String(invoice.environment || '') === 'homologacao') return;

    const items = await storage.getFiscalInvoiceItems(invoiceId);

    try {
      const pdf = montarDanfePdf({ ...invoice, items });
      await entregarDocumento({ customerId: invoice.customerId, kind: 'danfe', refId: invoiceId, arquivos: [pdf],
        mensagem: `Segue a nota fiscal nº ${invoice.invoiceNumber || ''} da sua compra na Honest Sucos.` });
    } catch (e: any) { console.error('[DOC-GATILHO] DANFE:', e?.message || e); }

    try {
      const xml = montarXmlNfe(invoice);
      if (xml) {
        await entregarDocumento({ customerId: invoice.customerId, kind: 'xml', refId: invoiceId, arquivos: [xml],
          mensagem: `Segue o XML da NF-e nº ${invoice.invoiceNumber || ''} (Honest Sucos).` });
      }
    } catch (e: any) { console.error('[DOC-GATILHO] XML:', e?.message || e); }
  } catch (e: any) {
    console.error('[DOC-GATILHO] NF-e autorizada:', e?.message || e);
  }
}

/** Boleto BB registrado -> folha de cobranca (linha digitavel + PIX). */
export async function dispararDocBoleto(boletoChargeId: string): Promise<void> {
  try {
    const q: any = await db.execute(sql`
      SELECT id, nosso_numero, linha_digitavel, valor_original, data_vencimento, debtor_name,
             debtor_document, pix_copia_e_cola, pix_qr_code_base64, customer_id
      FROM boleto_charges WHERE id = ${boletoChargeId} LIMIT 1`);
    const c = q.rows?.[0];
    if (!c || !c.customer_id) return;
    const pdf = montarCobrancaPdf({
      tipo: 'boleto', pagador: c.debtor_name, documento: c.debtor_document, valor: c.valor_original,
      vencimento: c.data_vencimento, linhaDigitavel: c.linha_digitavel, nossoNumero: c.nosso_numero,
      pixCopiaECola: c.pix_copia_e_cola, qrBase64: c.pix_qr_code_base64,
    });
    await entregarDocumento({
      customerId: String(c.customer_id), kind: 'boleto_pix', refId: String(c.id), arquivos: [pdf],
      mensagem: 'Segue o boleto da sua compra na Honest Sucos. Você também pode pagar pelo PIX que está no arquivo.',
    });
  } catch (e: any) { console.error('[DOC-GATILHO] boleto:', e?.message || e); }
}

/** Cobranca PIX criada -> folha com QR e copia-e-cola. */
export async function dispararDocPix(pixChargeId: string): Promise<void> {
  try {
    const q: any = await db.execute(sql`
      SELECT id, amount, due_date, debtor_name, debtor_document, pix_copia_e_cola, qr_code_base64, customer_id
      FROM pix_charges WHERE id = ${pixChargeId} LIMIT 1`);
    const c = q.rows?.[0];
    if (!c || !c.customer_id) return;
    const pdf = montarCobrancaPdf({
      tipo: 'pix', pagador: c.debtor_name, documento: c.debtor_document, valor: c.amount,
      vencimento: c.due_date, pixCopiaECola: c.pix_copia_e_cola, qrBase64: c.qr_code_base64,
    });
    await entregarDocumento({
      customerId: String(c.customer_id), kind: 'boleto_pix', refId: String(c.id), arquivos: [pdf],
      mensagem: 'Segue a cobrança PIX da sua compra na Honest Sucos.',
    });
  } catch (e: any) { console.error('[DOC-GATILHO] pix:', e?.message || e); }
}

/** Venda registrada -> espelho do pedido. */
export async function dispararDocPedido(item: any): Promise<void> {
  try {
    if (!item?.customerId) return;
    const pdf = montarPedidoPdf({
      numero: item.orderNumber, cliente: item.customerName, documento: item.customerDocument,
      vendedor: item.sellerName, data: item.createdAt, valor: item.saleValue,
      formaPagamento: item.paymentMethod, observacao: item.notes, produtos: item.products,
    });
    await entregarDocumento({
      customerId: String(item.customerId), kind: 'pedido', refId: String(item.id), arquivos: [pdf],
      mensagem: 'Recebemos o seu pedido na Honest Sucos! Segue o espelho para conferência.',
    });
  } catch (e: any) { console.error('[DOC-GATILHO] pedido:', e?.message || e); }
}
