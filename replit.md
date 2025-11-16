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
- **Hotsite Design**: Premium landing page inspired by Solti.com with a hero section, badges, ingredient showcase, product showcase, benefits section, and enhanced footer. Visual theme uses a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing).
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), normalization of weekday formats.
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
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data. Customer inactivation.
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