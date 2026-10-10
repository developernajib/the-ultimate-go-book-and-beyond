## Web Service Architecture

The architecture below shows the request lifecycle from the network listener through the middleware stack, router, handler, service, and repository layers. Each boundary is an abstraction point that can be independently tested, replaced, or scaled.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       WEB SERVICE ARCHITECTURE                                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Client                                                                          │
│    │                                                                             │
│    ▼                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                        Load Balancer / Reverse Proxy                    │     │
│  │                    (nginx, HAProxy, AWS ALB, Cloudflare)                │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │     │
│  │  │ TLS Term    │  │ Rate Limit  │  │ Static CDN  │                      │     │
│  │  │ (SSL/TLS)   │  │ (Global)    │  │ (Assets)    │                      │     │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                      │     │
│  └────────────────────────────────┬────────────────────────────────────────┘     │
│                                   │                                              │
│                                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         Go HTTP Server                                  │     │
│  │                                                                         │     │
│  │  http.Server{                                                           │     │
│  │      Addr:           ":8080",                                           │     │
│  │      Handler:        router,                                            │     │
│  │      ReadTimeout:    15s,       // Time to read request                 │     │
│  │      WriteTimeout:   15s,       // Time to write response               │     │
│  │      IdleTimeout:    60s,       // Keep-alive timeout                   │     │
│  │      MaxHeaderBytes: 1MB,       // Max header size                      │     │
│  │  }                                                                      │     │
│  │                                                                         │     │
│  └────────────────────────────────┬────────────────────────────────────────┘     │
│                                   │                                              │
│                                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                      Middleware Pipeline                                │     │
│  │                                                                         │     │
│  │  Request ──► [Recovery] ──► [RequestID] ──► [Logger] ──► [CORS]         │     │
│  │                                                                         │     │
│  │          ──► [RateLimit] ──► [Auth] ──► [Timeout] ──► Handler           │     │
│  │                                                                         │     │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │     │
│  │  │ Middleware Order Matters:                                        │   │     │
│  │  │                                                                  │   │     │
│  │  │ 1. Recovery    - Catch panics, prevent server crash              │   │     │
│  │  │ 2. RequestID   - Assign unique ID for tracing                    │   │     │
│  │  │ 3. Logger      - Log request start (needs RequestID)             │   │     │
│  │  │ 4. CORS        - Handle preflight before auth                    │   │     │
│  │  │ 5. RateLimit   - Reject before expensive operations              │   │     │
│  │  │ 6. Auth        - Authenticate/authorize                          │   │     │
│  │  │ 7. Timeout     - Cancel slow requests                            │   │     │
│  │  │ 8. Handler     - Business logic                                  │   │     │
│  │  └──────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                         │     │
│  └────────────────────────────────┬────────────────────────────────────────┘     │
│                                   │                                              │
│                                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                           Router                                        │     │
│  │                                                                         │     │
│  │   /                                                                     │     │
│  │   ├── /api                                                              │     │
│  │   │   ├── /v1                                                           │     │
│  │   │   │   ├── GET    /users           → listUsers                       │     │
│  │   │   │   ├── POST   /users           → createUser                      │     │
│  │   │   │   ├── GET    /users/{id}      → getUser                         │     │
│  │   │   │   ├── PUT    /users/{id}      → updateUser                      │     │
│  │   │   │   ├── DELETE /users/{id}      → deleteUser                      │     │
│  │   │   │   ├── GET    /users/{id}/posts→ getUserPosts                    │     │
│  │   │   │   └── /posts                                                    │     │
│  │   │   │       ├── GET    /            → listPosts                       │     │
│  │   │   │       └── POST   /            → createPost                      │     │
│  │   │   └── /v2                                                           │     │
│  │   │       └── ... (versioned endpoints)                                 │     │
│  │   ├── /health                 → healthCheck                             │     │
│  │   ├── /ready                  → readinessCheck                          │     │
│  │   └── /metrics                → prometheusHandler                       │     │
│  │                                                                         │     │
│  └────────────────────────────────┬────────────────────────────────────────┘     │
│                                   │                                              │
│                                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                          Handler Layer                                  │     │
│  │                                                                         │     │
│  │  ┌─────────────────────────────────────────────────────────────────────┐│     │
│  │  │                    Request Processing                               ││     │
│  │  │                                                                     ││     │
│  │  │  1. Parse Request                                                   ││     │
│  │  │     - JSON body     → json.Decoder                                  ││     │
│  │  │     - Form data     → r.ParseForm()                                 ││     │
│  │  │     - File upload   → r.ParseMultipartForm()                        ││     │
│  │  │     - Path params   → chi.URLParam(r, "id")                         ││     │
│  │  │     - Query params  → r.URL.Query().Get("page")                     ││     │
│  │  │                                                                     ││     │
│  │  │  2. Validate Input                                                  ││     │
│  │  │     - Required fields                                               ││     │
│  │  │     - Type checking                                                 ││     │
│  │  │     - Business rules                                                ││     │
│  │  │                                                                     ││     │
│  │  │  3. Call Service Layer                                              ││     │
│  │  │     - Business logic                                                ││     │
│  │  │     - Database operations                                           ││     │
│  │  │     - External API calls                                            ││     │
│  │  │                                                                     ││     │
│  │  │  4. Format Response                                                 ││     │
│  │  │     - Set Content-Type                                              ││     │
│  │  │     - Set status code                                               ││     │
│  │  │     - Encode body (JSON/XML/etc)                                    ││     │
│  │  │                                                                     ││     │
│  │  └─────────────────────────────────────────────────────────────────────┘│     │
│  │                                                                         │     │
│  └────────────────────────────────┬────────────────────────────────────────┘     │
│                                   │                                              │
│                                   ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                        Service Layer                                    │     │
│  │                                                                         │     │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                │     │
│  │  │  UserService  │  │  PostService  │  │  AuthService  │                │     │
│  │  │               │  │               │  │               │                │     │
│  │  │ - Create      │  │ - Create      │  │ - Login       │                │     │
│  │  │ - Get         │  │ - Get         │  │ - Logout      │                │     │
│  │  │ - Update      │  │ - Update      │  │ - Verify      │                │     │
│  │  │ - Delete      │  │ - Delete      │  │ - Refresh     │                │     │
│  │  │ - List        │  │ - List        │  │               │                │     │
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘                │     │
│  │          │                  │                  │                        │     │
│  │          └──────────────────┼──────────────────┘                        │     │
│  │                             │                                           │     │
│  └─────────────────────────────┼───────────────────────────────────────────┘     │
│                                │                                                 │
│                                ▼                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         Data Layer                                      │     │
│  │                                                                         │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │     │
│  │  │ PostgreSQL  │  │   Redis     │  │   S3/GCS    │ │ External API│      │     │
│  │  │ (Primary)   │  │  (Cache)    │  │  (Files)    │ │  (3rd Party)│      │     │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘     │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

                          REQUEST LIFECYCLE

┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   1. Accept Connection                                                          │
│      └─► net.Listener.Accept()                                                  │
│                                                                                 │
│   2. TLS Handshake (if HTTPS)                                                   │
│      └─► tls.Server.Handshake()                                                 │
│                                                                                 │
│   3. Read Request                                                               │
│      └─► http.ReadRequest() within ReadTimeout                                  │
│                                                                                 │
│   4. Parse Headers                                                              │
│      └─► Check MaxHeaderBytes, parse headers                                    │
│                                                                                 │
│   5. Route Match                                                                │
│      └─► Find handler for method + path                                         │
│                                                                                 │
│   6. Middleware Chain                                                           │
│      └─► Execute middleware in order                                            │
│                                                                                 │
│   7. Handler Execution                                                          │
│      └─► Parse body, validate, process                                          │
│                                                                                 │
│   8. Write Response                                                             │
│      └─► Write within WriteTimeout                                              │
│                                                                                 │
│   9. Close or Keep-Alive                                                        │
│      └─► Close connection or wait IdleTimeout                                   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Junior to FAANG: Reading the Diagram Critically

The box diagram above is correct and hides roughly half the real production architecture. Add these boxes mentally as you read. Between the load balancer and your Go server sits a service mesh sidecar (Envoy) in most FAANG clusters, which terminates mTLS, adds `x-request-id`, and enforces outbound policy. Between the router and the handler sits a trace-context extraction step that pulls `traceparent` off the request and seeds the context. Between the service layer and the data layer sits a connection pool plus a retry/circuit-breaker wrapper. The cache sits both in front of and beside the database, not only beside it. Draw your own version including these and put it on the wall of your cubicle. When an incident hits, you will instinctively know which layer to probe.

Practical walkthrough for a new engineer. Pick the `POST /api/v1/users` route and trace one request end to end. Write down the exact goroutine that handles it (spawned by `http.Server.Serve` per connection), the `context.Context` chain (request context, canceled on client disconnect), the downstream calls (Postgres via `database/sql`, Redis via `go-redis`), and the metrics each layer emits. This exercise, done once per service you own, is worth ten skimmed architecture docs.

### Senior at FAANG: Architecture Decisions Behind the Diagram

Load balancer choice. ALB vs NLB vs Envoy vs Cloudflare is not a preference, it is a compliance and latency decision. ALB does layer-7 with WAF hooks but adds 10 to 20 ms. NLB is layer-4 only and is the right call for high-throughput east-west. Envoy in a mesh gives you mTLS, retries, and outlier detection but adds operational load. The staff ADR captures "what tier needs what" and enforces it via Terraform modules.

Router placement debate. Embedding the router in the Go binary (Chi) vs pushing routing to the mesh (Envoy route table) is a genuine staff-level debate. In-binary routing is faster to iterate, one PR ships. Mesh routing gives you traffic shifting, canaries, and shadowing without redeploying. The FAANG compromise, coarse routing at the mesh (by service and major version), fine routing in the binary (by path). Document the boundary so teams do not fight over it.

Service and repository layering at scale. The diagram shows UserService, PostService, AuthService as peers. In a large org the real question is whether these live in one monorepo service or separate services, and whether the service layer is a Go package or an RPC boundary. The principled answer. Start coarse (one service, multiple packages), split on proven scaling need (rate, team ownership, deploy cadence, data sovereignty), never split on aesthetics. Write the splitting criteria into the platform handbook so new teams do not prematurely fragment.

Data layer contracts. The Postgres, Redis, S3, external API boxes each need platform-level contracts. Postgres. Use pgx, connection pool capped at `max_connections / num_replicas` minus headroom, read replicas routed by a `READ` context tag. Redis. Single-digit-ms SLA, treat as cache only, never durable source of truth. S3. All writes with SSE-KMS, presigned URLs expire in 15 minutes max, bucket policies deny public by default. External API. Wrap every client in a circuit breaker (`sony/gobreaker`), per-upstream timeout, retry budget, and OTEL instrumentation. Publish these as platform libraries with one-line adoption.

Request lifecycle pitfalls at FAANG scale. Step 2 (TLS handshake) under CVE pressure becomes a fleetwide rotation event, practice it quarterly as a game day. Step 4 (parse headers) is where HTTP request smuggling lives, pin `http.Server.DisableGeneralOptionsHandler = true` and never trust `Transfer-Encoding` from untrusted sources. Step 6 (middleware chain) is where 90 percent of incidents originate because of ordering bugs, lock the order. Step 9 (close or keep-alive) interacts with `IdleTimeout` and load-balancer idle settings. Set server `IdleTimeout` slightly lower than LB idle to ensure the server initiates close, which avoids the "connection reset" races that plague naive deployments.

Capacity planning model. For each service, publish a sizing sheet. Peak RPS, p99 latency budget, average request CPU ms, memory per in-flight request, goroutines per RPS. From these, compute replica count with a 2x safety margin. Re-derive quarterly. Staff engineers own the capacity model, SREs execute against it. Missing capacity models is the silent killer of FAANG reliability. Every oncall page about "service is slow" eventually traces back to someone capacity-planning on gut feel.

Multi-region architecture overlay. Add a box above the load balancer for GeoDNS or Anycast, a box for the cross-region data-replication path (Aurora Global, Spanner, DynamoDB Global Tables), and an indicator for which requests are region-pinned vs region-neutral. Session stickiness, write affinity, and failover behavior belong in this overlay, not in the per-service diagram. Maintain a single org-wide multi-region pattern catalog so teams pick a proven pattern rather than invent a new one.

---
