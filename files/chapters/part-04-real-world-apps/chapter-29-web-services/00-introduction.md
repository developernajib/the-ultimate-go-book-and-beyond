# Chapter 29: Building Web Services

*"Go's HTTP server is production-ready out of the box. Most other languages wish they could say the same."* - Anonymous

Every modern application is a network of web services communicating over HTTP. REST APIs power mobile apps, internal microservices, third-party integrations, and public developer platforms. Getting HTTP right - handling timeouts, graceful shutdown, connection pooling, middleware composition, and TLS - is not optional at production scale. A misconfigured `WriteTimeout` can exhaust goroutines under load. Missing CORS headers block legitimate clients. Absent request size limits invite denial-of-service. The difference between a toy HTTP server and a production one lives entirely in these details.

Go's `net/http` package is one of the most battle-tested HTTP implementations in any programming language. It handles connection lifecycle, keep-alive management, and concurrent request dispatch natively, without needing an external application server. Go 1.22's enhanced routing - with method-based dispatch and path parameters in the standard library - closes the gap with third-party routers for most use cases, while libraries like Chi and Gorilla Mux remain available for more complex routing needs.

This chapter covers every layer of a production-grade Go web service: server configuration and tuning, routing and middleware pipelines, request parsing and validation, structured error handling, session management, WebSocket support, and a complete testing strategy from unit to end-to-end. The patterns here reflect how Cloudflare, Dropbox, and Twitch build HTTP infrastructure that handles millions of requests per minute reliably.

**What you'll learn in this chapter:**
- Configuring production HTTP servers with proper read/write timeouts, graceful shutdown, TLS termination, and connection limits
- Implementing sophisticated routing with Go 1.22+ stdlib, Chi, and Gorilla Mux including path parameters and route groups
- Building a composable middleware pipeline: logging, authentication, CORS, rate limiting, and distributed tracing
- Handling all request types professionally: JSON bodies, URL-encoded forms, multipart file uploads, and query parameters
- Designing consistent, structured error responses with appropriate HTTP status codes and client-safe messages
- Managing sessions securely with HttpOnly and SameSite cookies, CSRF protection, and session invalidation
- Integrating WebSocket support for real-time features with connection lifecycle management and broadcasting
- Testing HTTP handlers with `httptest`, writing integration tests with a live server, and load testing critical endpoints

**Why this matters at scale:**
Cloudflare's network handles tens of millions of HTTP requests per second, and the Go services around that edge (cloudflared, their DNS lineage, the control plane) rely on the same server configuration and middleware patterns taught in this chapter. Dropbox moved performance-critical backend services from Python to Go, escaping the GIL and using goroutine-based concurrency to cut latency and raise throughput under equivalent load.

**Prerequisites:** Chapter 5 (Interfaces & Dependency Injection), Chapter 14 (Context & Cancellation), Chapter 39 (Authentication & Authorization)

### Junior to FAANG: Entering HTTP Services With No Prior Scale Experience

If you have never shipped a public HTTP service, the jump from "my handler returns JSON on localhost" to "my handler serves a real user base" is where most new engineers stall. Start by internalizing the request lifecycle end to end. A TCP connection arrives at the kernel, the Go server accepts it, reads headers, routes the request, invokes your handler, streams the response, and either reuses the connection (keep-alive) or closes it. Every production bug you will encounter in your first year lives somewhere in that path. Read `net/http` source for `Server.Serve`, `conn.serve`, and `ResponseWriter.WriteHeader`. Thirty minutes of reading saves a week of debugging.

Worked example, a tiny but production-shaped server. Notice the explicit timeouts, the `context` propagation, and the graceful shutdown. Shipping this template on day one already puts you ahead of many mid-level engineers.

```go
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    srv := &http.Server{
        Addr:              ":8080",
        Handler:           mux,
        ReadHeaderTimeout: 5 * time.Second,
        ReadTimeout:       15 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
        MaxHeaderBytes:    1 << 20,
    }
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()
    go func() { _ = srv.ListenAndServe() }()
    <-ctx.Done()
    shutCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    _ = srv.Shutdown(shutCtx)
}
```

Interview-entry framing. For SWE I or SWE II loops, expect questions like "walk me through what happens when a client sends a POST with a 10 MB body and your `ReadTimeout` is 1 second." The answer must cover the `io.EOF` or timeout error, the partially written response, the client-visible 408 or reset, and why `MaxBytesReader` exists. If you can explain that fluently, you will clear the HTTP bar at every FAANG.

First-job context. Your first real service will have three problems nobody warned you about. First, somebody will deploy a handler that blocks on a downstream call with no context deadline, and a spike in that downstream will exhaust your goroutines. Second, a teammate will log the full request body including PII. Third, a load balancer health check will hammer your `/healthz` every second and pollute your metrics. Write your template to solve all three from the start.

### Senior at FAANG: Platform Thinking for HTTP at Organizational Scale

At staff and principal level, you are not writing handlers. You are writing the ADRs and platform contracts that determine how hundreds of services across the org write handlers. The questions shift from "how do I serve HTTP" to "what is the shared substrate, who owns it, how does it evolve, and how do we migrate 800 services off the old one without a two-year freeze."

Platform contract, the minimum a Go HTTP service at FAANG scale must expose.

1. A `/healthz` and `/readyz` split where `/readyz` participates in load-balancer drain.
2. OTEL-compliant trace propagation on both ingress and egress, with `traceparent` preserved across middleware.
3. Structured logs with `trace_id`, `span_id`, `tenant_id`, `request_id`, emitted at INFO for request completion and ERROR with a stable error code for failures.
4. RED metrics (rate, errors, duration) exposed as Prometheus histograms with SLO-aligned buckets, plus a saturation gauge for in-flight requests.
5. A panic recovery middleware that emits a structured error, records a metric, and never leaks the stack to the client.
6. Request-size caps, header caps, and per-route timeout overrides, all declarative.
7. A graceful-shutdown contract that drains existing connections for `terminationGracePeriodSeconds - 5s` before closing listeners.

Framework selection ADR template. At scale you cannot let every team pick Gin, Echo, Fiber, Chi, or raw `net/http` based on taste. The canonical staff-level ADR weighs the axes below. net/http plus Chi remains the FAANG default because Fiber's `fasthttp` core does not speak HTTP/2, breaks streaming semantics, and has subtly different `Request` semantics that fracture shared middleware. Gin's middleware API is not `http.Handler` compatible which forces a parallel ecosystem. Echo sits in between. The staff call is almost always "net/http with a thin router (Chi or 1.22 stdlib), wrap with org middleware, ban alternatives via CI lint." Write the ADR so the reasoning is durable after you rotate.

HTTP/2 and HTTP/3 rollout playbook. HTTP/2 you get for free on TLS via `ListenAndServeTLS`. HTTP/3 (QUIC) in 2026 is driven by `quic-go` through a reverse proxy tier or an ingress like Envoy or Cloudflare. The staff roadmap typically looks like year one enable h2 everywhere and measure, year two roll h3 at the edge behind a feature flag per route class, year three push h3 to internal east-west where your service mesh supports it. Gotchas. `WriteTimeout` in `net/http` is per-connection for h1 but per-stream semantics differ under h2, and long-lived server-push or SSE will trip naive timeout middleware. Bake a `http.ResponseController` based timeout helper into the platform so handlers do not roll their own.

TLS termination architecture. Three canonical topologies. Edge-terminated (Cloudflare, ALB, GCLB) with plaintext to pods is simplest but fails compliance for PCI and HIPAA east-west. Mesh-terminated (Istio, Linkerd, Consul) with mTLS between pods is the FAANG default for regulated workloads. Sidecar-terminated per pod is a hybrid. The ADR should pick one per environment class (public-edge, internal-api, regulated) and document who owns cert rotation (typically a platform team running cert-manager with a 60-day rotation and 14-day overlap). Pin cipher suites to TLS 1.3 only in 2026, disable 0-RTT for state-changing endpoints because of replay risk.

Graceful shutdown under Kubernetes, the full contract. The pod receives SIGTERM. `preStop` runs first and sleeps 5 seconds to let endpoints propagate. The process then flips `/readyz` to 503 while `/livez` stays 200. Existing connections continue until drained or timeout. `Server.Shutdown` is called with a deadline shorter than `terminationGracePeriodSeconds` to leave slack for SIGKILL. Long-lived WebSocket connections need a broadcast "please reconnect" frame because `Shutdown` will not forcibly close them. Codify this in a shared `shutdown.Manager` so every service inherits the same behavior. One of the most common FAANG outages is a deploy that drops 0.5 percent of requests because somebody forgot the `preStop` sleep.

Middleware ordering ADR. Order matters and is not obvious. The canonical stack from outermost to innermost. Panic recovery, then request ID generation, then OTEL span start, then structured logging (so logs carry the trace), then metrics (so metrics see the true latency including auth), then timeout, then body-size limit, then CORS, then auth, then rate limit (per user requires auth first), then idempotency-key check, then the handler. Document this order in a platform README and enforce it via a `router.Build(middlewares...)` constructor that rejects misordered stacks.

Structured error contracts. Adopt RFC 7807 Problem Details as the org-wide error envelope. Every service returns `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, plus a stable `code` field for machine routing. This is the single change that pays the most dividends. Client teams stop parsing strings, SRE dashboards can group by `code`, and incident response can trace one `code` across every service that returns it.

Idempotency keys. For any POST that creates or charges, require an `Idempotency-Key` header, store a hash of the request plus the response for 24 hours in Redis, and replay on collision. Stripe published the canonical pattern. Make it platform middleware, not per-handler.

Rate-limit hierarchies. Layer per-IP at the edge (WAF), per-API-key at the gateway, per-user inside the service, and per-tenant at the database connection pool. Use a token bucket in Redis with a Lua script for the middle layers. Document the escalation path when one layer trips so incident commanders know which knob to turn.

Observability SLOs. Every HTTP service publishes a latency SLO (p99 under N ms) and an availability SLO (99.9 percent non-5xx over 28 days). RED metrics feed burn-rate alerts at 2 percent and 5 percent per hour. A staff engineer owns the SLO catalog and reviews every new service onboarding.

Staff archetypes in HTTP platform work. The Architect writes the net/http vs framework ADR and defends it in design review. The Migrator leads the three-year "retire the legacy framework" program with a deprecation timeline, a codemod tool, and a per-service dashboard. The Incident Commander runs the retro when HTTP/2 PING flood CVE hits and decides whether to hotfix the stdlib or disable h2 at the edge. The Educator writes the onboarding docs and runs the quarterly "HTTP internals" guild. Pick the archetype that matches your promo packet and lean in.

Multi-year roadmap sketch. Year one, unify on net/http plus Chi, land the platform middleware, reach 100 percent OTEL coverage. Year two, roll HTTP/3 at the edge, migrate session storage from cookie-only to encrypted cookie with server-side shadow. Year three, move east-west to mesh-mTLS, retire the last Gin services, adopt RFC 7807 org-wide. Year four, measure the platform impact in SLO improvement and incident reduction, write the retrospective that becomes the next staff engineer's onboarding reading.

---
