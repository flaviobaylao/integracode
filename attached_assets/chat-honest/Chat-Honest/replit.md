# Overview

This is a WhatsApp Business customer service dashboard application built with React, Express.js, and PostgreSQL. The system provides a real-time chat interface for customer service agents to manage and respond to customer conversations. It features conversation management, agent assignment, real-time messaging via WebSockets, comprehensive customer relationship tracking, and integrated ChatGPT bot for automated customer service with the ability to transfer conversations to human agents when needed.

# Current Status (2025-09-30)

## What Works ✅
- WhatsApp → App: Messages from WhatsApp are received via Evolution API webhook and saved to database
- App → WhatsApp: Messages sent from agents are delivered to customers via WhatsApp
- Database: All conversations, messages, and customer data are persisted correctly
- Admin Dashboard: Real statistics from database (no more mock data)
- Authentication: Complete login system with role-based access control
- Dual WhatsApp APIs: Both Evolution API and Official API configured and working
- **WebSocket Real-Time Notifications**: WORKING ✅
  - New messages appear automatically without page refresh
  - WebSocket clients connect successfully (2 clients typically connected)
  - Broadcasts working: "📡 Broadcasting new message to 2 WebSocket clients"
  - Fixed: Added useWebSocket hook to both Dashboard AND Admin pages (admin users were on /admin route, not /dashboard)
- **Media Support**: WORKING ✅
  - File uploads (images, documents, videos) with size limits (10MB for files, 5MB for audio)
  - Audio message recording support
  - Location sharing with Google Maps integration
  - Media rendering in chat UI (images, audio players, video players, document downloads, location maps)
  - Automatic fallback chain: Evolution API → WhatsApp Official API → text with link
- **Chat History Synchronization**: WORKING ✅
  - Automatic import of entire WhatsApp conversation history when connecting a number
  - One-click synchronization from Admin panel for Evolution API connections
  - Historical messages stored in database for ChatGPT context
  - Batch processing of all chats with proper customer/conversation creation
  - Historical messages marked as read to avoid notification spam

## Known Issues ❌
- None at the moment! All major features are working correctly.

# User Preferences

Preferred communication style: Simple, everyday language.
WhatsApp Integration: User wants to test with real WhatsApp connection (noted 2025-08-18).

# System Architecture

## Frontend Architecture
- **React SPA**: Built with React 18 using TypeScript and Vite as the build tool
- **UI Framework**: shadcn/ui components with Radix UI primitives and Tailwind CSS for styling
- **State Management**: TanStack Query (React Query) for server state management and caching
- **Routing**: Wouter for lightweight client-side routing
- **Real-time Communication**: WebSocket client for live updates of conversations and messages

## Backend Architecture
- **Express.js Server**: RESTful API with Express.js handling HTTP requests and responses
- **WebSocket Integration**: WebSocket server for real-time bidirectional communication between agents and the system
- **Database Layer**: Drizzle ORM with PostgreSQL for data persistence and type-safe database operations
- **Session Management**: Express sessions with PostgreSQL session store using connect-pg-simple

## Database Design
- **Agents Table**: Stores agent information, status (online/offline/busy), and conversation statistics
- **Customers Table**: Customer contact information and interaction history
- **Conversations Table**: Links customers to agents with status tracking (new, assigned, in-progress, resolved) and priority levels
- **Messages Table**: Stores all conversation messages with sender type identification, read status, and media support
  - Media fields: messageType (text/image/audio/video/document/location), mediaUrl, mediaType, mediaSize, mediaFilename
  - Location fields: latitude, longitude, locationName

## Key Features
- **Real-time Messaging**: WebSocket-powered instant message delivery and status updates
- **Agent Message Sending**: Agent responses are automatically sent via WhatsApp (Evolution API or Official API) to customers
- **Agent Management**: Online status tracking, conversation assignment, and workload distribution
- **Conversation Reopening**: Ability to reopen resolved conversations for continued customer support
- **ChatGPT Integration**: Automated customer service bot that can handle initial customer inquiries
- **OpenAI Assistant Exclusive**: Configured exclusively to use Assistant ID `asst_4AM6M50fsOXKXlz5Ijc7IA9k`
- **Fixed API Configuration**: Hardcoded Assistant ID to ensure consistent behavior and remove fallbacks
- **Bot-to-Human Transfer**: Intelligent conversation transfer from ChatGPT to human agents when needed
- **Conversation Workflow**: Automatic assignment system with status progression from new to resolved
- **Customer Tracking**: Comprehensive customer profiles with conversation history and contact management
- **Dashboard Interface**: Multi-panel layout with conversation list, chat area, and customer information panel
- **Hybrid Support Model**: Seamless integration between automated bot responses and human agent assistance
- **Settings Management**: Comprehensive configuration interface with API key validation and connection testing
- **Dual WhatsApp Integration**: Supports both WhatsApp Official Business API and Evolution API (free alternative)
- **Priority-Based Messaging**: Evolution API > WhatsApp Official API > Simulation mode for message delivery
- **Hybrid Strategy Dashboard**: Visual admin interface showing real-time status of all WhatsApp APIs with automatic fallback
- **Smart Provider Selection**: Automatic selection of best available provider with resilient fallback chain
- **QR Code Connection**: Simple WhatsApp connection via QR code scanning with Evolution API
- **Webhook Processing**: Real-time message reception from both WhatsApp API providers
- **Live Status Monitoring**: Real-time dashboard with color-coded cards showing configuration, connection, and active status of each provider
- **Media Support**: Complete multimedia messaging support
  - File uploads with multer (images, documents, videos, audio)
  - Size limits: 10MB for files, 5MB for audio
  - Audio recording capability in chat interface
  - Location sharing with Google Maps integration
  - Media rendering: Images displayed inline, audio/video with native players, documents with download links
  - Resilient fallback: Evolution API → WhatsApp Official API → text message with media URL
- **Chat History Synchronization**: Automatic WhatsApp conversation history import
  - Evolution API integration for fetching historical messages (fetchChatHistory, fetchAllChats methods)
  - Admin endpoints: `/api/evolution/sync-all-chats` (all conversations) and `/api/evolution/sync-history` (specific contact)
  - **Auto-Sync on Conversation Open** (NEW - 2025-10-02): When an agent opens a conversation with no messages, the system automatically fetches and imports the complete WhatsApp message history
    - Endpoint: `POST /api/conversations/:id/sync-history` (available to all authenticated users)
    - Frontend integration in ChatArea component with automatic detection
    - Loading state management to prevent redundant requests
    - Silent error handling when Evolution API is not configured
  - Batch processing: Automatically creates customers, reopens/creates conversations, saves all historical messages
  - Historical messages marked as read (isRead: true) to prevent notification overload
  - ChatGPT context enhancement: All historical messages available in conversationHistory for intelligent responses
  - One-click sync button in Admin panel (Evolution API Settings section)
  - Audit logging for all synchronization operations

## Authentication & Authorization
- **Complete Authentication System**: Username/password authentication with bcrypt password hashing
- **Role-Based Access Control**: Admin and Agent user roles with different permission levels
- **Session Management**: Express sessions with PostgreSQL session store for secure authentication state
- **Protected Routes**: All sensitive API endpoints require proper authentication and authorization
- **Default Admin Account**: Username "Flavio" with password "M@riafe1" for system administration
- **Audit Logging**: Comprehensive logging of all authentication events and system actions

# External Dependencies

## AI Integration
- **OpenAI API**: ChatGPT integration for automated customer service responses

## WhatsApp Integration
- **WhatsApp Official Business API**: Enterprise-grade WhatsApp integration with official Meta/Facebook API
- **Evolution API**: Free, open-source alternative for WhatsApp integration via QR code connection
- **Priority System**: Evolution API takes priority when both are configured, falling back to Official API, then simulation mode
- **Webhook Configuration**: Evolution API webhook configured at `https://workspace.flaviobaylao.repl.co/api/evolution/webhook` with events `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE`
- **Event Format**: Webhook events must be in UPPERCASE format (e.g., MESSAGES_UPSERT not messages.upsert)
- **Message Reception**: Incoming customer messages are automatically processed to create/update customers, conversations, and messages in the database

## Database
- **Neon Database**: PostgreSQL database service via @neondatabase/serverless driver
- **Drizzle ORM**: Type-safe database operations with PostgreSQL dialect

## UI & Styling
- **shadcn/ui**: Complete UI component library built on Radix UI primitives
- **Tailwind CSS**: Utility-first CSS framework for responsive design
- **Radix UI**: Accessible, unstyled UI primitives for complex components

## Real-time Communication
- **WebSocket (ws)**: Native WebSocket implementation for real-time client-server communication

## Development Tools
- **Vite**: Fast build tool with React plugin and TypeScript support
- **TypeScript**: Type safety across the entire application stack
- **Replit Integration**: Development environment with live reload and error overlay plugins

## Form & Data Validation
- **React Hook Form**: Form state management with @hookform/resolvers
- **Zod**: Runtime type validation and schema definition
- **drizzle-zod**: Integration between Drizzle schemas and Zod validation

## Utilities
- **date-fns**: Date manipulation and formatting utilities
- **clsx & class-variance-authority**: Dynamic CSS class composition
- **cmdk**: Command palette component for enhanced UX