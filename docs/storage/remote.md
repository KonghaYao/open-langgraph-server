---
title: Remote Storage
---

# Remote Storage

Remote PostgreSQL Adapter provides centralized database access through HTTP APIs, eliminating the need for each service instance to maintain its own connection pool. It's ideal for distributed environments and microservice architectures. Design for serverless environment.

## Overview

The Remote Storage adapter allows you to separate your application from direct database connections by using a dedicated HTTP server as a proxy. This architecture provides better resource management, easier scaling, and simplified deployment in distributed systems.

## Characteristics

-   🌐 **Centralized Management** - Unified database connection management
-   💾 **Reduced Overhead** - No connection pool maintenance on client side
-   🔄 **Easy Scaling** - Independent scaling of database access layer
-   🚀 **Simple Deployment** - Only HTTP connection required on client side
-   🐛 **Debug Friendly** - HTTP APIs are easy to debug and monitor

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Application Service                     │
│  ┌────────────────────────────────────────────────────┐ │
│  │  RemoteKyselyThreadsManager                         │ │
│  │  - HTTP Client (fetch API)                          │ │
│  └──────────────────────┬─────────────────────────────┘ │
│                         │ HTTP/REST API                 │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│               Remote Server                              │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Hono.js HTTP Server                                │ │
│  │  - KyselyThreadsManager                            │ │
│  │  - PostgresAdapter (Direct PG Connection)          │ │
│  └──────────────────────┬─────────────────────────────┘ │
│                         │                                │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│               PostgreSQL Database                        │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Start Remote Server

#### Basic Setup

Create a server file `server.ts`:

```typescript
import { RemoteServer } from '@langgraph-js/pure-graph/storage/remote/remote-server';
import App from '@langgraph-js/pure-graph/dist/remote/index';

export default {
    fetch: App.fetch,
};
```

Using Environment Variables

```bash
# Set database connection
export DATABASE_URL="postgresql://user:password@localhost:5432/dbname"

# Start server
bun run server.ts
```

### 2. Configure Agent Side Connection

#### Method 1: Environment Variables

```bash
# Use local PostgreSQL connection
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Use remote PG server
DATABASE_URL=http://localhost:3001/api/remote
DATABASE_URL=https://remote-pg-server.example.com/api/remote
```

The system automatically recognizes:

-   `http://` or `https://` prefix → Uses RemoteKyselyThreadsManager
-   Other formats → Uses local PostgresAdapter
