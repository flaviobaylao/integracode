# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. It optimizes business operations by integrating customer relationship management, product catalog administration, sales tracking, and WhatsApp communication. The system aims to enhance efficiency, improve customer service, expand market reach, and increase sales through features like sales tracking, advanced route optimization, access control, an integrated e-commerce platform ("Hotsite Instagram"), and real-time billing data synchronization with Omie ERP for customer "positivation" status. It also includes robust financial management, lead management, inventory control, and an NF-e emission module to provide a complete operational solution.

# User Preferences

- **Communication Style**: Simple, everyday language.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.
- **Hotsite Design**: Premium landing page inspired by Solti.com, featuring a hero section, badges, ingredient showcase, product showcase, benefits, and an enhanced footer with a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista, industria). The "industria" role has exclusive access (alongside admin) to the Industry/NF-e module.
- **WhatsApp Integration**: Evolution API for message sending, real-time conversation tracking, and webhook support with automatic URL validation. Supports media message downloading and features a comprehensive chat center with intelligent round-robin agent distribution, quick templates, status tracking, and optional ChatGPT standby.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer display prioritization, and strict abbreviated weekday format throughout the system.
- **Sales & Financial Management**: Sales card tracking, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a commission-based sales goals dashboard. Sellers are classified into 3 types (vendedor_clt, vendedor_pj, telemarketing) with type-specific commission tiers. Only revenue (faturamento) goals are tracked. Telemarketing has a collective goal. Commission dashboard shows Meta vs Projetado, commission tier maps, and monthly achievement history (`sales_goal_history` table). Seller type is stored in `users.seller_type` column. Sales metrics aggregate billings across ALL Omie instances using `users.omie_vendor_codes` (JSON mapping instanceId→vendorCode). A single goal per seller covers combined results from all instances.
- **Delivery & Route Optimization**: Scheduled daily route generation using Nearest Neighbor + 2-opt and OSRM API. Intelligent regional sectorization using K-means clustering with Haversine distance. Features include visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, driver transfer, and a mobile-friendly driver interface with GPS check-in/check-out and photo capture. Omie invoice stage synchronization is automated based on delivery status.
- **Customer Management**: Client-side search and filtering, inactivation, detailed delivery configurations, and a three-layer date system for visit days. An interactive Leaflet map displays active customers with color-coded pins and in-map editing.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Supports order blocking and Hotsite order submission to Omie with automatic customer creation and robust validation. Includes automatic cleanup for billings no longer present in Omie.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **System Administration**: Admin-only page with data maintenance tools, including delivery days recalculation.
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection, 5-tier dynamic pricing, server-side security, automatic order registration as `sales_cards`, product gallery, stock management, and differentiated payment methods.
- **Leads Management**: Integrated lead tracking with route optimization, full customer registration form with "isLead" flag. Supports automatic creation, seller assignment, check-in/check-out with photo requirement, location validation, and conversion to full customer workflow. Automatic check-out for uncompleted visits.
- **Phone Number Mapping**: Maps alternative phone numbers to canonical numbers to consolidate conversations, managed via an admin-only API.
- **Automatic Data Backup**: Complete backup system for all order data with daily scheduled backups and manual trigger options.
- **Inventory/Stock Management**: Comprehensive stock control with lot tracking, per-instance stock (in-use and blocked), color-coded instance display, automatic stock transfers, and integration with NF-e billing flows.
- **ChatGPT Auto-Attendance**: Configurable AI-powered customer service system with four operating modes, configurable business hours, handoff keywords, customizable prompts, model selection, test interface, and audit logging. Supports automated order capture via ChatGPT, allowing customers to place orders through a form-based approach via WhatsApp or by redirecting to a simplified virtual store.
- **Virtual Service Logging**: Attendants can log virtual customer service interactions with notes, image attachments, automatic attendant tracking, full history view, and service type categorization (Débito Vencido, Venda, Prospecção). Supports both customer and lead service logging.
- **Virtual Attendance Statistics**: Chat Center includes an "Atendimentos" tab showing virtual attendance statistics per agent and date, with date range filtering, summary cards, and detailed breakdown.
- **Omie Stage Transition Logging**: All order stage transitions in Omie are logged, recording order ID, customer name, previous/new stage, trigger type, success/error status, driver email, and Omie API response.
- **NF-e Emission Module**: Complete fiscal invoice (Nota Fiscal Eletrônica) management system. Features fiscal scenarios (CFOP codes), secure digital certificate management (A1), full invoice lifecycle management (CRUD), SEFAZ integration (homologação mode currently), event timeline for audit, and SHA-256 checksummed backups. Designed as a future replacement for Omie invoicing.
- **Billing Pipeline (Kanban)**: Internal billing kanban system with 7 stages (Pedido, A Faturar, Faturado, Impresso, Aguardando Rota, Em Rota, Entregue). Features a visual board with card movement, detail modal, stage history audit trail, and access control. Includes auto-receivable creation when an order moves to "faturado".
- **Financial Module**: Comprehensive financial management with 7 tabs: Contas a Receber, Contas a Pagar, Plano de Contas, Contas Financeiras, DRE, XMLs, and SPED Fiscal. All financial data supports omieInstanceId filtering.
- **Dynamic Reports Module**: Fully customizable report builder at `/relatorios` with pivot table functionality. Supports 8 data sources (Clientes, Produtos, Vendas, Faturamentos, Débitos Vencidos, Metas, Rotas de Entrega, Usuários). Features include: field selection for rows/columns, groupBy aggregation (sum/count/avg/min/max/count_distinct), dynamic filters with multiple operators, custom ordering, CSV export, and saved report templates. Backend report engine (`server/reportEngine.ts`) dynamically constructs SQL queries with sanitized identifiers. Access restricted to admin/coordinator/administrative roles.
- **Purchase Invoice Radar**: NF-e purchase invoice management system at `/radar-compras`. Features XML import/parsing, supplier detection, auto-matching to Omie instances via CNPJ, chart-of-accounts classification, automatic payable creation, stock replenishment integration, and summary statistics dashboard. Supports manual XML import with future SEFAZ DF-e automatic scanning capability. Status flow: detected → imported → classified → linked → paid.

# External Dependencies

- **Neon PostgreSQL**
- **Drizzle ORM**
- **Replit Authentication**
- **Passport.js**
- **Radix UI**
- **Lucide React**
- **Tailwind CSS**
- **Leaflet**
- **WhatsApp Business API** (Evolution API)
- **Receita Federal API**
- **Omie ERP**
- **OSRM API**
- **node-cron**
- **node-nfe-nfce** (for NF-e integration)
- **xml-js** (for XML parsing in Purchase Radar)