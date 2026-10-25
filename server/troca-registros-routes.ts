// ============================================================================
// TROCAS — MOTIVO E DESCONTO DE COMISSÃO — 23/out/2026
// ---------------------------------------------------------------------------
// Política de trocas Honest (versão enxuta, aprovada por Flavio em 23/10/2026):
//   Motivos aceitos: fermentado, lacre, tampa (QUALIDADE) e vencido (COMERCIAL).
//   Toda troca exige foto (câmera ou galeria) — trava já existente no card.
//   Fermentado exige a temperatura lida no DISPLAY do refrigerador do cliente.
//
// TROCA POR VENCIMENTO é aceita como decisão comercial, mas a comissão sobre o
// valor trocado é descontada do vendedor:
//   valor da troca  = qtd trocada × preço unitário da ÚLTIMA NF de venda
//                     faturada para o MESMO cliente (fallback: preço do card)
//   % da comissão   = % aplicada ao vendedor que faturou essa NF, no mês da NF
//                     (collab_remuneracao_config 'fixo' → comissao_pct;
//                      'faixa' ou sem config → sales_goal_history.commission_pct)
//   desconto        = valor da troca × % ; lançado no MÊS DA TROCA, para o
//                     vendedor que faturou a NF.
// Trocas por qualidade ficam registradas (lote/análise), sem desconto.
//
// O desconto é abatido na Comissão Mês do Resumo Recebíveis e listado na aba
// "Descontos por troca" do módulo Metas.
//
// Tabela criada por CREATE TABLE IF NOT EXISTS no primeiro uso (o build de
// produção não roda db:push).
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { nfVendaFrom, nfVendaWhere, nfData, vendedorImplantou } from "./faturamento-oficial";

export const MOTIVOS_TROCA = ["fermentado", "lacre", "tampa", "vencido"] as const;
export type MotivoTroca = typeof MOTIVOS_TROCA[number];
export const MOTIVO_LABEL: Record<MotivoTroca, string> = {
  fermentado: "Fermentado",
  lacre: "Lacre",
  tampa: "Tampa",
  vencido: "Vencido",
};

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

let schemaReady: Promise<void> | null = null;
export function ensureTrocaSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS troca_registros (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "sales_card_id varchar NOT NULL, " +
        "customer_id varchar, customer_name varchar, " +
        "card_seller_id varchar, " +
        "motivo varchar NOT NULL, " +
        "categoria varchar NOT NULL, " +
        "temperatura_c numeric, " +
        "valor_troca numeric NOT NULL DEFAULT 0, " +
        "itens jsonb, " +
        "nf_id varchar, nf_numero varchar, nf_data date, " +
        "nf_seller_id varchar, nf_seller_name varchar, " +
        "comissao_pct numeric NOT NULL DEFAULT 0, " +
        "desconto numeric NOT NULL DEFAULT 0, " +
        "ym varchar(7) NOT NULL, " +
        "observacao text, " +
        "created_by varchar, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())"
      ));
      for (const ix of [
        // Card permanente é reaproveitado a cada pedido: um card pode ter VÁRIAS trocas ao longo do
        // tempo. A chave única por card (versão de 23/10) sobrescreveria a troca anterior.
        "DROP INDEX IF EXISTS ux_troca_registros_card",
        "CREATE INDEX IF NOT EXISTS idx_troca_registros_card ON troca_registros (sales_card_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_troca_registros_cliente ON troca_registros (customer_id, motivo, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_troca_registros_ym ON troca_registros (ym, nf_seller_id)",
      ]) await db.execute(sql.raw(ix)).catch(() => {});
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/** Mês corrente em Brasília, 'YYYY-MM'. */
function ymBrasil(d = new Date()): string {
  const s = d.toLocaleString("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });
  return s.slice(0, 7);
}

/** Desconto de troca por vendedor no mês (para o Resumo Recebíveis). */
export async function descontosTrocaPorVendedor(ym: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    await ensureTrocaSchema();
    const r: any = await db.execute(sql`
      SELECT nf_seller_id, COALESCE(SUM(desconto), 0) AS total
      FROM troca_registros WHERE ym = ${ym} AND motivo = 'vencido' AND nf_seller_id IS NOT NULL
      GROUP BY nf_seller_id`);
    for (const row of r.rows || []) out[String(row.nf_seller_id)] = n(row.total);
  } catch (e: any) {
    console.error("[TROCA] descontos por vendedor:", e?.message || e);
  }
  return out;
}

/** % de comissão aplicada ao vendedor no mês da NF. */
async function pctComissao(sellerId: string, ano: number, mes: number): Promise<number> {
  const ym = `${ano}-${String(mes).padStart(2, "0")}`;
  try {
    const c: any = await db.execute(sql`
      SELECT comissao_tipo, comissao_pct FROM collab_remuneracao_config
      WHERE user_id = ${sellerId} AND vigencia_ym <= ${ym}
      ORDER BY vigencia_ym DESC LIMIT 1`);
    const cfg = c.rows?.[0];
    if (cfg && cfg.comissao_tipo === "fixo") return n(cfg.comissao_pct);
    if (cfg && cfg.comissao_tipo === "nenhum") return 0;
  } catch { /* tabela pode não existir ainda — cai no histórico */ }
  try {
    const h: any = await db.execute(sql`
      SELECT commission_pct FROM sales_goal_history
      WHERE seller_id = ${sellerId} AND (year < ${ano} OR (year = ${ano} AND month <= ${mes}))
      ORDER BY year DESC, month DESC LIMIT 1`);
    return n(h.rows?.[0]?.commission_pct);
  } catch {
    return 0;
  }
}

const normalizar = (s: any) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Calcula (sem gravar) os dados da troca a partir do card. */
async function calcularTroca(card: any, motivo: MotivoTroca) {
  const produtos: any[] = Array.isArray(card.products) ? card.products : [];

  // Última NF de venda autorizada do mesmo cliente (pelo id do cliente ou CNPJ/CPF).
  let nf: any = null;
  if (card.customer_id) {
    const r: any = await db.execute(sql.raw(`
      SELECT fi.id, fi.invoice_number, to_char((${nfData("fi")})::date, 'YYYY-MM-DD') AS data, ${vendedorImplantou("fi")} AS seller_key
      FROM ${nfVendaFrom("fi")}
      WHERE ${nfVendaWhere("fi")}
        AND (fi.customer_id = '${String(card.customer_id).replace(/'/g, "''")}'
             OR (NULLIF(regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g'),'') IS NOT NULL
                 AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') IN (
                   SELECT regexp_replace(COALESCE(c.cnpj, c.cpf, ''),'[^0-9]','','g')
                   FROM customers c WHERE c.id = '${String(card.customer_id).replace(/'/g, "''")}')))
      ORDER BY ${nfData("fi")} DESC LIMIT 1`));
    nf = r.rows?.[0] || null;
  }

  // Vendedor da NF (id de usuário) e nome.
  let nfSellerId: string | null = null;
  let nfSellerName: string | null = null;
  const sellerKey = nf?.seller_key ? String(nf.seller_key) : null;
  const chave = sellerKey || (card.seller_id ? String(card.seller_id) : null);
  if (chave) {
    const u: any = await db.execute(sql`
      SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS nome FROM users
      WHERE id = ${chave} OR omie_vendor_code = ${chave} OR omie_vendor_code = ${chave.replace("omie-vendor-", "")}
      LIMIT 1`);
    nfSellerId = u.rows?.[0]?.id || null;
    nfSellerName = u.rows?.[0]?.nome || null;
  }

  // Preços da NF por produto.
  const precosNf: Array<{ product_id: string | null; nome: string; preco: number }> = [];
  if (nf?.id) {
    const it: any = await db.execute(sql`
      SELECT product_id, product_name, unit_price FROM fiscal_invoice_items WHERE invoice_id = ${nf.id}`);
    for (const row of it.rows || []) {
      precosNf.push({ product_id: row.product_id ? String(row.product_id) : null, nome: normalizar(row.product_name), preco: n(row.unit_price) });
    }
  }

  const itens = produtos.map((p) => {
    const qtd = n(p.quantity);
    const achado =
      precosNf.find((x) => x.product_id && String(p.id) === x.product_id) ||
      precosNf.find((x) => x.nome && x.nome === normalizar(p.name));
    const preco = achado ? achado.preco : n(p.unitPrice);
    return { produtoId: String(p.id ?? ""), produto: String(p.name ?? ""), quantidade: qtd, precoUnit: preco, fontePreco: achado ? "nf" : "card", valor: r2(qtd * preco) };
  });
  const valorTroca = r2(itens.reduce((s, i) => s + i.valor, 0));

  let pct = 0;
  if (motivo === "vencido" && nfSellerId) {
    const [a, m] = String(nf?.data || ymBrasil()).split("-").map(Number);
    pct = await pctComissao(nfSellerId, a, m);
  }
  const desconto = motivo === "vencido" ? r2((valorTroca * pct) / 100) : 0;

  return {
    itens, valorTroca, pct, desconto,
    nfId: nf?.id || null,
    nfNumero: nf?.invoice_number != null ? String(nf.invoice_number) : null,
    nfData: nf?.data ? String(nf.data) : null,
    nfSellerId, nfSellerName,
  };
}

/** Troca anterior do cliente pelo mesmo motivo, antes de `antesDe` (ou a mais recente). */
async function trocaAnterior(customerId: string | null, motivo: string, antesDe: { id: string; createdAt: string } | null) {
  if (!customerId || !motivo) return null;
  const r: any = antesDe
    ? await db.execute(sql`
        SELECT id, motivo, created_at, to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS data_br
        FROM troca_registros
        WHERE customer_id = ${customerId} AND motivo = ${motivo} AND id <> ${antesDe.id}
          AND created_at < ${antesDe.createdAt}::timestamptz
        ORDER BY created_at DESC LIMIT 1`)
    : await db.execute(sql`
        SELECT id, motivo, created_at, to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS data_br
        FROM troca_registros
        WHERE customer_id = ${customerId} AND motivo = ${motivo}
        ORDER BY created_at DESC LIMIT 1`);
  const x = r.rows?.[0];
  return x ? { id: String(x.id), motivo: String(x.motivo), data: x.created_at, dataBr: String(x.data_br), customerId } : null;
}

function podeVerEquipe(req: any): boolean {
  return ["admin", "coordinator", "administrative"].includes(req.currentUser?.role);
}

export function registerTrocaRegistrosRoutes(app: Express) {
  // Grava o motivo da troca do card (chamado pelo card de vendas ao finalizar).
  app.post("/api/sales-cards/:id/troca-motivo", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const { id } = req.params;
      const motivo = String(req.body?.motivo || "").toLowerCase() as MotivoTroca;
      if (!MOTIVOS_TROCA.includes(motivo)) {
        return res.status(400).json({ message: "Motivo da troca inválido. Use: Fermentado, Lacre, Tampa ou Vencido." });
      }
      let temperatura: number | null = null;
      if (motivo === "fermentado") {
        const t = Number(String(req.body?.temperatura ?? "").replace(",", "."));
        if (!Number.isFinite(t) || t < -30 || t > 60) {
          return res.status(400).json({ message: "Informe a temperatura lida no display do refrigerador." });
        }
        temperatura = t;
      }
      const c: any = await db.execute(sql`
        SELECT sc.id, sc.customer_id, sc.seller_id, sc.products, sc.notes,
               COALESCE(NULLIF(cu.fantasy_name,''), NULLIF(cu.company_name,''), cu.name) AS customer_name
        FROM sales_cards sc LEFT JOIN customers cu ON cu.id = sc.customer_id
        WHERE sc.id = ${id} LIMIT 1`);
      const card = c.rows?.[0];
      if (!card) return res.status(404).json({ message: "Card não encontrado" });

      const calc = await calcularTroca(card, motivo);
      const categoria = motivo === "vencido" ? "comercial" : "qualidade";
      const ym = ymBrasil();
      const user = req.currentUser;

      // Reenvio do MESMO pedido (o vendedor tenta de novo em poucas horas) atualiza o registro;
      // um pedido novo no mesmo card permanente gera registro novo.
      const recente: any = await db.execute(sql`
        SELECT id FROM troca_registros
        WHERE sales_card_id = ${id} AND created_at > now() - interval '6 hours'
        ORDER BY created_at DESC LIMIT 1`);
      const recenteId = recente.rows?.[0]?.id || null;
      // Troca anterior do mesmo cliente pelo mesmo motivo (aviso no card e no pipeline).
      const anterior = await trocaAnterior(card.customer_id, motivo,
        recenteId ? { id: String(recenteId), createdAt: new Date().toISOString() } : null);
      if (recenteId) {
        await db.execute(sql`
          UPDATE troca_registros SET
            motivo = ${motivo}, categoria = ${categoria}, temperatura_c = ${temperatura},
            valor_troca = ${calc.valorTroca}, itens = ${JSON.stringify(calc.itens)}::jsonb, nf_id = ${calc.nfId},
            nf_numero = ${calc.nfNumero}, nf_data = ${calc.nfData}, nf_seller_id = ${calc.nfSellerId},
            nf_seller_name = ${calc.nfSellerName}, comissao_pct = ${calc.pct},
            desconto = ${calc.desconto}, observacao = ${card.notes || null}, updated_at = now()
          WHERE id = ${recenteId}`);
      } else {
        await db.execute(sql`
          INSERT INTO troca_registros
            (sales_card_id, customer_id, customer_name, card_seller_id, motivo, categoria, temperatura_c,
             valor_troca, itens, nf_id, nf_numero, nf_data, nf_seller_id, nf_seller_name,
             comissao_pct, desconto, ym, observacao, created_by)
          VALUES (${id}, ${card.customer_id}, ${card.customer_name}, ${card.seller_id}, ${motivo}, ${categoria}, ${temperatura},
             ${calc.valorTroca}, ${JSON.stringify(calc.itens)}::jsonb, ${calc.nfId}, ${calc.nfNumero}, ${calc.nfData},
             ${calc.nfSellerId}, ${calc.nfSellerName}, ${calc.pct}, ${calc.desconto}, ${ym}, ${card.notes || null}, ${user?.id || null})`);
      }

      // Auditoria junto das fotos da troca.
      try {
        await db.execute(sql`INSERT INTO order_pipeline_audit (id, sales_card_id, outcome, error, created_at)
          VALUES (gen_random_uuid(), ${id}, 'troca_motivo', ${`${MOTIVO_LABEL[motivo]}${temperatura != null ? ` ${temperatura}°C` : ""} | desconto R$ ${calc.desconto.toFixed(2)}`}, now())`);
      } catch { /* auditoria nao bloqueia */ }

      return res.json({ ok: true, motivo, categoria, ...calc, anterior });
    } catch (e: any) {
      console.error("[TROCA] motivo:", e?.message || e);
      return res.status(500).json({ message: "Falha ao registrar o motivo da troca" });
    }
  });

  // Lista das trocas do mês (aba "Descontos por troca" do módulo Metas).
  // Vendedor/telemarketing veem apenas os próprios descontos.
  app.get("/api/trocas/descontos", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const ym = /^\d{4}-\d{2}$/.test(String(req.query?.ym || "")) ? String(req.query.ym) : ymBrasil();
      const soVencido = String(req.query?.todos || "") !== "1";
      const equipe = podeVerEquipe(req);
      const uid = String(req.currentUser?.id || "");
      const r: any = await db.execute(sql`
        SELECT id, sales_card_id, customer_id, customer_name, motivo, categoria, temperatura_c, valor_troca, itens,
               nf_numero, to_char(nf_data, 'YYYY-MM-DD') AS nf_data, nf_seller_id, nf_seller_name,
               comissao_pct, desconto, ym, created_at
        FROM troca_registros
        WHERE ym = ${ym}
          AND (${soVencido} = false OR motivo = 'vencido')
          AND (${equipe} = true OR nf_seller_id = ${uid} OR card_seller_id = ${uid})
        ORDER BY created_at DESC`);
      const registros = (r.rows || []).map((x: any) => ({
        id: x.id,
        salesCardId: x.sales_card_id,
        cliente: x.customer_name,
        motivo: x.motivo,
        categoria: x.categoria,
        temperatura: x.temperatura_c != null ? n(x.temperatura_c) : null,
        valorTroca: n(x.valor_troca),
        itens: x.itens || [],
        nfNumero: x.nf_numero,
        nfData: x.nf_data,
        vendedorId: x.nf_seller_id,
        vendedor: x.nf_seller_name,
        comissaoPct: n(x.comissao_pct),
        desconto: n(x.desconto),
        data: x.created_at,
      }));
      const porVendedor: Record<string, { vendedorId: string; vendedor: string; trocas: number; valorTroca: number; desconto: number }> = {};
      for (const x of registros) {
        if (x.motivo !== "vencido") continue;
        const k = x.vendedorId || "sem-vendedor";
        const v = (porVendedor[k] = porVendedor[k] || { vendedorId: k, vendedor: x.vendedor || "Sem vendedor", trocas: 0, valorTroca: 0, desconto: 0 });
        v.trocas++;
        v.valorTroca = r2(v.valorTroca + x.valorTroca);
        v.desconto = r2(v.desconto + x.desconto);
      }
      res.json({ ym, registros, porVendedor: Object.values(porVendedor).sort((a, b) => b.desconto - a.desconto) });
    } catch (e: any) {
      console.error("[TROCA] descontos:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar descontos por troca" });
    }
  });

  // Troca anterior pelo mesmo motivo.
  //  ?salesCardId=X          → pedido no pipeline (card-filho resolve para o card de origem)
  //  ?customerId=Y&motivo=Z  → card de vendas, enquanto o vendedor escolhe o motivo
  app.get("/api/trocas/anterior", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const salesCardId = String(req.query?.salesCardId || "").trim();
      if (salesCardId) {
        const sc: any = await db.execute(sql`
          SELECT id, parent_card_id, created_at FROM sales_cards WHERE id = ${salesCardId} LIMIT 1`);
        const card = sc.rows?.[0];
        if (!card) return res.json({ atual: null, anterior: null });
        const ids = [String(card.id)];
        if (card.parent_card_id) ids.push(String(card.parent_card_id));
        // Card-filho nasce logo DEPOIS do registro do motivo (gravado no card de origem):
        // limita ao registro feito até o nascimento do filho, para não pegar uma troca posterior.
        const limite = card.parent_card_id && card.created_at ? new Date(new Date(card.created_at).getTime() + 30 * 60000).toISOString() : null;
        const a: any = limite
          ? await db.execute(sql`
              SELECT id, customer_id, motivo, created_at FROM troca_registros
              WHERE sales_card_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) AND created_at <= ${limite}::timestamptz
              ORDER BY created_at DESC LIMIT 1`)
          : await db.execute(sql`
              SELECT id, customer_id, motivo, created_at FROM troca_registros
              WHERE sales_card_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
              ORDER BY created_at DESC LIMIT 1`);
        const atual = a.rows?.[0];
        if (!atual) return res.json({ atual: null, anterior: null });
        const createdAt = new Date(atual.created_at).toISOString();
        const anterior = await trocaAnterior(atual.customer_id, atual.motivo, { id: String(atual.id), createdAt });
        return res.json({ atual: { id: atual.id, motivo: atual.motivo, customerId: atual.customer_id }, anterior });
      }
      const customerId = String(req.query?.customerId || "").trim();
      const motivo = String(req.query?.motivo || "").toLowerCase();
      if (!customerId || !MOTIVOS_TROCA.includes(motivo as MotivoTroca)) return res.json({ anterior: null });
      return res.json({ anterior: await trocaAnterior(customerId, motivo, null) });
    } catch (e: any) {
      console.error("[TROCA] anterior:", e?.message || e);
      res.status(500).json({ message: "Falha ao consultar troca anterior" });
    }
  });

  // Trocas registradas do cliente (bloco "Trocas registradas" do Extrato do Cliente).
  app.get("/api/trocas/cliente/:customerId", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const r: any = await db.execute(sql`
        SELECT id, sales_card_id, motivo, categoria, temperatura_c, valor_troca, itens,
               nf_numero, to_char(nf_data, 'YYYY-MM-DD') AS nf_data, nf_seller_name, card_seller_id,
               comissao_pct, desconto, observacao, created_at
        FROM troca_registros WHERE customer_id = ${req.params.customerId}
        ORDER BY created_at DESC LIMIT 200`);
      const vend: any = await db.execute(sql`SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS nome FROM users`);
      const nomes = new Map<string, string>((vend.rows || []).map((u: any) => [String(u.id), String(u.nome || "")]));
      res.json((r.rows || []).map((x: any) => ({
        id: x.id,
        salesCardId: x.sales_card_id,
        motivo: x.motivo,
        categoria: x.categoria,
        temperatura: x.temperatura_c != null ? n(x.temperatura_c) : null,
        valorTroca: n(x.valor_troca),
        itens: x.itens || [],
        nfNumero: x.nf_numero,
        nfData: x.nf_data,
        vendedorNf: x.nf_seller_name,
        vendedorCard: x.card_seller_id ? nomes.get(String(x.card_seller_id)) || null : null,
        comissaoPct: n(x.comissao_pct),
        desconto: n(x.desconto),
        observacao: x.observacao,
        data: x.created_at,
      })));
    } catch (e: any) {
      console.error("[TROCA] cliente:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar trocas do cliente" });
    }
  });
}
