## 47.11 Microservices Architecture Pitfalls: When Distribution Goes Wrong

### Pitfall 1: The Distributed Monolith Disaster

**Incident Report**: A company decomposed their monolith into 47 microservices. But services made synchronous calls to each other in chains of 5-7 services. A single slow service caused cascading latency spikes. Deployment required coordinating 12 teams because services were tightly coupled by shared databases and synchronous dependencies.

```go
// WRONG: Synchronous chain creates distributed monolith
func (s *OrderService) CreateOrder(ctx context.Context, req *OrderRequest) (*Order, error) {
    // Chain of synchronous calls - any failure kills the request
    user, err := s.userClient.GetUser(ctx, req.UserID)  // Call 1
    if err != nil {
        return nil, err
    }

    inventory, err := s.inventoryClient.CheckAvailability(ctx, req.Items)  // Call 2
    if err != nil {
        return nil, err
    }

    payment, err := s.paymentClient.AuthorizePayment(ctx, req.PaymentInfo)  // Call 3
    if err != nil {
        return nil, err
    }

    shipping, err := s.shippingClient.CalculateShipping(ctx, req.Address)  // Call 4
    if err != nil {
        return nil, err
    }

    // If any service is slow, the entire order creation is slow
    // If any service fails, the order fails
    // If any service deploys breaking changes, order service breaks
    order := &Order{...}
    return order, nil
}

// CORRECT: Event-driven decoupling with local data
func (s *OrderService) CreateOrder(ctx context.Context, req *OrderRequest) (*Order, error) {
    // Use local cached/replicated data for read operations
    user, err := s.localUserCache.GetUser(ctx, req.UserID)
    if err != nil {
        return nil, err
    }

    // Create order with pending status - don't wait for downstream
    order := &Order{
        ID:        uuid.New().String(),
        UserID:    req.UserID,
        Items:     req.Items,
        Status:    OrderStatusPending,
        CreatedAt: time.Now(),
    }

    // Persist order first (single database operation)
    if err := s.orderRepo.Create(ctx, order); err != nil {
        return nil, err
    }

    // Emit event for async processing - fire and forget
    event := &OrderCreatedEvent{
        OrderID:     order.ID,
        UserID:      order.UserID,
        Items:       order.Items,
        PaymentInfo: req.PaymentInfo,
        Address:     req.Address,
    }

    if err := s.eventBus.Publish(ctx, "orders.created", event); err != nil {
        // Log but don't fail - event will be retried via outbox
        log.Printf("Failed to publish event: %v", err)
    }

    // Return immediately - order will be processed asynchronously
    return order, nil
}

// Separate saga coordinator handles the workflow
func (c *OrderSagaCoordinator) HandleOrderCreated(ctx context.Context, event *OrderCreatedEvent) error {
    saga := NewOrderSaga(event.OrderID)

    // Steps run independently, each with compensation
    saga.AddStep("inventory", c.reserveInventory, c.releaseInventory)
    saga.AddStep("payment", c.processPayment, c.refundPayment)
    saga.AddStep("shipping", c.scheduleShipping, c.cancelShipping)

    return saga.Execute(ctx)
}
```

### Pitfall 2: The Service Discovery Stampede

**Incident Report**: After a network partition healed, 500 services simultaneously queried Consul for service discovery. Consul's CPU spiked to 100%, and it started returning stale data. Services began routing to dead instances, causing 30% error rate for 15 minutes.

```go
// WRONG: Aggressive polling without backoff
type ServiceDiscovery struct {
    client *consul.Client
    cache  map[string][]*ServiceInstance
}

func (sd *ServiceDiscovery) GetInstances(serviceName string) ([]*ServiceInstance, error) {
    // Every call hits Consul - no caching
    services, _, err := sd.client.Health().Service(serviceName, "", true, nil)
    if err != nil {
        return nil, err
    }
    return convertToInstances(services), nil
}

// Called on every RPC - massive Consul load
func (c *Client) Call(ctx context.Context, req Request) Response {
    instances, _ := c.discovery.GetInstances("payment-service")
    target := instances[rand.IntN(len(instances))]
    return c.doCall(target, req)
}

// CORRECT: Cached discovery with background refresh and jitter
type CachedServiceDiscovery struct {
    client       *consul.Client
    cache        sync.Map
    refreshJitter time.Duration
}

func NewCachedServiceDiscovery(client *consul.Client) *CachedServiceDiscovery {
    sd := &CachedServiceDiscovery{
        client:       client,
        refreshJitter: 5 * time.Second,
    }
    return sd
}

func (sd *CachedServiceDiscovery) StartWatching(ctx context.Context, serviceName string) {
    // Initial fetch
    sd.refresh(ctx, serviceName)

    // Background watcher with blocking queries (long polling)
    go func() {
        var lastIndex uint64

        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            // Add jitter to prevent thundering herd after partition
            jitter := time.Duration(rand.Int64N(int64(sd.refreshJitter)))
            time.Sleep(jitter)

            // Use blocking query - Consul holds connection until change
            opts := &consul.QueryOptions{
                WaitIndex: lastIndex,
                WaitTime:  5 * time.Minute,
            }

            services, meta, err := sd.client.Health().Service(
                serviceName, "", true, opts,
            )
            if err != nil {
                log.Printf("Discovery refresh failed: %v", err)
                time.Sleep(time.Second)  // Backoff on error
                continue
            }

            if meta.LastIndex > lastIndex {
                lastIndex = meta.LastIndex
                sd.cache.Store(serviceName, convertToInstances(services))
                log.Printf("Updated %s: %d instances", serviceName, len(services))
            }
        }
    }()
}

func (sd *CachedServiceDiscovery) GetInstances(serviceName string) ([]*ServiceInstance, error) {
    if cached, ok := sd.cache.Load(serviceName); ok {
        return cached.([]*ServiceInstance), nil
    }
    return nil, fmt.Errorf("no instances for %s", serviceName)
}
```

### Pitfall 3: The Timeout Cascade Collapse

**Incident Report**: Service A called B called C called D. Each had a 30-second timeout. When D became slow (taking 25s), requests backed up. A's timeout fired at 30s, but B, C, and D continued processing the abandoned request. Under load, all services became saturated processing requests that would never be used.

```go
// WRONG: Same timeout at every layer
const Timeout = 30 * time.Second

func (a *ServiceA) HandleRequest(ctx context.Context, req Request) Response {
    ctx, cancel := context.WithTimeout(ctx, Timeout)
    defer cancel()
    return a.serviceB.Call(ctx, req)  // B also uses 30s timeout
}

func (b *ServiceB) Call(ctx context.Context, req Request) Response {
    ctx, cancel := context.WithTimeout(ctx, Timeout)  // Resets to 30s!
    defer cancel()
    return b.serviceC.Call(ctx, req)  // Total could be 60s+
}

// CORRECT: Deadline propagation with budget
func (a *ServiceA) HandleRequest(ctx context.Context, req Request) Response {
    // Set overall deadline at entry point
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    // Pass context with remaining deadline
    return a.serviceB.Call(ctx, req)
}

func (b *ServiceB) Call(ctx context.Context, req Request) Response {
    // Check remaining budget
    deadline, ok := ctx.Deadline()
    if !ok {
        // No deadline set - add our own
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 10*time.Second)
        defer cancel()
    } else {
        remaining := time.Until(deadline)
        if remaining < 100*time.Millisecond {
            return Response{Error: ErrDeadlineExceeded}
        }

        // Reserve time for our processing (don't use full budget)
        ourBudget := remaining - 500*time.Millisecond
        if ourBudget < 100*time.Millisecond {
            return Response{Error: ErrInsufficientBudget}
        }

        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, ourBudget)
        defer cancel()
    }

    return b.serviceC.Call(ctx, req)
}

// Alternative: Explicit deadline headers
func (c *Client) Call(ctx context.Context, serviceName string, req Request) Response {
    deadline, ok := ctx.Deadline()

    md := metadata.MD{}
    if ok {
        // Send absolute deadline timestamp
        md.Set("x-deadline", deadline.Format(time.RFC3339Nano))
    }

    ctx = metadata.NewOutgoingContext(ctx, md)
    return c.grpcClient.Call(ctx, req)
}

func (s *Server) HandleRequest(ctx context.Context, req Request) Response {
    // Extract upstream deadline
    md, _ := metadata.FromIncomingContext(ctx)
    if deadlines := md.Get("x-deadline"); len(deadlines) > 0 {
        deadline, _ := time.Parse(time.RFC3339Nano, deadlines[0])
        remaining := time.Until(deadline)

        if remaining < 0 {
            return Response{Error: ErrDeadlineExceeded}
        }

        var cancel context.CancelFunc
        ctx, cancel = context.WithDeadline(ctx, deadline)
        defer cancel()
    }

    return s.processRequest(ctx, req)
}
```

### Pitfall 4: The Database Per Service Data Integrity Nightmare

**Incident Report**: Each microservice owned its database as per best practices. But a race condition emerged: Order Service created an order and published an event, Payment Service processed it and charged the customer, but Order Service's database transaction rolled back due to a constraint violation. Customer was charged for a non-existent order.

```go
// WRONG: Publish event before transaction commits
func (s *OrderService) CreateOrder(ctx context.Context, req *OrderRequest) (*Order, error) {
    order := &Order{ID: uuid.New().String(), ...}

    // Start transaction
    tx, _ := s.db.BeginTx(ctx, nil)

    // Insert order
    _, err := tx.ExecContext(ctx, "INSERT INTO orders ...", order.ID, ...)
    if err != nil {
        tx.Rollback()
        return nil, err
    }

    // BUG: Publish BEFORE commit - event might be processed before/if transaction fails
    s.eventBus.Publish("orders.created", OrderCreatedEvent{OrderID: order.ID})

    // Transaction might fail here!
    if err := tx.Commit(); err != nil {
        // Event already published and possibly processed!
        return nil, err
    }

    return order, nil
}

// CORRECT: Transactional outbox pattern
func (s *OrderService) CreateOrder(ctx context.Context, req *OrderRequest) (*Order, error) {
    order := &Order{ID: uuid.New().String(), ...}

    // Single transaction for both order AND event
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Insert order
    _, err := tx.ExecContext(ctx, "INSERT INTO orders ...", order.ID, ...)
    if err != nil {
        return nil, err
    }

    // Insert event into outbox table (same transaction)
    eventPayload, _ := json.Marshal(OrderCreatedEvent{OrderID: order.ID})
    _, err = tx.ExecContext(ctx, `
        INSERT INTO outbox (id, event_type, payload, created_at)
        VALUES ($1, $2, $3, $4)
    `, uuid.New().String(), "orders.created", eventPayload, time.Now())
    if err != nil {
        return nil, err
    }

    // Commit both atomically
    if err := tx.Commit(); err != nil {
        return nil, err
    }

    return order, nil
}

// Separate process polls outbox and publishes events
func (p *OutboxProcessor) Run(ctx context.Context) {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.processOutbox(ctx)
        }
    }
}

func (p *OutboxProcessor) processOutbox(ctx context.Context) {
    // FOR UPDATE SKIP LOCKED only holds its row locks for the life of the
    // enclosing transaction. Run outside one and the locks vanish when the
    // SELECT returns, so two pollers double-publish. The whole claim,
    // publish, mark cycle must share a transaction.
    tx, err := p.db.BeginTx(ctx, nil)
    if err != nil {
        log.Printf("begin outbox tx: %v", err)
        return
    }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx, `
        SELECT id, event_type, payload
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    `)
    if err != nil {
        log.Printf("query outbox: %v", err)
        return
    }
    defer rows.Close()

    for rows.Next() {
        var id, eventType string
        var payload []byte
        if err := rows.Scan(&id, &eventType, &payload); err != nil {
            log.Printf("scan outbox row: %v", err)
            return
        }

        // Publish to message broker. A crash after publish but before commit
        // re-delivers the event, which is why consumers must be idempotent.
        if err := p.eventBus.Publish(eventType, payload); err != nil {
            log.Printf("Failed to publish event %s: %v", id, err)
            continue
        }

        // Mark as published inside the same transaction that holds the lock
        if _, err := tx.ExecContext(ctx, `
            UPDATE outbox SET published_at = $1 WHERE id = $2
        `, time.Now(), id); err != nil {
            log.Printf("mark published %s: %v", id, err)
            return
        }
    }

    if err := tx.Commit(); err != nil {
        log.Printf("commit outbox tx: %v", err)
    }
}
```

### Pitfall 5: The API Gateway Single Point of Failure

**Incident Report**: All traffic routed through a single API gateway cluster. During a routine deployment, the gateway had a memory leak. It crashed, taking down all 47 services behind it. The team had to revert while users experienced complete outage.

```go
// WRONG: Gateway does too much, single failure domain
func (g *APIGateway) Handle(w http.ResponseWriter, r *http.Request) {
    // Auth, rate limiting, transformation, caching all in gateway
    // Any bug here affects ALL services

    token := r.Header.Get("Authorization")
    user, err := g.authService.ValidateToken(token)  // External call in critical path
    if err != nil {
        http.Error(w, "unauthorized", 401)
        return
    }

    // Complex routing logic
    backend := g.router.Route(r)

    // Request transformation (memory allocation)
    transformed := g.transformRequest(r, user)

    // Response caching (memory growth)
    if cached := g.cache.Get(r.URL.Path); cached != nil {
        w.Write(cached)
        return
    }

    resp := g.proxy.Forward(backend, transformed)
    g.cache.Set(r.URL.Path, resp)  // Memory leak if responses are large
    w.Write(resp)
}

// CORRECT: Thin gateway with distributed concerns
func (g *ThinGateway) Handle(w http.ResponseWriter, r *http.Request) {
    // Gateway only does routing and basic request validation
    // Other concerns are handled by sidecars or services

    // Quick local validation only
    if r.ContentLength > g.maxRequestSize {
        http.Error(w, "request too large", 413)
        return
    }

    // Simple routing based on path prefix
    backend, ok := g.routes[extractPrefix(r.URL.Path)]
    if !ok {
        http.Error(w, "not found", 404)
        return
    }

    // Forward with minimal transformation
    // Auth is handled by service mesh (mTLS + JWT validation in sidecar)
    // Rate limiting by service-specific sidecars
    g.proxy.Forward(w, r, backend)
}

// Each service has its own lightweight sidecar
type ServiceSidecar struct {
    authValidator   *JWTValidator      // Local validation
    rateLimiter     *LocalRateLimiter  // In-memory, service-specific limits
    circuitBreaker  *CircuitBreaker    // Per-dependency breakers
}

func (s *ServiceSidecar) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Auth: Validate JWT locally (no external call)
    claims, err := s.authValidator.ValidateLocal(r)
    if err != nil {
        http.Error(w, "unauthorized", 401)
        return
    }

    // Rate limit: Per-user, per-service (isolated)
    if !s.rateLimiter.Allow(claims.UserID) {
        http.Error(w, "rate limited", 429)
        return
    }

    // Pass to actual service
    s.next.ServeHTTP(w, r)
}
```

### Pitfall 6: The Observability Data Explosion

**Incident Report**: With 47 microservices and 100% trace sampling, the team generated 2TB of trace data per day. Storage costs hit $50,000/month. When they tried to query for a specific trace, it timed out. The observability system meant to help debugging became unusable.

```go
// WRONG: Trace everything at maximum detail
func initTracing() {
    exporter, _ := jaeger.New(jaeger.WithCollectorEndpoint(
        jaeger.WithEndpoint("http://jaeger:14268/api/traces"),
    ))

    tp := tracesdk.NewTracerProvider(
        tracesdk.WithBatcher(exporter),
        tracesdk.WithSampler(tracesdk.AlwaysSample()),  // 100% sampling!
    )
    otel.SetTracerProvider(tp)
}

func (s *Server) HandleRequest(ctx context.Context, req Request) Response {
    ctx, span := tracer.Start(ctx, "HandleRequest")
    defer span.End()

    // Add excessive attributes
    span.SetAttributes(
        attribute.String("request.body", string(req.Body)),  // PII risk + large
        attribute.String("user.email", req.Email),           // PII!
        attribute.StringSlice("request.headers", formatHeaders(req.Headers)),
    )

    // Create spans for every tiny operation
    ctx, dbSpan := tracer.Start(ctx, "database.query")
    result := s.db.Query(ctx, "SELECT * FROM users")
    dbSpan.End()

    ctx, jsonSpan := tracer.Start(ctx, "json.marshal")  // Microseconds, noise
    data, _ := json.Marshal(result)
    jsonSpan.End()

    return Response{Data: data}
}

// CORRECT: Strategic sampling and meaningful spans
func initTracing() {
    exporter, _ := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint("otel-collector:4318"),
    )

    // Adaptive sampling based on criteria
    sampler := NewAdaptiveSampler(AdaptiveSamplerConfig{
        DefaultRate:     0.01,  // 1% baseline
        ErrorRate:       1.0,   // 100% of errors
        SlowThreshold:   time.Second,
        SlowRate:        0.5,   // 50% of slow requests
        DebugHeaderRate: 1.0,   // 100% if X-Debug header
    })

    tp := tracesdk.NewTracerProvider(
        tracesdk.WithBatcher(exporter),
        tracesdk.WithSampler(sampler),
    )
    otel.SetTracerProvider(tp)
}

type AdaptiveSampler struct {
    config AdaptiveSamplerConfig
}

func (s *AdaptiveSampler) ShouldSample(p tracesdk.SamplingParameters) tracesdk.SamplingResult {
    // Always sample errors
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return tracesdk.SamplingResult{Decision: tracesdk.RecordAndSample}
        }
    }

    // Sample debug requests
    if hasDebugHeader(p) {
        return tracesdk.SamplingResult{Decision: tracesdk.RecordAndSample}
    }

    // Probabilistic sampling for normal traffic
    if rand.Float64() < s.config.DefaultRate {
        return tracesdk.SamplingResult{Decision: tracesdk.RecordAndSample}
    }

    return tracesdk.SamplingResult{Decision: tracesdk.Drop}
}

func (s *Server) HandleRequest(ctx context.Context, req Request) Response {
    ctx, span := tracer.Start(ctx, "HandleRequest")
    defer span.End()

    // Only add essential, non-PII attributes
    span.SetAttributes(
        attribute.String("user.id", req.UserID),  // ID, not email
        attribute.String("request.path", req.Path),
        attribute.Int("request.size", len(req.Body)),
    )

    // Only create spans for significant operations
    result, err := s.queryWithSpan(ctx, "GetUserOrders", userID)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }

    return Response{Data: result}
}
```

### Quick Reference: Microservices Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Distributed monolith | Coordinated deployments, cascading failures | Event-driven architecture, local data |
| Discovery stampede | Control plane overload after partitions | Cached discovery with jitter, blocking queries |
| Timeout cascade | All services slow when one is slow | Deadline propagation, budget-aware timeouts |
| Data integrity gaps | Inconsistent state across services | Transactional outbox, saga pattern |
| Gateway SPOF | Complete outage during gateway issues | Thin gateway, distributed concerns, mesh |
| Observability explosion | Unqueryable data, high costs | Adaptive sampling, meaningful spans only |

### Junior → FAANG: Pitfalls as Incident Preparation Material

The six pitfalls in this section are not hypothetical. They are the most common incident patterns in microservices organizations. For junior engineers, understanding these pitfalls serves two purposes: avoiding them in code you write, and being able to diagnose them when you are on-call.

Distributed monolith diagnosis: during an incident, if you see a single slow service causing elevated latency across ten other services, you are looking at a distributed monolith call chain. The immediate mitigation is to check if any circuit breakers are open and whether the slow service can be bypassed. The long-term fix is to identify which calls in the chain are not user-facing and convert them to async.

Discovery stampede diagnosis: if Consul or your service registry CPU spikes to 100% immediately after a network event, you are seeing a stampede. The immediate mitigation is to restart the services in batches rather than all at once. The long-term fix is jittered blocking queries, which the corrected code in this section implements.

Timeout cascade diagnosis: if all services in a dependency chain show elevated latency simultaneously, with the deepest service in the chain being the slowest, you are seeing a timeout cascade. Check whether contexts are being propagated or whether each service is creating a fresh timeout. `ctx.Deadline()` is zero if the upstream context deadline is not being honored.

Outbox pattern as a junior skill to develop: the transactional outbox is not an advanced concept. It is a correctness requirement for any event-sourced workflow. Practice implementing it in the exercise service. The two operations (write to business table, write to outbox table) must be in the same DB transaction. This is the only way to guarantee at-least-once delivery without a distributed transaction.

### Senior @ FAANG: Pitfall Prevention as Platform Engineering

At L6/L7, pitfall prevention is a platform responsibility, not an individual team responsibility. The six pitfalls in this section each have a platform-level mitigation that prevents all future services from repeating the mistake.

**Distributed monolith prevention.** The platform publishes a synchronous-call depth limit as a convention: no service may make more than two synchronous calls to other services in a single request handler, and no call chain may exceed three hops. This is enforced by an architecture review checklist, not by a tool (there is no static analysis tool that can reliably detect cross-service call depth). The platform team also provides a service dependency map that is generated from distributed trace data: if the map shows a service with more than five synchronous dependencies, it triggers an automatic architecture review request.

**Discovery stampede prevention.** The platform mandates that all service discovery clients use the shared discovery library, which implements blocking queries with jittered reconnect by default. Services that bypass the library (custom HTTP clients that poll Consul directly) are flagged in CI. The platform also configures Consul with rate limits on the health check API to prevent any single client from exhausting the query budget.

**Timeout cascade prevention.** The platform provides a shared gRPC interceptor and HTTP middleware that enforce deadline propagation: if the incoming request has a deadline, the outgoing request inherits it (minus a small processing budget). If no deadline is present, a default is added. This is applied via the service template so that new services get the correct timeout behavior without configuration. Teams that want to override the default must file an exception with a latency budget analysis.

**Data integrity governance.** The platform requires that any service publishing domain events implements the transactional outbox. The service template includes an outbox table schema migration, an outbox processor goroutine, and a metrics gauge for outbox lag. The SLO for the outbox processor is: all rows published within 5 seconds of commit under normal load. The lag metric is monitored and pages the on-call if it exceeds 30 seconds.

**Observability cost governance.** The platform owns the OTel collector configuration, including the sampling rules. Teams cannot configure 100% trace sampling in production without an exception approved by the platform team with a cost estimate. The collector enforces head-based sampling at the platform level, and the platform team reviews the monthly observability cost report and identifies services that are producing disproportionate trace volume. The resolution is a tail-based sampling policy adjustment, not a conversation with the application team about their instrumentation.

---
