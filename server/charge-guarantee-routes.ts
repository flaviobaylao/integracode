import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { generateBoletoForReceivable, generatePixForReceivable } from "./billing-pipeline-routes";
import { authenticateUser, requireRole } from "./authMiddleware";
const FIN_ROLES = ["admin", "coordinator", "administrative"]; // FASE 1c

// ---------------------------------------------------------------------------
// GARANTIR COBRANCA - corrige "faturado sem cobranca" DAQUI PRA FRENTE.
//   POST /api/admin/financial/garantir-cobranca { apply, sinceISO, cutoffReset }
//        -> gera a cobranca que faltou nos recebiveis de VENDA em aberto criados A PARTIR do cutoff (nao toca no legado)
//   GET  /api/admin/financial/garantir-cobranca/last
// O cutoff (system_settings.charge_guarantee_cutoff) e fixado no 1o uso = "de agora em diante".
// ---------------------------------------------------------------------------

async function getSetting(key: string): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    return r?.rows?.[0]?.value ?? null;
  } catch { return null; }
}
async function setSetting(key: string, value: string) {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${value}, 'charge-guarantee', now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'charge-guarantee', updated_at = now()`);
}

export function registerChargeGuarantee(app: Express) {
  // ---- Garantir cobranca nos recebiveis de venda em aberto (a partir do cutoff) ----
  app.post("/api/admin/financial/garantir-cobranca", authenticateUser, requireRole(FIN_ROLES), async (req: Request, res: Response) => {
    try {
      const out = await runGarantirCobranca({
        apply: req.body?.apply === true,
        sinceISO: req.body?.sinceISO,
        cutoffReset: req.body?.cutoffReset === true,
        destravar: req.body?.destravar === true,
        limit: Number(req.body?.limit) || 200,
      });
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/financial/garantir-cobranca/last", authenticateUser, requireRole(FIN_ROLES), async (_req: Request, res: Response) => {
    const v = await getSetting("charge_guarantee_last");
    res.json(v ? JSON.parse(v) : { none: true });
  });
}

// ---------------------------------------------------------------------------
// GARANTIR COBRANCA — logica compartilhada pelo endpoint e pelo cron horario.
//
// Gera a cobranca que faltou nos recebiveis de VENDA em aberto criados A PARTIR
// do cutoff (system_settings.charge_guarantee_cutoff, fixado no 1o uso). Nao
// toca no legado.
//
// INSTANCIA QUE NAO EMITE FICA FORA DA LISTA. A SERV (PURO SERVICOS, CNPJ
// ...0105) nao emite boleto nem PIX por decisao de 06/jul: as funcoes geradoras
// retornam `skipped` para ela. Enquanto esses titulos continuavam na lista de
// candidatos, toda execucao os tentava de novo — a rodada de 23/07 terminou
// "ok:0, skipped:8" exatamente por isso. Num cron de hora em hora isso viraria
// ruido permanente e esconderia a falha de verdade. Eles saem da contagem e
// aparecem em `naoEmitem`, para nao sumirem sem explicacao.
// ---------------------------------------------------------------------------
export async function runGarantirCobranca(opts: {
  apply?: boolean; sinceISO?: string; cutoffReset?: boolean; limit?: number; destravar?: boolean;
} = {}): Promise<any> {
  const apply = opts.apply === true;
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  let cutoff = await getSetting("charge_guarantee_cutoff");
  if (opts.cutoffReset) { cutoff = new Date().toISOString(); await setSetting("charge_guarantee_cutoff", cutoff); }
  if (!cutoff) { cutoff = new Date().toISOString(); await setSetting("charge_guarantee_cutoff", cutoff); }
  const since = opts.sinceISO ? new Date(opts.sinceISO).toISOString() : cutoff;

  const NAO_EMITE = sql`(
    upper(COALESCE(oi.name, '')) = 'SERV'
    OR regexp_replace(COALESCE(oi.cnpj, ''), '[^0-9]', '', 'g') = '52921727000105'
  )`;

  const rows: any = await db.execute(sql`
    SELECT r.id, r.amount, r.due_date, r.customer_id, r.customer_name, r.customer_document,
           r.fiscal_invoice_id, r.billing_pipeline_id, r.omie_instance_id, r.payment_method,
           r.title_number, r.created_at,
           bp.omie_instance_name, bp.order_number, bp.sales_card_id
    FROM receivables r
    LEFT JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
    LEFT JOIN omie_instances oi ON oi.id = r.omie_instance_id
    WHERE r.billing_pipeline_id IS NOT NULL
      AND r.status IN ('a_vencer','vencida')
      AND (r.amount - COALESCE(r.amount_paid,0)) > 0
      AND r.created_at >= ${since}
      AND NOT ${NAO_EMITE}
      AND NOT EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM boleto_charge_receivables jr WHERE jr.receivable_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM pix_charges pc WHERE pc.receivable_id = r.id)
    ORDER BY r.created_at ASC
    LIMIT ${limit}`);
  const list = rows?.rows || [];

  const semEmissao: any = await db.execute(sql`
    SELECT count(1)::int AS n
    FROM receivables r LEFT JOIN omie_instances oi ON oi.id = r.omie_instance_id
    WHERE r.billing_pipeline_id IS NOT NULL
      AND r.status IN ('a_vencer','vencida')
      AND (r.amount - COALESCE(r.amount_paid,0)) > 0
      AND r.created_at >= ${since}
      AND ${NAO_EMITE}
      AND NOT EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM boleto_charge_receivables jr WHERE jr.receivable_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM pix_charges pc WHERE pc.receivable_id = r.id)`);
  const naoEmitem = Number(semEmissao?.rows?.[0]?.n || 0);

  // BACKOFF POR TITULO. Emissao que falha por DADO (ex.: "O CNPJ informado para o
  // pagador esta invalido") vai falhar de novo em toda rodada. Num cron de hora em
  // hora isso repete o mesmo erro 12x por dia e afoga a falha nova no meio do ruido.
  // Depois de MAX_TENTATIVAS o titulo sai da fila e passa a aparecer em `bloqueados`
  // com o erro — que e onde alguem consegue agir: corrigir o cadastro do cliente.
  // Sucesso limpa o contador; { "destravar": true } zera todos.
  const MAX_TENTATIVAS = 3;
  let falhas: Record<string, { n: number; erro: string; titulo?: string; at: string }> = {};
  try { falhas = JSON.parse((await getSetting("charge_guarantee_falhas")) || "{}"); } catch { falhas = {}; }
  if (opts.destravar) falhas = {};
  const travado = (r: any) => (falhas[String(r.id)]?.n || 0) >= MAX_TENTATIVAS;
  const bloqueados = list.filter(travado).map((r: any) => ({
    titulo: r.title_number, tentativas: falhas[String(r.id)].n, erro: falhas[String(r.id)].erro,
  }));
  const fila = list.filter((r: any) => !travado(r));

  let ok = 0, skipped = 0, fail = 0; const detalhes: any[] = [];
  if (apply) {
    for (const r of fila) {
      const receivable = {
        id: r.id, amount: r.amount, dueDate: r.due_date,
        customerName: r.customer_name, customerDocument: r.customer_document,
        customerId: r.customer_id, fiscalInvoiceId: r.fiscal_invoice_id,
      };
      const item = {
        id: r.billing_pipeline_id, customerId: r.customer_id,
        omieInstanceId: r.omie_instance_id, omieInstanceName: r.omie_instance_name,
        orderNumber: r.order_number, salesCardId: r.sales_card_id,
        invoiceNumber: r.title_number, saleValue: r.amount,
      };
      const fm = String(r.payment_method || "").toLowerCase();
      try {
        const res1 = fm === "boleto"
          ? await generateBoletoForReceivable(receivable, item)
          : await generatePixForReceivable(receivable, item);
        if (res1?.ok) { ok++; delete falhas[String(r.id)]; detalhes.push({ titulo: r.title_number, forma: fm, ok: true }); }
        else if (res1?.skipped) { skipped++; detalhes.push({ titulo: r.title_number, forma: fm, skipped: true }); }
        else {
          fail++;
          const msg = String(res1?.error || 'falha sem mensagem').slice(0, 300);
          falhas[String(r.id)] = { n: (falhas[String(r.id)]?.n || 0) + 1, erro: msg, titulo: r.title_number, at: new Date().toISOString() };
          detalhes.push({ titulo: r.title_number, forma: fm, erro: msg, tentativa: falhas[String(r.id)].n });
        }
      } catch (e: any) {
        fail++;
        const msg = String(e?.message || e).slice(0, 300);
        falhas[String(r.id)] = { n: (falhas[String(r.id)]?.n || 0) + 1, erro: msg, titulo: r.title_number, at: new Date().toISOString() };
        detalhes.push({ titulo: r.title_number, forma: fm, erro: msg, tentativa: falhas[String(r.id)].n });
      }
    }
    await setSetting("charge_guarantee_falhas", JSON.stringify(falhas));
    await setSetting("charge_guarantee_last", JSON.stringify({ at: new Date().toISOString(), candidatos: fila.length, ok, skipped, fail, naoEmitem, bloqueados: bloqueados.length }));
  }
  return { apply, cutoff, since, limite: limit, candidatos: fila.length, naoEmitem, bloqueados, ok, skipped, fail, detalhes: detalhes.slice(0, 50) };
}
