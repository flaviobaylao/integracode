# Overview

"Sistema Integra" is a comprehensive CRM and sales management system designed for Honest Sucos. Its core purpose is to optimize business operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance efficiency, improve customer service, and expand market reach through features like robust sales tracking, reporting, route optimization, and fine-grained access control. It also includes an e-commerce platform ("Hotsite Instagram") for direct sales and integrates real-time billing data from Omie ERP for accurate customer "positivation" status.

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
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo for all date comparisons in queries. Includes CPF/CNPJ validation, bulk data imports, customer display prioritization, and weekday normalization. Critical timezone fixes ensure accurate date parsing for route generation.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking, order release functionality, and customer "positivation" based on Omie billings. Sales goals dashboard with individual seller metrics.
- **Delivery & Route Optimization**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API, visual mapping, checkpoint registration, and performance dashboards. Supports multi-vehicle planning, check-in/check-out, and distance tracking. Includes automatic coordinate validation and admin diagnostic tools.
- **Visit Schedule Management**: Permanent sales card architecture with reusable `sales_card` per customer, storing visit results in `order_history`. `nextVisitDate` is calculated from customer's recurrence settings (weekdays, periodicity) and updated automatically upon changes. Route generation queries accurately use the Brazil timezone. Automatic route synchronization recalculates `nextVisitDate` and removes customers from outdated routes upon customer recurrence or seller data edits.
- **Automatic Card Reset System**: When permanent cards are completed, the system automatically creates an `order_history` entry, clears temporary fields (products, saleValue, notes, completedDate, check-in/out data, delivery fields, telemarketing fields, and all Omie/invoice identifiers), recalculates `nextVisitDate`, and resets the card status to 'pending' for reuse.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation for configuration changes and automatic recurrence change propagation.
    - **Complete Order Duplication from Route**: Allows vendors to duplicate a customer's last order (including products, quantities, prices, payment, freight, discount) into a new `sales_card` directly from the daily route view, streamlining repeat sales. If no previous orders exist, a blank sales card is provided.
    - **Duplicate Card Validation**: Prevents manual creation of multiple active cards for the same customer while allowing the permanent card system to function. System-generated permanent cards bypass this validation.
    - **Smart Prepare-Sale Workflow**: Unified endpoint `/api/customers/:customerId/prepare-sale` with 3-scenario logic: (1) existing virgin card → opens details modal directly, (2) no active card + order history → duplicates last order and opens details, (3) no history → opens creation modal with callback to auto-open details after save. Defensive `getActiveSalesCard()` helper excludes polluted cards (cards with products/saleValue despite pending status). Admin cleanup endpoint `/api/admin/cleanup-polluted-cards` available with dry-run mode for mass finalization of polluted cards. Frontend callback chain ensures seamless modal transitions without manual navigation.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data, including "Positivação". Features customer inactivation, improved multi-field client search, "Última Atividade" column, and a centralized "Gestão de Clientes" table.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling, automated seller validation, and admin tools for diagnosis.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices.
    - **Sales Category Code**: Uses a fixed fiscal category `OMIE_SALES_CATEGORY_CODE = "1.01.01"` for all order submissions to Omie.
    - **Automatic Vendor Sync**: Automatically updates the responsible vendor in Omie ERP when a customer's seller is changed in "Gestão de Clientes" for Omie-sourced customers and vendors.
    - **CFOP Fallback Mechanism**: Implemented ConsultarNF API fallback with concurrency control to retrieve missing CFOPs from invoices, significantly reducing null values.
    - **Enhanced CFOP Classification**: Defines five billing types ('venda', 'devolucao', 'entrada', 'amostra', 'troca') for accurate sales metrics, where `vendas_líquidas = vendas - devoluções`.
    - **Cancelled Invoice Handling**: Correctly identifies and excludes cancelled invoices from sales calculations based on SEFAZ status, order stage, or direct invoice cancellation flags. All cancelled invoices are saved with `is_cancelled = true` for audit.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours, daily attendance).
- **E-commerce Platform (Hotsite Instagram)**:
    - **Access**: Publicly accessible at `/shop`.
    - **Structure**: Standalone React SPA with mobile-first design.
    - **Customer Type Selection & Validation**: Interactive flow for pricing, CPF validation for consumers, and automatic CNPJ verification via Receita Federal API for resellers.
    - **Customer Recognition & Registration**: Triple-layer lookup for data autofill and duplicate prevention. New hotsite customers are automatically registered in Omie ERP.
    - **Dynamic Pricing**: Five price tables based on customer type.
    - **Security**: Server-side price and stock validation, enforced CPF/CNPJ.
    - **Integration**: Hotsite orders are automatically registered in Sistema Integra as `sales_cards` with `source: 'hotsite'`.
    - **Payment Methods**: Accepts only PIX and Boleto Bancário with a 7-day payment term.
    - **Product Features**: Gallery system with multiple images, touch-swipe navigation, and zoom. Admin interface for image upload.
    - **Review System**: Customer product reviews with ratings, comments, and admin approval.
    - **Stock Management**: Accepts orders regardless of inventory levels.
    - **Order Management**: Dedicated page for managing hotsite orders with filtering and notification badges.
    - **Omie Submission Workflow**: Hotsite orders can be reviewed and manually sent to Omie ERP from a dedicated management interface, tracking sync status and errors.
    - **Payment Gateway Integration**: Pending implementation with Efí Bank (formerly Gerencianet) for PIX QR Code generation, card tokenization, boleto generation, and webhook notifications.

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
- **Efí Bank (formerly Gerencianet)**