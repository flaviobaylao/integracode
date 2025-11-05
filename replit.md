# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system supports various user roles with fine-grained access control, offering robust sales tracking, reporting, and route optimization. This aims to enhance business efficiency, improve customer service, and expand market reach. The project also includes an e-commerce platform ("Hotsite Instagram") to capture direct sales.

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
- **Sales Card Configuration Replication**: Automatically propagates configuration changes to future pending sales cards.
- **Sales Schedule Filtering**: Client-side search filter by customer fantasy name or company name. Weekday filter uses standardized abbreviated format (Seg, Ter, Qua, Qui, Sex, Sab, Dom).
- **Customer Weekdays Management in Sale Flow**: During sale completion, customer weekdays are displayed with checkboxes. For vendors: read-only (locked). For administrative users: editable, with changes automatically updating customer weekdays for all future sales cards.
- **Data Validation & Integrity**: 3-layer protection system ensures sales cards are always scheduled on correct weekdays: (1) Pre-creation validation in `createSalesCard`, (2) Admin endpoint `/api/admin/validate-cards` for diagnosis and auto-correction, (3) Diagnostic script `diagnose-cards.ts` for manual verification. Full documentation in `VALIDACAO_ROTAS.md`.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Features product mapping, vendor resolution, and automatic customer registration from Integra to Omie.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time for major sync operations.
- **Sales Goals Dashboard**: Displays individual seller metrics using aggregated SQL queries, including refined CFOP filtering logic for revenue calculation. Revenue calculations use current date as upper limit for month-to-date metrics to ensure accurate real-time values.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management) with restricted access.
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Available at `/shop` path in production mode.
    - **Public API Routes**: Separate public endpoints for products, orders, customer checks, and reviews.
    - **Structure**: Standalone React SPA with mobile-first design, building to `server/public-hotsite`.
    - **Customer Type Selection**: Interactive flow determines pricing table (Consumer: Retail/Wholesale; Reseller: Location-based with CNPJ verification).
    - **Reseller CNPJ Verification**: Automatic data retrieval from Receita Federal API, customer recognition, and address editing.
    - **Dynamic Pricing**: Five price tables (`retail_price`, `wholesale_price`, `resale_goiania_price`, `resale_interior_price`, `resale_brasilia_price`) based on customer type.
    - **Security**: Server-side price validation, stock verification, and total recalculation.
    - **Integration**: Orders automatically registered in Sistema Integra as sales_cards with `source: 'hotsite'`.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto.
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