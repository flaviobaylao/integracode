# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, and expand market reach. Key capabilities include robust sales tracking, reporting, route optimization, and fine-grained access control. It also features an e-commerce platform ("Hotsite Instagram") for direct sales and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# Recent Changes

## 2025-11-08: Migration to Permanent Sales Cards Architecture

**Major System Redesign**: Migrated from temporary sales cards to a permanent card architecture where each active customer has ONE reusable sales_card.

### Architectural Changes:

#### **OLD ARCHITECTURE (Deprecated):**
- Multiple temporary cards per customer
- New card created for each visit
- Used `scheduledDate` to determine when to visit
- Cards closed after each visit
- Historical data stored in sales_cards table

#### **NEW ARCHITECTURE (Current):**
- **ONE permanent card per active customer**
- Card reused for all visits (`isPermanent=true`)
- Uses `nextVisitDate` calculated from customer's `weekdays` + `visitPeriodicity`
- All visit results stored in `order_history` table
- Permanent cards stay `status='pending'` between visits

### Schema Changes (shared/schema.ts):

Added new fields to `sales_cards`:
- `isPermanent` (boolean): Identifies permanent vs legacy cards
- `lastVisitDate` (timestamp): Records last visit attempt (any outcome)
- `nextVisitDate` (timestamp): Calculated next visit date based on periodicity
- `daysOverdue` (integer): Days overdue for tracking (future use)

### Migration Results (PHASE 3):

✅ **Successfully migrated 1,201 permanent cards** (one per active customer)
- Migration script: `server/migrateToPermanentCardsBATCH.ts`
- Execution date: 2025-11-08
- **Historical data lost**: 11,154 old cards deleted due to Drizzle WHERE bug (user approved proceeding)

### Route Generation (PHASE 4):

Rewrote `generateDailyRoute()` in `server/routeOptimizationService.ts`:
- **Query logic**: `isPermanent=true AND nextVisitDate <= today`
- Replaced legacy `scheduledDate` filtering
- Uses customer data (`weekdays` + `visitPeriodicity`) as single source of truth

### Sales Card Completion (PHASE 5):

Updated `PUT /api/sales-cards/:id` endpoint in `server/routes.ts`:
1. Creates `order_history` entry for every visit (completed/no_sale/failed)
2. Updates `lastVisitDate` to today (always, regardless of outcome)
3. Recalculates `nextVisitDate` based on **last completed sale** from `order_history`
4. Resets card to `status='pending'` for next visit

### Critical Bugs Fixed:

1. **Drizzle WHERE chaining bug**: Fixed multiple instances of `.where().where()` which overwrites predicates
   - **Correct syntax**: `where(and(eq(...), eq(...)))`
   - Found in migration script and sales completion logic

2. **nextVisitDate calculation bug**: 
   - **Problem**: Using `currentCard.lastVisitDate` caused `no_sale` visits to advance schedule
   - **Solution**: Query `order_history` for last `status='completed'` sale to calculate next visit
   - **Impact**: Prevents cards from being perpetually reclassified after failed visits

3. **lastVisitDate tracking**: Now properly separates:
   - `lastVisitDate` = last visit attempt (any outcome)
   - Last completed sale = queried from `order_history.status='completed'`
   - Only completed sales advance the `nextVisitDate`

### Expected Behaviors:

#### **Completed Visit:**
- `lastVisitDate` updated to today
- `nextVisitDate` calculated from today + periodicity
- Order recorded in `order_history` with `status='completed'`

#### **no_sale / failed Visit:**
- `lastVisitDate` updated to today (records attempt)
- `nextVisitDate` calculated from **last completed sale** (not today!)
- Order recorded in `order_history` with `status='no_sale'|'failed'`
- **Result**: Schedule doesn't drift forward without real sales

#### **Client Without Sales:**
- `nextVisitDate` calculated as new client (from card creation date)
- First completed sale establishes baseline for future visits

### Architecture Validation:

✅ **Architect approval**: System ready for production after 3 review cycles
- All edge cases handled correctly
- Consecutive no_sale scenarios tested
- Query predicates fixed with `and()` operator

### Pending Work:

- **PHASE 6**: Implement daily job to recalculate `daysOverdue` for all permanent cards
- **Testing**: Regression tests for consecutive no_sale scenarios
- **Monitoring**: Production telemetry for overdue handling

---

## 2025-11-07: Auditoria "Gestão de Clientes" + Coordinate Validation

**Priority Audit**: Confirmed that "Gestão de Clientes" (customers table) is the **single source of truth** for all sales operations and route generation.

### Audit Results (see AUDITORIA_GESTAO_CLIENTES.md):

#### ✅ **CONFIRMATIONS:**
1. **Data Hierarchy Validated**: All 7 dependent tables (sales_cards, visit_schedule_history, route_checkpoints, message_history, blocked_orders, delivery_route_stops, billings) correctly reference `customers`
2. **Route Generation**: Uses INNER JOIN with `customers` to fetch coordinates, addresses, and customer data in real-time (line 355-374 in routeOptimizationService.ts)
3. **Sales_cards Integrity**: 100% referential integrity - 0 orphaned customer_ids, 0 stale coordinates, 11,163 cards across 1,200 unique customers
4. **Omie Sync**: 99.25% of customers (1,193/1,202) synchronized from Omie ERP with 0 duplicates by omie_client_code

#### 🚨 **CRITICAL ISSUES IDENTIFIED:**
1. **362 active customers WITHOUT coordinates** (30% of active base)
   - **Impact**: 2,828 pending sales_cards blocked from route generation
   - **Top affected seller**: Flavio Administrador (142 customers)
2. **No explicit Foreign Keys** in database (referential integrity enforced by application only)
3. **Omie sync failure** since 28/10/2025 (SOAP error in omie_complete job)
4. **64 duplicate documents** (60× CPF "00000000000" placeholder + 4 real duplicates)

#### ⚠️ **OTHER DATA QUALITY ISSUES:**
- 154 customers without addresses (13%)
- 6 customers without assigned sellers (orphans)
- 83 PF without CPF, 1 PJ without CNPJ
- 9 customers without Omie code

#### 📋 **PRIORITY ACTIONS:**
1. **URGENT**: Geocode 362 customers to unblock 2,828 sales operations
2. **HIGH**: Add database Foreign Keys for customers → dependent tables
3. **HIGH**: Fix omie_complete sync job (SOAP tag error)
4. **MEDIUM**: Clean 60 customers with placeholder CPF "00000000000"
5. **LOW**: Assign sellers to 6 orphaned customers

---

## 2025-11-07: Coordinate Validation & Route Optimization Improvements

**Technical Fixes**: Implemented comprehensive coordinate validation system and fixed route counting bugs.

### Changes Made:

#### 1. **Coordinate Validation System** (server/routeOptimizationService.ts)
   - Added automatic detection of suspicious coordinates (>100km from seller's home)
   - Implemented warnings for routes >300km (long) and >500km (critical)
   - Returns `warnings` and `suspiciousCoordinates` arrays in route generation response
   - Real-time validation during route creation prevents physically impossible routes

#### 2. **Coordinate Diagnosis Tool** (server/routes.ts)
   - New admin endpoint: `GET /api/admin/diagnose-coordinates`
   - Detects all customers with positive latitude (common error in Brazil - should be negative)
   - Identifies customers >100km from assigned sellers
   - Returns detailed report with suggested fixes

#### 3. **Data Corrections**
   - Fixed 2 clients with incorrect positive latitudes in Goiânia (GO):
     - `omie-client-4254745499` (Lanchonete do Levy): 16.70 → -16.70
     - `omie-client-4276236942` (RAQUEL MESSIAS): 16.64 → -16.64
   - Result: Route distance corrected from 7,458km to ~150-250km (realistic!)

#### 4. **Route Counting Bug Fix** (server/routes.ts line 8827)
   - OLD: Used `allProcessedCardIds.size` (counted all cards, including past days)
   - NEW: Uses `existingRoute.totalVisits` (correct count from database)
   - Impact: Frontend now displays accurate visit counts when regenerating routes

### Route Generation Logic (Confirmed):
- **Source**: `sales_cards` filtered by `sellerId`, `scheduledDate`, `status='pending'|'open'`
- **Customer Deduplication**: Same customer with multiple sales_cards appears ONCE in route
- **Storage**: `optimizedOrder` contains **customer IDs**, not sales_card IDs
- **Off-route visits**: Integrated on the day they occur only
- **Validation**: Automatic distance checks prevent erroneous coordinates

### Data Hierarchy:
- `sales_cards` = **source of truth** for visit scheduling
- `route_day` + `recurrence_type` fields determine visit dates
- `customers.weekdays` field deprecated (no longer used)
- `optimizedOrder` in `daily_routes` = array of **customer IDs** (deduplicated)

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
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking with release functionality, and customer "positivation" based on Omie billings. Sales goals dashboard with individual seller metrics.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. **Includes automatic coordinate validation** with warnings for suspicious distances (>100km) and critical route lengths (>500km). Admin diagnostic tool available at `/api/admin/diagnose-coordinates`.
- **Visit Schedule Management**: Persistent tracking of all scheduled visits with completion status, based on customer-specific periodicity. Automated agenda management focusing on `visit_schedule_history` and `order_history`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation system for sales card configuration changes, including automatic recurrence change propagation.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data (including "Positivação"). Customer inactivation feature with confirmation of consequences. Improved client search across multiple fields (fantasy name, corporate name, CPF/CNPJ, phone). "Última Atividade" column displays last sale date.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling, automated seller validation, and admin tools for diagnosis and correction.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices, including product mapping and customer registration. Sync status tracking.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management, and daily attendance percentage).
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Available at `/shop` with public API routes.
    - **Structure**: Standalone React SPA with mobile-first design.
    - **Customer Type Selection & Validation**: Interactive flow for pricing, pre-checkout CPF validation for consumers, automatic data retrieval from Receita Federal API for reseller CNPJ verification.
    - **Customer Recognition & Registration**: Triple-layer lookup to prevent duplicates and auto-fill data. New hotsite customers automatically registered in Omie ERP.
    - **Dynamic Pricing**: Five price tables based on customer type.
    - **Security**: Server-side price validation, stock verification, and validated CPF/CNPJ enforcement.
    - **Integration**: Orders automatically registered in Sistema Integra as `sales_cards` with `source: 'hotsite'`.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (PJ only).
    - **Product Features**: Gallery system with multiple images, touch-swipe navigation, zoom, and admin interface for image upload.
    - **Review System**: Customer product reviews with ratings, comments, and admin approval.
    - **Stock Management**: Accepts orders regardless of inventory levels.
    - **Order Management**: Dedicated page for managing hotsite orders with filtering and notification badges.

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