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
- **WhatsApp Chat Center**: Complete customer service platform with 8 backend endpoints for conversations, messages, templates, and analytics.
- **Order Synchronization**: Correct synchronization of pending deliveries by querying Omie ERP data.
- **Delivery Configuration Validation**: Ensures customer registration before allowing configuration edits for pending orders.

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

# Recent Changes (2025-11-26)

## WhatsApp Chat Integration - Critical Fixes & Webhook Ready
- **Completed**: 
  - ✅ **Fixed database schema**: Added missing `user_id` column to `chat_agents` table (was causing HTTP 500 errors)
  - ✅ **Fixed webhook double-response error**: Refactored webhook handler to respond immediately (200 OK) then process async in background
  - ✅ **Added webhook test endpoint**: GET `/api/chat/webhook/test` for browser testing (in addition to existing POST)
  - ✅ **Webhook verified working**: Test messages successfully created conversations and saved messages to database
  - ✅ **Simplified `/api/chat/conversations` endpoint**: Added robust error handling to prevent HTTP 500 when fetching agents/customers
  - ✅ All WhatsApp action buttons now create conversations in Integra instead of opening external wa.me
  - ✅ Created `syncChatHistory()` method in storage for database persistence
  - ✅ Added sync endpoints with debug capabilities
  
- **System Status**:
  - 🟢 **WEBHOOK OPERATIONAL**: Accepting and processing incoming messages from Evolution API
  - 🟢 **TEST ENDPOINT ACTIVE**: Available at `https://integrahonest.replit.app/api/chat/webhook/test`
  - 🟢 **DATABASE PERSISTENCE**: All messages permanently saved with phone number association
  - 🟡 **AWAITING**: Real messages from Evolution API (webhook infrastructure ready)
  
- **Next Steps**:
  - Verify Evolution API is sending real incoming messages to webhook
  - Monitor webhook logs for incoming messages from customers
  - Once incoming messages flow in, system will automatically save and display in chat center
