## 52.13 Interview Questions

### Question 1: How would you handle a scenario where the payment succeeds but order confirmation fails?

**Answer:**

This is a classic distributed transaction problem. Here's how I'd handle it:

```go
// Solution: Saga pattern with compensation and idempotent operations

type OrderSaga struct {
    orderRepo      OrderRepository
    paymentService PaymentService
    inventoryService InventoryService
    publisher      EventPublisher
    logger         *slog.Logger
}

func (s *OrderSaga) Execute(ctx context.Context, order *Order) error {
    // Step 1: Reserve inventory (can be compensated)
    reservationID, err := s.inventoryService.Reserve(ctx, order.Items)
    if err != nil {
        return fmt.Errorf("reserve inventory: %w", err)
    }

    // Step 2: Process payment
    // IMPORTANT: Use idempotency key based on order ID
    payment, err := s.paymentService.Process(ctx, &PaymentRequest{
        AmountCents:    order.TotalCents,
        IdempotencyKey: fmt.Sprintf("order-%s", order.ID),
    })
    if err != nil {
        // Compensate: Release inventory
        s.inventoryService.Release(ctx, reservationID)
        return fmt.Errorf("process payment: %w", err)
    }

    // Step 3: Confirm order
    order.Status = OrderConfirmed
    order.PaymentID = payment.ID

    err = s.orderRepo.Update(ctx, order)
    if err != nil {
        // Payment succeeded but order update failed!
        // Options:
        // 1. Retry order update (preferred if transient)
        // 2. Queue for manual reconciliation
        // 3. Auto-refund (use carefully)

        // First, retry with backoff
        for i := 0; i < 3; i++ {
            time.Sleep(time.Duration(i*100) * time.Millisecond)
            if err = s.orderRepo.Update(ctx, order); err == nil {
                break
            }
        }

        if err != nil {
            // Queue for reconciliation - payment exists but order not updated
            s.publisher.Publish(ctx, "order.reconciliation.needed", ReconciliationEvent{
                OrderID:   order.ID,
                PaymentID: payment.ID,
                Reason:    "order_update_failed",
                Error:     err.Error(),
            })

            // Log with full context for ops team
            s.logger.Error("Order confirmation failed after payment",
                "order_id", order.ID,
                "payment_id", payment.ID,
                "error", err,
            )

            // Don't auto-refund! Payment is valid, just need manual intervention
            return ErrOrderConfirmationFailed
        }
    }

    // Confirm inventory reservation
    s.inventoryService.Confirm(ctx, reservationID)

    return nil
}

// Reconciliation worker processes failed confirmations
type ReconciliationWorker struct {
    orderRepo      OrderRepository
    paymentService PaymentService
    alerter        Alerter
}

func (w *ReconciliationWorker) HandleReconciliation(ctx context.Context, event ReconciliationEvent) error {
    // Check if order was eventually updated
    order, err := w.orderRepo.Get(ctx, event.OrderID)
    if err != nil {
        return err
    }

    if order.Status == OrderConfirmed {
        // Already reconciled
        return nil
    }

    // Verify payment exists
    payment, err := w.paymentService.Get(ctx, event.PaymentID)
    if err != nil || payment.Status != PaymentSucceeded {
        // Payment doesn't exist or failed - refund not needed
        return nil
    }

    // Try to update order again
    order.Status = OrderConfirmed
    order.PaymentID = payment.ID

    if err := w.orderRepo.Update(ctx, order); err != nil {
        // Still failing - alert ops team
        w.alerter.Alert("Manual reconciliation needed", map[string]string{
            "order_id":   event.OrderID,
            "payment_id": event.PaymentID,
        })
        return err
    }

    return nil
}
```

Key principles:
1. **Idempotent operations**: Payment uses idempotency key, so retries are safe
2. **Retry before compensating**: Don't immediately refund - database might recover
3. **Reconciliation queue**: Handle edge cases asynchronously
4. **Alerting**: Ops team can manually intervene if automation fails

**What FAANG expects:** You must name the failure mode out loud ("dual-write between payment and order DB is the hard part"), reach for the *outbox pattern* or a durable workflow engine (Temporal) rather than ad-hoc retry loops, and explicitly separate *client-facing idempotency* (the key on the HTTP request) from *infrastructure idempotency* (Kafka consumer deduplication). Bonus points for mentioning that the webhook from the payment gateway is the actual source of truth, not the synchronous response.

**Follow-ups interviewers will push:**
- "The retry loop above blocks the request thread for 600ms, what do you do under 10k RPS?" (Answer: kick a background reconciliation job, return 202, notify the client via webhook/SSE.)
- "Two webhooks arrive at the same time for the same payment intent, how do you not double-credit?" (Answer: store the Stripe event ID with a UNIQUE constraint, process inside `SELECT ... FOR UPDATE` on the order row.)
- "How would Temporal change this code?" (Answer: `workflow.ExecuteActivity` for each step, Temporal persists state and replays on crash, the reconciliation worker disappears.)

---

### Question 2: How do you design service boundaries in a microservices e-commerce system?

**Answer:**

I use Domain-Driven Design (DDD) principles to define bounded contexts:

```
E-Commerce Domain Decomposition:

┌──────────────────────────────────────────────────────────────┐
│                    CORE DOMAINS                              │
│  (Critical to business - invest most engineering effort)     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │   ORDER     │  │  INVENTORY  │  │   PAYMENT   │           │
│  │  CONTEXT    │  │  CONTEXT    │  │  CONTEXT    │           │
│  │             │  │             │  │             │           │
│  │ • Order     │  │ • Stock     │  │ • Payment   │           │
│  │ • Cart      │  │ • Warehouse │  │ • Refund    │           │
│  │ • Checkout  │  │ • Supplier  │  │ • Settlement│           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                  SUPPORTING DOMAINS                          │
│  (Enable core domains - important but not differentiating)   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │   USER      │  │   PRODUCT   │  │  SHIPPING   │           │
│  │  CONTEXT    │  │  CONTEXT    │  │  CONTEXT    │           │
│  │             │  │             │  │             │           │
│  │ • Profile   │  │ • Catalog   │  │ • Shipment  │           │
│  │ • Auth      │  │ • Pricing   │  │ • Tracking  │           │
│  │ • Address   │  │ • Category  │  │ • Carrier   │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                   GENERIC DOMAINS                            │
│  (Commodity - buy or use off-the-shelf)                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │NOTIFICATION │  │   SEARCH    │  │  ANALYTICS  │           │
│  │  CONTEXT    │  │  CONTEXT    │  │  CONTEXT    │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

```go
// Service boundary design principles:

// 1. Each service owns its data completely
type OrderService struct {
    // Own database - no shared tables
    db *sql.DB

    // Communicate via events/APIs, not direct DB access
    inventoryClient InventoryClient
    publisher       EventPublisher
}

// 2. Define clear contracts between services
// Order Service's view of a Product (minimal)
type OrderProduct struct {
    ID    string
    Name  string
    PriceCents int64
}

// Product Service's full Product (rich)
type Product struct {
    ID          string
    Name        string
    Description string
    PriceCents  int64
    Category    Category
    Attributes  map[string]string
    Images      []Image
    SEO         SEOData
    // ... much more
}

// 3. Anti-corruption layer protects domain model
type ProductAntiCorruptionLayer struct {
    productClient ProductClient
}

func (acl *ProductAntiCorruptionLayer) GetProductForOrder(
    ctx context.Context,
    productID string,
) (*OrderProduct, error) {
    // Fetch full product from Product Service
    full, err := acl.productClient.Get(ctx, productID)
    if err != nil {
        return nil, err
    }

    // Transform to Order domain's minimal view
    return &OrderProduct{
        ID:    full.ID,
        Name:  full.Name,
        PriceCents: full.PriceCents,
    }, nil
}

// 4. Context Map shows relationships
/*
Order Context <──── Conformist ────> Payment Context
    │                                      │
    │ Customer-Supplier                    │ Conformist
    ▼                                      ▼
Inventory Context              External Payment Gateway

Product Context ──── Shared Kernel ──── Search Context
                    (Product schema)
*/
```

Key decision criteria:
1. **Business capability**: Each service = one business capability
2. **Data ownership**: Clear owner for each piece of data
3. **Team alignment**: One team per service (Conway's Law)
4. **Change frequency**: Things that change together stay together
5. **Scalability needs**: Services with different load patterns separate

**What FAANG expects:** Don't lead with "microservices", lead with bounded contexts and ubiquitous language. Interviewers want to see you decompose the domain *before* talking about deployment units, acknowledge that a badly-drawn service boundary is worse than a monolith, and apply the "core vs supporting vs generic" lens from Evans. They'll also expect you to cite Conway's Law and be ready to say "we would not split this into a service just because it's technically possible."

**Follow-ups interviewers will push:**
- "Why is cart in the Order context and not its own service?" (Answer: cart and checkout share the same aggregate root and transactional invariants. Splitting them creates chatty sync calls for no gain.)
- "Your Product and Search contexts use the same Product schema, isn't that a shared database anti-pattern?" (Answer: it's a *shared kernel* with an explicit contract and a single owning team. Either that or Search keeps its own denormalized projection populated by events.)
- "When would you merge two services back into one?" (Answer: if they change together every release, share a transaction boundary, or have become a distributed monolith with synchronous call chains.)

---

### Question 3: How do you ensure data consistency across microservices without distributed transactions?

**Answer:**

I use eventual consistency with the Saga pattern and carefully designed compensation:

```go
// Strategy 1: Choreography-based Saga (event-driven)
// Each service publishes events, others react

// Order Service
func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) error {
    order := &Order{ID: generateID(), Status: OrderPending}
    s.db.Create(order)

    // Publish event - triggers saga
    s.publisher.Publish("order.created", OrderCreatedEvent{
        OrderID: order.ID,
        Items:   req.Items,
    })
    return nil
}

// Inventory Service - reacts to order.created
func (h *InventoryHandler) OnOrderCreated(event OrderCreatedEvent) {
    err := h.reserve(event.OrderID, event.Items)
    if err != nil {
        h.publisher.Publish("inventory.reservation.failed", InventoryFailedEvent{
            OrderID: event.OrderID,
            Reason:  err.Error(),
        })
        return
    }
    h.publisher.Publish("inventory.reserved", InventoryReservedEvent{
        OrderID: event.OrderID,
    })
}

// Payment Service - reacts to inventory.reserved
func (h *PaymentHandler) OnInventoryReserved(event InventoryReservedEvent) {
    err := h.processPayment(event.OrderID)
    if err != nil {
        h.publisher.Publish("payment.failed", PaymentFailedEvent{
            OrderID: event.OrderID,
        })
        return
    }
    h.publisher.Publish("payment.processed", PaymentProcessedEvent{
        OrderID: event.OrderID,
    })
}

// Inventory Service - compensates on payment.failed
func (h *InventoryHandler) OnPaymentFailed(event PaymentFailedEvent) {
    h.releaseReservation(event.OrderID)
}

// Strategy 2: Orchestration-based Saga (central coordinator)
type OrderSagaOrchestrator struct {
    steps []SagaStep
}

func (o *OrderSagaOrchestrator) Execute(ctx context.Context, order *Order) error {
    executedSteps := []SagaStep{}

    for _, step := range o.steps {
        if err := step.Execute(ctx, order); err != nil {
            // Compensate in reverse order
            for i := len(executedSteps) - 1; i >= 0; i-- {
                executedSteps[i].Compensate(ctx, order)
            }
            return err
        }
        executedSteps = append(executedSteps, step)
    }

    return nil
}

// Strategy 3: Outbox Pattern for reliable publishing
func (s *OrderService) CreateOrderWithOutbox(ctx context.Context, req *CreateOrderRequest) error {
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Create order
    order := &Order{ID: generateID()}
    tx.Exec("INSERT INTO orders ...", order)

    // Write event to outbox (same transaction)
    event := OrderCreatedEvent{OrderID: order.ID}
    eventData, _ := json.Marshal(event)
    tx.Exec("INSERT INTO outbox (topic, payload) VALUES ($1, $2)",
        "order.created", eventData)

    // Single atomic commit
    return tx.Commit()
}

// Outbox relay reads from outbox, publishes to Kafka
func (r *OutboxRelay) Run() {
    for {
        events := r.db.Query("SELECT * FROM outbox WHERE published = false LIMIT 100")
        for _, e := range events {
            r.kafka.Publish(e.Topic, e.Payload)
            r.db.Exec("UPDATE outbox SET published = true WHERE id = $1", e.ID)
        }
    }
}
```

**What FAANG expects:** Say "eventual consistency" early, acknowledge that two-phase commit is off the table at scale, and reach for the outbox pattern without being prompted. You should also volunteer that every saga step must be *idempotent* and every event consumer must dedupe (event ID + `UNIQUE` constraint or a processed-events table), that's the detail that separates someone who has read about sagas from someone who has operated them. Mention Debezium/CDC as the production-grade alternative to a polling outbox relay.

**Follow-ups interviewers will push:**
- "Choreography or orchestration, which and why?" (Answer: choreography up to ~3 participants, orchestration with Temporal or a central saga coordinator once you need visibility across 5+ steps or cross-team ownership.)
- "How do you handle a compensating action that itself fails?" (Answer: retry with backoff, then quarantine to a DLQ and page ops. Design compensations to be idempotent from the start.)
- "The outbox relay just published an event but crashed before marking it published, what happens?" (Answer: at-least-once delivery, consumer must dedupe on event ID. This is why exactly-once requires the consumer to participate.)

---

### Question 4: How would you implement rate limiting in an API gateway for a multi-tenant e-commerce platform?

**Answer:**

```go
// Multi-tenant rate limiter with different tiers
type TenantRateLimiter struct {
    redis    *redis.Client
    limits   map[string]TierLimits // tier -> limits
    metrics  *prometheus.CounterVec
}

type TierLimits struct {
    RequestsPerSecond int
    RequestsPerMinute int
    BurstSize         int
}

var defaultLimits = map[string]TierLimits{
    "free":       {10, 100, 20},
    "starter":    {50, 1000, 100},
    "business":   {200, 5000, 500},
    "enterprise": {1000, 50000, 2000},
}

// RateLimit checks if request should be allowed
func (rl *TenantRateLimiter) RateLimit(ctx context.Context, tenantID, tier string) error {
    limits := rl.limits[tier]

    // Use sliding window algorithm
    now := time.Now().UnixMicro()
    windowKey := fmt.Sprintf("ratelimit:%s:window", tenantID)

    pipe := rl.redis.Pipeline()

    // Remove old entries (outside 1-second window)
    windowStart := now - int64(time.Second/time.Microsecond)
    pipe.ZRemRangeByScore(ctx, windowKey, "0", fmt.Sprintf("%d", windowStart))

    // Add current request
    pipe.ZAdd(ctx, windowKey, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d", now)})

    // Count requests in window
    countCmd := pipe.ZCard(ctx, windowKey)

    // Set expiry
    pipe.Expire(ctx, windowKey, 2*time.Second)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return err
    }

    count := countCmd.Val()

    if count > int64(limits.RequestsPerSecond) {
        rl.metrics.WithLabelValues(tenantID, tier, "rejected").Inc()
        return &RateLimitError{
            Limit:      limits.RequestsPerSecond,
            Remaining:  0,
            RetryAfter: time.Second,
        }
    }

    rl.metrics.WithLabelValues(tenantID, tier, "allowed").Inc()
    return nil
}

// Middleware applies rate limiting
func RateLimitMiddleware(limiter *TenantRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            tenant := getTenantFromContext(r.Context())

            err := limiter.RateLimit(r.Context(), tenant.ID, tenant.Tier)
            if err != nil {
                if rlErr, ok := err.(*RateLimitError); ok {
                    w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", rlErr.Limit))
                    w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", rlErr.Remaining))
                    w.Header().Set("Retry-After", fmt.Sprintf("%d", int(rlErr.RetryAfter.Seconds())))
                    http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                    return
                }
                http.Error(w, "Internal error", http.StatusInternalServerError)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

**What FAANG expects:** You must pick a specific algorithm (sliding window, token bucket, leaky bucket) and defend it, distinguish *per-tenant* from *per-endpoint* from *per-IP* limiting, and explain how you avoid the Redis hot-key problem at hyperscale (sharding the key by hashed tenant prefix, using `CL.THROTTLE` from RedisCell, or local-first limits with periodic sync). Mentioning that rate limiting is a *defense in depth* layer, fronted by the CDN/WAF for L7 floods, signals production experience.

**Follow-ups interviewers will push:**
- "What happens to your limiter when Redis goes down?" (Answer: fail-open for availability-critical paths, fail-closed for write-critical paths. Fall back to a local token bucket per pod as a safety net.)
- "A customer says they're getting 429s but your dashboard shows they're well under the tier limit, how do you debug?" (Answer: clock skew on the sliding window, bursts hitting a single pod with local limits, retry storms on their side. Check `X-RateLimit-*` headers you return per request.)
- "How would you let enterprise customers burst past the limit for 30 seconds?" (Answer: token bucket with a burst capacity larger than the refill rate, or a secondary "credit" bucket replenished more slowly.)

---

### Question 5: How do you handle service discovery and load balancing in a microservices architecture?

**Answer:**

```go
// Service Discovery with Consul and client-side load balancing

type ServiceDiscovery struct {
    consul      *consul.Client
    cache       *ServiceCache
    loadBalancer LoadBalancer
}

// ServiceCache caches service instances locally
type ServiceCache struct {
    services map[string][]*ServiceInstance
    mu       sync.RWMutex
    ttl      time.Duration
}

type ServiceInstance struct {
    ID       string
    Address  string
    Port     int
    Healthy  bool
    Metadata map[string]string
    Weight   int
}

// GetService returns a healthy instance of the service
func (sd *ServiceDiscovery) GetService(ctx context.Context, serviceName string) (*ServiceInstance, error) {
    // Try cache first
    instances := sd.cache.Get(serviceName)
    if len(instances) == 0 {
        // Fetch from Consul
        var err error
        instances, err = sd.fetchFromConsul(ctx, serviceName)
        if err != nil {
            return nil, err
        }
        sd.cache.Set(serviceName, instances)
    }

    // Filter healthy instances
    healthy := filterHealthy(instances)
    if len(healthy) == 0 {
        return nil, ErrNoHealthyInstances
    }

    // Load balance
    return sd.loadBalancer.Select(healthy), nil
}

// WeightedRoundRobin load balancer
type WeightedRoundRobin struct {
    current map[string]int
    mu      sync.Mutex
}

func (wrr *WeightedRoundRobin) Select(instances []*ServiceInstance) *ServiceInstance {
    wrr.mu.Lock()
    defer wrr.mu.Unlock()

    // Calculate total weight
    totalWeight := 0
    for _, inst := range instances {
        totalWeight += inst.Weight
    }

    // Select based on weight
    idx := wrr.current["counter"] % totalWeight
    wrr.current["counter"]++

    cumulative := 0
    for _, inst := range instances {
        cumulative += inst.Weight
        if idx < cumulative {
            return inst
        }
    }

    return instances[0]
}

// ServiceClient wraps HTTP client with service discovery
type ServiceClient struct {
    discovery *ServiceDiscovery
    client    *http.Client
    retrier   *Retrier
}

func (c *ServiceClient) Call(ctx context.Context, serviceName, path string, req, resp any) error {
    return c.retrier.Do(ctx, func() error {
        instance, err := c.discovery.GetService(ctx, serviceName)
        if err != nil {
            return err
        }

        url := fmt.Sprintf("http://%s:%d%s", instance.Address, instance.Port, path)

        body, _ := json.Marshal(req)
        httpReq, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
        httpReq.Header.Set("Content-Type", "application/json")

        httpResp, err := c.client.Do(httpReq)
        if err != nil {
            // Mark instance as potentially unhealthy
            c.discovery.MarkUnhealthy(instance.ID)
            return err
        }
        defer httpResp.Body.Close()

        return json.NewDecoder(httpResp.Body).Decode(resp)
    })
}

// Service registration on startup
func RegisterService(consul *consul.Client, service *ServiceConfig) error {
    registration := &consul.AgentServiceRegistration{
        ID:      service.ID,
        Name:    service.Name,
        Port:    service.Port,
        Address: service.Address,
        Check: &consul.AgentServiceCheck{
            HTTP:     fmt.Sprintf("http://%s:%d/health", service.Address, service.Port),
            Interval: "10s",
            Timeout:  "5s",
        },
        Meta: map[string]string{
            "version": service.Version,
        },
    }

    return consul.Agent().ServiceRegister(registration)
}
```

**What FAANG expects:** Know the trade-off between client-side and server-side load balancing (client-side avoids an extra hop but couples clients to the discovery mechanism. Server-side via an L4/L7 proxy like Envoy is what service meshes give you for free). You should also bring up *active* vs *passive* health checking, the "thundering herd on restart" problem (why you jitter re-registrations), and why in 2026 most teams have retired hand-rolled Consul clients in favour of a service mesh (Istio, Linkerd, or Envoy + xDS) that handles discovery, retries, mTLS, and observability as a platform feature. Kubernetes-native shops typically just use `Service` + `EndpointSlice` + headless services for gRPC.

**Follow-ups interviewers will push:**
- "Why client-side load balancing here instead of just putting an ALB in front of each service?" (Answer: per-request latency, skip the extra hop, and gRPC keeps one long-lived connection per backend, so you need client-side LB to spread load across replicas.)
- "Your cache TTL is 30s. A pod dies, how long before traffic stops hitting it?" (Answer: up to TTL + health-check interval in the worst case, which is why you also react to connection errors to eject immediately.)
- "Would you still roll your own with Consul today, or use a service mesh?" (Answer: mesh, unless you're on bare metal without Kubernetes, the built-in retry, circuit breaking, mTLS, and telemetry pay for themselves quickly.)

### Junior → FAANG: How to Use These Questions Before Your Interview

These five questions cover the highest-probability topics in a FAANG distributed systems interview for an e-commerce domain. Do not just read the answers. Practice delivering them out loud.

**Calibrate your answer length.** A FAANG system design interview gives you 45 to 60 minutes. Each major topic (service boundaries, data consistency, rate limiting, service discovery) should take 8 to 12 minutes including discussion. If your answer to question 3 takes two minutes, you are not going deep enough. If it takes 20 minutes, you are not managing time. Practice with a timer.

**Name the pattern before you explain it.** When asked about distributed transactions, say "I would use a saga pattern" before drawing anything. When asked about rate limiting, say "I would use a sliding window algorithm" before writing code. Naming patterns signals that you have a vocabulary for the problem domain, which is what interviewers are assessing.

**Use the follow-up questions as your preparation drill.** The follow-ups in each answer are real questions that FAANG interviewers ask. If you cannot answer the follow-up without reading the hint, that is a gap to close before the interview. Pick one follow-up per day and spend 15 minutes researching it until you can answer without notes.

**Draw before you code.** In the interview, ask for a whiteboard or use the shared document. Draw the state machine for a saga before explaining it. Draw the token bucket for rate limiting. Draw the cell router for the Amazon question. Drawings force precision and give the interviewer something concrete to react to.

**First-job entry point.** If you are interviewing for a mid-level role (L4/L5) rather than a senior role, focus on questions 1, 2, and 3. Being able to discuss the saga pattern with concrete code, explain service boundary reasoning with DDD terminology, and describe the outbox pattern for eventual consistency covers the core of a mid-level distributed systems assessment.

### Senior @ FAANG: What Bar-Raisers Are Actually Measuring

At the L6/L7 level, these interview questions have no "correct" answer. They are conversation starters. The bar-raiser is measuring how you think, not what you know.

**Proactive failure mode identification.** The L6 signal in question 1 ("payment succeeds but order confirmation fails") is identifying the failure mode before the interviewer completes the sentence. A bar-raiser candidate hears "how would you handle a scenario where..." and immediately starts listing the failure modes: crash between payment and order update, network timeout on the update, database deadlock on the update, successful update but failed event publication. Each mode has a different mitigation. Walking through all of them, rather than picking one, demonstrates the completeness of thinking that distinguishes L6.

**Trade-off quantification, not trade-off enumeration.** Enumerating trade-offs (choreography has lower coupling, orchestration has better visibility) is L4 behavior. Quantifying trade-offs (choreography becomes operationally unmanageable beyond approximately three participants because the causal chain is not visible in any single service's logs, based on our incident data from the fulfillment saga) is L6 behavior. Practice attaching numbers or experience to every trade-off you name.

**Organizational and team topology awareness.** The service boundary question (question 2) is not just a technical question at the L6 level. The correct answer mentions Conway's Law and asks about team structure before proposing a decomposition. "What does your org chart look like?" is a legitimate response to "how would you design the service boundaries?" A decomposition that misaligns with team ownership creates the distributed monolith problem organizationally, even if the technical architecture is sound.

**Proposing the path to the next maturity level.** Every answer in this file is a point-in-time solution. A bar-raiser candidate ends every answer with: "This is right for our current scale and team size. At 10x the current order volume, I would [describe the next architectural step]. The trigger to make that change is [specific metric or business event]." This forward-looking framing demonstrates L7 thinking: not just solving the current problem, but anticipating and designing for the next one.

---
