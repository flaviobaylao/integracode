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
  "/fornecedores-criticos": "Produtos & Estoque",
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
  "/conferencia-recebimentos": "Financeiro",
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
  // Gestão
  "/gestao-produtos": "Gestão",
  "/gestao-debito-vendas": "Gestão",
  "/painel-atendimento": "Gestão",
  "/relatorios": "Relatórios",
  "/relatorios-ia": "Relatórios",
  // Administracao
  "/pagamento-clientes": "Administração",
  "/cenarios-fiscais": "Administração",
  "/cielo": "Administração",
  "/rh": "Administração",
  "/admin/users": "Administração",
  "/admin/system": "Administração",
  "/admin/empresas": "Administração",
  "/admin/ambiente-fiscal": "Administração",
  "/admin/feriados": "Administração",
  "/chamados": "Chamados",
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

// (05/nov/2026) Caminho de navegacao (breadcrumb) exibido acima do titulo de todas
// as telas: "Integra2.0 > <secao> > <tela>". Rotulos gerados a partir dos itens do
// menu (Layout.tsx menuGroups). Rota sem rotulo aqui usa o titulo (h1) da propria tela.
export const PAGE_MAP: Record<string, { label: string; group: string }> = {
  "/sales-schedule": { label: "Agenda de Vendas", group: "Vendas" },
  "/sales-goals": { label: "Metas de Vendas", group: "Vendas" },
  "/resumo-recebiveis": { label: "Meus Recebíveis", group: "Vendas" },
  "/visit-routes": { label: "Rota de Visitas", group: "Vendas" },
  "/rota-do-dia": { label: "Rota do Dia", group: "Vendas" },
  "/consulta-local": { label: "Consulta no Local", group: "Vendas" },
  "/vendas-digitais": { label: "Vendas Digitais", group: "Vendas" },
  "/canais": { label: "Canais", group: "Vendas" },
  "/carrinhos-loja": { label: "Carrinhos da Loja", group: "Vendas" },
  "/relatorios-graficos": { label: "Relatórios Gráficos", group: "Vendas" },
  "/gestao-carteiras": { label: "Gestão de Carteiras", group: "Vendas" },
  "/telemarketing/sdr-digital": { label: "SDR Digital", group: "Vendas" },
  "/repescagem": { label: "Repescagem", group: "Vendas" },
  "/execucao-rota": { label: "Execução de Rota", group: "Vendas" },
  "/justificativas": { label: "Justificar Visitas", group: "Vendas" },
  "/fechamento-config": { label: "Fechamento de Rotas", group: "Vendas" },
  "/minha-agenda": { label: "Minha Agenda", group: "Vendas" },
  "/visitas": { label: "Visitas", group: "Vendas" },
  "/resumo-visitas": { label: "Resumo de Visitas", group: "Vendas" },
  "/chamados": { label: "Chamados", group: "Chamados" },
  "/viagens": { label: "Programação de Viagens e Outras Despesas", group: "Chamados" },
  "/reembolsos": { label: "Reembolso de Despesas", group: "Chamados" },
  "/extrato-cliente": { label: "Extrato do Cliente", group: "Clientes" },
  "/clientes-ativos": { label: "Clientes Ativos", group: "Clientes" },
  "/clientes-virtuais-hoje": { label: "Clientes Virtuais do Dia", group: "Clientes" },
  "/radar-churn": { label: "Radar de Churn", group: "Clientes" },
  "/fila-resgate": { label: "Fila de Resgate", group: "Clientes" },
  "/programa-indicacao": { label: "Programa de Indicação", group: "Clientes" },
  "/leads": { label: "LEADs", group: "Clientes" },
  "/tabela-precos": { label: "Tabela de Preços", group: "Clientes" },
  "/precos-grade": { label: "Preços (Grade)", group: "Clientes" },
  "/comodatos": { label: "Contratos de Comodato", group: "Clientes" },
  "/rota-entrega": { label: "Minhas Entregas", group: "Logística" },
  "/entregas-do-dia": { label: "Entregas do Dia", group: "Logística" },
  "/validacao-rotas": { label: "Validação de Rotas", group: "Logística" },
  "/check-in-audit": { label: "Auditoria de Check-ins", group: "Logística" },
  "/fluxo-entregas": { label: "Fluxo de Entregas", group: "Logística" },
  "/delivery-routes": { label: "Rotas de Entrega", group: "Logística" },
  "/mapa-clientes": { label: "Mapa de Clientes", group: "Logística" },
  "/temperatura-entregas": { label: "Temperatura das Entregas", group: "Logística" },
  "/hotsite-pricing": { label: "Preços de Venda", group: "Produtos & Estoque" },
  "/estoque": { label: "Gestão de Estoque", group: "Produtos & Estoque" },
  "/auditoria-estoque": { label: "Auditoria de Estoque", group: "Produtos & Estoque" },
  "/abertura-estoque": { label: "Abertura de Estoque do Dia", group: "Produtos & Estoque" },
  "/recebimento-estoque": { label: "Recebimento de Transferências", group: "Produtos & Estoque" },
  "/radar-compras": { label: "Compras", group: "Produtos & Estoque" },
  "/fornecedores": { label: "Fornecedores", group: "Produtos & Estoque" },
  "/fornecedores-criticos": { label: "Fornecedores Críticos", group: "Produtos & Estoque" },
  "/billings": { label: "Faturamentos", group: "Faturamento" },
  "/fiscal-invoices": { label: "Faturamento NF-e", group: "Faturamento" },
  "/inutilizacao-nf": { label: "Inutilização de NF", group: "Faturamento" },
  "/billing-pipeline": { label: "Pipeline Faturamento", group: "Faturamento" },
  "/recuperacao-faturamento": { label: "Recuperação de Faturamento", group: "Faturamento" },
  "/contabilidade-fiscal": { label: "Fiscal", group: "Contabilidade" },
  "/contabilidade-contabil": { label: "Contábil", group: "Contabilidade" },
  "/contabilidade": { label: "Relatórios Contábeis", group: "Contabilidade" },
  "/financeiro?tab=receivables": { label: "Contas a Receber", group: "Financeiro" },
  "/financeiro?tab=payables": { label: "Contas a Pagar", group: "Financeiro" },
  "/financeiro?tab=overdue": { label: "Débitos Vencidos", group: "Financeiro" },
  "/financeiro?tab=blocked": { label: "Pedidos Bloqueados", group: "Financeiro" },
  "/financeiro?tab=chart": { label: "Plano de Contas", group: "Financeiro" },
  "/financeiro?tab=accounts": { label: "Contas Financeiras", group: "Financeiro" },
  "/financeiro?tab=dre": { label: "DRE", group: "Financeiro" },
  "/financeiro?tab=xml": { label: "XMLs", group: "Financeiro" },
  "/financeiro?tab=sped": { label: "SPED Fiscal", group: "Financeiro" },
  "/dashboard-financeiro": { label: "Dashboard Financeiro", group: "Financeiro" },
  "/todas-as-contas": { label: "Todas as Contas", group: "Financeiro" },
  "/fluxo-caixa": { label: "Fluxo de Caixa", group: "Financeiro" },
  "/conciliacao-bancaria": { label: "Conciliação Bancária", group: "Financeiro" },
  "/conferencia-pagamentos": { label: "Conferência de Pagamentos", group: "Financeiro" },
  "/conferencia-recebimentos": { label: "Conferência de Recebimentos", group: "Financeiro" },
  "/auditoria-cobrancas": { label: "Auditoria de Cobranças", group: "Financeiro" },
  "/auditoria-financeira": { label: "Auditoria Financeira", group: "Financeiro" },
  "/lixeira-financeira": { label: "Lixeira Financeira", group: "Financeiro" },
  "/pix-charges": { label: "PIX", group: "Financeiro" },
  "/whatsapp": { label: "WhatsApp", group: "Comunicação" },
  "/telefones-clientes": { label: "Telefones de Clientes", group: "Comunicação" },
  "/telemarketing/atendimento": { label: "Central de Atendimento", group: "Comunicação" },
  "/telemarketing": { label: "Central de Telemarketing", group: "Comunicação" },
  "/telemarketing/conversas": { label: "Dashboard de Conversas", group: "Comunicação" },
  "/telemarketing/templates": { label: "Templates Rápidos", group: "Comunicação" },
  "/telemarketing/analysis": { label: "Análises", group: "Comunicação" },
  "/telemarketing/disparo-em-massa": { label: "Disparo em Massa", group: "Comunicação" },
  "/automacoes-comunicacao": { label: "Automações de Comunicação", group: "Comunicação" },
  "/painel-comunicacao": { label: "Painel de Comunicação", group: "Comunicação" },
  "/admin/agentes": { label: "Agentes IA", group: "Agentes IA" },
  "/marketing": { label: "Central de Marketing", group: "Marketing" },
  "/industria": { label: "Módulo Indústria", group: "Indústria" },
  "/industria-dados": { label: "Matéria-Prima e Receitas", group: "Indústria" },
  "/temperaturas": { label: "Temperaturas", group: "Indústria" },
  "/qualidade-agua": { label: "Qualidade da Água", group: "Indústria" },
  "/gestao-produtos": { label: "Produtos Comercializados", group: "Gestão" },
  "/gestao-debito-vendas": { label: "Débito e Variação de Vendas", group: "Gestão" },
  "/painel-atendimento": { label: "Painel de Atendimento", group: "Gestão" },
  "/trocas-recorrentes": { label: "Trocas Recorrentes", group: "Gestão" },
  "/gestao-trocas": { label: "Gestão de Trocas", group: "Gestão" },
  "/relatorios": { label: "Relatórios Dinâmicos", group: "Relatórios" },
  "/relatorios-ia": { label: "Relatórios IA", group: "Relatórios" },
  "/admin/empresas": { label: "Empresas do Grupo", group: "Administração" },
  "/admin/ambiente-fiscal": { label: "Ambiente Fiscal", group: "Administração" },
  "/rh": { label: "RH", group: "Administração" },
  "/km-vendedores": { label: "Kilometragem Vendedores", group: "Administração" },
  "/pagamento-clientes": { label: "Pagamento Clientes", group: "Administração" },
  "/admin/system": { label: "Administração do Sistema", group: "Administração" },
  "/admin/recursos-prospeccao": { label: "Recursos de Prospecção", group: "Administração" },
  "/admin/amostras": { label: "Amostras para Leads", group: "Administração" },
  "/cenarios-fiscais": { label: "Cenários Fiscais", group: "Administração" },
  "/cielo": { label: "Cielo (PIX/Cartão)", group: "Administração" },
  "/admin/acessos-delegacoes": { label: "Acessos e Delegações", group: "Administração" },
  "/admin/solicitacoes-alteracao": { label: "Solicitações de Alteração", group: "Administração" },
  "/admin/feriados": { label: "Feriados", group: "Administração" },
};

export function pageInfoFor(path: string, search: string = ""): { label: string | null; group: string | null } {
  const p = (path || "").split("?")[0].split("#")[0];
  const q = new URLSearchParams(search || "");
  if (p === "/financeiro" && q.get("tab")) {
    const hit = PAGE_MAP["/financeiro?tab=" + q.get("tab")];
    if (hit) return { label: hit.label, group: hit.group };
  }
  const hit = PAGE_MAP[p];
  const group = PATH_TO_SECTION[p] || hit?.group || groupForPath(p);
  return { label: hit?.label || null, group };
}
