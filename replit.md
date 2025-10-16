# Overview

"Sistema Integra" is a Customer Relationship Management (CRM) system designed for Honest Sucos, a Brazilian juice company. Its core purpose is to optimize sales management through features like customer relationship management, product catalog administration, sales card tracking, and integrated WhatsApp communication. The system supports various user roles with role-based access control and offers extensive sales tracking and reporting to improve business operations and expand market reach.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## Frontend
- **Framework**: React with TypeScript (Vite).
- **UI**: Radix UI components with shadcn/ui and Tailwind CSS.
- **Routing**: Wouter.
- **State Management**: TanStack Query.
- **Form Handling**: React Hook Form with Zod.

## Backend
- **Runtime**: Node.js with Express.js (TypeScript).
- **Authentication**: Email/Password and Replit Auth (Passport.js for OIDC).
- **Session Management**: Express sessions with PostgreSQL store.
- **Database**: PostgreSQL with Drizzle ORM.
- **API**: RESTful with role-based access control.

## Database Schema
- **Entities**: Users (role-based), Customers, Products, Sales Cards, Message Templates, Message History, Delivery Management, Sessions.

## Authentication & Authorization
- **Providers**: Replit OpenID Connect and internal email/password.
- **Authorization**: Role-based (admin, coordinator, administrative, vendedor, telemarketing).
- **User Management**: Admin-only interface for creating, managing, and deleting users with role and route assignments.
- **Auto-Initialization**: System automatically creates default admin user (flavio@bebahonest.com.br / M@riafe1) on first startup if no admin exists. Manual setup endpoint also available at POST /api/setup-admin.

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.

## Technical Implementations
- **Check-in with Photo**: Mobile check-in with photo capture, geolocation, and distance calculation (Haversine).
- **Date Handling**: ISO UTC format for consistency.
- **Customer Validation**: Prevents duplicate CPF/CNPJ.
- **Sales Cards**: Search by customer/CNPJ, conditional payment terms for "Boleto", bulk import from Excel/CSV with Receita Federal API integration.
- **Customer Excel Import**: Bulk update customer data via Excel import using CPF/CNPJ as key. Supports: GPS coordinates (latitude/longitude with comma decimal separator), visit schedule (ROTA/weekdays), visit frequency (FREQUENCIA/periodicidade: semanal, quinzenal, mensal, bimestral), and service start date (DATA DE INICIO in DD/MM/YYYY format). Automatically converts weekdays to JSON array format and handles multiple date formats including Excel serial dates.
- **Omie ERP Integration**: Synchronizes clients, vendors, products, overdue debts, and invoices. Includes product mapping, vendor resolution, and automated hourly synchronization (Clients, Billings, Overdue Debts). OmieSyncManager provides a tab-based interface for managing synchronization. **Sync Filters**: Only ACTIVE records are synchronized - vendors and products with `inativo === 'S'` are automatically skipped during sync. Products are also filtered for blocked status and valid pricing. **Invoice Date Filter**: `syncBillings()` method filters invoices by emission date (dEmi ≥ 01/09/2025) to synchronize only invoices from September 2025 onwards. Uses descending order (newest first) with code-level filtering since Omie API ignores date filter parameters. Scheduler uses `syncBillings()` instead of `syncAllOrders()` for efficient invoice-only synchronization. **Stage Extraction**: Extracts order stage (Aguardando Rota, Entregue, Faturado) from related pedido using nIdPedido from invoice.compl. **Stage Fallback**: When order stages list is empty, system uses header stage as fallback to ensure correct stage mapping. **Billing Synchronization Endpoint** (October 2025): New `/api/omie/sync-billings` endpoint provides filtered billing synchronization with: (1) last 45 days filter, (2) automatic exclusion of cancelled invoices, (3) vendor code to name conversion with caching via `fetchVendorData()`. Frontend integration via "Sincronizar Omie" button on Billings page with success/error toast feedback. **Seller Assignment Fix** (October 2025): Fixed critical bug affecting 1,183 clients and all sales cards. System now correctly extracts vendor from Omie's `recomendacoes.codigo_vendedor`, includes it in `getAllClients()` response, and maps to `omie-vendor-{codigo}` format. Sync logic prioritizes: Omie seller > Existing seller > Default admin (never overwrites existing sellers). Sales cards inherit seller from customer, not parent card. Batch correction script `fix-sales-card-sellers-batch.ts` updates 3,231+ cards in single SQL operation. Result: 4,311 sales cards correctly distributed across 24 vendors.
- **Financial Tracking**: Overdue debt monitoring, credit analysis, and comprehensive "Contas a Receber" view with frontend filtering and Excel export.
- **Blocked Orders Management**: Automatic blocking for orders with Boleto terms > 7 days or overdue debts. Admin/coordinator/administrative roles can release blocked orders.
- **Delivery Integration**: Real-time tracking with App Entregas Honest via webhooks.
- **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm for near-optimal routes. Uses OSRM API for real motorcycle route distances. Includes visual mapping (Leaflet), checkpoint registration, and performance metrics dashboards for both sellers and admins. Supports exclusive vehicle delivery configuration on sales cards. **Manual Route Generation** (October 2025): Added "Gerar Rota" / "Atualizar Rota" button in DailyRouteView interface allowing admins and sellers to manually trigger route generation on demand via POST /api/daily-routes/generate endpoint. Implementation uses proper date format (YYYY-MM-DD) and granular cache invalidation for immediate UI updates. **Route Visibility Fix** (October 2025): Fixed admin route view initialization - DailyRouteView now automatically selects first seller when admin loads page, ensuring routes are visible immediately instead of showing empty state. Admins can switch between sellers using dropdown. **Route Data Source Fix** (October 2025): Fixed critical route generation bug where service was looking for visits in empty `visit_agenda` table instead of using `sales_cards` as the source of truth. Modified `routeOptimizationService.ts` to fetch directly from `sales_cards` and join with customer data for coordinates. System now successfully generates routes from existing sales cards.
- **Multi-Vehicle Route Planning (VRP)**: Advanced delivery route optimization system with 4-phase algorithm: (1) preprocessing with coordinate validation, (2) greedy vehicle assignment prioritizing urgent orders, (3) per-vehicle route optimization using NN+2-opt+OSRM, (4) persistence to delivery_routes/delivery_route_stops tables. Includes manual order selection, vehicle configuration (type, capacity, start point, time windows), and results display with ETAs and statistics. Validates coordinates and filters invalid orders with warnings.
- **Enhanced Delivery Management**: Delivery Management page with order selection, urgent delivery marking, vehicle configuration modal, manual order refresh button, and clear display of delivery time slots and exclusive vehicle configurations. Supports multi-vehicle route planning with real-time optimization.
- **Automatic Future Visit Agenda Generation** (October 2025): Automated system that generates 3+ months of future sales cards for customers based on their visit schedules (weekdays and periodicity). Uses `calculateNextVisitDate()` from `shared/visitSchedule.ts` to compute next visit dates. Implements recursive card generation via `generateNextSalesCard()` storage method that automatically creates the next card in the chain when a card is completed. **Scheduled Daily Maintenance**: Runs automatically every night at 00:00h (UTC-3) via `ensureFutureAgendaCoverage()` to ensure all clients always have 2 months of future programming. Execution history (last 30 runs with stats) is persisted in `system_settings` table for audit. System achieved 52% client coverage (350/673 clients) with complete 4+ month agendas. Two utility scripts: (1) `generate-future-agenda.ts` - batch generates cards for all clients up to 3 months ahead, (2) `unlock-all-clients.ts` - unblocks clients missing `next_card_id` linkage by creating first next card and updating parent reference. Total generation: 2,127 cards across Oct-Jan period.

# External Dependencies

## Database
- **Neon PostgreSQL**
- **Drizzle ORM**

## Authentication
- **Replit Authentication**
- **Passport.js**

## UI Components
- **Radix UI**
- **Lucide React**
- **Tailwind CSS**
- **Leaflet** (react-leaflet v4.2.1)

## Third-Party Services
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **App Entregas Honest**