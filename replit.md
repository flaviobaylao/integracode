# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos, aiming to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. It supports various user roles with fine-grained access control, offering robust sales tracking, reporting, and route optimization to enhance business efficiency, improve customer service, and expand market reach.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, and React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, and TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing). Includes user management and default admin auto-initialization.
- **Data Handling**: ISO UTC for dates, CPF/CNPJ validation, bulk data imports (customers, sales cards) with Excel/CSV. Customer displays prioritize `fantasy_name` over `company_name`.
- **Import Diagnostics**: Debug system for Excel/CSV imports showing column detection, coordinate parsing, data type validation, and update tracking.
- **Sales & Financial Management**: Sales card tracking, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view with export. Automatic order blocking based on payment terms/debts, with release functionality.
- **Delivery & Route Optimization**:
    - **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm with OSRM API. Features visual mapping, checkpoint registration, performance dashboards, and manual generation. Handles route regeneration intelligently by preserving completed/in-progress visits and optimizing only new pending ones.
    - **Multi-Vehicle Route Planning (VRP)**: 4-phase algorithm for vehicle assignment, route optimization (NN+2-opt+OSRM), and persistence. Supports manual order selection, vehicle configuration, and results display with ETAs. Integrates with Omie billings.
    - **Distance Formatting**: Consistent display of distances (meters < 1km, kilometers >= 1km). Backend converts kilometers to meters for frontend display.
    - **Route Optimization Fallback**: Optimizes routes using `visitAgenda` or, if empty, falls back to `sales_cards` filtered for physical visits with valid coordinates.
    - **Manual Check-out System**: Check-out button remains enabled even after check-out, allowing multiple check-outs during a visit. Cards remain in 'in_progress' status after check-out. Cards only finalize when: (a) sale completed ("EFETUAR VENDA"), (b) not-sale registered ("Não Venda"), or (c) auto-failed (two days after scheduled date). Auto-checkout removed to give vendors full control.
    - **Check-in/Check-out Architecture**: Supports both `visitAgenda` and `sales_cards` flows for check-in/check-out. `daily_routes` store `sales_card IDs`. All check-in/check-out events register checkpoints in `route_checkpoints` to track actual distance and completed visits. Timestamps, coordinates, and distance data are synchronized across relevant tables.
    - **Cache Synchronization (Fixed Oct 2025)**: All mutations (check-in, check-out, send-to-Omie, toggle service type) now properly invalidate both `['/api/sales-cards']` and `['/api/sales-cards/by-day']` queries with `exact: false` to ensure UI state updates immediately after operations. SalesSchedule page includes useEffect to auto-update selectedCard when query data changes, ensuring modal displays fresh data after check-in/check-out.
    - **Checkpoint Distance Tracking**: Displays distance between checkpoint location (check-in/check-out) and registered customer location using Haversine formula, helping identify location discrepancies.
    - **Check-in Audit System**: Complete audit trail of all check-ins from both `sales_cards` and `visit_agenda` with verification of checkpoint registration, route association, and data integrity. Accessible at `/check-in-audit` for both vendors and administrators.
    - **Fantasy Name Display Priority**: `fantasy_name` is consistently displayed as the primary customer identifier across all interfaces.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links directly on mobile or in a new tab on desktop.
- **Automated Agenda Management**: Scheduled daily (midnight UTC-3) and on-demand synchronization of sales cards for the next two months, calculating correct visit dates, managing cards, and providing statistics.
- **Sales Card Configuration Replication**: Automatically propagates configuration changes to all future pending sales cards of a customer.
- **Sales Schedule Filtering**: Client-side search filter on Sales Schedule page (`/sales-schedule`) allows real-time filtering by customer fantasy name or company name with results counter display.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, and invoices. Features product mapping, vendor resolution, filtering, stage extraction, and automatic filtering of cancelled invoices.
    - **Automatic Customer Registration**: New customers created in Integra with CPF/CNPJ are automatically registered in Omie ERP, updating Integra with the `omieClientCode`.
    - **Vendor Assignment**: Correctly extracts and includes vendor codes from `sellerId` in `cabecalho.codigo_vendedor` when sending orders to Omie.
- **Sync Status Tracking**: Tracks and displays last synchronization date/time for major sync operations via a `sync_status` table, with a dedicated display component.
- **Sales Goals Dashboard**: Displays individual seller metrics using aggregated SQL queries.
- **HR Management (RH)**: HR tracking system for seller performance, accessible at `/rh`.
    - **Monthly Mileage Tracking**: Aggregates daily route distances per seller.
    - **Work Hours Management**: Calculates daily work hours, deducting lunch, and compares against expected hours.
    - **Access Control**: Restricted to admin, coordinator, and administrative roles.
- **E-commerce Platform (Hotsite Instagram)**:
    - **Public API Routes**: Separate public endpoints for external sales channels (`/api/public/products`, `/api/public/orders`, `/api/public/customers/check`).
    - **Hotsite Structure**: Standalone React SPA in `/hotsite` folder with own package.json, mobile-first design optimized for Instagram traffic.
    - **Intelligent Pricing**: Automatic customer type detection (retail vs wholesale) with automatic upgrade to wholesale pricing when cart exceeds R$200 (10% discount).
    - **Customer Recognition**: Automatic customer verification during checkout with auto-fill of returning customer data.
    - **Security**: Server-side price validation, stock verification, and total recalculation to prevent client-side manipulation.
    - **Integration**: Orders created via hotsite are automatically registered in Sistema Integra as sales_cards with `source: 'hotsite'` marker.
    - **Payment Methods**: Supports Pix, Credit/Debit Card, and Boleto (payment processing integration pending).

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
- **Leaflet**

## Third-Party Services
- **WhatsApp Business API**
- **Receita Federal API**
- **Omie ERP**
- **App Entregas Honest**
- **OSRM API**