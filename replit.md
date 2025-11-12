# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, and expand market reach. Key capabilities include robust sales tracking, reporting, route optimization, and fine-grained access control. It also features an e-commerce platform ("Hotsite Instagram") for direct sales and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

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
- **Data Handling**: ISO UTC for dates with **timezone conversion to America/Sao_Paulo** for visit schedule calculations (nextVisitDate, weekdays), CPF/CNPJ validation, bulk data imports, customer displays prioritizing `fantasy_name`, and normalization of weekday formats.
  - **Route Storage & Lookup (Nov 12, 2025)**: Daily routes use **UTC-based storage** for consistency. Endpoint POST /api/daily-routes/generate parses date strings as UTC midnight (`new Date("2025-11-12T00:00:00.000Z")`), and `getDailyRouteBySellerAndDate()` searches within UTC day ranges. Previous double timezone conversion (endpoint→BRT + storage→BRT) caused range mismatches where existing routes were not found, triggering duplicate key errors. Current implementation: single UTC normalization at endpoint level, simple UTC range query at storage level. This ensures regeneration updates existing routes instead of attempting duplicate inserts.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking with release functionality, and customer "positivation" based on Omie billings. Sales goals dashboard with individual seller metrics.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Includes automatic coordinate validation with warnings for suspicious distances (>100km) and critical route lengths (>500km). Admin diagnostic tool available at `/api/admin/diagnose-coordinates`.
- **Rota do Dia (Nov 12, 2025)**: New simplified daily route visualization page accessible via `/rota-do-dia`. Features include:
  - Clean, user-friendly interface for viewing daily routes
  - Date and seller selection filters (admin/coordinator access)
  - **Auto-refresh**: Page automatically updates every 30 seconds to show latest check-ins/check-outs
  - **Manual refresh button**: Click to immediately update route data with loading indicator
  - **Route Metrics Dashboard**: Displays total visits, completed, pending, average visit time, plus planned distance and executed distance calculations
    - **Average Visit Time**: Calculated from check-in to check-out timestamps; visits with only check-in (no check-out) are counted as 30 minutes
  - **Interactive Map**: Leaflet-based route visualization showing:
    - Seller's home location (start/end point) with green house icon
    - Sequential numbered markers for each customer visit
    - Optimized route path connecting all points (home → visits → home)
    - Actual executed route overlay (red line) based on checkpoints
    - Photo markers (purple camera icons) for visits with check-in photos
  - **Smart Visit List with Inline Check-in/Check-out**:
    - Check-in/check-out times displayed inline on each visit row (Brazil/São Paulo timezone)
    - **Critical Bug Fix (Nov 12, 2025)**: Corrected checkpoint-to-visit association logic to use `customerId` instead of `visitId`. Previously, checkpoints were not displaying on visits because the frontend was looking for `cp.visitId === visit.id`, but visits use `id = customerId` while checkpoints have a separate UUID `visitId`. Now uses `cp.customerId === visit.customerId` for correct matching.
    - **Color-coded status system:**
      - 🟢 **Green**: Visit completed (check-in + check-out)
      - 🔵 **Blue**: Visit in progress (check-in only)
      - 🔴 **Red**: Location validation issue (check-in/check-out >100m from registered address)
      - ⚪ **Gray**: Pending (no check-in)
    - **Location Validation**: Haversine distance calculation compares check-in/check-out GPS coordinates with customer's registered address
      - Alerts displayed when distance exceeds 100 meters with exact distance shown
      - Red warning: "Check-in fora do local" or "Check-out fora do local"
    - **Photo Indicator**: Purple camera icon when visit has check-in photo
    - Customer name and address with sequential numbering
    - Click-to-open sales card functionality for immediate order registration
  - **Off-Route Check-ins Section**: Separate section at bottom showing check-ins performed on customers not in the planned route (orange highlight)
    - **Critical Bug Fix (Nov 12, 2025)**: Corrected `isOffRoute` detection logic in `registerCheckpoint()` to compare `customerId` instead of `visitId` against `optimizedOrder`. Previously, ALL visits were incorrectly marked as off-route because `optimizedOrder` contains customer IDs, not visit IDs. Now only check-ins for customers NOT in the planned route appear in this section.
  - **Sales Card Integration**: Click any visit to open SalesCardDetailsModal for that customer/date
    - Auto-creates sales card if none exists for that date
    - API endpoint: `GET /api/customers/:customerId/sales-card/:date` returns or creates sales card
    - New cards created with `source: 'rota_do_dia'`
    - Seamless order registration workflow from route visualization
  - **Distance Calculations**:
    - Planned route distance: Sum of distances from home → all visits (optimized order) → home
    - Executed route distance: Sum of distances between sequential check-in coordinates
    - Uses Haversine formula for accurate geodesic calculations
  - Full TypeScript type safety using Zod schemas from `@shared/schema`
  - **Timezone Handling**: ALL dates use UTC for storage but display in Brazil/São Paulo timezone (BRT/GMT-3)
    - Fixed critical date bug where selecting date in calendar was off by one day (Nov 12, 2025)
    - Changed `setHours` to `setUTCHours` in `getDailyRouteBySellerAndDate()` for proper UTC range queries
    - Fixed date header display using midday UTC anchor (T12:00:00.000Z) to prevent timezone conversion from shifting displayed date
    - Frontend now uses `selectedDate` directly with stable UTC offset instead of backend's `routeDate` to ensure calendar selection matches displayed date
  - Integrated menu navigation replacing legacy DailyRouteView
  - API endpoint: `GET /api/daily-routes/:sellerId/date/:date` returns `DailyRouteResponse` with `sellerHome` coordinates and checkpoint data
- **Visit Schedule Management (Nov 12, 2025 - Direct Customer-Based Architecture)**: Route generation now queries **customers table directly** as the single source of truth. Visit scheduling is calculated on-demand using `calculateNextVisitDate()` from customer's `weekdays`, `visitPeriodicity`, and last visit from `sales_cards`. Sales cards (`sales_cards` table) are used for both recording sales transactions AND tracking visit history for next-visit calculations.
  - **Architecture Change (Nov 12, 2025)**: Removed permanent sales cards architecture. Routes are now generated by `getCustomersForDate()` which:
    1. Fetches active customers assigned to the seller with valid coordinates
    2. **Critical Bug Fix #1 (Nov 12, 2025)**: Retrieves last completed visit date from `sales_cards` table (status='completed' or 'invoiced') for each customer. Previously incorrectly queried `order_history` table which lacks `customerId` and visit tracking fields, causing 500 errors during route generation. Now uses `MAX(COALESCE(completedDate, scheduledDate))` to prioritize actual visit dates for accurate next-visit calculations.
    3. **Critical Bug Fix #2 (Nov 12, 2025)**: Added JSON parsing for `customer.weekdays` field. Field is stored as VARCHAR (JSON string) but code expected array, causing "weekdays.map is not a function" errors and 0 routes generated. Now safely parses `JSON.parse(customer.weekdays)` before passing to `calculateNextVisitDate()`, with defensive checks for invalid data. This fixed route generation for future dates (13/11+).
    4. Calculates `nextVisitDate` using `calculateNextVisitDate()` with **Brazil timezone (America/Sao_Paulo)**
    5. Includes visits where `nextVisitDate <= targetDate` (same-day + overdue visits)
    6. Uses `fromZonedTime()` from date-fns-tz for proper BRT normalization without timezone shift bugs
  - **Route Planning**: `planDailyRoute()` helper function separates route planning logic from database persistence, enabling both generation and regeneration to use the same customer-based query logic. `optimizedOrder` contains customer IDs for route sequencing.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation system for sales card configuration changes, including automatic recurrence change propagation.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data (including "Positivação"). Customer inactivation feature with confirmation of consequences. Improved client search across multiple fields (fantasy name, corporate name, CPF/CNPJ, phone). "Última Atividade" column displays last sale date. "Gestão de Clientes" (customers table) is the single source of truth for all sales operations and route generation. All customer displays prioritize `fantasyName` over `name` (corporate name) throughout the system.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling, automated seller validation, and admin tools for diagnosis and correction. Critical audit identified 362 active customers without coordinates, which impacts route generation.
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