# Go Microservices E-Commerce Platform

A production-grade e-commerce platform built with Go, demonstrating microservices architecture with gRPC, event-driven communication, and distributed systems patterns.

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │           API Gateway :8080          │
                        │  (Chi router, JWT auth, CORS, logs)  │
                        └───┬────────┬────────┬────────┬───────┘
                            │ REST   │        │        │
              ┌─────────────▼──┐  ┌──▼───┐ ┌─▼────┐ ┌▼───────┐
              │ Product Service │  │ Cart │ │Order │ │Payment │
              │   gRPC :50051   │  │Svc   │ │Svc   │ │Svc     │
              └────────┬────────┘  └──┬───┘ └──┬───┘ └───┬────┘
                       │              │         │          │
              ┌────────▼──────────────▼─────────▼──────────▼────┐
              │                   NATS (Events)                   │
              └────────────────────────┬──────────────────────────┘
                          ┌────────────┼──────────────┐
                     ┌────▼────┐  ┌───▼────┐  ┌──────▼──────┐
                     │Notif.   │  │Search  │  │  Shared Pkg  │
                     │Service  │  │Service │  │  (logging,   │
                     │(events) │  │(ES)    │  │   tracing,   │
                     └─────────┘  └────────┘  │   circuit    │
                                               │   breaker)  │
                                               └─────────────┘
```

### Services

| Service             | Port  | Protocol | Storage        |
|---------------------|-------|----------|----------------|
| API Gateway         | 8080  | HTTP/REST | -             |
| Product Service     | 50051 | gRPC      | PostgreSQL     |
| Cart Service        | -     | Internal  | Redis          |
| Order Service       | -     | Internal  | PostgreSQL     |
| Payment Service     | -     | Internal  | PostgreSQL     |
| Notification Service| -     | Events    | -              |
| Search Service      | -     | Internal  | Elasticsearch  |

### Infrastructure

- **PostgreSQL** - persistent storage for products, orders, payments
- **Redis** - cart sessions and caching
- **NATS** - async event bus between services
- **Elasticsearch** - full-text product search with facets
- **Jaeger** (optional) - distributed tracing via OpenTelemetry

---

## Prerequisites

| Tool              | Version  | Purpose                        |
|-------------------|----------|--------------------------------|
| Go | 1.27+    | Build and run services         |
| Docker            | 24+      | Run infrastructure containers  |
| Docker Compose    | 2.x      | Orchestrate all containers     |
| `grpc_health_probe` | latest | Check gRPC service health     |
| `protoc` + plugins | latest  | Regenerate proto files (optional) |

Install Go toolchain: https://go.dev/dl/

---

## Quick Start (All Services)

```bash
# 1. Clone and enter the project
cd projects/03-ecommerce-platform

# 2. Copy environment config
cp .env.example .env
# Edit .env with your values (Stripe key, JWT secret, etc.)

# 3. Start infrastructure
docker compose up -d

# 4. Wait for services to be healthy (~15s), then verify
docker compose ps

# 5. Build everything
make build

# 6. Run all services (in separate terminals or via make)
make run-all
```

The API gateway will be available at `http://localhost:8080`.

---

## Step-by-Step Build Guide

Each step is self-contained. Follow them in order on a fresh checkout.

### Step 1 - Shared Packages (`pkg/`)

The shared packages are imported by every service. Build them first to catch dependency issues.

**Files:**
- `pkg/logging/logger.go` - structured Zap logger
- `pkg/tracing/tracing.go` - OpenTelemetry tracer setup
- `pkg/circuitbreaker/breaker.go` - circuit breaker pattern
- `pkg/database/postgres.go` - pgx connection pool helper
- `pkg/events/nats.go` - NATS publisher/subscriber wrapper

```bash
# Verify shared packages compile
go build ./pkg/...
```

**Key concepts:**
- `logging.Default()` returns a production Zap logger; call `logging.Sync()` on shutdown.
- `tracing.InitTracer(cfg)` connects to Jaeger via OTLP HTTP; returns a shutdown func.
- `database.NewPostgresPool(ctx, cfg)` creates a `pgxpool.Pool`; always `defer pool.Close()`.
- `events.NewNATSClient(url)` wraps NATS with reconnect logic.

---

### Step 2 - Product Service (`services/product/`)

Exposes a **gRPC** server on port `50051`. Handles product catalog, inventory, and categories.

**Files:**
```
services/product/
  cmd/server/main.go                     # Entry point
  internal/domain/product.go             # Domain models
  internal/domain/errors.go              # Domain errors
  internal/repository/product_repository.go
  internal/repository/inventory_repository.go
  internal/repository/category_repository.go
  internal/service/product_service.go    # Business logic
  internal/grpc/server.go                # gRPC handler
  proto/product.pb.go                    # Generated proto
  proto/product_grpc.pb.go               # Generated gRPC stubs
```

```bash
# Build the product service binary
go build -o bin/product-service ./services/product/cmd/server/

# Run (requires PostgreSQL on localhost:5432)
DB_HOST=localhost DB_USER=postgres DB_PASSWORD=postgres DB_NAME=product_db \
  ./bin/product-service
```

**Environment variables:**

| Variable         | Default     | Description              |
|------------------|-------------|--------------------------|
| `DB_HOST`        | localhost   | PostgreSQL host          |
| `DB_USER`        | postgres    | PostgreSQL user          |
| `DB_PASSWORD`    | postgres    | PostgreSQL password      |
| `DB_NAME`        | product_db  | Database name            |
| `GRPC_PORT`      | 50051       | gRPC listen port         |
| `JAEGER_ENDPOINT`| http://localhost:14268/api/traces | Tracing |

**gRPC methods:** `GetProduct`, `ListProducts`, `CreateProduct`, `UpdateProduct`, `DeleteProduct`, `ReserveInventory`, `ReleaseInventory`

---

### Step 3 - Order Service (`services/order/`)

Implements the **Saga pattern** for distributed order processing across product, payment, and notification services.

**Files:**
```
services/order/
  internal/domain/order.go       # Order aggregate, state machine
  internal/domain/errors.go      # Order-specific errors
  internal/saga/order_saga.go    # Saga orchestrator
```

The saga coordinates:
1. Reserve inventory (Product Service)
2. Process payment (Payment Service)
3. Confirm order + publish `order.confirmed` event
4. On failure: release inventory, refund payment (compensating transactions)

```bash
go build ./services/order/...
```

---

### Step 4 - Payment Service (`services/payment/`)

Integrates with **Stripe** for payment processing. Listens for Stripe webhooks.

**Files:**
```
services/payment/
  internal/domain/payment.go
  internal/repository/payment_repository.go
  internal/service/payment_service.go    # Stripe charge + refund
```

```bash
go build ./services/payment/...
```

**Environment variables:**

| Variable              | Description                      |
|-----------------------|----------------------------------|
| `STRIPE_SECRET_KEY`   | Stripe secret key (sk_test_...)  |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret  |

Webhook endpoint: `POST /api/v1/payments/webhook`

---

### Step 5 - Cart Service (`services/cart/`)

**Redis-backed** shopping cart. Each cart is keyed by user ID with TTL.

**Files:**
```
services/cart/
  internal/domain/cart.go
  internal/repository/cart_repository.go   # Redis HSET/HGET
  internal/service/cart_service.go
```

```bash
go build ./services/cart/...
```

**Environment variables:**

| Variable      | Default          | Description         |
|---------------|------------------|---------------------|
| `REDIS_ADDR`  | localhost:6379   | Redis address       |
| `REDIS_PASSWORD` | (empty)       | Redis password      |
| `CART_TTL`    | 24h              | Cart session TTL    |

---

### Step 6 - Notification Service (`services/notification/`)

Subscribes to NATS events and sends notifications (email, SMS, push).

**Files:**
```
services/notification/
  internal/handlers/order_events.go        # NATS event handlers
  internal/service/notification_service.go # Dispatch logic
```

**Events consumed:**

| NATS Subject        | Action                        |
|---------------------|-------------------------------|
| `order.confirmed`   | Send order confirmation email |
| `order.cancelled`   | Send cancellation notice      |
| `payment.failed`    | Alert user of payment failure |

```bash
go build ./services/notification/...
```

**Environment variables:**

| Variable    | Default              | Description    |
|-------------|----------------------|----------------|
| `NATS_URL`  | nats://localhost:4222 | NATS server   |

---

### Step 7 - Search Service (`services/search/`)

**Elasticsearch**-backed product search with fuzzy matching, facets, and price range filters.

**Files:**
```
services/search/
  internal/domain/product.go              # Search-specific product model
  internal/elasticsearch/client.go        # ES client, indexing, search
```

**Features:**
- Multi-field fuzzy search (`name^3`, `description`, `tags`)
- Faceted search by category and price range
- Auto-created index with custom analyzer on startup

```bash
go build ./services/search/...
```

**Environment variables:**

| Variable            | Default               | Description           |
|---------------------|-----------------------|-----------------------|
| `ELASTICSEARCH_URL` | http://localhost:9200 | Elasticsearch address |

---

### Step 8 - API Gateway (`api-gateway/`)

The single HTTP entry point. Routes REST requests to backend services, applies middleware.

**Files:**
```
api-gateway/
  cmd/gateway/main.go
  internal/router/router.go          # Chi route definitions
  internal/middleware/auth.go        # JWT authentication
  internal/middleware/cors.go        # CORS headers
  internal/middleware/logging.go     # Request logging
  internal/middleware/request_id.go  # X-Request-ID header
  internal/clients/product_client.go # gRPC client for product service
  internal/handlers/
    product_handler.go
    cart_handler.go
    order_handler.go
    payment_handler.go
```

```bash
# Build
go build -o bin/api-gateway ./api-gateway/cmd/gateway/

# Run (product service must be running first)
PRODUCT_SERVICE_ADDR=localhost:50051 \
HTTP_PORT=8080 \
  ./bin/api-gateway
```

**Environment variables:**

| Variable               | Default          | Description              |
|------------------------|------------------|--------------------------|
| `HTTP_PORT`            | 8080             | HTTP listen port         |
| `PRODUCT_SERVICE_ADDR` | localhost:50051  | Product gRPC address     |
| `JWT_SECRET`           | -                | JWT signing secret       |

---

### Step 9 - Wire It All Together

With Docker Compose handling infrastructure:

```bash
# Start infrastructure (PostgreSQL, Redis, NATS, Elasticsearch)
docker compose up -d postgres redis nats elasticsearch

# Build all binaries
make build

# Terminal 1: Product service
make run-product

# Terminal 2: API gateway
make run-gateway

# Verify health
curl http://localhost:8080/health
# {"status":"healthy"}
```

---

## Running Services

### Via Makefile (recommended)

```bash
make build          # Build all binaries into bin/
make run-product    # Run product service
make run-gateway    # Run API gateway
make run-all        # Run infra + all services via docker compose
make test           # Run all tests
make lint           # Run go vet + staticcheck
make clean          # Remove bin/ directory
```

### Via Docker Compose (full stack)

```bash
docker compose up --build   # Build images + start everything
docker compose down         # Stop and remove containers
docker compose logs -f      # Stream logs
```

---

## API Endpoints

All endpoints are prefixed with `/api/v1`. Authenticated routes require `Authorization: Bearer <jwt>`.

### Health

```
GET  /health
```

### Products

```
GET  /api/v1/products              List products (paginated)
GET  /api/v1/products/{id}         Get product by ID
GET  /api/v1/products/search       Search products (?q=query)
```

### Cart (authenticated)

```
GET    /api/v1/cart                 Get current user's cart
POST   /api/v1/cart/items           Add item to cart
PUT    /api/v1/cart/items/{id}      Update item quantity
DELETE /api/v1/cart/items/{id}      Remove item from cart
POST   /api/v1/cart/clear           Clear entire cart
```

### Orders (authenticated)

```
POST /api/v1/orders                 Create order from cart
GET  /api/v1/orders                 List user's orders
GET  /api/v1/orders/{id}            Get order details
POST /api/v1/orders/{id}/cancel     Cancel order
```

### Payments

```
POST /api/v1/payments/webhook       Stripe webhook receiver
```

---

## Project Structure

```
03-ecommerce-platform/
├── api-gateway/            # HTTP gateway (REST → gRPC)
│   ├── cmd/gateway/
│   └── internal/
│       ├── clients/        # gRPC client wrappers
│       ├── handlers/       # HTTP request handlers
│       ├── middleware/      # Auth, CORS, logging, request ID
│       └── router/         # Chi route definitions
├── cmd/server/             # Monolith entrypoint (dev/demo)
├── pkg/                    # Shared packages
│   ├── circuitbreaker/
│   ├── database/
│   ├── events/
│   ├── logging/
│   └── tracing/
├── services/
│   ├── cart/
│   ├── notification/
│   ├── order/
│   ├── payment/
│   ├── product/            # Has its own cmd/server + proto
│   └── search/
├── .env.example
├── docker-compose.yml
├── go.mod
├── go.sum
└── Makefile
```

---

## Development Notes

- **Proto changes:** Regenerate with `make proto` (requires `protoc` and `protoc-gen-go` installed).
- **Circuit breaker:** Wraps all inter-service gRPC calls. Trips after 5 consecutive failures, resets after 60s.
- **Tracing:** Each service initializes OpenTelemetry and exports to Jaeger. Trace IDs propagate via gRPC metadata.
- **Graceful shutdown:** All services handle `SIGTERM` / `SIGINT` and drain connections before exiting.
