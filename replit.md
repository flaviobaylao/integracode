# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, and expand market reach. Key capabilities include robust sales tracking, reporting, route optimization, and fine-grained access control. It also features an e-commerce platform ("Hotsite Instagram") for direct sales and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# Recent Changes

## 2025-11-07: Coordinate Validation & Route Optimization Improvements

**Critical Fixes**: Implemented comprehensive coordinate validation system and fixed route counting bugs.

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