## Exercises

1. **REST API**: Build a complete CRUD API with authentication.

2. **Middleware Stack**: Create a reusable middleware stack with logging, auth, and rate limiting.

3. **WebSocket Chat**: Build a real-time chat application using WebSockets.

4. **File Upload Service**: Create a file upload service with size limits and type validation.

5. **API Gateway**: Build a simple API gateway with routing and rate limiting.

### Junior to FAANG: Completing These as Offer-Generating Portfolio Pieces

Treat each exercise as a two-week project, not a weekend hack.

REST API acceptance criteria. Postgres persistence via pgx. JWT auth via RS256 with JWKS rotation. RFC 7807 errors. OpenAPI schema published. Table-driven handler tests with httptest. Integration tests via testcontainers. Dockerfile and docker-compose. `hey` benchmark in README showing p99 under 50 ms on your laptop. README explaining every architectural choice.

Middleware stack acceptance criteria. Canonical order enforced by a typed builder. Unit tests per middleware. Integration test demonstrating the full chain. Observability (slog with trace_id, a `/metrics` endpoint via promhttp). Documentation of the order with rationale for each position.

WebSocket chat acceptance criteria. Heartbeat with 30-second ping. Reconnect-tolerant clients with jittered backoff. Redis pubsub for cross-pod fanout. Message history from Redis stream (last 50). Auth via Bearer token on upgrade. Graceful shutdown broadcasting "reconnect" frame. Load test with 1000 simulated clients.

File upload service acceptance criteria. `MaxBytesReader` on body. `http.DetectContentType` server-side (do not trust header). Virus scan stub (call ClamAV in Docker). Presigned S3 URLs for actual upload, your service only handles metadata. Per-user quota enforced. Audit log of every upload.

API gateway acceptance criteria. Route table loaded from config. Per-route timeout and retry budget. Circuit breaker per upstream. Rate limit per API key via Redis. Observability (RED metrics per route, trace propagation). Health checks with upstream-aware readiness (if 50 percent of upstreams are down, gateway goes 503).

Each of these on your GitHub with a thoughtful README is worth more than any certification.

### Senior at FAANG: Exercises as Staff-Level Design Exercises

Each exercise has a staff-level version where the coding is trivial and the design is the bar.

Staff REST API exercise. Design the REST API platform for 200 services. What is shared (router, middleware, error envelope, observability). What is service-owned (business logic, domain models). How do teams onboard (templates, codemods, CI gates). What breaks if a platform bump ships with a regression (canary, rollback, per-service opt-in). Present as an ADR plus a one-year roadmap.

Staff middleware exercise. Design the middleware governance. Who owns the canonical chain. What is the process to add a new middleware. How do teams opt out when a middleware is wrong for their use case. How do you measure adoption. How do you migrate when the chain changes. Deliverable is a platform-team charter plus a service-team contract.

Staff WebSocket exercise. Design WS infrastructure for 10 million concurrent connections across three regions. Pod sizing (how many connections per pod). Fan-out bus (Redis vs NATS vs Kafka vs direct mesh). Session state (in-pod vs external store). Deployment strategy (how to deploy without dropping connections). Observability (what SLOs, what alerts). Cost model. Deliverable is a design doc with diagrams and a capacity spreadsheet.

Staff file upload exercise. Design a tenant-isolated file upload platform supporting multi-region, lifecycle policies (auto-delete after N days), encryption at rest with per-tenant KMS keys, audit logging for compliance (SOC 2, HIPAA), access control via signed URLs with expiry. Present the ADR comparing building vs buying (S3 direct vs Cloudflare R2 vs Uploadcare).

Staff API gateway exercise. Design the org API gateway. Envoy-based vs Go-based vs vendor (Kong, Apigee). Trade-offs on latency, feature velocity, operational load, vendor lock. Config distribution (xDS vs config files vs custom control plane). Authentication model (JWT validation at edge vs delegate to services). Rate-limit hierarchy. Canary and traffic-shifting primitives. Deliverable is a three-year roadmap for the gateway including migration plan if you choose differently from current state.

Interview use. Bring one of these staff-level designs to a principal loop. Present it as a case study. Walk through the trade-offs. That single 30-minute conversation often determines the promotion signal.

Peer critique protocol. Pair with another senior engineer. Each of you picks an exercise, writes the staff-level design, swap, critique. The critique skill is what separates staff engineers from senior engineers who never promote. Practice it weekly until it is second nature.

Publishing pipeline. A good staff-level design deserves a blog post or conference talk. Target Go Time, FOSDEM, GopherCon, or your company engineering blog. External publication compounds the impact of the work and is the highest-value career move beyond the immediate output.

