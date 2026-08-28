// ============================================================================
// NFC-e (MODELO 65) — COLUNAS QUE FALTAVAM (28/ago/2026)
// ----------------------------------------------------------------------------
// O sefaz-service JA sabe emitir NFC-e: monta o XML sem enderDest, usa tpImp=4,
// idDest=1, dispensa o CPF do destinatario (consumidor nao identificado) e passa
// CSC/idCSC para a biblioteca gerar o QR Code. So que NADA disso era alcancavel,
// porque as tres colunas que ligam a chave nunca existiram no banco:
//
//   fiscal_invoices.invoice_model  -> sem ela, (invoice as any).invoiceModel era
//                                     SEMPRE undefined e todo documento caia no
//                                     default '55'.
//   digital_certificates.csc       -> sem elas, certData.csc/idCsc eram sempre
//   digital_certificates.id_csc       undefined e a emissao 65 morreria em
//                                     MISSING_CSC.
//
// Sintoma no balcao: a venda da maquininha ia para o Pipeline, o "Faturar" criava
// uma NF-e modelo 55 para o CONSUMIDOR BALCAO — que por definicao nao tem CPF — e
// a emissao parava em MISSING_CUSTOMER_DOC (HTTP 422) antes de sair do sistema.
// Venda de balcao a consumidor nao identificado nao e caso de NF-e 55; e NFC-e.
//
// POR QUE UM ensure E NAO UMA MIGRACAO: `drizzle-kit push` nao roda no deploy do
// Railway (build = vite+esbuild, start = node dist/index.js). Toda coluna nova
// deste projeto nasce por ensure idempotente no boot. Mesmo padrao de
// ensure-payment-method-card.ts: roda uma vez por processo, nunca derruba a subida.
//
// POR QUE AS COLUNAS NAO ENTRARAM NO shared/schema.ts: o Drizzle faz SELECT com
// TODAS as colunas declaradas. Se o schema declarasse invoice_model e o ALTER
// falhasse por qualquer motivo, QUALQUER leitura de fiscal_invoices passaria a
// estourar "column does not exist" — ou seja, um erro aqui derrubaria a emissao
// de NF-e que hoje funciona. Quem le essas colunas le por SQL cru e tolera a
// ausencia (ver getFiscalInvoice e loadCertFromStorage). Custo: uma consulta
// pequena a mais; beneficio: a NF-e 55 nao depende deste arquivo dar certo.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

let _pronto = false;

export async function ensureNfceSchema(): Promise<void> {
  if (_pronto) return;
  try {
    // DEFAULT '55' preenche as notas ja existentes: todas sao NF-e. Nenhuma nota
    // antiga muda de modelo por causa desta coluna.
    await db.execute(sql.raw(
      `ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS invoice_model varchar NOT NULL DEFAULT '55'`
    ));
    // O CSC e um segredo do CNPJ emitente, entregue pela SEFAZ. Fica junto do
    // certificado porque e a mesma unidade de credencial fiscal: um par por CNPJ.
    await db.execute(sql.raw(`ALTER TABLE digital_certificates ADD COLUMN IF NOT EXISTS csc varchar`));
    await db.execute(sql.raw(`ALTER TABLE digital_certificates ADD COLUMN IF NOT EXISTS id_csc varchar`));
    // A numeracao ja e por (CNPJ, serie); o indice abaixo so acelera a consulta de
    // MAX(invoice_number) quando o modelo entra no filtro.
    await db.execute(sql.raw(
      `CREATE INDEX IF NOT EXISTS idx_fiscal_invoices_model_series ON fiscal_invoices (invoice_model, series)`
    ));
    _pronto = true;
    console.log('✅ [SCHEMA] NFC-e: invoice_model + csc/id_csc garantidos.');
  } catch (e: any) {
    console.warn('⚠️ [SCHEMA] nao foi possivel garantir as colunas de NFC-e:', e?.message || e);
  }
}
