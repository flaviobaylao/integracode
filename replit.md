# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. It aims to optimize business operations by integrating customer relationship management, product catalog administration, sales tracking, and WhatsApp communication. The system enhances efficiency, improves customer service, expands market reach, and significantly increases sales through features like robust sales tracking, advanced route optimization, fine-grained access control, an integrated e-commerce platform ("Hotsite Instagram"), and real-time billing data synchronization with Omie ERP for customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: 
    - Admin: flavio@bebahonest.com.br / M@riafe1
    - Motorista: kaique@bebahonest.com.br / test123
    - Telemarketing: telemarketing@bebahonest.com.br / test123

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.
- **Hotsite Design**: Premium landing page inspired by Solti.com, featuring a hero section, badges, ingredient showcase, product showcase, benefits, and an enhanced footer. Uses a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista). Access is restricted based on user roles.
- **Data Handling**: ISO UTC for dates with timezone conversion, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), and robust weekday normalization for visit schedules.
- **Sales & Financial Management**: Sales card tracking with source and conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard. Includes prioritization for urgent deliveries.
- **Delivery & Route Optimization**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API. Features include visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, check-in/check-out, checkpoint distance tracking, and automation for check-out. Advanced logic supports unified optimization for customers and leads, 3-layer deduplication, route allocation based on service start dates, and calculation of executed route distance. Admin controls allow manual addition, deletion, and optimization of visits, including empty route creation for flexible manual management. The system includes advanced validation for vehicle exclusivity, weekday/time window validation, average delivery time, and proportional workload distribution. Delivery history is tracked comprehensively. A dedicated driver app (`/rota-entrega`) provides a simplified mobile interface with GPS check-in/check-out (mandatory photo capture) and status tracking (pendente→em_pausa→efetuada→devolvida). Routes are saved with transactional integrity and automatic naming, and listed via a GET endpoint with embedded stops, timestamps, photos, and GPS coordinates. Admin-only deletion of stops or entire routes automatically returns billings to "Aguardando Rota" status.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering, customer inactivation, and detailed delivery configuration modals. Implements a three-layer date system: `weekdays` (seller visit day), `deliveryWeekdays` (auto-calculated delivery days), and `receivingWeekdays` (customer availability for routing).
- **Mapa de Clientes**: Interactive Leaflet map (`/mapa-clientes`) displaying active customers with color-coded pins based on visit day, including a legend and clickable popups with customer information and in-map editing capabilities. Access is restricted to administrative users.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices, with customer cache optimization. Orders from the Hotsite are sent to Omie ERP. Invoice stages are mapped for delivery status: "Pedido de Venda," "Em Rota," "Faturado," "Entregue," and "Aguardando Rota." Delivery days are automatically copied from customers to billings during synchronization, with admin tools for historical data correction. Virtual customers are excluded from driver routes. Delivery configuration includes a fallback to Omie data for billings not yet synchronized to Integra, ensuring full visibility.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **System Administration**: Admin-only page (`/admin/system`) with data maintenance tools, including a delivery days recalculation utility with dry-run and apply modes.
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection (CPF/CNPJ with Receita Federal API), dynamic 5-tier pricing, server-side security, and automatic order registration as `sales_cards` in Sistema Integra. Features product gallery, stock management, order management, and differentiated payment methods.
- **Leads Management**: Integrated lead tracking system with route optimization. Access control allows administrative users to create/delete leads, all users to view, and sellers to update assigned leads with mandatory photo enforcement for check-in/check-out.
- **Order Synchronization**: Correct synchronization of pending deliveries by querying Omie ERP data (`invoice_stage = 'Aguardando Rota'`) from the `billings` table.
- **Evolution API WhatsApp Integration**: Foundational WhatsApp integration service supporting text messages, images, message history, instance status, and template messages, with automatic E.164 phone number formatting.

# External Dependencies

- **Neon PostgreSQL**
- **Drizzle ORM**
- **Replit Authentication**
- **Passport.js**
- **Radix UI**
- **Lucide React**
- **Tailwind CSS**
- **Leaflet**
- **WhatsApp Business API** (via Evolution API)
- **Receita Federal API**
- **Omie ERP**
- **OSRM API**