# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. It aims to optimize business operations by integrating customer relationship management, product catalog administration, sales tracking, and WhatsApp communication. The system enhances efficiency, improves customer service, expands market reach, and increases sales through features like robust sales tracking, advanced route optimization, fine-grained access control, an integrated e-commerce platform ("Hotsite Instagram"), and real-time billing data synchronization with Omie ERP for customer "positivation" status.

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
- **Hotsite Design**: Premium landing page inspired by Solti.com, featuring a hero section, badges, ingredient showcase, product showcase, benefits, and an enhanced footer with a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing, motorista) restricting access based on user roles.
- **WhatsApp Integration**: Evolution API (CHAT_HONEST instance) with webhook support for receiving messages, message sending, and real-time conversation tracking.
- **WhatsApp Chat Center**: Complete conversational system at `/telemarketing/atendimento` with:
  - Real-time conversation management with agent assignment
  - Message read/unread tracking with visual indicators
  - Automatic conversation creation from sales modals (SaleModal, SaleEditModal, CustomerDetailsModal, CustomerManagement)
  - Quick template insertion for fast responses
  - Status tracking (new → assigned → in-progress → resolved)
  - **Chat History Synchronization** (NEW - 2025-11-25): Two-stage implementation:
    - **Stage 1 - Conversation Sync** (`POST /api/chat/sync-conversations-only`): Creates conversation entries for all 1000+ WhatsApp contacts, accessible immediately for new messages
    - **Stage 2 - Historical Message Import** (in progress): Via `POST /api/chat/sync-history` - attempts to fetch and import historical messages from Evolution API using `fetchChatHistory()` method
    - **Debug Endpoint** (`GET /api/chat/debug-history/:phone`): Tests single contact history retrieval for troubleshooting
    - Current status: Conversation creation working at 100%, historical message retrieval requires API response format verification
- **Central de Atendimento**: Real-time chat interface at `/telemarketing/atendimento` with conversation management, agent assignment, status tracking, and quick template insertion.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), and robust weekday normalization for visit schedules.
- **Sales & Financial Management**: Sales card tracking, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard.
- **Delivery & Route Optimization**:
    - **Route Generation**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API, supporting both customers and leads.
    - **Regional Sectorization (NEW - 2025-11-25)**: Production-ready intelligent route distribution system featuring:
      - **Geographic Clustering**: K-means algorithm with Haversine distance for geographic coordinates
      - **Smart Constraints**: Exclusive vehicle pre-assignment, multi-type vehicle compatibility, automatic cluster splitting for incompatible requirements
      - **Validation Layers**: Pre-assignment validation, post-assignment compatibility checks, final delivery count verification
      - **Fail-Fast Design**: Explicit errors with actionable diagnostics when requirements cannot be met, preventing silent delivery loss
      - **CLI Testing Tool**: `server/scripts/generateSectorizedRoutes.ts` for validation and testing
      - **Service File**: `server/regionalRouteOptimizationService.ts` - Main algorithm implementation
      - **Driver Coordinates**: Required `home_latitude` and `home_longitude` in `delivery_drivers` table for route planning
    - **Features**: Visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, check-in/check-out, checkpoint distance tracking, and automatic check-out.
    - **Driver Interface**: "Rota do Dia" page with auto-refreshing visualization, metrics, interactive map, photo markers, and smart visit lists with inline check-in/check-out and location validation. Simplified mobile-friendly app (`/rota-entrega`) for drivers with restricted access, date filtering, delivery lists, summary statistics, GPS check-in/check-out with mandatory photo capture, and Waze navigation.
    - **Route Management**: Administrative users can manually add, delete, and optimize visits. Supports creation of empty routes for manual population.
    - **Delivery Status**: Four levels: PENDENTE, EFETUADA, EM PAUSA, DEVOLVIDA, with visual badges.
    - **Delivery History**: Comprehensive tracking with API endpoint for registering completed deliveries and automatic duration calculation.
    - **Scheduling**: Hourly time slots, persistent delivery configurations in customer profiles, and synchronized across locations.
    - **Data Enrichment**: Complete data enrichment for pending delivery orders, including CPF/CNPJ, invoice dates, coordinates, address, receiving weekdays, time slots, vehicle requirements, and average delivery time.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering, inactivation, and detailed delivery configuration displays. Implements a three-layer date system for visit days, calculated delivery days, and manually configured receiving weekdays.
- **Mapa de Clientes**: Interactive Leaflet map (`/mapa-clientes`) displaying active customers with color-coded pins based on visit day, featuring clickable pins with popups, filtering, and in-map customer editing for administrative users.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Order blocking system. Hotsite orders are sent to Omie ERP with automatic customer creation and robust validation. Supports specific Omie invoice stages for delivery workflow.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **System Administration**: Admin-only page (`/admin/system`) with data maintenance tools, including delivery days recalculation utility with dry-run mode.
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection, recognition/registration, 5-tier dynamic pricing, server-side security, automatic order registration as `sales_cards`, product gallery, stock management, and differentiated payment methods.
- **Leads Management**: Integrated lead tracking with route optimization, access control, mandatory photo enforcement for check-in/check-out, and updates within daily routes.
- **Automatic Data Backup (NEW - 2025-11-26)**: Complete backup system protecting all order data:
  - **Automatic Backup Scheduler**: Executes daily at 2h UTC + on server startup via node-cron
  - **Database Table**: `orders_backup` stores historical snapshots of all sales_cards and blocked_orders
  - **Service File**: `server/backup-service.ts` handles backup operations and data retrieval
  - **API Endpoints**: 
    - `GET /api/admin/backups?startDate=&endDate=` - Retrieve backups by date range
    - `GET /api/admin/backups/blocked-orders` - View backed-up blocked orders
    - `POST /api/admin/backups/run` - Trigger manual backup on demand
  - **Purpose**: Prevents data loss from accidental deletion, provides recovery mechanism for historical order data
- **Order Release Workflow (UPDATED - 2025-11-26)**: 
  - ✅ **Removed payment term blocking**: Orders with boleto prazo > 7 dias can now be released without restrictions
  - Admins can approve and release any blocked order regardless of payment terms
  - Full Omie integration for order creation and synchronization

# External Dependencies

- **Neon PostgreSQL**
- **Drizzle ORM**
- **Replit Authentication**
- **Passport.js**
- **Radix UI**
- **Lucide React**
- **Tailwind CSS**
- **Leaflet**
- **WhatsApp Business API** (Evolution API)
- **Receita Federal API**
- **Omie ERP**
- **OSRM API**
- **node-cron** - For scheduled backup tasks

# Recent Changes (2025-11-26)

## Backup System & Order Release - Complete Implementation
- **Completed**: 
  - ✅ **Automatic Backup System**: Implemented node-cron scheduler that runs daily at 2h UTC + on server startup
  - ✅ **Database Table**: Created `orders_backup` table for storing historical snapshots of sales_cards and blocked_orders
  - ✅ **Backup Service**: Built `server/backup-service.ts` with functions to backup all orders, retrieve backups by date range, and access blocked order history
  - ✅ **API Endpoints**: 
    - `GET /api/admin/backups?startDate=2025-11-26&endDate=2025-11-27` - List backups
    - `GET /api/admin/backups/blocked-orders` - View blocked order backups
    - `POST /api/admin/backups/run` - Trigger manual backup
  - ✅ **Fixed Payment Term Blocking**: Removed restriction preventing orders with boleto prazo > 7 dias from being released
  - ✅ **Order Release Ready**: Admins can now release ANY blocked order, including those with extended payment terms
  - ✅ **Fixed Import Errors**: Corrected Drizzle operator imports (eq, and, gte) from 'drizzle-orm'
  
- **System Status**:
  - 🟢 **BACKUP SYSTEM ACTIVE**: Daily automatic backups scheduled + manual backup endpoint available
  - 🟢 **ORDER RELEASE OPERATIONAL**: Payment term blocking removed - full order release workflow active
  - 🟢 **DATABASE PERSISTENCE**: All backup data stored permanently with timestamps
  - 🟢 **APP RUNNING**: All systems operational on port 5000
  
- **Key Benefits**:
  - Automatic daily backups prevent data loss
  - Historical order data preserved for audit and recovery
  - Admins have full flexibility to release blocked orders
  - Manual backup trigger available for immediate backups on demand

