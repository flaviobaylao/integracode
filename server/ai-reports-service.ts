import { db } from "./db";
import { customers, overdueDebts, billings, chatAiReports } from "@shared/schema";
import { eq, sql, desc, and, gte, isNull, isNotNull } from "drizzle-orm";

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
    
    lines.push(`- Status Omie: ${customer.omieStatus || 'ativo'}`);
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
  
  const allDebts = await db.select().from(overdueDebts);

  const lines: string[] = [
    `# DÉBITOS VENCIDOS - HONEST SUCOS`,
    `Atualizado em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`,
    `Total de clientes com débitos: ${allDebts.length}`,
    `---`,
    ``
  ];

  let totalDebt = 0;

  for (const debt of allDebts) {
    const amount = parseFloat(debt.totalAmount?.toString() || '0');
    totalDebt += amount;
    
    lines.push(`## ${debt.clientName}`);
    lines.push(`- Doc: ${debt.clientDocument || 'N/D'}`);
    lines.push(`- Total em débito: R$ ${amount.toFixed(2)}`);
    lines.push(`- Dias de atraso máximo: ${debt.maxDaysOverdue} dias`);
    
    if (debt.debts && Array.isArray(debt.debts)) {
      lines.push(`- Detalhes dos títulos:`);
      for (const d of debt.debts) {
        lines.push(`  * Doc ${d.numero_documento}: R$ ${d.valor?.toFixed(2)} (venc: ${d.data_vencimento}, ${d.dias_atraso} dias atraso)`);
      }
    }
    
    lines.push(``);
  }

  lines.splice(3, 0, `Valor total em débitos: R$ ${totalDebt.toFixed(2)}`);

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
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const recentBillings = await db
    .select()
    .from(billings)
    .where(
      and(
        gte(billings.orderDate, thirtyDaysAgo),
        eq(billings.isCancelled, false)
      )
    )
    .orderBy(desc(billings.orderDate));

  const customerSummary: Record<string, { 
    name: string; 
    document: string; 
    totalValue: number; 
    orderCount: number;
    lastOrder: string;
  }> = {};

  for (const billing of recentBillings) {
    const key = billing.customerDocument || billing.customerFantasyName;
    if (!customerSummary[key]) {
      customerSummary[key] = {
        name: billing.customerFantasyName,
        document: billing.customerDocument || 'N/D',
        totalValue: 0,
        orderCount: 0,
        lastOrder: ''
      };
    }
    
    customerSummary[key].totalValue += parseFloat(billing.totalValue?.toString() || '0');
    customerSummary[key].orderCount += 1;
    
    if (!customerSummary[key].lastOrder) {
      customerSummary[key].lastOrder = billing.orderDate 
        ? new Date(billing.orderDate).toLocaleDateString('pt-BR') 
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
