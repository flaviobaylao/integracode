import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

// ===========================================================================
// DADOS DE PAGAMENTO SALVOS (03/nov/2026) — Reembolsos e Viagens.
// Toda solicitação enviada grava (ou atualiza) os dados de pagamento do favorecido
// para o DONO do pedido (solicitante do reembolso / vendedor da viagem): nome,
// CPF/CNPJ, forma, chave PIX (tipo, titular, banco) ou conta bancária e empresa.
// No próximo pedido o formulário já vem preenchido com o último usado, e dá para
// escolher outro favorecido salvo. Um registro por (dono, favorecido); o mais
// recente primeiro. Tabela criada sob demanda, fora do drizzle.
// ===========================================================================

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const ADM = ["admin", "administrative", "coordinator"];

export type DadosPagamento = {
  favorecidoNome: string; favorecidoDoc?: string; forma?: string; instancia?: string;
  pixTipo?: string; pixChave?: string; pixTitular?: string;
  banco?: string; agencia?: string; conta?: string; tipoConta?: string;
};

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS pagamento_favoritos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id varchar NOT NULL,
        chave varchar NOT NULL,
        dados jsonb NOT NULL,
        usos integer NOT NULL DEFAULT 1,
        updated_at timestamp NOT NULL DEFAULT now(),
        UNIQUE (user_id, chave)
      )`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

const chaveDe = (d: DadosPagamento) => String(d.favorecidoNome || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);

// Grava/atualiza os dados de pagamento usados num pedido (nunca bloqueia o pedido).
export async function salvarDadosPagamento(userId: string, d: DadosPagamento): Promise<void> {
  try {
    const chave = chaveDe(d);
    if (!userId || !chave) return;
    await ensure();
    const limpo: DadosPagamento = {
      favorecidoNome: String(d.favorecidoNome || "").trim().slice(0, 200),
      favorecidoDoc: d.favorecidoDoc || "", forma: d.forma || "", instancia: d.instancia || "",
      pixTipo: d.forma === "pix" ? (d.pixTipo || "") : "", pixChave: d.forma === "pix" ? (d.pixChave || "") : "", pixTitular: d.forma === "pix" ? (d.pixTitular || "") : "",
      banco: d.banco || "", agencia: d.forma === "transferencia" ? (d.agencia || "") : "", conta: d.forma === "transferencia" ? (d.conta || "") : "",
      tipoConta: d.forma === "transferencia" ? (d.tipoConta || "") : "",
    };
    await db.execute(sql`INSERT INTO pagamento_favoritos (user_id, chave, dados) VALUES (${userId}, ${chave}, ${JSON.stringify(limpo)}::jsonb)
      ON CONFLICT (user_id, chave) DO UPDATE SET dados = EXCLUDED.dados, usos = pagamento_favoritos.usos + 1, updated_at = now()`);
  } catch (e: any) { console.warn("[pagamento-favoritos] salvar:", e?.message || e); }
}

export function registerFavoritosPagamento(app: Express) {
  // Lista os favorecidos salvos de um dono (o próprio usuário; admin/financeiro pode consultar de um vendedor)
  app.get("/api/pagamento-favoritos", authenticateUser, async (req: Request, res: Response) => {
    const u: any = (req as any).currentUser || (req as any).user;
    if (!u?.id) return res.status(401).json({ message: "Unauthorized" });
    try {
      await ensure();
      const alvo = req.query.userId && ADM.includes(String(u.role || "")) ? String(req.query.userId) : String(u.id);
      const r = rows(await db.execute(sql`SELECT id, dados, usos, updated_at FROM pagamento_favoritos WHERE user_id = ${alvo} ORDER BY updated_at DESC LIMIT 20`));
      res.json(r.map((x) => ({ id: x.id, usos: Number(x.usos || 0), ...(typeof x.dados === "string" ? JSON.parse(x.dados) : x.dados) })));
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  // Apagar um favorecido salvo (dono, ou admin)
  app.delete("/api/pagamento-favoritos/:id", authenticateUser, async (req: Request, res: Response) => {
    const u: any = (req as any).currentUser || (req as any).user;
    if (!u?.id) return res.status(401).json({ message: "Unauthorized" });
    try {
      await ensure();
      const adm = ADM.includes(String(u.role || ""));
      await db.execute(adm ? sql`DELETE FROM pagamento_favoritos WHERE id = ${req.params.id}`
        : sql`DELETE FROM pagamento_favoritos WHERE id = ${req.params.id} AND user_id = ${String(u.id)}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
}
