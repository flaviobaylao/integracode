# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, expand market reach, and increase sales. Key capabilities include robust sales tracking, reporting, route optimization, fine-grained access control, an e-commerce platform ("Hotsite Instagram"), and real-time billing data integration from Omie ERP for customer "positivation" status.

# User Preferences

- **Communication Style**: Simple, everyday language.
- **Testing Credentials**: Always use flavio@bebahonest.com.br / M@riafe1 for login and testing.

# System Architecture

## UI/UX Decisions
- **Branding**: "Sistema Integra" with a sustainability leaf favicon.
- **Responsiveness**: Mobile-first design with adaptive navigation.
- **UI Components**: Utilizes Radix UI, shadcn/ui, and Tailwind CSS.
- **Hotsite Design**: Premium landing page inspired by Solti.com with a hero section, badges, ingredient showcase, product showcase, benefits section, and enhanced footer. Visual theme uses a strawberry/pink color palette, premium spacing, and clean typography.

## Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, TanStack Query for state management, React Hook Form with Zod for form handling.
- **Backend**: Node.js, Express.js, TypeScript.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication & Authorization**: Email/Password and Replit Auth (Passport.js OIDC) with role-based access control (admin, coordinator, administrative, vendedor, telemarketing).
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo, CPF/CNPJ validation, bulk data imports, customer display prioritization (`fantasy_name`), normalization of weekday formats.
- **Sales & Financial Management**: Sales card tracking with source and conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and sales goals dashboard.
- **Delivery & Route Optimization**:
    - Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API.
    - Visual mapping, checkpoint registration, performance dashboards.
    - Multi-vehicle planning, check-in/check-out, and checkpoint distance tracking.
    - Unified Customer + Lead Optimization: Route optimization algorithm supports both customers and leads simultaneously.
    - 3-Layer Deduplication: Protects against duplicate route entries.
    - Route Allocation Logic: Filters customers where `routeDate >= serviceStartDate`.
    - Executed Route Distance: Calculates actual traveled distance based on chronological check-ins using OSRM API.
    - "Rota do Dia" Page: Auto-refreshing daily route visualization with metrics, interactive map, and photo markers.
    - Smart Visit List: Inline check-in/check-out, color-coded status, location validation alerts.
    - Automated Check-out: Time-based (30 mins after check-in) and action-based (sale or "no sale" registered).
    - Worked Hours Calculation: Real-time calculation from first check-in to last check-out, deducting lunch breaks.
- **Admin Route Management**: Administrative users can manually add, delete, and optimize visits on daily routes.
- **Visit Schedule Management**: Route generation queries `customers` table directly. Visit scheduling is calculated on-demand from customer's `weekdays`, `visitPeriodicity`, and last visit from `sales_cards`.
- **WhatsApp Mobile Optimization**: Smart device detection for opening WhatsApp links.
- **Customer Management**: Client-side search and filtering for sales schedules and customer data. Customer inactivation.
- **Omie ERP Integration**: Hourly synchronization of clients, vendors, products, overdue debts, invoices. Order blocking system. Hotsite orders can be sent to Omie ERP, automatically creating customers if needed, with robust validation for mandatory fields and numeric values.
- **HR Management (RH)**: HR tracking for seller performance (monthly mileage, work hours, daily attendance).
- **E-commerce Platform (Hotsite Instagram)**: Standalone React SPA with customer type selection (CPF/CNPJ with Receita Federal API), customer recognition/registration, 5-tier dynamic pricing system, server-side security, and automatic order registration in Sistema Integra as `sales_cards` (source: 'hotsite'). Includes product gallery, customer reviews, stock management, order management page, and technical product details.
    - **Payment Methods**: Differentiated by customer type (Pix, Credit/Debit Card, Boleto).
    - **Shopping Cart UX**: Cart modal opens on product add and remains open, with multiple closing methods.
    - **Minimum Order & Shipping**: Free shipping on all orders with minimum order values enforced per customer type. No additional discounts.
    - **5-Tier Pricing System**: Products have separate prices for Consumidor Varejo, Consumidor Atacado, Revenda Goiânia, Revenda Interior, and Revenda Brasília/DF.
    - **Technical Details**: Optional technical details (10,000 char max) for products.
- **Leads Management**: Lead tracking system with full route integration.
    - **Access Control**: Administrative users create/delete leads; all view; sellers update assigned leads.
    - **Route Integration**: Unified `visitStops` field allows mixing customers and leads on daily routes.
    - **Photo Enforcement**: Leads require mandatory photos for check-in and check-out.

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
# Recent Changes (Nov 14, 2025)

## Urgent Delivery Prioritization (COMPLETE)
- **Feature**: Sistema de priorização de entregas urgentes para roteirização
- **Implementation**:
  1. **Schema**: Campo `isUrgent` adicionado à tabela `billings`
  2. **Algorithm**: Urgent-first grouping com 3 buckets (urgent, highPriority, normal)
  3. **Priority Factors**: 0.1 para urgent, 0.7 para highPriority, 1.0 para normal
  4. **2-opt Guard**: Proteção que impede entregas urgentes serem movidas para depois de não-urgentes
  5. **Endpoint**: PATCH `/api/billings/:id/urgent` para atualizar status de urgência
  6. **Storage**: Método `updateBillingUrgency` para atualização otimizada
  7. **Interface**: Checkbox em Gestão de Entregas para marcar billings como urgentes
- **Flow**:
  1. Usuário marca billing como urgente antes da roteirização
  2. Sistema aplica urgent-first grouping no algoritmo de otimização
  3. Entregas urgentes aparecem sempre no início das rotas
  4. 2-opt respeita ordem de urgência durante refinamento
- **Impact**:
  - ✅ Entregas urgentes sempre priorizadas
  - ✅ Considera particularidades de localização, veículo e horário
  - ✅ Mantém eficiência do algoritmo de otimização
  - ✅ Compatível com rotas de vendedores existentes

# Recent Changes (Nov 14, 2025)

## Delivery Management Duplicate Orders Fix (COMPLETE)
- **Issue**: Delivery management page showed duplicate entries for the same client (e.g., CONVENIENCIA VIA 153 appeared twice with different addresses)
- **Root Causes**:
  1. **Original count mismatch**: `/api/deliveries` endpoint had incorrect NOT EXISTS subquery. It tried to JOIN `billings.id` with `delivery_route_stops.sales_card_id`, but `sales_card_id` references `sales_cards` table, not `billings`. The subquery never found matches, so already-routed billings weren't filtered out.
  2. **Duplicate rows**: LEFT JOIN with `customers` table used 3 OR conditions (omie_customer_code, CPF, CNPJ) without deduplication. When multiple customers matched the same billing (e.g., 2 stores with same CNPJ but different addresses), the JOIN returned multiple rows for the same billing.
- **Fix**: 
  1. Corrected NOT EXISTS to properly traverse `delivery_route_stops` → `sales_cards` → `billings` using shared business keys (`invoice_number` or `omie_order_id`)
  2. Added `DISTINCT ON (b.id)` to the SELECT query to guarantee each billing appears only once, even when multiple customers match
  3. Implemented intelligent customer prioritization using CASE WHEN in ORDER BY:
     - **Priority 1**: Customer with exact match by `omie_customer_code` (canonical Omie customer)
     - **Priority 2**: Customers with non-null IDs
     - **Priority 3**: Ordering by invoice date
  4. Query: `ORDER BY b.id, CASE WHEN c.id = CONCAT('omie-client-', b.omie_customer_code) THEN 0 ELSE 1 END, c.id NULLS LAST, b.invoice_date`
- **Impact**: 
  - ✅ Eliminates duplicates definitively - each billing appears exactly once
  - ✅ Always selects the correct customer (from Omie) even when multiple stores share the same CNPJ
  - ✅ Correctly excludes billings that already have assigned delivery routes
  - ✅ Count now matches perfectly between delivery management and invoicing "aguardando rota"
  - ✅ Deterministic behavior - same customer selected every time for a given billing

## Driver Management Fix (COMPLETE)
- **Issue**: Driver creation and update weren't working (reported by user)
- **Root Causes**: 
  1. Duplicate GET "/api/delivery-drivers" endpoint
  2. Read operations queried `users` table (role='motorista') while write operations targeted `delivery_drivers` table
  3. Missing `isActive` field in createDeliveryDriver INSERT statement
  4. SQL syntax error in updateDeliveryDriver using COALESCE with undefined values
  5. Inconsistent response formats (snake_case vs camelCase)
  6. Missing authentication on driver management endpoints
- **Fix**: 
  1. Removed duplicate endpoint definition
  2. Updated all storage methods to consistently use `delivery_drivers` table (not users)
  3. Added `isActive` field to CREATE (defaults to true)
  4. Rewrote `updateDeliveryDriver` using proper Drizzle ORM `.update().set().where().returning()`
  5. All CRUD methods now return consistent camelCase fields
  6. Added proper authentication with role-based access control
  7. Imported `deliveryDrivers` table from schema into storage layer
- **Testing**: All CRUD operations tested and working
- **Impact**: Complete driver CRUD functionality now works reliably
