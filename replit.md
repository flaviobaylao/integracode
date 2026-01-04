# Overview

"Sistema Integra" is a comprehensive CRM and sales management system designed for Honest Sucos. Its primary purpose is to optimize business operations by integrating customer relationship management, product catalog administration, sales tracking, and WhatsApp communication. The system aims to enhance efficiency, improve customer service, expand market reach, and increase sales through robust features like sales tracking, advanced route optimization, fine-grained access control, an integrated e-commerce platform ("Hotsite Instagram"), and real-time billing data synchronization with Omie ERP for customer "positivation" status.

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
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista).
- **WhatsApp Integration**: Evolution API for message sending, real-time conversation tracking, and webhook support for environment-specific configurations (development/production). **Automatic webhook URL validation** on startup detects and corrects stale deployment URLs (`.spock.`, `.prod.repl.run`, `.repl.co`) to the stable production domain (`integrahonest.replit.app`), preventing intermittent message reception issues.
- **WhatsApp Chat Center**: A complete conversational system at `/telemarketing/atendimento` with real-time conversation management, intelligent round-robin agent distribution, quick templates, status tracking, and optional ChatGPT standby activation/deactivation. Includes features for conversation transfer and unattended conversation auto-redistribution.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer display prioritization, and **strict abbreviated weekday format (Seg, Ter, Qua, Qui, Sex, Sab, Dom) throughout system** with robust error handling.
- **Sales & Financial Management**: Sales card tracking, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard. Order release workflow allows admin approval for blocked orders.
  - **Daily Sales Metrics Dashboard**: Comprehensive dashboard in "Metas de Vendas" tab with two tables:
    - QUADRO 1: Daily breakdown showing all vendors across all days of the month with scheduled visits (presencial/virtual), completed visits, orders, performance %, and distance traveled
    - QUADRO 2: Monthly performance comparison showing active customers, positivados, positivation rate, current vs previous month sales, variation %, and customers with higher sales
    - Uses optimized aggregated SQL queries (GROUP BY) with indexed Maps for O(1) lookup - only 8 queries total regardless of month length or vendor count
- **Delivery & Route Optimization**: Scheduled daily route generation using Nearest Neighbor + 2-opt and OSRM API. Intelligent regional sectorization using K-means clustering with Haversine distance. Features include visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, driver transfer, and a mobile-friendly driver interface (`/rota-entrega`) with GPS check-in/check-out and photo capture. Admins can manually manage and optimize routes, including creating empty routes for later population. Routes are linked directly to `driver email + date`.
  - **Daily Route Metrics**: Orders count and performance index calculated per route using CTE-based aggregation with robust timestamp fallback chain (orderHistory.orderDate → completedDate → deliveryCompletedDate → checkpointTime → route_date). Includes auto_check_out checkpoint handling and Brazil timezone conversion.
  - **Omie Invoice Stage Sync**: Automatic synchronization of invoice stages with Omie ERP:
    - When route is sent to driver: NF stage changes to "Em Rota" (code 20)
    - When driver completes delivery (checkout): NF stage changes to "Entregue" (code 70)
    - When driver marks as returned (devolvida): NF stage changes to "Aguardando Rota" (code 80)
    - Stage changes do not affect route composition (no deliveries added/removed after route is saved)
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering, inactivation, detailed delivery configurations, and a three-layer date system for visit days.
- **Mapa de Clientes**: Interactive Leaflet map (`/mapa-clientes`) displaying active customers with color-coded pins, filtering, and in-map editing for administrative users.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Order blocking system, Hotsite order submission to Omie with automatic customer creation and robust validation. Includes automatic cleanup for billings no longer present in Omie.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **System Administration**: Admin-only page (`/admin/system`) with data maintenance tools, including delivery days recalculation.
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection, 5-tier dynamic pricing, server-side security, automatic order registration as `sales_cards`, product gallery, stock management, and differentiated payment methods.
- **Leads Management**: Integrated lead tracking with route optimization, full customer registration form with "isLead" flag. Supports automatic creation, seller assignment, check-in/check-out with photo requirement, and conversion to full customer workflow.
- **Lead Check-in/Check-out**: Sellers can perform check-in/check-out on leads via dedicated API endpoints, with photo requirement, location validation, distance calculation, and improved error handling.
- **Automatic Check-out**: Visits with check-in but no order or no-sale registered are automatically checked out after 20 minutes. The system runs every 5 minutes (6h-23h) and only auto-checkouts visits where sales_card status is NOT 'completed' (order registered) or 'no_sale' (non-sale registered).
- **Phone Number Mapping**: Maps alternative phone numbers to canonical numbers to consolidate conversations, stored in `phone_number_mappings` table, managed via an admin-only API.
- **Automatic Data Backup**: Complete backup system for all order data with daily scheduled backups and manual trigger options, storing historical snapshots in an `orders_backup` table.
- **Sales Card Duplication**: Endpoint for duplicating sales cards with all related entities loaded.
- **ChatGPT Auto-Attendance**: Configurable AI-powered customer service system at `/telemarketing/ai-settings`. Features four operating modes (disabled, manual, schedule, timeout), configurable business hours, handoff keywords, customizable prompts, model selection (GPT-4o-mini, GPT-4o, GPT-4 Turbo), test interface, and audit logging. Includes daily AI reports for customer data, overdue debts, and billing summaries. Supports automated order capture via ChatGPT, allowing customers to place orders through a form-based approach via WhatsApp or by redirecting to a simplified virtual store (`/pedido-rapido`). The simplified store allows public access, pre-fills phone numbers from WhatsApp, applies 5-tier pricing, validates minimum orders, and creates orders via a public API.

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