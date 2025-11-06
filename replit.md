# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system supports various user roles with fine-grained access control, offering robust sales tracking, reporting, and route optimization. This aims to enhance business efficiency, improve customer service, and expand market reach. The project also includes an e-commerce platform ("Hotsite Instagram") to capture direct sales.

# Recent Changes

## 2025-11-06: Blocked Orders Release Fix
- **Fixed Release Functionality**: Corrected critical bug in `/api/blocked-orders/release` endpoint preventing order release in production:
  - Added status validation to process ONLY orders with status 'blocked'
  - Implemented rigorous product validation - products must exist in catalog AND have valid Omie code
  - Eliminated UUID-as-Omie-code failure path that was causing silent failures
  - Enhanced error messages to clearly identify missing products or products without Omie codes
  - Example error: "Cliente X: Produtos não encontrados ou sem código Omie: Suco de Laranja, Suco de Uva (sem código Omie)"
  - Orders now fail fast with actionable feedback instead of sending invalid data to Omie

- **Fixed Troca/Amostra Blocking**: Corrected bug in `/api/sales-cards/:id/finalize-sale` preventing proper blocking of exchange and sample orders:
  - Endpoint was marking sales_card status as 'blocked' but NOT creating record in `blocked_orders` table
  - Added creation of `blocked_orders` record when blocking troca/amostra orders
  - Now troca/amostra orders appear in blocked orders screen and can be released by administrators
  - Fixes: (1) Trocas not appearing as blocked, (2) Amostras not being releasable

## 2025-11-06: Route Management Enhancement
- **Delete Visit from Daily Route**: Replaced "Edit" button with "Delete" button in daily routes view (`/daily-route`). Users can now remove specific visits from the optimized daily route with confirmation dialog. Implementation includes:
  - Backend DELETE endpoint `/api/daily-routes/:routeId/visits/:visitId` with role-based permissions (ADMIN ONLY - vendedores não podem excluir)
  - Frontend confirmation dialog (AlertDialog) before deletion
  - Automatic list and map updates after removal via cache invalidation
  - Defensive handling for legacy routes without optimizedOrder
  - Audit logging for deletion operations

## 2025-11-06: Hotsite Bug Fixes
- **Fixed CPF Recognition**: Corrected `/api/public/customers/check` endpoint that was searching for non-existent `cpfCnpj` field. Now correctly searches `cpf` field for existing customers, enabling proper customer recognition and data auto-fill.
- **Fixed Order Creation**: Corrected `/api/public/orders` endpoint to use separate `cpf` and `cnpj` fields instead of non-existent `cpfCnpj` field when creating new customers and checking for existing customers. Pedidos from hotsite now successfully migrate to Sistema Integra.
- **Fixed Pricing Table Persistence**: Resolved three issues preventing hotsite price updates: (1) corrected apiRequest parameter order to `(method, url, data)`, (2) fixed authentication using `req.currentUser` instead of `req.userId`, (3) extended Zod schema to accept numeric price inputs with automatic string coercion.
- **Fixed Seller Preservation**: Hotsite orders now preserve existing customer seller assignments. Existing customers maintain their assigned seller, route day, and visit periodicity. New customers receive default settings (Dom, mensal, fallback vendor).

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
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing). Includes user management and default admin auto-initialization.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports (customers, sales cards) with Excel/CSV. Customer displays prioritize `fantasy_name`.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view with export. Automatic order blocking with release functionality. Administrative roles can create sales cards for any seller.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning (VRP) with vehicle assignment, optimization, and persistence, integrating with Omie billings. Check-in/check-out system supports both `visitAgenda` and `sales_cards` flows, logging checkpoints for audit. Checkpoint distance tracking and a dedicated check-in audit system are in place.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Automated Agenda Management**: Scheduled daily and on-demand synchronization of sales cards, calculating visit dates, managing cards, and providing statistics. System supports multiple weekdays per customer and robust visit allocation.
- **Sales Card Configuration Replication**: Role-based propagation system for sales card configuration changes:
    - **Administrative Users** (admin, coordinator, administrative): Changes propagate to ALL non-finalized sales cards of the customer (past and future, excluding completed/no_sale/failed cards)
    - **Vendors**: Changes propagate only to future sales cards
    - **Propagated Fields**: routeDay, recurrenceType, paymentMethod, deliveryWeekdays, deliveryTimeSlots, deliverySaturdayTimeSlots, boletoDays, exclusiveVehicle, vehicleTypes, customerLatitude, customerLongitude
    - **Implementation**: `updateAllCustomerCardsConfig()` for admins, `updateFutureCardsConfig()` for vendors
- **Sales Schedule Filtering**: Client-side search filter by customer fantasy name or company name. Weekday filter uses standardized abbreviated format (Seg, Ter, Qua, Qui, Sex, Sab, Dom).
- **Customer Weekdays Management in Sale Flow**: During sale completion, customer weekdays are displayed with checkboxes. For vendors: read-only (locked). For administrative users: editable, with changes automatically updating customer weekdays for all future sales cards.
- **Data Validation & Integrity**: 3-layer protection system ensures sales cards are always scheduled on correct weekdays: (1) Pre-creation validation in `createSalesCard`, (2) Admin endpoint `/api/admin/validate-cards` for diagnosis and auto-correction, (3) Diagnostic script `diagnose-cards.ts` for manual verification. Full documentation in `VALIDACAO_ROTAS.md`. Additionally, automated seller validation ensures sales cards are always assigned to the correct seller: (1) Route generation validates and auto-corrects seller assignments, (2) Card creation enforces seller_id from customer record, (3) Admin endpoint `/api/admin/fix-card-sellers` provides batch correction capabilities.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Features product mapping, vendor resolution, and automatic customer registration from Integra to Omie.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time for major sync operations.
- **Sales Goals Dashboard**: Displays individual seller metrics using aggregated SQL queries, including refined CFOP filtering logic for revenue calculation. Revenue calculations use current date as upper limit for month-to-date metrics to ensure accurate real-time values.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management) with restricted access.
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Available at `/shop` path in production mode.
    - **Public API Routes**: Separate public endpoints for products, orders, customer checks, and reviews.
    - **Structure**: Standalone React SPA with mobile-first design, building to `server/public-hotsite`.
    - **Customer Type Selection**: Interactive flow determines pricing table (Consumer: Retail/Wholesale; Reseller: Location-based with CNPJ verification).
    - **Consumer CPF Validation**: Pre-checkout CPF validation flow mirrors CNPJ process - consumers must validate CPF and confirm data before accessing catalog. CPF field disabled in checkout to prevent post-validation tampering.
    - **Reseller CNPJ Verification**: Automatic data retrieval from Receita Federal API, customer recognition, and address editing.
    - **Customer Recognition**: Triple-layer lookup (email OR phone OR CPF/CNPJ) prevents duplicate registrations and auto-fills existing customer data.
    - **Automatic Omie Registration**: New hotsite customers automatically registered in Omie ERP with PF/PJ differentiation and graceful error handling.
    - **Dynamic Pricing**: Five price tables (`retail_price`, `wholesale_price`, `resale_goiania_price`, `resale_interior_price`, `resale_brasilia_price`) based on customer type.
    - **Security**: Server-side price validation, stock verification, total recalculation, and validated CPF/CNPJ enforcement.
    - **Integration**: Orders automatically registered in Sistema Integra as sales_cards with `source: 'hotsite'`.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (PJ only - PF restricted to Pix/Card).
    - **Product Gallery System**: Multiple images per product with touch-swipe navigation and zoom.
    - **Product Image Management**: Admin interface for uploading multiple images (base64 data URLs).
    - **Review System**: Customer product reviews with ratings, comments, and admin approval workflow.
    - **Stock Management**: Accepts orders regardless of inventory levels.
    - **Hotsite Orders Management**: Dedicated page for managing hotsite orders with filtering capabilities.

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
- **Leaflet**

## Third-Party Services
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **App Entregas Honest**
- **OSRM API**