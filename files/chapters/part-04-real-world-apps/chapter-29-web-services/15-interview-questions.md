## Interview Questions

### Question 1: How would you design a rate limiter for a high-traffic API?

**Answer:**

A production rate limiter applies limits at multiple tiers, global, per-endpoint, and per-user, to handle different abuse scenarios. The global limiter is checked first because it is the cheapest. Per-user limits use a concurrent map of token bucket limiters keyed by user ID.

```go
// Multi-tier rate limiting with different limits for different endpoints
type RateLimiterConfig struct {
    // Global limits
    GlobalRPS     int
    GlobalBurst   int

    // Per-user limits
    UserRPS       int
    UserBurst     int

    // Per-endpoint limits
    EndpointLimits map[string]EndpointLimit
}

type EndpointLimit struct {
    RPS   int
    Burst int
}

type MultiTierRateLimiter struct {
    global    *rate.Limiter
    users     *sync.Map // map[string]*rate.Limiter
    endpoints map[string]*rate.Limiter
    config    RateLimiterConfig
}

func (rl *MultiTierRateLimiter) Allow(userID, endpoint string) bool {
    // Check global limit first (cheapest)
    if !rl.global.Allow() {
        return false
    }

    // Check endpoint-specific limit
    if epLimiter, ok := rl.endpoints[endpoint]; ok {
        if !epLimiter.Allow() {
            return false
        }
    }

    // Check user-specific limit
    userLimiter := rl.getUserLimiter(userID)
    return userLimiter.Allow()
}
```

For distributed systems where multiple server instances share rate limits, use Redis-based rate limiting with a sliding window algorithm:

```go
// Redis-based distributed rate limiter using sliding window
func (rl *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    now := time.Now().UnixMilli()
    windowStart := now - rl.windowMs

    pipe := rl.client.Pipeline()

    // Remove old entries
    pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart))

    // Count current window
    countCmd := pipe.ZCard(ctx, key)

    // Add current request
    pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: now})

    // Set expiry
    pipe.Expire(ctx, key, time.Duration(rl.windowMs)*time.Millisecond)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return false, err
    }

    return countCmd.Val() < int64(rl.limit), nil
}
```

**What FAANG expects:** a discussion of the algorithm tradeoffs (fixed window, sliding window log, sliding window counter, token bucket, leaky bucket), where each lives (in-process vs Redis vs edge/Envoy), how you handle clock skew across nodes, what happens on Redis outage (fail-open vs fail-closed, and why that is a product decision), and how you surface `Retry-After` + `X-RateLimit-*` headers to clients. Bonus points for mentioning probabilistic algorithms like redis-cell (GCRA) for O(1) memory per key.

**Follow-ups:**
1. How would you rate-limit by identity when a single user sits behind a NAT with shared IP? (hint: authenticated user ID is the right key, IP is a fallback)
2. A bug causes your Redis limiter to double-count. How do you detect it in production before users complain?
3. How does your limiter behave during a Redis failover, and what SLO does that commit you to?

### Question 2: Explain graceful shutdown and why it matters

**Answer:**

Graceful shutdown stops accepting new connections while letting in-flight requests finish within a deadline. Without it, a deploy kills active requests, causing 502 errors for clients mid-request.

```go
func main() {
    server := &http.Server{
        Addr:    ":8080",
        Handler: router,
    }

    // Channel for shutdown signals
    shutdown := make(chan os.Signal, 1)
    signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

    // Start server
    go func() {
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    // Wait for shutdown signal
    <-shutdown
    log.Println("Shutting down...")

    // Create deadline for graceful shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Stop accepting new connections
    // Wait for existing connections to finish
    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Forced shutdown: %v", err)
    }

    // Close other resources (database, message queues, etc.)
    db.Close()

    log.Println("Server stopped")
}
```

Key considerations:
1. **Stop accepting new connections** - Shutdown() does this automatically
2. **Complete in-flight requests** - Give them time to finish
3. **Close dependencies** - Database connections, message queues
4. **Health check awareness** - Return unhealthy during shutdown so load balancer routes traffic away

**What FAANG expects:** a precise ordering: flip readiness to unhealthy, wait at least one LB probe interval (usually 10-30s) so the LB stops sending new traffic, then call `server.Shutdown(ctx)`, then drain worker pools and DB pools. Mention `context.Context` propagation so in-flight handlers observe cancellation, the double-signal pattern (second SIGTERM forces immediate exit), and SIGKILL's 30-second grace period in Kubernetes (`terminationGracePeriodSeconds`). Bonus: connection draining for long-lived WebSockets, where you push a "reconnect" frame before closing.

**Follow-ups:**
1. What happens to a request that started at T-5s when shutdown begins at T=0 with a 3s deadline?
2. Why is `http.ErrServerClosed` not treated as an error after `Shutdown`?
3. How do you handle graceful shutdown for a gRPC server and a Kafka consumer in the same binary?

### Question 3: How do you handle API versioning?

**Answer:**

Three approaches are common, each with different tradeoffs for discoverability, caching, and backward compatibility:

**1. URL Path Versioning (Most Common)**
```go
r.Route("/api/v1", func(r chi.Router) {
    r.Get("/users", v1.ListUsers)
})
r.Route("/api/v2", func(r chi.Router) {
    r.Get("/users", v2.ListUsers) // Different response format
})
```

**2. Header Versioning (Stripe's Approach)**
```go
func VersionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := r.Header.Get("API-Version")
        if version == "" {
            version = "2024-01-01" // Default to latest
        }
        ctx := context.WithValue(r.Context(), "api_version", version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

**3. Content Negotiation**
```go
// Accept: application/vnd.myapi.v2+json
func handler(w http.ResponseWriter, r *http.Request) {
    accept := r.Header.Get("Accept")
    if strings.Contains(accept, "v2") {
        // Respond with v2 format
    } else {
        // Respond with v1 format
    }
}
```

**What FAANG expects:** recognition that versioning is a product contract, not a code organization problem. The real hard questions are deprecation policy (how long do you support v1 after v2 ships), how you migrate clients (dual-writing, shadow reads, feature-flagged rollout), and how you avoid shipping a v3 at all through additive, backward-compatible field evolution (Protobuf-style optional fields, tolerant readers). Mention Stripe's date-based versioning as a way to ship per-account pinning without branching the entire API tree.

**Follow-ups:**
1. A field's semantics changed but its name and type did not. How do you version that?
2. How do you version a public webhook payload you send to customers?
3. What's your test strategy for guaranteeing v1 compatibility after 50 v2-only code changes?

### Question 4: What's the difference between authentication and authorization middleware?

**Answer:**

```go
// Authentication: WHO are you?
// Verifies identity and adds user to context
func Authenticate(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := extractToken(r)

        claims, err := validateToken(token)
        if err != nil {
            http.Error(w, "Unauthorized", 401)
            return
        }

        ctx := context.WithValue(r.Context(), "user", claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Authorization: WHAT can you do?
// Checks if authenticated user has permission
func Authorize(requiredRole string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := r.Context().Value("user").(*Claims)

            if user.Role != requiredRole {
                http.Error(w, "Forbidden", 403) // Not 401!
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage
r.Route("/admin", func(r chi.Router) {
    r.Use(Authenticate)              // First: verify identity
    r.Use(Authorize("admin"))        // Then: check permissions
    r.Get("/users", adminListUsers)
})
```

**What FAANG expects:** the 401 vs 403 distinction (401 = no or bad credentials, challenge the client. 403 = valid credentials but not enough rights), avoidance of stringly-typed context keys (use an unexported `type userCtxKey struct{}` to prevent collisions and accidental leakage), and defense-in-depth: authorization is re-checked at the service layer against the actual resource (ownership, tenant scoping), not only at the edge. Bonus: mention JWT pitfalls (don't trust `alg: none`, validate `kid` against a pinned JWKS, short access token + refresh token rotation) and RBAC vs ABAC tradeoffs.

**Follow-ups:**
1. Where do you enforce tenant isolation, in middleware or at the query layer, and why both?
2. How do you revoke a JWT before its `exp` without moving to server-side sessions?
3. A user loses "admin" role mid-session. How quickly does that propagate with your JWT design?

### Question 5: How would you implement request tracing across microservices?

**Answer:**

```go
// Use OpenTelemetry for distributed tracing
func TracingMiddleware(serviceName string) func(http.Handler) http.Handler {
    tracer := otel.Tracer(serviceName)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract trace context from incoming request
            ctx := otel.GetTextMapPropagator().Extract(
                r.Context(),
                propagation.HeaderCarrier(r.Header),
            )

            // Start a new span
            ctx, span := tracer.Start(ctx, r.URL.Path,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    attribute.String("http.method", r.Method),
                    attribute.String("http.url", r.URL.String()),
                ),
            )
            defer span.End()

            // Wrap response writer to capture status code
            rec := &statusRecorder{ResponseWriter: w, status: 200}

            // Process request
            next.ServeHTTP(rec, r.WithContext(ctx))

            // Record response status
            span.SetAttributes(attribute.Int("http.status_code", rec.status))
            if rec.status >= 400 {
                span.SetStatus(codes.Error, http.StatusText(rec.status))
            }
        })
    }
}

// When making outgoing requests, propagate the trace context
func (c *Client) DoWithTracing(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Inject trace context into outgoing request headers
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
    return c.httpClient.Do(req)
}
```

**What FAANG expects:** a diagram-level answer, W3C `traceparent` and `tracestate` headers carry the trace ID, span ID, and sampling decision across process boundaries. Mention OpenTelemetry as the vendor-neutral API, its separation of API, SDK, and exporter (OTLP to Jaeger/Tempo/Honeycomb/Datadog), head-based vs tail-based sampling and why tail-based is hard but catches outliers, and the cost model (1 percent head sampling at high traffic). Explain log/trace/metric correlation via trace ID in structured logs so an alert links straight to the offending span.

**Follow-ups:**
1. A request traverses ten services, why is the 99th percentile latency worse than the sum of the medians?
2. How do you trace work that escapes the request, a goroutine spawned from a handler that outlives it?
3. Sampling at 1 percent, how do you still catch every error trace?

### Junior to FAANG: How to Study Interview Questions Without Memorizing Answers

The bad way, memorize the answer to Q1. The good way, for each question, write your own code from scratch under time pressure, without referring to the answer. Then compare. The gap tells you where to study.

Time budget for on-site loops. Coding round, 45 minutes. Expect to produce working rate-limit or graceful-shutdown code. System-design round, 45 minutes. Expect to whiteboard the tracing or versioning architecture. Behavioral round, 45 minutes. Expect to describe an incident you caused and what you learned.

A realistic prep plan for junior candidates. Four weeks. Week 1, Q1 and Q2, implement both end to end. Week 2, Q3 and Q4, read one ADR from a real company (Stripe blog, Netflix Tech Blog). Week 3, Q5 and build a mini distributed system (two services with OTEL). Week 4, mock interviews with a peer, record yourself, watch back.

### Senior at FAANG: Interviewing at Staff Level

Staff and principal loops ask different versions of the same questions. The rate-limiter question becomes "design the org-wide rate-limit platform." The graceful-shutdown question becomes "design the fleet-wide drain protocol." The versioning question becomes "design the API deprecation policy spanning four years and 30 client teams."

Additional staff-level questions to expect.

Q6. Design the observability platform for a fleet of 500 Go services. Expected answer touches on OTEL collectors, sampling strategy (head plus tail), trace storage (Tempo, Honeycomb, Datadog), cost model, SLO dashboards, alerting (SLO burn-rate multi-window), and the org contract that every service must emit. Bonus, discuss cardinality governance and how you prevent `http_requests_total{url="/users/12345"}` from blowing up your metrics backend.

Q7. Your company has 200 Go services using five different HTTP frameworks. How do you converge on one. Expected answer, ADR process, codemod tool, adapter pattern for incremental migration, adoption dashboard, sunset timeline for unsupported frameworks, CI lint to reject new usage of deprecated frameworks, quarterly review. Bonus, estimate the engineering cost (typically 2 to 4 engineer-years over 18 months for 200 services) and defend the ROI.

Q8. Design the error-contract platform across 100 services with 20 client SDKs. Expected answer, RFC 7807 problem+json, error-code registry (YAML file, single source of truth), code-generated SDKs, runbook links, per-code SLOs, incident integration. Bonus, discuss how you migrate without breaking existing clients (dual-emission period, client-side adapter, sunset timeline).

Q9. A Sev-1 hits where every service returns 5xx for 20 minutes. The cause turns out to be a shared platform library. How do you prevent this class of incident. Expected answer, semantic versioning for platform libs, canary rollout (10 percent of services for a week, 50 percent for a week, 100 percent), automated rollback on SLO regression, staged rollout tooling, "platform incidents blast radius" as a headline metric. Bonus, discuss the organizational structure that supports this (platform team with ops partnership, dedicated rollback oncall).

Q10. Your p99 latency is rising week over week and nobody knows why. Walk through the investigation. Expected answer, SLO dashboard drill-down by service, route, region. OTEL trace sampling for p99 percentile specifically (tail sampling). CPU profile on the worst pods, heap profile, goroutine profile. GC tuning (GOGC, GOMEMLIMIT). Upstream latency correlation. Commit deploy-to-latency alignment. Capacity headroom check. The staff answer distinguishes methodical investigation from "I'd look at the dashboards."

Behavioral questions at staff level. "Tell me about a time you influenced an org without authority." "Describe a technical decision you reversed after new data." "How do you grow senior engineers into staff." "Walk me through a multi-year roadmap you owned." Prepare three STAR stories per question, each with a quantifiable outcome (reduced Sev-1 rate, increased deploy frequency, reduced cloud spend).

Writing samples at staff level. Bring a design doc you wrote or an ADR you shepherded. Hiring managers read it in prep. A good doc substitutes for an hour of interviewing.

The staff-level signal differentiators. Scope (one service vs one org). Time horizon (quarter vs three years). Measurement (outcome metric defined and tracked). Influence (named partner teams and how you aligned them). Tradeoffs (at least two options considered with explicit rejection criteria). Mentorship (juniors you grew). Interviewers grade every answer against these six axes whether they say so or not.

Multi-year roadmap for your own career. Year 1, land a named platform or reliability project. Year 2, promote-to-staff packet with three clear bullets. Year 3, cross-org influence, publish an ADR that gets adopted beyond your team. Year 4, external influence (conf talk, open source, blog post) that the outside world cites.

---
