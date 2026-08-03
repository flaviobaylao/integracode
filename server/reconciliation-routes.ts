// Redeploy manual: o deploy do commit anterior falhou no Railway (o build passa
// localmente com `npm run build`). Sem mudanca de comportamento.
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { settleBoletoCharge } from "./bb-boleto-service";
import { fetchExtrato, diagnosticarExtrato } from "./bb-extrato-service";
import { authenticateUser, requireRole } from "./authMiddleware";
const FIN_ROLES = ["admin", "coordinator", "administrative"]; // FASE 1c

// ---------------------------------------------------------------------------
// Conciliação Bancária — FASE 1 (read-only): reconstrói a tela do 1.0.
//   GET /api/reconciliation/filters                 -> contas + instâncias
//   GET /api/reconciliation/statements              -> "Extratos Importados"
//   GET /api/reconciliation/statements/:id/items    -> itens + matches + sugestões
// Fonte: tabelas sincronizadas do 1.0 (bank_statements, bank_statement_items,
// bank_statement_item_matches, reconciliation_patterns). NENHUMA escrita.
// Sugestões: padrões aprendidos (reconciliation_patterns por descrição/cpf_cnpj,
// reforçados por match_count) + títulos em aberto (receber/pagar) casados por valor.
// ---------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
// drizzle expande ${array} em vez de passar array Postgres p/ ANY(); usar IN (...) com params individuais.
const inList = (arr: any[]) => sql.join(arr.map((v) => sql`${v}`), sql`, `);
const onlyDigits = (v: any): string => (v == null ? "" : String(v)).replace(/\D/g, "");
const pickMethod = (desc: any): string => {
  const d = (desc == null ? "" : String(desc)).toLowerCase();
  if (d.includes("pix")) return "pix";
  if (d.includes("boleto")) return "boleto";
  if (d.includes("ted") || d.includes("doc ") || d.includes("transfer")) return "transferencia";
  if (d.includes("dinheiro") || d.includes("especie") || d.includes("saque")) return "dinheiro";
  return "transferencia";
};
const normDesc = (v: any): string =>
  (v == null ? "" : String(v)).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const money = (v: any): string => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? "0.00" : n.toFixed(2);
};

export function registerReconciliation(app: Express) {
  // ---- Filtros (contas + instâncias) --------------------------------------
  // FASE 3.4j - coluna aditiva para linhas "espelho" (lancamento ja importado em
  // outro extrato). Idempotente; garantida antes de qualquer leitura/escrita que a use.
  let __mirrorColReady = false;
  async function ensureMirrorColumn() {
    if (__mirrorColReady) return;
    // mirror_of deve ter o MESMO tipo de bank_statement_items.id (character varying),
    // senao os JOIN/COALESCE (c.id = i.mirror_of) quebram com "varchar = uuid".
    try { await db.execute(sql`ALTER TABLE bank_statement_items ADD COLUMN IF NOT EXISTS mirror_of text`); } catch {}
    try { await db.execute(sql`ALTER TABLE bank_statement_items ALTER COLUMN mirror_of TYPE text USING mirror_of::text`); } catch {}
    __mirrorColReady = true;
  }

  // Garante a coluna do FITID (identificador unico do lancamento no extrato do BB).
  // O dedup usa FITID como chave primaria; se a tabela nao tiver coluna de FITID,
  // criamos 'fitid' para que a deduplicacao por FITID passe a valer (sem ela o dedup
  // caia so na chave composta, que e fragil). Idempotente.
  let __fitidColReady = false;
  async function ensureFitidColumn() {
    if (__fitidColReady) return;
    try { await db.execute(sql`ALTER TABLE bank_statement_items ADD COLUMN IF NOT EXISTS fitid text`); } catch {}
    __fitidColReady = true;
  }

  // Guarda o lancamento BRUTO do banco (todas as tags do OFX / o JSON da API do BB)
  // + o que foi derivado do texto. Coluna 'text' (JSON serializado) de proposito:
  // o insert dinamico manda parametro texto e jsonb exigiria cast. Idempotente.
  let __rawColReady = false;
  async function ensureRawColumn() {
    if (__rawColReady) return;
    try { await db.execute(sql`ALTER TABLE bank_statement_items ADD COLUMN IF NOT EXISTS raw_ofx text`); } catch {}
    try { await db.execute(sql`ALTER TABLE bank_statement_items ADD COLUMN IF NOT EXISTS origin_document text`); } catch {}
    __rawColReady = true;
  }

  // Trilha de auditoria (append-only) de TODAS as conciliacoes e estornos, para
  // rastreabilidade do processo mesmo se o item for reimportado/duplicado/desfeito.
  let __auditReady = false;
  async function ensureAuditTable() {
    if (__auditReady) return;
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS reconciliation_audit_log (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        event_at timestamptz NOT NULL DEFAULT now(),
        action text NOT NULL,
        bank_statement_item_id text,
        statement_id text,
        financial_account_id text,
        omie_instance_id text,
        amount numeric,
        item_type text,
        transaction_date date,
        description text,
        titles jsonb,
        counterpart jsonb,
        performed_by text,
        details jsonb
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_recon_audit_item ON reconciliation_audit_log (bank_statement_item_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_recon_audit_at ON reconciliation_audit_log (event_at DESC)`);
    } catch {}
    __auditReady = true;
  }
  async function logReconAudit(row: Record<string, any>) {
    try {
      await ensureAuditTable();
      await db.execute(sql`
        INSERT INTO reconciliation_audit_log
          (id, action, bank_statement_item_id, statement_id, financial_account_id, omie_instance_id, amount, item_type, transaction_date, description, titles, counterpart, performed_by, details)
        VALUES (gen_random_uuid()::text, ${row.action}, ${row.itemId ?? null}, ${row.statementId ?? null}, ${row.accountId ?? null}, ${row.instanceId ?? null},
          ${row.amount ?? null}, ${row.itemType ?? null}, ${row.transactionDate ?? null}, ${(row.description ?? "").toString().slice(0, 300)},
          ${row.titles ? JSON.stringify(row.titles) : null}::jsonb, ${row.counterpart ? JSON.stringify(row.counterpart) : null}::jsonb,
          ${row.by ?? null}, ${row.details ? JSON.stringify(row.details) : null}::jsonb)`);
    } catch {}
  }

  app.get("/api/reconciliation/filters", authenticateUser, requireRole(FIN_ROLES), async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT id, name, omie_instance_id
        FROM financial_accounts
        WHERE is_active IS NOT FALSE
        ORDER BY omie_instance_id NULLS LAST, name`);
      const accounts = rowsOf(r);
      const instances = Array.from(new Set(accounts.map((a: any) => a.omie_instance_id).filter(Boolean)));
      res.json({ accounts, instances });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Lista de extratos importados ---------------------------------------
  app.get("/api/reconciliation/statements", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      const instanceId = (req.query.instanceId as string) || null;
      const accountId = (req.query.accountId as string) || null;
      const r = await db.execute(sql`
        SELECT s.id, s.file_name, s.source, s.start_date, s.end_date,
               s.total_credits, s.total_debits, s.financial_account_id,
               s.omie_instance_id, fa.name AS account_name, s.created_at,
               (SELECT count(*) FROM bank_statement_items i WHERE i.statement_id = s.id
                  AND COALESCE(i.reconciliation_status, 'pending') <> 'saldo')::int AS items,
               (SELECT count(*) FROM bank_statement_items i LEFT JOIN bank_statement_items c ON c.id = i.mirror_of
                  WHERE i.statement_id = s.id AND COALESCE(c.reconciliation_status, i.reconciliation_status) = 'reconciled')::int AS reconciled,
               (SELECT count(*) FROM bank_statement_items i LEFT JOIN bank_statement_items c ON c.id = i.mirror_of
                  WHERE i.statement_id = s.id AND COALESCE(c.reconciliation_status, i.reconciliation_status) = 'ignored')::int AS ignored
        FROM bank_statements s
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
        ORDER BY COALESCE(s.end_date, s.created_at) DESC NULLS LAST`);
      res.json({ statements: rowsOf(r) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- FASE 3.4b: motor de sugestões compartilhado ------------------------
  // Usado pelo extrato individual e pela visão consolidada de pendentes.
  async function buildSuggestions(items: any[]): Promise<Record<string, any>> {
      // Sugestões p/ itens pendentes
      const pend = items.filter((i: any) => !i.reconciliation_status || i.reconciliation_status === "pending");
      const perKeys: Record<string, { nd: string; doc: string; amt: string }> = {};
      const normSet = new Set<string>(), docSet = new Set<string>(), amtSet = new Set<string>();
      for (const i of pend) {
        const nd = normDesc(i.description);
        const dm = (String(i.description || "") + " " + String(i.origin_document || "")).match(/(\d{11}|\d{14})/);
        const doc = dm ? dm[1] : "";
        const amt = money(i.amount);
        perKeys[i.id] = { nd, doc, amt };
        if (nd) normSet.add(nd);
        if (doc) docSet.add(doc);
        amtSet.add(amt);
      }

      // Padrões aprendidos (descrição + cpf_cnpj)
      const patByDesc: Record<string, any[]> = {}, patByDoc: Record<string, any[]> = {};
      if (normSet.size || docSet.size) {
        const normArr = normSet.size ? Array.from(normSet) : ["__none__"];
        const docArr = docSet.size ? Array.from(docSet) : ["__none__"];
        const pR = await db.execute(sql`
          SELECT pattern_type, normalized_value, direction, counterparty_type, counterparty_id,
                 counterparty_name, counterparty_document, suggested_category, match_count
          FROM reconciliation_patterns
          WHERE (pattern_type = 'description' AND normalized_value IN (${inList(normArr)}))
             OR (pattern_type = 'cpf_cnpj'   AND normalized_value IN (${inList(docArr)}))
          ORDER BY match_count DESC`);
        for (const p of rowsOf(pR)) {
          if (p.pattern_type === "description") (patByDesc[p.normalized_value] ||= []).push(p);
          else (patByDoc[p.normalized_value] ||= []).push(p);
        }
      }

      // FASE 3.4 - Titulos em aberto casados com SCORE (valor restante, CPF/CNPJ, data).
      // Volume de abertos e pequeno (~1.100), entao carrega e casa em memoria.
      // SOMENTE SUGESTAO: a conciliacao continua 100% manual (modal + clique do usuario).
      let openRecv: any[] = [], openPay: any[] = [], pixPend: any[] = [];
      if (pend.length) {
        openRecv = rowsOf(await db.execute(sql`
          SELECT r.id, r.title_number, r.customer_name, r.customer_document, r.amount,
                 COALESCE(r.amount_paid, 0) AS amount_paid, r.due_date, r.omie_instance_id,
                 r.chart_account_id, (c.code || ' ' || c.name) AS chart_label
          FROM receivables r LEFT JOIN chart_of_accounts c ON c.id = r.chart_account_id
          WHERE r.deleted_at IS NULL AND r.status IN ('a_vencer','vencida') AND (r.amount - COALESCE(r.amount_paid,0)) > 0
          LIMIT 2000`));
        openPay = rowsOf(await db.execute(sql`
          SELECT p.id, p.title_number, p.supplier_name, p.supplier_document, p.amount,
                 COALESCE(p.amount_paid, 0) AS amount_paid, p.due_date, p.omie_instance_id,
                 p.chart_account_id, (c.code || ' ' || c.name) AS chart_label
          FROM payables p LEFT JOIN chart_of_accounts c ON c.id = p.chart_account_id
          WHERE p.deleted_at IS NULL AND p.status IN ('a_vencer','vencida') AND (p.amount - COALESCE(p.amount_paid,0)) > 0
          LIMIT 2000`));
        try {
          pixPend = rowsOf(await db.execute(sql`
            SELECT txid, end_to_end_id, valor, horario, info_pagador
            FROM pix_unmatched WHERE status = 'pendente' ORDER BY created_at DESC LIMIT 300`));
        } catch { pixPend = []; }
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const scoreTitle = (t: any, itemAmt: number, itemDoc: string, itemDate: number, patName: string) => {
        const restante = Number(t.amount || 0) - Number(t.amount_paid || 0);
        const dv = Math.abs(restante - itemAmt);
        const rel = itemAmt > 0 ? dv / itemAmt : 1;
        let score = 0; const motivos: string[] = [];
        if (dv <= 0.011) { score += 50; motivos.push("valor exato"); }
        else if (rel <= 0.02) { score += 35; motivos.push("valor aproximado (ate 2%)"); }
        else if (rel <= 0.10) { score += 15; motivos.push("valor proximo (ate 10%)"); }
        const tDoc = onlyDigits(t.customer_document || t.supplier_document);
        if (itemDoc && tDoc && itemDoc === tDoc) { score += 30; motivos.push("CPF/CNPJ confere"); }
        if (t.due_date && itemDate) {
          const dd = Math.abs(new Date(t.due_date).getTime() - itemDate) / dayMs;
          if (dd <= 5) { score += 15; motivos.push(dd < 1 ? "vence no dia" : `vencimento a ${Math.round(dd)} dia(s)`); }
          else if (dd <= 15) { score += 8; motivos.push(`vencimento a ${Math.round(dd)} dias`); }
        }
        const nome = String(t.customer_name || t.supplier_name || "");
        if (patName && nome && normDesc(nome) && normDesc(patName).includes(normDesc(nome).slice(0, 10))) { score += 10; motivos.push("padrao aprendido"); }
        return { score, motivos, restante };
      };

      const suggestions: Record<string, any> = {};
      for (const i of pend) {
        const { nd, doc } = perKeys[i.id];
        const cand = [...(patByDoc[doc] || []), ...(patByDesc[nd] || [])]
          .filter((p) => !p.direction || p.direction === i.type)
          .sort((a, b) => (b.match_count || 0) - (a.match_count || 0));
        const bestPat = cand[0];
        const itemAmt = Number(money(i.amount));
        const itemDate = i.transaction_date ? new Date(i.transaction_date).getTime() : 0;
        const pool = i.type === "C" ? openRecv : openPay;
        const scored = pool
          .map((t: any) => ({ t, s: scoreTitle(t, itemAmt, doc, itemDate, bestPat?.counterparty_name || "") }))
          .filter((x: any) => x.s.score >= 35)
          .sort((a: any, b: any) => b.s.score - a.s.score)
          .slice(0, 5);
        // Cruzamento com PIX recebidos sem cobranca (webhook) - so p/ creditos
        let pix: any = null;
        if (i.type === "C" && pixPend.length && itemDate) {
          const hit = pixPend.find((p: any) => Math.abs(Number(p.valor || 0) - itemAmt) <= 0.011
            && p.horario && Math.abs(new Date(p.horario).getTime() - itemDate) <= 2 * dayMs);
          if (hit) pix = { txid: hit.txid, e2e: hit.end_to_end_id, horario: hit.horario, valor: hit.valor, pagador: hit.info_pagador };
        }
        if (bestPat || scored.length || pix) {
          suggestions[i.id] = {
            counterparty: bestPat
              ? {
                  type: bestPat.counterparty_type,
                  id: bestPat.counterparty_id,
                  name: bestPat.counterparty_name,
                  document: bestPat.counterparty_document,
                  category: bestPat.suggested_category,
                  matchCount: bestPat.match_count,
                  via: bestPat.pattern_type,
                }
              : null,
            pix,
            titles: scored.map(({ t, s }: any) => ({
              kind: i.type === "C" ? "receivable" : "payable",
              id: t.id,
              title: t.title_number,
              name: t.customer_name || t.supplier_name,
              document: t.customer_document || t.supplier_document,
              amount: t.amount,
              restante: s.restante.toFixed(2),
              due: t.due_date,
              instance: t.omie_instance_id,
              chartAccountId: t.chart_account_id || null,
              chartLabel: t.chart_label || null,
              score: Math.min(100, s.score),
              motivos: s.motivos,
            })),
          };
        }
      }

      return suggestions;
  }

  // ---- FASE 3.4b: Pendentes de todos os extratos (visão consolidada) ------
  // Read-only: lista lançamentos pendentes de todas as importações da conta,
  // com as mesmas sugestões. A conciliação continua por item (manual).
  app.get("/api/reconciliation/pending-items", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      const accountId = (req.query.accountId as string) || null;
      const instanceId = (req.query.instanceId as string) || null;
      const r = await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.document,
               i.balance_after, i.origin_name, i.origin_document, i.reconciliation_status,
               i.matched_receivable_id, i.matched_payable_id, i.matched_at, i.matched_by,
               i.match_confidence, i.notes, s.file_name, fa.name AS account_name
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending')
          AND i.mirror_of IS NULL
          -- FASE 3.4p: NAO listar como pendente um lancamento cuja MESMA transacao economica
          -- (mesma conta | data | valor | tipo | descricao normalizada) ja esta CONCILIADA em
          -- outra linha/extrato. Corrige a "conciliacao que volta a pendente" causada por
          -- duplicatas entre extratos sobrepostos que nao foram vinculadas como espelho.
          AND NOT EXISTS (
            SELECT 1 FROM bank_statement_items j
            JOIN bank_statements sj ON sj.id = j.statement_id
            WHERE sj.financial_account_id = s.financial_account_id
              AND j.id <> i.id
              AND j.reconciliation_status = 'reconciled'
              AND j.transaction_date::date = i.transaction_date::date
              AND round(j.amount::numeric, 2) = round(i.amount::numeric, 2)
              AND j.type = i.type
              AND regexp_replace(lower(COALESCE(j.description, '')), '[^a-z0-9]', '', 'g')
                = regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g')
          )
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
          AND (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
        ORDER BY i.transaction_date, i.id
        LIMIT 1000`);
      const items = rowsOf(r);
      const suggestions = await buildSuggestions(items);
      res.json({ items, matchesByItem: {}, suggestions });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Livro único da conta: 1 linha por transação (canônica), TODOS os status
  // Read-only. É a visão principal do modelo "livro único por conta": cada lançamento
  // do extrato aparece UMA única vez (mirror_of IS NULL = canônico; as reimportações
  // do mesmo lançamento entram como espelho e NÃO reaparecem aqui), com seu status.
  // Não emite nada; matches (p/ conciliados) e sugestões (p/ pendentes) vêm juntos.
  app.get("/api/reconciliation/ledger", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      const accountId = (req.query.accountId as string) || null;
      const instanceId = (req.query.instanceId as string) || null;
      const r = await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.document,
               i.balance_after, i.origin_name, i.origin_document, i.reconciliation_status,
               i.matched_receivable_id, i.matched_payable_id, i.matched_at, i.matched_by,
               i.match_confidence, i.notes, s.file_name, fa.name AS account_name
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE i.mirror_of IS NULL
          AND COALESCE(i.reconciliation_status, 'pending') <> 'saldo'
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
          AND (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
        ORDER BY i.transaction_date DESC, i.id
        LIMIT 5000`);
      const items = rowsOf(r);
      const canonIds = items.map((i: any) => i.id);
      const matchesByItem: Record<string, any[]> = {};
      if (canonIds.length) {
        const mR = await db.execute(sql`
          SELECT m.bank_statement_item_id, m.receivable_id, m.payable_id, m.amount, m.match_kind,
                 m.title_amount_settled, m.interest, m.discount,
                 r.title_number AS r_title, r.customer_name AS r_name, r.amount AS r_amount, r.due_date AS r_due,
                 p.title_number AS p_title, p.supplier_name AS p_name, p.amount AS p_amount, p.due_date AS p_due
          FROM bank_statement_item_matches m
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN payables p ON p.id = m.payable_id
          WHERE m.bank_statement_item_id IN (${inList(canonIds)})`);
        for (const m of rowsOf(mR)) (matchesByItem[m.bank_statement_item_id] ||= []).push(m);
      }
      const suggestions = await buildSuggestions(items);
      res.json({ items, matchesByItem, suggestions });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Itens de um extrato + matches + sugestões --------------------------
  app.get("/api/reconciliation/statements/:id/items", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      const id = req.params.id;
      // Resolve linhas "espelho" (mirror_of) ao vivo pelo item canonico: status,
      // conciliacao e origem vem do canonico. Assim o extrato mostra TODOS os
      // lancamentos do arquivo, ja identificando o que foi conciliado/ignorado.
      const itemsR = await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.document,
               i.balance_after, i.origin_name, i.origin_document,
               COALESCE(c.reconciliation_status, i.reconciliation_status) AS reconciliation_status,
               COALESCE(c.matched_receivable_id, i.matched_receivable_id) AS matched_receivable_id,
               COALESCE(c.matched_payable_id, i.matched_payable_id) AS matched_payable_id,
               COALESCE(c.matched_at, i.matched_at) AS matched_at,
               COALESCE(c.matched_by, i.matched_by) AS matched_by,
               COALESCE(c.match_confidence, i.match_confidence) AS match_confidence,
               i.notes,
               (i.mirror_of IS NOT NULL) AS is_mirror,
               cs.file_name AS mirror_from,
               COALESCE(i.mirror_of, i.id) AS canonical_id
        FROM bank_statement_items i
        LEFT JOIN bank_statement_items c ON c.id = i.mirror_of
        LEFT JOIN bank_statements cs ON cs.id = c.statement_id
        WHERE i.statement_id = ${id}
          AND COALESCE(i.reconciliation_status, 'pending') <> 'saldo'
        ORDER BY i.transaction_date, i.id`);
      const items = rowsOf(itemsR);
      const canonIds = Array.from(new Set(items.map((i: any) => i.canonical_id).filter(Boolean)));

      // Matches (conciliação composta) buscados pelo id canonico e mapeados p/ a linha exibida
      const matchesByItem: Record<string, any[]> = {};
      if (canonIds.length) {
        const mR = await db.execute(sql`
          SELECT m.bank_statement_item_id, m.receivable_id, m.payable_id, m.amount,
                 m.match_kind, m.title_amount_settled, m.interest, m.discount,
                 r.title_number AS r_title, r.customer_name AS r_name, r.amount AS r_amount, r.due_date AS r_due,
                 p.title_number AS p_title, p.supplier_name AS p_name, p.amount AS p_amount, p.due_date AS p_due
          FROM bank_statement_item_matches m
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN payables p ON p.id = m.payable_id
          WHERE m.bank_statement_item_id IN (${inList(canonIds)})`);
        const byCanon: Record<string, any[]> = {};
        for (const m of rowsOf(mR)) (byCanon[m.bank_statement_item_id] ||= []).push(m);
        for (const it of items) { const mm = byCanon[(it as any).canonical_id]; if (mm) matchesByItem[(it as any).id] = mm; }
      }

      // Sugestoes apenas para itens reais pendentes (espelhos nao sao conciliaveis aqui)
      const suggestions = await buildSuggestions(items.filter((i: any) => !i.is_mirror));

      res.json({ items, matchesByItem, suggestions });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });


  // ---- DETALHE COMPLETO de um lancamento do extrato -----------------------
  // Tudo o que da p/ saber sobre a linha: o que veio do banco (todas as tags do
  // OFX / o JSON da API), o que foi derivado do texto (contraparte, CPF/CNPJ,
  // hora) e o cruzamento com o sistema (cadastro, titulos em aberto, cobrancas
  // do mesmo valor, conciliacoes anteriores da mesma contraparte, auditoria).
  // READ-ONLY. Cada bloco em try/catch proprio: se um falhar, o resto aparece.
  app.get("/api/reconciliation/items/:id/detalhe", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      await ensureRawColumn();
      const id = req.params.id;
      const it = rowsOf(await db.execute(sql`
        SELECT to_jsonb(i) AS j, COALESCE(i.mirror_of, i.id) AS canonical_id,
               s.id AS st_id, s.file_name, s.source, s.start_date, s.end_date,
               s.omie_instance_id, fa.name AS account_name, fa.id AS account_id,
               fa.bank_name, fa.agency, fa.account_number
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE i.id = ${id} LIMIT 1`))[0];
      if (!it) return res.status(404).json({ error: "lancamento nao encontrado" });
      const item: any = it.j || {};
      const canonical = String(it.canonical_id || id);

      // 1) O que veio do banco + o que foi derivado do texto
      const der = derivarDetalhe(item.description, item.origin_name);
      let raw: any = null;
      try { raw = item.raw_ofx ? JSON.parse(item.raw_ofx) : null; } catch { raw = { textoBruto: item.raw_ofx }; }
      const docItem = onlyDigits(item.origin_document) || der.doc || "";
      const valor = Number(money(item.amount));
      const dataISO = String(item.transaction_date || "").slice(0, 10);

      const out: any = {
        item, canonicalId: canonical,
        extrato: {
          id: it.st_id, arquivo: it.file_name, origem: it.source,
          periodo: { de: it.start_date, ate: it.end_date },
          conta: it.account_name, contaId: it.account_id, instancia: it.omie_instance_id,
          banco: it.bank_name, agencia: it.agency, numeroConta: it.account_number,
        },
        banco: {
          data: dataISO, valor: valor.toFixed(2), tipo: item.type,
          historico: item.origin_name || null,      // rotulo do banco (<NAME>)
          detalhe: item.description || null,        // texto completo (<MEMO>)
          contraparte: der.contraparte || null, documento: docItem || null,
          diaHora: [der.dia, der.hora].filter(Boolean).join(" ") || null,
          numeroDocumento: item.document || null, fitid: item.fitid || null,
          saldoApos: item.balance_after ?? null,
          tagsOfx: raw?.tags || null, lancamentoApi: raw?.lancamento || null,
          extratoOfx: raw?.extrato || null, bruto: raw ? undefined : null,
        },
        matches: [], auditoria: [], cadastro: null, titulosCadastro: [],
        cobrancas: { boletos: [], pix: [] }, padrao: null, conciliacoesAnteriores: [],
      };

      // 2) Titulos ja baixados neste lancamento (conciliacao composta)
      try {
        out.matches = rowsOf(await db.execute(sql`
          SELECT m.receivable_id, m.payable_id, m.amount, m.match_kind,
                 m.title_amount_settled, m.interest, m.discount,
                 r.title_number AS r_title, r.customer_name AS r_name, r.amount AS r_amount, r.due_date AS r_due, r.status AS r_status,
                 p.title_number AS p_title, p.supplier_name AS p_name, p.amount AS p_amount, p.due_date AS p_due, p.status AS p_status
          FROM bank_statement_item_matches m
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN payables p ON p.id = m.payable_id
          WHERE m.bank_statement_item_id = ${canonical}`));
      } catch {}

      // 3) Trilha de auditoria (conciliacoes/estornos deste lancamento)
      try {
        await ensureAuditTable();
        out.auditoria = rowsOf(await db.execute(sql`
          SELECT event_at, action, amount, performed_by, titles, counterpart
          FROM reconciliation_audit_log
          WHERE bank_statement_item_id IN (${inList([id, canonical])})
          ORDER BY event_at DESC LIMIT 20`));
      } catch {}

      // 4) Cadastro: cliente (credito) ou fornecedor (debito) pelo CPF/CNPJ, senao pelo nome
      const nomeLike = der.contraparte ? "%" + der.contraparte.replace(/\s+/g, "%") + "%" : "__none__";
      const docLike = docItem ? "%" + docItem + "%" : "__none__";
      try {
        if (item.type === "C") {
          const c = rowsOf(await db.execute(sql`
            SELECT id, name, company_name, cnpj, cpf, city, neighborhood, phone, seller_id, is_active
            FROM customers
            WHERE is_supplier IS NOT TRUE
              AND (regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') LIKE ${docLike}
                OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') LIKE ${docLike}
                OR (${nomeLike} <> '__none__' AND name ILIKE ${nomeLike}))
            ORDER BY (is_active IS TRUE) DESC LIMIT 3`));
          if (c.length) out.cadastro = { tipo: "cliente", achados: c };
        } else {
          const f = rowsOf(await db.execute(sql`
            SELECT id, name, company_name, cnpj, cpf, default_category, default_chart_account_id, is_active
            FROM suppliers
            WHERE (regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') LIKE ${docLike}
                OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') LIKE ${docLike}
                OR (${nomeLike} <> '__none__' AND name ILIKE ${nomeLike}))
            ORDER BY (is_active IS TRUE) DESC LIMIT 3`));
          if (f.length) out.cadastro = { tipo: "fornecedor", achados: f };
        }
      } catch {}

      // 5) Titulos em aberto da contraparte (por documento ou nome)
      try {
        if (item.type === "C") {
          out.titulosCadastro = rowsOf(await db.execute(sql`
            SELECT id, title_number, customer_name, customer_document, amount,
                   COALESCE(amount_paid,0) AS amount_paid, due_date, status
            FROM receivables
            WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida')
              AND (regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g') LIKE ${docLike}
                OR (${nomeLike} <> '__none__' AND customer_name ILIKE ${nomeLike}))
            ORDER BY due_date LIMIT 10`));
        } else {
          out.titulosCadastro = rowsOf(await db.execute(sql`
            SELECT id, title_number, supplier_name, supplier_document, amount,
                   COALESCE(amount_paid,0) AS amount_paid, due_date, status
            FROM payables
            WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida')
              AND (regexp_replace(COALESCE(supplier_document,''),'[^0-9]','','g') LIKE ${docLike}
                OR (${nomeLike} <> '__none__' AND supplier_name ILIKE ${nomeLike}))
            ORDER BY due_date LIMIT 10`));
        }
      } catch {}

      // 6) Cobrancas emitidas com o MESMO valor por perto (boleto/PIX) — ajuda a
      //    identificar de quem e o credito quando o extrato so diz "Cobranca".
      try {
        out.cobrancas.boletos = rowsOf(await db.execute(sql`
          SELECT id, nosso_numero, debtor_name, debtor_document, valor_original,
                 data_vencimento, status, receivable_id
          FROM boleto_charges
          WHERE round(COALESCE(NULLIF(valor_original::text,'')::numeric,0),2) = ${valor.toFixed(2)}::numeric
            AND (data_vencimento IS NULL OR abs(data_vencimento::date - ${dataISO}::date) <= 45)
          ORDER BY data_vencimento DESC NULLS LAST LIMIT 8`));
      } catch {}
      try {
        out.cobrancas.pix = rowsOf(await db.execute(sql`
          SELECT pc.id, pc.txid, pc.status, pc.receivable_id, pc.paid_at, pc.debtor_document,
                 round(COALESCE(NULLIF(pc.amount_paid::text,'')::numeric,0),2) AS valor_pago,
                 r.title_number, r.customer_name
          FROM pix_charges pc LEFT JOIN receivables r ON r.id = pc.receivable_id
          WHERE round(COALESCE(NULLIF(pc.amount_paid::text,'')::numeric,0),2) = ${valor.toFixed(2)}::numeric
            AND pc.paid_at IS NOT NULL AND abs(pc.paid_at::date - ${dataISO}::date) <= 5
          ORDER BY pc.paid_at DESC LIMIT 8`));
      } catch {}

      // 7) Padrao aprendido + conciliacoes ANTERIORES da mesma contraparte
      try {
        const nd = normDesc(item.description);
        const pr = rowsOf(await db.execute(sql`
          SELECT pattern_type, normalized_value, direction, counterparty_type, counterparty_name,
                 counterparty_document, suggested_category, match_count
          FROM reconciliation_patterns
          WHERE (pattern_type = 'cpf_cnpj' AND normalized_value = ${docItem || "__none__"})
             OR (pattern_type = 'description' AND normalized_value = ${nd || "__none__"})
          ORDER BY match_count DESC LIMIT 3`));
        out.padrao = pr[0] || null;
        out.padroes = pr;
      } catch {}
      try {
        out.conciliacoesAnteriores = rowsOf(await db.execute(sql`
          SELECT DISTINCT ON (COALESCE(r.title_number, p.title_number))
                 i.id, i.transaction_date, i.amount, i.type, i.description, i.origin_name,
                 r.title_number AS r_title, r.customer_name AS r_name,
                 p.title_number AS p_title, p.supplier_name AS p_name
          FROM bank_statement_items i
          JOIN bank_statement_item_matches m ON m.bank_statement_item_id = i.id
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN payables p ON p.id = m.payable_id
          WHERE i.id <> ${id} AND i.reconciliation_status = 'reconciled' AND i.type = ${item.type}
            AND COALESCE(r.title_number, p.title_number) IS NOT NULL
            AND (
              (${docItem || "__none__"} <> '__none__' AND (
                 regexp_replace(COALESCE(i.origin_document,''),'[^0-9]','','g') = ${docItem || "__none__"}
                 OR i.description LIKE ${docItem ? "%" + docItem + "%" : "__none__"}))
              OR (${nomeLike} <> '__none__' AND i.description ILIKE ${nomeLike})
            )
          ORDER BY COALESCE(r.title_number, p.title_number), i.transaction_date DESC
          LIMIT 6`));
      } catch {}

      res.json(out);
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Reparo: lancamento com match mas que voltou a 'pending' ------------
  // Causa-raiz (corrigida em 26/jul): o backfill noturno 1.0->2.0 fazia
  // "ON CONFLICT (id) DO UPDATE" em bank_statement_items, sobrescrevendo a
  // conciliacao feita no 2.0 com os valores (vazios) do 1.0. Os matches, criados
  // so no 2.0, sobreviviam -> titulo baixado, extrato "nao conciliado".
  // Este endpoint restaura o status a partir dos matches que sobreviveram.
  // SEGURANCA: so repara quando o titulo vinculado esta REALMENTE baixado
  // (paga/recebida ou amount_paid >= amount). Os demais entram em `naoReparados`.
  app.post("/api/reconciliation/reparar-conciliacoes", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "reparo-conciliacao").toString();
      const rows = rowsOf(await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.reconciliation_status,
               min(m.created_at) AS conciliado_em, min(m.created_by) AS conciliado_por,
               count(*)::int AS n_matches,
               max(m.receivable_id) AS receivable_id, max(m.payable_id) AS payable_id,
               bool_or(COALESCE(r.status::text,'') IN ('recebida') OR COALESCE(NULLIF(r.amount_paid::text,'')::numeric,0) >= COALESCE(NULLIF(r.amount::text,'')::numeric,0) - 0.005) AS recv_ok,
               bool_or(COALESCE(p.status::text,'') IN ('paga') OR COALESCE(NULLIF(p.amount_paid::text,'')::numeric,0) >= COALESCE(NULLIF(p.amount::text,'')::numeric,0) - 0.005) AS pay_ok,
               max(COALESCE(r.title_number, p.title_number)) AS titulo
        FROM bank_statement_items i
        JOIN bank_statement_item_matches m ON m.bank_statement_item_id = i.id
        LEFT JOIN receivables r ON r.id = m.receivable_id
        LEFT JOIN payables p ON p.id = m.payable_id
        WHERE COALESCE(i.reconciliation_status, 'pending') NOT IN ('reconciled', 'mirror')
          AND i.mirror_of IS NULL
        GROUP BY i.id, i.transaction_date, i.amount, i.type, i.description, i.reconciliation_status
        ORDER BY i.transaction_date DESC`));

      const reparar = rows.filter((r: any) => (r.receivable_id && r.recv_ok) || (r.payable_id && r.pay_ok));
      const naoReparados = rows.filter((r: any) => !((r.receivable_id && r.recv_ok) || (r.payable_id && r.pay_ok)))
        .map((r: any) => ({ id: r.id, data: String(r.transaction_date || "").slice(0, 10), valor: r.amount, titulo: r.titulo, motivo: "titulo vinculado NAO esta baixado - conferir manualmente" }));
      const amostra = reparar.slice(0, 15).map((r: any) => ({ data: String(r.transaction_date || "").slice(0, 10), valor: r.amount, tipo: r.type, titulo: r.titulo, descricao: String(r.description || "").slice(0, 45), conciliadoEm: r.conciliado_em, por: r.conciliado_por }));
      if (dryRun) return res.json({ ok: true, dryRun: true, candidatos: rows.length, reparaveis: reparar.length, naoReparados, amostra });

      let reparados = 0;
      const erros: string[] = [];
      for (const r of reparar as any[]) {
        try {
          const nota = `Conciliacao restaurada em ${new Date().toISOString()} a partir do vinculo de ${String(r.conciliado_em || "").slice(0, 19)} por ${r.conciliado_por || "-"} (havia sido revertida pelo backfill 1.0->2.0)`;
          await db.execute(sql`
            UPDATE bank_statement_items
            SET reconciliation_status = 'reconciled',
                matched_receivable_id = COALESCE(matched_receivable_id, ${r.receivable_id ?? null}),
                matched_payable_id = COALESCE(matched_payable_id, ${r.payable_id ?? null}),
                matched_at = COALESCE(matched_at, ${r.conciliado_em ?? null}),
                matched_by = COALESCE(matched_by, ${r.conciliado_por ?? by}),
                match_confidence = COALESCE(match_confidence, 100),
                notes = ${nota}
            WHERE id = ${r.id}`);
          await logReconAudit({ action: "repair", itemId: r.id, amount: money(r.amount), itemType: r.type || null, transactionDate: r.transaction_date || null, description: r.description || "", by, details: { titulo: r.titulo, conciliadoEm: r.conciliado_em } });
          reparados++;
        } catch (e: any) { erros.push(String(e?.message || e).slice(0, 120)); }
      }
      res.json({ ok: true, dryRun: false, candidatos: rows.length, reparados, naoReparados, erros });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Backfill: preenche origin_document dos lancamentos JA importados ----
  // Extrai o CPF/CNPJ do texto do lancamento (inclusive desfazendo o padding de
  // zeros do BB) e grava em origin_document quando estiver vazio. Idempotente.
  app.post("/api/reconciliation/backfill-detalhes", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureRawColumn();
      const dryRun = req.body?.dryRun !== false;
      const accountId = (req.body?.accountId || "").toString() || null;
      const rows = rowsOf(await db.execute(sql`
        SELECT i.id, i.description, i.origin_name
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        WHERE COALESCE(i.origin_document, '') = ''
          AND i.description ~ '[0-9]{11}'
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
        LIMIT 20000`));
      let atualizados = 0;
      const amostra: any[] = [];
      for (const r of rows) {
        const d = derivarDetalhe(r.description, r.origin_name);
        if (!d.doc) continue;
        if (amostra.length < 10) amostra.push({ descricao: r.description, contraparte: d.contraparte, documento: d.doc });
        if (!dryRun) { await db.execute(sql`UPDATE bank_statement_items SET origin_document = ${d.doc} WHERE id = ${r.id}`); }
        atualizados++;
      }
      res.json({ ok: true, dryRun, candidatos: rows.length, atualizados, amostra });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // =========================================================================
  // FASE 2 — ESCRITA (financeiro). Conciliar dá baixa (reusa a baixa testada).
  // =========================================================================

  async function settleReceivable(recId: string, amount: number, method: string, accountId: string | null, paidAtISO: string, by: string) {
    const br = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${recId} ORDER BY created_at DESC NULLS LAST LIMIT 1`);
    const charge = rowsOf(br)[0];
    if (charge) {
      const result = await settleBoletoCharge(charge, amount, paidAtISO, "conciliacao-bancaria");
      return { via: "boleto", result };
    }
    const rec: any = await storage.getReceivable(recId);
    if (!rec) throw new Error("recebivel nao encontrado: " + recId);
    const prevPaid = Number(rec.amountPaid || 0);
    const amt = Number(rec.amount || 0);
    // FIX 3.4b: titulo ja quitado (ex.: conciliacao anterior interrompida no meio) ->
    // nao duplica a baixa; o chamador ainda vincula o item do extrato ao titulo.
    if (amt > 0 && prevPaid >= amt - 0.005) return { via: "ja_baixado", status: rec.status };
    // FIX (teto): idem ao pagavel — nunca baixar mais do que resta.
    const emAbertoR = amt > 0 ? amt - prevPaid : amount;
    const aBaixarR = Math.max(0, Math.min(amount, emAbertoR));
    const newPaid = prevPaid + aBaixarR;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "recebida" : rec.status;
    // FIX 3.4b: paid_at precisa ser Date (string quebrava o drizzle com
    // "value.toISOString is not a function"); pagamento criado ANTES da baixa,
    // para nao deixar titulo baixado sem pagamento se algo falhar.
    await storage.createReceivablePayment({ receivableId: recId, paidAt: new Date(paidAtISO) as any, amount: aBaixarR.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || rec.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
    await storage.updateReceivable(recId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || rec.financialAccountId || null } as any);
    return { via: "receivable", status };
  }

  async function settlePayable(payId: string, amount: number, method: string, accountId: string | null, paidAtISO: string, by: string) {
    const pay: any = await storage.getPayable(payId);
    if (!pay) throw new Error("pagavel nao encontrado: " + payId);
    const prevPaid = Number(pay.amountPaid || 0);
    const amt = Number(pay.amount || 0);
    // FIX 3.4b: titulo ja quitado -> nao duplica a baixa (so vincula o extrato).
    if (amt > 0 && prevPaid >= amt - 0.005) return { via: "ja_baixado", status: pay.status };
    // FIX (teto): a baixa nao pode passar do que falta pagar.
    const emAbertoP = amt > 0 ? amt - prevPaid : amount;
    const aBaixarP = Math.max(0, Math.min(amount, emAbertoP));
    const newPaid = prevPaid + aBaixarP;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "paga" : pay.status;
    // FIX 3.4b: paid_at como Date + pagamento antes da baixa (ver settleReceivable).
    await storage.createPayablePayment({ payableId: payId, paidAt: new Date(paidAtISO) as any, amount: aBaixarP.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || pay.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
    await storage.updatePayable(payId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || pay.financialAccountId || null } as any);
    return { via: "payable", status };
  }

  async function evolvePattern(item: any, cp: { type: string; id: string | null; name: string | null; document: string | null; category: string | null }, instanceId: string | null, by: string) {
    try {
      const dir = item.type;
      const doc = onlyDigits(cp.document) || ((String(item.description || "").match(/(\d{11}|\d{14})/) || [])[1] || "");
      const nd = normDesc(item.description);
      const entries: { ptype: string; pval: string; norm: string }[] = [];
      if (doc) entries.push({ ptype: "cpf_cnpj", pval: doc, norm: doc });
      if (nd) entries.push({ ptype: "description", pval: String(item.description || "").slice(0, 200), norm: nd });
      for (const e of entries) {
        const ex = rowsOf(await db.execute(sql`
          SELECT id FROM reconciliation_patterns
          WHERE pattern_type = ${e.ptype} AND normalized_value = ${e.norm} AND direction = ${dir} LIMIT 1`))[0];
        if (ex) {
          await db.execute(sql`
            UPDATE reconciliation_patterns
            SET match_count = COALESCE(match_count,0) + 1, last_used_at = now(), updated_at = now(),
                counterparty_type = ${cp.type}, counterparty_id = ${cp.id}, counterparty_name = ${cp.name},
                counterparty_document = ${cp.document}, suggested_category = COALESCE(${cp.category}, suggested_category)
            WHERE id = ${ex.id}`);
        } else {
          await db.execute(sql`
            INSERT INTO reconciliation_patterns (id, pattern_type, pattern_value, normalized_value, direction,
              counterparty_type, counterparty_id, counterparty_name, counterparty_document, suggested_category,
              omie_instance_id, match_count, last_used_at, created_by, created_at, updated_at)
            VALUES (gen_random_uuid(), ${e.ptype}, ${e.pval}, ${e.norm}, ${dir},
              ${cp.type}, ${cp.id}, ${cp.name}, ${cp.document}, ${cp.category},
              ${instanceId}, 1, now(), ${by}, now(), now())`);
        }
      }
    } catch (_e) { /* best-effort */ }
  }

  // Buscar títulos em aberto (aba "Buscar Título" do modal) — C=receber, D=pagar
  app.get("/api/reconciliation/titles/search", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const type = String(req.query.type || "C").toUpperCase() === "D" ? "D" : "C";
      const q = String(req.query.q || "").trim();
      const limit = Math.min(parseInt(String(req.query.limit || "30")) || 30, 100);
      const like = `%${q}%`;
      const qDigits = q.replace(/\D/g, "");
      const qNumRaw = q.replace(/[^0-9.,]/g, "").replace(/\./g, "").replace(",", ".");
      const qNum = qNumRaw ? parseFloat(qNumRaw) : NaN;
      if (type === "C") {
        // Em aberto OU ja baixado manualmente mas SEM vinculo bancario (permite conciliar
        // o extrato ao titulo ja pago — a baixa nao e duplicada; so cria o vinculo).
        const openCond = sql`(r.status IN ('a_vencer','vencida') AND (r.amount - COALESCE(r.amount_paid,0)) > 0)`;
        const settledUnlinked = sql`(r.status = 'recebida' AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.receivable_id = r.id))`;
        const conds: any[] = [sql`r.deleted_at IS NULL`, q ? sql`(${openCond} OR ${settledUnlinked})` : openCond];
        if (q) {
          const ors: any[] = [sql`title_number ILIKE ${like}`, sql`customer_name ILIKE ${like}`];
          if (qDigits) ors.push(sql`COALESCE(customer_document,'') ILIKE ${'%' + qDigits + '%'}`);
          if (!isNaN(qNum)) ors.push(sql`round(amount::numeric,2) = ${qNum}`);
          conds.push(sql`(${sql.join(ors, sql` OR `)})`);
        }
        const r = await db.execute(sql`
          SELECT r.id, r.title_number, r.customer_name, r.customer_document, r.amount, r.status,
                 (r.amount - COALESCE(r.amount_paid,0)) AS restante, r.due_date, r.omie_instance_id,
                 r.chart_account_id, (c.code || ' ' || c.name) AS chart_label
          FROM receivables r LEFT JOIN chart_of_accounts c ON c.id = r.chart_account_id
          WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY (status IN ('a_vencer','vencida')) DESC, due_date NULLS LAST LIMIT ${limit}`);
        return res.json({ titles: rowsOf(r).map((t: any) => ({ kind: "receivable", id: t.id, title: t.title_number, name: t.customer_name, document: t.customer_document, amount: t.amount, restante: t.restante, due: t.due_date, instance: t.omie_instance_id, chartAccountId: t.chart_account_id || null, chartLabel: t.chart_label || null, jaBaixado: String(t.status) === 'recebida' })) });
      } else {
        // Em aberto OU ja baixado manualmente mas SEM vinculo bancario (permite conciliar
        // o extrato ao titulo ja pago — a baixa nao e duplicada; so cria o vinculo).
        const openCond = sql`(p.status IN ('a_vencer','vencida') AND (p.amount - COALESCE(p.amount_paid,0)) > 0)`;
        const settledUnlinked = sql`(p.status = 'paga' AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.payable_id = p.id))`;
        const conds: any[] = [sql`p.deleted_at IS NULL`, q ? sql`(${openCond} OR ${settledUnlinked})` : openCond];
        if (q) {
          const ors: any[] = [sql`title_number ILIKE ${like}`, sql`supplier_name ILIKE ${like}`];
          if (qDigits) ors.push(sql`COALESCE(supplier_document,'') ILIKE ${'%' + qDigits + '%'}`);
          if (!isNaN(qNum)) ors.push(sql`round(amount::numeric,2) = ${qNum}`);
          conds.push(sql`(${sql.join(ors, sql` OR `)})`);
        }
        const r = await db.execute(sql`
          SELECT p.id, p.title_number, p.supplier_name, p.supplier_document, p.amount, p.status,
                 (p.amount - COALESCE(p.amount_paid,0)) AS restante, p.due_date, p.omie_instance_id,
                 p.chart_account_id, (c.code || ' ' || c.name) AS chart_label
          FROM payables p LEFT JOIN chart_of_accounts c ON c.id = p.chart_account_id
          WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY (status IN ('a_vencer','vencida')) DESC, due_date NULLS LAST LIMIT ${limit}`);
        return res.json({ titles: rowsOf(r).map((t: any) => ({ kind: "payable", id: t.id, title: t.title_number, name: t.supplier_name, document: t.supplier_document, amount: t.amount, restante: t.restante, due: t.due_date, instance: t.omie_instance_id, chartAccountId: t.chart_account_id || null, chartLabel: t.chart_label || null, jaBaixado: String(t.status) === 'paga' })) });
      }
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/reconciliation/items/:id/ignore", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const reason = (req.body?.reason || "").toString();
      const cur = rowsOf(await db.execute(sql`SELECT reconciliation_status FROM bank_statement_items WHERE id = ${id}`))[0];
      if (!cur) return res.status(404).json({ error: "item nao encontrado" });
      if (cur.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado; desfaca antes de ignorar" });
      const note = `Ignorado por ${by} em ${new Date().toISOString()}${reason ? " - " + reason : ""}`;
      await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(), notes = ${note}
        WHERE id = ${id}`);
      res.json({ ok: true, status: "ignored" });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // IGNORAR EM LOTE: marca varios lancamentos como 'ignored' numa unica chamada.
  // Nao dá baixa em nada (igual ao ignore individual). Pula os ja 'reconciled'
  // (exigem desfazer antes) — reportados em skippedReconciled.
  app.post("/api/reconciliation/items/ignore-batch", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => String(x)).filter(Boolean) : [];
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const reason = (req.body?.reason || "").toString();
      if (!ids.length) return res.status(400).json({ error: "ids[] obrigatorio" });
      const note = `Ignorado em lote por ${by} em ${new Date().toISOString()}${reason ? " - " + reason : ""}`;
      const r: any = await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(), notes = ${note}
        WHERE id IN (${inList(ids)}) AND COALESCE(reconciliation_status, 'pending') <> 'reconciled'`);
      const ignored = r.rowCount ?? 0;
      res.json({ ok: true, ignored, requested: ids.length, skippedReconciled: ids.length - ignored });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/reconciliation/items/:id/reconcile", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const dryRun = !!req.body?.dryRun;
      const titles: any[] = Array.isArray(req.body?.titles) ? req.body.titles : [];
      if (!titles.length) return res.status(400).json({ error: "titles[] obrigatorio" });
      const item = rowsOf(await db.execute(sql`
        SELECT i.*, s.omie_instance_id AS s_instance, s.financial_account_id AS s_account
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.id = ${id}`))[0];
      if (!item) return res.status(404).json({ error: "item nao encontrado" });
      if (item.mirror_of) return res.status(409).json({ error: "lancamento espelho (ja importado em outro extrato); concilie no extrato de origem ou na aba Pendentes" });
      if (item.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado" });
      const method = (req.body?.paymentMethod || pickMethod(item.description)).toString();
      const paidAtISO = (req.body?.paidAt ? new Date(req.body.paidAt) : new Date(item.transaction_date || Date.now())).toISOString();
      const accountId = item.s_account || null;

      const plan = titles.map((t) => ({
        kind: t.kind === "payable" ? "payable" : "receivable",
        id: t.id,
        amount: Number(t.amount || 0),
        interest: Number(t.interest || 0),
        discount: Number(t.discount || 0),
        chartAccountId: t.chartAccountId ? String(t.chartAccountId) : null,
        settled: Number(t.amount || 0) + Number(t.interest || 0) - Number(t.discount || 0),
      }));
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, item: { id: item.id, amount: item.amount, type: item.type, description: item.description }, method, paidAtISO, accountId, plan });
      }

      // ---- FASE 3.4h: categoria DRE selecionavel na conciliacao ----------
      // Valida e aplica a categoria enviada por titulo ANTES da baixa.
      // Pagar sem categoria (nem existente, nem enviada) -> bloqueia.
      // Receber sem categoria -> assume a primeira conta de receita bruta.
      {
        const wanted = Array.from(new Set(plan.map((t) => t.chartAccountId).filter(Boolean))) as string[];
        if (wanted.length) {
          const okIds = new Set(rowsOf(await db.execute(sql`
            SELECT id FROM chart_of_accounts
            WHERE is_active = true AND code LIKE '%.%' AND id IN (${inList(wanted)})`)).map((c: any) => String(c.id)));
          const bad = wanted.find((w) => !okIds.has(String(w)));
          if (bad) return res.status(400).json({ error: "Categoria DRE invalida ou inativa. Selecione uma categoria do plano de contas." });
        }
        let defRecv: string | null = null;
        for (const t of plan) {
          if (t.kind === "receivable") {
            if (t.chartAccountId) {
              await db.execute(sql`UPDATE receivables SET chart_account_id = ${t.chartAccountId} WHERE id = ${t.id}`);
            } else {
              const cur = rowsOf(await db.execute(sql`SELECT chart_account_id FROM receivables WHERE id = ${t.id}`))[0];
              if (cur && !cur.chart_account_id) {
                if (defRecv === null) {
                  const q = rowsOf(await db.execute(sql`SELECT id FROM chart_of_accounts WHERE dre_group = 'receita_bruta' AND code LIKE '%.%' AND is_active = true ORDER BY code LIMIT 1`));
                  defRecv = (q[0]?.id as string) || "";
                }
                if (defRecv) await db.execute(sql`UPDATE receivables SET chart_account_id = ${defRecv} WHERE id = ${t.id}`);
              }
            }
          } else {
            if (t.chartAccountId) {
              await db.execute(sql`UPDATE payables SET chart_account_id = ${t.chartAccountId} WHERE id = ${t.id}`);
            } else {
              const cur = rowsOf(await db.execute(sql`SELECT chart_account_id FROM payables WHERE id = ${t.id}`))[0];
              if (cur && !cur.chart_account_id) return res.status(400).json({ error: "Selecione a categoria DRE (plano de contas) do titulo a pagar. Nenhuma baixa sem categoria." });
            }
          }
        }
      }

      const kind = titles.length > 1 ? "manual_multi" : "manual";
      const results: any[] = [];
      let firstRecv: string | null = null, firstPay: string | null = null;
      let cpInfo: any = null;
      for (const t of plan) {
        if (t.kind === "receivable") {
          const r = await settleReceivable(t.id, t.settled, method, accountId, paidAtISO, by);
          results.push({ id: t.id, kind: "receivable", ...r });
          if (!firstRecv) firstRecv = t.id;
          if (!cpInfo) { const rec: any = await storage.getReceivable(t.id); if (rec) cpInfo = { type: "customer", id: rec.customerId || null, name: rec.customerName || null, document: rec.customerDocument || null, category: rec.category || null }; }
        } else {
          const r = await settlePayable(t.id, t.settled, method, accountId, paidAtISO, by);
          results.push({ id: t.id, kind: "payable", ...r });
          if (!firstPay) firstPay = t.id;
          if (!cpInfo) { const pay: any = await storage.getPayable(t.id); if (pay) cpInfo = { type: "supplier", id: null, name: pay.supplierName || null, document: pay.supplierDocument || null, category: pay.category || null }; }
        }
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${id}, ${t.kind === "receivable" ? t.id : null}, ${t.kind === "payable" ? t.id : null}, ${t.amount.toFixed(2)}, ${kind}, ${t.settled.toFixed(2)}, ${t.interest.toFixed(2)}, ${t.discount.toFixed(2)}, ${by}, now())`);
      }
      const note = `Conciliado por ${by} em ${new Date().toISOString()}${titles.length > 1 ? " (composta " + titles.length + " titulos)" : ""}`;
      await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'reconciled', matched_receivable_id = ${firstRecv}, matched_payable_id = ${firstPay},
            matched_at = now(), matched_by = ${by}, match_confidence = 100, notes = ${note}
        WHERE id = ${id}`);
      if (cpInfo) await evolvePattern(item, cpInfo, item.s_instance || null, by);
      await logReconAudit({ action: "reconcile", itemId: id, statementId: item.statement_id || null, accountId, instanceId: item.s_instance || null, amount: money(item.amount), itemType: item.type || null, transactionDate: item.transaction_date || null, description: item.description || "", titles: plan, counterpart: cpInfo || null, by, details: { kind, results } });
      res.json({ ok: true, status: "reconciled", kind, results });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // ---- FASE 3.4c: cadastros no "Criar Novo" -------------------------------
  // Busca fornecedores no cadastro (autocomplete do modal).
  app.get("/api/reconciliation/suppliers/search", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${q}%`;
      const digits = onlyDigits(q);
      const digitsLike = digits ? "%" + digits + "%" : "__none__";
      const r = await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf, default_category, default_chart_account_id
        FROM suppliers
        WHERE (is_active IS NOT FALSE)
          AND (${q} = '' OR name ILIKE ${like} OR company_name ILIKE ${like}
               OR regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') LIKE ${digitsLike}
               OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') LIKE ${digitsLike})
        ORDER BY name LIMIT 10`);
      res.json({ suppliers: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Busca clientes no cadastro p/ o campo Cliente de Contas a Receber (nome/razao/cnpj/cpf).
  app.get("/api/reconciliation/customers/search", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${q}%`;
      const digits = onlyDigits(q);
      const digitsLike = digits ? "%" + digits + "%" : "__none__";
      const r = await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf
        FROM customers
        WHERE (is_supplier IS NOT TRUE)
          AND (${q} = '' OR name ILIKE ${like} OR company_name ILIKE ${like}
               OR regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') LIKE ${digitsLike}
               OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') LIKE ${digitsLike})
        ORDER BY (is_active IS TRUE) DESC, name LIMIT 10`);
      res.json({ customers: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Busca categorias analiticas do DRE (plano de contas) p/ o campo Categoria.
  app.get("/api/reconciliation/dre-categories", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${q}%`;
      const r = await db.execute(sql`
        SELECT id, code, name, type, dre_group
        FROM chart_of_accounts
        WHERE (is_active IS NOT FALSE) AND code LIKE '%.%'
          AND (${q} = '' OR name ILIKE ${like} OR code ILIKE ${like})
        ORDER BY code LIMIT 20`);
      res.json({ categories: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Garante o fornecedor no cadastro: procura por documento/nome; cadastra se novo.
  async function ensureSupplier(name: string, document: string | null, instanceId: string | null, chartAccountId: string | null, category: string | null, by: string): Promise<{ id: string | null; created: boolean; name: string; document: string | null }> {
    const nm = String(name || "").trim();
    if (!nm) return { id: null, created: false, name: nm, document };
    const digits = onlyDigits(document);
    try {
      let found: any = null;
      if (digits) {
        found = rowsOf(await db.execute(sql`
          SELECT id, name, cnpj, cpf FROM suppliers
          WHERE regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') = ${digits}
             OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') = ${digits} LIMIT 1`))[0];
      }
      if (!found) {
        found = rowsOf(await db.execute(sql`
          SELECT id, name, cnpj, cpf FROM suppliers
          WHERE lower(trim(name)) = ${nm.toLowerCase()} OR lower(trim(COALESCE(company_name, ''))) = ${nm.toLowerCase()} LIMIT 1`))[0];
      }
      if (found) return { id: found.id, created: false, name: found.name || nm, document: document || found.cnpj || found.cpf || null };
      const cols = await tableColInfo("suppliers");
      const row = await insertDynamic("suppliers", cols, {
        name: nm,
        cnpj: digits.length === 14 ? document : null,
        cpf: digits.length === 11 ? document : null,
        omie_instance_id: instanceId,
        default_chart_account_id: chartAccountId,
        default_category: category,
        is_active: true,
        notes: "Cadastrado automaticamente pela Conciliacao 2.0 (" + by + ")",
      }, "id");
      return { id: row?.id || null, created: true, name: nm, document };
    } catch (_e) { return { id: null, created: false, name: nm, document }; }
  }

  // Criar Novo (aba do modal, igual ao 1.0): cria um titulo (conta a pagar/receber) na hora
  // com os dados do lancamento do banco e JA concilia (da baixa) contra o item do extrato.
  app.post("/api/reconciliation/items/:id/create-and-reconcile", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const b = req.body || {};
      const by = (b.by || "conciliacao-2.0").toString();
      const tipo = (b.tipo === "receber" || b.tipo === "receivable") ? "receber" : "pagar";
      const amount = Number(b.amount || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "valor invalido" });
      const item = rowsOf(await db.execute(sql`
        SELECT i.*, s.omie_instance_id AS s_instance, s.financial_account_id AS s_account
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id WHERE i.id = ${id}`))[0];
      if (!item) return res.status(404).json({ error: "item nao encontrado" });
      if (item.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado" });
      const method = (b.paymentMethod || pickMethod(item.description)).toString();
      const paidAtISO = (b.paidAt ? new Date(b.paidAt) : new Date(item.transaction_date || Date.now())).toISOString();
      const accountId = item.s_account || null;
      const instanceId = b.omieInstanceId || item.s_instance || null;
      const issue = b.issueDate ? new Date(b.issueDate) : new Date(item.transaction_date || Date.now());
      const due = b.dueDate ? new Date(b.dueDate) : issue;
      const desc = (b.description || item.description || "").toString().slice(0, 300);
      let name = (b.name || item.description || "Sem nome").toString().slice(0, 120);
      let doc = (b.document || "").toString();
      const category = b.category ? String(b.category) : null;
      let chartAccountId = b.chartAccountId ? String(b.chartAccountId) : null;
      // FASE 3.4m - se veio so o TEXTO da categoria (pre-marcada) e sem id, resolve o
      // chartAccountId casando com o plano de contas (code+name / name / code).
      if (!chartAccountId && category) {
        const cat = String(category).trim();
        const codeTok = cat.split(/\s+/)[0];
        try {
          const q = rowsOf(await db.execute(sql`
            SELECT id FROM chart_of_accounts
            WHERE is_active = true AND code LIKE '%.%'
              AND (lower(code || ' ' || name) = lower(${cat}) OR lower(name) = lower(${cat}) OR code = ${codeTok})
            ORDER BY code LIMIT 1`));
          if (q[0]?.id) chartAccountId = String(q[0].id);
        } catch {}
      }
      // FASE 3.4e - categoria DRE obrigatoria: nenhuma conta e criada sem categoria.
      if (!chartAccountId) return res.status(400).json({ error: "Selecione a categoria DRE (plano de contas). Nenhuma conta pode ser criada sem categoria." });
      // FASE 3.4c - fornecedor vem do cadastro: procura por documento/nome e
      // cadastra automaticamente quando o nome e novo.
      let supplierInfo: any = null;
      if (tipo === "pagar") {
        supplierInfo = await ensureSupplier(name, doc || null, instanceId, chartAccountId, category, by);
        name = String(supplierInfo.name || name).slice(0, 120);
        if (!doc && supplierInfo.document) doc = String(supplierInfo.document);
      }

      let titleId: string; let kind: "receivable" | "payable";
      if (tipo === "receber") {
        const rec: any = await storage.createReceivable({ customerName: name, customerDocument: doc || null, amount: amount.toFixed(2), issueDate: issue as any, dueDate: due as any, description: desc, category, chartAccountId: chartAccountId, omieInstanceId: instanceId, financialAccountId: accountId, status: "a_vencer", createdBy: by } as any);
        titleId = rec.id; kind = "receivable";
        await settleReceivable(titleId, amount, method, accountId, paidAtISO, by);
      } else {
        const pay: any = await storage.createPayable({ supplierName: name, supplierDocument: doc || null, amount: amount.toFixed(2), issueDate: issue as any, dueDate: due as any, description: desc, chartAccountId: chartAccountId, omieInstanceId: instanceId, financialAccountId: accountId, status: "a_vencer", source: "manual", createdBy: by, notes: category ? ("Categoria: " + category) : null } as any);
        titleId = pay.id; kind = "payable";
        await settlePayable(titleId, amount, method, accountId, paidAtISO, by);
      }
      await db.execute(sql`
        INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
        VALUES (gen_random_uuid(), ${id}, ${kind === "receivable" ? titleId : null}, ${kind === "payable" ? titleId : null}, ${amount.toFixed(2)}, ${"manual_novo"}, ${amount.toFixed(2)}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
      const note = `Conciliado (titulo criado) por ${by} em ${new Date().toISOString()}`;
      await db.execute(sql`
        UPDATE bank_statement_items SET reconciliation_status = 'reconciled',
          matched_receivable_id = ${kind === "receivable" ? titleId : null}, matched_payable_id = ${kind === "payable" ? titleId : null},
          matched_at = now(), matched_by = ${by}, match_confidence = 100, notes = ${note} WHERE id = ${id}`);
      try { await evolvePattern(item, { type: kind === "receivable" ? "customer" : "supplier", id: null, name, document: doc || null, category }, instanceId, by); } catch {}
      res.json({ ok: true, status: "reconciled", created: { kind, id: titleId }, supplier: supplierInfo });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Desfazer conciliação (reverte a baixa) ------------------------------
  // FASE 3.4s: o corpo virou a função `undoReconciliation(id, by)` para poder ser
  // reusada pela correção em lote de BAIXA DUPLA (`fix-baixa-dupla`). A rota abaixo
  // continua idêntica no comportamento e no formato da resposta.
  async function undoReconciliation(id: string, by: string): Promise<{ ok: boolean; status?: string; reverted?: any; error?: string; code?: number }> {
    {
      const item = rowsOf(await db.execute(sql`SELECT * FROM bank_statement_items WHERE id = ${id}`))[0];
      if (!item) return { ok: false, error: "item nao encontrado", code: 404 };
      if (item.reconciliation_status === "ignored") {
        await db.execute(sql`UPDATE bank_statement_items SET reconciliation_status='pending', matched_by=${by}, matched_at=null, notes=null WHERE id=${id}`);
        return { ok: true, status: "pending", reverted: "ignored" };
      }
      if (item.reconciliation_status !== "reconciled") return { ok: false, error: "item nao esta conciliado", code: 409 };
      const matches = rowsOf(await db.execute(sql`SELECT * FROM bank_statement_item_matches WHERE bank_statement_item_id = ${id}`));
      const reverted: any[] = [];
      // Vencido por DIA-CALENDÁRIO (fuso Brasil): ao desfazer a baixa, o título só volta a
      // 'vencida' se o vencimento JÁ PASSOU. Vence HOJE (ou futuro) volta a 'a_vencer'.
      // (Antes usava due < new Date() — comparação por INSTANTE — e um título que vence hoje
      // de manhã voltava 'vencida' à tarde, aparecendo como vencido no mesmo dia.)
      // Vencimento = data de calendário (meia-noite UTC) => ler em UTC; HOJE em BRT.
      // (Ler o vencimento em BRT puxava o dia p/ trás e devolvia 'vencida' a um título
      // que vence HOJE ao desfazer a baixa.)
      const _pastDueBR = (d: Date | null) => !!d && d.toLocaleDateString('en-CA', { timeZone: 'UTC' }) < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      for (const m of matches) {
        const settled = Number(m.title_amount_settled || m.amount || 0);
        if (m.receivable_id) {
          const rec: any = await storage.getReceivable(m.receivable_id);
          if (rec) {
            const newPaid = Math.max(0, Number(rec.amountPaid || 0) - settled);
            const amt = Number(rec.amount || 0);
            const due = rec.dueDate ? new Date(rec.dueDate) : null;
            const status = amt > 0 && newPaid >= amt - 0.005 ? "recebida" : (_pastDueBR(due) ? "vencida" : "a_vencer");
            await storage.updateReceivable(m.receivable_id, { amountPaid: newPaid.toFixed(2), status, __allowUnsettle: true } as any);
            // FIX: o DELETE antigo casava por (reference, amount) SEM LIMIT e nao achava
            // a baixa feita via boleto (reference = nosso numero). Agora apaga UMA linha,
            // e cobre os dois casos.
            await db.execute(sql`
              DELETE FROM receivable_payments WHERE ctid IN (
                SELECT rp.ctid FROM receivable_payments rp
                WHERE rp.receivable_id = ${m.receivable_id}
                  AND rp.amount = ${settled.toFixed(2)}
                  AND rp.deleted_at IS NULL
                  AND (rp.reference = 'conciliacao-bancaria'
                       OR rp.reference IN (SELECT bc.nosso_numero FROM boleto_charges bc WHERE bc.receivable_id = ${m.receivable_id}))
                ORDER BY rp.created_at DESC LIMIT 1)`);
            reverted.push({ kind: "receivable", id: m.receivable_id, status });
          }
        } else if (m.payable_id) {
          const pay: any = await storage.getPayable(m.payable_id);
          if (pay) {
            const newPaid = Math.max(0, Number(pay.amountPaid || 0) - settled);
            const amt = Number(pay.amount || 0);
            const due = pay.dueDate ? new Date(pay.dueDate) : null;
            const status = amt > 0 && newPaid >= amt - 0.005 ? "paga" : (_pastDueBR(due) ? "vencida" : "a_vencer");
            await storage.updatePayable(m.payable_id, { amountPaid: newPaid.toFixed(2), status, __allowUnsettle: true } as any);
            // FIX: sem LIMIT, desfazer UMA conciliacao apagava TODAS as parcelas iguais.
            await db.execute(sql`
              DELETE FROM payable_payments WHERE ctid IN (
                SELECT pp.ctid FROM payable_payments pp
                WHERE pp.payable_id = ${m.payable_id}
                  AND pp.amount = ${settled.toFixed(2)}
                  AND pp.reference = 'conciliacao-bancaria'
                ORDER BY pp.created_at DESC LIMIT 1)`);
            reverted.push({ kind: "payable", id: m.payable_id, status });
          }
        }
      }
      await db.execute(sql`DELETE FROM bank_statement_item_matches WHERE bank_statement_item_id = ${id}`);
      await db.execute(sql`UPDATE bank_statement_items SET reconciliation_status='pending', matched_receivable_id=null, matched_payable_id=null, matched_at=null, matched_by=${by}, match_confidence=null, notes=null WHERE id=${id}`);
      await logReconAudit({ action: "undo", itemId: id, statementId: item.statement_id || null, amount: money(item.amount), itemType: item.type || null, transactionDate: item.transaction_date || null, description: item.description || "", titles: matches.map((m: any) => ({ receivable_id: m.receivable_id, payable_id: m.payable_id, amount: m.amount, settled: m.title_amount_settled })), by, details: { reverted } });
      return { ok: true, status: "pending", reverted };
    }
  }

  app.post("/api/reconciliation/items/:id/undo", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const r = await undoReconciliation(req.params.id, (req.body?.by || "conciliacao-2.0").toString());
      if (!r.ok) return res.status(r.code || 409).json({ error: r.error });
      res.json({ ok: true, status: r.status, reverted: r.reverted });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // =========================================================================
  // IMPORTAR OFX — cria bank_statement + bank_statement_items (status pending).
  // Não dá baixa; só ingere o extrato (o motor sugere a conciliação).
  // Insert defensivo por introspecção de colunas (tabelas vêm do sync do 1.0).
  // =========================================================================

  type ColInfo = Map<string, { nullable: boolean; hasDefault: boolean; dtype: string }>;
  async function tableColInfo(table: string): Promise<ColInfo> {
    const r = await db.execute(sql`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name = ${table} AND table_schema = 'public'`);
    const m: ColInfo = new Map();
    for (const c of rowsOf(r)) m.set(String(c.column_name), { nullable: c.is_nullable === "YES", hasDefault: c.column_default != null, dtype: String(c.data_type || "") });
    return m;
  }
  const defaultForType = (dtype: string): any => {
    if (/int|numeric|real|double|decimal|money/i.test(dtype)) return 0;
    if (/bool/i.test(dtype)) return false;
    if (/timestamp|date|time/i.test(dtype)) return new Date().toISOString();
    return "";
  };
  async function insertDynamic(table: string, cols: ColInfo, valueMap: Record<string, any>, returning?: string) {
    const names: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(valueMap)) {
      if (v === undefined) continue;
      if (cols.has(k)) { names.push(k); vals.push(v); }
    }
    // Preenche NOT NULL sem default que não foram fornecidos (evita 500 por coluna obrigatória)
    for (const [name, info] of cols.entries()) {
      if (name === "id") continue;
      if (!info.nullable && !info.hasDefault && !names.includes(name)) { names.push(name); vals.push(defaultForType(info.dtype)); }
    }
    const colSql = sql.join(names.map((c) => sql.raw('"' + c + '"')), sql`, `);
    const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    const hasId = cols.has("id");
    const idColSql = hasId ? sql`"id", ` : sql``;
    const idValSql = hasId ? sql`gen_random_uuid(), ` : sql``;
    const retSql = returning ? sql`${sql.raw('RETURNING "' + returning + '"')}` : sql``;
    const r = await db.execute(sql`INSERT INTO ${sql.raw('"' + table + '"')} (${idColSql}${colSql}) VALUES (${idValSql}${valSql}) ${retSql}`);
    return rowsOf(r)[0] || null;
  }

  const ofxDate = (v: any): string | null => {
    const s = onlyDigits(v);
    if (s.length < 8) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };
  const ofxAmount = (v: any): number => {
    let s = String(v == null ? "" : v).trim().replace(/[^0-9.,\-]/g, "");
    if (!s) return NaN;
    if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
    else if (s.includes(",")) s = s.replace(",", ".");
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  };
  const ofxTag = (block: string, tag: string): string => {
    const m = block.match(new RegExp("<" + tag + ">([^<\\r\\n]*)", "i"));
    return m ? m[1].trim() : "";
  };
  // Captura TODAS as tags-folha de um bloco OFX (nada e descartado). O BB varia os
  // campos conforme o tipo de export (REFNUM, PAYEEID, EXTDNAME, CORRECTFITID,
  // SIC, CURRENCY...), entao guardamos o mapa inteiro em vez de uma lista fixa.
  const ofxAllTags = (block: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const re = /<([A-Za-z0-9._]+)>([^<\r\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const k = m[1].toUpperCase();
      const v = (m[2] || "").trim();
      if (v && out[k] === undefined) out[k] = v.slice(0, 300);
    }
    return out;
  };
  // Deriva do texto do lancamento o que o banco nao entrega em campo proprio:
  // contraparte (favorecido/pagador), CPF/CNPJ e data/hora. MESMA logica da tela.
  const derivarDetalhe = (memoRaw: any, nameRaw: any) => {
    const memo = String(memoRaw ?? "").trim();
    let tipo = String(nameRaw ?? "").trim();
    let resto = memo;
    if (!tipo && memo) {
      const cabe = (s: string) => /^[A-Z0-9ÀÁÂÃÉÊÍÓÔÕÚÇ .\/-]{3,45}$/.test(s);
      const a = memo.match(/^(.+?)\s+-\s+(\d{1,2}\/\d{1,2}\s.*)$/);
      const b = memo.match(/^(.+?)\s+-\s+(.+)$/);
      const m = a && cabe(a[1]) ? a : b && cabe(b[1]) ? b : null;
      if (m) { tipo = m[1].trim(); resto = m[2].trim(); }
    }
    let dia = "", hora = "";
    const dh = resto.match(/^(\d{1,2}\/\d{1,2})(?:\s+(\d{1,2}:\d{2}))?\s+/);
    if (dh) { dia = dh[1]; hora = dh[2] || ""; resto = resto.slice(dh[0].length).trim(); }
    let doc = "";
    const dm = resto.match(/(?<!\d)(\d{11}|\d{14})(?!\d)/);
    if (dm) { doc = dm[1]; resto = (resto.slice(0, dm.index) + " " + resto.slice((dm.index || 0) + dm[1].length)).trim(); }
    // o BB completa o CPF com zeros a esquerda ate 14 digitos ("00094172218172").
    if (doc.length === 14 && doc.startsWith("000")) doc = doc.slice(3);
    const contraparte = resto.replace(/\s{2,}/g, " ").replace(/^[-\s.]+|[-\s]+$/g, "").trim();
    return { contraparte, tipo, doc, dia, hora };
  };
  // ---- Linha de SALDO nao e lancamento -------------------------------------
  // O export "Extrato conta corrente" do BB traz DENTRO do <BANKTRANLIST> linhas
  // informativas de saldo ("Saldo do dia", "S A L D O", "SALDO ANTERIOR") como se
  // fossem transacao. Nao e dinheiro que se moveu: entrando como lancamento, ela
  // infla entradas/saidas e o saldo NUNCA fecha com o extrato do banco. Casamento
  // ESTRITO (texto inteiro), para nao pegar "SALDO DEVEDOR TARIFA" e afins.
  const RE_LINHA_SALDO = /^s\s*a\s*l\s*d\s*o( (do|de) dia( anterior)?| anterior| atual| final| inicial| em c c| disponivel| bloqueado)?$/;
  function ehLinhaDeSaldo(...textos: Array<string | null | undefined>) {
    return textos.some((t) => {
      const n = String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return !!n && RE_LINHA_SALDO.test(n);
    });
  }
  // mesma regra, sobre a descricao ja normalizada do banco (sem espacos)
  const ND_LINHA_SALDO = new Set([
    "saldo", "saldododia", "saldodedia", "saldododiaanterior", "saldoanterior",
    "saldoatual", "saldofinal", "saldoinicial", "saldoemcc", "saldodisponivel", "saldobloqueado",
  ]);

  // ---- Repasse de COBRANCA do BB: ja conciliado pelo webhook ---------------
  // FASE 3.4w. Credito que o banco lanca ao repassar a liquidacao dos BOLETOS da
  // carteira de cobranca. Esse dinheiro JA FOI baixado e conciliado titulo a titulo
  // pelo WEBHOOK de cobranca — nao existe titulo em aberto para casar com ele, e
  // ele so entulhava a fila de pendentes. Regra do Flavio (03/ago): entra como
  // IGNORADO automaticamente. Ignorado NAO sai do saldo (o dinheiro entrou de
  // verdade); apenas some dos pendentes.
  // Restrito a CREDITO: no debito, "Cobranca ..." e tarifa e tem titulo proprio.
  const RE_REPASSE_COBRANCA = /^(cobranca|cobrancas|cobranca simples|credito de cobranca|liquidacao de cobranca|cobranca referente\b.*|cobranca bb\b.*)$/;
  function ehRepasseCobranca(tipo: string, ...textos: Array<string | null | undefined>) {
    if (String(tipo || "").toUpperCase() !== "C") return false;
    return textos.some((t) => {
      const n = String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\uFFFD/g, "c")                    // "COBRAN?A": acento quebrado no OFX
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return !!n && RE_REPASSE_COBRANCA.test(n);
    });
  }
  // mesma regra sobre a descricao ja normalizada pelo banco de dados (sem espacos).
  // O '?' do acento quebrado some no regexp_replace, entao "cobranca" e "cobrana"
  // sao as duas formas possiveis.
  const ND_REPASSE_COBRANCA = /^(cobranc?as?|cobranc?asimples|creditodecobranc?a|liquidacaodecobranc?a|cobranc?areferente[0-9]*|cobranc?abb[0-9]*)$/;
  const NOTA_REPASSE = "Repasse de cobranca do BB (boletos ja baixados pelo webhook) - ignorado automaticamente";

  function parseOfx(text: string) {
    const acct = ofxTag(text, "ACCTID");
    const bankId = ofxTag(text, "BANKID");
    const branch = ofxTag(text, "BRANCHID");
    const acctType = ofxTag(text, "ACCTTYPE");
    const curdef = ofxTag(text, "CURDEF");
    const dtStart = ofxDate(ofxTag(text, "DTSTART"));
    const dtEnd = ofxDate(ofxTag(text, "DTEND"));
    // Saldo do extrato (LEDGERBAL) — informativo, entra no detalhe do lancamento.
    const ledgerBlk = (text.match(/<LEDGERBAL>[\s\S]*?(<\/LEDGERBAL>|<AVAILBAL>|$)/i) || [""])[0];
    const saldoFinal = ofxTag(ledgerBlk, "BALAMT");
    const saldoData = ofxDate(ofxTag(ledgerBlk, "DTASOF"));
    const txns: any[] = [];
    const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    let mm: RegExpExecArray | null;
    const chunks: string[] = [];
    while ((mm = re.exec(text))) chunks.push(mm[1]);
    if (!chunks.length && /<STMTTRN>/i.test(text)) {
      // OFX sem fechamento de </STMTTRN>: separa por marcador
      const parts = text.split(/<STMTTRN>/i).slice(1);
      for (const p of parts) chunks.push(p.split(/<\/BANKTRANLIST>|<LEDGERBAL>|<AVAILBAL>/i)[0]);
    }
    for (const blk of chunks) {
      const amt = ofxAmount(ofxTag(blk, "TRNAMT"));
      if (isNaN(amt)) continue;
      const date = ofxDate(ofxTag(blk, "DTPOSTED"));
      const memo = ofxTag(blk, "MEMO");
      const name = ofxTag(blk, "NAME");
      const fitid = ofxTag(blk, "FITID");
      const checknum = ofxTag(blk, "CHECKNUM");
      const trntype = ofxTag(blk, "TRNTYPE").toUpperCase();
      const type = amt >= 0 ? "C" : "D";
      // Guarda o lancamento INTEIRO (todas as tags do OFX) + o que foi derivado do
      // texto, para o painel "Detalhes" mostrar tudo o que veio do banco.
      const tags = ofxAllTags(blk);
      const der = derivarDetalhe(memo, name);
      txns.push({
        date, amount: Math.abs(amt), type,
        description: (memo || name || trntype || "").slice(0, 300),
        name: (name || "").slice(0, 200),
        document: (checknum || "").slice(0, 60),
        fitid: (fitid || "").slice(0, 120),
        originDocument: der.doc || null,
        raw: { origem: "ofx", tags, derivado: der, extrato: { acct, bankId, branch, acctType, curdef, saldoFinal, saldoData } },
      });
    }
    return { acct, bankId, dtStart, dtEnd, transactions: txns };
  }

  // ---- Ingestao compartilhada (OFX e API do BB) ---------------------------
  // Recebe transacoes ja normalizadas (mesmo formato do parseOfx) e faz:
  // cria o `bank_statements`, insere os lancamentos novos como 'pending' e os
  // ja existentes na MESMA conta como 'mirror' (espelho). NAO da baixa.
  type IngestTxn = {
    date: string; amount: number; type: string; description: string;
    name?: string | null; document?: string | null; fitid?: string | null;
    originDocument?: string | null; raw?: any;
  };
  async function ingestTransactions(o: {
    accountId: string; fileName: string; source: string;
    dtStart: string | null; dtEnd: string | null; bankAccount: string | null;
    instanceId: string | null; transactions: IngestTxn[]; by: string;
  }) {
    await ensureMirrorColumn();
    await ensureFitidColumn();
    await ensureRawColumn();
    // Linhas informativas de saldo NAO viram lancamento (ver ehLinhaDeSaldo).
    // Filtro aqui, no funil unico da ingestao, para valer p/ OFX e p/ API do BB.
    const linhasDeSaldo = o.transactions.filter((t) => ehLinhaDeSaldo(t.description, t.name)).length;
    if (linhasDeSaldo) o.transactions = o.transactions.filter((t) => !ehLinhaDeSaldo(t.description, t.name));
    const stCols = await tableColInfo("bank_statements");
    const itCols = await tableColInfo("bank_statement_items");
    let fitCol = ["fit_id", "fitid", "external_id", "transaction_id"].find((c) => itCols.has(c)) || null;
    // ensureFitidColumn() ja garantiu 'fitid'; se nenhuma coluna de FITID existia,
    // adota 'fitid' para que o dedup por FITID valha (evita cair so na chave composta).
    if (!fitCol) { itCols.set("fitid", { nullable: true, hasDefault: false, dtype: "text" } as any); fitCol = "fitid"; }

    // Dedup / espelho contra itens já existentes na MESMA conta.
    // Lancamento ja importado em OUTRO extrato NAO e descartado: entra como
    // "espelho" (mirrorOf -> id canonico), preservando a visao completa do arquivo.
    let skipped = 0;                 // duplicata dentro do MESMO lote (descartada)
    const toInsert: any[] = [];      // lancamentos novos (pending)
    const toMirror: Array<{ t: any; canonical: string }> = []; // ja existentes (espelho)
    // Mira por FITID quando houver; se o lancamento NAO tiver FITID (comum nos
    // extratos do BB), cai para a chave composta (data|valor|tipo|descricao) na
    // MESMA conta. Assim, reimportar um extrato sem FITID NAO recria o lancamento
    // como novo pendente -> evita a "conciliacao que volta a pendente" e a baixa
    // em duplicidade do titulo. A chave composta tambem faz o extrato vindo da
    // API do BB casar com o mesmo lancamento ja importado por OFX.
    const compKey = (dateStr: string, amount: number, type: string, desc: string) =>
      `${dateStr}|${amount.toFixed(2)}|${type}|${String(desc || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    // FASE 3.4s - 3a CHAVE: o CARIMBO DE DATA/HORA que o proprio banco escreve no
    // texto ("27/07 09:50"). Os DOIS formatos de export do BB descrevem a MESMA
    // transacao com textos diferentes ("PIX - ENVIADO - 27/07 09:50 CONSELHO..."
    // x "27/07 09:50 CONSELHO..."), entao a chave por descricao NAO os colapsa e
    // cada importacao recriava a linha como um NOVO pendente canonico -> duplicata
    // permanente no Livro da conta. Mesma conta + data + valor + tipo + MINUTO
    // EXATO = mesma transacao. E a mesma regra ja validada em producao pelo
    // endpoint de limpeza `relink-espelho`; aqui ela passa a valer na INGESTAO,
    // que e onde a duplicata nascia.
    const stampKey = (dateStr: string, amount: number, type: string, desc: string) => {
      const m = String(desc || "").match(/[0-9]{1,2}\/[0-9]{1,2} [0-9]{1,2}:[0-9]{2}/);
      return m ? `${dateStr}|${amount.toFixed(2)}|${type}|${m[0]}` : null;
    };
    // 4a CHAVE (FASE 3.4t): TEXTO CONTIDO no mesmo balde conta|data|valor|tipo.
    // Boleto/imposto/tarifa nao trazem carimbo de horario, e os dois formatos de
    // export do BB escrevem a mesma transacao com textos diferentes, um contido no
    // outro ("IMPOSTOS - DAS - SIMPLES NACIONAL" x "DAS - SIMPLES NACIONAL").
    const bucketKey = (dateStr: string, amount: number, type: string) => `${dateStr}|${amount.toFixed(2)}|${type}`;
    const norm = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const canonByFit: Record<string, string> = {};
    const canonByKey: Record<string, string> = {};
    const canonByStamp: Record<string, string> = {};
    const canonByBucket: Record<string, Array<{ nd: string; canonical: string }>> = {};
    {
      const er = await db.execute(sql`
        SELECT COALESCE(i.mirror_of, i.id) AS canonical, i.mirror_of AS mirror_of,
               to_char(i.transaction_date::date, 'YYYY-MM-DD') AS d,
               round(i.amount::numeric, 2)::text AS amt, i.type AS type,
               regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g') AS nd,
               substring(COALESCE(i.description, '') from '[0-9]{1,2}/[0-9]{1,2} [0-9]{1,2}:[0-9]{2}') AS stamp
               ${fitCol ? sql.raw(', i."' + fitCol + '" AS fit') : sql``}
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE s.financial_account_id = ${o.accountId}`);
      for (const x of rowsOf(er)) {
        const kk = `${x.d}|${x.amt}|${x.type}|${x.nd}`;
        if (!x.mirror_of) canonByKey[kk] = String(x.canonical);
        else if (!canonByKey[kk]) canonByKey[kk] = String(x.canonical);
        const st = (x as any).stamp;
        if (st) {
          const sk = `${x.d}|${x.amt}|${x.type}|${String(st)}`;
          if (!x.mirror_of) canonByStamp[sk] = String(x.canonical);
          else if (!canonByStamp[sk]) canonByStamp[sk] = String(x.canonical);
        }
        const fv = (x as any).fit;
        if (fv) { const f = String(fv); if (!x.mirror_of) canonByFit[f] = String(x.canonical); else if (!canonByFit[f]) canonByFit[f] = String(x.canonical); }
        if (!x.mirror_of && String(x.nd || "").length >= 8) {
          (canonByBucket[`${x.d}|${x.amt}|${x.type}`] ||= []).push({ nd: String(x.nd), canonical: String(x.canonical) });
        }
      }
    }
    {
      const seen = new Set<string>();
      const usados = new Set<string>();   // canonicos ja absorvidos por este lote
      for (const t of o.transactions) {
        const compK = compKey(t.date, t.amount, t.type, t.description);
        const dedK = t.fitid || compK;
        if (seen.has(dedK)) { skipped++; continue; }   // duplicata dentro do MESMO lote
        seen.add(dedK);
        const stK = stampKey(t.date, t.amount, t.type, t.description);
        let canonical: string | null = (t.fitid && canonByFit[t.fitid]) || canonByKey[compK]
          || (stK ? canonByStamp[stK] : null) || null;
        if (!canonical) {
          // texto contido, dentro do balde conta|data|valor|tipo; cada canonico so
          // pode absorver UM lancamento do lote (evita colapsar 2 cobrancas iguais).
          const nd = norm(t.description);
          if (nd.length >= 8) {
            const cand = (canonByBucket[bucketKey(t.date, t.amount, t.type)] || [])
              .find((c) => !usados.has(c.canonical) && (c.nd === nd || c.nd.includes(nd) || nd.includes(c.nd)));
            if (cand) { canonical = cand.canonical; usados.add(cand.canonical); }
          }
        }
        if (canonical) toMirror.push({ t, canonical });
        else toInsert.push(t);
      }
    }

    const totalC = o.transactions.filter((t) => t.type === "C").reduce((a, t) => a + t.amount, 0);
    const totalD = o.transactions.filter((t) => t.type === "D").reduce((a, t) => a + t.amount, 0);
    if (!toInsert.length && !toMirror.length) {
      return { statementId: null as string | null, inserted: 0, espelhados: 0, skipped, linhasDeSaldo, repassesCobranca: 0, totalC, totalD };
    }

    const stmt = await insertDynamic("bank_statements", stCols, {
      file_name: o.fileName,
      source: o.source,
      start_date: o.dtStart,
      end_date: o.dtEnd,
      financial_account_id: o.accountId,
      omie_instance_id: o.instanceId,
      total_credits: toInsert.filter((t) => t.type === "C").reduce((a, t) => a + t.amount, 0).toFixed(2),
      total_debits: toInsert.filter((t) => t.type === "D").reduce((a, t) => a + t.amount, 0).toFixed(2),
      item_count: toInsert.length + toMirror.length,
      reconciled_count: 0,
      bank_account: o.bankAccount || null,
      created_by: o.by,
    }, "id");
    const stmtId = stmt?.id;
    if (!stmtId) throw new Error("falha ao criar o extrato (sem id)");

    // IMPORTACAO READ-ONLY: todo lancamento novo entra como 'pending'. Nada e
    // ignorado, baixado ou conciliado automaticamente na importacao. O extrato e
    // apenas espelhado; qualquer baixa vem da conciliacao MANUAL de cada item, e
    // tarifas/PIX/COBRANCA sao tratados por acao explicita do operador (botoes).
    const linha = (t: any, extra: Record<string, any>) => {
      const vm: Record<string, any> = {
        statement_id: stmtId,
        transaction_date: t.date,
        amount: t.amount.toFixed(2),
        type: t.type,
        description: t.description,
        document: t.document,
        origin_name: t.name || null,
        created_by: o.by,
        ...extra,
      };
      // CPF/CNPJ da contraparte: vem da API do BB ou e extraido do texto do OFX.
      if (t.originDocument && itCols.has("origin_document")) vm.origin_document = t.originDocument;
      // lancamento bruto do banco (todas as tags) p/ o painel "Detalhes"
      if (t.raw && itCols.has("raw_ofx")) { try { vm.raw_ofx = JSON.stringify(t.raw).slice(0, 20000); } catch {} }
      if (fitCol) vm[fitCol] = t.fitid || null;
      return vm;
    };
    let inserted = 0;
    let repassesCobranca = 0;
    for (const t of toInsert) {
      // FASE 3.4w: repasse de cobranca do BB ja nasce IGNORADO (nao ha titulo a casar).
      const repasse = ehRepasseCobranca(t.type, t.description, t.name);
      if (repasse) repassesCobranca++;
      await insertDynamic("bank_statement_items", itCols, linha(t, repasse
        ? { reconciliation_status: "ignored", notes: NOTA_REPASSE }
        : { reconciliation_status: "pending" }));
      inserted++;
    }

    // FASE 3.4j - linhas ESPELHO: lancamentos ja importados em outro extrato.
    // Status/conciliacao sao resolvidos ao vivo pelo canonico (mirror_of). Nao
    // disparam baixa nem entram na visao consolidada de pendentes.
    let espelhados = 0, enriquecidos = 0;
    for (const { t, canonical } of toMirror) {
      await insertDynamic("bank_statement_items", itCols, linha(t, {
        reconciliation_status: "mirror",
        mirror_of: canonical,
        notes: "Espelho: lançamento já importado em outro extrato (mesma conta)",
      }));
      espelhados++;
      // Reimportar o MESMO extrato passa a ENRIQUECER o lancamento canonico com o
      // que ele ainda nao tinha (arquivo bruto do banco + CPF/CNPJ da contraparte).
      // So preenche o que esta VAZIO — nunca sobrescreve dado existente.
      try {
        const rawJson = t.raw ? JSON.stringify(t.raw).slice(0, 20000) : null;
        if (rawJson || t.originDocument) {
          const r: any = await db.execute(sql`
            UPDATE bank_statement_items
               SET raw_ofx = COALESCE(NULLIF(raw_ofx, ''), ${rawJson}),
                   origin_document = COALESCE(NULLIF(origin_document, ''), ${t.originDocument ?? null})
             WHERE id = ${canonical}
               AND (COALESCE(raw_ofx, '') = '' OR COALESCE(origin_document, '') = '')`);
          if (r?.rowCount) enriquecidos++;
        }
      } catch { /* enriquecimento e best-effort */ }
    }
    return { statementId: String(stmtId), inserted, espelhados, enriquecidos, skipped, linhasDeSaldo, repassesCobranca, totalC, totalD };
  }

  app.post("/api/reconciliation/import-ofx", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const ofxText = String(req.body?.ofxText || "");
      const accountId = (req.body?.accountId || "").toString();
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const fileName = (req.body?.fileName || "extrato.ofx").toString().slice(0, 200);
      if (!ofxText.trim()) return res.status(400).json({ error: "ofxText obrigatorio" });
      if (!accountId) return res.status(400).json({ error: "selecione a conta antes de importar" });

      const acc = rowsOf(await db.execute(sql`SELECT id, name, omie_instance_id FROM financial_accounts WHERE id = ${accountId} LIMIT 1`))[0];
      if (!acc) return res.status(404).json({ error: "conta financeira nao encontrada" });
      const instanceId = acc.omie_instance_id || null;

      const parsed = parseOfx(ofxText);
      if (!parsed.transactions.length) return res.status(400).json({ error: "nenhuma transacao (STMTTRN) encontrada no arquivo" });

      const r = await ingestTransactions({
        accountId, fileName, source: "ofx",
        dtStart: parsed.dtStart, dtEnd: parsed.dtEnd, bankAccount: parsed.acct || null,
        instanceId, transactions: parsed.transactions, by,
      });
      if (!r.statementId) return res.json({ ok: true, statementId: null, inserted: 0, skipped: r.skipped, espelhados: 0, message: "Nenhum lançamento no arquivo." });

      // Importacao READ-ONLY para baixas: tarifas do BB e COBRANCA/SALDO continuam sendo
      // conciliados/ignorados por ACAO EXPLICITA do operador (/conciliar-tarifas,
      // /ignore-cobranca). A importacao nao gera lancamento nem da baixa nova.
      // EXCECAO (Honest 23/jul): PIX-recebidos que o WEBHOOK ja baixou (cobranca CONCLUIDA
      // atrelada a um titulo) sao VINCULADOS automaticamente aqui — isto apenas reflete no
      // extrato a conciliacao que o webhook ja fez; NAO cria baixa nem esconde nada.
      let pixVinculados = 0;
      try { const pr = await conciliarPixWebhook(by, false); pixVinculados = pr.conciliados || 0; }
      catch (e: any) { console.warn("[import-ofx] auto-link PIX webhook falhou:", e?.message || e); }
      res.json({ ok: true, statementId: r.statementId, fileName, inserted: r.inserted, espelhados: r.espelhados, enriquecidos: r.enriquecidos, skipped: r.skipped, pixVinculados, totalCredits: r.totalC.toFixed(2), totalDebits: r.totalD.toFixed(2), period: { start: parsed.dtStart, end: parsed.dtEnd }, account: acc.name, instance: instanceId });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // ---- Importar via API de EXTRATOS do BB ---------------------------------
  // Mesma ingestao do OFX (dedup/espelho/pending), porem os dados vem direto do
  // banco e trazem o DETALHE do lancamento (contraparte, CPF/CNPJ, data/hora),
  // que o arquivo OFX so traz parcialmente.
  const contaExtrato = async (accountId: string) =>
    rowsOf(await db.execute(sql`
      SELECT id, name, omie_instance_id, agency, account_number,
             bb_extrato_client_id, bb_extrato_client_secret,
             bb_client_id, bb_client_secret, bb_dev_app_key
      FROM financial_accounts WHERE id = ${accountId} LIMIT 1`))[0];
  const periodoPadrao = (req: any) => {
    const hoje = new Date();
    const ate = String(req.query?.ate || req.body?.ate || "").slice(0, 10) || hoje.toISOString().slice(0, 10);
    const d0 = new Date(ate + "T00:00:00Z"); d0.setUTCDate(d0.getUTCDate() - 30);
    const de = String(req.query?.de || req.body?.de || "").slice(0, 10) || d0.toISOString().slice(0, 10);
    return { de, ate };
  };

  // Diagnostico (nao grava nada): diz se as credenciais existem, se o OAuth com o
  // scope extrato-info funciona e mostra uma amostra do que o BB devolveu.
  app.get("/api/reconciliation/bb-extrato/diag", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const accountId = (req.query.accountId as string) || "";
      if (!accountId) return res.status(400).json({ error: "accountId obrigatorio" });
      const acc = await contaExtrato(accountId);
      if (!acc) return res.status(404).json({ error: "conta financeira nao encontrada" });
      const { de, ate } = periodoPadrao(req);
      res.json(await diagnosticarExtrato(acc as any, de, ate));
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/reconciliation/import-bb-api", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const accountId = (req.body?.accountId || "").toString();
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const dryRun = req.body?.dryRun === true;
      if (!accountId) return res.status(400).json({ error: "selecione a conta antes de importar" });
      const acc = await contaExtrato(accountId);
      if (!acc) return res.status(404).json({ error: "conta financeira nao encontrada" });
      const { de, ate } = periodoPadrao(req);
      if (de > ate) return res.status(400).json({ error: "periodo invalido (data inicial maior que a final)" });

      const ex = await fetchExtrato(acc as any, de, ate);
      if (!ex.transactions.length) {
        return res.json({ ok: true, statementId: null, inserted: 0, espelhados: 0, skipped: 0, periodo: { de, ate }, message: "O BB nao retornou lancamentos nesse periodo." });
      }
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, periodo: { de, ate }, lancamentos: ex.transactions.length, totalRegistros: ex.totalRegistros, amostra: ex.transactions.slice(0, 10) });
      }
      const fileName = `BB API ${acc.name} ${de.split("-").reverse().join("/")} a ${ate.split("-").reverse().join("/")}`.slice(0, 200);
      const r = await ingestTransactions({
        accountId, fileName, source: "bb-api",
        dtStart: de, dtEnd: ate, bankAccount: `${ex.agencia}/${ex.conta}`,
        instanceId: acc.omie_instance_id || null, transactions: ex.transactions, by,
      });
      let pixVinculados = 0;
      try { const pr = await conciliarPixWebhook(by, false); pixVinculados = pr.conciliados || 0; }
      catch (e: any) { console.warn("[import-bb-api] auto-link PIX webhook falhou:", e?.message || e); }
      res.json({
        ok: true, statementId: r.statementId, fileName, inserted: r.inserted, espelhados: r.espelhados, enriquecidos: r.enriquecidos,
        skipped: r.skipped, pixVinculados, periodo: { de, ate }, paginas: ex.paginas,
        totalCredits: r.totalC.toFixed(2), totalDebits: r.totalD.toFixed(2),
        account: acc.name, instance: acc.omie_instance_id || null,
      });
    } catch (e: any) {
      const st = e?.response?.status;
      const det = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 600) : null;
      res.status(500).json({ error: String(e?.message || e), status: st || null, detalheBB: det });
    }
  });

  // ---- FASE 3.4f: tarifas bancarias do BB conciliadas automaticamente ------
  // Padroes (tolerantes a acentuacao quebrada): "TARIFA PIX ..." e
  // "DEBITO SERVICO COBRANCA ...". Para cada lancamento pendente de debito que
  // casar, cria a conta a pagar (fornecedor BANCO DO BRASIL SA, categoria
  // "Tarifas bancarias" - criada na DRE se nao existir), da baixa e concilia.
  const TARIFA_RE = /^\s*(tarifa\s+pix|d.{0,2}bito\s+servi.{0,2}o\s+cobran.{0,2}a)/i;

  async function ensureTarifaChartAccount(): Promise<string | null> {
    try {
      const ex = rowsOf(await db.execute(sql`
        SELECT id FROM chart_of_accounts
        WHERE code LIKE '%.%' AND lower(name) LIKE '%tarifa%banc%' LIMIT 1`))[0];
      if (ex) return ex.id;
      let parent = rowsOf(await db.execute(sql`
        SELECT id, code, dre_group, type FROM chart_of_accounts
        WHERE code NOT LIKE '%.%' AND dre_group = 'despesas_financeiras'
        ORDER BY code LIMIT 1`))[0];
      if (!parent) parent = rowsOf(await db.execute(sql`SELECT id, code, dre_group, type FROM chart_of_accounts WHERE code = '9' LIMIT 1`))[0];
      if (!parent) return null;
      let prox = 1;
      try {
        const mx = rowsOf(await db.execute(sql`
          SELECT COALESCE(MAX(NULLIF(regexp_replace(split_part(code, '.', 2), '[^0-9]', '', 'g'), '')::int), 0) AS n
          FROM chart_of_accounts WHERE code LIKE ${String(parent.code) + '.%'}`))[0];
        prox = Number(mx?.n || 0) + 1;
      } catch {}
      const novoCode = String(parent.code) + '.' + String(prox).padStart(2, '0');
      const ins = rowsOf(await db.execute(sql`
        INSERT INTO chart_of_accounts (id, code, name, type, dre_group, parent_id, is_active)
        VALUES (gen_random_uuid(), ${novoCode}, ${'Tarifas bancárias'}, ${String(parent.type || 'despesa')}::chart_of_account_type, ${parent.dre_group}, ${parent.id}, true)
        RETURNING id`))[0];
      return ins?.id || null;
    } catch (_e) { return null; }
  }

  async function conciliarTarifasBB(by: string, dryRun: boolean): Promise<{ candidatos: number; conciliados: number; erros: string[] }> {
    const out = { candidatos: 0, conciliados: 0, erros: [] as string[] };
    const items = rowsOf(await db.execute(sql`
      SELECT i.*, s.financial_account_id AS s_account, s.omie_instance_id AS s_instance
      FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
      WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending') AND i.type = 'D'
      ORDER BY i.transaction_date LIMIT 500`));
    const alvo = items.filter((i: any) => TARIFA_RE.test(String(i.description || "")));
    out.candidatos = alvo.length;
    if (dryRun || !alvo.length) return out;
    const chartId = await ensureTarifaChartAccount();
    if (!chartId) { out.erros.push("categoria Tarifas bancarias indisponivel"); return out; }
    const sup = await ensureSupplier("BANCO DO BRASIL SA", null, null, chartId, "Tarifas bancárias", by);
    for (const item of alvo) {
      try {
        const amount = Math.abs(Number(item.amount || 0));
        if (!(amount > 0)) continue;
        const dt = item.transaction_date ? new Date(item.transaction_date) : new Date();
        const paidAtISO = dt.toISOString();
        const pay: any = await storage.createPayable({
          supplierName: sup.name || "BANCO DO BRASIL SA",
          supplierDocument: sup.document || null,
          amount: amount.toFixed(2),
          issueDate: dt as any, dueDate: dt as any,
          description: String(item.description || "Tarifa bancaria BB").slice(0, 300),
          chartAccountId: chartId,
          omieInstanceId: item.s_instance || null,
          financialAccountId: item.s_account || null,
          status: "a_vencer", source: "manual",
          createdBy: by, notes: "Tarifa bancaria conciliada automaticamente (importacao OFX)",
        } as any);
        await settlePayable(pay.id, amount, "transferencia", item.s_account || null, paidAtISO, by);
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${item.id}, ${null}, ${pay.id}, ${amount.toFixed(2)}, ${"auto_tarifa"}, ${amount.toFixed(2)}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
        await db.execute(sql`
          UPDATE bank_statement_items
          SET reconciliation_status = 'reconciled', matched_payable_id = ${pay.id}, matched_at = now(), matched_by = ${by},
              match_confidence = 100, notes = 'Tarifa bancaria BB conciliada automaticamente'
          WHERE id = ${item.id}`);
        out.conciliados++;
      } catch (e: any) { out.erros.push(String(e?.message || e).slice(0, 120)); }
    }
    return out;
  }

  // Disparo manual (dryRun por padrao) - a importacao de OFX tambem roda isso.
  app.post("/api/reconciliation/conciliar-tarifas", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      res.json({ dryRun, ...(await conciliarTarifasBB(by, dryRun)) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- FASE 3.4q: PIX recebidos ja baixados via webhook BB -----------------
  // O pagamento de uma cobranca PIX (QR Code) e baixado automaticamente pelo
  // webhook do BB no titulo (receivable). O MESMO PIX reaparece no extrato OFX
  // como credito "PIX-RECEBIDO ..." e ficava pendente, correndo o risco de ser
  // conciliado ao titulo ERRADO (a sugestao por valor aproximado erra o cliente)
  // ou de gerar baixa em duplicidade. Aqui identificamos esses creditos e os
  // vinculamos ao titulo JA quitado, marcando-os como conciliados SEM nova baixa.
  // Chave de casamento: documento do pagador (CPF/CNPJ na descricao do extrato)
  // + valor, desempatado por instancia e data. So vincula se o titulo ja estiver
  // integralmente recebido (a baixa ja foi feita pelo webhook). Reversivel (undo).
  function extractPayerDoc(desc: string): string {
    const m = String(desc || "").match(/(?<!\d)(\d{14}|\d{11})(?!\d)/);
    return m ? m[1] : "";
  }

  async function conciliarPixWebhook(by: string, dryRun: boolean): Promise<any> {
    const out: any = { candidatos: 0, conciliados: 0, ambiguos: 0, semMatch: 0, erros: [] as string[], exemplos: [] as any[],
                       porChave: { documento: 0, horario: 0 }, porOrigem: { cobranca: 0, loja: 0 }, aBaixar: [] as any[] };
    // 1) Itens pendentes de credito "PIX-RECEBIDO" (QR Code ou chave).
    const items = rowsOf(await db.execute(sql`
      SELECT i.id, i.statement_id, i.transaction_date::date::text AS d, round(COALESCE(NULLIF(i.amount::text, '')::numeric, 0), 2)::text AS amt,
             i.description, i.document, i.origin_document, s.financial_account_id AS acc, s.omie_instance_id AS inst
      FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
      WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending')
        AND i.mirror_of IS NULL AND i.type = 'C'
        AND regexp_replace(lower(COALESCE(i.origin_name, '') || ' ' || COALESCE(i.description, '')), '[^a-z]', '', 'g') LIKE '%pixrecebido%'
      ORDER BY i.transaction_date LIMIT 5000`));
    out.candidatos = items.length;
    if (!items.length) return out;

    // 2) Cobrancas PIX PAGAS (webhook BB, status CONCLUIDA). O titulo vem de duas
    //    origens: (a) a propria cobranca (pc.receivable_id) — QR gerado a partir de
    //    um titulo, ja baixado pelo webhook; (b) PIX da LOJA (hotsite): a cobranca
    //    nasce SEM titulo, o pedido e criado depois do pagamento e o recebivel sai
    //    do faturamento — a ligacao e hotsite_pending_pix.charge_id/txid -> order_id
    //    (sales_card) -> billing_pipeline -> receivables.billing_pipeline_id.
    //    Sem (b), todo PIX pago na loja ficava pendente no extrato para sempre.
    const SQL_CHARGES = (comLoja: boolean) => sql`
      SELECT pc.id AS charge_id, pc.txid,
             round(COALESCE(NULLIF(pc.amount_paid::text, ''), NULLIF(pc.amount::text, ''), '0')::numeric, 2)::text AS amt,
             pc.paid_at::date::text AS d,
             to_char(pc.paid_at - interval '3 hours', 'MM-DD HH24:MI') AS hbrt,
             pc.omie_instance_id AS inst, pc.created_by,
             regexp_replace(COALESCE(pc.debtor_document, ''), '[^0-9]', '', 'g') AS cdoc,
             COALESCE(pc.receivable_id, r2.id) AS receivable_id,
             CASE WHEN pc.receivable_id IS NOT NULL THEN 'cobranca' ELSE 'loja' END AS origem,
             regexp_replace(COALESCE(COALESCE(r.customer_document, r2.customer_document), ''), '[^0-9]', '', 'g') AS rdoc,
             COALESCE(r.title_number, r2.title_number) AS nf,
             round(COALESCE(NULLIF(COALESCE(r.amount, r2.amount)::text, '')::numeric, 0), 2) AS ramt,
             round(COALESCE(NULLIF(COALESCE(r.amount_paid, r2.amount_paid)::text, '')::numeric, 0), 2) AS rpaid
      FROM pix_charges pc
      LEFT JOIN receivables r ON r.id = pc.receivable_id AND r.deleted_at IS NULL
      ${comLoja ? sql`
      LEFT JOIN hotsite_pending_pix hp ON hp.status = 'paid'
             AND (hp.charge_id = pc.id OR (pc.txid IS NOT NULL AND hp.txid = pc.txid))
      LEFT JOIN billing_pipeline bp ON bp.sales_card_id = hp.order_id
      LEFT JOIN receivables r2 ON r2.billing_pipeline_id = bp.id AND r2.deleted_at IS NULL` : sql`
      LEFT JOIN receivables r2 ON false`}
      WHERE pc.status = 'CONCLUIDA' AND pc.paid_at IS NOT NULL
        AND COALESCE(pc.receivable_id, r2.id) IS NOT NULL`;
    // A tabela da loja pode nao existir em bases antigas -> cai para o modo sem loja.
    let charges: any[] = [];
    try { charges = rowsOf(await db.execute(SQL_CHARGES(true))); }
    catch (e: any) {
      out.erros.push("hotsite_pending_pix indisponivel: " + String(e?.message || e).slice(0, 80));
      charges = rowsOf(await db.execute(SQL_CHARGES(false)));
    }

    // Indexa por valor|documento (pagador OU cliente do titulo) e por valor|horario.
    // O HORARIO e a chave mais forte: o extrato do BB traz "DD/MM HH:MM" no texto do
    // lancamento e o webhook grava paid_at (UTC) — batendo ao minuto. Resolve o caso
    // em que quem paga o QR NAO e o titular do titulo (CPF do pagador != CNPJ do cliente).
    const byDoc: Record<string, any[]> = {};
    const byHora: Record<string, any[]> = {};
    for (const c of charges) {
      const docs = new Set<string>();
      if (c.cdoc) docs.add(String(c.cdoc));
      if (c.rdoc) docs.add(String(c.rdoc));
      for (const dc of docs) (byDoc[`${c.amt}|${dc}`] ||= []).push(c);
      if (c.hbrt) (byHora[`${c.amt}|${c.hbrt}`] ||= []).push(c);
    }
    const docsDoItem = (it: any): string[] => {
      const set = new Set<string>();
      for (const raw of [extractPayerDoc(it.description), it.document, it.origin_document]) {
        let d = onlyDigits(raw);
        if (d.length === 14 && d.startsWith("000")) d = d.slice(3); // CPF com padding do BB
        if (d.length === 11 || d.length === 14) set.add(d);
      }
      return [...set];
    };
    // "19/07 18:27 ..." -> "07-19 18:27"
    const horaDoItem = (it: any): string => {
      const m = String(it.description || "").match(/(?<!\d)(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (!m) return "";
      const dd = m[1].padStart(2, "0"), mm = m[2].padStart(2, "0"), hh = m[3].padStart(2, "0");
      return `${mm}-${dd} ${hh}:${m[4]}`;
    };
    const diasEntre = (a: string, b: string) => {
      const ta = Date.parse(a + "T00:00:00Z"), tb = Date.parse(b + "T00:00:00Z");
      return isNaN(ta) || isNaN(tb) ? 99 : Math.abs(ta - tb) / 86400000;
    };

    // Uma MESMA cobranca pode corresponder a mais de uma LINHA do extrato quando o
    // mesmo lancamento veio em dois arquivos diferentes (formatos de export do BB com
    // textos distintos, que o dedup por descricao nao colapsa). Nesse caso as duas
    // linhas sao a mesma transacao e as duas devem ficar conciliadas — senao sobra
    // uma pendente eternamente. Reuso permitido apenas em EXTRATO diferente e quando
    // o casamento veio pelo horario (chave que identifica a transacao exata).
    const usados = new Map<string, Set<string>>();
    const usadoPor = (cid: string, stId: string, via: string) => {
      const st = usados.get(cid);
      if (!st) return false;
      if (via === "horario" && !st.has(String(stId))) return false;
      return true;
    };
    const marcarUsado = (cid: string, stId: string) => {
      const st = usados.get(cid) || new Set<string>();
      st.add(String(stId)); usados.set(cid, st);
    };
    const aplicar: Array<{ item: any; charge: any; via: string }> = [];
    for (const it of items) {
      const vistos = new Set<string>();
      const push = (arr: any[], via: string, acc: Array<{ c: any; via: string }>) => {
        for (const c of arr) {
          const cid = String(c.charge_id);
          if (usadoPor(cid, it.statement_id, via) || vistos.has(cid)) continue;
          if (diasEntre(it.d, c.d) > 3) continue;   // extrato lanca em D ou D+1
          vistos.add(cid); acc.push({ c, via });
        }
      };
      const acc: Array<{ c: any; via: string }> = [];
      const hora = horaDoItem(it);
      if (hora) push(byHora[`${it.amt}|${hora}`] || [], "horario", acc);       // chave forte primeiro
      for (const doc of docsDoItem(it)) push(byDoc[`${it.amt}|${doc}`] || [], "documento", acc);
      if (!acc.length) { out.semMatch++; continue; }
      let pool = acc;
      if (pool.length > 1) {
        const porHora = pool.filter((x) => x.via === "horario");
        if (porHora.length) pool = porHora;
        if (pool.length > 1) {
          const mesmaInst = pool.filter((x) => String(x.c.inst || "") === String(it.inst || ""));
          if (mesmaInst.length) pool = mesmaInst;
        }
        if (pool.length > 1) {
          const mesmaData = pool.filter((x) => x.c.d === it.d);
          if (mesmaData.length) pool = mesmaData;
        }
        // Varias cobrancas apontando pro MESMO titulo nao e ambiguidade.
        if (pool.length > 1 && new Set(pool.map((x) => String(x.c.receivable_id))).size > 1) { out.ambiguos++; continue; }
      }
      const { c, via } = pool[0];
      // PIX da LOJA: so vincula se o titulo ja estiver quitado (o recebivel de pedido
      // pago na loja nasce baixado). Se estiver em aberto, NAO concilia — reporta para
      // conferencia, para nunca marcar como conciliado um titulo que nao recebeu baixa.
      if (c.origem === "loja" && !(Number(c.ramt) > 0 && Number(c.rpaid) >= Number(c.ramt) - 0.005)) {
        out.aBaixar.push({ data: it.d, valor: it.amt, nf: c.nf || null, receivableId: c.receivable_id, txid: c.txid || null });
        out.semMatch++;
        continue;
      }
      marcarUsado(String(c.charge_id), it.statement_id);
      aplicar.push({ item: it, charge: c, via });
    }
    for (const a of aplicar) { out.porChave[a.via === "horario" ? "horario" : "documento"]++; out.porOrigem[a.charge.origem === "loja" ? "loja" : "cobranca"]++; }
    out.exemplos = aplicar.slice(0, 10).map(({ item, charge, via }) => ({ data: item.d, valor: item.amt, nf: charge.nf || null, via, origem: charge.origem }));
    if (dryRun) { out.conciliados = aplicar.length; return out; }
    for (const { item, charge, via } of aplicar) {
      try {
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${item.id}, ${charge.receivable_id}, ${null}, ${item.amt}, ${"pix_webhook"}, ${"0.00"}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
        const nota = charge.origem === "loja"
          ? "PIX pago na LOJA (hotsite) - titulo ja baixado no faturamento - vinculado automaticamente ao " + String(charge.nf || "titulo")
          : "PIX ja baixado via webhook BB - vinculado automaticamente ao titulo " + String(charge.nf || "");
        const upd: any = await db.execute(sql`
          UPDATE bank_statement_items
          SET reconciliation_status = 'reconciled', matched_receivable_id = ${charge.receivable_id}, matched_at = now(), matched_by = ${by},
              match_confidence = 100, notes = ${nota + " (casado por " + via + ")"}
          WHERE id = ${item.id} AND (reconciliation_status IS NULL OR reconciliation_status = 'pending')`);
        if (Number((upd as any)?.rowCount ?? 1) > 0) out.conciliados++;
      } catch (e: any) { out.erros.push(String(e?.message || e).slice(0, 120)); }
    }
    return out;
  }

  app.post("/api/reconciliation/conciliar-pix-webhook", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      res.json({ dryRun, ...(await conciliarPixWebhook(by, dryRun)) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- FASE 3.4g: remove duplicatas de importacoes repetidas dos pendentes -
  // Mesmo lancamento (conta+data+valor+tipo+descricao+documento) importado em
  // mais de um extrato (arquivos cumulativos importados antes da deduplicacao
  // por FITID). Mantem as ocorrencias de UM extrato (maior contagem; empate ->
  // mais recente) e marca as copias dos demais como ignoradas (reversivel).
  app.post("/api/reconciliation/dedup-pendentes", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      await ensureMirrorColumn();
      const rows = rowsOf(await db.execute(sql`
        SELECT i.id, i.statement_id, i.transaction_date::date::text AS d, round(i.amount::numeric, 2)::text AS v, i.type,
               regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g') AS nd,
               COALESCE(i.document, '') AS doc, s.financial_account_id AS acc, s.created_at AS s_created
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending') AND i.mirror_of IS NULL`));
      const groups: Record<string, any[]> = {};
      for (const r of rows) {
        // Chave por identidade ECONOMICA (conta|data|valor|tipo|descricao normalizada).
        // NAO inclui o document/FITID: a mesma transacao vem com refs diferentes entre
        // importacoes, e incluir o doc quebrava os grupos e deixava duplicatas passarem.
        const k = [r.acc || '', r.d, r.v, r.type, r.nd].join('|');
        (groups[k] ||= []).push(r);
      }
      const ignorar: string[] = [];
      for (const g of Object.values(groups)) {
        const porExtrato: Record<string, any[]> = {};
        for (const x of g) (porExtrato[x.statement_id] ||= []).push(x);
        const stmts = Object.keys(porExtrato);
        if (stmts.length < 2) continue; // duplicatas dentro do MESMO extrato podem ser legitimas
        let melhor = stmts[0];
        for (const sid of stmts) {
          const a = porExtrato[sid], b = porExtrato[melhor];
          if (a.length > b.length || (a.length === b.length && String(a[0].s_created) > String(b[0].s_created))) melhor = sid;
        }
        for (const sid of stmts) { if (sid !== melhor) { for (const x of porExtrato[sid]) ignorar.push(x.id); } }
      }
      let atualizados = 0;
      if (!dryRun && ignorar.length) {
        for (let i = 0; i < ignorar.length; i += 200) {
          const lote = ignorar.slice(i, i + 200);
          const u: any = await db.execute(sql`
            UPDATE bank_statement_items
            SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(),
                notes = 'Duplicata de importacao repetida - mantida a ocorrencia de um unico extrato'
            WHERE id IN (${inList(lote)}) AND (reconciliation_status IS NULL OR reconciliation_status = 'pending')`);
          atualizados += Number((u as any)?.rowCount ?? 0);
        }
      }
      res.json({ dryRun, candidatos: ignorar.length, atualizados });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // FASE 3.4p - LIMPEZA: vincula como ESPELHO as copias pendentes cuja MESMA
  // transacao economica (conta|data|valor|tipo|descricao normalizada) ja esta
  // CONCILIADA em outra linha/extrato. NAO apaga nada: apenas aponta mirror_of ->
  // canonico conciliado e marca status 'mirror'. Assim a copia some dos pendentes
  // e passa a aparecer como "ja conciliado" tambem no extrato individual.
  // dryRun por padrao (so conta). Idempotente e reversivel.
  app.post("/api/reconciliation/relink-espelho", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      await ensureMirrorColumn();
      // Casa cada PENDENTE (nao-espelho) com o GEMEO ja CONCILIADO da mesma conta.
      // Feito com CTE + JOIN (hash join) em vez de subconsulta correlacionada: com
      // ~12k lancamentos a versao correlacionada com regex ficava O(n^2) e estourava
      // o tempo da requisicao.
      const CAND = sql`
        WITH base AS (
          SELECT i.id,
                 s.financial_account_id AS acc,
                 i.transaction_date::date AS d,
                 round(i.amount::numeric, 2) AS amt,
                 i.type,
                 regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g') AS nd,
                 substring(COALESCE(i.description, '') from '[0-9]{1,2}/[0-9]{1,2} [0-9]{1,2}:[0-9]{2}') AS ts,
                 COALESCE(i.reconciliation_status, 'pending') AS st,
                 i.mirror_of, i.matched_at
          FROM bank_statement_items i
          JOIN bank_statements s ON s.id = i.statement_id
        ),
        conc AS (SELECT * FROM base WHERE st = 'reconciled' AND mirror_of IS NULL),
        pend AS (SELECT * FROM base WHERE st = 'pending' AND mirror_of IS NULL)
        SELECT DISTINCT ON (p.id) p.id AS pending_id, c.id AS canonical_id
        FROM pend p
        JOIN conc c
          ON c.acc = p.acc AND c.d = p.d AND c.amt = p.amt AND c.type = p.type AND c.id <> p.id
         AND (
              -- (a) mesmo texto (dedup classico)
              c.nd = p.nd
              -- (b) MESMO CARIMBO DE DATA/HORA no texto ("17/07 17:17"). Os dois formatos
              -- de export do BB escrevem o lancamento com textos diferentes
              -- ("PIX - ENVIADO - 17/07 17:17 VOLUS" x "17/07 17:17 VOLUS"), entao o dedup
              -- por texto nao os colapsava e sobrava uma linha pendente para sempre.
              -- Mesma conta + data + valor + tipo + minuto exato = mesma transacao.
              OR (p.ts IS NOT NULL AND c.ts = p.ts)
             )
        ORDER BY p.id, c.matched_at ASC NULLS LAST, c.id ASC`;
      if (dryRun) {
        const c = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM (${CAND}) q`))[0];
        return res.json({ dryRun, candidatos: Number(c?.n || 0), atualizados: 0 });
      }
      // Aplicacao em UM unico UPDATE em conjunto (rapido e atomico; sem loop/timeout).
      const u = rowsOf(await db.execute(sql`
        UPDATE bank_statement_items t
        SET mirror_of = q.canonical_id, reconciliation_status = 'mirror',
            matched_by = ${by}, matched_at = now(),
            notes = 'Espelho (limpeza 3.4p): lançamento já conciliado em outro extrato da mesma conta'
        FROM (${CAND}) q
        WHERE t.id = q.pending_id
          AND q.canonical_id IS NOT NULL
          AND (t.reconciliation_status IS NULL OR t.reconciliation_status = 'pending')
          AND t.mirror_of IS NULL
        RETURNING t.id`));
      const atualizados = u.length;
      res.json({ dryRun, candidatos: atualizados, atualizados });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Deduplicacao de CANONICOS legados (limpeza) -------------------------
  // Duplicatas ANTIGAS: a MESMA transacao economica (conta|data|valor|tipo|descricao
  // normalizada) existe em MAIS DE UMA linha canonica (mirror_of IS NULL) - restos de
  // importacoes cumulativas feitas antes do recurso de espelho. Colapsa cada grupo em
  // UMA linha canonica (preferindo a conciliada; senao a de menor id) e transforma as
  // demais em espelho (mirror_of -> canonica).
  //
  // FASE 3.4s - DUAS mudancas, porque a versao anterior nunca conseguia colapsar nada:
  //  (1) GRUPO tambem pelo CARIMBO DE DATA/HORA do texto ("27/07 09:50"), unindo os
  //      dois formatos de export do BB ("PIX - ENVIADO - 27/07 09:50 X" x "27/07 09:50 X").
  //  (2) A trava deixou de olhar o FLAG `reconciliation_status = 'reconciled'` e passou
  //      a olhar a BAIXA DE VERDADE (existencia de linha em bank_statement_item_matches).
  //      Motivo: as duplicatas legadas foram marcadas 'reconciled' em lote SEM match,
  //      entao todo grupo tinha >1 "conciliada" e a limpeza recusava 100% dos grupos
  //      (783 de 783). Baixa dupla de verdade so existe quando 2+ linhas do grupo tem
  //      match; esses grupos continuam INTOCADOS e sao devolvidos em `gruposComBaixaDupla`
  //      para conferencia manual.
  // A linha mantida e a que TEM match; sem match, a conciliada; senao a de menor id.
  // dryRun por padrao. Reversivel (basta limpar mirror_of).
  app.post("/api/reconciliation/dedup-canonical", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const accountId = (req.body?.accountId as string) || null;
      // porHorario=false volta ao comportamento antigo (so chave por descricao)
      const porHorario = req.body?.porHorario !== false;
      // porTexto=false desliga a 3a regra (texto contido — ver abaixo)
      const porTexto = req.body?.porTexto !== false;
      await ensureMirrorColumn();
      let rows = rowsOf(await db.execute(sql`
        SELECT i.id, s.financial_account_id AS acc,
               to_char(i.transaction_date::date, 'YYYY-MM-DD') AS d,
               round(i.amount::numeric, 2)::text AS amt, i.type AS type,
               regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g') AS nd,
               substring(COALESCE(i.description, '') from '[0-9]{1,2}/[0-9]{1,2} [0-9]{1,2}:[0-9]{2}') AS stamp,
               i.reconciliation_status AS st,
               (EXISTS (SELECT 1 FROM bank_statement_item_matches m
                         WHERE m.bank_statement_item_id = i.id)) AS tem_baixa
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.mirror_of IS NULL
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})`));

      // LINHAS DE SALDO: nao sao transacao (ver ehLinhaDeSaldo). Saem do agrupamento e
      // sao marcadas com status 'saldo' — deixam de contar no saldo, no livro e no
      // relatorio. Nao apaga nada: e so um UPDATE de status, reversivel.
      // FASE 3.4w: repasses de COBRANCA do BB (credito de boleto ja baixado pelo
      // webhook) que ainda estao PENDENTES viram IGNORADO. Nao mexe no saldo.
      const idsRepasse = rows.filter((r: any) => String(r.type) === "C"
          && ND_REPASSE_COBRANCA.test(String(r.nd || ""))
          && (r.st == null || r.st === "pending") && r.tem_baixa !== true)
        .map((r: any) => String(r.id));

      const idsSaldo = rows.filter((r: any) => ND_LINHA_SALDO.has(String(r.nd || "")) && r.tem_baixa !== true)
                           .map((r: any) => String(r.id));
      rows = rows.filter((r: any) => !ND_LINHA_SALDO.has(String(r.nd || "")));

      // Union-find: a MESMA linha pode entrar no grupo pela descricao E pelo horario.
      // Assim os dois criterios formam UM unico grupo por transacao economica.
      const parent: Record<string, string> = {};
      const find = (a: string): string => { while (parent[a] && parent[a] !== a) { parent[a] = parent[parent[a]] || parent[a]; a = parent[a]; } return a; };
      const union = (a: string, b: string) => { parent[a] ||= a; parent[b] ||= b; const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
      const firstByKey: Record<string, string> = {};
      for (const r of rows) {
        const id = String(r.id);
        parent[id] ||= id;
        const keys = [["d", r.acc || "", r.d, r.amt, r.type, r.nd].join("|")];
        if (porHorario && r.stamp) keys.push(["h", r.acc || "", r.d, r.amt, r.type, String(r.stamp)].join("|"));
        for (const k of keys) { if (firstByKey[k]) union(firstByKey[k], id); else firstByKey[k] = id; }
      }
      // FASE 3.4t - 3a REGRA: TEXTO CONTIDO. Os lancamentos SEM carimbo de horario
      // (boleto, imposto, tarifa) escapavam das duas regras acima, porque os dois
      // formatos de export do BB escrevem a MESMA transacao assim:
      //   "IMPOSTOS - DAS - SIMPLES NACIONAL"    x  "DAS - SIMPLES NACIONAL"
      //   "PAGAMENTO DE BOLETO - PROSPER FOMENTO" x "PROSPER FOMENTO"
      // Um texto e parte do outro. Dentro do MESMO balde (conta|data|valor|tipo) —
      // ja restritissimo — texto contido = mesma transacao.
      // Trava: minimo de 8 caracteres no texto menor, p/ "pix"/"ted" nao casarem.
      if (porTexto) {
        const baldes: Record<string, any[]> = {};
        for (const r of rows) (baldes[[r.acc || "", r.d, r.amt, r.type].join("|")] ||= []).push(r);
        for (const b of Object.values(baldes)) {
          if (b.length < 2) continue;
          for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
            const a = String(b[i].nd || ""), c = String(b[j].nd || "");
            if (a.length < 8 || c.length < 8) continue;
            if (a === c || a.includes(c) || c.includes(a)) union(String(b[i].id), String(b[j].id));
          }
        }
      }
      const groups: Record<string, any[]> = {};
      for (const r of rows) (groups[find(String(r.id))] ||= []).push(r);

      const toMirror: Array<{ id: string; canonical: string }> = [];
      let gruposDup = 0, comBaixaDupla = 0;
      const gruposComBaixaDupla: any[] = [];
      for (const g of Object.values(groups)) {
        if (g.length < 2) continue;
        gruposDup++;
        const comBaixa = g.filter((x) => x.tem_baixa === true);
        if (comBaixa.length > 1) { // NAO colapsa: possivel baixa dupla de verdade
          comBaixaDupla++;
          if (gruposComBaixaDupla.length < 100) gruposComBaixaDupla.push({
            conta: g[0].acc, data: g[0].d, valor: g[0].amt, tipo: g[0].type,
            linhas: g.length, comBaixa: comBaixa.length,
            ids: comBaixa.map((x: any) => String(x.id)).slice(0, 10),
          });
          continue;
        }
        // Preferencia da linha que SOBREVIVE: (1) a que tem baixa de verdade;
        // (2) senao, uma CONCILIADA (para o status exibido do grupo nao regredir
        // de "Conciliado" para "Pendente"); (3) senao, a de menor id.
        const menorId = (arr: any[]) => arr.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))[0];
        const reconc = g.filter((x) => x.st === "reconciled");
        const ignor = g.filter((x) => x.st === "ignored");
        const keep = comBaixa[0] || (reconc.length ? menorId(reconc) : (ignor.length ? menorId(ignor) : menorId(g)));
        for (const x of g) { if (String(x.id) !== String(keep.id)) toMirror.push({ id: String(x.id), canonical: String(keep.id) }); }
      }
      if (dryRun) return res.json({ repassesCobranca: idsRepasse.length, dryRun: true, porHorario, porTexto, gruposDuplicados: gruposDup, linhasParaEspelhar: toMirror.length, linhasDeSaldo: idsSaldo.length, gruposComBaixaDupla: comBaixaDupla, amostraBaixaDupla: gruposComBaixaDupla });
      let espelhados = 0;
      for (let i = 0; i < toMirror.length; i += 300) {
        const lote = toMirror.slice(i, i + 300);
        const vals = lote.map((m) => sql`(${m.id}, ${m.canonical})`);
        const u: any = await db.execute(sql`
          UPDATE bank_statement_items t
          SET mirror_of = v.canon, reconciliation_status = 'mirror', matched_by = ${by}, matched_at = now(),
              notes = 'Duplicata legada colapsada (dedup-canonical) - reversivel'
          FROM (VALUES ${sql.join(vals, sql`, `)}) AS v(id, canon)
          WHERE t.id::text = v.id AND t.mirror_of IS NULL
            AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = t.id)`);
        espelhados += Number((u as any)?.rowCount ?? 0);
      }
      // linhas informativas de saldo -> status 'saldo' (somem do livro/saldo/relatorio)
      let saldoMarcadas = 0;
      for (let i = 0; i < idsSaldo.length; i += 500) {
        const lote = idsSaldo.slice(i, i + 500);
        const u: any = await db.execute(sql`
          UPDATE bank_statement_items t
          SET reconciliation_status = 'saldo', matched_by = ${by}, matched_at = now(),
              notes = 'Linha informativa de saldo do extrato - nao e lancamento (reversivel)'
          WHERE t.id::text IN (${inList(lote)}) AND t.mirror_of IS NULL
            AND COALESCE(t.reconciliation_status, 'pending') <> 'saldo'
            AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = t.id)`);
        saldoMarcadas += Number((u as any)?.rowCount ?? 0);
      }
      // repasses de cobranca pendentes -> ignorado (some da fila, fica no saldo)
      let repassesIgnorados = 0;
      for (let i = 0; i < idsRepasse.length; i += 500) {
        const lote = idsRepasse.slice(i, i + 500);
        const u: any = await db.execute(sql`
          UPDATE bank_statement_items t
          SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(),
              notes = ${NOTA_REPASSE}
          WHERE t.id::text IN (${inList(lote)}) AND t.mirror_of IS NULL
            AND (t.reconciliation_status IS NULL OR t.reconciliation_status = 'pending')
            AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = t.id)`);
        repassesIgnorados += Number((u as any)?.rowCount ?? 0);
      }
      res.json({ repassesCobranca: repassesIgnorados, dryRun: false, porHorario, porTexto, gruposDuplicados: gruposDup, gruposComBaixaDupla: comBaixaDupla, amostraBaixaDupla: gruposComBaixaDupla, espelhados, linhasDeSaldo: saldoMarcadas });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- BAIXA DUPLA: desconciliar as sobras e deixar UM lancamento -----------
  // FASE 3.4s. Alvo: os grupos que o `dedup-canonical` RECUSA colapsar porque tem
  // 2+ linhas com BAIXA DE VERDADE (linha em bank_statement_item_matches) — a mesma
  // transacao do banco conciliada duas ou mais vezes.
  //
  // Regra (definida pelo Flavio em 28/jul):
  //  * TODAS as baixas do grupo caem no MESMO titulo  -> e baixa duplicada do mesmo
  //    titulo. MANTEM a conciliacao mais ANTIGA e DESFAZ as demais (o `amount_paid`
  //    do titulo volta ao valor correto). Nada a refazer.
  //  * As baixas caem em TITULOS DIFERENTES -> o sistema NAO tem como saber qual esta
  //    certa. DESFAZ TODAS; o lancamento fica unico e 'pending' para conciliacao
  //    manual contra o titulo certo.
  // Depois de desfazer, o grupo e COLAPSADO em uma unica linha canonica (as demais
  // viram espelho), atendendo "manter um unico lancamento".
  //
  // Usa a MESMA `undoReconciliation` da tela (reverte amount_paid, recalcula o status
  // do titulo, apaga o pagamento e o match, e grava auditoria action='undo').
  // ⚠️ Desfazer baixa REABRE o titulo — pode voltar a bloquear pedido por debito
  // vencido e entrar no alerta de WhatsApp. A resposta lista todos os titulos tocados.
  // dryRun por padrao.
  app.post("/api/reconciliation/fix-baixa-dupla", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const accountId = (req.body?.accountId as string) || null;
      const colapsar = req.body?.colapsar !== false;
      const porHorario = req.body?.porHorario !== false;
      await ensureMirrorColumn();
      const rows = rowsOf(await db.execute(sql`
        SELECT i.id, s.financial_account_id AS acc, fa.name AS conta,
               to_char(i.transaction_date::date, 'YYYY-MM-DD') AS d,
               round(i.amount::numeric, 2)::text AS amt, i.type AS type,
               regexp_replace(lower(COALESCE(i.description, '')), '[^a-z0-9]', '', 'g') AS nd,
               substring(COALESCE(i.description, '') from '[0-9]{1,2}/[0-9]{1,2} [0-9]{1,2}:[0-9]{2}') AS stamp,
               i.description, i.reconciliation_status AS st, i.matched_at, s.file_name,
               (SELECT count(*) FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = i.id)::int AS n_match,
               COALESCE((SELECT string_agg(DISTINCT COALESCE('r:' || m.receivable_id, 'p:' || m.payable_id), ',')
                           FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = i.id), '') AS titulo_keys,
               COALESCE((SELECT string_agg(DISTINCT COALESCE(r.title_number, p.title_number, '?'), ' / ')
                           FROM bank_statement_item_matches m
                           LEFT JOIN receivables r ON r.id = m.receivable_id
                           LEFT JOIN payables p ON p.id = m.payable_id
                          WHERE m.bank_statement_item_id = i.id), '') AS titulo,
               COALESCE((SELECT string_agg(DISTINCT COALESCE(r.customer_name, p.supplier_name, ''), ' / ')
                           FROM bank_statement_item_matches m
                           LEFT JOIN receivables r ON r.id = m.receivable_id
                           LEFT JOIN payables p ON p.id = m.payable_id
                          WHERE m.bank_statement_item_id = i.id), '') AS parte
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE i.mirror_of IS NULL
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})`));

      // Mesmo agrupamento do dedup-canonical: descricao normalizada UNIAO carimbo.
      const parent: Record<string, string> = {};
      const find = (a: string): string => { while (parent[a] && parent[a] !== a) { parent[a] = parent[parent[a]] || parent[a]; a = parent[a]; } return a; };
      const union = (a: string, b: string) => { parent[a] ||= a; parent[b] ||= b; const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
      const firstByKey: Record<string, string> = {};
      for (const r of rows) {
        const id = String(r.id); parent[id] ||= id;
        const keys = [["d", r.acc || "", r.d, r.amt, r.type, r.nd].join("|")];
        if (porHorario && r.stamp) keys.push(["h", r.acc || "", r.d, r.amt, r.type, String(r.stamp)].join("|"));
        for (const k of keys) { if (firstByKey[k]) union(firstByKey[k], id); else firstByKey[k] = id; }
      }
      const groups: Record<string, any[]> = {};
      for (const r of rows) (groups[find(String(r.id))] ||= []).push(r);

      const ordena = (arr: any[]) => arr.slice().sort((a, b) => {
        const ta = a.matched_at ? new Date(a.matched_at).getTime() : Number.MAX_SAFE_INTEGER;
        const tb = b.matched_at ? new Date(b.matched_at).getTime() : Number.MAX_SAFE_INTEGER;
        return ta !== tb ? ta - tb : (String(a.id) < String(b.id) ? -1 : 1);
      });

      const plano: any[] = [];
      for (const g of Object.values(groups)) {
        const comBaixa = g.filter((x) => Number(x.n_match) > 0);
        if (comBaixa.length < 2) continue;
        const titulos = new Set<string>();
        for (const x of comBaixa) for (const t of String(x.titulo_keys || "").split(",")) if (t) titulos.add(t);
        const mesmoTitulo = titulos.size === 1;
        const ord = ordena(comBaixa);
        const manter = mesmoTitulo ? ord[0] : null;              // titulos diferentes: desfaz TODAS
        const desfazer = mesmoTitulo ? ord.slice(1) : ord;
        plano.push({
          conta: g[0].conta || g[0].acc, data: g[0].d, valor: g[0].amt, tipo: g[0].type,
          descricao: String(g[0].description || "").slice(0, 120),
          linhasNoGrupo: g.length, linhasComBaixa: comBaixa.length,
          mesmoTitulo, titulos: [...titulos].length,
          mantida: manter ? { id: String(manter.id), titulo: manter.titulo, parte: manter.parte, arquivo: manter.file_name } : null,
          desfeitas: desfazer.map((x: any) => ({ id: String(x.id), titulo: x.titulo, parte: x.parte, arquivo: x.file_name, matches: Number(x.n_match) })),
          _grupo: g.map((x: any) => String(x.id)), _manterId: manter ? String(manter.id) : null,
        });
      }

      const resumo = {
        gruposComBaixaDupla: plano.length,
        gruposMesmoTitulo: plano.filter((p) => p.mesmoTitulo).length,
        gruposTitulosDiferentes: plano.filter((p) => !p.mesmoTitulo).length,
        conciliacoesADesfazer: plano.reduce((a, p) => a + p.desfeitas.length, 0),
      };
      if (dryRun) return res.json({ dryRun: true, ...resumo, plano: plano.map(({ _grupo, _manterId, ...p }) => p) });

      let desfeitas = 0, falhas: any[] = [], titulosTocados: any[] = [], espelhados = 0;
      for (const p of plano) {
        for (const d of p.desfeitas) {
          const r = await undoReconciliation(d.id, by);
          if (r.ok) { desfeitas++; if (Array.isArray(r.reverted)) for (const rv of r.reverted) titulosTocados.push({ data: p.data, valor: p.valor, titulo: d.titulo, parte: d.parte, ...rv }); }
          else falhas.push({ id: d.id, erro: r.error });
        }
        if (!colapsar) continue;
        // Colapsa o grupo em UMA linha: mantem a que ficou com baixa (ou a de menor id)
        // e transforma as demais em espelho. Nunca espelha linha que ainda tem match.
        const keep = p._manterId || p._grupo.slice().sort()[0];
        const outros = p._grupo.filter((x: string) => x !== keep);
        for (let i = 0; i < outros.length; i += 300) {
          const lote = outros.slice(i, i + 300);
          const u: any = await db.execute(sql`
            UPDATE bank_statement_items t
            SET mirror_of = ${keep}, reconciliation_status = 'mirror', matched_by = ${by}, matched_at = now(),
                notes = 'Baixa dupla corrigida (fix-baixa-dupla) - linha colapsada, reversivel'
            WHERE t.id::text IN (${inList(lote)}) AND t.mirror_of IS NULL
              AND NOT EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.bank_statement_item_id = t.id)`);
          espelhados += Number((u as any)?.rowCount ?? 0);
        }
      }
      res.json({ dryRun: false, ...resumo, desfeitas, espelhados, falhas, titulosTocados });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // FASE 3.4c - marca como ignorados os creditos "COBRANCA" pendentes (repasses
  // de boletos ja baixados via webhook). dryRun por padrao.
  app.post("/api/reconciliation/ignore-cobranca", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const c = rowsOf(await db.execute(sql`
        SELECT count(*)::int AS n FROM bank_statement_items
        WHERE (reconciliation_status IS NULL OR reconciliation_status = 'pending')
          AND ((type = 'C' AND regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('cobranca', 'cobrana', 'cobranaa'))
               OR regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('saldododia', 'saldoanterior'))`))[0];
      const candidatos = Number(c?.n || 0);
      let atualizados = 0;
      if (!dryRun && candidatos > 0) {
        const u: any = await db.execute(sql`
          UPDATE bank_statement_items
          SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(),
              notes = 'Ignorado automaticamente (COBRANCA / SALDO DO DIA / SALDO ANTERIOR)'
          WHERE (reconciliation_status IS NULL OR reconciliation_status = 'pending')
            AND ((type = 'C' AND regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('cobranca', 'cobrana', 'cobranaa'))
                 OR regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('saldododia', 'saldoanterior'))`);
        atualizados = Number((u as any)?.rowCount ?? 0);
      }
      res.json({ dryRun, candidatos, atualizados });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Remover extrato importado (trava: recusa se houver item conciliado) -
  app.post("/api/reconciliation/statements/:id/delete", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const st = rowsOf(await db.execute(sql`SELECT id, file_name FROM bank_statements WHERE id = ${id}`))[0];
      if (!st) return res.status(404).json({ error: "extrato nao encontrado" });
      const rec = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM bank_statement_items WHERE statement_id = ${id} AND reconciliation_status = 'reconciled'`))[0];
      if (Number(rec?.n || 0) > 0) return res.status(409).json({ error: `extrato tem ${rec.n} item(ns) conciliado(s); desfaca as conciliacoes antes de remover`, reconciled: rec.n });
      await db.execute(sql`DELETE FROM bank_statement_item_matches WHERE bank_statement_item_id IN (SELECT id FROM bank_statement_items WHERE statement_id = ${id})`);
      const delItems = rowsOf(await db.execute(sql`DELETE FROM bank_statement_items WHERE statement_id = ${id} RETURNING id`));
      await db.execute(sql`DELETE FROM bank_statements WHERE id = ${id}`);
      res.json({ ok: true, statementId: id, fileName: st.file_name, deletedItems: delItems.length, by });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Trilha de auditoria das conciliacoes (rastreabilidade) --------------
  app.get("/api/reconciliation/audit", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureAuditTable();
      const itemId = (req.query.itemId as string) || null;
      const action = (req.query.action as string) || null;
      const limit = Math.min(Number(req.query.limit) || 500, 2000);
      const r = await db.execute(sql`
        SELECT * FROM reconciliation_audit_log
        WHERE (${itemId}::text IS NULL OR bank_statement_item_id = ${itemId})
          AND (${action}::text IS NULL OR action = ${action})
        ORDER BY event_at DESC
        LIMIT ${limit}`);
      res.json({ items: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // =========================================================================
  // RELATORIO FINANCEIRO DE CONCILIACAO BANCARIA
  // GET /api/reconciliation/report?accountId=&from=&to=&saldoInicial=
  //
  // Responde a pergunta do negocio: "o saldo da conta bate com o extrato?".
  //   saldo inicial + entradas - saidas = saldo final calculado
  //   saldo final calculado x saldo informado pelo BANCO (LEDGERBAL do OFX)
  //
  // COMO SE SABE O SALDO DO BANCO: o import do OFX guarda o bloco <LEDGERBAL>
  // (BALAMT + DTASOF) dentro de raw_ofx (raw.extrato.saldoFinal/saldoData).
  // Cada arquivo importado vira uma ANCORA (data -> saldo do banco naquele dia).
  // O saldo base da conta (antes do 1o lancamento importado) e deduzido da
  // ancora mais antiga: base = saldoBanco(ancora) - movimento acumulado ate ela.
  // Com a base, o saldo calculado em QUALQUER data e base + movimento acumulado,
  // e a conferencia contra TODAS as ancoras mostra onde (e quando) divergiu.
  // Se nao houver nenhuma ancora, aceita ?saldoInicial= (saldo do dia anterior
  // ao inicio do periodo, digitado pelo operador).
  //
  // Regras:
  //  - linhas ESPELHO (mirror_of) nao entram: o dinheiro se moveu uma vez so.
  //  - lancamento IGNORADO entra no saldo (o dinheiro saiu/entrou do mesmo
  //    jeito); ignorado significa apenas "nao ha titulo a conciliar".
  //  - so leitura. Nenhuma escrita.
  // =========================================================================
  app.get("/api/reconciliation/report", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      await ensureMirrorColumn();
      await ensureRawColumn();
      const accountId = (req.query.accountId as string) || null;
      const instanceId = (req.query.instanceId as string) || null;
      if (!accountId) return res.status(400).json({ error: "informe a conta bancaria (accountId)" });

      const hoje = new Date();
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const to = (req.query.to as string) || iso(hoje);
      const from = (req.query.from as string) || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
      if (from > to) return res.status(400).json({ error: "periodo invalido (data inicial maior que a final)" });
      const saldoInicialParam = req.query.saldoInicial != null && String(req.query.saldoInicial).trim() !== ""
        ? Number(String(req.query.saldoInicial).replace(",", ".")) : null;

      // ---- conta ----------------------------------------------------------
      const contas = rowsOf(await db.execute(sql`
        SELECT id, name, bank_name, bank_code, agency, account_number, omie_instance_id, balance
        FROM financial_accounts
        WHERE id = ${accountId}`));
      const conta = contas[0] || null;
      if (!conta) return res.status(404).json({ error: "conta financeira nao encontrada" });

      const filtroConta = sql`s.financial_account_id = ${accountId}
                          AND (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
                          AND COALESCE(i.reconciliation_status, 'pending') <> 'saldo'`;

      // ---- movimento acumulado por dia (conta inteira) --------------------
      const movDia = rowsOf(await db.execute(sql`
        SELECT to_char(i.transaction_date::date, 'YYYY-MM-DD') AS d,
               SUM(CASE WHEN i.type = 'C' THEN i.amount::numeric ELSE -i.amount::numeric END)::numeric AS mov,
               SUM(CASE WHEN i.type = 'C' THEN i.amount::numeric ELSE 0 END)::numeric AS cred,
               SUM(CASE WHEN i.type = 'D' THEN i.amount::numeric ELSE 0 END)::numeric AS deb,
               COUNT(*)::int AS qtd
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.mirror_of IS NULL AND ${filtroConta}
        GROUP BY 1 ORDER BY 1`));
      // acumulado ate o fim de cada dia
      const acum: Array<{ d: string; ate: number }> = [];
      { let a = 0; for (const r of movDia) { a += Number(r.mov || 0); acum.push({ d: String(r.d), ate: a }); } }
      const movAte = (dia: string): number => {          // movimento acumulado ate o FIM de `dia`
        let v = 0;
        for (const x of acum) { if (x.d <= dia) v = x.ate; else break; }
        return v;
      };
      const movAntes = (dia: string): number => {        // movimento acumulado ate o dia ANTERIOR
        let v = 0;
        for (const x of acum) { if (x.d < dia) v = x.ate; else break; }
        return v;
      };

      // ---- ancoras: saldo informado pelo BANCO (LEDGERBAL do OFX) ---------
      // Extraido por regex do raw_ofx (o JSON e truncado em 20k -> cast p/ json
      // pode falhar; regex nao). Uma ancora por (data, saldo).
      let ancorasRaw: any[] = [];
      try {
        ancorasRaw = rowsOf(await db.execute(sql`
          SELECT substring(i.raw_ofx from '"saldoData":"([^"]*)"') AS dt,
                 substring(i.raw_ofx from '"saldoFinal":"([^"]*)"') AS bal,
                 MIN(s.file_name) AS file_name, MIN(s.id::text) AS statement_id
          FROM bank_statement_items i
          JOIN bank_statements s ON s.id = i.statement_id
          WHERE ${filtroConta} AND i.raw_ofx IS NOT NULL AND i.raw_ofx LIKE '%saldoFinal%'
          GROUP BY 1, 2
          ORDER BY 1`));
      } catch { ancorasRaw = []; }
      const ancoras = ancorasRaw
        .filter((a: any) => String(a.bal ?? "").trim() !== "" && String(a.dt ?? "").trim() !== "")
        .map((a: any) => ({ data: String(a.dt).slice(0, 10), saldoBanco: Number(String(a.bal).replace(/[^0-9.-]/g, "")), arquivo: a.file_name || null, statementId: a.statement_id || null }))
        .filter((a: any) => a.data && !isNaN(a.saldoBanco))
        .sort((a: any, b: any) => (a.data! < b.data! ? -1 : a.data! > b.data! ? 1 : 0));

      // ---- FASE 3.4v: o LEDGERBAL do OFX e FOTO DO INSTANTE DA EXPORTACAO --
      // O BB exporta o extrato de manha e escreve no <LEDGERBAL> o saldo DAQUELE
      // MOMENTO, com DTASOF = o proprio dia. O arquivo so contem os lancamentos
      // ate ali; o resto do dia chega nos arquivos seguintes. Comparar esse saldo
      // com o movimento do DIA INTEIRO acusava divergencia falsa do tamanho do
      // que caiu depois da foto (ex.: o DAS de R$ 39.361,99 em 28/07, que so
      // aparece no arquivo exportado em 29/07 as 10:16).
      // Regra correta: cada ancora e comparada com
      //     saldoBase + movimento ate o dia ANTERIOR + movimento do dia DAQUELE ARQUIVO.
      // Assim compara-se exatamente o mesmo conjunto de lancamentos que o banco
      // tinha na hora de escrever o saldo.
      const movDiaArq: Record<string, number> = {};
      const diaTotalQtd: Record<string, number> = {};
      const diaArqQtd: Record<string, number> = {};
      try {
        const r = rowsOf(await db.execute(sql`
          SELECT stmt, d, SUM(CASE WHEN tp = 'C' THEN v ELSE -v END)::numeric AS mov, COUNT(*)::int AS qtd
          FROM (
            SELECT DISTINCT s.id::text AS stmt,
                   to_char(c.transaction_date::date, 'YYYY-MM-DD') AS d,
                   c.id AS cid, c.type AS tp, c.amount::numeric AS v
            FROM bank_statement_items i
            JOIN bank_statements s ON s.id = i.statement_id
            JOIN bank_statement_items c ON c.id = COALESCE(i.mirror_of, i.id)
            WHERE s.financial_account_id = ${accountId}
              AND (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
              AND COALESCE(c.reconciliation_status, 'pending') <> 'saldo'
          ) t GROUP BY 1, 2`));
        for (const x of r) {
          movDiaArq[`${x.stmt}|${x.d}`] = Number(x.mov || 0);
          diaArqQtd[`${x.stmt}|${x.d}`] = Number(x.qtd || 0);
        }
      } catch { /* sem raw/statement: cai na regra antiga */ }
      for (const r of movDia) diaTotalQtd[String(r.d)] = Number(r.qtd || 0);
      // saldo calculado "como o banco via" no instante daquela exportacao
      const calcNaAncora = (a: any): number => {
        const k = `${a.statementId}|${a.data}`;
        if (a.statementId && k in movDiaArq) return saldoBase + movAntes(a.data) + movDiaArq[k];
        return saldoBase + movAte(a.data);          // sem arquivo identificado: regra antiga
      };
      const ancoraParcial = (a: any): boolean => {
        const k = `${a.statementId}|${a.data}`;
        return !!a.statementId && k in diaArqQtd && (diaArqQtd[k] < (diaTotalQtd[a.data] || 0));
      };

      // ---- saldo base (antes do 1o lancamento importado) ------------------
      let saldoBase = 0;
      let baseOrigem: "extrato" | "informado" | "zero" = "zero";
      if (saldoInicialParam != null && !isNaN(saldoInicialParam)) {
        // saldo digitado pelo operador = saldo do dia ANTERIOR ao inicio do periodo
        saldoBase = saldoInicialParam - movAntes(from);
        baseOrigem = "informado";
      } else if (ancoras.length) {
        const a0: any = ancoras[0];
        const k0 = `${a0.statementId}|${a0.data}`;
        const movAteAncora = (a0.statementId && k0 in movDiaArq)
          ? movAntes(a0.data as string) + movDiaArq[k0]
          : movAte(a0.data as string);
        saldoBase = a0.saldoBanco - movAteAncora;
        baseOrigem = "extrato";
      }
      const saldoEm = (dia: string) => saldoBase + movAte(dia);

      // conferencia: saldo calculado x saldo do banco em cada ancora
      // A ancora mais antiga e a CALIBRACAO (dela sai o saldo base), entao ela
      // sempre fecha por construcao. As demais sao conferencia de verdade.
      const conferencia = ancoras.map((a: any, idx: number) => {
        const calc = calcNaAncora(a);
        return {
          data: a.data, arquivo: a.arquivo,
          saldoBanco: Number(a.saldoBanco.toFixed(2)),
          saldoCalculado: Number(calc.toFixed(2)),
          diferenca: Number((calc - a.saldoBanco).toFixed(2)),
          calibracao: baseOrigem === "extrato" && idx === 0,
          // true = o arquivo e uma FOTO do meio do dia (o dia tem mais lancamentos
          // do que os que estavam nele). A comparacao ja considera so o que o banco
          // tinha naquele instante; o marcador serve para leitura.
          parcial: ancoraParcial(a),
          saldoDoDiaFechado: Number(saldoEm(a.data as string).toFixed(2)),
        };
      });

      // ---- lancamentos do periodo -----------------------------------------
      const itens = rowsOf(await db.execute(sql`
        SELECT i.id, to_char(i.transaction_date::date, 'YYYY-MM-DD') AS data, i.amount, i.type,
               i.description, i.document, i.origin_name, i.origin_document,
               COALESCE(i.reconciliation_status, 'pending') AS status,
               i.matched_at, i.matched_by, i.notes,
               s.file_name, s.id AS statement_id, fa.name AS account_name
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE i.mirror_of IS NULL AND ${filtroConta}
          AND i.transaction_date::date >= ${from}::date
          AND i.transaction_date::date <= ${to}::date
        ORDER BY i.transaction_date::date, i.type, i.id
        LIMIT 20000`));

      // titulos conciliados de cada lancamento (o que foi RECEBIDO / PAGO)
      const ids = itens.map((i: any) => i.id);
      const titulosPorItem: Record<string, any[]> = {};
      if (ids.length) {
        const mR = await db.execute(sql`
          SELECT m.bank_statement_item_id AS item_id, m.amount, m.match_kind,
                 m.title_amount_settled, m.interest, m.discount,
                 r.id AS r_id, r.title_number AS r_title, r.customer_name AS r_name, r.customer_document AS r_doc,
                 r.due_date AS r_due, r.amount AS r_amount,
                 (rc.code || ' ' || rc.name) AS r_cat,
                 p.id AS p_id, p.title_number AS p_title, p.supplier_name AS p_name, p.supplier_document AS p_doc,
                 p.due_date AS p_due, p.amount AS p_amount,
                 (pc.code || ' ' || pc.name) AS p_cat
          FROM bank_statement_item_matches m
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN chart_of_accounts rc ON rc.id = r.chart_account_id
          LEFT JOIN payables p ON p.id = m.payable_id
          LEFT JOIN chart_of_accounts pc ON pc.id = p.chart_account_id
          WHERE m.bank_statement_item_id IN (${inList(ids)})`);
        for (const m of rowsOf(mR)) {
          const receber = !!m.r_id;
          (titulosPorItem[m.item_id] ||= []).push({
            especie: receber ? "receber" : "pagar",
            id: receber ? m.r_id : m.p_id,
            titulo: receber ? m.r_title : m.p_title,
            nome: receber ? m.r_name : m.p_name,
            documento: receber ? m.r_doc : m.p_doc,
            vencimento: receber ? m.r_due : m.p_due,
            valorTitulo: receber ? m.r_amount : m.p_amount,
            categoria: (receber ? m.r_cat : m.p_cat) || null,
            valor: m.amount,
            baixado: m.title_amount_settled,
            juros: m.interest,
            desconto: m.discount,
            origem: m.match_kind,
          });
        }
      }

      // ---- monta as linhas com SALDO ACUMULADO ----------------------------
      const n = (v: any) => { const x = parseFloat(String(v ?? "0").replace(/[^0-9.-]/g, "")); return isNaN(x) ? 0 : x; };
      let saldo = saldoBase + movAntes(from);           // saldo de abertura do periodo
      const saldoInicial = saldo;
      const linhas = itens.map((i: any) => {
        const valor = n(i.amount);
        const entrada = i.type === "C" ? valor : 0;
        const saida = i.type === "D" ? valor : 0;
        saldo += entrada - saida;
        const det = derivarDetalhe(i.description, i.origin_name);
        const titulos = titulosPorItem[i.id] || [];
        return {
          id: i.id, data: i.data, tipo: i.type, entrada, saida, valor,
          saldo: Number(saldo.toFixed(2)),
          contraparte: det.contraparte || i.origin_name || i.description || "",
          historico: det.tipo || "",
          documento: det.doc || i.origin_document || "",
          hora: det.hora || "", diaBanco: det.dia || "",
          descricao: i.description, docBanco: i.document,
          status: i.status, conciliadoEm: i.matched_at, conciliadoPor: i.matched_by,
          observacao: i.notes, arquivo: i.file_name, conta: i.account_name,
          titulos,
          categoria: titulos.map((t: any) => t.categoria).filter(Boolean)[0] || null,
        };
      });
      const saldoFinalCalculado = saldo;

      // ---- totais ---------------------------------------------------------
      const soma = (f: (l: any) => number) => Number(linhas.reduce((a: number, l: any) => a + f(l), 0).toFixed(2));
      const entradas = soma((l) => l.entrada);
      const saidas = soma((l) => l.saida);
      const porStatus = (st: string) => {
        const ls = linhas.filter((l: any) => (st === "pending" ? (l.status === "pending" || !l.status) : l.status === st));
        return {
          qtd: ls.length,
          entradas: Number(ls.reduce((a: number, l: any) => a + l.entrada, 0).toFixed(2)),
          saidas: Number(ls.reduce((a: number, l: any) => a + l.saida, 0).toFixed(2)),
        };
      };
      // recebido / pago = o que a conciliacao baixou em titulos no periodo
      const somaTit = (especie: string, campo: string) => Number(linhas.reduce((a: number, l: any) =>
        a + (l.titulos || []).filter((t: any) => t.especie === especie).reduce((b: number, t: any) => b + n((t as any)[campo]), 0), 0).toFixed(2));
      const contaTit = (especie: string) => linhas.reduce((a: number, l: any) => a + (l.titulos || []).filter((t: any) => t.especie === especie).length, 0);

      // por categoria (plano de contas), separando entrada e saida
      const catMap: Record<string, { categoria: string; entradas: number; saidas: number; qtd: number }> = {};
      for (const l of linhas) {
        const ts = l.titulos || [];
        if (!ts.length) {
          const k = l.status === "ignored" ? "— Ignorado (sem título)" : "— Sem título conciliado";
          (catMap[k] ||= { categoria: k, entradas: 0, saidas: 0, qtd: 0 });
          catMap[k].entradas += l.entrada; catMap[k].saidas += l.saida; catMap[k].qtd++;
          continue;
        }
        for (const t of ts) {
          const k = t.categoria || "— Sem categoria";
          (catMap[k] ||= { categoria: k, entradas: 0, saidas: 0, qtd: 0 });
          if (l.tipo === "C") catMap[k].entradas += n(t.valor); else catMap[k].saidas += n(t.valor);
          catMap[k].qtd++;
        }
      }
      const porCategoria = Object.values(catMap)
        .map((c) => ({ ...c, entradas: Number(c.entradas.toFixed(2)), saidas: Number(c.saidas.toFixed(2)) }))
        .sort((a, b) => (b.entradas + b.saidas) - (a.entradas + a.saidas));

      // ---- HISTORICO MENSAL (conta inteira, independente do periodo) ------
      // Base fixa do relatorio: todo mes que tem lancamento na conta, com
      // entradas, saidas, saldo no fim do mes e a situacao da conciliacao.
      const mesesR = rowsOf(await db.execute(sql`
        SELECT to_char(i.transaction_date::date, 'YYYY-MM') AS mes,
               MAX(to_char(i.transaction_date::date, 'YYYY-MM-DD')) AS ultimo_dia,
               SUM(CASE WHEN i.type = 'C' THEN i.amount::numeric ELSE 0 END)::numeric AS entradas,
               SUM(CASE WHEN i.type = 'D' THEN i.amount::numeric ELSE 0 END)::numeric AS saidas,
               COUNT(*)::int AS qtd,
               COUNT(*) FILTER (WHERE COALESCE(i.reconciliation_status, 'pending') = 'reconciled')::int AS conciliados,
               COUNT(*) FILTER (WHERE COALESCE(i.reconciliation_status, 'pending') = 'pending')::int AS pendentes,
               COUNT(*) FILTER (WHERE COALESCE(i.reconciliation_status, 'pending') = 'ignored')::int AS ignorados,
               SUM(CASE WHEN COALESCE(i.reconciliation_status, 'pending') = 'pending' THEN i.amount::numeric ELSE 0 END)::numeric AS valor_pendente
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.mirror_of IS NULL AND ${filtroConta}
        GROUP BY 1 ORDER BY 1`));
      const porMes = mesesR.map((m: any) => {
        const fim = String(m.ultimo_dia);
        // ancora (saldo do banco) mais recente DENTRO do mes, se houver
        const ancMes = ancoras.filter((a: any) => String(a.data).slice(0, 7) === String(m.mes)).slice(-1)[0] || null;
        return {
          mes: m.mes,
          entradas: Number(Number(m.entradas || 0).toFixed(2)),
          saidas: Number(Number(m.saidas || 0).toFixed(2)),
          resultado: Number((Number(m.entradas || 0) - Number(m.saidas || 0)).toFixed(2)),
          saldoFinal: Number(saldoEm(fim).toFixed(2)),
          saldoBanco: ancMes ? Number(ancMes.saldoBanco.toFixed(2)) : null,
          saldoBancoData: ancMes ? ancMes.data : null,
          diferenca: ancMes ? Number((calcNaAncora(ancMes) - ancMes.saldoBanco).toFixed(2)) : null,
          qtd: m.qtd, conciliados: m.conciliados, pendentes: m.pendentes, ignorados: m.ignorados,
          valorPendente: Number(Number(m.valor_pendente || 0).toFixed(2)),
        };
      });

      // ---- fechamento: calculado x banco ----------------------------------
      // Ancora usada no fechamento = a mais recente com data <= fim do periodo.
      const ancoraFim = [...conferencia].filter((a: any) => (a.data as string) <= to).pop() || null;
      const diferenca = ancoraFim ? Number((ancoraFim as any).diferenca) : null;

      res.json({
        conta: {
          id: conta.id, nome: conta.name, banco: conta.bank_name, agencia: conta.agency,
          numero: conta.account_number, instancia: conta.omie_instance_id,
          saldoCadastro: conta.balance == null ? null : Number(conta.balance),
        },
        periodo: { de: from, ate: to },
        base: { saldoBase: Number(saldoBase.toFixed(2)), origem: baseOrigem },
        resumo: {
          saldoInicial: Number(saldoInicial.toFixed(2)),
          entradas, saidas,
          resultado: Number((entradas - saidas).toFixed(2)),
          saldoFinalCalculado: Number(saldoFinalCalculado.toFixed(2)),
          saldoBanco: ancoraFim ? ancoraFim.saldoBanco : null,
          saldoBancoData: ancoraFim ? ancoraFim.data : null,
          saldoCalculadoNaDataDoBanco: ancoraFim ? Number((ancoraFim as any).saldoCalculado) : null,
          diferenca,
          bate: diferenca == null ? null : Math.abs(diferenca) < 0.01,
          qtdEntradas: linhas.filter((l: any) => l.tipo === "C").length,
          qtdSaidas: linhas.filter((l: any) => l.tipo === "D").length,
        },
        status: { conciliados: porStatus("reconciled"), pendentes: porStatus("pending"), ignorados: porStatus("ignored") },
        titulos: {
          recebido: { qtd: contaTit("receber"), valor: somaTit("receber", "valor"), baixado: somaTit("receber", "baixado"), juros: somaTit("receber", "juros"), desconto: somaTit("receber", "desconto") },
          pago: { qtd: contaTit("pagar"), valor: somaTit("pagar", "valor"), baixado: somaTit("pagar", "baixado"), juros: somaTit("pagar", "juros"), desconto: somaTit("pagar", "desconto") },
        },
        porCategoria,
        porMes,
        conferencia,
        itens: linhas,
        avisos: [
          ...(baseOrigem === "zero" ? ["Nenhum saldo do banco foi encontrado nos extratos importados (bloco LEDGERBAL do OFX). O saldo inicial foi considerado ZERO — informe o saldo inicial no filtro para o relatório fechar com o extrato."] : []),
          ...(baseOrigem === "informado" ? ["Saldo inicial informado manualmente no filtro."] : []),
          ...(ancoraFim && Math.abs(diferenca as number) >= 0.01 ? [`O saldo calculado NÃO bate com o extrato em ${String(ancoraFim.data).split("-").reverse().join("/")}: diferença de R$ ${(diferenca as number).toFixed(2)}. Verifique lançamentos faltando (extrato não importado) ou duplicados.${(ancoraFim as any).parcial ? " (esse arquivo é uma foto do meio do dia; a comparação já considera só o que o banco tinha naquele instante)" : ""}`] : []),
        ],
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

}
