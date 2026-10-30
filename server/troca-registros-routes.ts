// ============================================================================
// TROCAS — MOTIVO E DESCONTO DE COMISSÃO — 23/out/2026
// ---------------------------------------------------------------------------
// Política de trocas Honest (versão enxuta, aprovada por Flavio em 23/10/2026):
//   Motivos aceitos: fermentado, lacre, tampa (QUALIDADE) e vencido (COMERCIAL).
//   Toda troca exige foto (câmera ou galeria) — trava já existente no card.
//   Fermentado exige FOTO do display de temperatura do refrigerador do cliente (25/10/2026:
//   a temperatura deixou de ser digitada). Motivo "avaria" (avaria/deformação/rótulo)
//   incluído em 25/10/2026.
//
// TROCA POR VENCIMENTO é aceita como decisão comercial, mas a comissão sobre o
// valor trocado é descontada do vendedor:
//   valor da troca  = qtd trocada × preço unitário da ÚLTIMA NF de venda
//                     faturada para o MESMO cliente (fallback: preço do card)
//   (26/10/2026) vendedor = QUEM REGISTROU o pedido de troca; NF = a última que ELE
//   faturou para o cliente (sem NF dele: última NF do cliente, só para o preço)
//   % da comissão   = % do registrante no mês dessa NF (sem NF dele: mês da troca)
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

export const MOTIVOS_TROCA = ["fermentado", "lacre", "tampa", "avaria", "vencido"] as const;
export type MotivoTroca = typeof MOTIVOS_TROCA[number];
export const MOTIVO_LABEL: Record<MotivoTroca, string> = {
  fermentado: "Fermentado",
  lacre: "Lacre",
  tampa: "Tampa",
  avaria: "Avaria / deformação / rótulo",
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
        // 26/10/2026: desconto passa a ser de quem registrou a troca (regra_versao 2).
        // sem DEFAULT: linhas antigas ficam NULL (= regra 1) e são recalculadas abaixo.
        "ALTER TABLE troca_registros ADD COLUMN IF NOT EXISTS regra_versao integer",
        "ALTER TABLE troca_registros ADD COLUMN IF NOT EXISTS nf_do_vendedor boolean",
        "ALTER TABLE troca_registros ADD COLUMN IF NOT EXISTS acao_cliente varchar",
        "ALTER TABLE troca_registros ADD COLUMN IF NOT EXISTS origem varchar",
        "CREATE TABLE IF NOT EXISTS troca_migracoes (nome varchar PRIMARY KEY, feito_em timestamptz DEFAULT now(), resultado text)",
      ]) await db.execute(sql.raw(ix)).catch(() => {});
      await recalcularRegraRegistrante().catch((e) => console.error("[TROCA] recalculo:", e?.message || e));
      // Trocas que já estavam no pipeline/bloqueados antes do motivo existir: registra uma vez
      // (em segundo plano, para não atrasar a primeira requisição).
      setTimeout(() => { backfillTrocasPipeline().catch((e) => console.error("[TROCA] backfill:", e?.message || e)); }, 5000);
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
/** Chaves com que um usuário aparece como vendedor da NF (id, código Omie, 'omie-vendor-<código>'). */
async function chavesDoUsuario(userId: string): Promise<{ chaves: string[]; nome: string | null }> {
  const u: any = await db.execute(sql`
    SELECT id, omie_vendor_code, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS nome
    FROM users WHERE id = ${userId} LIMIT 1`);
  const x = u.rows?.[0];
  if (!x) return { chaves: [userId], nome: null };
  const chaves = [String(x.id)];
  if (x.omie_vendor_code) chaves.push(String(x.omie_vendor_code), `omie-vendor-${x.omie_vendor_code}`);
  return { chaves, nome: x.nome || null };
}

/**
 * Calcula (sem gravar) os dados da troca.
 * REGRA (Flavio, 26/10/2026): o desconto cai para QUEM REGISTROU o pedido de troca, e o
 * valor/percentual vêm da ÚLTIMA NF que ESSE vendedor faturou para o cliente. Se ele nunca
 * vendeu para o cliente, usa a última NF do cliente (de qualquer vendedor) só para o preço,
 * e o percentual do próprio registrante no mês da troca.
 */
async function calcularTroca(card: any, motivo: MotivoTroca, registranteId: string | null) {
  const produtos: any[] = Array.isArray(card.products) ? card.products : [];
  const vendedorId = registranteId || (card.seller_id ? String(card.seller_id) : null);
  const { chaves, nome: vendedorNome } = vendedorId ? await chavesDoUsuario(vendedorId) : { chaves: [] as string[], nome: null };

  const esc = (v: string) => String(v).replace(/'/g, "''");
  const ultimaNf = async (soDoVendedor: boolean) => {
    if (!card.customer_id) return null;
    const filtroVend = soDoVendedor && chaves.length
      ? `WHERE x.seller_key IN (${chaves.map((k) => `'${esc(k)}'`).join(",")})`
      : "";
    const r: any = await db.execute(sql.raw(`
      SELECT * FROM (
        SELECT fi.id, fi.invoice_number, ${nfData("fi")} AS dt,
               to_char((${nfData("fi")})::date, 'YYYY-MM-DD') AS data, ${vendedorImplantou("fi")} AS seller_key
        FROM ${nfVendaFrom("fi")}
        WHERE ${nfVendaWhere("fi")}
          AND (fi.customer_id = '${esc(card.customer_id)}'
               OR (NULLIF(regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g'),'') IS NOT NULL
                   AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') IN (
                     SELECT regexp_replace(COALESCE(c.cnpj, c.cpf, ''),'[^0-9]','','g')
                     FROM customers c WHERE c.id = '${esc(card.customer_id)}')))
      ) x ${filtroVend}
      ORDER BY x.dt DESC LIMIT 1`));
    return r.rows?.[0] || null;
  };

  let nf: any = vendedorId ? await ultimaNf(true) : null;
  const nfDoVendedor = !!nf;
  if (!nf) nf = await ultimaNf(false);

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
    const qtd = n(p.quantity ?? p.quantidade);
    const pid = p.id ?? p.produtoId;
    const pnome = p.name ?? p.produto;
    const achado =
      precosNf.find((x) => x.product_id && String(pid) === x.product_id) ||
      precosNf.find((x) => x.nome && x.nome === normalizar(pnome));
    const preco = achado ? achado.preco : n(p.unitPrice ?? p.precoUnit);
    return { produtoId: String(pid ?? ""), produto: String(pnome ?? ""), quantidade: qtd, precoUnit: preco, fontePreco: achado ? "nf" : "card", valor: r2(qtd * preco) };
  });
  const valorTroca = r2(itens.reduce((s, i) => s + i.valor, 0));

  let pct = 0;
  if (motivo === "vencido" && vendedorId) {
    // % do registrante no mês da NF dele; sem NF dele para o cliente, o % dele no mês da troca.
    const [a, m] = String(nfDoVendedor ? nf.data : ymBrasil()).split("-").map(Number);
    pct = await pctComissao(vendedorId, a, m);
  }
  const desconto = motivo === "vencido" ? r2((valorTroca * pct) / 100) : 0;

  return {
    itens, valorTroca, pct, desconto,
    nfId: nf?.id || null,
    nfNumero: nf?.invoice_number != null ? String(nf.invoice_number) : null,
    nfData: nf?.data ? String(nf.data) : null,
    nfDoVendedor,
    // nf_seller_* = vendedor DESCONTADO (quem registrou a troca)
    nfSellerId: vendedorId,
    nfSellerName: vendedorNome,
  };
}

/**
 * Motivo deduzido do texto que o vendedor escreveu (observações), para trocas registradas
 * antes de 23/10/2026, quando o card ainda não tinha a lista de motivos. Sem palavra-chave
 * reconhecível, devolve null e a troca fica sem registro.
 */
export function motivoPorTexto(texto: string | null | undefined): MotivoTroca | null {
  const t = normalizar(texto);
  if (!t) return null;
  if (/ferment|estufad|azed|\bgas\b|gaseific|estourad|inchad/.test(t)) return "fermentado";
  if (/vencid|venceu|vencimento|validade|vencend|fora do prazo/.test(t)) return "vencido";
  if (/lacre/.test(t)) return "lacre";
  if (/tampa|vazand|vazament|vazou/.test(t)) return "tampa";
  if (/amassad|avaria|avariad|rotulo|deformad|quebrad|furad|danificad/.test(t)) return "avaria";
  return null;
}

/**
 * BACKFILL (30/10/2026): cria registro de troca para os pedidos de troca dos últimos 120 dias
 * (pipeline e bloqueados) que não têm registro, com o motivo deduzido das observações.
 * Assim os cards que já estão no pipeline mostram motivo e recorrência. Não gera desconto de
 * comissão (desconto 0, origem 'backfill'). Roda uma vez (troca_migracoes).
 */
export async function backfillTrocasPipeline(): Promise<{ criados: number; semMotivo: number; jaTinham: number } | null> {
  const NOME = "backfill_pipeline_v1";
  const ja: any = await db.execute(sql`SELECT 1 FROM troca_migracoes WHERE nome = ${NOME}`);
  if (ja.rows?.length) return null;
  const r: any = await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (x.sales_card_id, x.dia) x.* FROM (
        SELECT bp.sales_card_id, bp.customer_id, bp.customer_name, bp.seller_id, bp.sale_value AS valor, bp.products,
               COALESCE(NULLIF(bp.notes, ''), sc.notes) AS notas, bp.created_at,
               (bp.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia
        FROM billing_pipeline bp LEFT JOIN sales_cards sc ON sc.id = bp.sales_card_id
        WHERE LOWER(COALESCE(bp.operation_type, '')) = 'troca' AND bp.stage <> 'lixeira'
          AND bp.created_at >= now() - interval '120 days'
        UNION ALL
        SELECT bo.sales_card_id, bo.customer_id,
               COALESCE(NULLIF(cu.fantasy_name, ''), NULLIF(cu.company_name, ''), cu.name) AS customer_name,
               bo.seller_id, bo.total_amount AS valor, bo.products, sc.notes AS notas, bo.created_at,
               (bo.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia
        FROM blocked_orders bo
        LEFT JOIN sales_cards sc ON sc.id = bo.sales_card_id
        LEFT JOIN customers cu ON cu.id = bo.customer_id
        WHERE bo.operation_type::text = 'troca' AND bo.status::text IN ('blocked', 'released')
          AND bo.created_at >= now() - interval '120 days'
      ) x ORDER BY x.sales_card_id, x.dia, x.created_at
    ) y ORDER BY y.created_at`);
  let criados = 0, semMotivo = 0, jaTinham = 0;
  for (const o of (r.rows || []) as any[]) {
    try {
      // Já tem registro deste pedido (no próprio card ou no card de origem, no mesmo dia)?
      const ex: any = await db.execute(sql`
        SELECT 1 FROM troca_registros t
        WHERE (t.sales_card_id = ${o.sales_card_id}
               OR t.sales_card_id = (SELECT parent_card_id FROM sales_cards WHERE id = ${o.sales_card_id}))
          AND ABS(EXTRACT(EPOCH FROM (t.created_at - ${new Date(o.created_at).toISOString()}::timestamptz))) < 86400
        LIMIT 1`);
      if (ex.rows?.length) { jaTinham++; continue; }
      const motivo = motivoPorTexto(o.notas);
      if (!motivo) { semMotivo++; continue; }
      const prods = Array.isArray(o.products) ? o.products : [];
      const itens = prods.map((p: any) => ({
        produtoId: String(p.id ?? ""), produto: String(p.name ?? ""), quantidade: n(p.quantity),
        precoUnit: n(p.unitPrice), fontePreco: "pedido", valor: r2(n(p.quantity) * n(p.unitPrice)),
      }));
      const valor = n(o.valor) || r2(itens.reduce((s: number, i: any) => s + i.valor, 0));
      const ym = ymBrasil(new Date(o.created_at));
      await db.execute(sql`
        INSERT INTO troca_registros
          (sales_card_id, customer_id, customer_name, card_seller_id, motivo, categoria, valor_troca, itens,
           nf_seller_id, comissao_pct, desconto, ym, observacao, created_by, created_at, regra_versao, origem)
        VALUES (${o.sales_card_id}, ${o.customer_id}, ${o.customer_name}, ${o.seller_id}, ${motivo},
           ${motivo === "vencido" ? "comercial" : "qualidade"}, ${valor}, ${JSON.stringify(itens)}::jsonb,
           ${o.seller_id}, 0, 0, ${ym}, ${o.notas || null}, 'backfill', ${new Date(o.created_at).toISOString()}::timestamptz, 2, 'backfill')`);
      criados++;
    } catch (e: any) {
      console.error("[TROCA] backfill item", o.sales_card_id, e?.message || e);
    }
  }
  const resultado = JSON.stringify({ criados, semMotivo, jaTinham, total: (r.rows || []).length });
  await db.execute(sql`INSERT INTO troca_migracoes (nome, resultado) VALUES (${NOME}, ${resultado}) ON CONFLICT (nome) DO NOTHING`);
  console.log(`[TROCA] backfill do pipeline: ${resultado}`);
  return { criados, semMotivo, jaTinham };
}

/** Recalcula pela regra de 26/10 os registros de vencido gravados antes dela. Idempotente. */
async function recalcularRegraRegistrante(): Promise<void> {
  const r: any = await db.execute(sql`
    SELECT id, customer_id, card_seller_id, created_by, itens FROM troca_registros
    WHERE motivo = 'vencido' AND COALESCE(regra_versao, 1) < 2`);
  for (const x of r.rows || []) {
    try {
      const calc = await calcularTroca(
        { customer_id: x.customer_id, seller_id: x.card_seller_id, products: Array.isArray(x.itens) ? x.itens : [] },
        "vencido", x.created_by ? String(x.created_by) : null);
      await db.execute(sql`
        UPDATE troca_registros SET
          valor_troca = ${calc.valorTroca}, itens = ${JSON.stringify(calc.itens)}::jsonb, nf_id = ${calc.nfId},
          nf_numero = ${calc.nfNumero}, nf_data = ${calc.nfData}, nf_seller_id = ${calc.nfSellerId},
          nf_seller_name = ${calc.nfSellerName}, comissao_pct = ${calc.pct}, desconto = ${calc.desconto},
          nf_do_vendedor = ${calc.nfDoVendedor}, regra_versao = 2, updated_at = now()
        WHERE id = ${x.id}`);
      console.log(`[TROCA] registro ${x.id} recalculado pela regra do registrante: ${calc.nfSellerName} R$ ${calc.desconto}`);
    } catch (e: any) {
      console.error("[TROCA] recalculo", x.id, e?.message || e);
    }
  }
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

// ============================================================================
// RECORRÊNCIA DE TROCAS (30/10/2026) — mesmo cliente + mesmo motivo numa janela.
//   1ª na janela = normal · 2ª = alerta (vendedor informa a "Ação com o cliente")
//   3ª ou mais  = liberação no pipeline só por admin, com observação obrigatória.
//   A partir da 2ª, abre chamado para o gestor comercial.
// ============================================================================
export const JANELA_RECORRENCIA_DIAS = 60;
export const ACOES_CLIENTE = [
  "Orientei o armazenamento (−2 a 5 °C)",
  "Conferi o refrigerador do cliente",
  "Reduzi a quantidade do pedido",
  "Troquei o mix de sabores",
  "Outra (descrita nas observações)",
];
const DESTINOS_CHAMADO_RECORRENCIA = ["flavio", "cinthia"];
const JANELA_MS = JANELA_RECORRENCIA_DIAS * 86400000;
const dataBr = (d: any) => (d ? new Date(d).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null);
const ordinal = (k: number) => `${k}ª`;

/** Última compra do cliente: última NF de venda autorizada (data e valor). */
async function ultimaCompraCliente(customerId: string | null): Promise<{ data: string | null; valor: number; nf: string | null } | null> {
  if (!customerId) return null;
  const esc = (v: string) => String(v).replace(/'/g, "''");
  try {
    const r: any = await db.execute(sql.raw(`
      SELECT fi.invoice_number, fi.total_invoice, to_char((${nfData("fi")})::date, 'YYYY-MM-DD') AS data
      FROM ${nfVendaFrom("fi")}
      WHERE ${nfVendaWhere("fi")}
        AND (fi.customer_id = '${esc(customerId)}'
             OR (NULLIF(regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g'),'') IS NOT NULL
                 AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') IN (
                   SELECT regexp_replace(COALESCE(c.cnpj, c.cpf, ''),'[^0-9]','','g')
                   FROM customers c WHERE c.id = '${esc(customerId)}')))
      ORDER BY ${nfData("fi")} DESC LIMIT 1`));
    const x = r.rows?.[0];
    if (!x) return null;
    return { data: x.data ? String(x.data).split("-").reverse().join("/") : null, valor: n(x.total_invoice), nf: x.invoice_number != null ? String(x.invoice_number) : null };
  } catch (e: any) {
    console.error("[TROCA] ultima compra:", e?.message || e);
    return null;
  }
}

/** Trocas do cliente pelo motivo, ANTES de `ate` (exclui `excluirId`), mais recentes primeiro. */
async function trocasDoMotivo(customerId: string, motivo: string, ate: Date, excluirId: string | null) {
  const r: any = await db.execute(sql`
    SELECT id, created_at, valor_troca, itens, acao_cliente FROM troca_registros
    WHERE customer_id = ${customerId} AND motivo = ${motivo}
      AND created_at <= ${ate.toISOString()}::timestamptz
      AND id <> ${excluirId || ""}
    ORDER BY created_at DESC LIMIT 50`);
  return (r.rows || []) as any[];
}

/** Resumo de recorrência para uma troca que acontece em `ate`. */
async function resumoRecorrencia(customerId: string, motivo: string, ate: Date, excluirId: string | null) {
  const ant = await trocasDoMotivo(customerId, motivo, ate, excluirId);
  const naJanela = ant.filter((x) => ate.getTime() - new Date(x.created_at).getTime() <= JANELA_MS).length;
  const nOrdem = naJanela + 1; // esta troca inclusa
  const ultima = ant[0] || null;
  return {
    motivo,
    motivoLabel: MOTIVO_LABEL[motivo as MotivoTroca] || motivo,
    janelaDias: JANELA_RECORRENCIA_DIAS,
    n: nOrdem,
    ordinal: ordinal(nOrdem),
    nivel: nOrdem >= 3 ? "alta" : nOrdem === 2 ? "atencao" : "normal",
    exigeAcao: nOrdem >= 2,
    exigeObsAdmin: nOrdem >= 3,
    ultimaData: ultima ? dataBr(ultima.created_at) : null,
    hist: ant.slice(0, 3).map((x) => ({
      data: dataBr(x.created_at),
      valor: n(x.valor_troca),
      itens: (Array.isArray(x.itens) ? x.itens : []).map((i: any) => `${n(i.quantidade)} × ${i.produto}`).join(" · "),
      acao: x.acao_cliente || null,
    })),
  };
}

/** Registro de troca correspondente a um card (card-filho resolve para o card de origem). */
async function registroDoCard(cardId: string): Promise<any | null> {
  const sc: any = await db.execute(sql`SELECT id, parent_card_id, created_at FROM sales_cards WHERE id = ${cardId} LIMIT 1`);
  const card = sc.rows?.[0];
  if (!card) return null;
  const ids = [String(card.id)];
  if (card.parent_card_id) ids.push(String(card.parent_card_id));
  const limite = card.parent_card_id && card.created_at ? new Date(new Date(card.created_at).getTime() + 30 * 60000).toISOString() : null;
  const a: any = limite
    ? await db.execute(sql`
        SELECT * FROM troca_registros
        WHERE sales_card_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) AND created_at <= ${limite}::timestamptz
        ORDER BY created_at DESC LIMIT 1`)
    : await db.execute(sql`
        SELECT * FROM troca_registros
        WHERE sales_card_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
        ORDER BY created_at DESC LIMIT 1`);
  return a.rows?.[0] || null;
}

/** Recorrência por card (selo do pipeline / bloqueados e trava de liberação).
 *  Em lote (3 consultas no total), porque roda a cada carga do pipeline. */
export async function recorrenciaPorCards(cardIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const ids = Array.from(new Set(cardIds.filter(Boolean).map(String)));
  if (!ids.length) return out;
  try {
    await ensureTrocaSchema();
    const lst = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
    const sc: any = await db.execute(sql`SELECT id, parent_card_id, created_at FROM sales_cards WHERE id IN (${lst(ids)})`);
    const cards = new Map<string, any>((sc.rows || []).map((c: any) => [String(c.id), c]));
    const todos = new Set<string>(ids);
    for (const c of Array.from(cards.values())) if (c.parent_card_id) todos.add(String(c.parent_card_id));
    const rg: any = await db.execute(sql`SELECT * FROM troca_registros WHERE sales_card_id IN (${lst(Array.from(todos))}) ORDER BY created_at DESC`);
    const porCard = new Map<string, any[]>();
    for (const r of rg.rows || []) { const k = String(r.sales_card_id); (porCard.get(k) || porCard.set(k, []).get(k)!).push(r); }
    const atual = new Map<string, any>();
    for (const id of ids) {
      const c = cards.get(id);
      if (!c) continue;
      let cand = [...(porCard.get(id) || []), ...(c.parent_card_id ? porCard.get(String(c.parent_card_id)) || [] : [])];
      if (c.parent_card_id && c.created_at) {
        const lim = new Date(c.created_at).getTime() + 30 * 60000;
        cand = cand.filter((r) => new Date(r.created_at).getTime() <= lim);
      }
      cand.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (cand[0]?.customer_id) atual.set(id, cand[0]);
    }
    if (!atual.size) return out;
    const clientes = Array.from(new Set(Array.from(atual.values()).map((r) => String(r.customer_id))));
    const hs: any = await db.execute(sql`
      SELECT id, customer_id, motivo, created_at FROM troca_registros
      WHERE customer_id IN (${lst(clientes)}) AND created_at >= now() - interval '400 days'`);
    const hist = (hs.rows || []) as any[];
    for (const [id, reg] of Array.from(atual.entries())) {
      const t = new Date(reg.created_at).getTime();
      const ant = hist
        .filter((h) => String(h.customer_id) === String(reg.customer_id) && h.motivo === reg.motivo && String(h.id) !== String(reg.id) && new Date(h.created_at).getTime() <= t)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const nOrdem = ant.filter((h) => t - new Date(h.created_at).getTime() <= JANELA_MS).length + 1;
      out.set(id, {
        motivo: reg.motivo,
        motivoLabel: MOTIVO_LABEL[reg.motivo as MotivoTroca] || reg.motivo,
        janelaDias: JANELA_RECORRENCIA_DIAS,
        n: nOrdem,
        ordinal: ordinal(nOrdem),
        nivel: nOrdem >= 3 ? "alta" : nOrdem === 2 ? "atencao" : "normal",
        exigeObsAdmin: nOrdem >= 3,
        ultimaData: ant[0] ? dataBr(ant[0].created_at) : null,
        acao: reg.acao_cliente || null,
        registroId: reg.id,
        customerId: reg.customer_id,
      });
    }
  } catch (e: any) {
    console.error("[TROCA] recorrencia por cards:", e?.message || e);
  }
  return out;
}

export function registerTrocaRegistrosRoutes(app: Express) {
  // Garante o esquema (e o registro retroativo das trocas do pipeline) logo após o boot.
  setTimeout(() => { ensureTrocaSchema().catch((e) => console.error("[TROCA] schema no boot:", e?.message || e)); }, 20000);
  // Grava o motivo da troca do card (chamado pelo card de vendas ao finalizar).
  // PRÉVIA do desconto (card de vendas, antes de finalizar): mesma conta do registro,
  // com os produtos que estão na tela (ainda não gravados no card). Não grava nada.
  app.post("/api/sales-cards/:id/troca-previa", authenticateUser, async (req: any, res) => {
    try {
      const c: any = await db.execute(sql`
        SELECT id, customer_id, seller_id, products FROM sales_cards WHERE id = ${req.params.id} LIMIT 1`);
      const card = c.rows?.[0];
      if (!card) return res.status(404).json({ message: "Card não encontrado" });
      const produtos = Array.isArray(req.body?.products) ? req.body.products : card.products;
      const calc = await calcularTroca({ ...card, products: produtos }, "vencido", req.currentUser?.id ? String(req.currentUser.id) : null);
      return res.json(calc);
    } catch (e: any) {
      console.error("[TROCA] previa:", e?.message || e);
      return res.status(500).json({ message: "Falha ao calcular a prévia do desconto" });
    }
  });

  app.post("/api/sales-cards/:id/troca-motivo", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const { id } = req.params;
      const motivo = String(req.body?.motivo || "").toLowerCase() as MotivoTroca;
      if (!MOTIVOS_TROCA.includes(motivo)) {
        return res.status(400).json({ message: "Motivo da troca inválido. Use: Fermentado, Lacre, Tampa, Avaria/deformação/rótulo ou Vencido." });
      }
      // Temperatura não é mais digitada: no fermentado a prova é a FOTO do display do
      // refrigerador. Mantido opcional para compatibilidade com apps ainda em cache.
      let temperatura: number | null = null;
      if (motivo === "fermentado" && req.body?.temperatura != null && String(req.body.temperatura).trim() !== "") {
        const t = Number(String(req.body.temperatura).replace(",", "."));
        if (Number.isFinite(t) && t >= -30 && t <= 60) temperatura = t;
      }
      const c: any = await db.execute(sql`
        SELECT sc.id, sc.customer_id, sc.seller_id, sc.products, sc.notes,
               COALESCE(NULLIF(cu.fantasy_name,''), NULLIF(cu.company_name,''), cu.name) AS customer_name
        FROM sales_cards sc LEFT JOIN customers cu ON cu.id = sc.customer_id
        WHERE sc.id = ${id} LIMIT 1`);
      const card = c.rows?.[0];
      if (!card) return res.status(404).json({ message: "Card não encontrado" });

      const user = req.currentUser;
      const acaoCliente = String(req.body?.acaoCliente || "").trim().slice(0, 200) || null;
      const calc = await calcularTroca(card, motivo, user?.id ? String(user.id) : null);
      const categoria = motivo === "vencido" ? "comercial" : "qualidade";
      const ym = ymBrasil();

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
            desconto = ${calc.desconto}, observacao = ${card.notes || null}, nf_do_vendedor = ${calc.nfDoVendedor},
            acao_cliente = COALESCE(${acaoCliente}, acao_cliente),
            regra_versao = 2, created_by = COALESCE(created_by, ${user?.id || null}), updated_at = now()
          WHERE id = ${recenteId}`);
      } else {
        await db.execute(sql`
          INSERT INTO troca_registros
            (sales_card_id, customer_id, customer_name, card_seller_id, motivo, categoria, temperatura_c,
             valor_troca, itens, nf_id, nf_numero, nf_data, nf_seller_id, nf_seller_name,
             comissao_pct, desconto, ym, observacao, created_by, nf_do_vendedor, regra_versao, acao_cliente)
          VALUES (${id}, ${card.customer_id}, ${card.customer_name}, ${card.seller_id}, ${motivo}, ${categoria}, ${temperatura},
             ${calc.valorTroca}, ${JSON.stringify(calc.itens)}::jsonb, ${calc.nfId}, ${calc.nfNumero}, ${calc.nfData},
             ${calc.nfSellerId}, ${calc.nfSellerName}, ${calc.pct}, ${calc.desconto}, ${ym}, ${card.notes || null}, ${user?.id || null}, ${calc.nfDoVendedor}, 2, ${acaoCliente})`);
      }

      // Recorrência: a partir da 2ª troca do mesmo motivo na janela, chamado ao gestor comercial
      // (só no registro novo — reenvio do mesmo pedido não abre outro).
      let recorrencia: any = null;
      try {
        recorrencia = card.customer_id ? await resumoRecorrencia(String(card.customer_id), motivo, new Date(), recenteId ? String(recenteId) : null) : null;
        if (recorrencia && recorrencia.n >= 2 && !recenteId) {
          const { abrirChamadoSistema } = await import("./chamados-routes");
          const ult = await ultimaCompraCliente(card.customer_id);
          const quem = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "vendedor";
          const linhas = [
            `${recorrencia.ordinal} troca por ${recorrencia.motivoLabel} em ${JANELA_RECORRENCIA_DIAS} dias — cliente ${card.customer_name || ""}.`,
            `Data última troca: ${recorrencia.ultimaData || "—"}.`,
            `Esta troca: R$ ${calc.valorTroca.toFixed(2).replace(".", ",")}${ult ? ` · última compra ${ult.data}: R$ ${ult.valor.toFixed(2).replace(".", ",")}` : ""}.`,
            `Vendedor: ${quem} · ação com o cliente: ${acaoCliente || "não informada"}.`,
            recorrencia.n >= 3 ? "Liberação no pipeline só por admin, com observação." : "",
          ].filter(Boolean);
          await abrirChamadoSistema({
            destinoKeys: DESTINOS_CHAMADO_RECORRENCIA,
            assunto: `NOTIFICACAO - TROCA RECORRENTE - ${String(card.customer_name || "CLIENTE").toUpperCase()} - ${recorrencia.motivoLabel.toUpperCase()}`,
            descricao: linhas.join("\n"),
            prioridade: recorrencia.n >= 3 ? "Urgente" : "Normal",
            autor: user?.id ? { id: String(user.id), nome: quem, role: String(user.role || "") } : null,
          });
        }
      } catch (e: any) { console.error("[TROCA] chamado recorrencia:", e?.message || e); }

      // Auditoria junto das fotos da troca.
      try {
        await db.execute(sql`INSERT INTO order_pipeline_audit (id, sales_card_id, outcome, error, created_at)
          VALUES (gen_random_uuid(), ${id}, 'troca_motivo', ${`${MOTIVO_LABEL[motivo]}${temperatura != null ? ` ${temperatura}°C` : ""} | desconto R$ ${calc.desconto.toFixed(2)}`}, now())`);
      } catch { /* auditoria nao bloqueia */ }

      return res.json({ ok: true, motivo, categoria, ...calc, anterior, recorrencia });
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
        WHERE ym = ${ym} AND COALESCE(origem, '') <> 'backfill'
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

  // Recorrência da troca (30/10/2026).
  //  ?customerId=&motivo=  → card de vendas, antes de finalizar (esta troca conta como a próxima)
  //  ?salesCardId=         → pedido no pipeline / bloqueados
  app.get("/api/trocas/recorrencia", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const salesCardId = String(req.query?.salesCardId || "").trim();
      if (salesCardId) {
        const reg = await registroDoCard(salesCardId);
        if (!reg || !reg.customer_id) return res.json({ recorrencia: null });
        const r = await resumoRecorrencia(String(reg.customer_id), String(reg.motivo), new Date(reg.created_at), String(reg.id));
        const ultimaCompra = await ultimaCompraCliente(String(reg.customer_id));
        return res.json({ recorrencia: { ...r, acao: reg.acao_cliente || null, valorTroca: n(reg.valor_troca), customerId: reg.customer_id, ultimaCompra } });
      }
      const customerId = String(req.query?.customerId || "").trim();
      const motivo = String(req.query?.motivo || "").toLowerCase();
      if (!customerId || !MOTIVOS_TROCA.includes(motivo as MotivoTroca)) return res.json({ recorrencia: null });
      const r = await resumoRecorrencia(customerId, motivo, new Date(), null);
      const ultimaCompra = await ultimaCompraCliente(customerId);
      return res.json({ recorrencia: { ...r, customerId, ultimaCompra }, acoes: ACOES_CLIENTE });
    } catch (e: any) {
      console.error("[TROCA] recorrencia:", e?.message || e);
      res.status(500).json({ message: "Falha ao consultar a recorrência da troca" });
    }
  });

  // Clientes com troca recorrente: mesmo cliente + mesmo motivo com 2+ trocas na janela.
  app.get("/api/trocas/recorrentes", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const dias = Math.min(365, Math.max(7, parseInt(String(req.query?.dias || JANELA_RECORRENCIA_DIAS), 10) || JANELA_RECORRENCIA_DIAS));
      const equipe = podeVerEquipe(req);
      const uid = String(req.currentUser?.id || "");
      const r: any = await db.execute(sql`
        SELECT t.customer_id, MAX(t.customer_name) AS customer_name, t.motivo,
               COUNT(*)::int AS qtd, SUM(t.valor_troca) AS valor,
               MIN(t.created_at) AS primeira, MAX(t.created_at) AS ultima,
               (ARRAY_AGG(COALESCE(t.nf_seller_name, '') ORDER BY t.created_at DESC))[1] AS vendedor,
               (ARRAY_AGG(t.nf_seller_id ORDER BY t.created_at DESC))[1] AS vendedor_id,
               (ARRAY_AGG(t.acao_cliente ORDER BY t.created_at DESC))[1] AS acao
        FROM troca_registros t
        WHERE t.created_at >= now() - make_interval(days => ${dias}::int) AND t.customer_id IS NOT NULL
        GROUP BY t.customer_id, t.motivo
        HAVING COUNT(*) >= 2
        ORDER BY COUNT(*) DESC, MAX(t.created_at) DESC`);
      let lista = (r.rows || []) as any[];
      if (!equipe) lista = lista.filter((x) => String(x.vendedor_id || "") === uid);
      const out = [];
      for (const x of lista) {
        const qtd = Number(x.qtd) || 0;
        const intervalo = qtd > 1 ? Math.round((new Date(x.ultima).getTime() - new Date(x.primeira).getTime()) / 86400000 / (qtd - 1)) : null;
        const ult = await ultimaCompraCliente(String(x.customer_id));
        out.push({
          customerId: x.customer_id,
          cliente: x.customer_name,
          motivo: x.motivo,
          motivoLabel: MOTIVO_LABEL[x.motivo as MotivoTroca] || x.motivo,
          qtd,
          ordinal: ordinal(qtd),
          nivel: qtd >= 3 ? "alta" : "atencao",
          intervaloDias: intervalo,
          ultima: dataBr(x.ultima),
          valorTrocado: n(x.valor),
          ultimaCompra: ult,
          vendedor: x.vendedor || null,
          acao: x.acao || null,
        });
      }
      res.json({ dias, clientes: out });
    } catch (e: any) {
      console.error("[TROCA] recorrentes:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar trocas recorrentes" });
    }
  });

  // Resultado do registro retroativo das trocas que já estavam no pipeline (admin).
  app.get("/api/trocas/backfill-status", authenticateUser, async (req: any, res) => {
    try {
      await ensureTrocaSchema();
      const r: any = await db.execute(sql`SELECT nome, feito_em, resultado FROM troca_migracoes ORDER BY feito_em DESC`);
      const c: any = await db.execute(sql`SELECT motivo, COUNT(*)::int AS qtd FROM troca_registros WHERE origem = 'backfill' GROUP BY motivo ORDER BY 2 DESC`);
      res.json({ migracoes: r.rows || [], porMotivo: c.rows || [] });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "falha" });
    }
  });
}
