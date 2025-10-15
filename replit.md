# Overview

"Sistema Integra" is a Customer Relationship Management (CRM) system designed for Honest Sucos, a Brazilian juice company. Its core purpose is to optimize sales management through features like customer relationship management, product catalog administration, sales card tracking, and integrated WhatsApp communication. The system supports various user roles with role-based access control and offers extensive sales tracking and reporting to improve business operations and expand market reach.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## Frontend
- **Framework**: React with TypeScript (Vite).
- **UI**: Radix UI components with shadcn/ui and Tailwind CSS.
- **Routing**: Wouter.
- **State Management**: TanStack Query.
- **Form Handling**: React Hook Form with Zod.

## Backend
- **Runtime**: Node.js with Express.js (TypeScript).
- **Authentication**: Email/Password and Replit Auth (Passport.js for OIDC).
- **Session Management**: Express sessions with PostgreSQL store.
- **Database**: PostgreSQL with Drizzle ORM.
- **API**: RESTful with role-based access control.

## Database Schema
- **Entities**: Users (role-based), Customers, Products, Sales Cards, Message Templates, Message History, Delivery Management, Sessions.

## Authentication & Authorization
- **Providers**: Replit OpenID Connect and internal email/password.
- **Authorization**: Role-based (admin, coordinator, administrative, vendedor, telemarketing).
- **User Management**: Admin-only interface for creating, managing, and deleting users with role and route assignments.
- **Auto-Initialization**: System automatically creates default admin user (flavio@bebahonest.com.br / M@riafe1) on first startup if no admin exists. Manual setup endpoint also available at POST /api/setup-admin.

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.

## Technical Implementations
- **Check-in with Photo**: Mobile check-in with photo capture, geolocation, and distance calculation (Haversine).
- **Date Handling**: ISO UTC format for consistency.
- **Customer Validation**: Prevents duplicate CPF/CNPJ.
- **Sales Cards**: Search by customer/CNPJ, conditional payment terms for "Boleto", bulk import from Excel/CSV with Receita Federal API integration.
- **Customer Excel Import**: Bulk update customer data via Excel import using CPF/CNPJ as key. Supports: GPS coordinates (latitude/longitude with comma decimal separator), visit schedule (ROTA/weekdays), visit frequency (FREQUENCIA/periodicidade: semanal, quinzenal, mensal, bimestral), and service start date (DATA DE INICIO in DD/MM/YYYY format). Automatically converts weekdays to JSON array format and handles multiple date formats including Excel serial dates.
- **Omie ERP Integration**: Synchronizes clients, vendors, products, overdue debts, and invoices. Includes product mapping, vendor resolution, and automated hourly synchronization (Clients, Billings, Overdue Debts). OmieSyncManager provides a tab-based interface for managing synchronization. **Sync Filters**: Only ACTIVE records are synchronized - vendors and products with `inativo === 'S'` are automatically skipped during sync. Products are also filtered for blocked status and valid pricing. **Invoice Date Filter**: `syncBillings()` method filters invoices by emission date (dEmi ≥ 01/09/2025) to synchronize only invoices from September 2025 onwards. Uses descending order (newest first) with code-level filtering since Omie API ignores date filter parameters. Scheduler uses `syncBillings()` instead of `syncAllOrders()` for efficient invoice-only synchronization. **Stage Extraction**: Extracts order stage (Aguardando Rota, Entregue, Faturado) from related pedido using nIdPedido from invoice.compl. **Stage Fallback**: When order stages list is empty, system uses header stage as fallback to ensure correct stage mapping.
- **Financial Tracking**: Overdue debt monitoring, credit analysis, and comprehensive "Contas a Receber" view with frontend filtering and Excel export.
- **Blocked Orders Management**: Automatic blocking for orders with Boleto terms > 7 days or overdue debts. Admin/coordinator/administrative roles can release blocked orders.
- **Delivery Integration**: Real-time tracking with App Entregas Honest via webhooks.
- **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm for near-optimal routes. Uses OSRM API for real motorcycle route distances. Includes visual mapping (Leaflet), checkpoint registration, and performance metrics dashboards for both sellers and admins. Supports exclusive vehicle delivery configuration on sales cards.
- **Multi-Vehicle Route Planning (VRP)**: Advanced delivery route optimization system with 4-phase algorithm: (1) preprocessing with coordinate validation, (2) greedy vehicle assignment prioritizing urgent orders, (3) per-vehicle route optimization using NN+2-opt+OSRM, (4) persistence to delivery_routes/delivery_route_stops tables. Includes manual order selection, vehicle configuration (type, capacity, start point, time windows), and results display with ETAs and statistics. Validates coordinates and filters invalid orders with warnings.
- **Enhanced Delivery Management**: Delivery Management page with order selection, urgent delivery marking, vehicle configuration modal, manual order refresh button, and clear display of delivery time slots and exclusive vehicle configurations. Supports multi-vehicle route planning with real-time optimization.

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
- **Leaflet** (react-leaflet v4.2.1)

## Third-Party Services
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **App Entregas Honest**