// server/repescagem-bloqueios.ts
// -----------------------------------------------------------------------------
// BLOQUEIOS DA REPESCAGEM (Admin) — nov/2026, pedido do Flavio.
//
// Carteiras, redes de clientes e clientes que NUNCA entram em repescagem
// (ex.: todas as unidades da rede Amorix). Vale para o cálculo dos candidatos,
// para o sorteio, para o envio manual do Inbox e para a Rota do Dia.
//   • carteira: todos os clientes cujo dono (customers.seller_id) é aquele vendedor;
//   • rede:     todas as unidades da rede (inclusive as que entrarem depois);
//   • cliente:  um cliente específico.
// Ao bloquear, as alocações ativas (pendentes ou na rota de hoje) dos clientes
// atingidos são canceladas na hora.
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);
const TIPOS = ["carteira", "rede", "cliente"] as const;
type Tipo = typeof TIPOS[number];

let ensured = false;
export async function ensureBloqueiosTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql.raw(
    "CREATE TABLE IF NOT EXISTS repescagem_bloqueios (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "tipo varchar NOT NULL, " +
    "ref_id varchar NOT NULL, " +
    "nome varchar, " +
    "motivo text, " +
    "created_by varchar, " +
    "created_by_name varchar, " +
    "created_at timestamptz DEFAULT now())"
  ));
  await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS ux_rep_bloq_tipo_ref ON repescagem_bloqueios (tipo, ref_id)"));
  ensured = true;
}

export type BloqueiosRep = { carteiras: Set<string>; redes: Set<string>; clientes: Set<string>; clientesDeRede: Set<string> };

/** Bloqueios atuais. Nunca estoura: em erro devolve tudo vazio. */
export async function bloqueiosRepescagem(): Promise<BloqueiosRep> {
  const out: BloqueiosRep = { carteiras: new Set(), redes: new Set(), clientes: new Set(), clientesDeRede: new Set() };
  try {
    await ensureBloqueiosTable();
    for (const r of rowsOf(await db.execute(sql`SELECT tipo, ref_id FROM repescagem_bloqueios`))) {
      if (r.tipo === "carteira") out.carteiras.add(String(r.ref_id));
      else if (r.tipo === "rede") out.redes.add(String(r.ref_id));
      else if (r.tipo === "cliente") out.clientes.add(String(r.ref_id));
    }
    if (out.redes.size) {
      const ids = sql.join(Array.from(out.redes).map((x) => sql`${x}`), sql`, `);
      for (const m of rowsOf(await db.execute(sql`SELECT customer_id FROM cliente_rede_membros WHERE rede_id IN (${ids})`))) {
        if (m.customer_id) out.clientesDeRede.add(String(m.customer_id));
      }
    }
  } catch (e: any) { console.warn("[repescagem-bloqueios] leitura:", e?.message); }
  return out;
}

/** O cliente está bloqueado? (por carteira do dono, por rede ou individualmente) */
export function estaBloqueado(b: BloqueiosRep, customerId: string, sellerId?: string | null): boolean {
  const cid = String(customerId || "");
  return b.clientes.has(cid) || b.clientesDeRede.has(cid) || (!!sellerId && b.carteiras.has(String(sellerId)));
}

/** Motivo legível do bloqueio de um cliente, ou null. */
export async function motivoBloqueioCliente(customerId: string): Promise<string | null> {
  const b = await bloqueiosRepescagem();
  const cid = String(customerId || "");
  if (b.clientes.has(cid)) return "cliente bloqueado para repescagem";
  if (b.clientesDeRede.has(cid)) return "a rede deste cliente está bloqueada para repescagem";
  try {
    const c = rowsOf(await db.execute(sql`SELECT seller_id FROM customers WHERE id = ${cid} LIMIT 1`))[0];
    if (c?.seller_id && b.carteiras.has(String(c.seller_id))) return "a carteira deste cliente está bloqueada para repescagem";
  } catch {}
  return null;
}

function nomeUser(u: any): string {
  return (((u?.firstName || u?.first_name || "") + " " + (u?.lastName || u?.last_name || "")).trim() || (u?.email ? String(u.email).split("@")[0] : "")) || "Admin";
}

export function registerRepescagemBloqueios(app: Express, opts: { authenticateUser: any; requireRole: (roles: string[]) => any }) {
  const { authenticateUser, requireRole } = opts;
  const GESTAO = ["admin", "coordinator", "administrative"];

  // Lista dos bloqueios (com nomes e quantos clientes cada um atinge).
  app.get("/api/repescagem/bloqueios", authenticateUser, requireRole(GESTAO), async (_req: any, res) => {
    try {
      await ensureBloqueiosTable();
      const rows = rowsOf(await db.execute(sql`SELECT * FROM repescagem_bloqueios ORDER BY tipo, nome`));
      const itens: any[] = [];
      for (const r of rows) {
        let clientes = 0;
        try {
          if (r.tipo === "carteira") clientes = Number(rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM customers WHERE seller_id = ${r.ref_id} AND is_active IS NOT FALSE`))[0]?.n || 0);
          else if (r.tipo === "rede") clientes = Number(rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM cliente_rede_membros WHERE rede_id = ${r.ref_id}`))[0]?.n || 0);
          else clientes = 1;
        } catch {}
        itens.push({ id: r.id, tipo: r.tipo, refId: r.ref_id, nome: r.nome || r.ref_id, motivo: r.motivo || null, por: r.created_by_name || null, em: r.created_at, clientes });
      }
      res.json({ itens });
    } catch (e: any) {
      console.error("GET /api/repescagem/bloqueios", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });

  // Opções para escolher: carteiras (vendedores/telemarketing) e redes de clientes.
  app.get("/api/repescagem/bloqueios/opcoes", authenticateUser, requireRole(GESTAO), async (_req: any, res) => {
    try {
      const carteiras = rowsOf(await db.execute(sql`
        SELECT u.id, TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS nome, u.role::text AS role, u.is_active,
               (SELECT COUNT(*)::int FROM customers c WHERE c.seller_id = u.id AND c.is_active IS NOT FALSE) AS clientes
          FROM users u
         WHERE EXISTS (SELECT 1 FROM customers c WHERE c.seller_id = u.id AND c.is_active IS NOT FALSE)
         ORDER BY 2`));
      let redes: any[] = [];
      try {
        redes = rowsOf(await db.execute(sql`
          SELECT r.id, r.nome, (SELECT COUNT(*)::int FROM cliente_rede_membros m WHERE m.rede_id = r.id) AS clientes
            FROM cliente_redes r ORDER BY r.nome`));
      } catch {}
      res.json({
        carteiras: carteiras.map((c: any) => ({ id: c.id, nome: c.nome || c.id, role: c.role, ativo: c.is_active !== false, clientes: Number(c.clientes || 0) })),
        redes: redes.map((r: any) => ({ id: r.id, nome: r.nome || r.id, clientes: Number(r.clientes || 0) })),
      });
    } catch (e: any) {
      console.error("GET /api/repescagem/bloqueios/opcoes", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });

  // Busca de clientes por nome, razão social ou documento (para bloquear um cliente).
  app.get("/api/repescagem/bloqueios/clientes", authenticateUser, requireRole(GESTAO), async (req: any, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ clientes: [] });
      const like = `%${q}%`;
      const dig = q.replace(/\D/g, "");
      const r = rowsOf(await db.execute(sql`
        SELECT c.id, COALESCE(NULLIF(TRIM(c.fantasy_name), ''), c.name) AS nome, c.city,
               TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS vendedor
          FROM customers c LEFT JOIN users u ON u.id = c.seller_id
         WHERE c.is_active IS NOT FALSE
           AND (c.fantasy_name ILIKE ${like} OR c.name ILIKE ${like}
                ${dig.length >= 5 ? sql`OR regexp_replace(COALESCE(c.cnpj, c.cpf, ''), '[^0-9]', '', 'g') LIKE ${"%" + dig + "%"}` : sql``})
         ORDER BY 2 LIMIT 20`));
      res.json({ clientes: r.map((x: any) => ({ id: x.id, nome: x.nome || x.id, cidade: x.city || null, vendedor: x.vendedor || null })) });
    } catch (e: any) {
      console.error("GET /api/repescagem/bloqueios/clientes", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });

  // Criar um bloqueio { tipo: carteira|rede|cliente, refId, motivo? } — admin.
  app.post("/api/repescagem/bloqueios", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureBloqueiosTable();
      const u = req.currentUser || {};
      const tipo = String(req.body?.tipo || "") as Tipo;
      const refId = String(req.body?.refId || "").trim();
      const motivo = req.body?.motivo ? String(req.body.motivo).trim().slice(0, 500) : null;
      if (!TIPOS.includes(tipo)) return res.status(400).json({ message: "Tipo inválido (carteira, rede ou cliente)." });
      if (!refId) return res.status(400).json({ message: "Escolha o que bloquear." });

      let nome: string | null = null;
      let clientesSql: any = null; // subconsulta dos clientes atingidos
      if (tipo === "carteira") {
        const x = rowsOf(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${refId} LIMIT 1`))[0];
        if (!x) return res.status(404).json({ message: "Carteira não encontrada." });
        nome = nomeUser(x);
        clientesSql = sql`SELECT id FROM customers WHERE seller_id = ${refId}`;
      } else if (tipo === "rede") {
        const x = rowsOf(await db.execute(sql`SELECT nome FROM cliente_redes WHERE id = ${refId} LIMIT 1`))[0];
        if (!x) return res.status(404).json({ message: "Rede não encontrada." });
        nome = x.nome;
        clientesSql = sql`SELECT customer_id FROM cliente_rede_membros WHERE rede_id = ${refId}`;
      } else {
        const x = rowsOf(await db.execute(sql`SELECT COALESCE(NULLIF(TRIM(fantasy_name), ''), name) AS nome FROM customers WHERE id = ${refId} LIMIT 1`))[0];
        if (!x) return res.status(404).json({ message: "Cliente não encontrado." });
        nome = x.nome;
        clientesSql = sql`SELECT ${refId}::varchar`;
      }

      const por = nomeUser(u) || u.name || "Admin";
      await db.execute(sql`
        INSERT INTO repescagem_bloqueios (tipo, ref_id, nome, motivo, created_by, created_by_name)
        VALUES (${tipo}, ${refId}, ${nome}, ${motivo}, ${u.id || null}, ${por})
        ON CONFLICT (tipo, ref_id) DO UPDATE SET nome = EXCLUDED.nome, motivo = COALESCE(EXCLUDED.motivo, repescagem_bloqueios.motivo)`);

      // Efeito imediato: cancela as alocações ativas (pendentes ou na rota de hoje) dos atingidos.
      const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
      const canc = rowsOf(await db.execute(sql`
        UPDATE repescagem_assignments
           SET status = 'cancelled', locked = false, updated_at = now()
         WHERE customer_id IN (${clientesSql})
           AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${hoje}))
         RETURNING id, customer_id, assigned_user_id`));
      for (const a of canc) {
        try {
          await db.execute(sql`
            INSERT INTO repescagem_assignment_history (id, assignment_id, customer_id, from_user_id, to_user_id, action, reason, created_at)
            VALUES (gen_random_uuid(), ${String(a.id)}, ${String(a.customer_id)}, ${a.assigned_user_id || null}, NULL, 'cancelled',
                    ${"Bloqueado para repescagem (" + tipo + ": " + (nome || refId) + ")"}, now())`);
        } catch {}
      }
      // Capturas abertas desses clientes deixam de cobrar registro (não é culpa de quem capturou).
      try {
        await db.execute(sql`
          UPDATE repescagem_capturas SET status = 'cancelada', desfecho_at = now(),
                 texto = ${"Cliente bloqueado para repescagem pelo admin"}, updated_at = now()
           WHERE status IN ('aberta', 'pendente') AND customer_id IN (${clientesSql})`);
      } catch {}
      // Envios manuais futuros (botão "Repescagem") também caem.
      try { await db.execute(sql`DELETE FROM repescagem_forced WHERE customer_id IN (${clientesSql}) AND forced_date >= ${hoje}`); } catch {}

      res.json({ ok: true, tipo, refId, nome, canceladas: canc.length });
    } catch (e: any) {
      console.error("POST /api/repescagem/bloqueios", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });

  // Remover um bloqueio — admin. Os clientes voltam às regras normais no próximo cálculo.
  app.delete("/api/repescagem/bloqueios/:id", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureBloqueiosTable();
      const r = rowsOf(await db.execute(sql`DELETE FROM repescagem_bloqueios WHERE id = ${String(req.params.id)} RETURNING tipo, nome`));
      if (!r.length) return res.status(404).json({ message: "Bloqueio não encontrado." });
      res.json({ ok: true, tipo: r[0].tipo, nome: r[0].nome });
    } catch (e: any) {
      console.error("DELETE /api/repescagem/bloqueios/:id", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });
}
