# Overview

"Sistema Integra" is a Customer Relationship Management (CRM) system designed for Honest Sucos, a Brazilian juice company. Its core purpose is to optimize sales management through features like customer relationship management, product catalog administration, sales card tracking, and integrated WhatsApp communication. The system supports various user roles with role-based access control and offers extensive sales tracking and reporting to improve business operations and expand market reach.

# User Preferences

Preferred communication style: Simple, everyday language.

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
- **Omie ERP Integration**: Synchronizes clients, vendors, products, overdue debts, and orders. Includes product mapping, vendor resolution, and automated hourly synchronization (Clients, Billings, Overdue Debts). OmieSyncManager provides a tab-based interface for managing synchronization. **Sync Filters**: Only ACTIVE records are synchronized - vendors and products with `inativo === 'S'` are automatically skipped during sync. Products are also filtered for blocked status and valid pricing.
- **Financial Tracking**: Overdue debt monitoring, credit analysis, and comprehensive "Contas a Receber" view with frontend filtering and Excel export.
- **Blocked Orders Management**: Automatic blocking for orders with Boleto terms > 7 days or overdue debts. Admin/coordinator/administrative roles can release blocked orders.
- **Delivery Integration**: Real-time tracking with App Entregas Honest via webhooks.
- **Daily Route Optimization**: Scheduled daily route generation for sellers using Nearest Neighbor + 2-opt algorithm for near-optimal routes. Uses OSRM API for real motorcycle route distances. Includes visual mapping (Leaflet), checkpoint registration, and performance metrics dashboards for both sellers and admins. Supports exclusive vehicle delivery configuration on sales cards.
- **Enhanced Delivery Management**: Delivery Management page with order selection, urgent delivery marking, and clear display of delivery time slots and exclusive vehicle configurations.

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