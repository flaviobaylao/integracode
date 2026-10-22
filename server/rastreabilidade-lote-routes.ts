// ---------------------------------------------------------------------------
// RASTREABILIDADE DE LOTE (Faturamentos › aba Rastreabilidade) — 22/out/2026
// ---------------------------------------------------------------------------
// Lista TODAS as notas fiscais faturadas que levaram o lote "X" (do produto "Y",
// opcional) e mostra a INSTÂNCIA que emitiu cada nota (IND, GYN, BSB, SERV).
//
// Regras do Flavio (22/out/2026):
//   - NÃO considerar transferências (IND→GYN 5151/1151, →BSB 5409/6409, 5152,
//     devolução de transferência 5208/5209 e qualquer natureza com "TRANSF",
//     inclusive a venda GYN→SERV "transferencia entre empresas do grupo").
//   - Considerar TODOS os outros tipos: venda, troca, amostra, bonificação,
//     devolução de venda (entrada), etc.
//
// Fontes (somente leitura):
//   fiscal_invoice_items.lot_number  → "H051026" ou, quando a baixa consumiu mais
//                                      de um lote, "H051026 (18) / H161026 (12)"
//   fiscal_invoice_items.product_name→ notas antigas sem lot_number têm o lote só
//                                      no nome ("... - Lote: H120626, h180626")
//   fiscal_invoices.omie_instance_id → instância emissora; fallback pelo CNPJ do
//                                      emitente casado com omie_instances.cnpj
//
// "Faturada" = NF-e de PRODUÇÃO autorizada ('authorized') ou autorizada e depois
// devolvida ('returned'). Canceladas só com ?incluirCanceladas=1. Rascunho,
// rejeitada e inutilizada nunca entram. Mesma NF registrada em duplicidade
// (CNPJ emitente + série + número + entrada/saída) aparece uma vez só.
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const PAPEIS = ["admin", "coordinator", "administrative"];

/** CFOPs de transferência (e devolução de transferência), sem ponto. */
export const CFOP_TRANSFERENCIA = [
  "5151", "5152", "5153", "5155", "5156", "5408", "5409", "5208", "5209",
  "6151", "6152", "6153", "6155", "6156", "6408", "6409", "6208", "6209",
  "1151", "1152", "1153", "1154", "1408", "1409", "1208", "1209",
  "2151", "2152", "2153", "2154", "2408", "2409", "2208", "2209",
];

/** Normaliza o número do lote para comparação: maiúsculo, sem espaços. */
export const normLote = (s: string) => String(s || "").toUpperCase().replace(/\s+/g, "").trim();

const rowsOf = (r: any): any[] => (r?.rows || r || []) as any[];
const num = (v: any) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** Trecho de SQL: texto do lote do item (coluna própria ou "Lote: ..." no nome). */
const LOTE_TXT = sql.raw(
  `COALESCE(NULLIF(TRIM(it.lot_number), ''), substring(it.product_name from '[Ll][Oo][Tt][Ee]:[[:space:]]*(.+)$'))`,
);
const CFOP_FORA = sql.raw(CFOP_TRANSFERENCIA.map((c) => `'${c}'`).join(","));

export function registerRastreabilidadeLoteRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(PAPEIS)];

  // Produtos que já saíram em NF com lote (para o seletor) e, se ?productId=,
  // os lotes conhecidos desse produto (NF + estoque) para sugerir no campo.
  app.get("/api/rastreabilidade-lote/opcoes", ...guard, async (req: any, res) => {
    try {
      const productId = req.query.productId ? String(req.query.productId) : null;
      const produtos = rowsOf(await db.execute(sql`
        SELECT p.id, p.name
          FROM products p
         WHERE p.id IN (SELECT l.product_id FROM inventory_lots l
                        UNION
                        SELECT it.product_id FROM fiscal_invoice_items it WHERE COALESCE(it.lot_number, '') <> '')
         ORDER BY p.name
      `)).map((p) => ({ id: String(p.id), name: String(p.name || "") }));

      let lotes: string[] = [];
      if (productId) {
        const r = rowsOf(await db.execute(sql`
          SELECT DISTINCT UPPER(TRIM(regexp_replace(t.tok, '[[:space:]]*[(].*$', ''))) AS lote
            FROM fiscal_invoice_items it
            JOIN fiscal_invoices fi ON fi.id = it.invoice_id
            , LATERAL regexp_split_to_table(${LOTE_TXT}, '[[:space:]]*[/,;][[:space:]]*') AS t(tok)
           WHERE it.product_id = ${productId} AND fi.environment = 'producao'
          UNION
          SELECT DISTINCT UPPER(TRIM(l.lot_number)) FROM inventory_lots l WHERE l.product_id = ${productId}
        `));
        lotes = Array.from(new Set(r.map((x) => String(x.lote || "").trim()).filter(Boolean)))
          .sort((a, b) => b.localeCompare(a));
      }
      res.json({ produtos, lotes });
    } catch (e: any) {
      console.error("[RASTREABILIDADE] opcoes:", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });

  // GET /api/rastreabilidade-lote?lote=H051026&productId=...&incluirCanceladas=1
  app.get("/api/rastreabilidade-lote", ...guard, async (req: any, res) => {
    try {
      const lote = String(req.query.lote || "").trim();
      if (normLote(lote).length < 2) return res.status(400).json({ message: "Informe o lote." });
      const productId = req.query.productId ? String(req.query.productId) : null;
      const incluirCanceladas = ["1", "true", "sim"].includes(String(req.query.incluirCanceladas || "").toLowerCase());
      const statuses = incluirCanceladas ? ["authorized", "returned", "cancelled"] : ["authorized", "returned"];
      const alvo = normLote(lote);
      const like = `%${lote.toUpperCase()}%`;

      const r = rowsOf(await db.execute(sql`
        WITH itens AS (
          SELECT fi.id AS invoice_id, fi.invoice_number, fi.series, fi.status, fi.operation_type,
                 fi.nature_of_operation, fi.fin_nfe, fi.customer_id, fi.customer_name, fi.customer_cnpj_cpf,
                 fi.customer_city, fi.customer_uf, fi.access_key, fi.issuer_cnpj, fi.issuer_name,
                 fi.omie_instance_id, fi.created_at, fi.cancellation_date,
                 COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) AS data_nf,
                 COALESCE(NULLIF(it.cfop, ''), fi.cfop) AS cfop,
                 it.id AS item_id, it.item_number, it.product_id, it.product_name,
                 it.quantity, it.unit_price, it.total_price,
                 ${LOTE_TXT} AS lote_txt
            FROM fiscal_invoice_items it
            JOIN fiscal_invoices fi ON fi.id = it.invoice_id
           WHERE fi.environment = 'producao'
             AND fi.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
             AND (${productId}::text IS NULL OR it.product_id = ${productId}::text)
             AND (UPPER(COALESCE(it.lot_number, '')) LIKE ${like} OR UPPER(it.product_name) LIKE ${like})
             AND regexp_replace(COALESCE(NULLIF(it.cfop, ''), fi.cfop, ''), '[^0-9]', '', 'g') NOT IN (${CFOP_FORA})
             AND UPPER(COALESCE(fi.nature_of_operation, '')) NOT LIKE '%TRANSF%'
        ), tok AS (
          SELECT i.*, t.tok, COUNT(*) OVER (PARTITION BY i.item_id) AS n_lotes
            FROM itens i, LATERAL regexp_split_to_table(i.lote_txt, '[[:space:]]*[/,;][[:space:]]*') AS t(tok)
        )
        SELECT tok.*,
               UPPER(regexp_replace(regexp_replace(tok.tok, '[[:space:]]*[(].*$', ''), '[[:space:]]+', '', 'g')) AS lote,
               NULLIF(replace(substring(tok.tok from '[(]([0-9.,]+)[)]'), ',', '.'), '')::numeric AS qtd_lote,
               COALESCE(oi.display_name, oi2.display_name) AS inst_nome,
               COALESCE(oi.id, oi2.id) AS inst_id,
               p.name AS produto_cadastro
          FROM tok
          LEFT JOIN omie_instances oi ON oi.id = tok.omie_instance_id
          LEFT JOIN omie_instances oi2 ON oi.id IS NULL
               AND COALESCE(oi2.cnpj, '') <> ''
               AND regexp_replace(oi2.cnpj, '[^0-9]', '', 'g') = regexp_replace(COALESCE(tok.issuer_cnpj, ''), '[^0-9]', '', 'g')
          LEFT JOIN products p ON p.id = tok.product_id
         WHERE UPPER(regexp_replace(regexp_replace(tok.tok, '[[:space:]]*[(].*$', ''), '[[:space:]]+', '', 'g')) = ${alvo}
         ORDER BY data_nf DESC, tok.invoice_number DESC, tok.item_number
      `));

      // Uma NF por (CNPJ emitente, série, número, entrada/saída): fica o registro mais recente.
      const chaveNf = (x: any) => [
        String(x.issuer_cnpj || "").replace(/\D/g, ""), String(x.series || ""),
        x.invoice_number != null ? String(x.invoice_number) : `id:${x.invoice_id}`, String(x.operation_type || "saida"),
      ].join("|");
      const vencedora = new Map<string, { id: string; created: number }>();
      for (const x of r) {
        const k = chaveNf(x), c = new Date(x.created_at).getTime();
        const v = vencedora.get(k);
        if (!v || c > v.created) vencedora.set(k, { id: String(x.invoice_id), created: c });
      }

      const linhas = r
        .filter((x) => vencedora.get(chaveNf(x))?.id === String(x.invoice_id))
        .map((x) => {
          const qtdItem = num(x.quantity);
          const nLotes = Number(x.n_lotes || 1);
          // Lote único no item → a quantidade do item é toda do lote.
          // Vários lotes com "(qtd)" → a quantidade do lote. Vários sem qtd → desconhecida.
          const qtdLote = x.qtd_lote != null ? num(x.qtd_lote) : nLotes === 1 ? qtdItem : null;
          const entrada = String(x.operation_type || "saida") === "entrada";
          return {
            invoiceId: String(x.invoice_id),
            numero: x.invoice_number != null ? Number(x.invoice_number) : null,
            serie: x.series ? String(x.series) : "",
            data: x.data_nf,
            status: String(x.status),
            tipo: entrada ? "entrada" : "saida",
            cfop: String(x.cfop || ""),
            natureza: String(x.nature_of_operation || ""),
            instancia: String(x.inst_nome || "") || "(não identificada)",
            instanciaId: x.inst_id ? String(x.inst_id) : null,
            emitenteCnpj: String(x.issuer_cnpj || ""),
            cliente: String(x.customer_name || ""),
            clienteId: x.customer_id ? String(x.customer_id) : null,
            clienteDoc: String(x.customer_cnpj_cpf || ""),
            cidade: [x.customer_city, x.customer_uf].filter(Boolean).join("/"),
            chave: String(x.access_key || ""),
            productId: x.product_id ? String(x.product_id) : null,
            produto: String(x.produto_cadastro || String(x.product_name || "").replace(/\s*-\s*lote:.*$/i, "")),
            lote: String(x.lote || ""),
            lotesDoItem: String(x.lote_txt || ""),
            qtdItem,
            qtdLote,
            // Sinal para o saldo: saída tira do mercado (+), entrada (devolução) volta (−).
            sinal: entrada ? -1 : 1,
            valorUnit: num(x.unit_price),
          };
        });

      res.json({ geradoEm: new Date().toISOString(), lote: alvo, productId, incluirCanceladas, linhas });
    } catch (e: any) {
      console.error("[RASTREABILIDADE] consulta:", e?.message);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });
}
