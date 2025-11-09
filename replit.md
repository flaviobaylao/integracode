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
- **Data Handling**: ISO UTC for dates with **timezone conversion to America/Sao_Paulo** for all date comparisons in queries, CPF/CNPJ validation, bulk data imports, customer displays prioritizing `fantasy_name`, and normalization of weekday formats.
  - **Critical Timezone Fix (Nov 2025)**: Route regeneration endpoint now uses `fromZonedTime()` from date-fns-tz to parse incoming date strings (e.g., "2025-11-10") as Brazil local time (America/Sao_Paulo) instead of UTC. Previously, `new Date("2025-11-10")` interpreted dates as UTC midnight, which converted to 21:00 BRT the previous day, causing weekday mismatches that permanently removed scheduled visits. The fix ensures `routeDate.getDay()` returns correct weekday values and prevents visits from disappearing when clicking "Atualizar Rota".
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking with release functionality, and customer "positivation" based on Omie billings. Sales goals dashboard with individual seller metrics.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Includes automatic coordinate validation with warnings for suspicious distances (>100km) and critical route lengths (>500km). Admin diagnostic tool available at `/api/admin/diagnose-coordinates`.
- **Visit Schedule Management**: Implemented a permanent sales card architecture where each active customer has one reusable `sales_card`. All visit results are stored in `order_history`. `nextVisitDate` is calculated from customer's `weekdays` and `visitPeriodicity`. Updates to customer weekdays or periodicity trigger recalculation of `nextVisitDate`. Route generation queries for `isPermanent=true` and `nextVisitDate` within the current day using **Brazil timezone (America/Sao_Paulo)** for accurate date matching.
  - **Automatic Route Synchronization (Nov 2025)**: Implemented transactional service (`customerRecurrenceService.ts`) that automatically recalculates `nextVisitDate` and removes customers from outdated routes when editing customer recurrence data (weekdays, periodicity, or seller). Service handles three scenarios: (1) weekdays/periodicity change → recalculate nextVisitDate and remove from old date routes, (2) seller change → remove from previous seller's routes even if date unchanged, (3) combined changes → handle both route removals. Ensures routes remain consistent immediately after customer edits without manual regeneration. Uses robust JSON parser for weekdays field to handle both array and string formats from database.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation system for sales card configuration changes, including automatic recurrence change propagation.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data (including "Positivação"). Customer inactivation feature with confirmation of consequences. Improved client search across multiple fields (fantasy name, corporate name, CPF/CNPJ, phone). "Última Atividade" column displays last sale date. "Gestão de Clientes" (customers table) is the single source of truth for all sales operations and route generation.
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