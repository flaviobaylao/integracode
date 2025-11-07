# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos, designed to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. It features robust sales tracking, reporting, and route optimization, with fine-grained access control for various user roles. The system aims to enhance business efficiency, improve customer service, and expand market reach, including an e-commerce platform ("Hotsite Instagram") for direct sales.

# Recent Changes

## 2025-11-07: Sales Cards Refactor - Permanent Cards + Order History [COMPLETED]
- **Major Architectural Change**: Transformed sales_cards from multiple recurring cards to single permanent card per customer
- **Motivation**: Sales cards now only serve as order registration tool, not visit scheduling (visit_schedule_history handles scheduling)
- **New Table**: `order_history` stores:
  - Individual orders within each sales card
  - orderDate, products, totalValue, status
  - Check-in/check-out data per order (checkInTime, checkInLatitude, checkInLongitude, checkOutTime, checkOutLatitude, checkOutLongitude)
  - Delivery tracking per order (deliveryScheduledDate, deliveryCompletedDate, deliveryStatus)
  - Omie integration data (invoiceNumber, omieOrderId)
- **FK Constraint**: order_history.salesCardId → salesCards.id (cascade delete)
- **Implementation Status**: ✅ COMPLETE
  - ✅ Schema and database table created (applied with npm run db:push)
  - ✅ Storage methods: getOrCreatePermanentCard(), getPermanentCardByCustomer(), createOrderHistory(), getOrderHistoryByCard(), getOrderHistoryById(), updateOrderHistory(), deleteOrderHistory()
  - ✅ API endpoints: GET /api/customers/:customerId/permanent-card, POST /api/order-history, GET /api/sales-cards/:salesCardId/orders, GET/PUT/DELETE /api/order-history/:id
  - ✅ Migration script: server/migrateToPermanentCards.ts with dry-run and execute modes
  - ✅ Admin endpoint: POST /api/admin/migrate-to-permanent-cards (admin-only, supports dryRun parameter)
  - ✅ UI updates: SalesCardDetailsModal displays order history with status-aware styling
  - ✅ Automated card generation DISABLED: 3 cron jobs commented in scheduler.ts
- **Migration Script Features**:
  - Consolidates multiple cards per customer into single permanent card
  - Converts completed/cancelled cards into order_history records
  - Preserves all historical data (products, check-in/out, delivery, invoices)
  - Removes duplicate/future pending cards
  - Supports dry-run mode for safe testing
  - CLI usage: `tsx server/migrateToPermanentCards.ts --dry-run` or `--execute`
  - API usage: POST to `/api/admin/migrate-to-permanent-cards` with `{dryRun: true/false}`
  - Architect validated: Safe to execute, processes 1,202 customers
- **Disabled Cron Jobs** (scheduler.ts):
  - ✗ generateVisitAgenda() at 06:00h - no longer creates sales_cards
  - ✗ Overdue card processing at 02:00h - no longer uses closeCardAndScheduleNext()
  - ✗ syncFutureSalesCards() at 00:00h - no longer creates/deletes recurring cards
- **Active Jobs**: Route generation (05:00h), Omie sync (hourly 06:00-23:00)
- **Compatibility**: Keeping products/saleValue fields in sales_cards for backward compatibility during transition
- **Next Steps**: Execute migration (dry-run → validate → execute), monitor for errors, cleanup unused utilities when safe

## 2025-11-06: Route Generation Integration with Visit Schedule History
- **Critical Fix**: Corrected route generation logic to use proper week-based periodicity calculations
- **Changed**: `routeOptimizationService.ts` now imports and uses `shouldVisitOnDate()` from `visitScheduleHistoryService.ts`
- **Removed**: Old incorrect day-based periodicity logic that was causing wrong visit schedules
- **Impact**: Route generation now perfectly aligned with visit_schedule_history system
- **Consistency**: Both systems now use identical logic for determining visit eligibility

## 2025-11-06: Visit Schedule History System
- **New Feature**: Persistent tracking of all scheduled visits (past and future) with completion status
- **New Table**: `visit_schedule_history` stores:
  - Scheduled visits for each customer based on their periodicity
  - Check-in/check-out times and GPS coordinates when completed
  - Visit status: 'scheduled', 'completed', 'missed', 'cancelled'
  - Links to route_checkpoints for delivery tracking integration
- **Corrected Periodicity Logic**:
  - **Semanal**: Every configured weekday (e.g., every Thursday and Friday)
  - **Quinzenal**: Alternating weeks (Week YES, Week NO) anchored to customer's `serviceStartDate`
  - **Mensal**: Quad-weekly pattern (1 week YES, 3 weeks NO) anchored to `serviceStartDate`
  - **Bimestral**: Every 8 weeks anchored to `serviceStartDate`
  - **Important**: Schedule is independent of check-ins - calendar doesn't change if vendor misses a visit
- **Service**: `visitScheduleHistoryService.ts` provides:
  - `shouldVisitOnDate()`: Determines if customer should be visited on specific date
  - `generateFutureVisitsForCustomer()`: Creates 60 days of future visit records
  - `generateFutureVisitsForAllCustomers()`: Batch generation for all active customers
  - `markVisitAsCompleted()`: Updates visit status when check-in occurs
  - `markMissedVisits()`: Automatically marks past unvisited dates as 'missed'
- **Weekday Format Support**: Comprehensive mapping for all variations:
  - Abbreviated: "Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"
  - Full capitalized: "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"
  - Lowercase: "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"
  - With hyphens: "segunda-feira", "terça-feira", etc.
- **Reference Date Logic**: Each customer's periodicity is calculated from their own `serviceStartDate` (falls back to 2025-01-02 if missing), ensuring consistent cadence regardless of when they started service

## 2025-11-06: Route Generation Migration - Customers as Single Source of Truth
- **Major Architectural Change**: Migrated daily route generation from sales_cards/visit_agenda to customers table as single source of truth
- **Previous Flow**: Routes were generated from pre-created sales_cards (created by agenda sync) → required maintaining dual systems
- **New Flow**: Routes generated on-the-fly from customers table based on:
  - `seller_id` match
  - `weekdays` JSON array (supports both abbreviated "Seg"/"Ter" and full "segunda"/"terca" formats)
  - `visit_periodicity` enum (semanal/quinzenal/mensal/bimestral)
  - `is_active` = true
  - `virtual_service` = false
  - Valid latitude/longitude coordinates
- **Changes Made**:
  - Modified `generateDailyRoute()` in routeOptimizationService.ts to query customers directly
  - Added `storage.getAllCustomers()` method for customer data access
  - Updated GET endpoints `/api/daily-routes/:sellerId/today` and `/date/:date` to fetch visits from customers
  - Updated POST `/api/daily-routes/:routeId/optimize-preview` to use customers data
  - `optimizedOrder` in daily_routes now contains customer IDs (not sales_card IDs)
- **Benefits**:
  - Eliminates dependency on pre-created sales_cards for route generation
  - Simplifies data flow - customers table is authoritative for visit scheduling
  - Reduces data duplication and synchronization complexity
- **Test Results**: Successfully generated route for Gabriel R. on 06/11/2025 (quarta-feira) with 23 valid visits from 32 scheduled customers (9 excluded due to missing coordinates)
- **Legacy Support**: visit_agenda table still exists for backward compatibility with some endpoints (metrics, legacy reports) - will be fully deprecated in future release

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
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, and customer displays prioritizing `fantasy_name`.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, and automatic order blocking with release functionality.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Features include manual customer addition to routes, deletion of visits from daily routes, and temporary local route re-optimization.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Automated Agenda Management**: Scheduled daily and on-demand synchronization of sales cards, visit date calculation, card management, and statistics. Supports multiple weekdays per customer.
- **Sales Card Configuration Replication**: Role-based propagation system for sales card configuration changes (e.g., recurrenceType, paymentMethod) to future or all non-finalized cards. Includes automatic recurrence change propagation (creating/cancelling future cards within a 60-day window).
- **Sales Schedule Filtering**: Client-side search and weekday filtering.
- **Customer Weekdays Management in Sale Flow**: Editable for administrative users, read-only for vendors.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling on correct weekdays, automated seller validation, and admin tools for diagnosis and correction.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices, including product mapping and customer registration.
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