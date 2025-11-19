# Overview

"Sistema Integra" is a comprehensive CRM and sales management system designed for Honest Sucos. Its core purpose is to optimize business operations by integrating customer relationship management, product catalog administration, sales tracking, and WhatsApp communication. The system aims to enhance efficiency, improve customer service, expand market reach, and significantly increase sales. Key features include robust sales tracking and reporting, advanced route optimization, fine-grained access control, an integrated e-commerce platform ("Hotsite Instagram"), and real-time billing data synchronization with Omie ERP for customer "positivation" status.

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
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista). Access is restricted based on user roles (e.g., drivers to "Minhas Entregas", telemarketing to specific dashboards).
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), and robust weekday normalization for visit schedules.
- **Sales & Financial Management**: Sales card tracking with source and conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard. Includes prioritization for urgent deliveries.
- **Delivery & Route Optimization**:
    - **Route Generation**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API.
    - **Features**: Visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, check-in/check-out, and checkpoint distance tracking.
    - **Advanced Logic**: Unified optimization for customers and leads, 3-layer deduplication, route allocation based on service start dates, and calculation of executed route distance.
    - **Driver Interface**: "Rota do Dia" page with auto-refreshing visualization, metrics, interactive map, and photo markers. Smart visit list with inline check-in/check-out, color-coded status, and location validation.
    - **Automation**: Automated check-out (time-based or action-based). Real-time worked hours calculation.
    - **Admin Control**: Administrative users can manually add, delete, and optimize visits.
    - **Advanced Validation**: Supports vehicle exclusivity, weekday validation, time window validation, average delivery time calculation, and proportional workload distribution.
    - **Delivery History**: Comprehensive tracking with API endpoint for registering completed deliveries and automatic duration calculation.
    - **Scheduling**: Hourly time slots for granular scheduling. Persistent delivery configurations stored in customer profiles and synced across locations.
    - **Driver App**: Simplified mobile-friendly app (`/rota-entrega`) for drivers with restricted access, date filtering, flat delivery lists, summary statistics, GPS check-in/check-out with mandatory photo capture, and Waze navigation.
    - **Check-in/Check-out System**: Complete implementation with GPS coordinates capture (checkInLatitude/Longitude, checkOutLatitude/Longitude), mandatory photo capture stored in delivery_route_stops photos array, and status tracking (pendente→em_pausa→efetuada). Automatic duration calculation between check-in and check-out timestamps.
    - **Delivery Status Management**: Four status levels: PENDENTE (pending), EFETUADA (completed), EM PAUSA (in progress after check-in), DEVOLVIDA (returned). Visual badges with color-coding in both driver app and Routes Summary screen.
    - **Route Saving**: New database schema (`delivery_routes`, `delivery_route_stops`) for comprehensive tracking. POST endpoint for saving planned routes with validation, transactional integrity, automatic naming, sequential numbering, and billing status updates.
    - **Route Listing**: GET endpoint for filtering and displaying routes with embedded stops, check-in/out timestamps, photos, and GPS coordinates. "Routes Summary Page" (`/delivery-routes`) provides route cards with key metrics, expandable details, visual status indicators, photo galleries, delivery duration, and complete location history.
    - **Route Deletion**: Admin-only (admin, coordinator, administrative) functionality to delete individual stops or entire routes. DELETE endpoints automatically return billings to "Aguardando Rota" status for re-routing. UI features confirmation dialogs with clear messaging about billing rollback behavior.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering, customer inactivation. Customer details modal displays delivery configuration (days, time slots, vehicle types, exclusive vehicle) with color-coded badges. Prioritizes `fantasy_name` display. Unified customer modals with full feature parity for editing customer data. **Three-Layer Date System**: (1) `weekdays` - dia da visita do vendedor (ex: Terça); (2) `deliveryWeekdays` - dias de entrega calculados automaticamente (2 dias úteis após visita, ex: Quarta e Quinta) - usado APENAS para sinalização ao lado da NF; (3) `receivingWeekdays` - dias em que cliente aceita receber mercadorias (ex: Segunda a Sexta) - configurado MANUALMENTE e usado para ROTEIRIZAÇÃO. System automatically calculates deliveryWeekdays based on visit days across all customer creation/update endpoints (PATCH/POST customers, Omie import, Omie sync), but receivingWeekdays must be manually configured for each customer as it represents their actual receiving availability.
- **Mapa de Clientes**: Interactive Leaflet map (`/mapa-clientes`) displaying all active customers with color-coded pins based on visit day. Pin colors: Segunda (Verde #22c55e), Terça (Azul #3b82f6), Quarta (Amarelo #eab308), Quinta (Vermelho #ef4444), Sexta (Roxo #a855f7). Features include legend with customer counts per day, clickable pins with customer information popups (name, address, phone, visit day), automatic filtering of active customers with valid coordinates, and **in-map customer editing**. Access restricted to administrative users only (admin, coordinator, administrative). Map height responsive with calc(100vh - 320px) minimum 600px for optimal vertical space. Clicking "Editar Cliente" button in marker popup opens full CustomerEditModal for complete data editing with delivery configuration, GPS coordinates, visit days, and all customer details.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices with customer cache optimization to prevent N+1 database queries. Order blocking system. Hotsite orders are sent to Omie ERP, with automatic customer creation and robust validation. **Omie Stage Mapping** (updated 18/11/2025): Etapa 10 = "Pedido de Venda", Etapa 20 = "Em Rota" (notas em rota de entrega), Etapa 50/60 = "Faturado", Etapa 70 = "Entregue", Etapa 80 = "Aguardando Rota" (notas aguardando alocação em rota). Most invoices come from Omie with stage 20 ("Em Rota"), while stage 80 ("Aguardando Rota") is used less frequently. **Delivery Days Sync Fix** (November 19, 2025): Fixed root cause - Omie client import was using ["Seg","Ter","Qua","Qui","Sex"] fallback for customers without visit days configured, resulting in incorrect delivery_weekdays showing all weekdays. transformOrderToBilling and transformInvoiceToBilling now automatically copy delivery_weekdays from customers to billings during synchronization. loadCustomersCache() preloads all customers at sync start to eliminate per-billing database queries. Admin endpoints /api/admin/fix-customer-delivery-days and /api/admin/fix-billing-delivery-days available to correct historical data in production. Bug fixes applied: transformInvoiceToBilling now correctly includes omieOrderId, orderNumber, and orderDate fields; hotsite orders now properly update existing customer email and phone fields.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **System Administration**: Admin-only page (`/admin/system`) providing data maintenance tools including delivery days recalculation utility. Features dry-run mode for safe preview and apply mode for bulk corrections. Interface displays detailed statistics (total analyzed, changes, updated, already correct) and change details for up to 100 customers. Successfully recalculated 1197 customer delivery days on November 18, 2025.
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection (CPF/CNPJ with Receita Federal API), customer recognition/registration, 5-tier dynamic pricing, server-side security, and automatic order registration in Sistema Integra as `sales_cards`. Includes product gallery, customer reviews, stock management, order management, and optional technical product details. Supports differentiated payment methods by customer type, smart shopping cart UX, minimum order enforcement, and free shipping.
- **Leads Management**: Lead tracking system fully integrated with route optimization. Access control allows administrative users to create/delete leads, all users to view, and sellers to update assigned leads. Mandatory photo enforcement for check-in/check-out for leads. Sellers can access and update lead cards within daily routes.
- **Order Synchronization**: Correct synchronization of pending deliveries by querying Omie ERP data (`invoice_stage = 'Aguardando Rota'`) from the `billings` table.
- **Delivery Management SQL Type Fix**: Resolved PostgreSQL type conversion errors by explicitly casting JSON fields to `::json` and using consistent empty array fallbacks.

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