# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, and expand market reach. Key capabilities include robust sales tracking, reporting, route optimization, and fine-grained access control. It also features an e-commerce platform ("Hotsite Instagram") for direct sales and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# Recent Changes

## 2025-11-07: Route Generation Migration to sales_cards

**Critical Fix**: Daily route generation completely rewritten to use `sales_cards` as source of truth instead of deprecated `customers.weekdays` field.

### Changes Made:
1. **`generateDailyRoute()` function** (server/routeOptimizationService.ts):
   - OLD: Filtered customers by `customers.weekdays` array (empty/deprecated field)
   - NEW: Queries `sales_cards` table filtered by `sellerId`, `scheduledDate`, and status
   - Result: Routes now generate correctly based on actual scheduled sales cards
   
2. **SQL Bug Fix** (server/routes.ts line 9196):
   - Fixed incorrect field reference: `assignedSellerId` → `sellerId`
   - Resolves SQL error when fetching customers without coordinates

### Impact:
- Automatic route generation at 05:00 now works correctly
- Manual route generation via UI functioning properly
- Test confirmed: Celso R. with 33 sales_cards → 26-visit route (7458.1km)

### Data Hierarchy:
- `sales_cards` = **source of truth** for visit scheduling
- `route_day` + `recurrence_type` fields determine visit dates
- `customers.weekdays` field deprecated (no longer used)

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
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking.
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