# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos, aiming to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. It supports various user roles with fine-grained access control, offering robust sales tracking, reporting, and route optimization to enhance business efficiency, improve customer service, and expand market reach.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, and React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, and TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing). Includes user management and default admin auto-initialization.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports (customers, sales cards) with Excel/CSV. Customer displays prioritize `fantasy_name` over `company_name`.
- **Import Diagnostics**: Debug system for Excel/CSV imports showing column detection, coordinate parsing, data type validation, and update tracking.
- **Sales & Financial Management**: Sales card tracking with source field ('integra', 'hotsite', etc) for order origin tracking, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view with export. Automatic order blocking based on payment terms/debts, with release functionality.
    - **Administrative Card Creation**: Users with administrative roles (admin, coordinator, administrative) can create sales cards on behalf of any seller. Regular sellers can only create cards for themselves.
- **Delivery & Route Optimization**:
    - **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API. Features visual mapping, checkpoint registration, performance dashboards, and manual generation. Handles route regeneration intelligently by preserving completed/in-progress visits and optimizing only new pending ones.
    - **Multi-Vehicle Route Planning (VRP)**: 4-phase algorithm for vehicle assignment, route optimization (NN+2-opt+OSRM), and persistence. Supports manual order selection, vehicle configuration, and results display with ETAs. Integrates with Omie billings.
    - **Distance Formatting**: Consistent display of distances (meters < 1km, kilometers >= 1km). Backend converts kilometers to meters for frontend display.
    - **Route Optimization Fallback**: Optimizes routes using `visitAgenda` or, if empty, falls back to `sales_cards` filtered for physical visits with valid coordinates.
    - **Manual Check-out System**: Check-out button remains enabled even after check-out, allowing multiple check-outs during a visit. Cards remain in 'in_progress' status after check-out. Cards only finalize when: (a) sale completed ("EFETUAR VENDA"), (b) not-sale registered ("Não Venda"), or (c) auto-failed (two days after scheduled date). Auto-checkout removed to give vendors full control.
    - **Check-in/Check-out Architecture**: Supports both `visitAgenda` and `sales_cards` flows for check-in/check-out. `daily_routes` store `sales_card IDs`. All check-in/check-out events register checkpoints in `route_checkpoints` to track actual distance and completed visits. Timestamps, coordinates, and distance data are synchronized across relevant tables.
    - **Cache Synchronization (Fixed Oct 2025)**: All mutations (check-in, check-out, send-to-Omie, toggle service type) now properly invalidate both `['/api/sales-cards']` and `['/api/sales-cards/by-day']` queries with `exact: false` to ensure UI state updates immediately after operations. SalesSchedule page includes useEffect to auto-update selectedCard when query data changes, ensuring modal displays fresh data after check-in/check-out.
    - **Modal Independent Query Pattern (Fixed Oct 2025)**: SalesCardDetailsModal implements independent `useQuery` to fetch fresh card data directly from backend (`queryKey: ['/api/sales-cards', card.id]`) instead of relying on stale prop data. Check-in/check-out buttons use `displayCard` (fresh query data) instead of `card` (prop) to ensure real-time state updates. After check-in success, modal query is explicitly refetched to immediately enable check-out button.
    - **Checkpoint Distance Tracking**: Displays distance between checkpoint location (check-in/check-out) and registered customer location using Haversine formula, helping identify location discrepancies.
    - **Check-in Audit System**: Complete audit trail of all check-ins from both `sales_cards` and `visit_agenda` with verification of checkpoint registration, route association, and data integrity. Accessible at `/check-in-audit` for both vendors and administrators.
    - **Fantasy Name Display Priority**: `fantasy_name` is consistently displayed as the primary customer identifier across all interfaces.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links directly on mobile or in a new tab on desktop.
- **Automated Agenda Management**: Scheduled daily (midnight UTC-3) and on-demand synchronization of sales cards for the next two months, calculating correct visit dates, managing cards, and providing statistics.
    - **Weekday Format Standardization (Nov 2025)**: System now uses **abbreviated weekday format exclusively** (Dom, Seg, Ter, Qua, Qui, Sex, Sab) for all route_day fields. All date calculation functions updated to generate abbreviated format. Admin route `/api/admin/fix-weekday-names` converts all existing cards from full-name formats (segunda-feira, terca, etc.) to abbreviated format.
    - **Visit Allocation Bug Fix (Nov 2025)**: Completely refactored visit date calculation to use centralized `calculateNextVisitDate()` from `shared/visitSchedule.ts`. All code paths (sales_cards generation, visit_agenda generation, and recurring card creation) now respect customer-configured weekdays instead of using fixed-day increments. Includes `normalizeWeekday()` function to handle mixed weekday formats (complete and abbreviated). Legacy path maintained for customers without weekday configuration. Migration tools available at `/api/admin/fix-weekday-names` (convert formats) and `/api/admin/sync-agenda` (recalculate all future cards).
    - **Multiple Weekdays Rule (Nov 2025)**: Customers with multiple weekdays configured (e.g., `["Seg", "Ter", "Qua", "Qui", "Sex"]`) are automatically allocated to **Sundays (Dom)** for visit scheduling. This special rule ensures consistent visit planning for flexible-schedule customers. Implemented in `calculateNextVisitDate()` which detects `weekdays.length > 1` and overrides to Sunday allocation.
- **Sales Card Configuration Replication**: Automatically propagates configuration changes to all future pending sales cards of a customer.
- **Sales Schedule Filtering**: Client-side search filter on Sales Schedule page (`/sales-schedule`) allows real-time filtering by customer fantasy name or company name with results counter display.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Features product mapping, vendor resolution, filtering, stage extraction, and automatic filtering of cancelled invoices.
    - **Automatic Customer Registration**: New customers created in Integra with CPF/CNPJ are automatically registered in Omie ERP, updating Integra with the `omieClientCode`.
    - **Vendor Assignment**: Correctly extracts and includes vendor codes from `sellerId` in `cabecalho.codigo_vendedor` when sending orders to Omie.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time for major sync operations via a `sync_status` table, with a dedicated display component.
- **Sales Goals Dashboard**: Displays individual seller metrics using aggregated SQL queries.
    - **CFOP Filtering Logic (Fixed Nov 2025)**: Revenue calculation previously excluded ALL billings with `cfop = NULL` (checking `billing.cfop && !excludedCFOPs.includes(billing.cfop)`). Fixed to include NULL/empty CFOP billings by default, only excluding specific CFOPs when present (trocas: 5.949/6.949, amostras: 5.911/6.911, bonificações: 5.910/6.910/5.915). This resolved zero revenue metrics despite confirmed billing data in database.
- **HR Management (RH)**: HR tracking system for seller performance, accessible at `/rh`.
    - **Monthly Mileage Tracking**: Aggregates daily route distances per seller.
    - **Work Hours Management**: Calculates daily work hours, deducting lunch, and compares against expected hours.
    - **Access Control**: Restricted to admin, coordinator, and administrative roles.
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access URL**: Available at `/shop` path (e.g., `https://integrahonest.replit.app/shop`). 
    - **Important**: Hotsite is ONLY available in PRODUCTION mode. Does not work in development due to Vite dev server limitations. To test: publish the project and access the deployed URL at `/shop`.
    - **Public API Routes**: Separate public endpoints for external sales channels (`/api/public/products`, `/api/public/orders`, `/api/public/customers/check`, `/api/public/reviews`).
    - **Hotsite Structure**: Standalone React SPA in `/hotsite` folder with own package.json, mobile-first design optimized for Instagram traffic. Builds to `server/public-hotsite`. Build command: `cd hotsite && npm run build && cp -r dist/* ../server/public-hotsite/`.
    - **Customer Type Selection Flow**: Interactive selection system at entry determines pricing table:
        - **Consumer Path**: Choose between Retail (< R$200) or Wholesale (≥ R$200) pricing
        - **Reseller Path**: Location-based pricing (Goiânia, Interior Goiás, Brasília/Entorno) with CNPJ verification
    - **Reseller CNPJ Verification**: After region selection, resellers must provide CNPJ for automatic data retrieval:
        - Checks if customer already exists in system
        - If new, queries Receita Federal API for company data
        - Displays company information for confirmation/editing
        - Validates CNPJ format and active status
        - Allows address editing before proceeding to catalog
    - **5 Price Tables**: Products support multiple pricing strategies:
        - `retail_price`: Retail pricing for consumers
        - `wholesale_price`: Wholesale pricing for larger consumer orders
        - `resale_goiania_price`: Reseller pricing for Goiânia
        - `resale_interior_price`: Reseller pricing for Interior Goiás
        - `resale_brasilia_price`: Reseller pricing for Brasília/Entorno
    - **Dynamic Pricing**: Prices displayed and applied based on customer type selection, stored in cart at selection time
    - **Customer Recognition**: Automatic customer verification during checkout with auto-fill of returning customer data.
    - **Security**: Server-side price validation, stock verification, and total recalculation to prevent client-side manipulation.
    - **Integration**: Orders created via hotsite are automatically registered in Sistema Integra as sales_cards with `source: 'hotsite'` marker.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (payment processing integration pending).
    - **Product Gallery System**: Multiple images per product with touch-swipe navigation (50px threshold), zoom functionality, and responsive image viewer in product details modal. Single-touch swipe detection prevents conflicts with pinch-to-zoom.
    - **Product Image Management**: Admin interface in ProductManagement component allows uploading multiple product images (max 10 per product) via drag-and-drop modal. Images stored as base64 data URLs in `imageUrl` (main) and `images` (array) fields. First image automatically set as product's primary image displayed in hotsite and catalog.
    - **Review System**: Customer product reviews with 1-5 star ratings, comments, and admin approval workflow. Reviews displayed with average rating and individual feedback; pending reviews require admin approval before public display. Admin can approve/reject reviews via Sistema Integra.
    - **Stock Management**: Hotsite accepts orders without stock verification. All orders are accepted regardless of inventory levels, allowing flexible order processing.
    - **Hotsite Orders Management**: Dedicated "Pedidos do Site" page accessible at `/hotsite-orders` for admin, coordinator, and administrative users to view and manage all orders placed through the hotsite. Shows order details, customer info, products, payment method, and status with filtering capabilities.

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