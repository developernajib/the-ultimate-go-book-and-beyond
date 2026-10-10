## 43.9 Interview Questions

### Question 1: Explain the differences between gRPC streaming patterns and when to use each

**Answer:**

```go
/*
gRPC STREAMING PATTERNS

1. UNARY RPC
   Pattern: Request -> Response
   Use when:
   - Simple request/response operations
   - Data fits in single message
   - No need for real-time updates

   Examples:
   - GetUser(id) -> User
   - CreateOrder(order) -> OrderConfirmation
   - AuthenticateUser(credentials) -> Token

2. SERVER STREAMING
   Pattern: Request -> Stream of Responses
   Use when:
   - Server has multiple items to return
   - Data is too large for single response
   - Real-time updates from server

   Examples:
   - ListOrders(filter) -> stream Order
   - SubscribeToEvents(topic) -> stream Event
   - DownloadFile(fileId) -> stream FileChunk

3. CLIENT STREAMING
   Pattern: Stream of Requests -> Response
   Use when:
   - Client has multiple items to send
   - Uploading large data
   - Batch operations

   Examples:
   - UploadFile(stream FileChunk) -> UploadResult
   - BulkInsert(stream Record) -> InsertResult
   - SendMetrics(stream Metric) -> Acknowledgement

4. BIDIRECTIONAL STREAMING
   Pattern: Stream <-> Stream
   Use when:
   - Both sides need to send continuously
   - Real-time interactive communication
   - Order of messages doesn't matter

   Examples:
   - Chat(stream Message) -> stream Message
   - GameSession(stream Action) -> stream GameState
   - IoTDataSync(stream SensorData) -> stream Command
*/

// Example: Choosing the right pattern

// Unary - simple CRUD
func (s *Server) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
    user, err := s.store.Get(ctx, req.Id)
    if err != nil {
        return nil, status.Error(codes.NotFound, "user not found")
    }
    return &pb.GetUserResponse{User: user}, nil
}

// Server streaming - listing large datasets
func (s *Server) ListUsers(req *pb.ListUsersRequest, stream pb.UserService_ListUsersServer) error {
    cursor := ""
    for {
        users, nextCursor, err := s.store.List(stream.Context(), cursor, 100)
        if err != nil {
            return status.Error(codes.Internal, "failed to list")
        }

        for _, user := range users {
            if err := stream.Send(user); err != nil {
                return err
            }
        }

        if nextCursor == "" {
            break
        }
        cursor = nextCursor
    }
    return nil
}

// Client streaming - bulk upload
func (s *Server) BulkCreateUsers(stream pb.UserService_BulkCreateUsersServer) error {
    var created int
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            return stream.SendAndClose(&pb.BulkCreateResponse{CreatedCount: int32(created)})
        }
        if err != nil {
            return err
        }

        if err := s.store.Create(stream.Context(), req); err == nil {
            created++
        }
    }
}

// Bidirectional - real-time chat
func (s *Server) Chat(stream pb.ChatService_ChatServer) error {
    go func() {
        for {
            msg, err := stream.Recv()
            if err != nil {
                return
            }
            s.broadcast(msg)
        }
    }()

    updates := s.subscribe()
    for msg := range updates {
        if err := stream.Send(msg); err != nil {
            return err
        }
    }
    return nil
}
```

**What FAANG expects:** A candidate who immediately reaches for bidirectional streaming for anything that looks vaguely real-time has not internalized the trade-offs. Interviewers want you to default to unary and justify streaming with specific pressures, payload exceeds a ~4 MB frame budget, the work produces results incrementally where first-byte latency matters, the session carries per-connection state that makes reconnection expensive, or backpressure must flow both directions. They also expect you to know that streams are half-closed independently on the two directions (io.EOF signals the peer finished sending but may still receive) and that a single stream is pinned to one backend, so streaming RPCs bypass the client-side load balancer's ability to rebalance mid-session and can create hot-spotting under long connections.

**Follow-ups:**
- "Your chat service uses bidi streams. During a rolling deploy one pod holds 40,000 open streams. How do you drain it?" (`GracefulStop` waits forever on open streams. You need `GOAWAY`-triggered reconnects with a max-connection-age server param plus application-level shutdown messages.)
- "Client streaming RPC uploads a 2 GB file. How do you bound server memory?" (flow control via HTTP/2 windows plus application-level chunked `stream.Recv` without buffering the whole payload.)
- "Why not just use server-sent events over HTTP/2?" (lack of typed contract, no per-message deadline/cancellation semantics, no bidirectional channel, no binary framing for non-text payloads.)

### Question 2: How would you implement retry logic for gRPC calls?

**Answer:**

```go
/*
gRPC RETRY STRATEGIES

Considerations:
1. Which errors are retryable?
2. How many times to retry?
3. What backoff strategy?
4. Is the operation idempotent?
*/

// Retryable error codes
func isRetryable(err error) bool {
    st, ok := status.FromError(err)
    if !ok {
        return false
    }

    switch st.Code() {
    case codes.Unavailable:    // Service temporarily unavailable
        return true
    case codes.ResourceExhausted: // Rate limited
        return true
    case codes.Aborted:        // Transaction conflict
        return true
    case codes.Internal:       // Could be transient
        return true
    case codes.DeadlineExceeded: // Timeout - maybe retry with longer timeout
        return false // Usually not retryable
    case codes.NotFound:       // Resource doesn't exist
        return false
    case codes.InvalidArgument: // Bad request
        return false
    case codes.Unauthenticated: // Auth error
        return false
    default:
        return false
    }
}

// Retry interceptor with exponential backoff
func RetryInterceptor(maxRetries int, initialBackoff, maxBackoff time.Duration) grpc.UnaryClientInterceptor {
    return func(ctx context.Context, method string, req, reply any,
        cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

        var lastErr error
        backoff := initialBackoff

        for attempt := 0; attempt <= maxRetries; attempt++ {
            // Check if context is still valid
            if ctx.Err() != nil {
                return ctx.Err()
            }

            // Make the call
            err := invoker(ctx, method, req, reply, cc, opts...)
            if err == nil {
                return nil
            }

            lastErr = err

            // Check if error is retryable
            if !isRetryable(err) {
                return err
            }

            // Don't retry if this was the last attempt
            if attempt == maxRetries {
                break
            }

            // Calculate backoff with jitter
            jitter := time.Duration(rand.Int64N(int64(backoff / 2)))
            sleepTime := backoff + jitter

            select {
            case <-time.After(sleepTime):
            case <-ctx.Done():
                return ctx.Err()
            }

            // Exponential backoff
            backoff *= 2
            if backoff > maxBackoff {
                backoff = maxBackoff
            }
        }

        return status.Errorf(
            status.Code(lastErr),
            "failed after %d retries: %v",
            maxRetries, lastErr,
        )
    }
}

// gRPC's built-in retry configuration (recommended for production)
func WithRetryPolicy() grpc.DialOption {
    retryPolicy := `{
        "methodConfig": [{
            "name": [{"service": "user.v1.UserService"}],
            "waitForReady": true,
            "retryPolicy": {
                "MaxAttempts": 4,
                "InitialBackoff": ".1s",
                "MaxBackoff": "1s",
                "BackoffMultiplier": 2,
                "RetryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
            }
        }]
    }`

    return grpc.WithDefaultServiceConfig(retryPolicy)
}

// Usage with built-in retry. Prefer grpc.NewClient over the deprecated grpc.Dial.
func NewClientWithRetry(addr string) (*grpc.ClientConn, error) {
    return grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        WithRetryPolicy(),
    )
}
```

**What FAANG expects:** Idempotency awareness is the single most common signal separating strong candidates from weak ones here. Blindly retrying a non-idempotent `CreateOrder` RPC after an `UNAVAILABLE` is how duplicate charges reach production. Interviewers want you to (a) classify each RPC as idempotent or not at the proto level, (b) use gRPC's built-in retry policy via service config rather than hand-rolled interceptors for standard cases, the built-in respects server-side `RetryInfo` push-back and caps `hedgingPolicy` correctly, (c) explain why `DEADLINE_EXCEEDED` is usually not retryable (the deadline is the budget for the whole operation including retries, so a retry inside the same context just wastes cycles), and (d) describe jittered exponential backoff to avoid thundering-herd reconnection storms.

**Follow-ups:**
- "The server returns `UNAVAILABLE` but your retry succeeds on the second attempt. What might be silently wrong?" (the first attempt may have reached the server and mutated state before the network dropped, only safe if the RPC is idempotent or carries a client-supplied idempotency key.)
- "Why is `codes.Internal` usually not retryable despite looking transient?" (it signals a server-side invariant violation, a panic, a corrupted cache, a nil deref, and retrying just amplifies load against a broken server.)
- "How does hedging differ from retrying?" (hedging sends parallel requests after a delay and takes the first response. retrying waits for failure. Hedging reduces tail latency at the cost of load. it's only safe for idempotent reads.)

### Question 3: How do you handle authentication in gRPC?

**Answer:**

```go
/*
gRPC AUTHENTICATION PATTERNS

1. Token-based (JWT, API keys)
2. mTLS (mutual TLS)
3. OAuth2
4. Per-RPC credentials

Metadata is used to pass auth info.
*/

// Client-side: Add token to every request
type tokenCredentials struct {
    token    string
    insecure bool
}

func (t tokenCredentials) GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error) {
    return map[string]string{
        "authorization": "Bearer " + t.token,
    }, nil
}

func (t tokenCredentials) RequireTransportSecurity() bool {
    return !t.insecure
}

// Client with token auth. In production, pair WithPerRPCCredentials with real
// TLS credentials, because gRPC refuses per-RPC credentials over insecure transport
// unless RequireTransportSecurity returns false, which you should only do in tests.
func NewAuthenticatedClient(addr, token string) (*grpc.ClientConn, error) {
    return grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithPerRPCCredentials(tokenCredentials{token: token, insecure: true}),
    )
}

// Server-side: Auth interceptor
func AuthInterceptor(validator TokenValidator) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler) (any, error) {

        // Skip auth for certain methods
        if skipAuth(info.FullMethod) {
            return handler(ctx, req)
        }

        // Extract token from metadata
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization")
        }

        token := strings.TrimPrefix(tokens[0], "Bearer ")
        if token == tokens[0] {
            return nil, status.Error(codes.Unauthenticated, "invalid authorization format")
        }

        // Validate token
        claims, err := validator.Validate(token)
        if err != nil {
            return nil, status.Error(codes.Unauthenticated, "invalid token")
        }

        // Add claims to context
        ctx = context.WithValue(ctx, claimsKey, claims)

        return handler(ctx, req)
    }
}

// mTLS authentication
func NewMTLSServer(certFile, keyFile, caFile string) (*grpc.Server, error) {
    // Load server certificate
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    // Load CA certificate for client verification
    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, err
    }

    certPool := x509.NewCertPool()
    certPool.AppendCertsFromPEM(caCert)

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    certPool,
        ClientAuth:   tls.RequireAndVerifyClientCert,
    }

    return grpc.NewServer(
        grpc.Creds(credentials.NewTLS(tlsConfig)),
    ), nil
}
```

**What FAANG expects:** Authentication and authorization are distinct and both must be enforced at the server. Interviewers want to see that you understand authentication lives in a server interceptor that extracts credentials from `metadata` and attaches a verified principal to `context.Context`, while authorization lives in each handler (or a second interceptor driven by method-to-permission mapping) that checks the principal against the operation. The common mistake to avoid: trusting claims passed as request fields, only trust metadata validated by the interceptor chain. Strong answers also cover why `credentials.PerRPCCredentials.RequireTransportSecurity()` must return `true` in production (per-RPC credentials over plaintext leak tokens to any on-path observer), and the difference between mTLS (authenticates the calling *service*) versus OAuth2/JWT (authenticates the calling *user*), most real systems combine both.

**Follow-ups:**
- "Your JWT validator does an HTTP call to the IdP on every request. What's wrong?" (it adds a round trip to every RPC and creates a hard dependency on the IdP's availability. Validate signatures locally with cached JWKs and do a full introspection only on cache miss or revocation.)
- "How do you propagate the caller's identity across three service hops without re-authenticating at each hop?" (service-mesh mTLS between hops plus a signed identity token in metadata, the *caller identity* token, that downstream services validate but do not need to re-issue. Google's ALTS and service-account identity tokens solve this.)
- "Where would you put rate limiting, interceptor, proxy, or service mesh?" (depends on the granularity: per-IP at the edge L7 proxy, per-user in an interceptor after auth resolves the principal, per-RPC-method as a sidecar policy. Putting it before auth lets attackers exhaust quota against unauthenticated calls.)

### Question 4: How would you implement load balancing for gRPC?

**Answer:**

```go
/*
gRPC LOAD BALANCING

Options:
1. Client-side load balancing (built-in)
2. Proxy-based (Envoy, nginx)
3. Service mesh (Istio, Linkerd)

Built-in policies:
- pick_first: Use first available
- round_robin: Rotate through backends
- grpclb: External load balancer
- Custom resolver + balancer
*/

// Round-robin client-side load balancing
func NewRoundRobinClient(addresses []string) (*grpc.ClientConn, error) {
    // Build resolver target with all addresses
    target := fmt.Sprintf("static:///%s", strings.Join(addresses, ","))

    return grpc.NewClient(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
        grpc.WithResolvers(&staticResolver{}),
    )
}

// Custom resolver for static addresses
type staticResolver struct{}

func (r *staticResolver) Build(target resolver.Target, cc resolver.ClientConn,
    opts resolver.BuildOptions) (resolver.Resolver, error) {

    addrs := strings.Split(strings.TrimPrefix(target.URL.Path, "/"), ",")

    addresses := make([]resolver.Address, len(addrs))
    for i, addr := range addrs {
        addresses[i] = resolver.Address{Addr: addr}
    }

    cc.UpdateState(resolver.State{Addresses: addresses})

    return &staticResolverInstance{}, nil
}

func (r *staticResolver) Scheme() string { return "static" }

type staticResolverInstance struct{}

func (r *staticResolverInstance) ResolveNow(resolver.ResolveNowOptions) {}
func (r *staticResolverInstance) Close()                                {}

// DNS-based discovery with round-robin. NewClient defaults to the DNS resolver,
// so "dns:///" is optional here but makes the intent explicit.
func NewDNSClient(serviceName string) (*grpc.ClientConn, error) {
    return grpc.NewClient(
        "dns:///"+serviceName, // dns:///users.service.consul
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
    )
}

// Custom balancer for weighted load balancing
type weightedBalancer struct {
    weights map[string]int
}

func (b *weightedBalancer) Pick(info balancer.PickInfo) (balancer.PickResult, error) {
    // Implement weighted random selection
    totalWeight := 0
    for _, w := range b.weights {
        totalWeight += w
    }

    r := rand.IntN(totalWeight)
    for addr, weight := range b.weights {
        r -= weight
        if r < 0 {
            // Return connection for this address
            // ...
        }
    }

    return balancer.PickResult{}, errors.New("no connection available")
}
```

**What FAANG expects:** An L7 proxy like an AWS ALB or classic nginx cannot load-balance gRPC correctly because every RPC rides a single multiplexed HTTP/2 connection, the proxy sees one long-lived TCP connection per client and pins it to one backend, so a ten-pod service receives traffic from exactly one pod per client. Interviewers want you to know one of three working approaches: (1) client-side balancing via `grpc.WithDefaultServiceConfig` with `round_robin` against a headless service plus the DNS resolver, (2) a proxy that understands HTTP/2 streams (Envoy, Linkerd-proxy, or an L7 ingress explicitly configured for gRPC, typically `GRPC` backend-protocol rather than `HTTP2`), or (3) a full service mesh that does weighted and locality-aware balancing with health-aware subsetting. Candidates should also mention that DNS-resolver re-resolution is cache-bound by TTL, so topology changes propagate slowly without `xDS` or periodic resolver refresh.

**Follow-ups:**
- "Your service scales from 4 to 40 pods under load but old clients still hit only 4. Why?" (the client's resolver resolved DNS once at connection time. `NewClient` only re-resolves on disconnection or service-config change. Fix with a re-resolving resolver or pick_first → round_robin with `max_connection_age` on the server to force periodic reconnects.)
- "Why does round_robin produce uneven load in practice?" (long-tailed request durations, some backends sit on slow queries, so uniform request distribution translates into uneven in-flight counts. Use `least_request` or weighted round robin.)
- "When would you choose headless service + client-side over a service mesh?" (for low latency overhead and when the language ecosystem has a mature gRPC balancer. A mesh adds ~0.5-2 ms per hop and another failure domain.)

### Question 5: How do you ensure gRPC services are observable?

**Answer:**

```go
/*
gRPC OBSERVABILITY

Three pillars:
1. Metrics (Prometheus)
2. Tracing (OpenTelemetry)
3. Logging (structured)
*/

// Combined observability interceptor
func ObservabilityInterceptor(
    tracer trace.Tracer,
    meter metric.Meter,
    logger *slog.Logger,
) grpc.UnaryServerInterceptor {
    // Metrics
    requestCounter, _ := meter.Int64Counter("grpc_requests_total")
    requestDuration, _ := meter.Float64Histogram("grpc_request_duration_seconds")

    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler) (any, error) {

        start := time.Now()

        // Start span
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
        )
        defer span.End()

        // Extract trace ID for logging
        traceID := span.SpanContext().TraceID().String()
        ctx = context.WithValue(ctx, "trace_id", traceID)

        // Handle request
        resp, err := handler(ctx, req)

        // Record metrics
        duration := time.Since(start)
        code := status.Code(err)

        requestCounter.Add(ctx, 1,
            metric.WithAttributes(
                attribute.String("method", info.FullMethod),
                attribute.String("code", code.String()),
            ),
        )

        requestDuration.Record(ctx, duration.Seconds(),
            metric.WithAttributes(
                attribute.String("method", info.FullMethod),
            ),
        )

        // Log
        logger.Info("grpc request",
            "method", info.FullMethod,
            "duration_ms", duration.Milliseconds(),
            "code", code.String(),
            "trace_id", traceID,
        )

        // Record error in span
        if err != nil {
            span.RecordError(err)
            span.SetStatus(otelcodes.Error, err.Error())
        }

        return resp, err
    }
}

// Health check for Kubernetes probes
type healthServer struct {
    grpc_health_v1.UnimplementedHealthServer
    services map[string]func() bool
}

func (s *healthServer) Check(ctx context.Context, req *grpc_health_v1.HealthCheckRequest) (
    *grpc_health_v1.HealthCheckResponse, error) {

    service := req.GetService()

    if check, ok := s.services[service]; ok {
        if check() {
            return &grpc_health_v1.HealthCheckResponse{
                Status: grpc_health_v1.HealthCheckResponse_SERVING,
            }, nil
        }
        return &grpc_health_v1.HealthCheckResponse{
            Status: grpc_health_v1.HealthCheckResponse_NOT_SERVING,
        }, nil
    }

    return &grpc_health_v1.HealthCheckResponse{
        Status: grpc_health_v1.HealthCheckResponse_SERVICE_UNKNOWN,
    }, nil
}

// Register health checks
func RegisterHealthChecks(server *grpc.Server, checks map[string]func() bool) {
    grpc_health_v1.RegisterHealthServer(server, &healthServer{services: checks})
}
```

**What FAANG expects:** Three pillars (metrics, traces, logs) is the table-stakes answer. strong candidates go further. They name the specific metrics to export, RED (rate, errors, duration) or the four golden signals, and insist on `method` and `code` label cardinality discipline so a high-cardinality label doesn't blow up Prometheus. They know that context propagation is *the* cross-cutting concern: `W3C traceparent` in metadata, request IDs as a correlation ID, and slog/zap's `*Context`-aware variants so structured logs carry the trace ID automatically. They also distinguish the gRPC health service (`grpc.health.v1.Health`) from Kubernetes HTTP liveness/readiness probes, the two serve different purposes and need different timeout budgets: liveness should be slow and tolerant (a single bad check won't restart the pod), readiness fast and strict (a single failure takes you out of the load balancer).

**Follow-ups:**
- "Your tracing overhead is 12% of CPU at peak. What do you do?" (head-based sampling at the edge with a low probability plus forced sampling on errors and slow requests. OpenTelemetry's `ParentBased(TraceIDRatioBased)` sampler, not per-span decisions.)
- "How do you trace across a bidirectional stream that lives for hours?" (one span per stream is useless. Emit span events per message or open nested spans for logical operations within the stream, with the stream's span as parent.)
- "A handler returns `codes.Internal`. Where exactly does that error get recorded?" (in the unary interceptor wrapping the handler via `span.RecordError` and `status.Code(err)`. The span status mapping from gRPC code to OTel status is documented in the OpenTelemetry semantic conventions for RPC.)

### Junior → FAANG: Interview Question Preparation Checklist

The five questions above map to a preparation checklist. Before your interview, practice answering each in under two minutes without referring to notes.

**Streaming patterns:** Draw the four patterns on paper and write one concrete use case for each. Practice explaining the trade-off between server streaming and pagination (streaming is lower latency for first item, pagination is restartable and proxy-friendly). Know that bidirectional streaming pins a connection to one backend, bypassing client-side load balancing.

**Retry logic:** Memorize the retryable code set (`UNAVAILABLE`, `RESOURCE_EXHAUSTED`, `ABORTED`) and the always-not-retryable set (`INVALID_ARGUMENT`, `NOT_FOUND`, `UNAUTHENTICATED`, `PERMISSION_DENIED`). For `INTERNAL` and `DEADLINE_EXCEEDED`, explain why each is context-dependent. Practice writing the gRPC service config JSON for built-in retries: interviewers who know gRPC well are impressed when you reach for the built-in retry policy over a hand-rolled interceptor.

**Authentication:** Know the distinction between `UNAUTHENTICATED` ("I don't know who you are") and `PERMISSION_DENIED` ("I know who you are but you cannot do this"). Be able to sketch a server interceptor that extracts a JWT from metadata, validates it, and attaches claims to the context. Know that `RequireTransportSecurity() bool` returning `false` should only happen in tests.

**Load balancing:** Understand why an L4 load balancer cannot balance gRPC correctly (one TCP connection per client, all streams pinned to one backend). Know at least one working solution (headless service with DNS resolver and `round_robin` policy, or a service mesh). Be ready to explain DNS re-resolution and why `max_connection_age` helps.

**Observability:** Lead with the RED method (Rate, Errors, Duration) for gRPC metrics. Know that the `grpc.method` and `grpc.code` labels are essential for useful dashboards. Be able to explain W3C traceparent propagation in gRPC metadata for distributed tracing.

### Senior @ FAANG: Bar-Raiser Interview Signals for gRPC

Bar-raisers test depth of ownership and fleet-level impact thinking, not just technical knowledge. For each of the five questions, the bar-raiser wants to see evidence that you have made decisions at scale with real consequences.

**Streaming at scale.** A strong answer to the streaming question includes: stream pinning and its impact on load balancing, max connection age for forced reconnection under client-side LB, goroutine leak patterns and how to detect them (`goleak`, `runtime.NumGoroutine` tests), and the `GOAWAY` mechanism for draining connections during rolling deploys. A bar-raiser signal: you have personally debugged a stream-leak incident or a load-balancing hot-spot caused by long-lived streams.

**Retry policy governance.** The bar-raiser wants to know how you make retry policy consistent across the fleet, not just within one service. The answer involves gRPC service config pushed via xDS from a control plane, or a standard `WithRetryPolicy` function in the platform's client package that teams call rather than writing their own JSON. Bonus signal: you understand why `INTERNAL` is excluded from the default retry list even though it looks transient, and you can articulate the risk of retry amplification against a broken server.

**Authentication depth.** A bar-raiser answer distinguishes service identity (mTLS via SPIFFE, authenticates the calling service) from user identity (JWT/OAuth2, authenticates the calling user) and explains when you need both. It covers JWK cache management (local signature validation with periodic key refresh, full introspection only on revocation), the ALTS (Application Layer Transport Security) pattern for service-to-service auth in Google's infrastructure, and why putting identity tokens in request fields rather than metadata is a security anti-pattern.

**Load balancing at L7.** The bar-raiser wants to know your fleet's actual load balancing topology, not just the theory. They expect you to know whether your organization uses Envoy, Linkerd, or client-side LB, what the failure mode is for each approach, and how you would migrate from one to another without downtime. A strong signal: you have measured the latency overhead of a sidecar proxy hop (typically 0.3-1ms for Envoy) and made a documented decision about whether it is acceptable for your service's SLO.

**Observability governance.** The bar-raiser expects cardinality discipline: knowing that a `grpc.method` label with a full method path (`/user.v1.UserService/GetUser`) can have hundreds of distinct values in a large service and that this cardinality is acceptable, but adding a `user_id` label would create millions of distinct time series and destroy your Prometheus cluster. They also expect you to know the OpenTelemetry semantic conventions for RPC (which label names are standard) rather than inventing custom label names that differ across services and cannot be aggregated by the central monitoring team.

---
