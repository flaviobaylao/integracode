# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos, designed to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. It features robust sales tracking, reporting, and route optimization, with fine-grained access control for various user roles. The system aims to enhance business efficiency, improve customer service, and expand market reach, including an e-commerce platform ("Hotsite Instagram") for direct sales, and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

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
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer displays prioritizing `fantasy_name`, and normalization of weekday formats.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking with release functionality, and customer "positivation" based on Omie billings.
- **Delivery & Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Features include manual customer addition to routes, deletion of visits from daily routes, and temporary local route re-optimization. Route generation is now based directly on customer data and `visit_schedule_history`.
- **Visit Schedule History System**: Persistent tracking of all scheduled visits (past and future) with completion status, based on customer-specific periodicity (weekly, bi-weekly, monthly, bi-monthly) anchored to `serviceStartDate`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Automated Agenda Management**: Scheduled daily and on-demand synchronization, now focusing on `visit_schedule_history` for visit dates and `order_history` for order details.
- **Sales Card Configuration Replication**: Role-based propagation system for sales card configuration changes (e.g., recurrenceType, paymentMethod) to future or all non-finalized cards. Includes automatic recurrence change propagation (creating/cancelling future cards within a 60-day window).
- **Sales Schedule Filtering**: Client-side search and weekday filtering.
- **Customer Weekdays Management in Sale Flow**: Editable for administrative users, read-only for vendors.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling on correct weekdays, automated seller validation, and admin tools for diagnosis and correction.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices, including product mapping and customer registration.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time.
- **Sales Goals Dashboard**: Individual seller metrics using aggregated SQL queries with refined CFOP filtering.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management).
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Available at `/shop` path.
    - **Public API Routes**: Separate public endpoints for products, orders, customer checks, and reviews.
    - **Structure**: Standalone React SPA with mobile-first design.
    - **Customer Type Selection**: Interactive flow determines pricing table (Consumer: Retail/Wholesale; Reseller: Location-based with CNPJ verification).
    - **Validation**: Pre-checkout CPF validation for consumers, automatic data retrieval from Receita Federal API for reseller CNPJ verification.
    - **Customer Recognition**: Triple-layer lookup (email OR phone OR CPF/CNPJ) prevents duplicates and auto-fills data.
    - **Automatic Omie Registration**: New hotsite customers automatically registered in Omie ERP.
    - **Dynamic Pricing**: Five price tables based on customer type.
    - **Security**: Server-side price validation, stock verification, and validated CPF/CNPJ enforcement.
    - **Integration**: Orders automatically registered in Sistema Integra as `sales_cards` with `source: 'hotsite'`.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (PJ only).
    - **Product Gallery System**: Multiple images per product with touch-swipe navigation and zoom.
    - **Product Image Management**: Admin interface for uploading multiple images.
    - **Review System**: Customer product reviews with ratings, comments, and admin approval.
    - **Stock Management**: Accepts orders regardless of inventory levels.
    - **Hotsite Orders Management**: Dedicated page for managing hotsite orders with filtering.

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