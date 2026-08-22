// ============================================================================
// INTEGRA 2.0 — ENVIO AUTOMATICO DE DOCUMENTOS DE FATURAMENTO
//
// PROBLEMA QUE ESTE ARQUIVO RESOLVE (21/ago/2026):
// O cadastro do cliente ja tinha o bloco "Envio Automatico de Documentos por
// E-mail" (e-mail + caixinhas DANFE/XML/Boleto-PIX/Pedido) e as colunas em
// `customers`. Mas NADA no servidor lia essas colunas: nao existia nenhum
// servico de e-mail no projeto (sem nodemailer, sem SMTP, sem SendGrid). As
// caixinhas gravavam a preferencia e o documento nunca saia. Por isso "o envio
// automatico nao esta funcionando" — nao era bug, era funcionalidade ausente.
//
// O QUE ENTRA AQUI:
//   1) Envio por E-MAIL via SMTP (conta GoDaddy da Honest) com o documento ANEXO.
//   2) Envio por WHATSAPP via Umbler Talk com o documento como ARQUIVO. O Umbler
//      baixa a midia por URL, entao o arquivo e guardado no banco e servido por
//      um link publico com token opaco (/api/doc/:token) com validade.
//   3) Preferencia POR CANAL e POR TIPO de documento, lida do cadastro do cliente.
//   4) Log de cada tentativa em `document_deliveries` (auditoria + dedup).
//
// NADA AQUI PODE DERRUBAR O FLUXO QUE CHAMOU. Toda a superficie publica engole
// erro e devolve o resultado: uma NF-e autorizada nunca deixa de ser autorizada
// porque o e-mail do cliente caiu.
// ============================================================================
import crypto from 'crypto';
import { db } from './db';
import { sql } from 'drizzle-orm';

export type DocKind = 'danfe' | 'xml' | 'boleto_pix' | 'pedido';

export interface DocFile {
  filename: string;
  mime: string;
  content: Buffer;
}

export interface EntregaResultado {
  enviado: boolean;
  email?: { ok: boolean; error?: string; to?: string };
  whatsapp?: { ok: boolean; error?: string; to?: string };
  motivo?: string; // quando nada foi enviado
}

const APP_URL = (process.env.APP_URL || 'https://integracode-production.up.railway.app').replace(/\/+$/, '');

// Validade do link publico do documento (o Umbler baixa em segundos; a folga e
// para reenvio manual e para o cliente reabrir o anexo no historico do WhatsApp).
const DOC_LINK_TTL_HORAS = Number(process.env.DOC_LINK_TTL_HOURS || 720); // 30 dias

// Nome humano de cada tipo, usado no assunto do e-mail e na legenda do WhatsApp.
const ROTULO: Record<DocKind, string> = {
  danfe: 'DANFE (nota fiscal)',
  xml: 'XML da NF-e',
  boleto_pix: 'Boleto / PIX',
  pedido: 'Pedido',
};

// Coluna de preferencia por canal e por tipo de documento.
const COL_EMAIL: Record<DocKind, string> = {
  danfe: 'send_danfe_email',
  xml: 'send_xml_email',
  boleto_pix: 'send_boleto_pix_email',
  pedido: 'send_pedido_email',
};
const COL_WHATS: Record<DocKind, string> = {
  danfe: 'send_danfe_whatsapp',
  xml: 'send_xml_whatsapp',
  boleto_pix: 'send_boleto_pix_whatsapp',
  pedido: 'send_pedido_whatsapp',
};

// ---------------------------------------------------------------------------
// Migracao de boot: colunas de WhatsApp no cadastro + tabelas de blob e de log.
// Idempotente (IF NOT EXISTS) e chamada uma vez no boot por server/index.ts.
// ---------------------------------------------------------------------------
let _schemaPronto: Promise<void> | null = null;
export function ensureDocDeliverySchema(): Promise<void> {
  if (_schemaPronto) return _schemaPronto;
  _schemaPronto = (async () => {
    try {
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS notification_whatsapp varchar`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_danfe_whatsapp boolean DEFAULT false`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_xml_whatsapp boolean DEFAULT false`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_boleto_pix_whatsapp boolean DEFAULT false`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_pedido_whatsapp boolean DEFAULT false`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS document_blobs (
          id varchar PRIMARY KEY,
          token varchar NOT NULL UNIQUE,
          customer_id varchar,
          kind varchar,
          filename varchar NOT NULL,
          mime varchar NOT NULL,
          data text NOT NULL,
          expires_at timestamptz,
          created_at timestamptz DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_document_blobs_token ON document_blobs (token)`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS document_deliveries (
          id varchar PRIMARY KEY,
          customer_id varchar,
          kind varchar NOT NULL,
          ref_id varchar,
          channel varchar NOT NULL,
          destination varchar,
          status varchar NOT NULL,
          error text,
          created_at timestamptz DEFAULT now()
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_document_deliveries_ref ON document_deliveries (kind, ref_id, channel)`);
      console.log('📨 [DOC-ENVIO] schema de envio de documentos pronto');
    } catch (e: any) {
      console.error('⚠️ [DOC-ENVIO] falha ao preparar schema:', e?.message || e);
    }
  })();
  return _schemaPronto;
}

// ---------------------------------------------------------------------------
// SMTP. As credenciais vivem SO em env var — nunca no codigo.
//
// A caixa da Honest e comprada na GoDaddy mas roda no TITAN (o webmail e
// secureserver.titan.email) — conferido no painel em 22/ago/2026. Por isso o
// padrao e `smtp.titan.email` na 465 (SSL); a 587 (STARTTLS) tambem serve.
// NAO e `smtpout.secureserver.net` (SMTP das contas Workspace/cPanel antigas da
// GoDaddy) nem `smtp.office365.com`.
//
// ⚠️ Com 2FA ligado na caixa, a senha comum NAO autentica: e preciso gerar uma
// "application password" no Titan e usar ela em SMTP_PASS.
// ---------------------------------------------------------------------------
export function smtpConfigurado(): boolean {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

let _transport: any = null;
async function getTransport(): Promise<any> {
  if (_transport) return _transport;
  const mod: any = await import('nodemailer');
  const nodemailer = mod.default || mod;
  const port = Number(process.env.SMTP_PORT || 465);
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.titan.email',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // GoDaddy costuma ser lento no handshake; margem folgada evita falso negativo.
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  return _transport;
}

/** Teste de conexao SMTP (usado pelo endpoint de diagnostico). */
export async function testarSmtp(): Promise<{ ok: boolean; error?: string; host?: string; user?: string }> {
  if (!smtpConfigurado()) return { ok: false, error: 'SMTP_USER/SMTP_PASS ausentes nas variaveis de ambiente' };
  try {
    const t = await getTransport();
    await t.verify();
    return { ok: true, host: process.env.SMTP_HOST || 'smtp.titan.email', user: process.env.SMTP_USER };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function enviarEmail(to: string, assunto: string, corpoHtml: string, anexos: DocFile[]): Promise<{ ok: boolean; error?: string }> {
  if (!smtpConfigurado()) return { ok: false, error: 'SMTP nao configurado (SMTP_USER/SMTP_PASS)' };
  try {
    const t = await getTransport();
    const from = process.env.SMTP_FROM || `Honest Sucos <${process.env.SMTP_USER}>`;
    await t.sendMail({
      from,
      to,
      subject: assunto,
      html: corpoHtml,
      attachments: anexos.map(a => ({ filename: a.filename, content: a.content, contentType: a.mime })),
      ...(process.env.SMTP_REPLY_TO ? { replyTo: process.env.SMTP_REPLY_TO } : {}),
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Link publico do documento (o Umbler Talk baixa a midia por URL).
// Token opaco de 32 bytes: nao da para adivinhar o documento de outro cliente.
// ---------------------------------------------------------------------------
export async function guardarDocumentoPublico(file: DocFile, customerId?: string | null, kind?: DocKind): Promise<string> {
  await ensureDocDeliverySchema();
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(Date.now() + DOC_LINK_TTL_HORAS * 3600 * 1000);
  await db.execute(sql`
    INSERT INTO document_blobs (id, token, customer_id, kind, filename, mime, data, expires_at, created_at)
    VALUES (${id}, ${token}, ${customerId || null}, ${kind || null}, ${file.filename}, ${file.mime},
            ${file.content.toString('base64')}, ${expira}, now())`);
  // O nome do arquivo entra no fim da URL para o WhatsApp mostrar "NFe_123.pdf"
  // em vez de um hash — o cliente precisa reconhecer o que recebeu.
  return `${APP_URL}/api/doc/${token}/${encodeURIComponent(file.filename)}`;
}

// ---------------------------------------------------------------------------
// Preferencias do cliente
// ---------------------------------------------------------------------------
interface Prefs {
  id: string;
  nome: string;
  email: string | null;
  whatsapp: string | null;
  emailLigado: boolean;
  whatsLigado: boolean;
}

async function lerPrefs(customerId: string, kind: DocKind): Promise<Prefs | null> {
  const colE = COL_EMAIL[kind];
  const colW = COL_WHATS[kind];
  // Os nomes de coluna vem de um mapa fixo deste arquivo (nunca do request),
  // por isso a interpolacao aqui e segura.
  const q: any = await db.execute(sql`
    SELECT id,
           COALESCE(fantasy_name, name) AS nome,
           notification_email AS email,
           COALESCE(NULLIF(notification_whatsapp, ''), phone) AS whatsapp,
           COALESCE(${sql.raw(colE)}, false) AS email_ligado,
           COALESCE(${sql.raw(colW)}, false) AS whats_ligado
    FROM customers WHERE id = ${customerId} LIMIT 1`);
  const r = q.rows?.[0];
  if (!r) return null;
  return {
    id: String(r.id),
    nome: String(r.nome || 'Cliente'),
    email: r.email ? String(r.email).trim() : null,
    whatsapp: r.whatsapp ? String(r.whatsapp).trim() : null,
    emailLigado: !!r.email_ligado,
    whatsLigado: !!r.whats_ligado,
  };
}

async function jaEnviado(kind: DocKind, refId: string, channel: string): Promise<boolean> {
  if (!refId) return false;
  try {
    const q: any = await db.execute(sql`
      SELECT 1 FROM document_deliveries
      WHERE kind = ${kind} AND ref_id = ${refId} AND channel = ${channel} AND status = 'sent' LIMIT 1`);
    return !!q.rows?.[0];
  } catch { return false; }
}

async function logEntrega(customerId: string | null, kind: DocKind, refId: string | null, channel: string, destination: string | null, status: string, error?: string) {
  try {
    await db.execute(sql`
      INSERT INTO document_deliveries (id, customer_id, kind, ref_id, channel, destination, status, error, created_at)
      VALUES (${crypto.randomUUID()}, ${customerId}, ${kind}, ${refId}, ${channel}, ${destination}, ${status}, ${error || null}, now())`);
  } catch { /* log nunca derruba envio */ }
}

// ---------------------------------------------------------------------------
// SUPERFICIE PUBLICA
// ---------------------------------------------------------------------------
export interface EntregarOpts {
  customerId: string;
  kind: DocKind;
  /** id do documento de origem (fiscal_invoice, boleto_charge, pipeline item) — usado para nao repetir envio. */
  refId?: string | null;
  arquivos: DocFile[];
  /** primeira linha da mensagem; se ausente, usa um texto padrao pelo tipo. */
  mensagem?: string;
  /** ignora a dedup por refId (reenvio manual pelo botao da tela). */
  forcar?: boolean;
  /** ignora as caixinhas do cadastro (reenvio manual explicito de um operador). */
  ignorarPreferencia?: boolean;
}

export async function entregarDocumento(opts: EntregarOpts): Promise<EntregaResultado> {
  const { customerId, kind, arquivos } = opts;
  const refId = opts.refId ? String(opts.refId) : null;
  try {
    if (!customerId || !arquivos?.length) return { enviado: false, motivo: 'sem cliente ou sem arquivo' };
    await ensureDocDeliverySchema();

    const p = await lerPrefs(customerId, kind);
    if (!p) return { enviado: false, motivo: 'cliente nao encontrado' };

    const querEmail = (opts.ignorarPreferencia || p.emailLigado) && !!p.email;
    const querWhats = (opts.ignorarPreferencia || p.whatsLigado) && !!p.whatsapp;
    if (!querEmail && !querWhats) {
      return { enviado: false, motivo: 'cliente sem canal marcado para este documento' };
    }

    const rotulo = ROTULO[kind];
    const texto = opts.mensagem || `Olá, ${p.nome}! Segue o documento: ${rotulo}.`;
    const out: EntregaResultado = { enviado: false };

    // ---- E-mail (documento ANEXO) ----
    if (querEmail) {
      if (!opts.forcar && refId && await jaEnviado(kind, refId, 'email')) {
        out.email = { ok: true, to: p.email! };
      } else {
        const html = `<p>${escapeHtml(texto)}</p>`
          + `<p style="color:#555;font-size:13px">Documento(s) em anexo: ${arquivos.map(a => escapeHtml(a.filename)).join(', ')}.</p>`
          + `<p style="color:#888;font-size:12px">Honest Sucos — mensagem automática, não é necessário responder.</p>`;
        const r = await enviarEmail(p.email!, `${rotulo} — Honest Sucos`, html, arquivos);
        out.email = { ok: r.ok, error: r.error, to: p.email! };
        await logEntrega(customerId, kind, refId, 'email', p.email, r.ok ? 'sent' : 'error', r.error);
        if (!r.ok) console.error(`⚠️ [DOC-ENVIO] e-mail ${kind} p/ ${p.email} falhou: ${r.error}`);
      }
    }

    // ---- WhatsApp (documento como ARQUIVO, baixado por URL publica) ----
    if (querWhats) {
      if (!opts.forcar && refId && await jaEnviado(kind, refId, 'whatsapp')) {
        out.whatsapp = { ok: true, to: p.whatsapp! };
      } else {
        try {
          const { sendUmblerTalkMedia } = await import('./chat-routes');
          let ok = true; let erro: string | undefined;
          for (let i = 0; i < arquivos.length; i++) {
            const url = await guardarDocumentoPublico(arquivos[i], customerId, kind);
            // A legenda vai so no primeiro arquivo (dois anexos = duas mensagens).
            const r = await sendUmblerTalkMedia(p.whatsapp!, url, i === 0 ? texto : undefined);
            if (!r.success) { ok = false; erro = r.error; break; }
          }
          out.whatsapp = { ok, error: erro, to: p.whatsapp! };
          await logEntrega(customerId, kind, refId, 'whatsapp', p.whatsapp, ok ? 'sent' : 'error', erro);
          if (!ok) console.error(`⚠️ [DOC-ENVIO] WhatsApp ${kind} p/ ${p.whatsapp} falhou: ${erro}`);
        } catch (e: any) {
          out.whatsapp = { ok: false, error: e?.message || String(e), to: p.whatsapp! };
          await logEntrega(customerId, kind, refId, 'whatsapp', p.whatsapp, 'error', e?.message);
        }
      }
    }

    out.enviado = !!(out.email?.ok || out.whatsapp?.ok);
    if (out.enviado) console.log(`📨 [DOC-ENVIO] ${kind} enviado p/ ${p.nome} (email=${out.email?.ok ? 'ok' : out.email ? 'falhou' : '-'} whats=${out.whatsapp?.ok ? 'ok' : out.whatsapp ? 'falhou' : '-'})`);
    return out;
  } catch (e: any) {
    console.error(`❌ [DOC-ENVIO] erro inesperado (${kind}):`, e?.message || e);
    await logEntrega(customerId || null, kind, refId, 'geral', null, 'error', e?.message);
    return { enviado: false, motivo: e?.message || String(e) };
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
