// server/conferencia-alerta.ts
// -----------------------------------------------------------------------------
// ETAPA 5 — ALERTA DA CONFERENCIA DE RECEBIMENTOS
//
// Todo dia util (08:15 BRT) checa os furos de GRAVIDADE ALTA da Conferencia de
// Recebimentos na janela dos ultimos 30 dias e, se algum passar de zero, manda um
// resumo por WhatsApp para o(s) gestor(es). E o gatilho que transforma o painel
// (que alguem precisa abrir) em aviso ativo — o cerco nao depende de ninguem lembrar.
//
// Seguro por padrao: so envia com a flag system_settings 'conferencia_alerta_ativo'
// = 'on' (nasce desligada) e no maximo uma vez por dia. Destino:
// system_settings 'telefone_gestor_relatorios' (+ 'mkt_aprovadores', se houver).
// -----------------------------------------------------------------------------
import type { Express } from "express";
import cron from "node-cron";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { sendUmblerTalkText } from "./chat-routes";
import { nfVendaWhere } from "./faturamento-oficial";
import { authenticateUser, requireRole } from "./authMiddleware";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => (r?.rows ?? r ?? []) as any[];
const brl = (n: any) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function diaUtilBR(): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date());
  return !["Sat", "Sun"].includes(wd);
}
async function setting(key: string): Promise<string> {
  try { const r = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`))[0]; return String(r?.value || "").trim(); } catch { return ""; }
}

// Conta os furos de gravidade ALTA na janela (mesma regua de venda das telas de
// Gestao). Retorna {label, chave, qtd, valor}[] apenas dos que passaram de zero.
export async function furosGravidadeAlta(dias = 30): Promise<{ chave: string; label: string; qtd: number; valor: number }[]> {
  const de = (() => { const d = new Date(`${hojeBR()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - (dias - 1)); return d.toISOString().slice(0, 10); })();
  const ateExcl = `('${hojeBR()}'::date + 1)`;
  const SO_VENDA = `
    AND NOT ((COALESCE(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') IN ('28295493000153','28295493000234','28295493000315','52921727000105','14877972000173'))
             OR UPPER(COALESCE(customer_name,'')) ~ '(^|[^A-Z])(PURO|BARUC)([^A-Z]|$)')
    AND NOT (UPPER(COALESCE(category,'')) ~ '(APORTE|SOCIO|SÓCIO|EMPREST|ADIANT|DEVOLU|TROCA|AMOSTRA|BONIFICA|BRINDE|DOACAO|DOAÇÃO|REMESSA|TRANSFER)' OR TRIM(COALESCE(category,'')) ~ '^[0-9]+([.-][0-9]+)*$')`;
  const JAN = `receivables.issue_date >= '${de}' AND receivables.issue_date < ${ateExcl} AND receivables.deleted_at IS NULL${SO_VENDA} AND COALESCE(status::text,'') <> 'cancelada'`;
  const HOJE = `(now() AT TIME ZONE '${TZ}')::date`;
  const q = async (label: string, chave: string, where: string, valorExpr: string) => {
    const r = rows(await db.execute(sql.raw(`SELECT COUNT(*)::int AS qtd, COALESCE(SUM(${valorExpr}),0)::float AS valor FROM ${where}`)))[0];
    return { chave, label, qtd: Number(r?.qtd || 0), valor: Number(r?.valor || 0) };
  };
  const out: { chave: string; label: string; qtd: number; valor: number }[] = [];
  out.push(await q("NF de venda sem título", "nf_sem_receivable",
    `fiscal_invoices fi WHERE ${nfVendaWhere("fi")} AND fi.emission_date >= '${de}' AND fi.emission_date < ${ateExcl}
       AND NOT EXISTS (SELECT 1 FROM receivables r WHERE r.fiscal_invoice_id = fi.id AND r.deleted_at IS NULL)`,
    `COALESCE(NULLIF(fi.total_invoice::text,'')::numeric,0)`));
  out.push(await q("Pedido entregue sem título", "pedido_sem_receivable",
    `billing_pipeline bp WHERE bp.stage IN ('faturado','impresso','aguardando_rota','em_rota','entregue','bsb','em_rota_bsb','agendado','outras_cidades','aguardando_rota_bsb')
       AND COALESCE(bp.operation_type,'venda') = 'venda' AND bp.created_at >= '${de}' AND bp.created_at < ${ateExcl}
       AND NOT EXISTS (SELECT 1 FROM receivables r WHERE (r.billing_pipeline_id = bp.id OR r.sales_card_id = bp.sales_card_id) AND r.deleted_at IS NULL)`,
    `COALESCE(NULLIF(bp.sale_value::text,'')::numeric,0)`));
  out.push(await q("Vencido ainda como “a vencer”", "avencer_vencido",
    `receivables WHERE ${JAN} AND status::text='a_vencer' AND due_date::date < ${HOJE}`,
    `(COALESCE(NULLIF(amount::text,'')::numeric,0)-COALESCE(NULLIF(amount_paid::text,'')::numeric,0))`));
  out.push(await q("Recebido sem conta de recebimento", "recebido_sem_conta",
    `receivables WHERE ${JAN} AND status::text='recebida'
       AND EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = receivables.id AND rp.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = receivables.id AND rp.deleted_at IS NULL AND rp.financial_account_id IS NOT NULL)`,
    `COALESCE(NULLIF(amount_paid::text,'')::numeric,0)`));
  return out.filter((f) => f.qtd > 0);
}

// Monta e envia (ou so simula) o alerta. `apply=false` devolve a previa sem enviar.
export async function enviarAlertaConferencia(apply: boolean, opts?: { toOverride?: string; ignorarFlag?: boolean }): Promise<any> {
  const furos = await furosGravidadeAlta(30);
  if (!furos.length) return { ok: true, enviado: false, motivo: "sem_pendencias", furos };

  const linhas = furos.map((f) => `• ${f.label}: ${f.qtd} (${brl(f.valor)})`).join("\n");
  const msg = `⚠️ *Conferência de Recebimentos* — pendências de gravidade alta (últimos 30 dias):\n\n${linhas}\n\nAbra em Financeiro › Conferência de Recebimentos para tratar.`;

  if (!apply) return { ok: true, enviado: false, previa: true, furos, msg };

  const ativo = (await setting("conferencia_alerta_ativo")) === "on";
  if (!opts?.ignorarFlag && !ativo) return { ok: true, enviado: false, motivo: "flag_desligada", furos };

  // No máximo uma vez por dia.
  const hoje = hojeBR();
  if (!opts?.ignorarFlag && (await setting("conferencia_alerta_last")) === hoje) return { ok: true, enviado: false, motivo: "ja_enviado_hoje", furos };

  const so = (s: string) => (s || "").replace(/[^0-9,]/g, "");
  const destinos = Array.from(new Set(
    (so(await setting("telefone_gestor_relatorios")) + "," + so(await setting("mkt_aprovadores")))
      .split(",").map((x) => x.trim()).filter((x) => x.length >= 10),
  ));
  const alvos = opts?.toOverride ? [so(opts.toOverride)] : destinos;
  if (!alvos.length) return { ok: true, enviado: false, motivo: "sem_destino", furos };

  let enviados = 0; const detalhes: any[] = [];
  for (const to of alvos) {
    try { const r = await sendUmblerTalkText(to, msg); if (r.success) enviados++; else detalhes.push({ to, err: r.error }); }
    catch (e: any) { detalhes.push({ to, err: String(e?.message || e) }); }
  }
  if (enviados > 0) {
    try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('conferencia_alerta_last', ${hoje}, 'cron-conferencia') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch {}
  }
  return { ok: true, enviado: enviados > 0, enviados, destinos: alvos, furos, detalhes };
}

let _agendado = false;
export function initConferenciaAlerta(app?: Express) {
  // Endpoint de teste/config (admin): GET devolve a prévia (sem enviar);
  // POST {enviar:true} força o envio ignorando a flag/1x-por-dia.
  if (app) {
    app.get("/api/gestao/conferencia-alerta", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (_req, res) => {
      try { res.json(await enviarAlertaConferencia(false)); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
    });
    app.post("/api/gestao/conferencia-alerta/testar", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
      try { res.json(await enviarAlertaConferencia(true, { ignorarFlag: true, toOverride: req.body?.to })); } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
    });
  }
  if (_agendado) return; _agendado = true;
  // Dia util, 08:15 BRT (logo antes do alerta de débitos das 08:30). Guard de flag
  // e de "uma vez por dia" fica dentro de enviarAlertaConferencia.
  cron.schedule("15 8 * * *", async () => {
    try {
      if (!diaUtilBR()) return;
      const r = await enviarAlertaConferencia(true);
      if (r.enviado) console.log(`⚠️ [CONFERENCIA-ALERTA] enviado para ${r.enviados} destino(s).`);
    } catch (e: any) { console.error("[CONFERENCIA-ALERTA] falha no cron:", e?.message || e); }
  }, { timezone: TZ });
  console.log("[CONFERENCIA-ALERTA] cron agendado (08:15 BRT, dias úteis).");
}
