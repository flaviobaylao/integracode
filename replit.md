# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos, designed to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. It features robust sales tracking, reporting, and route optimization, with fine-grained access control for various user roles. The system aims to enhance business efficiency, improve customer service, and expand market reach, including an e-commerce platform ("Hotsite Instagram") for direct sales, and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing).
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer displays prioritizing `fantasy_name`, and normalization of weekday formats.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking with release functionality, and customer "positivation" based on Omie billings.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Features include manual customer addition to routes, deletion of visits from daily routes, and temporary local route re-optimization. Route generation is now based directly on customer data and `visit_schedule_history`.
- **Visit Schedule History System**: Persistent tracking of all scheduled visits (past and future) with completion status, based on customer-specific periodicity (weekly, bi-weekly, monthly, bi-monthly) anchored to `serviceStartDate`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Automated Agenda Management**: Scheduled daily and on-demand synchronization, now focusing on `visit_schedule_history` for visit dates and `order_history` for order details.
- **Sales Card Configuration Replication**: Role-based propagation system for sales card configuration changes (e.g., recurrenceType, paymentMethod) to future or all non-finalized cards. Includes automatic recurrence change propagation (creating/cancelling future cards within a 60-day window).
- **Sales Schedule Filtering**: Client-side search and weekday filtering.
- **Customer Weekdays Management in Sale Flow**: Editable for administrative users, read-only for vendors.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling on correct weekdays, automated seller validation, and admin tools for diagnosis and correction.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices, including product mapping and customer registration.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time.
- **Sales Goals Dashboard**: Individual seller metrics using aggregated SQL queries with refined CFOP filtering.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management).
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Available at `/shop` path.
    - **Public API Routes**: Separate public endpoints for products, orders, customer checks, and reviews.
    - **Structure**: Standalone React SPA with mobile-first design.
    - **Customer Type Selection**: Interactive flow determines pricing table (Consumer: Retail/Wholesale; Reseller: Location-based with CNPJ verification).
    - **Validation**: Pre-checkout CPF validation for consumers, automatic data retrieval from Receita Federal API for reseller CNPJ verification.
    - **Customer Recognition**: Triple-layer lookup (email OR phone OR CPF/CNPJ) prevents duplicates and auto-fills data.
    - **Automatic Omie Registration**: New hotsite customers automatically registered in Omie ERP.
    - **Dynamic Pricing**: Five price tables based on customer type.
    - **Security**: Server-side price validation, stock verification, and validated CPF/CNPJ enforcement.
    - **Integration**: Orders automatically registered in Sistema Integra as `sales_cards` with `source: 'hotsite'`.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (PJ only).
    - **Product Gallery System**: Multiple images per product with touch-swipe navigation and zoom.
    - **Product Image Management**: Admin interface for uploading multiple images.
    - **Review System**: Customer product reviews with ratings, comments, and admin approval.
    - **Stock Management**: Accepts orders regardless of inventory levels.
    - **Hotsite Orders Management**: Dedicated page for managing hotsite orders with filtering.

# External Dependencies

- **Neon PostgreSQL**
- **Drizzle ORM**
- **Replit Authentication**
- **Passport.js**
- **Radix UI**
- **Lucide React**
- **Tailwind CSS**
- **Leaflet**
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **App Entregas Honest**
- **OSRM API**

# Recent Changes

## 2025-11-07: Barra de Rolagem no Menu Lateral
- **Adicionado**: Barra de rolagem automática no menu lateral (sidebar)
- **Benefício**: Facilita acesso a todas as abas quando há muitos itens de menu
- **Implementação**: Menu agora usa `overflow-y-auto` com versão do sistema fixa no rodapé

## 2025-11-07: Correção - Vendas Atuais em Metas de Vendas  
- **Bug corrigido**: Vendas não apareciam na aba "Metas de Vendas" (valores zerados)
- **Causa raiz**: Filtros incompletos - faltavam critérios de Situação e Operação do Omie
- **Solução aplicada**: Implementados **todos** os filtros do Omie:
  - **CFOP**: Vazio ou 1.201 (Devolução) / 5.101 (Venda)
  - **Situação**: `invoice_status = '100'` (Autorizado/Devolvido)
  - **Operação**: `billing_type IN ('venda', 'devolução')` (Pedido de Venda + Devolução de Venda)
  - **Não canceladas**: `is_cancelled = false`
- **Lógica CFOP**: Se vazio → incluir; Se preenchido → validar contra lista permitida
- **Nota**: Vendedores "Fabio H." e "Flávio" aparecem no Omie mas não precisam estar no Sistema Integra

## 2025-11-07: Atualização de Distância Estimada na Re-otimização de Rota
- **Nova funcionalidade**: Distância estimada atualiza em tempo real após re-otimização local
- **Estado local**: Adicionado `localEstimatedDistance` para armazenar distância calculada
- **Conversão**: Backend retorna km, frontend armazena em metros para compatibilidade
- **Limpeza de estado**: Estados locais resetam corretamente quando rota é regenerada, vendedor ou data mudam
- **Validação**: Guard para evitar NaN quando distância não for válida

## 2025-11-07: Correção - Abertura de Card de Vendas nas Rotas
- **Bug corrigido**: Card de vendas não abria ao clicar nas linhas da rota
- **Causa**: Estrutura de dados da rota mudou de `salesCardId` para `customerId`
- **Solução**: 
  - Modificado `handleOpenCardDetails` para buscar cards por data e filtrar por customerId
  - Modificado `handleEditCard` com a mesma lógica
  - Toast informativo quando card não existe para a data
- **Impacto**: Usuários agora podem clicar nas visitas da rota e ver/editar os cards de vendas corretamente

## 2025-11-07: Integração de Atendimento RH em Metas de Vendas
- **Modificação**: Campo "Atendimento" em Metas de Vendas agora usa dados reais de visitas
- **Fonte de dados**: Integrado com sistema RH de atendimento (`daily_routes` + `route_checkpoints`)
- **Cálculo**: Média do percentual de visitas completadas vs agendadas (igual à aba RH)
- **Filtros aplicados**:
  - Apenas rotas do mês selecionado
  - Apenas rotas até a data atual (exclui rotas futuras)
  - Filtro condicional por vendedor (funciona em visão agregada e individual)
- **Consistência**: Ambas abas (RH e Metas) usam mesma lógica e fonte de dados

## 2025-11-07: Sistema de Performance de Atendimento (RH)
- **Nova funcionalidade**: Aba "Atendimento" no módulo RH
- **Rastreamento diário**: Registra automaticamente o percentual de visitas completadas vs agendadas
- **Cálculo automático**: Baseado em dados de `daily_routes` (visitas agendadas) e `route_checkpoints` (check-outs)
- **Métricas exibidas**:
  - Percentual de atendimento dia a dia
  - Média mensal de atendimento (média dos dias com visitas)
  - Total de visitas agendadas vs completadas no mês
  - Percentual geral do mês
- **Indicadores visuais**: Cores (verde ≥80%, amarelo ≥60%, vermelho <60%)
- **Endpoint API**: GET `/api/hr/daily-attendance` com filtros de mês/ano
- **Tipos compartilhados**: `DailyAttendanceData` e `SellerAttendancePerformance` em `shared/schema.ts`

## 2025-11-07: Badges de Notificação no Menu Lateral
- **Removido**: Ícone de sino (notificação) no canto superior direito
- **Adicionado**: Badge vermelho com contador nas abas do menu:
  - "Pedidos Bloqueados": Mostra número de pedidos com status 'blocked'
  - "Pedidos do Site": Mostra número total de pedidos recebidos do hotsite
- **Comportamento**: Badges aparecem apenas quando há pedidos (contador > 0)
- **Cor**: Badge vermelho (#bg-red-500) para destacar itens que requerem atenção

## 2025-11-07: Busca de Clientes Aprimorada
- **Melhorias**: Busca agora funciona para todos os campos:
  - Nome Fantasia (ex: "GRASSA")
  - Razão Social (nome completo/oficial)
  - CNPJ (com ou sem formatação)
  - CPF (com ou sem formatação)
  - Telefone (com ou sem formatação)
- **Comportamento**: Busca inteligente que remove pontos, hífens e espaços automaticamente
- **Case-insensitive**: Não diferencia maiúsculas de minúsculas

## 2025-11-07: Coluna Última Atividade - Exibição de Data
- **Mudança**: Coluna "Última Atividade" agora mostra a data da última venda
- **Formato**: dd/mm/aaaa (formato brasileiro)
- **Quando vazio**: Exibe "Nunca" se o cliente não tiver vendas
- **Fonte**: `billings.invoiceDate` dos faturamentos importados do Omie ERP
- **Filtros**: Apenas faturamentos com `isCancelled = false` e `totalValue > 0`
- **Bug corrigido**: Anteriormente usava `sales_cards.scheduledDate` (datas futuras agendadas), agora usa vendas reais

## 2025-11-07: Botão de Inativação de Cliente
- **Funcionalidade**: Botão "Inativar Cliente" no modal de edição (somente para clientes ativos)
- **Confirmação**: AlertDialog com lista de consequências da inativação
- **Consequências da inativação**:
  1. Cliente não aparecerá mais nas rotas de visitas
  2. Não será considerado na carteira para fins de positivação
  3. Cliente pode ser reativado posteriormente editando e mudando status
- **Localização**: Lado esquerdo do rodapé do modal de edição (botão vermelho)
- **Permissão**: Requer permissão de edição de cliente (admin/coordinator/administrative)

## 2025-11-07: Filtro de Positivação
- **Funcionalidade**: Novo filtro "Positivação" na tela de Gestão de Clientes
- **Opções**: Todos / SIM / NÃO
- **Comportamento**: Filtra clientes baseado em `isPositivatedThisMonth` (faturamento no mês)

## 2025-11-07: Positivação baseada em Faturamentos (Billings)
- **Mudança**: Coluna "Positivado" agora exibe SIM (verde) ou NÃO (vermelho)
- **Fonte de dados**: Tabela `billings` (faturamentos do Omie) ao invés de `sales_cards`
- **Lógica**: Cliente positivado se tem `invoiceDate` no mês corrente, `isCancelled = false`, e `totalValue > 0`
- **Relacionamento**: `customers.omieClientCode` → `billings.omieCustomerCode`
- **Benefício**: Dados refletem faturamentos reais do ERP Omie, não apenas pedidos internos

## 2025-11-07: Correção de Filtros - Normalização de Dias da Semana
- **Bugs corrigidos**: 
  1. Dias da semana não apareciam no modal de edição de clientes
  2. Filtro de dia da semana não funcionava na tabela de clientes
  3. Filtro de data de rota não encontrava clientes
- **Causa raiz**: Dados armazenados em múltiplos formatos ("quarta", "Qua", "Sex", "monday", etc.)
- **Solução**: Função `normalizeWeekdays()` aplicada em 3 locais:
  1. `CustomerModal.tsx`: Normaliza ao exibir botões de seleção
  2. `CustomerManagement.tsx`: Normaliza nos filtros de weekday (linha 153) e data de rota (linha 180)
  3. `getWeekdaysLabel()`: Normaliza na exibição da coluna "Dias da Semana"
- **Formatos aceitos**: 
  - Abreviado PT: "Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"
  - Completo PT: "segunda", "terça", "quarta", etc. (com/sem acento)
  - Com "-feira": "segunda-feira", "terça-feira", etc.
  - Inglês (legacy): "monday", "tuesday", etc.
- **Impacto**: Todos os filtros e exibições funcionam independente do formato armazenado no banco de dados