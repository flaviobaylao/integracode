# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, expand market reach, and increase sales. Key capabilities include robust sales tracking, reporting, route optimization, fine-grained access control, an e-commerce platform ("Hotsite Instagram"), and real-time billing data integration from Omie ERP for customer "positivation" status.

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
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo for visit schedule calculations. CPF/CNPJ validation. Bulk data imports. Customer displays prioritize `fantasy_name`. Normalization of weekday formats.
- **Sales & Financial Management**: Sales card tracking with source, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and sales goals dashboard.
- **Delivery & Route Optimization**:
    - Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API.
    - Visual mapping, checkpoint registration, performance dashboards.
    - Supports multi-vehicle planning, check-in/check-out, and checkpoint distance tracking.
    - Automatic coordinate validation with warnings.
    - Admin diagnostic tools.
    - **Route Allocation Logic**: `serviceStartDate` is contract start, not last visit. Routes filter customers where `routeDate >= serviceStartDate`. Single validation source via `calculateNextVisitDate()`.
    - **Executed Route Distance**: Calculates actual traveled distance based on chronological check-ins from seller's home to all visited locations and back home, using OSRM API. Recalculation occurs automatically after every checkpoint registration.
    - **"Rota do Dia" Page**: Auto-refreshing daily route visualization with metrics (total visits, completed, pending, average visit time, planned/executed distance, worked hours). Interactive map shows seller's home, customer visits, optimized route, actual executed route, and photo markers.
    - **Smart Visit List**: Inline check-in/check-out, color-coded status, location validation alerts.
    - **Average Visit Time**: Displays average duration of completed visits (check-in to check-out) in minutes.
    - **Visit Schedule Display**: Customer visit cards show weekdays and periodicity.
    - **Off-Route Visit Validation**: Admin users can validate or reject off-route check-ins.
    - **Automated Check-out**: Two mechanisms: (1) Time-based (30 mins after check-in, runs every 5 mins 6h-23h BRT), and (2) Action-based (auto check-out when sale or "no sale" is registered). Both update visitAgenda and route_checkpoints.
    - **Worked Hours Calculation**: Real-time calculation from first check-in to last check-out (or current time if in progress), deducting lunch breaks.
    - **Lunch Break Tracking**: Sellers can mark lunch time. System calculates duration. Worked hours automatically subtract lunch time or default 90 minutes.
- **Admin Route Management**: Administrative users can manually add, delete, and optimize visits on daily routes. "Add visit" includes customer search and sales_card creation with 'manual_route_addition' source.
- **Visit Schedule Management**: Route generation queries `customers` table directly. Visit scheduling is calculated on-demand from customer's `weekdays`, `visitPeriodicity`, and last visit from `sales_cards`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation system for configuration changes.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data. Customer inactivation. "Última Atividade" column for last sale date.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling, automated seller validation, and admin tools.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices. Order blocking system based on operation type, overdue debt, and payment terms.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA accessible at `/shop`. Features customer type selection (CPF/CNPJ with Receita Federal API), customer recognition/registration (new customers to Omie), **5-tier dynamic pricing system**, server-side security, automatic order registration in Sistema Integra as `sales_cards` (source: 'hotsite'). Supports Pix, Credit/Debit Card, and Boleto. Includes product gallery, customer reviews, stock management, order management page, and **technical product details**.
    - **5-Tier Pricing System**: Each product has separate prices for different customer segments:
        - **Consumidor Varejo** (retailPrice): For consumer purchases < R$200
        - **Consumidor Atacado** (wholesalePrice): For consumer purchases >= R$200
        - **Revenda Goiânia** (resaleGoianiaPrice): Resellers in Goiânia capital
        - **Revenda Interior** (resaleInteriorPrice): Resellers in Goiás interior
        - **Revenda Brasília/DF** (resaleBrasiliaPrice): Resellers in Brasília/DF area
    - **Pricing Logic**: Located in `hotsite/src/utils/pricing.ts`, uses `getProductPrice()` function to select appropriate price based on customer type and location. Falls back to base `price` if specific tier is NULL.
    - **Admin Management**: Admins configure all 5 price tiers via "Tabela de Preços do Hotsite" page. Products automatically populated with calculated prices: 0% (retail), -10% (wholesale), -15% (Goiânia), -20% (Interior), -25% (Brasília) from base price. Manual adjustment recommended for business-specific margins.
    - **Technical Details**: Products include optional technical details/specifications managed by admins. Details field (10,000 char max) preserves line breaks and displays conditionally in product modal. Editable via "Tabela de Preços do Hotsite" page.
    - **Hotsite Deployment**: Hotsite is a standalone SPA that must be rebuilt after source changes: `cd hotsite && npm run build && cp -r dist/* ../server/public-hotsite/`. Public API endpoints (`/api/public/products`) provide all product data including pricing and details.
- **Leads Management**: Lead tracking system with full route integration.
    - **Access Control**: Administrative users create/delete leads; all view; sellers update assigned leads.
    - **Lead Fields**: `fantasyName`, `latitude/longitude`, `contact`, `phone`, `photo`, `observation`, `status`.
    - **Route Integration**: Unified `visitStops` field allows mixing customers and leads on daily routes. When added to route, creates `sales_card` and assigns lead to seller.
    - **Photo Enforcement**: Leads require mandatory photos for check-in and check-out.
    - **UI**: Purple styling, "Lead" badge, and Target icon in Rota do Dia. Modal with tabs for adding visits. Dedicated `/leads` page with dashboard and CRUD.

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
- **OSRM API**