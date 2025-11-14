# Overview

"Sistema Integra" is a comprehensive CRM and sales management system for Honest Sucos. Its primary purpose is to streamline operations by integrating customer relationship management, product catalog administration, sales card tracking, and WhatsApp communication. The system aims to enhance business efficiency, improve customer service, expand market reach, and increase sales. Key capabilities include robust sales tracking, reporting, route optimization, fine-grained access control, an e-commerce platform ("Hotsite Instagram"), and real-time billing data integration from Omie ERP for customer "positivation" status.

# Recent Changes (Nov 14, 2025)

## Hotsite Orders Display Bug Fix
- **Issue**: `/api/hotsite-orders` endpoint returned empty array despite hotsite orders existing in database
- **Root Cause**: Called `getSalesCards({})` which passed empty object as `sellerId` parameter, causing SQL to filter by `seller_id = '[object Object]'`
- **Fix**: Changed to `getSalesCards(undefined)` to fetch all sales_cards without seller filter
- **Impact**: Hotsite orders now display correctly in "Pedidos do Site" admin page

## Hotsite Order Value (saleValue) Bug Fix
- **Issue**: Order totals displayed as R$ 0.00 in "Pedidos do Site" page despite orders having correct values in notes
- **Root Cause**: POST `/api/public/orders` endpoint created sales_cards without populating `saleValue` field, storing total only as text in `notes`
- **Fix**: Added `saleValue: serverTotal.toString()` to orderData (line 13160 in server/routes.ts)
- **Data Backfill**: Executed SQL UPDATE to extract totals from notes and populate sale_value for existing hotsite orders using regex pattern
- **Validation**: End-to-end test confirmed new orders now save with correct saleValue (verified order created with sale_value = 75.00)
- **Impact**: All hotsite orders (new and existing) now display correct monetary values in admin interface

## Hotsite Orders Management Features
- **Interactive Order Details Modal**: Clicking on order row or eye icon opens modal with complete order information including products, customer details, and payment method
- **Delete Order Functionality**: Admin/coordinator/administrative users can delete hotsite orders via DELETE `/api/hotsite-orders/:id` endpoint. Validates user permissions and confirms order source is 'hotsite' before deletion
- **Send to Omie Integration**: Admin users can send hotsite orders to Omie ERP via POST `/api/hotsite-orders/:id/send-to-omie` endpoint
  - Automatically creates customer in Omie if customer doesn't exist (using `createOmieOrder` function)
  - Validates order hasn't been sent previously to prevent duplicates
  - Handles both array and string formats for order products field
  - Updates sales_card with Omie order ID and sync status after successful send
  - Returns both `numero_pedido` and `omieOrderNumber` for frontend compatibility

## Hotsite Product Structure & Omie Validation
- **Product Data Structure**: Hotsite orders now store complete product information for Omie compatibility
  - Products formatted with `name`, `productName`, `quantity`, `unitPrice`, and `totalPrice` fields at order creation time
  - All numeric fields (`quantity`, `unitPrice`, `totalPrice`) stored as actual numbers (not strings)
  - Structure created at order time (lines 13234-13241 in server/routes.ts)
  
- **Robust Omie Send Validation**: Endpoint POST `/api/hotsite-orders/:id/send-to-omie` implements strict validation before sending to Omie
  - **Mandatory Fields**: Rejects orders missing `paymentMethod` or `operationType` (no silent defaults)
  - **Numeric Validation**: Uses `Number()` with `Number.isFinite()` checks to reject malformed values
    - Validates `saleValue` against strings like '123abc' or 'R$ 100,50' (line 2119)
    - Validates each product's `quantity` and `unitPrice` (lines 2137-2149)
    - Validates `totalPrice` when present or calculates from validated values (lines 2152-2169)
    - Detects overflow/Infinity scenarios
  - **Boleto Payment**: When `paymentMethod = 'boleto'`, requires valid numeric `boletoDays` (no default to 7)
  - **Validated Products**: Stores validated products in `validatedProducts` array and reuses for Omie payload (line 2208) to prevent NaN propagation
  - **Error Messages**: Returns detailed error messages indicating which field/product failed validation
  
- **End-to-End Validation**: Test confirmed orders created via `/api/public/orders` have correct structure and display properly in admin interface with non-zero sale values

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
- **Data Handling**: ISO UTC for dates with timezone conversion to America/Sao_Paulo for visit schedule calculations. CPF/CNPJ validation. Bulk data imports. Customer displays prioritize `fantasy_name`. Normalization of weekday formats.
- **Sales & Financial Management**: Sales card tracking with source, conditional payment terms, overdue debt monitoring, credit analysis, "Contas a Receber" view, automatic order blocking based on Omie data, and sales goals dashboard.
- **Delivery & Route Optimization**:
    - Scheduled daily route generation using Nearest Neighbor + 2-opt algorithm with OSRM API.
    - Visual mapping, checkpoint registration, performance dashboards.
    - Supports multi-vehicle planning, check-in/check-out, and checkpoint distance tracking.
    - Unified Customer + Lead Optimization: Route optimization algorithm supports both customers and leads simultaneously using `visitStops` metadata.
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
    - **5-Tier Pricing System**: Products have separate prices for Consumidor Varejo, Consumidor Atacado, Revenda Goiânia, Revenda Interior, and Revenda Brasília/DF. Pricing logic is in `hotsite/src/utils/pricing.ts`. Admins configure prices.
    - **Technical Details**: Optional technical details (10,000 char max) for products, managed by admins.
    - **Hotsite Deployment**: Requires rebuild after source changes: `cd hotsite && npm run build && cp -r dist/* ../server/public-hotsite/`.
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