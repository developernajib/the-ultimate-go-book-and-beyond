# Project 10: API Gateway

A production-grade reverse proxy API gateway with a plugin system, multiple load balancing strategies, circuit breaker, distributed tracing, WebSocket proxying, gRPC proxying, TLS termination, hot config reloading, and a separate admin REST API for runtime management.

## Architecture Overview

```
Client Request
      |
[Gateway Server :8080]
      |
 [Router - trie-based path matching]
      |
 [Plugin Chain]
   ├── request-id  (correlation ID injection)
   ├── cors        (origin validation)
   ├── auth        (JWT or API key)
   ├── rate-limit  (Redis sliding window)
   ├── cache       (response caching)
   ├── circuit     (circuit breaker per upstream)
   └── transform   (request/response rewrite)
      |
 [Upstream Manager]
   ├── Round-Robin
   ├── Least-Connections
   ├── Weighted Random
   ├── IP Hash
   └── Consistent Hash
      |
 [Health Checker] → marks targets healthy/unhealthy
      |
Upstream Services

[Admin API :9090]  ← manage routes and upstreams at runtime
[Metrics   :8080/metrics]  ← Prometheus
[Tracing]  → OTLP exporter → Jaeger/Tempo
```

**Key packages:**
- `internal/gateway` - server lifecycle, config, TLS setup, WebSocket and gRPC proxy
- `internal/router` - trie-based URL matcher, route definition types
- `internal/upstream` - upstream pool, load balancers (round-robin, least-conn, weighted-random, IP-hash, consistent-hash), health checker
- `internal/plugin` - plugin interface, chain runner, plugin registry
- `internal/plugins/auth` - JWT and API key authentication plugins
- `internal/plugins/ratelimit` - sliding window rate limiter (Redis-backed)
- `internal/plugins/cors` - CORS header management
- `internal/plugins/cache` - response caching plugin
- `internal/plugins/circuit` - circuit breaker per upstream
- `internal/plugins/requestid` - request ID injection
- `internal/plugins/transform` - request/response body and header transforms
- `internal/admin` - admin REST API (chi router, API key auth)
- `internal/config` - fsnotify-based config file watcher
- `internal/observability` - structured logging (zap), Prometheus metrics, OTLP tracing

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.27+ | Build toolchain |
| Docker | 24+ | Run Redis and Jaeger |
| Docker Compose | 2.x | Local infrastructure |
| Make | any | Convenience targets |

---

## Step-by-Step Build Guide

### Step 1 - Understand the Gateway Configuration

**Files:** `internal/gateway/config.go`, `internal/gateway/types.go`

All gateway behaviour is driven by `configs/gateway.yaml`. The config tree:

```yaml
server:
  host: 0.0.0.0
  port: 8080

admin:
  enabled: true
  port: 9090
  api_key: "your-admin-key"

routes:
  - id: user-service
    paths: ["/api/users", "/api/users/*"]
    methods: [GET, POST, PUT, DELETE]
    upstream_id: user-upstream
    plugins:
      - name: jwt-auth
      - name: rate-limit
        config:
          limit: 100
          window: 1m

upstreams:
  - id: user-upstream
    load_balance: round_robin
    targets:
      - host: user-service
        port: 3000
        weight: 100
    health_check:
      enabled: true
      http_path: /health
      interval: 10s
```

`LoadConfig()` reads the YAML, sets defaults via `setDefaults()`, and validates with `validateConfig()`. Validation ensures: every route has at least one path and a valid `upstream_id`, every upstream has at least one target with a valid host and port.

**What to test:** Load a valid config and assert server port is set. Load a config with a route pointing to a non-existent upstream ID and assert an error is returned.

### Step 2 - Understand the Router (Trie)

**Files:** `internal/router/trie.go`, `internal/router/matcher.go`, `internal/router/router.go`

Routes are stored in a radix trie for O(k) lookup (where k is the path depth). The trie supports:
- Static segments: `/api/users`
- Wildcard parameters: `/api/users/*`

`matcher.go` extracts method constraints and selects the matching route. If multiple routes match, the most specific one wins.

`router.go` provides the `Router` struct used by both the gateway server and the admin API (to list and modify routes at runtime).

**What to test:** Insert routes for `/api/users` and `/api/users/:id`. Request `/api/users/42` - assert the second route matches and `:id` is extracted. Request `/api/posts` - assert no route is found (404).

### Step 3 - Understand the Upstream Load Balancers

**Files:** `internal/upstream/loadbalancer.go`, `internal/upstream/pool.go`, `internal/upstream/consistent_hash.go`, `internal/upstream/random.go`, `internal/upstream/upstream.go`

Five strategies are implemented, all satisfying the `LoadBalancer` interface:

| Strategy | When to use |
|----------|-------------|
| `round_robin` | Even distribution, default |
| `least_connections` | Best for variable request durations |
| `weighted_random` | Different capacity targets |
| `ip_hash` | Session affinity by client IP |
| `consistent_hash` | Cache-friendly routing by request key |

`pool.go` maintains the list of healthy targets. `upstream.go` wires the pool, load balancer, and health checker together.

**What to test:** Create a pool with 3 targets. Call `Pick()` 30 times under round-robin. Assert each target is selected exactly 10 times. Mark one target unhealthy. Call `Pick()` - assert the unhealthy target is never returned.

### Step 4 - Understand the Plugin System

**Files:** `internal/plugin/plugin.go`, `internal/plugin/chain.go`, `internal/plugin/registry.go`

Each plugin implements:
```go
type Plugin interface {
    Name() string
    Execute(ctx context.Context, pctx *PluginContext, next Handler) error
}
```

Plugins are registered globally at startup via `init()` functions (using blank imports in `main.go`). For each request, the plugins configured on the matching route are composed into a chain and executed in order, each calling `next` to continue.

`registry.go` stores plugin factories by name. The chain runner (`chain.go`) instantiates and sequences plugins per request.

**What to test:** Create a chain with two plugins: one that sets a header and one that checks it. Assert the header is set when the chain runs. Assert that a plugin returning an error stops the chain.

### Step 5 - Understand the Middleware Plugins

**Files:** `internal/plugins/auth/jwt.go`, `internal/plugins/auth/apikey.go`, `internal/plugins/ratelimit/ratelimit.go`, `internal/plugins/cors/cors.go`, `internal/plugins/cache/cache.go`, `internal/plugins/circuit/breaker.go`, `internal/plugins/requestid/requestid.go`, `internal/plugins/transform/transform.go`

**JWT auth** - validates `Authorization: Bearer <token>` using HMAC or RSA. Rejects with 401 if missing or invalid. Injects claims into the request context.

**API key auth** - checks `X-API-Key` header against a configured list. Supports key rotation by accepting multiple valid keys.

**Rate limiter** - uses a Redis sorted set to implement a sliding window counter. When the limit is exceeded it returns 429 with `Retry-After` header.

**CORS** - evaluates `Origin` against an allowlist and sets the appropriate `Access-Control-*` headers. Handles preflight OPTIONS requests.

**Cache** - caches GET responses in memory (or Redis) keyed by URL + Vary headers. Serves cached responses with `X-Cache: HIT`.

**Circuit breaker** - tracks upstream failure rate. Opens the circuit after a configurable threshold and returns 503 without forwarding the request during the open window.

**Request ID** - generates a UUID and injects it as `X-Request-ID` into both the request and response headers. Used for distributed tracing correlation.

**Transform** - applies request/response transformations: add/remove/rewrite headers, rewrite paths, modify JSON body fields.

**What to test:** For JWT: send a request without a token - assert 401. Send a valid token - assert the chain continues. For rate limiter: send 101 requests against a limit of 100 - assert the 101st returns 429.

### Step 6 - Understand the Circuit Breaker

**File:** `internal/plugins/circuit/breaker.go`

State machine: Closed → Open → Half-Open → Closed.

- **Closed** - normal operation. Failures are counted.
- **Open** - triggered after `failure_threshold` consecutive failures within `failure_window`. All requests return 503 immediately.
- **Half-Open** - after `recovery_timeout`, one probe request is forwarded. If it succeeds, transition to Closed. If it fails, stay Open.

Circuit state is tracked per upstream ID so different routes to the same upstream share the same breaker.

**What to test:** Simulate 5 failures. Assert the circuit opens. Assert the next request returns 503 without hitting the upstream. Wait for `recovery_timeout`. Assert the next request is forwarded (probe).

### Step 7 - Understand Distributed Tracing

**File:** `internal/observability/tracing.go`

`InitTracing()` creates an OTLP trace exporter pointing at a Jaeger (or any OTLP-compatible) endpoint. Every incoming request starts a span. Each plugin adds span events. The upstream HTTP call is a child span. Spans are exported asynchronously.

`ShutdownTracing()` flushes any pending spans before the process exits.

Configure tracing in `configs/gateway.yaml`:
```yaml
tracing:
  enabled: true
  provider: otlp
  endpoint: http://localhost:4318
  sampling_rate: 1.0
```

**What to test:** Set up a test OTLP receiver. Send a request through the gateway. Assert a span is exported with the correct route and upstream attributes.

### Step 8 - Understand Health Checks

**File:** `internal/upstream/healthcheck.go`

A background goroutine periodically sends an HTTP request to each target's health check path. If the check fails `unhealthy_threshold` times in a row, the target is marked unhealthy and removed from the load balancer pool. When checks start passing again (`healthy_threshold` successes), the target is restored.

**What to test:** Start a health check against a target that returns 200. Assert the target is healthy. Change the target to return 503. Assert the target is marked unhealthy after `unhealthy_threshold` failures.

### Step 9 - Understand the Admin API

**File:** `internal/admin/api.go`

A separate HTTP server (port 9090 by default) secured by `X-API-Key` header. Provides full CRUD over routes and upstreams at runtime - changes take effect immediately without restarting.

All admin endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Admin server health |
| GET | /routes | List all routes |
| POST | /routes | Create a route |
| GET | /routes/{id} | Get a route |
| PUT | /routes/{id} | Update a route |
| DELETE | /routes/{id} | Delete a route |
| GET | /upstreams | List all upstreams |
| POST | /upstreams | Create an upstream |
| GET | /upstreams/{id} | Get an upstream |
| PUT | /upstreams/{id} | Update an upstream |
| DELETE | /upstreams/{id} | Delete an upstream |
| GET | /upstreams/{id}/targets | List upstream targets |
| POST | /upstreams/{id}/targets | Add a target |
| DELETE | /upstreams/{id}/targets/{target_id} | Remove a target |
| GET | /metrics | Prometheus metrics snapshot |
| GET | /config | Current running config |
| POST | /config/reload | Reload config from disk |

**What to test:** Use `net/http/httptest` to call `GET /routes` - assert response is a JSON array. Call `POST /routes` with a valid body - assert 201 and the route appears in `GET /routes`.

### Step 10 - Wire Everything in main.go

**File:** `cmd/gateway/main.go`

`main.go`:
1. Parses `--config` flag
2. Loads `configs/gateway.yaml` via `gateway.LoadConfig()`
3. Creates a zap logger
4. Optionally initialises Prometheus metrics
5. Optionally initialises OTLP tracing
6. Creates the gateway server (`gateway.NewServer()`)
7. Starts an `fsnotify`-based config watcher for hot reload
8. Runs the server in a goroutine
9. Waits for `SIGTERM` or `SIGINT`
10. Shuts down gracefully with a timeout

All plugins are registered via `init()` in their packages, triggered by blank imports in `main.go`.

**What to test:** Run `go build ./...` with no errors. Start the server with `make run` and hit `GET /health`.

---

## Running the Project

### 1. Start infrastructure

```bash
make infra-up
```

Starts Redis (port 6379) and Jaeger (port 16686 UI, 4318 OTLP HTTP) via Docker Compose.

### 2. Create the gateway config

```bash
cp configs/gateway.example.yaml configs/gateway.yaml
```

Edit `configs/gateway.yaml` to add your upstream services.

### 3. Copy environment file

```bash
cp .env.example .env
```

### 4. Run the gateway

```bash
make run
```

### 5. Run tests

```bash
make test
```

### 6. Build binary

```bash
make build
```

### 7. Docker build

```bash
make docker-build
```

---

## Gateway API Endpoints

### Traffic Proxy

```
ANY /<configured-route-path>
→ proxied to upstream with plugins applied
```

### Health

```
GET /health   (if configured as a route)
```

### Metrics

```
GET /metrics
→ Prometheus exposition format
```

---

## Admin API Endpoints (port 9090)

All requests require `X-API-Key: <your-admin-key>` header.

```
GET    /health
GET    /routes
POST   /routes             Body: route JSON
GET    /routes/{id}
PUT    /routes/{id}        Body: route JSON
DELETE /routes/{id}

GET    /upstreams
POST   /upstreams
GET    /upstreams/{id}
PUT    /upstreams/{id}
DELETE /upstreams/{id}

GET    /upstreams/{id}/targets
POST   /upstreams/{id}/targets
DELETE /upstreams/{upstream_id}/targets/{target_id}

GET    /metrics
GET    /config
POST   /config/reload
```

---

## Plugin Configuration Reference

```yaml
routes:
  - id: my-route
    paths: ["/api/*"]
    upstream_id: my-upstream
    plugins:
      - name: request-id
      - name: cors
        config:
          allowed_origins: ["https://app.example.com"]
          allowed_methods: [GET, POST]
      - name: jwt-auth
        config:
          secret: "your-jwt-secret"
          algorithm: HS256
      - name: rate-limit
        config:
          limit: 1000
          window: 1m
          key_by: ip    # ip | user | api-key
      - name: circuit-breaker
        config:
          failure_threshold: 5
          failure_window: 30s
          recovery_timeout: 60s
      - name: cache
        config:
          ttl: 30s
          cache_methods: [GET]
      - name: transform
        config:
          request_headers:
            add:
              X-Forwarded-By: gateway
            remove:
              - X-Internal-Token
```

---

## Environment Variables

See `.env.example` for the full list with descriptions.

---

## Project Structure

```
10-api-gateway/
├── cmd/
│   └── gateway/
│       └── main.go                    # Server entrypoint
├── internal/
│   ├── admin/
│   │   └── api.go                     # Admin REST API
│   ├── config/
│   │   └── watcher.go                 # Hot config reload (fsnotify)
│   ├── gateway/
│   │   ├── config.go                  # Config loader and validator
│   │   ├── server.go                  # HTTP server, proxy handler
│   │   ├── types.go                   # Type aliases
│   │   ├── buffer.go                  # Buffer pool for proxying
│   │   ├── grpc.go                    # gRPC reverse proxy
│   │   ├── tls.go                     # TLS configuration
│   │   └── websocket.go               # WebSocket proxy
│   ├── observability/
│   │   ├── logger.go                  # Zap logger setup
│   │   ├── metrics.go                 # Prometheus metrics
│   │   └── tracing.go                 # OTLP tracing setup
│   ├── plugin/
│   │   ├── plugin.go                  # Plugin interface
│   │   ├── chain.go                   # Plugin chain runner
│   │   └── registry.go               # Plugin factory registry
│   ├── plugins/
│   │   ├── auth/
│   │   │   ├── jwt.go
│   │   │   └── apikey.go
│   │   ├── cache/cache.go
│   │   ├── circuit/breaker.go
│   │   ├── cors/cors.go
│   │   ├── ratelimit/ratelimit.go
│   │   ├── requestid/requestid.go
│   │   └── transform/transform.go
│   ├── router/
│   │   ├── router.go
│   │   ├── matcher.go
│   │   └── trie.go
│   └── upstream/
│       ├── upstream.go
│       ├── pool.go
│       ├── loadbalancer.go
│       ├── consistent_hash.go
│       ├── random.go
│       └── healthcheck.go
├── test/
│   └── integration/
│       └── gateway_test.go
├── configs/
│   └── gateway.example.yaml
├── docker-compose.yml
├── Makefile
└── .env.example
```
