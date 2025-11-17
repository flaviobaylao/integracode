# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, expand market reach, and increase sales. Key capabilities include robust sales tracking, reporting, route optimization, fine-grained access control, an e-commerce platform ("Hotsite Instagram"), and real-time billing data integration from Omie ERP for customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: 
    - Admin: flavio@bebahonest.com.br / M@riafe1
    - Motorista: kaique@bebahonest.com.br / test123
    - Telemarketing: telemarketing@bebahonest.com.br / test123

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.
- **Hotsite Design**: Premium landing page inspired by Solti.com with a hero section, badges, ingredient showcase, product showcase, benefits section, and enhanced footer. Visual theme uses a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista). 
    - **Motoristas**: Restricted access to only "Minhas Entregas" (/rota-entrega).
    - **Telemarketing**: Restricted access to Dashboard, Cards de Venda, Agenda de Vendas, Rota de Visitas, Clientes, and WhatsApp.
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), normalization of weekday formats.
    - **Weekday Update Fix** (Nov 2025): Fixed "dia inválido" error when updating customer visit weekdays. Enhanced `normalizeWeekdayInput()` function now handles:
        - Legacy data with combined tokens (e.g., "Seg/Qui" → ["Seg", "Qui"], "segunda e quarta" → ["segunda", "quarta"])
        - PostgreSQL array format conversion to JSON format
        - Strict validation with descriptive error messages
        - Automatic splitting of multi-day tokens using separators (/, ;, " e ")
        - Backward compatibility with all existing formats (arrays, JSON strings, comma-separated)
- **Sales & Financial Management**: Sales card tracking with source and conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and sales goals dashboard. Includes a system for prioritizing urgent deliveries in route optimization.
- **Delivery & Route Optimization**:
    - Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API.
    - Visual mapping, checkpoint registration, performance dashboards.
    - Multi-vehicle planning, check-in/check-out, and checkpoint distance tracking.
    - Unified Customer + Lead Optimization: Route optimization algorithm supports both customers and leads simultaneously.
    - 3-Layer Deduplication: Protects against duplicate route entries.
    - Route Allocation Logic: Filters customers where `routeDate >= serviceStartDate`.
    - Executed Route Distance: Calculates actual traveled distance based on chronological check-ins using OSRM API.
    - "Rota do Dia" Page: Auto-refreshing daily route visualization with metrics, interactive map, and photo markers.
    - Smart Visit List: Inline check-in/check-out, color-coded status, location validation alerts.
    - Automated Check-out: Time-based (30 mins after check-in) and action-based (sale or "no sale" registered).
    - Worked Hours Calculation: Real-time calculation from first check-in to last check-out, deducting lunch breaks.
    - Admin Route Management: Administrative users can manually add, delete, and optimize visits on daily routes.
    - **Visit Deletion Fix** (Nov 2025): Fixed critical bug preventing route visit deletion. System now supports flexible ID matching for both legacy format (simple entity IDs) and new format (prefixed stop IDs with timestamps). Deletion endpoint normalizes ID comparison to handle mixed format scenarios from data migrations.
    - Visit Schedule Management: Route generation queries `customers` table directly. Visit scheduling is calculated on-demand from customer's `weekdays`, `visitPeriodicity`, and last visit from `sales_cards`.
    - **Advanced Route Validation System** (Nov 2025):
        - **Vehicle Exclusivity**: Orders can require specific vehicle types (caminhão, carro, moto).
        - **Weekday Validation**: Validates route date against customer's allowed weekdays before assignment.
        - **Time Window Validation**: Ensures delivery time slots are compatible with vehicle operating hours.
        - **Average Delivery Time**: Calculates per-customer average from delivery history (last 10 completed deliveries).
        - **Proportional Distribution**: Balances workload across drivers using estimated work time (delivery + travel).
        - **Delivery History Tracking**: Full history with invoice numbers, driver info, vehicle type, check-in/out times, and delivery duration.
        - **API Endpoint**: POST /api/delivery-history for registering completed deliveries with automatic duration calculation.
        - **Hourly Time Slots**: Changed from time ranges to hourly checkboxes (08:00-18:00 weekdays, 08:00-12:00 Saturdays) for granular scheduling.
        - **Persistent Delivery Config**: Delivery preferences (vehicle types, delivery days, time slots) stored in customers table; editable from sales modal, delivery management, and customer edit modal; changes sync across all locations.
        - **Driver App (Rota Entrega)**: Simplified mobile-friendly app for delivery drivers at `/rota-entrega` with:
            - Restricted access: Motorista role users only see "Minhas Entregas" menu item
            - Date filter for viewing deliveries
            - Flat list of all deliveries sorted by stop order
            - Summary statistics (Total, Pending, Completed)
            - GPS check-in/check-out with mandatory photo capture
            - Waze navigation integration
            - Check-in/out buttons shown only when route is in progress
            - Test credentials: kaique@bebahonest.com.br / test123
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data. Customer inactivation. Customer details modal displays delivery configuration (delivery days, time slots for weekdays and Saturday, vehicle types, and exclusive vehicle requirement) with color-coded badges for easy identification. System prioritizes displaying `fantasy_name` (trade name) over `name` (legal name) across all customer-facing interfaces.
    - **Unified Customer Modals** (Nov 2025): Both "Editar Dados do Cliente" (Agenda de Vendas) and "Editar Cliente" (Gestão de Clientes) now have complete feature parity with all delivery configuration fields. Customer edit modal in "Gestão de Clientes" includes automatic normalization of delivery weekdays from legacy Omie data formats:
        - Nome Fantasia (Fantasy Name)
        - CPF/CNPJ with automatic person type switching
        - CNPJ search with Receita Federal API (Gestão de Clientes only)
        - GPS capture with Waze integration (Gestão de Clientes only)
        - Dias da Semana de Visita (Visit Weekdays) - normalized on load
        - Periodicidade de Visita (Visit Periodicity)
        - Data de Início do Fornecimento (Service Start Date - Gestão de Clientes only)
        - Atendimento Virtual (Virtual Service - Gestão de Clientes only)
        - Configurações de Entrega completas (Complete Delivery Settings):
            - Veículo Exclusivo (Exclusive Vehicle) with max 2 vehicle types validation
            - Tipos de Veículos (Vehicle Types): Caminhão, Carro, Moto
            - Dias de Entrega (Delivery Weekdays) - **normalized on load to handle legacy Omie formats**
            - Horários de Entrega Seg-Sex (Weekday Time Slots: 08:00-18:00)
            - Horários aos Sábados (Saturday Time Slots: 08:00-12:00)
        - **Data Normalization**: Uses enhanced `normalizeWeekdays()` function to automatically convert legacy Omie data formats (JSON strings, PostgreSQL arrays, full weekday names) to canonical codes ('Seg', 'Ter', etc.) preventing data corruption and validation errors
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices. Order blocking system. Hotsite orders can be sent to Omie ERP, automatically creating customers if needed, with robust validation for mandatory fields and numeric values.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection (CPF/CNPJ with Receita Federal API), customer recognition/registration, 5-tier dynamic pricing system, server-side security, and automatic order registration in Sistema Integra as `sales_cards` (source: 'hotsite'). Includes product gallery, customer reviews, stock management, order management page, and technical product details.
    - **Payment Methods**: Differentiated by customer type (Pix, Credit/Debit Card, Boleto).
    - **Shopping Cart UX**: Cart modal opens on product add and remains open, with multiple closing methods.
    - **Minimum Order & Shipping**: Free shipping on all orders with minimum order values enforced per customer type. No additional discounts.
    - **5-Tier Pricing System**: Products have separate prices for Consumidor Varejo, Consumidor Atacado, Revenda Goiânia, Revenda Interior, and Revenda Brasília/DF.
    - **Technical Details**: Optional technical details (10,000 char max) for products.
- **Leads Management**: Lead tracking system with full route integration.
    - **Access Control**: Administrative users create/delete leads; all view; sellers update assigned leads.
    - **Route Integration**: Unified `visitStops` field allows mixing customers and leads on daily routes.
    - **Photo Enforcement**: Leads require mandatory photos for check-in and check-out.
    - **Sales Card Access** (Nov 2025): Fixed bug preventing sellers from accessing lead cards in daily routes. System now properly extracts entityId from prefixed visit IDs ("lead:123:timestamp") to load the correct sales card, enabling sellers to treat visits, add observations, attach photos, and edit lead contact information.
- **Order Synchronization Fix** (Nov 2025): Corrected critical data source mismatch in delivery management. System now correctly queries billings table with `invoice_stage = 'Aguardando Rota'` (Omie ERP data) instead of sales_cards with `status = 'completed'` (internal data), ensuring delivery management displays the accurate 49 orders from Omie instead of incorrectly showing 206 internal sales cards.

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