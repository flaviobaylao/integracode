// server/gestao-debito-vendas-routes.ts
// -----------------------------------------------------------------------------
// GESTAO — DEBITO VENCIDO E VARIACAO DE VENDAS POR CARTEIRA  (tela /gestao-debito-vendas)
//
// Um unico endpoint read-only que devolve, por CLIENTE (a tela agrega por
// carteira e monta os rankings):
//   1. DEBITO VENCIDO de hoje  — estoque, nao fluxo: tudo que ja venceu e
//      continua em aberto, com o aging (1-30 / 31-60 / 61-90 / 90+ dias).
//   2. VENDAS da janela escolhida (padrao 30 dias) x janela imediatamente
//      anterior de mesmo tamanho, para ranquear MAIORES QUEDAS e MAIORES GANHOS.
//
// As duas reguas sao as MESMAS ja usadas em /api/reports/gestao-carteiras
// (server/carteira-routes.ts), de proposito — os numeros das duas telas tem de
// fechar entre si:
//   * VENCIDO   = status 'vencida' OU 'a_vencer' com due_date ja passado no fuso
//                 de Brasilia, e (amount - amount_paid) > 0.
//   * VENDA     = titulo emitido (`receivables.issue_date`), fora cancelados,
//                 fora empresas do grupo/BARUC, fora categorias que nao sao venda
//                 (aporte, emprestimo, devolucao, troca, amostra, bonificacao,
//                 transferencia...), fora titulo amarrado a NF que nao e venda
//                 (nfVendaWhere) e fora pedido na lixeira do pipeline.
//   * CARTEIRA  = `customers.seller_id` -> nome do vendedor em `users`. Titulo
//                 sem documento (ou de documento que nao esta em `customers`)
//                 cai em "Sem carteira", nunca e distribuido por rateio.
//
// Chave do cliente = CPF/CNPJ so-digitos; sem documento, o nome normalizado —
// mesmo criterio do extrato do cliente e da Gestao de Carteiras.
//
// Escopo: vendedor e telemarketing so enxergam a propria carteira (corte no
// servidor, nao na tela). Demais papeis veem todas as carteiras.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { nfVendaWhere } from "./faturamento-oficial";
import { authenticateUser } from "./authMiddleware";

const TZ = "America/Sao_Paulo";

/** 'YYYY-MM-DD' de hoje no fuso de Brasilia. */
function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

/** Soma (ou subtrai) dias de uma data 'YYYY-MM-DD' sem passar pelo fuso local. */
function addDias(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function registerGestaoDebitoVendas(app: Express) {
  // GET /api/gestao/debito-e-vendas?dias=30&ate=YYYY-MM-DD
  app.get("/api/gestao/debito-e-vendas", authenticateUser, async (req: Request, res: Response) => {
    try {
      // ── JANELA ──────────────────────────────────────────────────────────────
      // `dias` = tamanho da janela (7 a 365; padrao 30). A janela anterior tem
      // exatamente o mesmo tamanho e termina na vespera do inicio da atual, para
      // a comparacao nao ficar torta.
      const reDate = /^\d{4}-\d{2}-\d{2}$/;
      const hoje = hojeBR();
      const diasBruto = parseInt(String(req.query.dias ?? "30"), 10);
      const dias = Number.isFinite(diasBruto) ? Math.min(365, Math.max(7, diasBruto)) : 30;
      const ate = reDate.test(String(req.query.ate)) && String(req.query.ate) <= hoje ? String(req.query.ate) : hoje;
      const de = addDias(ate, -(dias - 1));
      const ateAnt = addDias(de, -1);
      const deAnt = addDias(ateAnt, -(dias - 1));

      // ── ESCOPO DE QUEM ESTA OLHANDO ─────────────────────────────────────────
      // Mesmo corte da Gestao de Carteiras: vendedor/telemarketing so ve a
      // propria carteira, inclusive quem chamar o endpoint na mao. Um vendedor
      // pode ter varios ids (duplicatas do Omie), entao expandimos id + codigos
      // de vendedor + a forma sintetica 'omie-vendor-<codigo>'.
      const usuario: any = (req as any).currentUser || (req as any).user || null;
      const papel = String(usuario?.role || "");
      const restrito = ["vendedor", "telemarketing"].includes(papel);
      const limpaId = (x: any) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "");
      const idsCarteira: string[] = [];
      if (restrito) {
        const add = (x: any) => { const v = limpaId(x); if (v && !idsCarteira.includes(v)) idsCarteira.push(v); };
        add(usuario?.id);
        const codigos: any[] = [];
        if (usuario?.omieVendorCode) codigos.push(usuario.omieVendorCode);
        const mapaCodigos = usuario?.omieVendorCodes;
        if (mapaCodigos && typeof mapaCodigos === "object") {
          for (const v of Object.values(mapaCodigos)) if (v) codigos.push(v);
        }
        for (const c of codigos) { add(c); add(`omie-vendor-${limpaId(c)}`); }
        if (!idsCarteira.length) idsCarteira.push("__sem_carteira__");
      }
      const FILTRO_SELLER = restrito
        ? ` AND c.seller_id IN (${idsCarteira.map((i) => `'${i}'`).join(",")})`
        : "";

      // ── O QUE NAO E FATURAMENTO DE VENDA ────────────────────────────────────
      // Copia fiel da regua de server/carteira-routes.ts (ver comentario la).
      const CNPJS_GRUPO = ["28295493000153", "28295493000234", "28295493000315", "52921727000105"];
      const CNPJS_NAO_CLIENTE = ["14877972000173"]; // BARUC BRASILIA TRANSPORTE E ARMAZENAGEM
      const DOCS_FORA = [...CNPJS_GRUPO, ...CNPJS_NAO_CLIENTE];
      const C_GRUPO = `(COALESCE(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') IN (${DOCS_FORA.map((c) => `'${c}'`).join(",")})
                        OR UPPER(COALESCE(customer_name,'')) ~ '(^|[^A-Z])(PURO|BARUC)([^A-Z]|$)')`;
      const C_CATEGORIA = `(UPPER(COALESCE(category,'')) ~ '(APORTE|SOCIO|SÓCIO|EMPREST|ADIANT|DEVOLU|TROCA|AMOSTRA|BONIFICA|BRINDE|DOACAO|DOAÇÃO|REMESSA|TRANSFER)'
                            OR TRIM(COALESCE(category,'')) ~ '^[0-9]+([.-][0-9]+)*$')`;
      const C_NF_INVALIDA = `(receivables.fiscal_invoice_id IS NOT NULL AND NOT EXISTS (
                                SELECT 1 FROM fiscal_invoices fx
                                WHERE fx.id = receivables.fiscal_invoice_id AND ${nfVendaWhere("fx")}))`;
      const C_LIXEIRA = `EXISTS (SELECT 1 FROM billing_pipeline bpx
                                 WHERE bpx.id = receivables.billing_pipeline_id AND bpx.stage = 'lixeira')`;
      const FILTRO_VENDA = `
            AND NOT (${C_GRUPO})
            AND NOT ${C_CATEGORIA}
            AND NOT ${C_NF_INVALIDA}
            AND NOT ${C_LIXEIRA}`;

      // ── CARTEIRA POR DOCUMENTO ──────────────────────────────────────────────
      // Um mesmo CNPJ pode ter mais de um cadastro (duplicata antiga). Fica o
      // cadastro ATIVO mais recente — e a carteira que responde pelo cliente hoje.
      // O seller_id sintetico 'omie-vendor-<codigo>' nao existe em users.id: cai
      // no LATERAL, que procura o codigo dentro de users.omie_vendor_codes.
      const CTE_CLI = `
        cli AS (
          SELECT DISTINCT ON (doc) doc, carteira, cliente, cidade
          FROM (
            SELECT
              NULLIF(regexp_replace(COALESCE(NULLIF(c.cnpj,''),NULLIF(c.cpf,''),''),'[^0-9]','','g'),'') AS doc,
              COALESCE(
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''),
                NULLIF(TRIM(CONCAT_WS(' ', ov.first_name, ov.last_name)),''),
                'Sem carteira'
              ) AS carteira,
              NULLIF(TRIM(c.name),'') AS cliente,
              NULLIF(TRIM(COALESCE(c.city,'')),'') AS cidade,
              COALESCE(c.is_active, false) AS ativo,
              c.updated_at AS upd
            FROM customers c
            LEFT JOIN users u ON u.id = c.seller_id
            LEFT JOIN LATERAL (
              SELECT u2.first_name, u2.last_name
              FROM users u2
              WHERE c.seller_id LIKE 'omie-vendor-%'
                AND EXISTS (
                  SELECT 1 FROM jsonb_each_text(COALESCE(u2.omie_vendor_codes, '{}'::jsonb)) e
                  WHERE e.value = replace(c.seller_id, 'omie-vendor-', '')
                )
              ORDER BY u2.is_active DESC, u2.updated_at DESC NULLS LAST
              LIMIT 1
            ) ov ON TRUE
            WHERE COALESCE(c.is_supplier, false) = false${FILTRO_SELLER}
          ) x
          WHERE doc IS NOT NULL
          ORDER BY doc, ativo DESC, upd DESC NULLS LAST
        )`;

      // Quando o usuario e restrito, so os titulos da carteira dele entram.
      const SO_MINHA = restrito ? ` AND r.doc IN (SELECT doc FROM cli)` : "";

      const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
      const HOJE_BR = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

      // ── 1) DEBITO VENCIDO POR CLIENTE (+ aging) ─────────────────────────────
      const VENCIDO = `(COALESCE(status::text,'') = 'vencida'
                        OR (COALESCE(status::text,'') = 'a_vencer'
                            AND due_date::date < ${HOJE_BR}))`;
      const debitoRows = await q(`
        WITH ${CTE_CLI},
        r AS (
          SELECT
            NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'')  AS doc,
            NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),'')                         AS nome,
            (COALESCE(NULLIF(amount::text,'')::numeric,0)
             - COALESCE(NULLIF(amount_paid::text,'')::numeric,0))                      AS aberto,
            (${HOJE_BR} - due_date::date)                                              AS dias
          FROM receivables
          WHERE deleted_at IS NULL
            AND due_date IS NOT NULL
            AND ${VENCIDO}
            AND (COALESCE(NULLIF(amount::text,'')::numeric,0)
                 - COALESCE(NULLIF(amount_paid::text,'')::numeric,0)) > 0
            ${FILTRO_VENDA}
        )
        SELECT
          COALESCE(r.doc, 'N|' || COALESCE(r.nome,'?'))            AS chave,
          COALESCE(cli.carteira, 'Sem carteira')                    AS carteira,
          COALESCE(cli.cliente, INITCAP(LOWER(r.nome)), '?')        AS cliente,
          COALESCE(cli.cidade, '')                                  AS cidade,
          COALESCE(SUM(r.aberto),0)::float                          AS vencido,
          COUNT(*)::int                                             AS titulos,
          COALESCE(MAX(r.dias),0)::int                              AS dias_max,
          COALESCE(SUM(r.aberto) FILTER (WHERE r.dias <= 30),0)::float                      AS ag30,
          COALESCE(SUM(r.aberto) FILTER (WHERE r.dias > 30 AND r.dias <= 60),0)::float      AS ag60,
          COALESCE(SUM(r.aberto) FILTER (WHERE r.dias > 60 AND r.dias <= 90),0)::float      AS ag90,
          COALESCE(SUM(r.aberto) FILTER (WHERE r.dias > 90),0)::float                       AS ag90mais
        FROM r
        LEFT JOIN cli ON cli.doc = r.doc
        WHERE TRUE${SO_MINHA}
        GROUP BY 1,2,3,4`);

      // ── 2) VENDAS: janela atual x janela anterior, por cliente ──────────────
      const vendaRows = await q(`
        WITH ${CTE_CLI},
        r AS (
          SELECT
            NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'')  AS doc,
            NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),'')                         AS nome,
            issue_date::date                                                           AS dia,
            COALESCE(NULLIF(amount::text,'')::numeric,0)                               AS v
          FROM receivables
          WHERE issue_date >= '${deAnt}'
            AND issue_date <  ('${ate}'::date + 1)
            AND deleted_at IS NULL
            AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
            AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
            ${FILTRO_VENDA}
        )
        SELECT
          COALESCE(r.doc, 'N|' || COALESCE(r.nome,'?'))            AS chave,
          COALESCE(cli.carteira, 'Sem carteira')                    AS carteira,
          COALESCE(cli.cliente, INITCAP(LOWER(r.nome)), '?')        AS cliente,
          COALESCE(cli.cidade, '')                                  AS cidade,
          COALESCE(SUM(r.v) FILTER (WHERE r.dia >= '${de}'),0)::float                                   AS atual,
          COALESCE(SUM(r.v) FILTER (WHERE r.dia >= '${deAnt}' AND r.dia <= '${ateAnt}'),0)::float        AS anterior,
          COUNT(*) FILTER (WHERE r.dia >= '${de}')::int                                                  AS titulos_atual,
          COUNT(*) FILTER (WHERE r.dia >= '${deAnt}' AND r.dia <= '${ateAnt}')::int                      AS titulos_anterior,
          MAX(r.dia) FILTER (WHERE r.dia >= '${de}')                                                     AS ultima_venda
        FROM r
        LEFT JOIN cli ON cli.doc = r.doc
        WHERE TRUE${SO_MINHA}
        GROUP BY 1,2,3,4`);

      // ── 3) MERGE POR CLIENTE ────────────────────────────────────────────────
      // Um cliente pode aparecer so no debito (parou de comprar e ficou devendo)
      // ou so nas vendas (comprou e esta em dia). Os dois lados entram na lista.
      type Row = {
        chave: string; cliente: string; carteira: string; cidade: string;
        vencido: number; titulosVencidos: number; diasMax: number;
        ag30: number; ag60: number; ag90: number; ag90mais: number;
        atual: number; anterior: number; delta: number; deltaPct: number | null;
        titulosAtual: number; titulosAnterior: number; ultimaVenda: string | null;
      };
      const mapa = new Map<string, Row>();
      const novo = (r: any): Row => ({
        chave: String(r.chave),
        cliente: String(r.cliente || "?"),
        carteira: String(r.carteira || "Sem carteira"),
        cidade: String(r.cidade || ""),
        vencido: 0, titulosVencidos: 0, diasMax: 0,
        ag30: 0, ag60: 0, ag90: 0, ag90mais: 0,
        atual: 0, anterior: 0, delta: 0, deltaPct: null,
        titulosAtual: 0, titulosAnterior: 0, ultimaVenda: null,
      });
      const pega = (r: any): Row => {
        const k = String(r.chave);
        let cur = mapa.get(k);
        if (!cur) { cur = novo(r); mapa.set(k, cur); }
        // Cadastro manda no nome/carteira; o nome do titulo e so o ultimo recurso.
        if (cur.carteira === "Sem carteira" && r.carteira && r.carteira !== "Sem carteira") cur.carteira = String(r.carteira);
        if ((!cur.cliente || cur.cliente === "?") && r.cliente) cur.cliente = String(r.cliente);
        if (!cur.cidade && r.cidade) cur.cidade = String(r.cidade);
        return cur;
      };
      const n = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

      for (const r of debitoRows) {
        const row = pega(r);
        row.vencido = n(r.vencido);
        row.titulosVencidos = n(r.titulos);
        row.diasMax = n(r.dias_max);
        row.ag30 = n(r.ag30); row.ag60 = n(r.ag60); row.ag90 = n(r.ag90); row.ag90mais = n(r.ag90mais);
      }
      for (const r of vendaRows) {
        const row = pega(r);
        row.atual = n(r.atual);
        row.anterior = n(r.anterior);
        row.titulosAtual = n(r.titulos_atual);
        row.titulosAnterior = n(r.titulos_anterior);
        row.ultimaVenda = r.ultima_venda ? String(r.ultima_venda).slice(0, 10) : null;
      }
      for (const row of Array.from(mapa.values())) {
        row.delta = row.atual - row.anterior;
        // Sem base anterior nao existe percentual: cliente novo e "ganho", nao "+∞".
        row.deltaPct = row.anterior > 0 ? (row.delta / row.anterior) * 100 : null;
      }
      const clientes = Array.from(mapa.values());

      // ── 4) AGREGADO POR CARTEIRA ────────────────────────────────────────────
      const porCarteira = new Map<string, any>();
      for (const c of clientes) {
        let k = porCarteira.get(c.carteira);
        if (!k) {
          k = {
            carteira: c.carteira,
            vencido: 0, titulosVencidos: 0, clientesVencidos: 0, maiorAtraso: 0,
            ag30: 0, ag60: 0, ag90: 0, ag90mais: 0,
            atual: 0, anterior: 0, delta: 0, deltaPct: null as number | null,
            clientesAtual: 0, clientesAnterior: 0, clientesQueCairam: 0, clientesQueSubiram: 0,
            maiorQuedaCliente: null as string | null, maiorQuedaValor: 0,
            maiorGanhoCliente: null as string | null, maiorGanhoValor: 0,
          };
          porCarteira.set(c.carteira, k);
        }
        k.vencido += c.vencido;
        k.titulosVencidos += c.titulosVencidos;
        if (c.vencido > 0) k.clientesVencidos += 1;
        if (c.vencido > 0 && c.diasMax > k.maiorAtraso) k.maiorAtraso = c.diasMax;
        k.ag30 += c.ag30; k.ag60 += c.ag60; k.ag90 += c.ag90; k.ag90mais += c.ag90mais;
        k.atual += c.atual; k.anterior += c.anterior;
        if (c.atual > 0) k.clientesAtual += 1;
        if (c.anterior > 0) k.clientesAnterior += 1;
        if (c.delta < 0) k.clientesQueCairam += 1;
        if (c.delta > 0) k.clientesQueSubiram += 1;
        if (c.delta < k.maiorQuedaValor) { k.maiorQuedaValor = c.delta; k.maiorQuedaCliente = c.cliente; }
        if (c.delta > k.maiorGanhoValor) { k.maiorGanhoValor = c.delta; k.maiorGanhoCliente = c.cliente; }
      }
      const carteiras = Array.from(porCarteira.values()).map((k) => {
        k.delta = k.atual - k.anterior;
        k.deltaPct = k.anterior > 0 ? (k.delta / k.anterior) * 100 : null;
        return k;
      });

      res.json({
        janela: { dias, de, ate, deAnt, ateAnt, hoje },
        escopo: restrito ? "carteira" : "todas",
        totais: {
          vencido: carteiras.reduce((s, k) => s + k.vencido, 0),
          atual: carteiras.reduce((s, k) => s + k.atual, 0),
          anterior: carteiras.reduce((s, k) => s + k.anterior, 0),
          clientesVencidos: carteiras.reduce((s, k) => s + k.clientesVencidos, 0),
        },
        carteiras,
        clientes,
      });
    } catch (err: any) {
      console.error("[GESTAO/DEBITO-VENDAS]", err);
      res.status(500).json({ error: err?.message || "Falha ao montar o relatorio" });
    }
  });
}
