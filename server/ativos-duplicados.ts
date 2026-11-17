// server/ativos-duplicados.ts
// -----------------------------------------------------------------------------
// CLIENTES ATIVOS DUPLICADOS (nov/2026)
// A lista de Clientes Ativos (active_customers) tinha 2 linhas ATIVAS apontando para o
// MESMO cliente (ex.: XIS TCHE). Origem: a importação de planilha de 28/04/2026
// ("import-active") criou uma linha nova para clientes que já estavam na lista desde
// 27/11/2025, e o "adicionar à lista" manual procurava só pelo documento (CPF/CNPJ
// corrigido depois = linha nova para o mesmo cliente).
//
// POST /api/admin/active-customers/deduplicar { dry?: boolean (padrão true) }
//   Mantém 1 linha por cliente (a do documento atual do cadastro; empate = a mais antiga)
//   e DESATIVA as demais (is_active=false, deactivated_at=now — nada é apagado).
//   Depois cria o índice único parcial que impede 2 linhas ativas para o mesmo cliente.
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);

export async function deduplicarClientesAtivos(dry: boolean) {
  const extras = rows(await db.execute(sql`
    WITH ranked AS (
      SELECT a.id, a.customer_id, a.document, a.upload_id, a.created_at,
             COALESCE(NULLIF(c.fantasy_name,''), c.name, a.fantasy_name_imported) AS nome,
             ROW_NUMBER() OVER (
               PARTITION BY a.customer_id
               ORDER BY (regexp_replace(COALESCE(a.document,''),'[^0-9]','','g')
                         = regexp_replace(COALESCE(NULLIF(c.cnpj,''), c.cpf, ''),'[^0-9]','','g')) DESC,
                        a.created_at ASC, a.id ASC) AS rn
      FROM active_customers a
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.is_active = true AND a.customer_id IS NOT NULL
    )
    SELECT id, customer_id, document, upload_id, created_at, nome FROM ranked WHERE rn > 1
    ORDER BY nome`));

  let desativadas = 0;
  let indice = false;
  if (!dry) {
    if (extras.length) {
      const ids = extras.map((e) => String(e.id));
      const r = rows(await db.execute(sql`
        UPDATE active_customers SET is_active = false, deactivated_at = now(), updated_at = now()
        WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND is_active = true
        RETURNING id`));
      desativadas = r.length;
    }
    try {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_customers_cliente_ativo
        ON active_customers (customer_id) WHERE is_active = true AND customer_id IS NOT NULL`);
      indice = true;
    } catch (e: any) {
      console.warn("[ativos-duplicados] índice único não criado:", e?.message);
    }
  }
  return {
    dry,
    duplicadas: extras.length,
    desativadas,
    indiceUnico: indice,
    linhas: extras.map((e) => ({ id: e.id, customerId: e.customer_id, nome: e.nome, documento: e.document, origem: e.upload_id, criadaEm: e.created_at })),
  };
}

export function registerAtivosDuplicados(app: Express): void {
  app.post("/api/admin/active-customers/deduplicar", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      const b: any = req.body || {};
      const dry = !(b.dry === false || b.dry === "0" || b.dry === "false");
      res.json({ ok: true, ...(await deduplicarClientesAtivos(dry)) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });
}
