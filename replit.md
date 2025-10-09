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
- **User Management**: Comprehensive user management interface with creation, listing, filtering, activation/deactivation, and role editing.

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
- **Omie ERP Integration**: Synchronization of clients, vendors, products, and overdue debts. Protected fields (coordinates, weekdays, periodicity) are preserved during sync. Sales order export preserves critical sales data including vendor lookup, real product mapping, and payment method. Vendor resolution: getVendorByEmail function for email-based lookup, with fallback to client recomendacoes.codigo_vendedor when sellerId is invalid or missing. Invalid sellerId format (starting with 'omie-vendor-') is automatically detected and bypassed. Vendor code correctly sent via informacoes_adicionais.codVend per Omie API specification. Product mapping: Products table includes omieCodigo (alphanumeric code like "PRD00003") and omieCodigoProduto (numeric ID like 2425693571) fields. Product sync imports both codigo and codigo_produto from Omie. Sales orders use real product codes (omieCodigoProduto) when all items have codes; otherwise consolidates to generic product CRM-SALE (ID: 4285815731). ProductModal allows manual entry of Omie codes for custom mapping.
- **Weekday-Based Route System**: Customers assigned to specific weekdays for visits; supports up to 2 days per week.
- **Financial Tracking**: Overdue debt monitoring and credit analysis.
- **Delivery Integration**: Real-time delivery tracking with App Entregas Honest, including webhook support for status updates.
- **Billing Synchronization**: Accurate invoice synchronization with status mapping and validation filters.
- **Billing Filters & Stats**: Seller-based filtering with reactive statistics.

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