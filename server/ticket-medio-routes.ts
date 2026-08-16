// ============================================================================
// QUANTIDADE DE CLIENTES POR TICKET MÉDIO
// ----------------------------------------------------------------------------
// Substitui o antigo recorte "PJ / PF" da tela Clientes Ativos. Em vez do tipo
// de pessoa (que não diz nada sobre o tamanho do cliente), a tela passa a
// mostrar quantos clientes existem em cada faixa de ticket médio, quanto isso
// representa da carteira e quanto cada faixa fatura por mês.
//
// Definições (aprovadas por Flavio):
//  - Ticket médio do cliente = total faturado ÷ nº de MESES EM QUE ELE COMPROU
//    (e não ÷ número de notas, nem ÷ 12 — assim quem compra a cada dois meses
//     não é rebaixado por causa dos meses parados).
//  - Faturamento efetivo = mesma regra do server/faturamento-oficial.ts:
//    NF-e autorizada em produção, CFOP de venda, deduplicada por
//    (CNPJ emitente, série, número); fora devolução, troca, transferência,
//    remessa, bonificação, amostra.
//  - Janela padrão: os últimos 12 meses FECHADOS (o mês corrente fica de fora;
//    meio mês contaria como mês inteiro e rebaixaria o ticket de quem já comprou).
//  - Fora da conta: PURO, BARUC e o CNPJ do próprio grupo (28.295.493/*),
//    que são operações entre empresas da casa, não venda.
// ============================================================================

import { type Express } from "express";
import { authenticateUser } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { CFOP_VENDA } from "./faturamento-oficial";

const ROLES_OK = ["admin", "coordinator", "administrative", "vendedor", "telemarketing"];

/** Faixas de ticket médio. Contíguas e sem buraco: toda a carteira cai em uma. */
export const FAIXAS_TICKET = [
  { chave: "f1", label: "Até R$ 299,99", min: 0, max: 299.99 },
  { chave: "f2", label: "R$ 300,00 a R$ 500,00", min: 300, max: 500 },
  { chave: "f3", label: "R$ 501,00 a R$ 799,00", min: 500.01, max: 799 },
  { chave: "f4", label: "R$ 800,00 a R$ 1.500,00", min: 799.01, max: 1500 },
  { chave: "f5", label: "R$ 1.501,00 a R$ 5.000,00", min: 1500.01, max: 5000 },
  { chave: "f6", label: "Acima de R$ 5.000,00", min: 5000.01, max: null as number | null },
];

function faixaDe(ticket: number): string {
  for (const f of FAIXAS_TICKET) {
    if (ticket >= f.min && (f.max === null || ticket <= f.max)) return f.chave;
  }
  return "f6";
}

export function registerTicketMedioRoutes(app: Express): void {
  app.get("/api/customers/ticket-medio", authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser || req.user;
      if (!user || !ROLES_OK.includes(user.role)) {
        return res.status(403).json({ message: "Sem permissão" });
      }
      const meses = Math.min(Math.max(parseInt(String(req.query.meses || "12"), 10) || 12, 1), 36);
      const cfops = CFOP_VENDA.map((c) => `'${c}'`).join(",");

      // A agregação por documento roda ANTES do join com customers: casar
      // cliente nota a nota estourava o statement_timeout do banco.
      const r: any = await db.execute(sql`
        WITH nf AS (
          SELECT DISTINCT ON (COALESCE(issuer_cnpj,''), COALESCE(series,''), COALESCE(invoice_number::text,'id:'||id::text))
                 id, emission_date, authorization_date, created_at, total_invoice,
                 customer_name, customer_cnpj_cpf
          FROM fiscal_invoices
          WHERE status = 'authorized' AND environment = 'producao'
            AND COALESCE(operation_type,'saida') <> 'entrada'
            AND COALESCE(fin_nfe,'1') <> '4'
            AND (cfop IN (${sql.raw(cfops)})
                 OR (cfop IS NULL AND UPPER(COALESCE(nature_of_operation,'')) LIKE '%VENDA%'))
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%'
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TROCA%'
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TRANSFER%'
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%REMESSA%'
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%BONIFICA%'
            AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%AMOSTRA%'
            AND COALESCE(emission_date, authorization_date, created_at)::date
                >= (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - (${meses}::text || ' months')::interval)::date
            AND COALESCE(emission_date, authorization_date, created_at)::date
                <  date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY COALESCE(issuer_cnpj,''), COALESCE(series,''), COALESCE(invoice_number::text,'id:'||id::text), created_at DESC
        ), agg AS (
          SELECT regexp_replace(COALESCE(customer_cnpj_cpf,''),'[^0-9]','','g') AS doc,
                 MIN(customer_name) AS nome_nf,
                 COUNT(1)::int AS nfs,
                 COUNT(DISTINCT to_char(COALESCE(emission_date, authorization_date, created_at),'YYYY-MM'))::int AS meses_com_compra,
                 SUM(total_invoice)::numeric AS total
          FROM nf
          WHERE regexp_replace(COALESCE(customer_cnpj_cpf,''),'[^0-9]','','g') <> ''
          GROUP BY 1
        )
        SELECT a.doc, a.nfs, a.meses_com_compra, ROUND(a.total,2) AS total,
               UPPER(TRIM(COALESCE(NULLIF(c.fantasy_name,''), NULLIF(c.name,''), a.nome_nf, 'SEM CLIENTE'))) AS fantasia,
               c.id AS customer_id
        FROM agg a
        LEFT JOIN LATERAL (
          SELECT cc.id, cc.name, cc.fantasy_name FROM customers cc
          WHERE regexp_replace(COALESCE(cc.cnpj, cc.cpf, ''),'[^0-9]','','g') = a.doc
          ORDER BY cc.is_active DESC LIMIT 1
        ) c ON true
        WHERE a.doc NOT LIKE '28295493%'
      `);
      const linhas: any[] = r?.rows || r || [];

      const resumo: Record<string, { clientes: number; pj: number; pf: number; faturamentoMes: number; total: number }> = {};
      for (const f of FAIXAS_TICKET) resumo[f.chave] = { clientes: 0, pj: 0, pf: 0, faturamentoMes: 0, total: 0 };

      const porCliente: Record<string, { ticket: number; faixa: string; tipo: string }> = {};
      let totalClientes = 0;
      let faturamentoMesTotal = 0;

      for (const l of linhas) {
        const fantasia = String(l.fantasia || "");
        // Operações entre empresas do grupo não são venda.
        if (fantasia.includes("PURO") || fantasia.includes("BARUC")) continue;
        const total = Number(l.total) || 0;
        const mesesComCompra = Number(l.meses_com_compra) || 0;
        if (total <= 0 || mesesComCompra <= 0) continue;

        const ticket = total / mesesComCompra;
        const faixa = faixaDe(ticket);
        const porMes = total / meses;
        // PJ x PF pelo tamanho do documento: 14 dígitos = CNPJ, 11 = CPF.
        const doc = String(l.doc || "");
        const tipo = doc.length === 14 ? "pessoa_juridica" : doc.length === 11 ? "pessoa_fisica" : "";

        resumo[faixa].clientes += 1;
        if (tipo === "pessoa_juridica") resumo[faixa].pj += 1;
        else if (tipo === "pessoa_fisica") resumo[faixa].pf += 1;
        resumo[faixa].faturamentoMes += porMes;
        resumo[faixa].total += total;
        totalClientes += 1;
        faturamentoMesTotal += porMes;

        // A tela casa por documento (o cadastro nem sempre tem customer_id na NF).
        const reg = { ticket: Math.round(ticket * 100) / 100, faixa, tipo };
        porCliente[l.doc] = reg;
        if (l.customer_id) porCliente[String(l.customer_id)] = reg;
      }

      const faixas = FAIXAS_TICKET.map((f) => ({
        chave: f.chave,
        label: f.label,
        min: f.min,
        max: f.max,
        clientes: resumo[f.chave].clientes,
        clientesPJ: resumo[f.chave].pj,
        clientesPF: resumo[f.chave].pf,
        percentual: totalClientes ? Math.round((resumo[f.chave].clientes / totalClientes) * 1000) / 10 : 0,
        faturamentoMes: Math.round(resumo[f.chave].faturamentoMes * 100) / 100,
        percentualFaturamento: faturamentoMesTotal
          ? Math.round((resumo[f.chave].faturamentoMes / faturamentoMesTotal) * 1000) / 10
          : 0,
        ticketMedioDaFaixa: resumo[f.chave].clientes
          ? Math.round((resumo[f.chave].faturamentoMes / resumo[f.chave].clientes) * 100) / 100
          : 0,
      }));

      res.set({ "Cache-Control": "no-cache, no-store, must-revalidate" });
      res.json({
        meses,
        totalClientes,
        faturamentoMesTotal: Math.round(faturamentoMesTotal * 100) / 100,
        faixas,
        porCliente,
      });
    } catch (e: any) {
      console.error("[ticket-medio]", e);
      res.status(500).json({ message: "Erro ao calcular ticket médio", error: e?.message });
    }
  });
}
