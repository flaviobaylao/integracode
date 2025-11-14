# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, expand market reach, and increase sales. Key capabilities include robust sales tracking, reporting, route optimization, fine-grained access control, an e-commerce platform ("Hotsite Instagram"), and real-time billing data integration from Omie ERP for customer "positivation" status.

# Recent Changes (Nov 14, 2025)

## Hotsite Orders Display Bug Fix
- **Issue**: `/api/hotsite-orders` endpoint returned empty array despite hotsite orders existing in database
- **Root Cause**: Called `getSalesCards({})` which passed empty object as `sellerId` parameter, causing SQL to filter by `seller_id = '[object Object]'`
- **Fix**: Changed to `getSalesCards(undefined)` to fetch all sales_cards without seller filter
- **Impact**: Hotsite orders now display correctly in "Pedidos do Site" admin page

## Hotsite Order Value (saleValue) Bug Fix
- **Issue**: Order totals displayed as R$ 0.00 in "Pedidos do Site" page despite orders having correct values in notes
- **Root Cause**: POST `/api/public/orders` endpoint created sales_cards without populating `saleValue` field, storing total only as text in `notes`
- **Fix**: Added `saleValue: serverTotal.toString()` to orderData (line 13160 in server/routes.ts)
- **Data Backfill**: Executed SQL UPDATE to extract totals from notes and populate sale_value for existing hotsite orders using regex pattern
- **Validation**: End-to-end test confirmed new orders now save with correct saleValue (verified order created with sale_value = 75.00)
- **Impact**: All hotsite orders (new and existing) now display correct monetary values in admin interface

## Hotsite Orders Management Features
- **Interactive Order Details Modal**: Clicking on order row or eye icon opens modal with complete order information including products, customer details, and payment method
- **Delete Order Functionality**: Admin/coordinator/administrative users can delete hotsite orders via DELETE `/api/hotsite-orders/:id` endpoint. Validates user permissions and confirms order source is 'hotsite' before deletion
- **Send to Omie Integration**: Admin users can send hotsite orders to Omie ERP via POST `/api/hotsite-orders/:id/send-to-omie` endpoint
  - Automatically creates customer in Omie if customer doesn't exist (using `createOmieOrder` function)
  - Validates order hasn't been sent previously to prevent duplicates
  - Handles both array and string formats for order products field
  - Updates sales_card with Omie order ID and sync status after successful send
  - Returns both `numero_pedido` and `omieOrderNumber` for frontend compatibility

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
    - **Unified Customer + Lead Optimization**: Route optimization algorithm (`resolveRouteStops()` helper) supports both customers and leads simultaneously. Uses `visitStops` metadata with stopId format "customer:{id}" or "lead:{id}". Legacy support detects prefixes for backward compatibility with routes created before metadata system.
    - **3-Layer Deduplication**: Protects against duplicate route entries at GET (display), POST input (processing), and POST output (reconstruction) levels to ensure data integrity.
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
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA accessible at `/shop`. Features customer type selection (CPF/CNPJ with Receita Federal API), customer recognition/registration (new customers to Omie), **5-tier dynamic pricing system**, server-side security, automatic order registration in Sistema Integra as `sales_cards` (source: 'hotsite'). Includes product gallery, customer reviews, stock management, order management page, and **technical product details**. Order confirmation displays message: "Nossa equipe entrará em contato para agendar sua entrega".
    - **Payment Methods**: Differentiated by customer type - Consumers (CPF) can pay via Pix or Credit/Debit Card; Resellers (CNPJ) can pay via Pix or Boleto (subject to credit approval). Card payment is not available for resellers.
    - **Shopping Cart UX**: Cart modal opens when product added and stays open until explicitly closed (no auto-close). Includes "Continuar Comprando" button for easy multi-product shopping. Multiple close methods: continue shopping button, X button, clicking overlay, or ESC key.
    - **Minimum Order & Shipping**: Free shipping on all orders. Minimum order values: Consumidor Varejo (R$ 70), Consumidor Atacado (R$ 200), CNPJ Goiânia (R$ 150), CNPJ Interior (R$ 350). Cart displays minimum order warnings and disables checkout if minimum not met. No additional discounts applied - prices are already differentiated by customer type through 5-tier pricing system.
    - **Premium Landing Page Design**: Redesigned Nov 2025 inspired by Solti.com with:
        - **Hero Section**: Fullscreen background with product line image, bold messaging "100% Fruta. Zero Mentira." emphasizing purity (no sugar, no preservatives).
        - **Badges Section**: Three prominent badges (100% FRUTA, ZERO AÇÚCAR, ZERO CONSERVANTES) with icons and hover effects.
        - **Ingredients Showcase**: Grid displaying 8 key fruits (Acerola, Maracujá, Framboesa, Limão, Mirtilo, Morango, Maçã, Pera) with emoji icons and photos.
        - **Product Showcase**: Lifestyle photography section (3 images) showing product usage in real contexts.
        - **Benefits Section**: Green gradient section highlighting brand values (Saúde de Verdade, Energia Natural, Sabor Autêntico, Qualidade Garantida).
        - **Enhanced Footer**: 3-column layout with company info, contact details, and business hours.
        - **Visual Theme**: Strawberry/pink color palette, premium spacing, clean typography, generous white space inspired by premium beverage brands.
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
    - **Assets Management**: Product and lifestyle photos stored in `hotsite/public/images/` and served via `/shop/images/` path.
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