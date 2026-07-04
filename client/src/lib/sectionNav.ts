// client/src/lib/sectionNav.ts
// Mapa rota -> secao do sidebar (grupo). Usado pelo botao "Voltar para <secao>"
// (BackToDashboardButton) para voltar ao grid inicial da secao a que a pagina pertence.
// (05/jul/2026) Os rotulos batem com menuGroups[].groupLabel de Layout.tsx.

export const PATH_TO_SECTION: Record<string, string> = {
  // Vendas
  "/sellers": "Vendas",
  "/sales-schedule": "Vendas",
  "/sales-goals": "Vendas",
  "/visit-routes": "Vendas",
  "/rota-do-dia": "Vendas",
  "/vendas-digitais": "Vendas",
  "/repescagem": "Vendas",
  "/execucao-rota": "Vendas",
  "/justificativas": "Vendas",
  "/minha-agenda": "Vendas",
  "/visitas": "Vendas",
  "/resumo-visitas": "Vendas",
  // Clientes
  "/clientes-ativos": "Clientes",
  "/clientes-virtuais-hoje": "Clientes",
  "/radar-churn": "Clientes",
  "/fila-resgate": "Clientes",
  "/indicacoes": "Clientes",
  "/leads": "Clientes",
  "/tabela-precos": "Clientes",
  "/precos-grade": "Clientes",
  // Logistica
  "/mapa-clientes": "Logística",
  "/rota-entrega": "Logística",
  "/entregas-do-dia": "Logística",
  "/validacao-rotas": "Logística",
  "/check-in-audit": "Logística",
  "/auditoria-checkins": "Logística",
  "/check-in-photos": "Logística",
  "/delivery-dashboard": "Logística",
  "/delivery-management": "Logística",
  "/delivery-routes": "Logística",
  "/routes-management": "Logística",
  "/driver-management": "Logística",
  "/delivery-reports": "Logística",
  // Produtos & Estoque
  "/estoque": "Produtos & Estoque",
  "/hotsite-pricing": "Produtos & Estoque",
  "/hotsite-orders": "Produtos & Estoque",
  "/cupons": "Produtos & Estoque",
  "/fornecedores": "Produtos & Estoque",
  // Faturamento
  "/billings": "Faturamento",
  "/fiscal-invoices": "Faturamento",
  "/billing-pipeline": "Faturamento",
  "/blocked-orders": "Faturamento",
  "/recuperacao-faturamento": "Faturamento",
  // Financeiro
  "/contas-receber": "Financeiro",
  "/overdue-debts": "Financeiro",
  "/dashboard-financeiro": "Financeiro",
  "/todas-as-contas": "Financeiro",
  "/fluxo-caixa": "Financeiro",
  "/conciliacao-bancaria": "Financeiro",
  "/conferencia-pagamentos": "Financeiro",
  "/auditoria-cobrancas": "Financeiro",
  "/radar-compras": "Financeiro",
  "/pix-charges": "Financeiro",
  // Comunicacao
  "/whatsapp": "Comunicação",
  "/telefones-clientes": "Comunicação",
  "/automacoes-comunicacao": "Comunicação",
  // Industria
  "/industria": "Indústria",
  "/industria-dados": "Indústria",
  // Relatorios
  "/relatorios": "Relatórios",
  "/relatorios-ia": "Relatórios",
  // Administracao
  "/pagamento-clientes": "Administração",
  "/cenarios-fiscais": "Administração",
  "/cielo": "Administração",
  "/rh": "Administração",
  "/admin/users": "Administração",
  "/admin/system": "Administração",
  "/admin/omie-instances": "Administração",
  "/admin/omie-stage-logs": "Administração",
  "/admin/sync-monitor": "Administração",
};

// Retorna o rotulo do grupo (secao) para uma rota, ou null se desconhecida.
export function groupForPath(path: string): string | null {
  if (!path) return null;
  const p = path.split("?")[0].split("#")[0];
  if (PATH_TO_SECTION[p]) return PATH_TO_SECTION[p];
  // prefixos / casos especiais
  if (p.startsWith("/telemarketing")) return p.includes("sdr-digital") ? "Vendas" : "Comunicação";
  if (p.startsWith("/admin/agentes")) return "Agentes IA";
  if (p.startsWith("/financeiro")) return "Financeiro";
  if (p.startsWith("/admin/")) return "Administração";
  return null;
}
