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
- **Central de Atendimento**: Real-time chat interface at `/telemarketing/atendimento` with conversation management, agent assignment, status tracking, and quick template insertion.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), and robust weekday normalization for visit schedules.
- **Sales & Financial Management**: Sales card tracking, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard.
- **Delivery & Route Optimization**:
    - **Route Generation**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API, supporting both customers and leads.
    - **Regional Sectorization (NEW)**: Intelligent route distribution system that divides deliveries into geographic sectors using K-means clustering algorithm, assigns sectors to vehicles based on constraints (exclusive vehicles, vehicle types, capacity), and optimizes each sector independently to maximize route compactness and minimize inter-vehicle region overlap.
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
- **WhatsApp Chat Center**: Complete customer service platform with:
  - Dashboard at `/telemarketing/conversas` - Shows stats (total conversations, active, response time, resolution rate), charts by day and agent performance, advanced filtering
  - Real-time Chat at `/telemarketing/atendimento` - Live conversation list, message history, agent assignment, status management (New → Assigned → In-progress → Resolved), automatic WhatsApp synchronization
  - Quick Templates at `/telemarketing/templates` - Manage response templates by category (greeting, sales, support, goodbye, general), quick insertion in chat
  - 8 Backend Endpoints:
    - `GET /api/chat/conversations/stats` - Statistics and metrics
    - `GET /api/chat/conversations` - List of all conversations
    - `GET /api/chat/conversations/:id/messages` - Conversation history
    - `GET /api/chat/agents` - Available agents
    - `POST /api/chat/conversations/:id/message` - Send message (auto-syncs to WhatsApp)
    - `PATCH /api/chat/conversations/:id/assign` - Assign to agent
    - `PATCH /api/chat/conversations/:id/status` - Update status
    - `GET/POST/DELETE /api/chat/quick-templates` - Template management
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
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **OSRM API**