# Overview

This is a Customer Relationship Management (CRM) system for Honest Sucos, a Brazilian juice company. The application provides sales management capabilities including customer management, product catalog, sales card tracking, and WhatsApp integration for communication. It supports multiple user roles (admin, coordinator, administrative, vendedor) with role-based access control and features comprehensive sales tracking and reporting functionality.

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
- **Users**: Role-based system (admin, coordinator, administrative, vendedor) with routes and profile information
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
- **Route Management**: Geographic organization of customers and sellers
- **Omie ERP Integration**: Complete synchronization of clients, vendors, products and overdue debts
- **Bulk Import Operations**: Individual and bulk client import from Omie with seller assignment
- **Financial Tracking**: Real-time overdue debt monitoring and credit analysis
- **Delivery Integration**: Real-time delivery status tracking integrated with App Entregas Honest
- **Delivery Tracking**: Complete delivery history, driver management, and status updates
- **Webhook Support**: External API endpoints for delivery status updates from delivery app
- **Billing Synchronization**: Accurate invoice synchronization with status mapping and validation filters (422 authorized invoices)
- **Billing Filters & Stats**: Seller-based filtering with reactive statistics that update based on applied filters using efficient SQL aggregates
- **Invoice Stage Mapping**: Properly documented invoice stage mapping (Etapa 20="Em Rota", Etapa 70="Entregue", Etapa 80="Aguardando Rota", Etapa 50/60="Faturado")

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