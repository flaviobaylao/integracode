# Overview

This project is a Customer Relationship Management (CRM) system named "Sistema Integra" for Honest Sucos, a Brazilian juice company. Its primary purpose is to streamline sales management, offering capabilities such as customer relationship management, product catalog maintenance, sales card tracking, and WhatsApp integration for communication. The system supports multiple user roles with role-based access control and provides comprehensive sales tracking and reporting to enhance business operations and market reach.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React with TypeScript, using Vite.
- **UI Library**: Radix UI components with shadcn/ui design system.
- **Styling**: Tailwind CSS with custom CSS variables.
- **Routing**: Wouter for client-side routing.
- **State Management**: TanStack Query for server state.
- **Form Handling**: React Hook Form with Zod validation.

## Backend Architecture
- **Runtime**: Node.js with Express.js.
- **Language**: TypeScript with ES modules.
- **Authentication**: Email/Password authentication, compatible with Replit Auth for session management. Passport.js for OpenID Connect integration.
- **Session Management**: Express sessions with PostgreSQL store.
- **Database**: PostgreSQL with Drizzle ORM.
- **API Design**: RESTful API endpoints with role-based access control.

## Database Schema
- **Entities**: Users (role-based), Customers, Products, Sales Cards, Message Templates, Message History, Delivery Management, Sessions.

## Authentication & Authorization
- **Authentication Provider**: Replit OpenID Connect integration, supplemented by internal email/password.
- **Session Storage**: PostgreSQL.
- **Authorization**: Role-based access control (admin, coordinator, administrative, vendedor, telemarketing).
- **User Management**: Comprehensive user management interface accessible via sidebar menu "Usuários" (admin-only). Admin can create users with full control over: email, password (min 6 chars, bcrypt hashed), first/last name, role selection, and route assignment. Interface includes user listing with filtering, activation/deactivation toggles, role editing, password editing, and user deletion. Password updates are admin-only (PUT /api/users/:id/password) with bcrypt hashing. User deletion is admin-only (DELETE /api/users/:id) with self-deletion prevention and confirmation dialog. Backend enforces admin-only access via requireRole(['admin']) middleware on user management endpoints.
- **Admin Credentials**: Email: flavio@bebahonest.com.br, Password: M@riafe1 (user ID: admin-flavio).

## UI/UX Decisions
- **Branding**: "Sistema Integra" branding with a sustainability leaf favicon.
- **Responsive Design**: Mobile-first approach with responsive navigation (hamburger menu on mobile, sidebar on desktop).

## Technical Implementations
- **Email/Password Authentication**: Secure email and password authentication with bcrypt hashing.
- **Check-in with Photo**: Mobile-friendly check-in with camera photo capture, geolocation, and distance calculation (Haversine formula). Photos stored as base64.
- **Date Handling**: Consistent date parsing using ISO UTC format to prevent timezone issues.
- **User Roles Expansion**: Expanded role capabilities and dedicated mobile navigation for 'vendedor' role.
- **Customer Validation**: Prevention of duplicate CPF/CNPJ during customer creation/update.
- **Sales Cards Search**: Search functionality for sales cards by customer name or CNPJ.
- **Boleto Payment Terms**: Conditional payment term selection for "Boleto" payment method, triggering blocking alerts for terms > 7 days.
- **Bulk Sales Cards Import**: Mass creation of sales cards via Excel/CSV upload with automatic customer registration via Receita Federal API and next visit date calculation.
- **Omie ERP Integration**: Synchronization of clients, vendors, products, and overdue debts. Protected fields (coordinates, weekdays, periodicity) are preserved during sync. Sales order export preserves critical sales data including vendor lookup, real product mapping, and payment method. Vendor resolution: getVendorByEmail function for email-based lookup, with fallback to client recomendacoes.codigo_vendedor when sellerId is invalid or missing. Invalid sellerId format (starting with 'omie-vendor-') is automatically detected and bypassed. Vendor code correctly sent via informacoes_adicionais.codVend per Omie API specification. Product mapping: Products table includes omieCodigo (alphanumeric code like "PRD00003" - varchar) and omieCodigoProduto (numeric ID like "2425693571" - varchar to support large IDs) fields. Product sync imports only ACTIVE products (inativo != 'S' AND bloqueado != 'S' AND valor_unitario > 0) and saves both codigo and codigo_produto from Omie. Sales orders use real product codes (omieCodigoProduto) when all items have codes; otherwise consolidates to generic product CRM-SALE (ID: 4285815731). ProductModal allows manual entry of Omie codes for custom mapping. Sync button available on Products page for direct synchronization. **OmieSyncManager Interface**: Tab-based dialog with persistent data display. Each tab (Clients, Vendors, Products, Debts, Visits) fetches data from database-backed endpoints (/api/customers, /api/users, /api/products, /api/omie/overdue-debts/cached, /api/visits/all) with tab-independent queries ensuring data persists across tab changes via TanStack Query caching. Overdue debts use cached endpoint with 30-minute stale window. Sync operations save to database (POST endpoints) while GET endpoints retrieve saved data. SyncResult shows immediate sync outcome; persistent statistics cards display current database state. Tab switching clears transient syncResult to prevent cross-tab data leakage. **Visits Tab**: Displays comprehensive visit history with check-in data from sales_cards table. Shows customer name, seller name, visit date, check-in/check-out times, visit duration (calculated), distance from check-in to customer location, and check-in photos (base64) with modal viewer. Role-based access: vendedores see only their visits, admins see all visits.
- **Weekday-Based Route System**: Customers assigned to specific weekdays for visits; supports up to 2 days per week.
- **Financial Tracking**: Overdue debt monitoring and credit analysis. **Automated hourly synchronization**: Complete synchronization (Clients + Billings + Overdue Debts) runs automatically every hour from 6am to 11pm (Brazil time). Overdue debts use correct filters: `data_previsao < today`, `valor_a_receber > 0`, and `status_titulo NOT IN ('RECEBIDO', 'CANCELADO', 'RECEBIMENTO CONFIRMADO')`. Debts are persisted in `overdue_debts` table for efficient order blocking without real-time API calls. **Contas a Receber Tab**: New comprehensive accounts receivable view that loads all títulos in a single API call and performs frontend filtering for maximum performance. Filters are applied in frontend for instant search/filter without API calls. Features include search by client/document, status filtering (all/vencidos/a_vencer), real-time statistics, and Excel export functionality.
- **Delivery Integration**: Real-time delivery tracking with App Entregas Honest, including webhook support for status updates.
- **Billing Synchronization**: Accurate invoice synchronization with status mapping and validation filters.
- **Billing Filters & Stats**: Seller-based filtering with reactive statistics.
- **Blocked Orders Management**: Automatic blocking system for orders requiring administrative approval. Orders are blocked in two scenarios: (1) Boleto payment terms exceeding 7 days, or (2) Clients with overdue debts registered in the system. Blocks require release by admin/coordinator/administrative users. Released orders are automatically sent to Omie ERP. Blocked orders management page at /blocked-orders shows order details, block reasons, and provides release functionality with proper authorization controls.
- **Daily Route Optimization**: Intelligent route planning system for sellers with automatic generation. Routes are automatically generated daily at 05:00h (Brazil time) by scheduled task for all sellers with configured home coordinates. Features include: Advanced two-phase optimization (Nearest Neighbor + 2-opt algorithm) providing near-optimal routes with typically 10-20% reduction in total distance compared to simple ordering, starting and ending at seller's home location; automatic visit sequencing based purely on geographical proximity (no priority weighting); visual route mapping using Leaflet with status-based markers; **real-time distance tracking using actual motorcycle routes via OSRM API** (distances calculated based on road networks, not straight lines); automatic checkpoint registration during check-in/check-out with real distance calculations; progress monitoring (visits completed, distances traveled); and geospatial visualization with polyline route display. **Distance Calculation**: System uses OSRM (Open Source Routing Machine) to calculate real motorcycle/car distances on road networks. Haversine formula (straight-line) is used only as fallback if OSRM API fails. Route optimization uses Haversine for speed during path finding, then calculates final real distances via OSRM. Checkpoint distances (check-in/check-out) always use OSRM for accuracy. System requires sellers to have configured home coordinates (homeLatitude/homeLongitude). Routes are stored in `daily_routes` table with checkpoints in `route_checkpoints` table. Route visualization accessible via "Minha Rota do Dia" menu for vendedor role. **Admin Route Monitoring**: Admin users (admin, coordinator, administrative roles) can view and monitor routes for any seller via seller selector dropdown. Admin view shows seller name, route statistics, map visualization, and execution details (planned vs actual distances, check-in/check-out status) for the selected seller. Sellers only view and follow their own routes - no manual generation needed. **Route Performance Metrics**: Comprehensive metrics dashboard displays route execution statistics including completion rates, distances traveled (total and daily averages), and work day counts. Admin dashboard (AdminRouteMetrics component) shows aggregated metrics for all sellers with month navigation, individual seller performance cards with progress indicators, and summary statistics. Sellers view their own metrics (RouteMetricsCard component) showing completion percentage, work days, distances, and recent route history. Metrics are calculated by routeMetricsService from daily_routes and route_checkpoints tables. API endpoints: /api/route-metrics/monthly/:sellerId/:year/:month for monthly stats, /api/route-metrics/recent/:sellerId for recent routes, and /api/route-metrics/admin-dashboard/:year/:month for admin aggregated view. Dashboard integration provides role-based metric visibility with visual progress bars and performance badges.

# External Dependencies

## Database
- **Neon PostgreSQL**: Serverless PostgreSQL.
- **Drizzle ORM**: Type-safe ORM.

## Authentication
- **Replit Authentication**: OpenID Connect provider.
- **Passport.js**: Authentication middleware.

## UI Components
- **Radix UI**: Headless UI components.
- **Lucide React**: Icon library.
- **Tailwind CSS**: Utility-first CSS framework.
- **Leaflet**: Interactive mapping library for route visualization (react-leaflet v4.2.1).

## Development Tools
- **Vite**: Build tool.
- **TypeScript**: Language.
- **ESBuild**: JavaScript bundler.

## Third-Party Services
- **WhatsApp Business API**: Customer communication (configured).
- **Receita Federal API**: Used for automatic customer registration during bulk import.
- **Omie ERP**: Enterprise Resource Planning system for data synchronization.
- **App Entregas Honest**: Delivery service integration.
- **Replit Infrastructure**: Hosting and development environment.