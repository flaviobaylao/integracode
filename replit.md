# Overview

"Sistema Integra" is a comprehensive CRM and sales management system designed for Honest Sucos, a Brazilian juice company. Its core purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system supports various user roles with fine-grained access control and offers robust sales tracking, reporting, and route optimization features to enhance business efficiency, improve customer service, and expand market reach.

## Version Control

**Current Version**: 1.5.0 (Versão Estável)

The system uses semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes or major structural updates
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes and minor improvements

Version information is displayed in the sidebar footer and can be accessed via `/api/version` endpoint.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI components, shadcn/ui, and Tailwind CSS for a modern and responsive user interface.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, and React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, and TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Supports Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing). Includes user management and auto-initialization for a default admin user.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports (customers, sales cards) with Excel/CSV.
- **Import Diagnostics**: Comprehensive debug system for Excel/CSV imports showing column detection, coordinate parsing, data type validation, and update success/failure tracking. Visual debug panel for customer imports and console logging for sales card imports.
- **Sales & Financial Management**: Sales card tracking, conditional payment terms, overdue debt monitoring, credit analysis, and "Contas a Receber" view with export capabilities. Automatic blocking of orders based on payment terms or overdue debts, with release functionality for authorized roles.
- **Delivery & Route Optimization**:
    - **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API for real motorcycle route distances. Includes visual mapping, checkpoint registration, performance dashboards, and manual route generation. Tracks actual distances based on check-ins and manages off-route visits.
    - **Route Regeneration**: The `/api/daily-routes/generate` endpoint intelligently handles route updates when sales_cards change (e.g., recreated with new IDs from Omie sync). Preserves in-flight route data by: (1) Identifying 3 visit states (completed with checkout, in-progress with checkin only, truly pending), (2) Keeping completed and in-progress visits in original sequence, (3) Optimizing only new pending visits, (4) Updating route via `storage.updateDailyRoute()` to preserve existing checkpoints, (5) Maintaining routeStatus (in_progress/paused/etc) and ensuring consistent visit counts (completedVisits <= totalVisits). Frontend displays "Rota atualizada com sucesso!" for regenerations vs "Rota gerada com sucesso!" for new routes.
    - **Multi-Vehicle Route Planning (VRP)**: Advanced delivery route optimization with a 4-phase algorithm for vehicle assignment, route optimization (NN+2-opt+OSRM), and persistence. Supports manual order selection, vehicle configuration, and results display with ETAs. Integrated with Omie billings for delivery management, using intelligent customer matching and supporting urgent deliveries and exclusive vehicle configurations.
    - **Distance Formatting**: All route-related components (DailyRoutesOverview, DailyRouteView, VisitRoutes) use consistent formatDistance function: displays meters (e.g., "250m", "850m") for distances < 1km, and kilometers (e.g., "1.2km", "15.5km") for distances >= 1km, improving readability across all route displays.
    - **Distance Unit Conversion**: The `/api/daily-routes/:sellerId/date/:date` endpoint converts distances from kilometers (returned by calculateDistance in routeOptimizationService) to meters before sending to frontend. This ensures proper display formatting, as frontend expects meter values (< 1000 shows as meters, >= 1000 converts to km).
    - **Route Optimization Fallback**: The `/api/visit-agenda/optimize-route` endpoint implements an intelligent fallback mechanism: (1) First attempts to load visits from `visitAgenda` table, (2) If no visitAgenda entries exist, falls back to `sales_cards` joined with `customers`, (3) Filters for presencial visits only (isVirtual=false) with comprehensive coordinate validation (non-null, non-NaN, non-zero), (4) Converts validated sales_cards to compatible visit format for optimization. This enables route optimization even when visitAgenda has not been manually generated, bridging the gap between auto-generated sales_cards and route planning workflow.
- **Automated Agenda Management**:
    - **Automatic Synchronization (Midnight)**: Scheduled daily task at 00:00h (UTC-3) performs comprehensive synchronization of sales cards for the next 2 months to ensure continuous agenda accuracy.
    - **Manual Synchronization**: "Sincronizar Agenda" button (admin/coordinator/administrative roles) performs on-demand synchronization.
    - **Synchronization Process**: Calculates correct visit dates based on customer configuration, deletes incorrectly scheduled cards, creates missing cards, and returns detailed statistics. Uses `onConflictDoNothing()` for duplicate prevention.
- **Sales Card Configuration Replication**: Automatically propagates configuration changes (e.g., routeDay, paymentMethod, deliveryTimeSlots) to all future pending sales cards of a customer.
- **Omie ERP Integration**: Synchronizes clients, vendors, products, overdue debts, and invoices hourly. Includes product mapping, vendor resolution, specific filters, stage extraction, fallback mechanisms, and automatic filtering of cancelled invoices. Customer table stores `omieClientCode` for bidirectional synchronization.
    - **Cancelled Invoice Filtering**: The `syncBillings()` method automatically excludes cancelled invoices using two verification methods: (1) checking the `cancelled` flag from `fetchPedidoStage()` for order-related invoices, and (2) checking the direct `cancelamento.cCancelado === 'S'` field from the invoice data. This ensures only active invoices are imported into the system.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time for major sync operations (Omie clients, vendors, products, billings) via a `sync_status` table, with a `SyncStatusDisplay` component, auto-refresh, and cache invalidation.
- **Sales Goals Dashboard**: Displays individual seller metrics using raw SQL queries for complex aggregations.

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
- **OSRM API**