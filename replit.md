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
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo for visit schedule calculations. CPF/CNPJ validation. Bulk data imports. Customer displays prioritize `fantasy_name`. Normalization of weekday formats. Route storage and lookup use UTC-based storage for consistency.
- **Sales & Financial Management**: Sales card tracking with source field, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking, customer "positivation" based on Omie billings, and sales goals dashboard.
- **Delivery & Route Optimization**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API. Visual mapping, checkpoint registration, performance dashboards. Supports multi-vehicle route planning, check-in/check-out system, and checkpoint distance tracking. Includes automatic coordinate validation with warnings for suspicious distances and critical route lengths. Admin diagnostic tool available. **Weekday/Periodicity Validation (Nov 13, 2025)**: Route allocation strictly filters customers by configured weekdays and visit periodicity (semanal/quinzenal/mensal). Function `planDailyRoute()` validates each customer against route date before inclusion. Prevents incorrect allocation (e.g., Tuesday customers in Friday routes). Handles weekdays as JSON array or Drizzle array type, serviceStartDate as Date|null. Detailed logging for debugging customer rejections.
- **Rota do Dia**: New simplified daily route visualization page with auto-refresh, manual refresh, and route metrics dashboard (total visits, completed, pending, average visit time, planned/executed distance, **worked hours** - Nov 12, 2025). Interactive map shows seller's home, customer visits, optimized route, actual executed route, and photo markers. Smart visit list with inline check-in/check-out, color-coded status (completed, in progress, location validation issue, pending), and location validation alerts. **Visit Schedule Display (Nov 13, 2025)**: Each customer visit card displays weekdays (e.g., "Seg, Ter") and periodicity ("Semanal", "Quinzenal", "Mensal") in blue text with Calendar icon, positioned between address and check-in/check-out times. LEADs do not display schedule information. Data sourced directly from customers table (weekdays JSON array, visitPeriodicity enum). Off-route check-ins section. Sales card integration for immediate order registration from any visit. Distance calculations use Haversine formula. All dates use UTC for storage but display in Brazil/São Paulo timezone.
- **Admin Route Management**: Administrative users can manually add, delete, and optimize visits on daily routes. Add visit feature includes customer search and sales_card creation with 'manual_route_addition' source. Delete visit affects only that day's route. Optimize route recalculates order using Nearest Neighbor + 2-opt.
- **Automated Check-out System (Nov 12, 2025)**: Auto check-out service monitors visits with check-in but no check-out. **Maximum visit duration: 30 minutes**. After 30 minutes from check-in without check-out, system automatically performs check-out using the same coordinates as check-in. Cron job executes every 5 minutes (6h-23h BRT) to process pending check-outs. Updates visitAgenda, salesCards, and registers checkpoint in route_checkpoints table. Ensures accurate route completion metrics and worked hours calculation.
- **Worked Hours Calculation (Nov 12, 2025)**: Daily route metrics include **worked hours** calculated from first check-in to last check-out of the day. Displayed in metrics dashboard as "Carga Horária" with format "Xh Ymin". Backend returns workedHours object: { hours, minutes, total, formatted }. Enables accurate tracking of seller daily work time for HR monitoring and performance analysis.
- **Lunch Break Tracking (Nov 12, 2025)**: Sellers can mark lunch time with a red "Iniciar Almoço" button (available after first check-in). System calculates lunch duration from last check-out before activation to first check-in after. Three button states: red (available), amber (pending return), green (completed). Lunch time card displays default "1h 30min (padrão)" when not activated, "Aguardando retorno" when pending, or measured time "Xh Ymin" when completed. Worked hours automatically subtract lunch break time or auto-deduct 90 minutes if not activated. Endpoint POST /api/daily-routes/:routeId/lunch-break is idempotent and validates at least one check-in exists. Supports midnight-crossing lunch breaks with timestamp normalization.
- **Visit Schedule Management**: Route generation queries the customers table directly. Visit scheduling is calculated on-demand using `calculateNextVisitDate()` from customer's `weekdays`, `visitPeriodicity`, and last visit from `sales_cards`. Sales cards are used for both sales transactions and visit history tracking. Fallback logic for customers without `serviceStartDate`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Sales Card Configuration**: Role-based propagation system for sales card configuration changes, including automatic recurrence change propagation.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data. Customer inactivation feature. Improved client search across multiple fields. "Última Atividade" column displays last sale date. "Gestão de Clientes" is the single source of truth for all sales operations and route generation, prioritizing `fantasyName`.
- **Data Validation & Integrity**: 3-layer protection for sales card scheduling, automated seller validation, and admin tools for diagnosis and correction.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices, including product mapping and customer registration. Sync status tracking.
- **HR Management (RH)**: HR tracking system for seller performance (monthly mileage, work hours management, and daily attendance percentage).
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with mobile-first design. Features customer type selection and validation (CPF for consumers, CNPJ for resellers with Receita Federal API integration), customer recognition and registration (prevents duplicates, auto-fills data, new customers registered in Omie ERP), dynamic pricing with five price tables, server-side security, automatic order registration in Sistema Integra as `sales_cards` with `source: 'hotsite'`. Supports Pix, Credit/Debit Card, and Boleto. Includes a product gallery system, customer review system, stock management (accepts orders regardless of inventory), and a dedicated order management page.
- **Leads Management (Nov 13, 2025)**: Lead tracking system for prospective customers with full route integration. **Access Control**: Administrative users (admin/coordinator/administrative) can create/delete leads; all users can view; sellers can update assigned leads. **Lead Fields**: fantasyName (required), latitude/longitude (required), contact, phone, photo (captured during check-in/check-out), observation, status (pending/contacted/converted/cancelled). **Route Integration**: Unified stop model using `visitStops` JSONB field allows mixing customers and leads on daily routes. When lead added to route via POST /api/daily-routes/:routeId/leads, system automatically: (1) creates sales_card with source='manual_route_addition', (2) assigns lead to route's seller, (3) updates visitStops with stopId format "lead:{id}". **Photo Enforcement**: LEADs require MANDATORY photos for both check-in and check-out (API returns 400 if missing). Customers have optional photos. Backend uses isLeadVisit() helper to detect leads via visitStops lookup with fallback to direct database query. **UI**: Purple styling (bg-purple-50) with "Lead" badge and Target icon in Rota do Dia. Modal with tabs (Customers | Leads) for adding visits. GET /api/leads endpoint uses ?sellerId query param to filter available leads (unassigned or assigned to seller). Frontend page at /leads with stats dashboard and CRUD interface. **Database**: leads table with fantasy_name, latitude/longitude (DECIMAL), contact, phone, photo, observation, status (lead_status enum), created_by, assigned_to, last_check_in_at, last_check_out_at timestamps.

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