// redeploy: NF-e dedup por chave de acesso
import { db } from './db';
import { sql } from 'drizzle-orm';
import { savedReports } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface ReportFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'currency';
  category: string;
  dbColumn?: string;
  sqlExpr?: string;
}

export interface DataSourceDef {
  key: string;
  label: string;
  description: string;
  fields: ReportFieldDef[];
  baseQuery: string;
}

const DATA_SOURCES: Record<string, DataSourceDef> = {
  customers: {
    key: 'customers',
    label: 'Clientes',
    description: 'Dados de clientes ativos e leads',
    baseQuery: `SELECT c.*, u.name as seller_name FROM customers c LEFT JOIN users u ON c.seller_id = u.id`,
    fields: [
      { key: 'name', label: 'Nome', type: 'text', category: 'Identificação', dbColumn: 'c.name' },
      { key: 'company_name', label: 'Razão Social', type: 'text', category: 'Identificação', dbColumn: 'c.company_name' },
      { key: 'fantasy_name', label: 'Nome Fantasia', type: 'text', category: 'Identificação', dbColumn: 'c.fantasy_name' },
      { key: 'customer_type', label: 'Tipo (PF/PJ)', type: 'text', category: 'Identificação', dbColumn: 'c.customer_type' },
      { key: 'cpf', label: 'CPF', type: 'text', category: 'Identificação', dbColumn: 'c.cpf' },
      { key: 'cnpj', label: 'CNPJ', type: 'text', category: 'Identificação', dbColumn: 'c.cnpj' },
      { key: 'phone', label: 'Telefone', type: 'text', category: 'Contato', dbColumn: 'c.phone' },
      { key: 'email', label: 'Email', type: 'text', category: 'Contato', dbColumn: 'c.email' },
      { key: 'city', label: 'Cidade', type: 'text', category: 'Endereço', dbColumn: 'c.city' },
      { key: 'state', label: 'UF', type: 'text', category: 'Endereço', dbColumn: 'c.state' },
      { key: 'neighborhood', label: 'Bairro', type: 'text', category: 'Endereço', dbColumn: 'c.neighborhood' },
      { key: 'zip_code', label: 'CEP', type: 'text', category: 'Endereço', dbColumn: 'c.zip_code' },
      { key: 'address', label: 'Endereço', type: 'text', category: 'Endereço', dbColumn: 'c.address' },
      { key: 'seller_name', label: 'Vendedor', type: 'text', category: 'Comercial', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'visit_periodicity', label: 'Periodicidade', type: 'text', category: 'Comercial', dbColumn: 'c.visit_periodicity' },
      { key: 'is_lead', label: 'É Lead?', type: 'boolean', category: 'Status', dbColumn: 'c.is_lead' },
      { key: 'is_active', label: 'Ativo?', type: 'boolean', category: 'Status', dbColumn: 'c.is_active' },
      { key: 'created_at', label: 'Data Cadastro', type: 'date', category: 'Datas', dbColumn: 'c.created_at' },
      { key: 'omie_instance_id', label: 'Instância Omie', type: 'text', category: 'Integração', dbColumn: 'c.omie_instance_id' },
    ],
  },
  products: {
    key: 'products',
    label: 'Produtos',
    description: 'Catálogo de produtos com preços e estoque',
    baseQuery: `SELECT p.* FROM products p`,
    fields: [
      { key: 'name', label: 'Nome', type: 'text', category: 'Identificação', dbColumn: 'p.name' },
      { key: 'description', label: 'Descrição', type: 'text', category: 'Identificação', dbColumn: 'p.description' },
      { key: 'omie_codigo', label: 'Código Omie', type: 'text', category: 'Identificação', dbColumn: 'p.omie_codigo' },
      { key: 'ncm', label: 'NCM', type: 'text', category: 'Fiscal', dbColumn: 'p.ncm' },
      { key: 'price', label: 'Preço Base', type: 'currency', category: 'Preços', dbColumn: 'p.price' },
      { key: 'retail_price', label: 'Preço Varejo', type: 'currency', category: 'Preços', dbColumn: 'p.retail_price' },
      { key: 'wholesale_price', label: 'Preço Atacado', type: 'currency', category: 'Preços', dbColumn: 'p.wholesale_price' },
      { key: 'resale_goiania_price', label: 'Preço Revenda Goiânia', type: 'currency', category: 'Preços', dbColumn: 'p.resale_goiania_price' },
      { key: 'resale_interior_price', label: 'Preço Revenda Interior', type: 'currency', category: 'Preços', dbColumn: 'p.resale_interior_price' },
      { key: 'resale_brasilia_price', label: 'Preço Revenda Brasília', type: 'currency', category: 'Preços', dbColumn: 'p.resale_brasilia_price' },
      { key: 'stock', label: 'Estoque', type: 'number', category: 'Estoque', dbColumn: 'p.stock' },
      { key: 'is_active', label: 'Ativo?', type: 'boolean', category: 'Status', dbColumn: 'p.is_active' },
      { key: 'omie_instance_id', label: 'Instância Omie', type: 'text', category: 'Integração', dbColumn: 'p.omie_instance_id' },
    ],
  },
  sales_cards: {
    key: 'sales_cards',
    label: 'Vendas / Pedidos',
    description: 'Cards de vendas com detalhes de pedidos e visitas',
    baseQuery: `SELECT sc.*, c.name as customer_name, c.fantasy_name as customer_fantasy, c.city as customer_city, c.state as customer_state, c.neighborhood as customer_neighborhood, u.name as seller_name FROM sales_cards sc LEFT JOIN customers c ON sc.customer_id = c.id LEFT JOIN users u ON sc.seller_id = u.id`,
    fields: [
      { key: 'customer_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'c.name' },
      { key: 'customer_fantasy', label: 'Nome Fantasia', type: 'text', category: 'Cliente', dbColumn: 'c.fantasy_name' },
      { key: 'customer_city', label: 'Cidade Cliente', type: 'text', category: 'Cliente', dbColumn: 'c.city' },
      { key: 'customer_state', label: 'UF Cliente', type: 'text', category: 'Cliente', dbColumn: 'c.state' },
      { key: 'customer_neighborhood', label: 'Bairro Cliente', type: 'text', category: 'Cliente', dbColumn: 'c.neighborhood' },
      { key: 'seller_name', label: 'Vendedor', type: 'text', category: 'Comercial', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'status', label: 'Status', type: 'text', category: 'Status', dbColumn: 'sc.status' },
      { key: 'operation_type', label: 'Tipo Operação', type: 'text', category: 'Operação', dbColumn: 'sc.operation_type' },
      { key: 'payment_method', label: 'Forma Pagamento', type: 'text', category: 'Operação', dbColumn: 'sc.payment_method' },
      { key: 'sale_value', label: 'Valor Venda', type: 'currency', category: 'Valores', dbColumn: 'sc.sale_value' },
      { key: 'scheduled_date', label: 'Data Agendada', type: 'date', category: 'Datas', dbColumn: 'sc.scheduled_date' },
      { key: 'completed_date', label: 'Data Conclusão', type: 'date', category: 'Datas', dbColumn: 'sc.completed_date' },
      { key: 'last_visit_date', label: 'Última Visita', type: 'date', category: 'Datas', dbColumn: 'sc.last_visit_date' },
      { key: 'is_permanent', label: 'Permanente?', type: 'boolean', category: 'Status', dbColumn: 'sc.is_permanent' },
      { key: 'invoice_number', label: 'Nº NF', type: 'text', category: 'Fiscal', dbColumn: 'sc.invoice_number' },
      { key: 'omie_order_id', label: 'ID Pedido Omie', type: 'text', category: 'Integração', dbColumn: 'sc.omie_order_id' },
      { key: 'created_at', label: 'Data Criação', type: 'date', category: 'Datas', dbColumn: 'sc.created_at' },
    ],
  },
  billings: {
    key: 'billings',
    label: 'Faturamentos',
    description: 'Notas fiscais e faturamentos do Omie',
    baseQuery: `SELECT b.* FROM billings b`,
    fields: [
      { key: 'order_number', label: 'Nº Pedido', type: 'text', category: 'Identificação', dbColumn: 'b.order_number' },
      { key: 'invoice_number', label: 'Nº NF', type: 'text', category: 'Identificação', dbColumn: 'b.invoice_number' },
      { key: 'omie_invoice_id', label: 'ID NF Omie', type: 'text', category: 'Identificação', dbColumn: 'b.omie_invoice_id' },
      { key: 'omie_order_id', label: 'ID Pedido Omie', type: 'text', category: 'Identificação', dbColumn: 'b.omie_order_id' },
      { key: 'customer_fantasy_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'b.customer_fantasy_name' },
      { key: 'customer_document', label: 'CPF/CNPJ', type: 'text', category: 'Cliente', dbColumn: 'b.customer_document' },
      { key: 'omie_customer_code', label: 'Cód. Cliente Omie', type: 'text', category: 'Cliente', dbColumn: 'b.omie_customer_code' },
      { key: 'seller_name', label: 'Vendedor', type: 'text', category: 'Comercial', dbColumn: 'b.seller_name' },
      { key: 'vendor_code', label: 'Código Vendedor', type: 'text', category: 'Comercial', dbColumn: 'b.vendor_code' },
      { key: 'total_value', label: 'Valor Total', type: 'currency', category: 'Valores', dbColumn: 'b.total_value' },
      { key: 'payment_method', label: 'Forma Pagamento', type: 'text', category: 'Operação', dbColumn: 'b.payment_method' },
      { key: 'billing_type', label: 'Tipo', type: 'text', category: 'Operação', dbColumn: 'b.billing_type' },
      { key: 'order_date', label: 'Data Pedido', type: 'date', category: 'Datas', dbColumn: 'b.order_date' },
      { key: 'invoice_date', label: 'Data Faturamento', type: 'date', category: 'Datas', dbColumn: 'b.invoice_date' },
      { key: 'due_date', label: 'Data Vencimento', type: 'date', category: 'Datas', dbColumn: 'b.due_date' },
      { key: 'created_at', label: 'Data Criação', type: 'date', category: 'Datas', dbColumn: 'b.created_at' },
      { key: 'updated_at', label: 'Última Atualização', type: 'date', category: 'Datas', dbColumn: 'b.updated_at' },
      { key: 'invoice_status', label: 'Status NF', type: 'text', category: 'Status', dbColumn: 'b.invoice_status' },
      { key: 'invoice_stage', label: 'Etapa', type: 'text', category: 'Status', dbColumn: 'b.invoice_stage' },
      { key: 'stage_name', label: 'Nome Etapa', type: 'text', category: 'Status', dbColumn: 'b.stage_name' },
      { key: 'is_cancelled', label: 'Cancelada?', type: 'boolean', category: 'Status', dbColumn: 'b.is_cancelled' },
      { key: 'is_urgent', label: 'Urgente?', type: 'boolean', category: 'Status', dbColumn: 'b.is_urgent' },
      { key: 'exclusive_vehicle', label: 'Veículo Exclusivo?', type: 'boolean', category: 'Entrega', dbColumn: 'b.exclusive_vehicle' },
      { key: 'cfop', label: 'CFOP', type: 'text', category: 'Fiscal', dbColumn: 'b.cfop' },
      { key: 'omie_instance_id', label: 'Instância Omie', type: 'text', category: 'Integração', dbColumn: 'b.omie_instance_id' },
    ],
  },
  overdue_debts: {
    key: 'overdue_debts',
    label: 'Débitos Vencidos',
    description: 'Títulos e débitos em atraso',
    baseQuery: `SELECT od.*, c.name as customer_name_join, c.city as customer_city, c.state as customer_state, u.name as seller_name_join FROM overdue_debts od LEFT JOIN customers c ON od.client_id = c.id LEFT JOIN users u ON c.seller_id = u.id`,
    fields: [
      { key: 'client_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'od.client_name' },
      { key: 'customer_city', label: 'Cidade', type: 'text', category: 'Cliente', dbColumn: 'c.city' },
      { key: 'customer_state', label: 'UF', type: 'text', category: 'Cliente', dbColumn: 'c.state' },
      { key: 'seller_name_join', label: 'Vendedor', type: 'text', category: 'Comercial', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'total_amount', label: 'Valor Total Débito', type: 'currency', category: 'Valores', dbColumn: 'od.total_amount' },
      { key: 'max_days_overdue', label: 'Dias em Atraso (Máx)', type: 'number', category: 'Atraso', dbColumn: 'od.max_days_overdue' },
      { key: 'omie_instance_id', label: 'Instância Omie', type: 'text', category: 'Integração', dbColumn: 'od.omie_instance_id' },
    ],
  },
  sales_goals: {
    key: 'sales_goals',
    label: 'Metas de Vendas',
    description: 'Metas mensais dos vendedores',
    baseQuery: `SELECT sg.*, u.name as seller_name FROM sales_goals sg LEFT JOIN users u ON sg.seller_id = u.id`,
    fields: [
      { key: 'seller_name', label: 'Vendedor', type: 'text', category: 'Identificação', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'month', label: 'Mês', type: 'number', category: 'Período', dbColumn: 'sg.month' },
      { key: 'year', label: 'Ano', type: 'number', category: 'Período', dbColumn: 'sg.year' },
      { key: 'positivation_goal', label: 'Meta Positivação', type: 'number', category: 'Metas', dbColumn: 'sg.positivation_goal' },
      { key: 'revenue_goal', label: 'Meta Receita', type: 'currency', category: 'Metas', dbColumn: 'sg.revenue_goal' },
      { key: 'service_goal', label: 'Meta Atendimento', type: 'number', category: 'Metas', dbColumn: 'sg.service_goal' },
    ],
  },
  delivery_routes: {
    key: 'delivery_routes',
    label: 'Rotas de Entrega',
    description: 'Rotas de entrega e paradas',
    baseQuery: `SELECT dr.*, u.name as driver_name FROM delivery_routes dr LEFT JOIN users u ON dr.driver_id = u.id`,
    fields: [
      { key: 'driver_name', label: 'Motorista', type: 'text', category: 'Identificação', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'route_date', label: 'Data Rota', type: 'date', category: 'Datas', dbColumn: 'dr.route_date' },
      { key: 'status', label: 'Status', type: 'text', category: 'Status', dbColumn: 'dr.status' },
      { key: 'total_stops', label: 'Total Paradas', type: 'number', category: 'Métricas', dbColumn: 'dr.total_stops' },
      { key: 'total_distance', label: 'Distância Total (km)', type: 'number', category: 'Métricas', dbColumn: 'dr.total_distance' },
      { key: 'total_duration', label: 'Duração Total (min)', type: 'number', category: 'Métricas', dbColumn: 'dr.total_duration' },
      { key: 'created_at', label: 'Data Criação', type: 'date', category: 'Datas', dbColumn: 'dr.created_at' },
    ],
  },
  users: {
    key: 'users',
    label: 'Usuários / Vendedores',
    description: 'Colaboradores e vendedores do sistema',
    baseQuery: `SELECT u.id, u.name, u.email, u.role, u.is_active, u.omie_vendor_code, u.created_at FROM users u`,
    fields: [
      { key: 'name', label: 'Nome', type: 'text', category: 'Identificação', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'email', label: 'Email', type: 'text', category: 'Contato', dbColumn: 'u.email' },
      { key: 'role', label: 'Cargo', type: 'text', category: 'Acesso', dbColumn: 'u.role' },
      { key: 'is_active', label: 'Ativo?', type: 'boolean', category: 'Status', dbColumn: 'u.is_active' },
      { key: 'omie_vendor_code', label: 'Código Omie', type: 'text', category: 'Integração', dbColumn: 'u.omie_vendor_code' },
      { key: 'created_at', label: 'Data Cadastro', type: 'date', category: 'Datas', dbColumn: 'u.created_at' },
    ],
  },
  fiscal_invoices: {
    key: 'fiscal_invoices',
    label: 'Notas Fiscais (NF-e)',
    description: 'Todas as NF-e emitidas no Integra com dados fiscais completos',
    baseQuery: `SELECT fi.* FROM (SELECT DISTINCT ON (COALESCE(access_key, id)) * FROM fiscal_invoices ORDER BY COALESCE(access_key, id), created_at DESC) fi LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN LATERAL (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS seller_name FROM users u WHERE u.id = sc.seller_id OR u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = REPLACE(COALESCE(sc.seller_id,''),'omie-vendor-','') LIMIT 1) u ON true`,
    fields: [
      { key: 'nf_numero', label: 'Nº NF-e', type: 'text', category: 'Identificação', dbColumn: 'fi.invoice_number' },
      { key: 'nf_serie', label: 'Série', type: 'text', category: 'Identificação', dbColumn: 'fi.series' },
      { key: 'nf_access_key', label: 'Chave de Acesso', type: 'text', category: 'Identificação', dbColumn: 'fi.access_key' },
      { key: 'nf_protocol', label: 'Protocolo', type: 'text', category: 'Identificação', dbColumn: 'fi.protocol_number' },
      { key: 'nf_status', label: 'Situação', type: 'text', category: 'Status', dbColumn: 'fi.status' },
      { key: 'nf_environment', label: 'Ambiente', type: 'text', category: 'Status', dbColumn: 'fi.environment' },
      { key: 'nf_operation_type', label: 'Tipo Operação', type: 'text', category: 'Fiscal', dbColumn: 'fi.operation_type' },
      { key: 'nf_cfop', label: 'CFOP', type: 'text', category: 'Fiscal', dbColumn: 'fi.cfop' },
      { key: 'nf_nature_of_operation', label: 'Natureza Operação', type: 'text', category: 'Fiscal', dbColumn: 'fi.nature_of_operation' },
      { key: 'nf_fin_nfe', label: 'Finalidade NF-e', type: 'text', category: 'Fiscal', dbColumn: 'fi.fin_nfe' },
      { key: 'nf_fiscal_scenario', label: 'Cenário Fiscal', type: 'text', category: 'Fiscal', dbColumn: 'fi.fiscal_scenario_id' },
      { key: 'nf_customer_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_name' },
      { key: 'nf_customer_cnpj_cpf', label: 'CPF/CNPJ Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_cnpj_cpf' },
      { key: 'nf_customer_ie', label: 'IE Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_ie' },
      { key: 'nf_customer_city', label: 'Cidade Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_city' },
      { key: 'nf_customer_uf', label: 'UF Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_uf' },
      { key: 'nf_customer_bairro', label: 'Bairro Cliente', type: 'text', category: 'Cliente', dbColumn: 'fi.customer_bairro' },
      { key: 'nf_issuer_name', label: 'Emitente', type: 'text', category: 'Emitente', dbColumn: 'fi.issuer_name' },
      { key: 'nf_issuer_cnpj', label: 'CNPJ Emitente', type: 'text', category: 'Emitente', dbColumn: 'fi.issuer_cnpj' },
      { key: 'nf_seller_name', label: 'Vendedor', type: 'text', category: 'Comercial', dbColumn: 'u.seller_name' },
      { key: 'nf_total_products', label: 'Total Produtos', type: 'currency', category: 'Valores', dbColumn: 'fi.total_products' },
      { key: 'nf_total_discount', label: 'Total Desconto', type: 'currency', category: 'Valores', dbColumn: 'fi.total_discount' },
      { key: 'nf_total_freight', label: 'Total Frete', type: 'currency', category: 'Valores', dbColumn: 'fi.total_freight' },
      { key: 'nf_total_icms', label: 'Total ICMS', type: 'currency', category: 'Valores', dbColumn: 'fi.total_icms' },
      { key: 'nf_total_pis', label: 'Total PIS', type: 'currency', category: 'Valores', dbColumn: 'fi.total_pis' },
      { key: 'nf_total_cofins', label: 'Total COFINS', type: 'currency', category: 'Valores', dbColumn: 'fi.total_cofins' },
      { key: 'nf_total_ipi', label: 'Total IPI', type: 'currency', category: 'Valores', dbColumn: 'fi.total_ipi' },
      { key: 'nf_total_invoice', label: 'Total NF', type: 'currency', category: 'Valores', dbColumn: 'fi.total_invoice' },
      { key: 'nf_emission_date', label: 'Data Emissão', type: 'date', category: 'Datas', dbColumn: 'fi.emission_date' },
      { key: 'nf_authorization_date', label: 'Data Autorização', type: 'date', category: 'Datas', dbColumn: 'fi.authorization_date' },
      { key: 'nf_omie_instance', label: 'Instância', type: 'text', category: 'Integração', dbColumn: 'fi.omie_instance_id' },
    ],
  },
  fiscal_invoice_items: {
    key: 'fiscal_invoice_items',
    label: 'Notas Fiscais - Produtos Faturados (itens)',
    description: 'Itens/produtos das notas fiscais emitidas',
    fields: [
      { key: 'nf_numero', label: 'Número NF', type: 'text', category: 'Nota', dbColumn: 'fi.invoice_number' },
      { key: 'nf_cliente', label: 'Cliente', type: 'text', category: 'Nota', dbColumn: 'fi.customer_name' },
      { key: 'nf_seller_name', label: 'Vendedor', type: 'text', category: 'Nota', dbColumn: 'u.name', sqlExpr: "TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))" },
      { key: 'product_name', label: 'Produto', type: 'text', category: 'Produto', dbColumn: 'ii.product_name' },
      { key: 'product_code', label: 'Código', type: 'text', category: 'Produto', dbColumn: 'ii.product_code' },
      { key: 'ncm', label: 'NCM', type: 'text', category: 'Fiscal', dbColumn: 'ii.ncm' },
      { key: 'cfop', label: 'CFOP', type: 'text', category: 'Fiscal', dbColumn: 'ii.cfop' },
      { key: 'quantity', label: 'Qtd', type: 'number', category: 'Valores', dbColumn: 'ii.quantity' },
      { key: 'unit_price', label: 'Preço Unit.', type: 'currency', category: 'Valores', dbColumn: 'ii.unit_price' },
      { key: 'total_price', label: 'Total', type: 'currency', category: 'Valores', dbColumn: 'ii.total_price' },
      { key: 'nf_total_products', label: 'Total do Item', type: 'currency', category: 'Valores', dbColumn: 'ii.total_price' },
      { key: 'csosn', label: 'CSOSN', type: 'text', category: 'Fiscal', dbColumn: 'ii.csosn' },
      { key: 'cst_icms', label: 'CST ICMS', type: 'text', category: 'Fiscal', dbColumn: 'ii.cst_icms' },
    ],
    baseQuery: `SELECT ii.*, fi.invoice_number, fi.customer_name, u.name as nf_seller_name FROM fiscal_invoice_items ii LEFT JOIN fiscal_invoices fi ON fi.id = ii.invoice_id LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN users u ON sc.seller_id = u.id`,
  },
  receivables: {
    key: 'receivables',
    label: 'Contas a Receber',
    description: 'Títulos a receber',
    fields: [
      { key: 'title_number', label: 'Título / NF', type: 'text', category: 'Título', dbColumn: 'r.title_number' },
      { key: 'customer_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'r.customer_name' },
      { key: 'customer_document', label: 'CNPJ/CPF', type: 'text', category: 'Cliente', dbColumn: 'r.customer_document' },
      { key: 'category', label: 'Categoria', type: 'text', category: 'Título', dbColumn: 'r.category' },
      { key: 'description', label: 'Descrição', type: 'text', category: 'Título', dbColumn: 'r.description' },
      { key: 'issue_date', label: 'Emissão', type: 'date', category: 'Datas', dbColumn: 'r.issue_date' },
      { key: 'due_date', label: 'Vencimento', type: 'date', category: 'Datas', dbColumn: 'r.due_date' },
      { key: 'amount', label: 'Valor', type: 'currency', category: 'Valores', dbColumn: 'r.amount' },
      { key: 'amount_paid', label: 'Valor Pago', type: 'currency', category: 'Valores', dbColumn: 'r.amount_paid' },
      { key: 'status', label: 'Status', type: 'text', category: 'Título', dbColumn: 'r.status' },
      { key: 'payment_method', label: 'Forma Pgto', type: 'text', category: 'Título', dbColumn: 'r.payment_method' },
      { key: 'omie_instance_id', label: 'Instância', type: 'text', category: 'Integração', dbColumn: 'r.omie_instance_id' },
    ],
    baseQuery: `SELECT r.* FROM (SELECT * FROM receivables WHERE deleted_at IS NULL) r`,
  },
  virtual_service_logs: {
    key: 'virtual_service_logs',
    label: 'Atendimentos Virtuais',
    description: 'Registros de atendimentos virtuais',
    fields: [
      { key: 'customer_name', label: 'Cliente', type: 'text', category: 'Cliente', dbColumn: 'c.name' },
      { key: 'entity_type', label: 'Tipo', type: 'text', category: 'Atendimento', dbColumn: 'vsl.entity_type' },
      { key: 'attendant_name', label: 'Atendente', type: 'text', category: 'Atendimento', dbColumn: 'vsl.attendant_name' },
      { key: 'attendance_date', label: 'Data', type: 'date', category: 'Datas', dbColumn: 'vsl.attendance_date' },
      { key: 'service_type', label: 'Tipo de Serviço', type: 'text', category: 'Atendimento', dbColumn: 'vsl.service_type' },
      { key: 'notes', label: 'Observações', type: 'text', category: 'Atendimento', dbColumn: 'vsl.notes' },
    ],
    baseQuery: `SELECT vsl.*, c.name as customer_name FROM virtual_service_logs vsl LEFT JOIN customers c ON vsl.customer_id = c.id`,
  },
  boleto_charges: {
    key: 'boleto_charges',
    label: 'Cobranças / Boletos',
    description: 'Boletos e cobranças geradas',
    fields: [
      { key: 'nosso_numero', label: 'Nosso Número', type: 'text', category: 'Cobrança', dbColumn: 'bc.nosso_numero' },
      { key: 'debtor_name', label: 'Pagador', type: 'text', category: 'Pagador', dbColumn: 'bc.debtor_name' },
      { key: 'debtor_document', label: 'CNPJ/CPF', type: 'text', category: 'Pagador', dbColumn: 'bc.debtor_document' },
      { key: 'valor_original', label: 'Valor', type: 'currency', category: 'Valores', dbColumn: 'bc.valor_original' },
      { key: 'data_vencimento', label: 'Vencimento', type: 'date', category: 'Datas', dbColumn: 'bc.data_vencimento' },
      { key: 'status', label: 'Status', type: 'text', category: 'Cobrança', dbColumn: 'bc.status' },
      { key: 'created_at', label: 'Criado em', type: 'date', category: 'Datas', dbColumn: 'bc.created_at' },
    ],
    baseQuery: `SELECT bc.* FROM boleto_charges bc`,
  },
};

export function getDataSources(): Omit<DataSourceDef, 'baseQuery'>[] {
  return Object.values(DATA_SOURCES).map(({ baseQuery, ...rest }) => rest);
}

export function getDataSourceFields(sourceKey: string): ReportFieldDef[] | null {
  const source = DATA_SOURCES[sourceKey];
  return source ? source.fields : null;
}

export interface ReportConfig {
  dataSource: string;
  columns: string[];
  groupBy?: string[];
  aggregations?: { field: string; fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'count_distinct' }[];
  filters?: { field: string; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is_null' | 'is_not_null'; value?: any }[];
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  dateBuckets?: Record<string, 'day' | 'month' | 'year'>;
}

function sanitizeIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\.]/g, '');
}

function fieldSql(field: ReportFieldDef): string | null {
  if (field.sqlExpr) return field.sqlExpr;
  if (field.dbColumn) return sanitizeIdentifier(field.dbColumn);
  return null;
}

function bucketExpr(col: string, bucket: 'day' | 'month' | 'year'): string {
  const local = `(${col} AT TIME ZONE 'America/Sao_Paulo')`;
  if (bucket === 'year') return `to_char(${local}, 'YYYY')`;
  if (bucket === 'month') return `to_char(${local}, 'YYYY-MM')`;
  return `to_char(${local}, 'YYYY-MM-DD')`;
}

function extractFromClause(baseQuery: string): string {
  const fromIdx = baseQuery.toUpperCase().indexOf(' FROM ');
  if (fromIdx === -1) throw new Error('Invalid base query: no FROM clause');
  return baseQuery.substring(fromIdx);
}

function escapeValue(value: any): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function executeReport(config: ReportConfig): Promise<{ rows: any[]; totalRows: number; columns: string[] }> {
  const source = DATA_SOURCES[config.dataSource];
  if (!source) throw new Error(`Fonte de dados "${config.dataSource}" não encontrada`);

  const fieldMap = new Map(source.fields.map(f => [f.key, f]));
  const hasGroupBy = config.groupBy && config.groupBy.length > 0;
  const hasAggregations = config.aggregations && config.aggregations.length > 0;
  const fromClause = extractFromClause(source.baseQuery);

  let selectParts: string[] = [];
  let resultColumns: string[] = [];

  if (hasGroupBy) {
    for (const gKey of config.groupBy!) {
      const field = fieldMap.get(gKey);
      if (!field) continue;
      let col = fieldSql(field);
      if (!col) continue;
      const gbkt = config.dateBuckets && config.dateBuckets[gKey];
      if (gbkt) col = bucketExpr(col, gbkt);
      selectParts.push(`${col} AS "${sanitizeIdentifier(gKey)}"`);
      resultColumns.push(gKey);
    }
  }

  if (hasAggregations) {
    for (const agg of config.aggregations!) {
      const field = fieldMap.get(agg.field);
      if (!field) continue;
      const col = fieldSql(field);
      if (!col) continue;
      const alias = `${agg.fn}_${sanitizeIdentifier(agg.field)}`;
      switch (agg.fn) {
        case 'sum': selectParts.push(`COALESCE(SUM(CAST(${col} AS numeric)), 0) AS "${alias}"`); break;
        case 'count': selectParts.push(`COUNT(${col}) AS "${alias}"`); break;
        case 'count_distinct': selectParts.push(`COUNT(DISTINCT ${col}) AS "${alias}"`); break;
        case 'avg': selectParts.push(`COALESCE(AVG(CAST(${col} AS numeric)), 0) AS "${alias}"`); break;
        case 'min': selectParts.push(`MIN(${col}) AS "${alias}"`); break;
        case 'max': selectParts.push(`MAX(${col}) AS "${alias}"`); break;
      }
      resultColumns.push(alias);
    }
  }

  if (!hasGroupBy && !hasAggregations) {
    const cols = config.columns.length > 0 ? config.columns : source.fields.map(f => f.key);
    for (const key of cols) {
      const field = fieldMap.get(key);
      if (!field) continue;
      const col = fieldSql(field);
      if (!col) continue;
      selectParts.push(`${col} AS "${sanitizeIdentifier(key)}"`);
      resultColumns.push(key);
    }
  }

  if (selectParts.length === 0) {
    selectParts.push('1');
    resultColumns.push('_');
  }

  let query = `SELECT ${selectParts.join(', ')} ${fromClause}`;

  const whereConditions: string[] = [];

  if (config.filters && config.filters.length > 0) {
    for (const filter of config.filters) {
      const field = fieldMap.get(filter.field);
      if (!field) continue;
      const col = fieldSql(field);
      if (!col) continue;

      switch (filter.operator) {
        case 'eq':
          whereConditions.push(`${col} = ${escapeValue(filter.value)}`);
          break;
        case 'neq':
          whereConditions.push(`${col} != ${escapeValue(filter.value)}`);
          break;
        case 'gt':
          whereConditions.push(`${col} > ${escapeValue(filter.value)}`);
          break;
        case 'gte':
          whereConditions.push(`${col} >= ${escapeValue(filter.value)}`);
          break;
        case 'lt':
          whereConditions.push(`${col} < ${escapeValue(filter.value)}`);
          break;
        case 'lte':
          whereConditions.push(`${col} <= ${escapeValue(filter.value)}`);
          break;
        case 'like':
          whereConditions.push(`CAST(${col} AS text) ILIKE ${escapeValue(`%${filter.value}%`)}`);
          break;
        case 'in':
          if (Array.isArray(filter.value) && filter.value.length > 0) {
            whereConditions.push(`${col} IN (${filter.value.map(escapeValue).join(', ')})`);
          }
          break;
        case 'is_null':
          whereConditions.push(`${col} IS NULL`);
          break;
        case 'is_not_null':
          whereConditions.push(`${col} IS NOT NULL`);
          break;
      }
    }
  }

  if (whereConditions.length > 0) {
    query += ` WHERE ${whereConditions.join(' AND ')}`;
  }

  if (hasGroupBy) {
    const groupCols = config.groupBy!
      .map(k => { const f = fieldMap.get(k); if (!f) return null; const c = fieldSql(f); if (!c) return null; const b = config.dateBuckets && config.dateBuckets[k]; return b ? bucketExpr(c, b) : c; })
      .filter(Boolean) as string[];
    if (groupCols.length > 0) {
      query += ` GROUP BY ${groupCols.join(', ')}`;
    }
  }

  if (config.orderBy && config.orderBy.length > 0) {
    const orderParts: string[] = [];
    for (const ord of config.orderBy) {
      const isAgg = ord.field.includes('_') && ['sum', 'count', 'avg', 'min', 'max', 'count_distinct'].some(fn => ord.field.startsWith(fn + '_'));
      if (isAgg) {
        orderParts.push(`"${sanitizeIdentifier(ord.field)}" ${ord.direction === 'desc' ? 'DESC' : 'ASC'}`);
      } else {
        const field = fieldMap.get(ord.field);
        const oc = field ? fieldSql(field) : null;
        if (oc) {
          orderParts.push(`${oc} ${ord.direction === 'desc' ? 'DESC' : 'ASC'}`);
        }
      }
    }
    if (orderParts.length > 0) {
      query += ` ORDER BY ${orderParts.join(', ')}`;
    }
  }

  const maxLimit = Math.min(config.limit || 5000, 10000);
  query += ` LIMIT ${maxLimit}`;

  const whereClause = whereConditions.length > 0 ? ` WHERE ${whereConditions.join(' AND ')}` : '';
  const countQuery = hasGroupBy
    ? `SELECT COUNT(*) as total FROM (${query.replace(/ LIMIT \d+/, '')}) _counted`
    : `SELECT COUNT(*) as total ${fromClause}${whereClause}`;

  try {
    const [dataResult, countResult] = await Promise.all([
      db.execute(sql.raw(query)),
      db.execute(sql.raw(countQuery)),
    ]);

    const rows = Array.isArray(dataResult) ? dataResult : (dataResult as any).rows || [];
    const countRows = Array.isArray(countResult) ? countResult : (countResult as any).rows || [];
    const totalRows = countRows.length > 0 ? parseInt(String((countRows[0] as any).total || '0')) : 0;

    return { rows, totalRows, columns: resultColumns };
  } catch (err: any) {
    console.error('[REPORT ENGINE] Query error:', err.message);
    console.error('[REPORT ENGINE] Query was:', query);
    throw new Error(`Erro ao executar relatório: ${err.message}`);
  }
}

export async function getSavedReports(userId?: string) {
  const results = await db.select().from(savedReports).orderBy(savedReports.updatedAt);
  return results;
}

export async function getSavedReport(id: string) {
  const [result] = await db.select().from(savedReports).where(eq(savedReports.id, id));
  return result;
}

export async function createSavedReport(data: any) {
  const [result] = await db.insert(savedReports).values(data).returning();
  return result;
}

export async function updateSavedReport(id: string, data: any) {
  const [result] = await db.update(savedReports)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(savedReports.id, id))
    .returning();
  return result;
}

export async function deleteSavedReport(id: string) {
  await db.delete(savedReports).where(eq(savedReports.id, id));
}
