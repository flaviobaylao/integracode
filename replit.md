# Overview

This is a Customer Relationship Management (CRM) system for Honest Sucos, a Brazilian juice company. The application provides sales management capabilities including customer management, product catalog, sales card tracking, and WhatsApp integration for communication. It supports multiple user roles (admin, coordinator, administrative, vendedor) with role-based access control and features comprehensive sales tracking and reporting functionality.

# Recent Changes

## October 8, 2025
- **Check-in with Photo Feature**: Implemented mobile-friendly check-in system with camera photo capture, geolocation tracking, and distance calculation
  - Created CheckInModal component with camera access and photo preview
  - Backend route `/api/sales-cards/:id/check-in` now handles multipart/form-data with multer
  - Photos stored in `checkInPhotoUrl` field (base64)
  - Distance automatically calculated using Haversine formula when customer coordinates available
  - Removed legacy JSON-based check-in mutation in favor of photo-based workflow
- **Date Parsing Bug Fix**: Fixed critical date parsing issue in agenda filtering
  - Changed from error-prone `new Date(string)` to explicit ISO UTC format: `new Date('YYYY-MM-DDT00:00:00.000Z')`
  - Resolves "time zone displacement out of range" PostgreSQL errors
  - Ensures consistent date handling across different timezones
- **User Roles Expansion & Mobile Navigation**: Enhanced role-based access control and implemented mobile-first responsive navigation
  - Added 'telemarketing' role to user roles enum (admin, coordinator, administrative, vendedor, telemarketing)
  - Expanded vendedor permissions to access: Faturamentos, Débitos Vencidos, Pedidos Bloqueados, and Sistema de Entregas
  - Implemented mobile-responsive navigation using Sheet component with hamburger menu button
  - Desktop sidebar (w-64) remains visible only on md+ screens with `hidden md:block` utility
  - Mobile menu features user info header and auto-closes on menu item selection
  - Vendedor-specific menu labels: "Meus Cards de Venda", "Minha Carteira", "Minhas Metas", "Meus Faturamentos", "Meus Débitos Vencidos", "Meus Pedidos Bloqueados", "Minhas Entregas"
  - All 9 required vendedor functionalities validated: Dashboard, Agenda, Rota, Clientes, Metas, Faturamentos, Débitos Vencidos, Pedidos Bloqueados, Entregas
- **User Management System**: Created comprehensive user management interface for administrators
  - New POST /api/users endpoint with admin-only access and Zod validation (insertUserSchema)
  - UserManagement component with user creation, listing, filtering by role, and activation/deactivation
  - User creation form with fields: email, firstName, lastName, role (dropdown), and optional route
  - Role-based filtering: filter users by admin, coordinator, administrative, vendedor, or telemarketing
  - User status toggle: activate/deactivate users directly from the table
  - **Role Editing**: Added ability to edit user profiles (admin, vendedor, telemarketing)
    - "Editar Perfil" button in user table opens dialog for role selection
    - PUT /api/users/:id endpoint handles role updates
    - Fixed Select component behavior using controlled value prop for reliable dialog interactions
    - Dedicated UserManagementPage at /admin/users route with admin-only access protection
  - Complete e2e testing validated: create user, filter by role, toggle status, edit role
- **CPF/CNPJ Duplicate Validation**: Implemented validation to prevent duplicate CPF or CNPJ registration
  - POST /api/customers validates CPF/CNPJ uniqueness before creating new customer
  - PUT /api/customers/:id validates CPF/CNPJ uniqueness when updating (ignores current customer's own document)
  - Returns HTTP 409 (Conflict) with detailed error message when duplicate is found
  - Error response includes field name and existing customer information (id, name, cpf/cnpj)
  - Uses existing storage methods: getCustomerByCpf() and getCustomerByCnpj()
- **Sales Cards Search**: Added search functionality to filter sales cards by customer name or CNPJ
  - Search input field with icon and clear button in SalesCards component
  - Filters by customer fantasy name (case-insensitive partial match) OR CNPJ (numeric digits only)
  - CNPJ search removes formatting for flexible matching (accepts "12345678" or "12.345.678/0001-90")
  - Prevents empty query bug: CNPJ comparison only runs when searchQueryClean.length > 0
  - Integrates with existing status and route filters
  - Clear all filters button resets search query along with other filters
  - Complete e2e testing validated: search by name, CNPJ, clear search, no-match behavior
- **Boleto Payment Terms**: Implemented conditional payment term selection for boleto transactions
  - When "Boleto" payment method is selected, a term selector appears with options: 7, 14, 21, 28, 32, and 35 days
  - Orders with boleto terms over 7 days trigger a blocking alert, indicating approval is required
  - Visual alert (yellow banner with AlertTriangle icon) displays "Pedido Bloqueado" message when term > 7 days
  - boletoDays field stored in database (default: 7 days) and persisted when finalizing sales
  - Complete e2e testing validated: term selection, conditional display, alert behavior

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React with TypeScript using Vite as the build tool
- **UI Library**: Radix UI components with shadcn/ui design system
- **Styling**: Tailwind CSS with custom CSS variables for theming
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query (React Query) for server state management
- **Form Handling**: React Hook Form with Zod validation

## Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Language**: TypeScript with ES modules
- **Authentication**: OpenID Connect with Replit Auth integration using Passport.js
- **Session Management**: Express sessions with PostgreSQL session store
- **Database**: PostgreSQL with Drizzle ORM for type-safe database operations
- **API Design**: RESTful API endpoints with role-based access control

## Database Schema
- **Users**: Role-based system (admin, coordinator, administrative, vendedor, telemarketing) with routes and profile information
- **Customers**: Customer data with seller assignments, contact information, and visit scheduling
- **Products**: Product catalog with pricing and inventory tracking
- **Sales Cards**: Visit scheduling and sales tracking with customer relationships and delivery integration
- **Message Templates**: WhatsApp message templates for customer communication
- **Message History**: Audit trail for WhatsApp communications
- **Delivery Management**: Delivery drivers, delivery history, and real-time status tracking
- **Sessions**: PostgreSQL-based session storage for authentication

## Authentication & Authorization
- **Authentication Provider**: Replit OpenID Connect integration
- **Session Storage**: PostgreSQL with connect-pg-simple
- **Authorization**: Role-based access control with middleware protection
- **User Management**: Automatic user creation/update on authentication

## Key Features
- **Role-Based Dashboard**: Different views and permissions based on user roles
- **Customer Management**: CRUD operations with seller assignments and route management
- **Sales Card System**: Visit scheduling and outcome tracking
- **Product Catalog**: Inventory and pricing management
- **WhatsApp Integration**: Template-based messaging system
- **Weekday-Based Route System**: Customers are organized by weekdays (segunda, terca, quarta, quinta, sexta, sabado, domingo) instead of geographic regions
  - Each customer can be assigned to up to 2 days per week for visits
  - Validation enforced at UI and database level (Zod refinement)
  - Legacy `route` field maintained for backward compatibility (nullable)
- **Omie ERP Integration**: Complete synchronization of clients, vendors, products and overdue debts
  - **Protected Fields During Sync**: Customer coordinates (latitude/longitude), route (deprecated), weekdays, and visit periodicity are preserved during Omie synchronization and can only be modified through spreadsheet import or individual customer editing in the app
- **Bulk Import Operations**: Individual and bulk client import from Omie with seller assignment
- **Financial Tracking**: Real-time overdue debt monitoring and credit analysis
- **Delivery Integration**: Real-time delivery status tracking integrated with App Entregas Honest
- **Delivery Tracking**: Complete delivery history, driver management, and status updates
- **Webhook Support**: External API endpoints for delivery status updates from delivery app
- **Billing Synchronization**: Accurate invoice synchronization with status mapping and validation filters (422 authorized invoices)
- **Billing Filters & Stats**: Seller-based filtering with reactive statistics that update based on applied filters using efficient SQL aggregates
- **Invoice Stage Mapping**: Properly documented invoice stage mapping (Etapa 20="Em Rota", Etapa 70="Entregue", Etapa 80="Aguardando Rota", Etapa 50/60="Faturado")
- **Check-in with Photo**: Mobile-friendly check-in system with camera photo capture, geolocation tracking, and distance calculation using Haversine formula
  - Backend handles multipart/form-data photo upload using multer
  - Photos stored as base64 in checkInPhotoUrl field
  - Distance automatically calculated when customer coordinates are available
  - Modal-based workflow: geolocation capture → camera preview → photo confirmation → submission

# External Dependencies

## Database
- **Neon PostgreSQL**: Serverless PostgreSQL database with connection pooling
- **Drizzle ORM**: Type-safe database operations with migration support

## Authentication
- **Replit Authentication**: OpenID Connect provider for user authentication
- **Passport.js**: Authentication middleware for Express

## UI Components
- **Radix UI**: Headless UI components for accessibility and functionality
- **Lucide React**: Icon library for consistent iconography
- **Tailwind CSS**: Utility-first CSS framework for styling

## Development Tools
- **Vite**: Fast build tool with HMR for development
- **TypeScript**: Type safety across frontend and backend
- **ESBuild**: Fast JavaScript bundler for production builds

## Third-Party Services
- **WhatsApp Business API**: Customer communication integration (configured but implementation depends on external setup)
- **Replit Infrastructure**: Hosting and development environment integration