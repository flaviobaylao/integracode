import { db } from "./db";
import { customers, chatAiReports } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { listarDebitosVencidosPorCliente } from "./overdue-debts-por-cliente";

interface ReportResult {
  reportType: string;
  content: string;
  recordCount: number;
}

export async function generateCustomersReport(): Promise<ReportResult> {
  console.log("📊 [AI-REPORTS] Gerando relatório de clientes...");
  
  const allCustomers = await db
    .select()
    .from(customers)
    .where(eq(customers.isActive, true));

  const lines: string[] = [
    `# CADASTRO DE CLIENTES HONEST SUCOS`,
    `Atualizado em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`,
    `Total: ${allCustomers.length} clientes ativos`,
    `---`,
    ``
  ];

  for (const customer of allCustomers) {
    const displayName = customer.fantasyName || customer.companyName || customer.name;
    const document = customer.cnpj || customer.cpf || 'Sem documento';
    const type = customer.customerType === 'pessoa_juridica' ? 'PJ' : 'PF';
    
    lines.push(`## ${displayName}`);
    lines.push(`- Tipo: ${type} | Doc: ${document}`);
    lines.push(`- Tel: ${customer.phone || 'N/D'} | Email: ${customer.email || 'N/D'}`);
    lines.push(`- End: ${customer.address || 'N/D'}, ${customer.neighborhood || ''} - ${customer.city || ''} ${customer.state || ''} ${customer.zipCode || ''}`);
    
    if (customer.weekdays) {
      try {
        const weekdays = typeof customer.weekdays === 'string' 
          ? JSON.parse(customer.weekdays) 
          : customer.weekdays;
        lines.push(`- Dias de visita: ${Array.isArray(weekdays) ? weekdays.join(', ') : weekdays}`);
      } catch {
        lines.push(`- Dias de visita: ${customer.weekdays}`);
      }
    }
    
    if (customer.lastSaleDate) {
      const lastSaleDate = new Date(customer.lastSaleDate).toLocaleDateString('pt-BR');
      lines.push(`- Última compra: ${lastSaleDate} (R$ ${customer.lastSaleValue || '0'})`);
    }
    
    lines.push(`- Ativo: ${customer.isActive === false ? 'não' : 'sim'}`);
    lines.push(``);
  }

  const content = lines.join('\n');
  console.log(`✅ [AI-REPORTS] Relatório de clientes gerado: ${allCustomers.length} registros`);

  return {
    reportType: 'customers',
    content,
    recordCount: allCustomers.length
  };
}

export async function generateOverdueDebtsReport(): Promise<ReportResult> {
  console.log("📊 [AI-REPORTS] Gerando relatório de débitos vencidos...");

  // E4 (06/set/2026): fonte 2.0 (receivables) com a REGRA ÚNICA de débito vivo
  // (server/divida-viva.ts), agrupada por cliente — NÃO mais `overdue_debts`
  // (sync do Omie, congelado em 26/ago). Mesmo texto de saída de antes.
  const { debts: allDebts, totalAmount } = await listarDebitosVencidosPorCliente();

  const lines: string[] = [
    `# DÉBITOS VENCIDOS - HONEST SUCOS`,
    `Atualizado em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`,
    `Total de clientes com débitos: ${allDebts.length}`,
    `---`,
    ``
  ];

  let totalDebt = 0;

  for (const debt of allDebts) {
    const amount = Number(debt.valorTotal || 0);
    totalDebt += amount;
    
    lines.push(`## ${debt.cliente.nome_fantasia}`);
    lines.push(`- Doc: ${debt.cliente.cnpj_cpf || 'N/D'}`);
    lines.push(`- Total em débito: R$ ${amount.toFixed(2)}`);
    lines.push(`- Dias de atraso máximo: ${debt.diasMaximoAtraso} dias`);
    if (debt.vendedores.length > 0) lines.push(`- Vendedor: ${debt.vendedores.join(', ')}`);
    
    if (debt.debitos.length > 0) {
      lines.push(`- Detalhes dos títulos:`);
      for (const d of debt.debitos) {
        lines.push(`  * Doc ${d.numero_documento_fiscal || d.numero_documento}: R$ ${Number(d.valor || 0).toFixed(2)} (venc: ${d.data_vencimento}, ${d.dias_atraso} dias atraso)`);
      }
    }
    
    lines.push(``);
  }

  lines.splice(3, 0, `Valor total em débitos: R$ ${(totalAmount || totalDebt).toFixed(2)}`);

  const content = lines.join('\n');
  console.log(`✅ [AI-REPORTS] Relatório de débitos gerado: ${allDebts.length} clientes, R$ ${totalDebt.toFixed(2)} total`);

  return {
    reportType: 'overdue_debts',
    content,
    recordCount: allDebts.length
  };
}

export async function generateBillingsReport(): Promise<ReportResult> {
  console.log("📊 [AI-REPORTS] Gerando relatório de faturamentos...");

  // E4 (06/set/2026): faturamento VIGENTE = billing_pipeline (estágio faturado ou
  // posterior) + fiscal_invoices (número/valor da NF quando há NF-e autorizada).
  // A tabela `billings` é histórico do Omie (termina em 22/jun/2026) e não é mais lida.
  // A coluna `stage` é enum billing_pipeline_stage: comparar como texto.
  const r: any = await db.execute(sql`
    SELECT bp.id,
           bp.customer_name      AS customer_fantasy_name,
           bp.customer_document  AS customer_document,
           bp.created_at         AS order_date,
           bp.invoice_number     AS bp_invoice_number,
           fi.invoice_number     AS fi_invoice_number,
           COALESCE(fi.total_invoice, bp.sale_value, 0)::float AS total_value
    FROM billing_pipeline bp
    LEFT JOIN LATERAL (
      SELECT fi.invoice_number, fi.total_invoice
      FROM fiscal_invoices fi
      WHERE fi.status = 'authorized'
        AND fi.invoice_number = NULLIF(regexp_replace(COALESCE(bp.invoice_number, ''), '[^0-9]', '', 'g'), '')::bigint
      ORDER BY fi.created_at DESC
      LIMIT 1
    ) fi ON true
    WHERE bp.stage::text IN ('faturado', 'impresso', 'aguardando_rota', 'em_rota', 'entregue')
      AND bp.created_at >= now() - interval '30 days'
    ORDER BY bp.created_at DESC
  `);
  const recentBillings: any[] = r.rows || [];

  const customerSummary: Record<string, { 
    name: string; 
    document: string; 
    totalValue: number; 
    orderCount: number;
    lastOrder: string;
  }> = {};

  for (const billing of recentBillings) {
    const key = billing.customer_document || billing.customer_fantasy_name;
    if (!customerSummary[key]) {
      customerSummary[key] = {
        name: billing.customer_fantasy_name,
        document: billing.customer_document || 'N/D',
        totalValue: 0,
        orderCount: 0,
        lastOrder: ''
      };
    }
    
    customerSummary[key].totalValue += Number(billing.total_value || 0);
    customerSummary[key].orderCount += 1;
    
    if (!customerSummary[key].lastOrder) {
      customerSummary[key].lastOrder = billing.order_date 
        ? new Date(billing.order_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) 
        : 'N/D';
    }
  }

  const sortedCustomers = Object.values(customerSummary)
    .sort((a, b) => b.totalValue - a.totalValue);

  const lines: string[] = [
    `# FATURAMENTOS POR CLIENTE - ÚLTIMOS 30 DIAS`,
    `Atualizado em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`,
    `Total de pedidos: ${recentBillings.length}`,
    `Total de clientes: ${sortedCustomers.length}`,
    `---`,
    ``
  ];

  let grandTotal = 0;

  for (const customer of sortedCustomers) {
    grandTotal += customer.totalValue;
    
    lines.push(`## ${customer.name}`);
    lines.push(`- Doc: ${customer.document}`);
    lines.push(`- Total faturado: R$ ${customer.totalValue.toFixed(2)}`);
    lines.push(`- Quantidade de pedidos: ${customer.orderCount}`);
    lines.push(`- Último pedido: ${customer.lastOrder}`);
    lines.push(``);
  }

  lines.splice(4, 0, `Valor total faturado: R$ ${grandTotal.toFixed(2)}`);

  const content = lines.join('\n');
  console.log(`✅ [AI-REPORTS] Relatório de faturamentos gerado: ${sortedCustomers.length} clientes, R$ ${grandTotal.toFixed(2)} total`);

  return {
    reportType: 'billings_summary',
    content,
    recordCount: recentBillings.length
  };
}

export async function generateAndSaveAllReports(): Promise<void> {
  console.log("🔄 [AI-REPORTS] Iniciando geração de todos os relatórios...");
  
  try {
    const now = new Date();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 2);

    const [customersReport, debtsReport, billingsReport] = await Promise.all([
      generateCustomersReport(),
      generateOverdueDebtsReport(),
      generateBillingsReport()
    ]);

    const reports = [customersReport, debtsReport, billingsReport];

    for (const report of reports) {
      const existing = await db
        .select({ id: chatAiReports.id })
        .from(chatAiReports)
        .where(eq(chatAiReports.reportType, report.reportType))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(chatAiReports)
          .set({
            content: report.content,
            recordCount: report.recordCount,
            generatedAt: now,
            expiresAt
          })
          .where(eq(chatAiReports.reportType, report.reportType));
      } else {
        await db.insert(chatAiReports).values({
          reportType: report.reportType,
          content: report.content,
          recordCount: report.recordCount,
          generatedAt: now,
          expiresAt
        });
      }
    }

    console.log("✅ [AI-REPORTS] Todos os relatórios foram gerados e salvos com sucesso!");
    
  } catch (error: any) {
    console.error("❌ [AI-REPORTS] Erro ao gerar relatórios:", error.message);
  }
}

export async function getAiReportsContext(): Promise<string> {
  try {
    const reports = await db.select().from(chatAiReports);
    
    if (reports.length === 0) {
      console.log("⚠️ [AI-REPORTS] Nenhum relatório encontrado. Gerando novos...");
      await generateAndSaveAllReports();
      const newReports = await db.select().from(chatAiReports);
      return newReports.map(r => r.content).join('\n\n---\n\n');
    }

    const oldestReport = reports.reduce((oldest, r) => {
      const rDate = r.generatedAt ? new Date(r.generatedAt).getTime() : 0;
      const oldestDate = oldest.generatedAt ? new Date(oldest.generatedAt).getTime() : 0;
      return rDate < oldestDate ? r : oldest;
    });
    
    const reportAge = oldestReport.generatedAt 
      ? (Date.now() - new Date(oldestReport.generatedAt).getTime()) / (1000 * 60 * 60) 
      : Infinity;
    
    if (reportAge > 24) {
      console.log(`⚠️ [AI-REPORTS] Relatórios com ${reportAge.toFixed(1)}h de idade. Regenerando...`);
      await generateAndSaveAllReports();
      const freshReports = await db.select().from(chatAiReports);
      return freshReports.map(r => r.content).join('\n\n---\n\n');
    }

    return reports.map(r => r.content).join('\n\n---\n\n');
    
  } catch (error: any) {
    console.error("❌ [AI-REPORTS] Erro ao obter contexto de relatórios:", error.message);
    return "";
  }
}
