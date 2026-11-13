// server/inativacao-trilha.ts
// -----------------------------------------------------------------------------
// TRILHA DA INATIVAÇÃO (nov/2026 — regra do Flávio)
// "Cliente inativado tem que ter o MOTIVO e aparecer no campo de observações do
//  histórico do cadastro, com data, hora e quem inativou."
//
// • registrarObservacaoInativacao(): grava UMA observação no histórico do cliente
//   (customer_change_history, field='inativacao') com o texto
//     "Inativado em DD/MM/AAAA às HH:MM por FULANO. Motivo: ..."
//   e garante o motivo na coluna status_reason (coluna Motivo da Gestão de Clientes).
//   Usada por todos os caminhos de tela (botão Inativar, edição, massa, lixeira).
//
// • reconciliarInativacoes(): rede de segurança para QUALQUER outro caminho (sincronização,
//   mescla, migração, SQL direto) e para o acervo antigo. Para cada cliente inativo sem a
//   observação da inativação atual, monta a observação a partir do que existe:
//     quando  = evento "Ativo: Sim → Não" do histórico, senão inactivated_at;
//     quem    = quem fez esse evento, senão "não registrado";
//     motivo  = nota de motivo gravada no momento, senão status_reason, senão "não informado".
//   Idempotente. Roda de hora em hora (últimos 3 dias) e por endpoint admin (tudo).
// -----------------------------------------------------------------------------
import type { Express } from "express";
import cron from "node-cron";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);
const SEM_MOTIVO_ANTIGO = "Motivo não informado (inativação anterior ao histórico do Integra, 06/09/2026)";
const SEM_MOTIVO_SISTEMA = "Motivo não informado (inativado pelo sistema, sem motivo registrado)";

let __ready: Promise<void> | null = null;
function ensureCols(): Promise<void> {
  if (!__ready) {
    __ready = (async () => {
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS status_reason text`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_excluded boolean DEFAULT false`);
    })().catch((e) => { __ready = null; throw e; });
  }
  return __ready;
}

function dataHoraBR(d: Date): { data: string; hora: string } {
  const f = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { data: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour}:${p.minute}` };
}

export function textoObservacao(params: { quando: Date; por: string; motivo: string; exclusao?: boolean }): string {
  const { data, hora } = dataHoraBR(params.quando);
  const acao = params.exclusao ? "Excluído (inativado)" : "Inativado";
  return `${acao} em ${data} às ${hora} por ${params.por}. Motivo: ${params.motivo}`.slice(0, 1000);
}

/**
 * Grava a observação da inativação no histórico do cliente e garante o motivo em status_reason.
 * Nunca lança. Não duplica: se já existe observação de inativação até 10 min antes/depois do
 * momento informado, só atualiza o texto dela.
 */
export async function registrarObservacaoInativacao(p: {
  customerId: string;
  motivo: string;
  actor?: { id?: string | null; name?: string | null } | null;
  source?: string | null;
  quando?: Date | null;
  exclusao?: boolean;
  /** true (padrão): grava o motivo na coluna status_reason. */
  gravarMotivo?: boolean;
}): Promise<void> {
  try {
    if (!p?.customerId) return;
    await ensureCols();
    const quando = p.quando && !isNaN(new Date(p.quando).getTime()) ? new Date(p.quando) : new Date();
    const por = (p.actor?.name && String(p.actor.name).trim()) || "Sistema";
    const motivo = String(p.motivo || "").trim() || SEM_MOTIVO_SISTEMA;
    const texto = textoObservacao({ quando, por, motivo, exclusao: p.exclusao });
    const label = p.exclusao ? "Observação — Exclusão" : "Observação — Inativação";
    const ja = rows(await db.execute(sql`
      SELECT id FROM customer_change_history
       WHERE customer_id = ${p.customerId} AND field = 'inativacao'
         AND created_at BETWEEN ${quando.toISOString()}::timestamptz - interval '10 minutes'
                            AND ${quando.toISOString()}::timestamptz + interval '10 minutes'
       ORDER BY created_at DESC LIMIT 1`));
    if (ja.length) {
      await db.execute(sql`UPDATE customer_change_history SET new_value = ${texto}, label = ${label} WHERE id = ${ja[0].id}`);
    } else {
      await db.execute(sql`
        INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source, created_at)
        VALUES (${p.customerId}, 'inativacao', ${label}, NULL, ${texto}, ${p.actor?.id || null}, ${por}, ${p.source || null}, ${quando.toISOString()}::timestamptz)`);
    }
    if (p.gravarMotivo !== false) {
      await db.execute(sql`UPDATE customers SET status_reason = ${motivo} WHERE id = ${p.customerId} AND COALESCE(is_active, true) = false`);
    }
  } catch (e: any) {
    console.error("[inativacao-trilha] registrar falhou:", e?.message || e);
  }
}

/**
 * Para cada cliente INATIVO sem a observação da inativação atual, grava a observação com o que
 * existir (evento, autor, motivo). `desde` limita aos inativados a partir da data (job horário).
 */
export async function reconciliarInativacoes(opts: { dry?: boolean; desde?: string | null; limite?: number } = {}): Promise<any> {
  await ensureCols();
  const desde = opts.desde && /^\d{4}-\d{2}-\d{2}/.test(opts.desde) ? opts.desde : null;
  const filtroDesde = desde ? sql`AND COALESCE(ev.created_at, c.inactivated_at, c.updated_at) >= ${desde}::timestamptz` : sql``;
  const base = rows(await db.execute(sql`
    WITH ev AS (
      SELECT DISTINCT ON (h.customer_id) h.customer_id, h.created_at, h.changed_by_user_id, h.changed_by_name, h.source
        FROM customer_change_history h
       WHERE h.field = 'isActive' AND h.new_value IN ('Não', 'false', 'Inativo')
       ORDER BY h.customer_id, h.created_at DESC
    )
    SELECT c.id,
           COALESCE(c.is_excluded, false) AS excluido,
           NULLIF(TRIM(COALESCE(c.status_reason, '')), '') AS status_reason,
           c.inactivated_at, c.updated_at,
           ev.created_at AS ev_quando, ev.changed_by_user_id AS ev_uid, ev.changed_by_name AS ev_por, ev.source AS ev_source,
           (SELECT n.new_value FROM customer_change_history n
             WHERE n.customer_id = c.id AND n.field = 'motivo'
               AND (n.label ILIKE 'Motivo da inativa%' OR n.label ILIKE 'Motivo da exclus%')
               AND (ev.created_at IS NULL OR n.created_at BETWEEN ev.created_at - interval '30 minutes' AND ev.created_at + interval '60 minutes')
             ORDER BY n.created_at DESC LIMIT 1) AS nota_motivo,
           (SELECT n.label FROM customer_change_history n
             WHERE n.customer_id = c.id AND n.field = 'motivo'
               AND (n.label ILIKE 'Motivo da inativa%' OR n.label ILIKE 'Motivo da exclus%')
               AND (ev.created_at IS NULL OR n.created_at BETWEEN ev.created_at - interval '30 minutes' AND ev.created_at + interval '60 minutes')
             ORDER BY n.created_at DESC LIMIT 1) AS nota_label,
           EXISTS (SELECT 1 FROM customer_change_history o
                    WHERE o.customer_id = c.id AND o.field = 'inativacao'
                      AND o.created_at >= COALESCE(ev.created_at, c.inactivated_at, c.updated_at, '1970-01-01'::timestamptz) - interval '10 minutes') AS tem_obs
      FROM customers c
      LEFT JOIN ev ON ev.customer_id = c.id
     WHERE COALESCE(c.is_active, true) = false
       ${filtroDesde}`));

  const pendentes = base.filter((r) => r.tem_obs !== true);
  const resumo: Record<string, number> = {};
  const conta = (k: string) => { resumo[k] = (resumo[k] || 0) + 1; };
  let gravados = 0;
  const lim = opts.limite && opts.limite > 0 ? opts.limite : Infinity;
  for (const r of pendentes) {
    const quando = r.ev_quando ? new Date(r.ev_quando) : (r.inactivated_at ? new Date(r.inactivated_at) : (r.updated_at ? new Date(r.updated_at) : null));
    const antigo = !r.ev_quando && (!quando || quando.toISOString() < "2026-09-06");
    const motivo = r.nota_motivo || r.status_reason || (antigo ? SEM_MOTIVO_ANTIGO : SEM_MOTIVO_SISTEMA);
    const fonteMotivo = r.nota_motivo ? "nota do momento" : r.status_reason ? "coluna Motivo" : antigo ? "não informado (antigo)" : "não informado (sistema)";
    conta(`motivo: ${fonteMotivo}`);
    conta(`autor: ${r.ev_por ? "registrado" : "não registrado"}`);
    if (opts.dry || gravados >= lim) continue;
    const por = r.ev_por || (antigo ? "não registrado (anterior ao histórico)" : "não registrado");
    await registrarObservacaoInativacao({
      customerId: String(r.id),
      motivo,
      actor: { id: r.ev_uid || null, name: por },
      source: r.ev_source || "reconciliacao",
      quando: quando || new Date(),
      exclusao: r.excluido === true || /exclus/i.test(String(r.nota_label || "")),
      gravarMotivo: true,
    });
    gravados++;
  }
  return {
    inativos: base.length,
    jaComObservacao: base.length - pendentes.length,
    semObservacao: pendentes.length,
    semMotivoNaColuna: base.filter((r) => !r.status_reason).length,
    resumo,
    gravados,
    dry: !!opts.dry,
  };
}

export function registerInativacaoTrilha(app: Express): void {
  // Rede de segurança: de hora em hora, inativações dos últimos 3 dias sem observação.
  try {
    cron.schedule("17 * * * *", () => {
      const d = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      void reconciliarInativacoes({ desde: d })
        .then((r) => { if (r.gravados) console.log(`[inativacao-trilha] ${r.gravados} observação(ões) de inativação gravada(s).`); })
        .catch((e) => console.error("[inativacao-trilha] job falhou:", e?.message || e));
    }, { timezone: TZ });
  } catch (e: any) { console.error("[inativacao-trilha] cron:", e?.message || e); }

  // Diagnóstico / execução (admin). body: { dry?: boolean, desde?: 'YYYY-MM-DD' }
  app.post("/api/admin/inativacao-trilha/reconciliar", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const b: any = req.body || {};
      const out = await reconciliarInativacoes({ dry: b.dry === true || b.dry === "1", desde: b.desde || null, limite: Number(b.limite) || 0 });
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });

  // Última observação de inativação do cliente (para o destaque no histórico do cadastro).
  app.get("/api/customers/:id/inativacao", authenticateUser, async (req, res) => {
    try {
      const id = String(req.params.id || "");
      const c = rows(await db.execute(sql`SELECT COALESCE(is_active, true) AS ativo FROM customers WHERE id = ${id} LIMIT 1`))[0];
      if (!c) return res.status(404).json({ ok: false });
      const o = rows(await db.execute(sql`
        SELECT label, new_value AS texto, changed_by_name AS por, created_at AS quando, source
          FROM customer_change_history WHERE customer_id = ${id} AND field = 'inativacao'
         ORDER BY created_at DESC LIMIT 1`))[0] || null;
      res.json({ ok: true, ativo: c.ativo === true, observacao: o });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });
}
