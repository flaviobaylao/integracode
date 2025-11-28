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
- **WhatsApp Chat Center**: Complete conversational system at `/telemarketing/atendimento` with real-time conversation management, agent assignment, message read/unread tracking, automatic conversation creation from sales modals, quick template insertion, and status tracking (new → assigned → in-progress → resolved). Includes synchronization for conversations and historical messages.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), and **strict abbreviated weekday format (Seg, Ter, Qua, Qui, Sex, Sab, Dom) throughout system** with robust error handling that never breaks on invalid formats.
- **Sales & Financial Management**: Sales card tracking, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and a sales goals dashboard. Sales cards are accessible by sellers based on creation or customer assignment. Order release workflow allows admins to approve any blocked order.
- **Delivery & Route Optimization**:
    - **Route Generation**: Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API, supporting both customers and leads.
    - **Regional Sectorization**: Intelligent route distribution system using K-means clustering with Haversine distance, smart constraints for vehicle assignment, and validation layers.
    - **Features**: Visual mapping, checkpoint registration, performance dashboards, multi-vehicle planning, check-in/check-out, checkpoint distance tracking, and automatic check-out.
    - **Driver Transfer & Route Management**: Functionality to transfer deliveries between drivers and map visualization with stop order numbers.
    - **Driver Interface**: Mobile-friendly app (`/rota-entrega`) for drivers with restricted access, date filtering, delivery lists, summary statistics, GPS check-in/check-out with mandatory photo capture, and Waze navigation.
    - **Route Management**: Administrative users can manually add, delete, and optimize visits, including creation of empty routes.
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
- **Automatic Data Backup**: Complete backup system protecting all order data with daily scheduled backups and manual trigger options. Stores historical snapshots in an `orders_backup` table.

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
- **node-cron**