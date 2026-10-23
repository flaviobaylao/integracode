// =============================================================================
//  INTEGRA 2.0 — Horário de atendimento ao FORNECEDOR (out/2026)
//  Alguns estabelecimentos só abrem ao público à tarde, mas de manhã a administração
//  atende fornecedores. O VENDEDOR marca no card da Rota do Dia o horário em que o
//  cliente atende fornecedor ("das 10:00 às 12:00"); se preenchido, aparece no card.
//
//  AUTOSSUFICIENTE: colunas criadas sob demanda (produção não roda db:push) e lidas
//  por SQL cru — NÃO estão no schema Drizzle, então nenhum SELECT existente quebra.
// =============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);

let __cols: Promise<void> | null = null;
export function ensureHorarioFornecedorColumns(): Promise<void> {
  if (!__cols) {
    __cols = (async () => {
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS atende_fornecedor_inicio varchar(5)`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS atende_fornecedor_fim varchar(5)`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS atende_fornecedor_por varchar`);
      await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS atende_fornecedor_em timestamp`);
    })().catch((e: any) => { __cols = null; throw e; });
  }
  return __cols;
}

// "9:5" / "09:05" / "0905" → "09:05"; vazio → null; inválido → undefined
function normHora(v: any): string | null | undefined {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*[:hH.]?\s*(\d{2})?$/);
  if (!m) return undefined;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function registerHorarioFornecedorRoutes(app: Express) {
  // Mapa customerId → { inicio, fim } para os cards da Rota do Dia.
  app.get("/api/horario-fornecedor", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureHorarioFornecedorColumns();
      const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.json({ horarios: {} });
      const r = await db.execute(sql`
        SELECT id, atende_fornecedor_inicio AS inicio, atende_fornecedor_fim AS fim
        FROM customers
        WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
          AND (atende_fornecedor_inicio IS NOT NULL OR atende_fornecedor_fim IS NOT NULL)`);
      const horarios: Record<string, { inicio: string | null; fim: string | null }> = {};
      for (const row of rowsOf(r)) horarios[String(row.id)] = { inicio: row.inicio || null, fim: row.fim || null };
      res.json({ horarios });
    } catch (e: any) {
      console.error("[horario-fornecedor] GET", e?.message);
      res.status(500).json({ message: e?.message || "erro interno" });
    }
  });

  // Vendedor (do próprio cliente) ou admin/gestão grava o horário. Ambos vazios = limpa.
  app.put("/api/horario-fornecedor/:customerId", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureHorarioFornecedorColumns();
      const user = req.currentUser || {};
      const { customerId } = req.params;
      const cr = rowsOf(await db.execute(sql`SELECT id, seller_id FROM customers WHERE id = ${customerId} LIMIT 1`));
      if (!cr.length) return res.status(404).json({ message: "Cliente não encontrado" });
      if (user.role === "vendedor" && String(cr[0].seller_id) !== String(user.id)) {
        return res.status(403).json({ message: "Este cliente não é da sua carteira." });
      }
      const inicio = normHora(req.body?.inicio);
      const fim = normHora(req.body?.fim);
      if (inicio === undefined || fim === undefined) {
        return res.status(400).json({ message: "Horário inválido. Use o formato HH:MM." });
      }
      if (inicio && fim && fim <= inicio) {
        return res.status(400).json({ message: "O horário final deve ser depois do inicial." });
      }
      const quem = String(user.name || user.email || user.id || "");
      await db.execute(sql`
        UPDATE customers
           SET atende_fornecedor_inicio = ${inicio},
               atende_fornecedor_fim = ${fim},
               atende_fornecedor_por = ${inicio || fim ? quem : null},
               atende_fornecedor_em = ${inicio || fim ? sql`now()` : null}
         WHERE id = ${customerId}`);
      res.json({ ok: true, customerId, inicio, fim });
    } catch (e: any) {
      console.error("[horario-fornecedor] PUT", e?.message);
      res.status(500).json({ message: e?.message || "erro interno" });
    }
  });
}
