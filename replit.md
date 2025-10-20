# Overview

"Sistema Integra" is a CRM system for Honest Sucos, a Brazilian juice company. Its main purpose is to optimize sales management by providing features for customer relationship management, product catalog administration, sales card tracking, and integrated WhatsApp communication. The system supports various user roles with role-based access control and offers extensive sales tracking and reporting capabilities to improve business operations and expand market reach.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# Recent Changes (October 20, 2025)

## Agenda de Vendas - New Features
- **Seller Filter**: Added dropdown filter to view sales cards by specific seller or all sellers (visible only for admin/coordinator/administrative roles). Fixed to properly display seller names (firstName + lastName) with fallback to email
- **Fantasy Name Display**: Sales cards now prominently display the fantasy name (nome fantasia) as the main title, with company name (razão social) shown as a subtitle when both exist
- **Excel Export**: Implemented comprehensive export functionality that exports ALL filtered sales cards (not just current page) to Excel with complete customer and sales information including: Data Agendada, Cliente, Razão Social, Telefone, Endereço, Cidade, Estado, Vendedor, Status, Tipo de Recorrência, Dias da Semana, Valor da Venda, and Atendimento type
- **Seller Name in Cards**: Sales cards now display the seller's full name (firstName + lastName) with User icon, with fallback to email if name is unavailable
- **Geographic Coordinates**: Cards display customer's latitude and longitude when available, formatted with 6 decimal places and shown with MapPin icon in blue. Fixed API to include these fields in the response (storage.ts getSalesCardsByDayAndDate)
- **CPF/CNPJ Display**: Cards now show customer's CNPJ (priority) or CPF when available
- **Removed Pagination Limit**: Increased from 20 to 1000 records per page in the sales agenda, allowing users to view significantly more sales cards without pagination
- **Inline Customer Edit**: Added pencil icon button next to customer name in each sales card, allowing admin/coordinator/administrative users to edit customer data directly. Opens a modal with all customer fields (name, fantasy name, CPF/CNPJ, contact info, address, coordinates). Changes are saved via PATCH /api/customers/:id endpoint with role-based access control. Cache is automatically invalidated after updates to refresh the display.
- **Customer Inactivation**: Added "Inativar Cliente" button in sales cards (visible only to admin/coordinator/administrative users). Features comprehensive confirmation modal warning about consequences, dual permission layer (UI render check + handler validation + backend validation), automatic deletion of all future pending/in_progress sales cards (except current card), timestamp recording (inactivatedAt field), and proper cache invalidation. Inactive customers are removed from future routes and agendas while preserving historical data. **Note**: Due to Omie API limitations, customer inactivation in Omie ERP must be done manually - the API does not support programmatic inactivation. Users are notified when manual Omie inactivation is required.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI components, shadcn/ui, and Tailwind CSS for a modern and responsive user interface.

## Technical Implementations
- **Frontend**: Built with React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, and React Hook Form with Zod for form handling.
- **Backend**: Implemented with Node.js, Express.js, and TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Supports Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing). Includes user management and auto-initialization for a default admin user.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports (customers, sales cards) with Excel/CSV.
- **Sales & Financial Management**: Sales card tracking, conditional payment terms, overdue debt monitoring, credit analysis, and "Contas a Receber" view with export capabilities.
- **Order Management**: Automatic blocking of orders based on payment terms or overdue debts, with release functionality for authorized roles.
- **Delivery & Route Optimization**:
    - **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API for real motorcycle route distances. Includes visual mapping, checkpoint registration, performance dashboards, and manual route generation. Tracks actual distances based on check-ins and manages off-route visits.
    - **Multi-Vehicle Route Planning (VRP)**: Advanced delivery route optimization with a 4-phase algorithm for vehicle assignment, route optimization (NN+2-opt+OSRM), and persistence. Supports manual order selection, vehicle configuration, and results display with ETAs. Integrated with Omie billings for delivery management, using intelligent customer matching and supporting urgent deliveries and exclusive vehicle configurations.
- **Automated Agenda Management**: 
    - **Automatic Generation**: Scheduled daily maintenance at midnight ensures continuous 2-month future agenda coverage for all clients. Recursive card generation follows customer visit schedules and periodicity. Initial card generation starts ~7 days in the future to allow planning time.
    - **Manual Synchronization**: "Sincronizar Agenda" button in Agenda de Vendas page (accessible to admin/coordinator/administrative roles) performs comprehensive synchronization of sales cards for the next 2 months. The sync process:
      1. Calculates correct visit dates based on each customer's `visitPeriodicity` and `weekdays` configuration
      2. Deletes cards that are scheduled on incorrect dates (don't match the customer's periodicity/weekdays)
      3. Creates missing cards for dates that should exist according to the customer's configuration
      4. Returns detailed statistics (processed customers, cards created, cards deleted, errors)
      5. Uses `onConflictDoNothing()` in Drizzle ORM for duplicate prevention
    - **Legacy Scripts**: For retroactive or near-future dates:
      - `generate-missing-monday-cards.ts`: Created 492 cards for 20/10/2025 (segunda)
      - `generate-missing-tuesday-cards.ts`: Created 487 cards for 21/10/2025 (terça)
      - `generate-missing-weekday-cards.ts`: Created 500 cards for 22/10/2025 (quarta) and 478 cards for 23/10/2025 (quinta)
      - `fix-friday-cards.ts`: Created 457 cards for 24/10/2025 (sexta)
- **Sales Card Configuration Replication**: Automatically propagates configuration changes (e.g., routeDay, paymentMethod, deliveryTimeSlots) to all future pending sales cards of a customer.
- **Omie ERP Integration**: Synchronizes clients, vendors, products, overdue debts, and invoices hourly. Includes product mapping, vendor resolution, and specific filters for active records and invoice dates. Features stage extraction from related orders, fallback mechanisms, and detection of cancelled orders. A dedicated endpoint for filtered billing synchronization is available, along with a batch script for correcting sales card seller assignments. **Customer table includes `omieClientCode` field** to store the Omie client code (`codigo_cliente_omie`) for bidirectional synchronization, enabling operations like customer inactivation to propagate to Omie ERP.
- **Sync Status Tracking**: Comprehensive system to track and display the last synchronization date/time for all major sync operations (Omie clients, vendors, products, billings) via a dedicated `sync_status` table. Features `SyncStatusDisplay` component with three states (loading, empty, data), auto-refresh every 30 seconds, and automatic timestamp recording after sync completion. Integrated in Dashboard below sync button with cache invalidation support.
- **Sales Goals Dashboard**: Individual seller metrics displayed when "All sellers" view is selected. Uses `/api/sales-metrics/multiple` endpoint to fetch metrics for multiple sellers simultaneously. The `getSalesMetrics` function uses raw SQL queries (instead of Drizzle ORM) to avoid compatibility issues with complex aggregations.

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