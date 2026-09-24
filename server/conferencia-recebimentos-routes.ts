// server/conferencia-recebimentos-routes.ts
// -----------------------------------------------------------------------------
// GESTAO — CONFERENCIA DE RECEBIMENTOS  (tela /conferencia-recebimentos)
//
// Um unico endpoint read-only que responde, para uma janela de emissao (padrao
// 30 dias), as tres perguntas de controle do recebimento:
//
//   1. TODA VENDA VIROU RECEBIVEL?  (cobertura)
//        - NF-e de venda autorizada SEM titulo a receber vinculado.
//        - Pedido ENTREGUE no pipeline (operacao venda) SEM titulo.
//   2. TEM PRAZO E CONTA?  (qualidade do titulo em aberto)
//        - titulo de venda a_vencer/vencida SEM conta prevista de liquidacao.
//        - SEM previsao de liquidacao (expected_settlement_date) — importa p/
//          cartao (D+30) e boleto.
//        - a_vencer JA vencido (due_date passou) e nao foi reclassificado.
//   3. FOI RECEBIDO, EM QUE CONTA E BATEU NO BANCO?  (recebimento efetivo)
//        - recebido SEM conta de recebimento (paid_financial_account_id).
//        - recebido SEM data de recebimento (paid_date).
//        - recebido e NAO conciliado com o extrato/EDI Cielo.
//        - recebido cujo boleto continua em aberto/vencido (recebimento falso).
//
//   + PANORAMA por CANAL (forma de pagamento: prazo medio, % recebido, %
//     conciliado) e por CONTA (onde o dinheiro do periodo caiu).
//
// A regua de "o que e venda" e a MESMA de server/gestao-debito-vendas-routes.ts
// e server/carteira-routes.ts (grupo/BARUC fora, categorias que nao sao venda
// fora, NF que nao e de venda fora, pedido na lixeira fora), de proposito: os
// numeros tem de fechar com as demais telas.
//
// Somente admin / coordinator / administrative (dado financeiro consolidado).
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { nfVendaWhere } from "./faturamento-oficial";
import { authenticateUser, requireRole } from "./authMiddleware";

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

export function registerConferenciaRecebimentos(app: Express) {
  // GET /api/gestao/conferencia-recebimentos?dias=30&ate=YYYY-MM-DD
  app.get(
    "/api/gestao/conferencia-recebimentos",
    authenticateUser,
    requireRole(["admin", "coordinator", "administrative"]),
    async (req: Request, res: Response) => {
      try {
        // ── JANELA (por data de emissao do titulo) ──────────────────────────
        const reDate = /^\d{4}-\d{2}-\d{2}$/;
        const hoje = hojeBR();
        const diasBruto = parseInt(String(req.query.dias ?? "30"), 10);
        const dias = Number.isFinite(diasBruto) ? Math.min(365, Math.max(1, diasBruto)) : 30;
        const ate = reDate.test(String(req.query.ate)) && String(req.query.ate) <= hoje ? String(req.query.ate) : hoje;
        const de = addDias(ate, -(dias - 1));
        const ateExcl = `('${ate}'::date + 1)`; // fim exclusivo

        const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
        const HOJE_BR = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

        // ── REGUA "O QUE E VENDA" (copia fiel das demais telas) ──────────────
        const CNPJS_GRUPO = ["28295493000153", "28295493000234", "28295493000315", "52921727000105"];
        const CNPJS_NAO_CLIENTE = ["14877972000173"]; // BARUC
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
        const SO_VENDA = `
              AND NOT (${C_GRUPO})
              AND NOT ${C_CATEGORIA}
              AND NOT ${C_NF_INVALIDA}
              AND NOT ${C_LIXEIRA}`;

        // Numero liquido em aberto do titulo.
        const ABERTO = `(COALESCE(NULLIF(amount::text,'')::numeric,0) - COALESCE(NULLIF(amount_paid::text,'')::numeric,0))`;
        // Conciliado de verdade = bateu no extrato bancario OU no EDI/repasse Cielo.
        // CONFIRMADO NO BANCO — o recebimento tem lastro de um sinal do banco/adquirente.
        // Cobre TODAS as fontes reais de vinculo: a conciliacao em conjunto grava em
        // bank_statement_item_matches (nao em bank_statement_items.matched_receivable_id),
        // o extrato simples grava reconciled no item, o EDI/repasse Cielo amarra a
        // transacao, e o boleto LIQUIDADO/PAGO e a confirmacao do proprio BB. Olhar so
        // uma dessas fontes subestima muito a conciliacao.
        const CONCILIADO = `(
            EXISTS (SELECT 1 FROM bank_statement_item_matches m WHERE m.receivable_id = receivables.id)
            OR EXISTS (SELECT 1 FROM bank_statement_items bi WHERE bi.matched_receivable_id = receivables.id AND bi.reconciliation_status = 'reconciled')
            OR EXISTS (SELECT 1 FROM cielo_edi_transacoes ct WHERE ct.receivable_id = receivables.id)
            OR EXISTS (SELECT 1 FROM cielo_reconciliation_records cr WHERE cr.matched_receivable_id = receivables.id)
            OR EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = receivables.id AND UPPER(COALESCE(b.status,'')) IN ('LIQUIDADO','PAGO'))
        )`;
        // Boleto do titulo ainda em aberto (registrado/vencido) — recebimento suspeito.
        const BOLETO_ABERTO = `EXISTS (SELECT 1 FROM boleto_charges b
            WHERE b.receivable_id = receivables.id AND b.deleted_at IS NULL
              AND UPPER(COALESCE(b.status,'')) IN ('REGISTRADO','VENCIDO','EMABERTO','EM_ABERTO'))`;

        const JANELA = `receivables.issue_date >= '${de}' AND receivables.issue_date < ${ateExcl} AND receivables.deleted_at IS NULL`;
        const VENDA_JANELA = `${JANELA}${SO_VENDA} AND COALESCE(status::text,'') <> 'cancelada'`;

        // ── 1) RESUMO DA JANELA ──────────────────────────────────────────────
        const [resumo] = await q(`
          SELECT
            COUNT(*)::int                                                                          AS titulos,
            COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0)),0)::float                    AS valor,
            COALESCE(SUM(COALESCE(NULLIF(amount_paid::text,'')::numeric,0)) FILTER (WHERE status::text='recebida'),0)::float AS recebido,
            COUNT(*) FILTER (WHERE status::text='recebida')::int                                    AS titulos_recebidos,
            COALESCE(SUM(${ABERTO}) FILTER (WHERE status::text IN ('a_vencer','vencida')),0)::float  AS em_aberto,
            COALESCE(SUM(${ABERTO}) FILTER (WHERE status::text='vencida' OR (status::text='a_vencer' AND due_date::date < ${HOJE_BR})),0)::float AS vencido,
            COUNT(*) FILTER (WHERE ${CONCILIADO} AND status::text='recebida')::int                   AS titulos_conciliados
          FROM receivables
          WHERE ${VENDA_JANELA}`);

        // ── 2) FUROS ──────────────────────────────────────────────────────────
        // Cada furo: total (qtd/valor) via window function + top 100 por valor.
        const furo = async (
          chave: string,
          titulo: string,
          descricao: string,
          gravidade: "alta" | "media" | "baixa",
          fromWhere: string,
          selectCols: string,
          valorExpr: string,
        ) => {
          const rows = await q(`
            SELECT ${selectCols},
              ${valorExpr} AS valor,
              COUNT(*) OVER()::int AS _qtd,
              COALESCE(SUM(${valorExpr}) OVER(),0)::float AS _valor_total
            ${fromWhere}
            ORDER BY ${valorExpr} DESC NULLS LAST
            LIMIT 100`);
          const qtd = rows.length ? Number(rows[0]._qtd) : 0;
          const valorTotal = rows.length ? Number(rows[0]._valor_total) : 0;
          const lista = rows.map((r) => {
            const { _qtd, _valor_total, ...rest } = r;
            return rest;
          });
          return { chave, titulo, descricao, gravidade, qtd, valor: valorTotal, lista };
        };

        const COLS_REC = `receivables.id, receivables.title_number AS titulo, receivables.customer_name AS cliente,
          receivables.customer_document AS documento, receivables.payment_method::text AS forma,
          receivables.issue_date::date AS emissao, receivables.due_date::date AS vencimento,
          receivables.status::text AS status`;

        const furos = [] as any[];

        // 2.1 NF-e de venda autorizada SEM recebivel (emissao na janela)
        furos.push(await furo(
          "nf_sem_receivable",
          "NF-e de venda sem título a receber",
          "Nota fiscal de venda autorizada no período sem nenhum recebível vinculado — venda faturada que não virou cobrança.",
          "alta",
          `FROM fiscal_invoices fi
             WHERE ${nfVendaWhere("fi")}
               AND fi.emission_date >= '${de}' AND fi.emission_date < ${ateExcl}
               AND NOT EXISTS (SELECT 1 FROM receivables r WHERE r.fiscal_invoice_id = fi.id AND r.deleted_at IS NULL)`,
          `fi.id, fi.invoice_number AS titulo, fi.customer_name AS cliente, fi.customer_cnpj_cpf AS documento,
           fi.payment_method AS forma, fi.emission_date::date AS emissao, NULL::date AS vencimento, fi.status AS status`,
          `COALESCE(NULLIF(fi.total_invoice::text,'')::numeric,0)`,
        ));

        // 2.2 Pedido ENTREGUE (pipeline, operacao venda) SEM recebivel
        furos.push(await furo(
          "pedido_sem_receivable",
          "Pedido entregue sem título a receber",
          "Pedido de venda já entregue no pipeline, criado no período, sem recebível — entregue e não cobrado.",
          "alta",
          `FROM billing_pipeline bp
             WHERE bp.stage IN ('faturado','impresso','aguardando_rota','em_rota','entregue','bsb','em_rota_bsb','agendado','outras_cidades','aguardando_rota_bsb')
               AND COALESCE(bp.operation_type,'venda') = 'venda'
               AND bp.created_at >= '${de}' AND bp.created_at < ${ateExcl}
               AND NOT EXISTS (SELECT 1 FROM receivables r WHERE (r.billing_pipeline_id = bp.id OR r.sales_card_id = bp.sales_card_id) AND r.deleted_at IS NULL)`,
          `bp.id, bp.order_number AS titulo, bp.customer_name AS cliente, bp.customer_document AS documento,
           bp.payment_method AS forma, bp.created_at::date AS emissao, NULL::date AS vencimento, bp.stage::text AS status`,
          `COALESCE(NULLIF(bp.sale_value::text,'')::numeric,0)`,
        ));

        // 2.3 Titulo de venda em aberto SEM conta prevista de liquidacao
        furos.push(await furo(
          "sem_conta_prevista",
          "Título em aberto sem conta prevista",
          "Recebível de venda em aberto sem a conta onde o dinheiro deve cair (financial_account_id).",
          "media",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text IN ('a_vencer','vencida') AND financial_account_id IS NULL`,
          COLS_REC,
          ABERTO,
        ));

        // 2.4 Titulo de venda em aberto SEM previsao de liquidacao
        furos.push(await furo(
          "sem_previsao_liquidacao",
          "Título em aberto sem previsão de liquidação",
          "Recebível de venda em aberto sem data prevista de liquidação — sem isso não dá para prever quando o dinheiro cai (crítico p/ cartão D+30).",
          "media",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text IN ('a_vencer','vencida') AND expected_settlement_date IS NULL`,
          COLS_REC,
          ABERTO,
        ));

        // 2.5 a_vencer JA vencido (nao reclassificado)
        furos.push(await furo(
          "avencer_vencido",
          "Vencido ainda marcado como “a vencer”",
          "Título com vencimento já passado que continua com status a_vencer — sai da régua de cobrança de vencidos.",
          "alta",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text='a_vencer' AND due_date::date < ${HOJE_BR}`,
          COLS_REC,
          ABERTO,
        ));

        // 2.6 Recebido com baixa registrada SEM conta de recebimento.
        furos.push(await furo(
          "recebido_sem_conta",
          "Recebido sem conta de recebimento",
          "Título recebido no período com baixa lançada mas sem registrar em qual conta o dinheiro entrou.",
          "alta",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text='recebida'
               AND EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = receivables.id AND rp.deleted_at IS NULL)
               AND NOT EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = receivables.id AND rp.deleted_at IS NULL AND rp.financial_account_id IS NOT NULL)`,
          COLS_REC,
          `COALESCE(NULLIF(amount_paid::text,'')::numeric,0)`,
        ));

        // 2.7 Recebido SEM data de recebimento
        furos.push(await furo(
          "recebido_sem_data",
          "Recebido sem data de recebimento",
          "Título recebido no período sem paid_date — não dá para medir prazo real de recebimento.",
          "baixa",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text='recebida' AND paid_date IS NULL`,
          COLS_REC,
          `COALESCE(NULLIF(amount_paid::text,'')::numeric,0)`,
        ));

        // 2.8 Recebido e NAO conciliado com banco/Cielo
        furos.push(await furo(
          "recebido_nao_conciliado",
          "Recebido sem confirmação no banco",
          "Título recebido no período sem lastro de confirmação bancária — não bateu no extrato, não tem boleto liquidado nem repasse Cielo. Quase sempre Pix/dinheiro/baixa manual a conferir no extrato.",
          "media",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text='recebida' AND NOT ${CONCILIADO}`,
          COLS_REC,
          `COALESCE(NULLIF(amount_paid::text,'')::numeric,0)`,
        ));

        // 2.9 Recebido mas boleto ainda em aberto (recebimento suspeito)
        furos.push(await furo(
          "recebido_boleto_aberto",
          "Recebido com boleto ainda em aberto",
          "Título marcado recebido cujo boleto continua registrado/vencido no banco — possível baixa indevida.",
          "media",
          `FROM receivables
             WHERE ${VENDA_JANELA} AND status::text='recebida' AND ${BOLETO_ABERTO}`,
          COLS_REC,
          `COALESCE(NULLIF(amount_paid::text,'')::numeric,0)`,
        ));

        // ── 3) PANORAMA POR CANAL (forma de pagamento) ───────────────────────
        const porCanal = await q(`
          SELECT
            COALESCE(payment_method::text,'(sem forma)')                                           AS forma,
            COUNT(*)::int                                                                          AS titulos,
            COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0)),0)::float                    AS valor,
            ROUND(AVG(due_date::date - issue_date::date)::numeric,1)::float                         AS prazo_medio_dias,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status::text='recebida') / NULLIF(COUNT(*),0),1)::float AS pct_recebido,
            ROUND(100.0 * COUNT(*) FILTER (WHERE ${CONCILIADO} AND status::text='recebida') / NULLIF(COUNT(*) FILTER (WHERE status::text='recebida'),0),1)::float AS pct_conciliado
          FROM receivables
          WHERE ${VENDA_JANELA}
          GROUP BY 1 ORDER BY 3 DESC`);

        // ── 4) ONDE O DINHEIRO CAIU — pela conta da BAIXA (receivable_payments),
        // que e a fonte de verdade; a baixa sem conta cai em "(não informada)".
        const porConta = await q(`
          SELECT
            COALESCE(fa.name, '(não informada)')                                                   AS conta,
            COALESCE(fa.type::text,'')                                                             AS tipo,
            COUNT(DISTINCT p.receivable_id)::int                                                   AS titulos,
            COALESCE(SUM(COALESCE(NULLIF(p.amount::text,'')::numeric,0)),0)::float                  AS valor
          FROM receivable_payments p
          JOIN receivables r ON r.id = p.receivable_id
          LEFT JOIN financial_accounts fa ON fa.id = p.financial_account_id
          WHERE p.deleted_at IS NULL
            AND r.issue_date >= '${de}' AND r.issue_date < ${ateExcl} AND r.deleted_at IS NULL
            AND NOT (${C_GRUPO}) AND NOT ${C_CATEGORIA}
          GROUP BY 1,2 ORDER BY 4 DESC`);

        res.json({
          janela: { dias, de, ate, hoje },
          resumo: resumo || {},
          furos,
          porCanal,
          porConta,
          contexto:
            "Base: recebíveis de venda emitidos no período (mesma régua de venda das telas de Gestão/Carteiras). " +
            "Conciliado = bateu no extrato bancário ou no repasse/EDI Cielo.",
        });
      } catch (err: any) {
        console.error("[GESTAO/CONFERENCIA-RECEBIMENTOS]", err);
        res.status(500).json({ error: err?.message || "Falha ao montar a conferência" });
      }
    },
  );
}
