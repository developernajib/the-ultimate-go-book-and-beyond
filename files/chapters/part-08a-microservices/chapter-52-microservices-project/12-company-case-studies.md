## 52.11 Company Case Studies

### Amazon: E-Commerce at Planetary Scale

Amazon isolates order processing into "cells", independent units that each handle a subset of traffic. If one cell fails, the blast radius is contained. During peak events like Prime Day, the cell-based router directs orders to healthy cells with available capacity, falling back to other regions when the nearest cell is saturated. The pipeline pattern below shows how each order moves through discrete stages with checkpointing, so a crash mid-pipeline can resume from the last successful stage rather than restarting from scratch *(Reference: AWS Well-Architected Framework, "Reliability Pillar: Cell-based Architecture", AWS Whitepapers; Amazon Builders' Library, "Avoiding fallback in distributed systems")*.

```go
// Amazon-style Order Pipeline with Cell-Based Architecture
// Each "cell" is an independent unit that can process orders

package amazon

import (
    "context"
    "sync"
    "time"
)

// Cell represents an isolated order processing unit
type Cell struct {
    ID            string
    Region        string
    Capacity      int
    CurrentLoad   int
    OrderQueue    chan *Order
    WorkerPool    *WorkerPool
    CircuitBreaker *CircuitBreaker
    mu            sync.RWMutex
}

// CellRouter routes orders to appropriate cells
type CellRouter struct {
    cells         map[string]*Cell
    loadBalancer  LoadBalancer
    healthChecker *HealthChecker
    metrics       *Metrics
}

// NewCellRouter creates a cell-based router like Amazon uses
func NewCellRouter(cells []*Cell) *CellRouter {
    router := &CellRouter{
        cells:         make(map[string]*Cell),
        loadBalancer:  NewWeightedLoadBalancer(),
        healthChecker: NewHealthChecker(5 * time.Second),
    }

    for _, cell := range cells {
        router.cells[cell.ID] = cell
        router.healthChecker.Register(cell)
    }

    return router
}

// RouteOrder routes order to optimal cell based on:
// - Geographic proximity (reduce latency)
// - Cell capacity (avoid overload)
// - Cell health (avoid failing cells)
func (r *CellRouter) RouteOrder(ctx context.Context, order *Order) (*Cell, error) {
    // Filter healthy cells
    healthyCells := r.healthChecker.GetHealthyCells()
    if len(healthyCells) == 0 {
        return nil, ErrNoHealthyCells
    }

    // Prefer cells in same region for lower latency
    regionalCells := filterByRegion(healthyCells, order.ShippingRegion)
    targetCells := regionalCells
    if len(regionalCells) == 0 {
        targetCells = healthyCells
    }

    // Load balance among available cells
    cell := r.loadBalancer.Select(targetCells)

    // Check capacity with backpressure
    if cell.CurrentLoad >= cell.Capacity {
        r.metrics.RecordBackpressure(cell.ID)
        // Try other cells
        for _, c := range targetCells {
            if c.CurrentLoad < c.Capacity {
                cell = c
                break
            }
        }
    }

    return cell, nil
}

// OrderPipeline processes orders through multiple stages
type OrderPipeline struct {
    stages        []PipelineStage
    deadLetter    *DeadLetterQueue
    checkpointer  *Checkpointer
    metrics       *PipelineMetrics
}

type PipelineStage interface {
    Name() string
    Process(ctx context.Context, order *Order) error
    Compensate(ctx context.Context, order *Order) error
}

// ProcessOrder runs order through the pipeline with checkpointing
func (p *OrderPipeline) ProcessOrder(ctx context.Context, order *Order) error {
    checkpoint, err := p.checkpointer.Load(order.ID)
    if err != nil {
        checkpoint = &Checkpoint{StageIndex: 0}
    }

    // Resume from last checkpoint
    for i := checkpoint.StageIndex; i < len(p.stages); i++ {
        stage := p.stages[i]

        startTime := time.Now()
        err := stage.Process(ctx, order)
        p.metrics.RecordStageLatency(stage.Name(), time.Since(startTime))

        if err != nil {
            p.metrics.RecordStageError(stage.Name())

            // Compensate completed stages in reverse order
            for j := i - 1; j >= 0; j-- {
                if compErr := p.stages[j].Compensate(ctx, order); compErr != nil {
                    // Log but continue compensation
                    p.deadLetter.Enqueue(order, compErr)
                }
            }
            return err
        }

        // Checkpoint after each successful stage
        checkpoint.StageIndex = i + 1
        checkpoint.UpdatedAt = time.Now()
        p.checkpointer.Save(order.ID, checkpoint)
    }

    return nil
}

// InventoryReservationStage reserves inventory with optimistic locking
type InventoryReservationStage struct {
    inventory *InventoryService
    timeout   time.Duration
}

func (s *InventoryReservationStage) Process(ctx context.Context, order *Order) error {
    ctx, cancel := context.WithTimeout(ctx, s.timeout)
    defer cancel()

    // Amazon uses "soft reservations" that expire if not confirmed
    reservation := &Reservation{
        OrderID:   order.ID,
        Items:     order.Items,
        ExpiresAt: time.Now().Add(15 * time.Minute),
        Type:      ReservationSoft,
    }

    return s.inventory.Reserve(ctx, reservation)
}

func (s *InventoryReservationStage) Compensate(ctx context.Context, order *Order) error {
    return s.inventory.Release(ctx, order.ID)
}
```

### Shopify: Multi-Tenant E-Commerce Platform

Shopify's core challenge is tenant isolation: millions of merchants share the same infrastructure, but one merchant's traffic spike must not degrade another's experience. The implementation below demonstrates three key techniques: database sharding (each tenant's data lives on a specific shard), per-tenant rate limiting (using a Redis sliding window), and asynchronous webhook delivery (so merchant integrations do not block order processing) *(Reference: Shopify Engineering Blog, "A Pod in Every Port: How Shopify Scales Multi-Tenant Architecture" & "Under the Hood: How Shopify Handles Peak Traffic")*.

```go
// Shopify-style Multi-Tenant Order Processing
package shopify

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
)

// TenantContext carries tenant info through the request
type TenantContext struct {
    ShopID       string
    ShopDomain   string
    Plan         string
    RateLimit    int
    DatabaseShard string
}

// TenantAwareOrderService handles orders with tenant isolation
type TenantAwareOrderService struct {
    shardManager  *ShardManager
    rateLimiter   *TenantRateLimiter
    webhookRunner *WebhookRunner
    featureFlags  *FeatureFlags
}

// ShardManager manages database shards per tenant
type ShardManager struct {
    shards map[string]*sql.DB
    mu     sync.RWMutex
}

func (sm *ShardManager) GetConnection(shardID string) (*sql.DB, error) {
    sm.mu.RLock()
    defer sm.mu.RUnlock()

    db, ok := sm.shards[shardID]
    if !ok {
        return nil, fmt.Errorf("shard %s not found", shardID)
    }
    return db, nil
}

// CreateOrder creates an order with tenant isolation
func (s *TenantAwareOrderService) CreateOrder(
    ctx context.Context,
    tenant *TenantContext,
    req *CreateOrderRequest,
) (*Order, error) {
    // Check rate limit for this tenant
    if err := s.rateLimiter.Allow(tenant.ShopID, 1); err != nil {
        return nil, ErrRateLimitExceeded
    }

    // Get tenant's database shard
    db, err := s.shardManager.GetConnection(tenant.DatabaseShard)
    if err != nil {
        return nil, fmt.Errorf("get shard: %w", err)
    }

    // Create order with tenant scoping
    order := &Order{
        ID:        generateID(),
        ShopID:    tenant.ShopID,
        Status:    OrderPending,
        CreatedAt: time.Now(),
    }

    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // All queries scoped to shop_id
    _, err = tx.ExecContext(ctx, `
        INSERT INTO orders (id, shop_id, customer_id, status, total_cents, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, order.ID, tenant.ShopID, req.CustomerID, order.Status, req.TotalCents, order.CreatedAt)
    if err != nil {
        return nil, err
    }

    for _, item := range req.Items {
        _, err = tx.ExecContext(ctx, `
            INSERT INTO order_items (order_id, shop_id, product_id, quantity, price_cents)
            VALUES ($1, $2, $3, $4, $5)
        `, order.ID, tenant.ShopID, item.ProductID, item.Quantity, item.PriceCents)
        if err != nil {
            return nil, err
        }
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    // Fire webhooks asynchronously
    go s.webhookRunner.Fire(tenant.ShopID, "orders/create", order)

    return order, nil
}

// WebhookRunner executes merchant webhooks
type WebhookRunner struct {
    store   WebhookStore
    client  *http.Client
    queue   *AsyncQueue
    metrics *WebhookMetrics
}

func (wr *WebhookRunner) Fire(shopID, topic string, payload any) {
    webhooks, _ := wr.store.GetWebhooks(shopID, topic)

    for _, webhook := range webhooks {
        job := &WebhookJob{
            WebhookID: webhook.ID,
            ShopID:    shopID,
            URL:       webhook.URL,
            Topic:     topic,
            Payload:   payload,
            Attempt:   0,
            MaxRetries: 5,
        }
        wr.queue.Enqueue(job)
    }
}

// TenantRateLimiter implements per-tenant rate limiting
type TenantRateLimiter struct {
    redis    *redis.Client
    limits   map[string]int // plan -> requests per second
}

func (rl *TenantRateLimiter) Allow(shopID string, cost int) error {
    key := fmt.Sprintf("ratelimit:%s", shopID)

    // Use Redis sliding window
    pipe := rl.redis.Pipeline()
    now := time.Now().UnixNano()
    windowStart := now - int64(time.Second)

    // Remove old entries
    pipe.ZRemRangeByScore(context.Background(), key, "0", fmt.Sprintf("%d", windowStart))
    // Add current request
    pipe.ZAdd(context.Background(), key, redis.Z{Score: float64(now), Member: now})
    // Count requests in window
    count := pipe.ZCard(context.Background(), key)
    // Set expiry
    pipe.Expire(context.Background(), key, time.Second)

    _, err := pipe.Exec(context.Background())
    if err != nil {
        return err
    }

    if count.Val() > int64(rl.limits["default"]) {
        return ErrRateLimitExceeded
    }

    return nil
}
```

### Stripe: Payment Processing with Idempotency

Stripe's payment APIs are designed so that every mutating operation can be safely retried. The client sends an idempotency key with each request. If the same key arrives twice, Stripe returns the cached result instead of charging the customer again. The implementation below shows how to build this pattern in your own payment integration: a distributed lock prevents concurrent processing of the same key, and a webhook handler verifies HMAC signatures to prevent forged event delivery *(Reference: Stripe Engineering Blog, Brandur Leach, "Designing reliable and predictable APIs with idempotency", 2017; Stripe API Documentation, "Idempotent Requests & Webhook Signatures")*.

```go
// Stripe-style Payment Integration with Idempotency
package stripe_integration

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

// IdempotentPaymentProcessor ensures exactly-once payment processing
type IdempotentPaymentProcessor struct {
    store         IdempotencyStore
    stripeClient  *StripeClient
    orderService  *OrderService
    webhookSecret string
    mu            sync.Mutex
}

// IdempotencyStore tracks request idempotency
type IdempotencyStore interface {
    Get(key string) (*IdempotencyRecord, error)
    Set(key string, record *IdempotencyRecord) error
    Lock(key string, ttl time.Duration) (bool, error)
    Unlock(key string) error
}

type IdempotencyRecord struct {
    Key        string
    Response   []byte
    Status     string // pending, completed, error
    CreatedAt  time.Time
    LockedUntil *time.Time
}

// ProcessPayment handles payment with idempotency guarantees
func (p *IdempotentPaymentProcessor) ProcessPayment(
    ctx context.Context,
    idempotencyKey string,
    req *PaymentRequest,
) (*PaymentResponse, error) {
    // Check for existing result
    record, err := p.store.Get(idempotencyKey)
    if err == nil && record.Status == "completed" {
        var resp PaymentResponse
        json.Unmarshal(record.Response, &resp)
        return &resp, nil
    }

    // Acquire distributed lock
    locked, err := p.store.Lock(idempotencyKey, 30*time.Second)
    if err != nil {
        return nil, err
    }
    if !locked {
        return nil, ErrIdempotencyConflict
    }
    defer p.store.Unlock(idempotencyKey)

    // Create idempotency record
    record = &IdempotencyRecord{
        Key:       idempotencyKey,
        Status:    "pending",
        CreatedAt: time.Now(),
    }
    p.store.Set(idempotencyKey, record)

    // Create PaymentIntent with Stripe
    intent, err := p.stripeClient.CreatePaymentIntent(&CreatePaymentIntentParams{
        Amount:         req.AmountCents, // Stripe amounts are integer minor units
        Currency:       req.Currency,
        PaymentMethod:  req.PaymentMethodID,
        IdempotencyKey: idempotencyKey,
        Metadata: map[string]string{
            "order_id": req.OrderID,
        },
        Confirm: true,
    })

    if err != nil {
        record.Status = "error"
        record.Response, _ = json.Marshal(map[string]string{"error": err.Error()})
        p.store.Set(idempotencyKey, record)
        return nil, err
    }

    // Build response
    resp := &PaymentResponse{
        PaymentID:     intent.ID,
        Status:        intent.Status,
        ClientSecret:  intent.ClientSecret,
    }

    record.Status = "completed"
    record.Response, _ = json.Marshal(resp)
    p.store.Set(idempotencyKey, record)

    return resp, nil
}

// WebhookHandler processes Stripe webhooks securely
type WebhookHandler struct {
    processor     *IdempotentPaymentProcessor
    orderService  *OrderService
    webhookSecret string
}

// HandleWebhook verifies and processes Stripe webhook events
func (h *WebhookHandler) HandleWebhook(payload []byte, signature string) error {
    // Verify webhook signature
    if !h.verifySignature(payload, signature) {
        return ErrInvalidSignature
    }

    var event StripeEvent
    if err := json.Unmarshal(payload, &event); err != nil {
        return err
    }

    // Handle different event types
    switch event.Type {
    case "payment_intent.succeeded":
        return h.handlePaymentSucceeded(event.Data)
    case "payment_intent.payment_failed":
        return h.handlePaymentFailed(event.Data)
    case "charge.refunded":
        return h.handleRefund(event.Data)
    case "charge.dispute.created":
        return h.handleDispute(event.Data)
    default:
        // Log unknown events but don't fail
        return nil
    }
}

func (h *WebhookHandler) verifySignature(payload []byte, header string) bool {
    // Parse signature header
    parts := parseSignatureHeader(header)
    timestamp := parts["t"]
    signature := parts["v1"]

    // Check timestamp to prevent replay attacks
    ts, _ := strconv.ParseInt(timestamp, 10, 64)
    if time.Now().Unix()-ts > 300 { // 5 minute tolerance
        return false
    }

    // Compute expected signature
    signedPayload := fmt.Sprintf("%s.%s", timestamp, string(payload))
    mac := hmac.New(sha256.New, []byte(h.webhookSecret))
    mac.Write([]byte(signedPayload))
    expectedSig := hex.EncodeToString(mac.Sum(nil))

    return hmac.Equal([]byte(signature), []byte(expectedSig))
}

func (h *WebhookHandler) handlePaymentSucceeded(data json.RawMessage) error {
    var intent PaymentIntent
    json.Unmarshal(data, &intent)

    orderID := intent.Metadata["order_id"]

    // Update order status
    return h.orderService.UpdatePaymentStatus(
        context.Background(),
        orderID,
        intent.ID,
        "paid",
    )
}

// RefundProcessor handles refunds with proper state machine
type RefundProcessor struct {
    stripeClient *StripeClient
    orderService *OrderService
    inventory    *InventoryService
}

func (rp *RefundProcessor) ProcessRefund(
    ctx context.Context,
    orderID string,
    items []RefundItem,
    reason string,
) (*Refund, error) {
    order, err := rp.orderService.GetOrder(ctx, orderID)
    if err != nil {
        return nil, err
    }

    // Validate refund is possible
    if order.Status != OrderDelivered && order.Status != OrderShipped {
        return nil, ErrCannotRefund
    }

    // Calculate refund amount
    var amount int64
    for _, item := range items {
        amount += item.PriceCents * int64(item.Quantity)
    }

    // Create Stripe refund
    refund, err := rp.stripeClient.CreateRefund(&CreateRefundParams{
        PaymentIntent: order.PaymentID,
        Amount:        amount,
        Reason:        reason,
    })
    if err != nil {
        return nil, err
    }

    // Update order
    if err := rp.orderService.UpdateOrderStatus(ctx, orderID, OrderRefunded); err != nil {
        return nil, err
    }

    // Return items to inventory
    for _, item := range items {
        rp.inventory.Return(ctx, item.ProductID, item.Quantity)
    }

    return &Refund{
        ID:      refund.ID,
        OrderID: orderID,
        Amount:  amount,
        Status:  refund.Status,
    }, nil
}
```

### Junior → FAANG: What to Take From Each Case Study

These case studies are not just inspiration. They describe specific patterns that appear in FAANG interviews. Know each pattern by name, understand the problem it solves, and be ready to describe an implementation in Go.

**Amazon's cell-based architecture.** The key insight is blast radius containment. A cell failure affects only the subset of traffic routed to that cell, not all orders globally. The interview question this addresses is: "How do you design an order processing system that can handle a regional failure?" The answer includes: partition traffic by geographic region or by consistent hash of user ID, ensure each cell is self-contained (its own database, its own Kafka cluster), and route around unhealthy cells without manual intervention.

**Shopify's tenant isolation.** The key insight is that shared infrastructure must have hard boundaries to prevent one tenant's behavior from affecting others. The `TenantRateLimiter` in the case study uses Redis to enforce per-tenant request limits. The interview question this addresses is: "You have a SaaS platform where one customer is generating 10x normal traffic. How do you protect other customers?" The answer includes: per-tenant rate limiting, per-tenant circuit breakers, and tenant-aware monitoring so you can identify the offending tenant before other customers complain.

**Stripe's idempotency model.** The key insight is that every payment operation must be safely retryable. The `IdempotentPaymentProcessor` uses a distributed lock to prevent concurrent processing of the same idempotency key, then stores the result so that subsequent calls return the cached response. The interview question this addresses is: "How do you prevent double-charging a customer when the network times out during payment?" The answer is: idempotency keys, server-side result caching, and the webhook as the authoritative source of payment outcome.

**First-job habit from the Shopify case study.** Every database query in a multi-tenant system must include a `tenant_id` (or `shop_id`) filter. Missing the filter is a data isolation bug that leaks one customer's data to another. Build a linting rule or a repository wrapper that requires the tenant filter on every query.

### Senior @ FAANG: Platform Patterns, Organizational Scale, and Bar-Raiser Interview Signals

These case studies describe architectural patterns at organizational scale. The staff-level question is not "can you implement this pattern" but "can you evaluate when it is the right choice, govern its adoption, and identify its failure modes."

**Cell-based architecture: when it is worth the operational cost.** Splitting traffic into cells multiplies your infrastructure: N cells means N database clusters, N Kafka clusters, N deployment pipelines. The operational burden is non-trivial. The cell model is worth it when: your blast radius analysis shows that a single-region failure would affect more than a tolerable fraction of customers, your SLA requires four or more nines, and your traffic is partitionable without cross-cell coordination. For most companies below Amazon's scale, a multi-region active-active deployment without cell isolation achieves the same SLA with less complexity. The bar-raiser question is: "At what scale would you introduce cells, and what metrics would tell you it is time?"

**Multi-tenant isolation maturity model.** Shopify's model has four maturity levels: Level 1, no isolation (all tenants share everything). Level 2, logical isolation (tenant ID filter on all queries, but shared infrastructure). Level 3, physical isolation for large tenants (dedicated database shard, dedicated Kafka consumer group). Level 4, dedicated infrastructure for enterprise tenants (private cluster, dedicated support SLA). A staff engineer designing a new SaaS platform specifies which level the MVP targets and documents the criteria for graduating a tenant to a higher isolation level. This is the kind of forward-looking design thinking that distinguishes a principal engineer.

**Stripe's idempotency model applied to internal systems.** The idempotency model is not only for payment gateways. Any operation that has a visible side effect (sending an email, creating a shipment label, deducting from a wallet) should be idempotent. At FAANG, the platform team defines an idempotency standard: every mutating API endpoint must accept an `X-Idempotency-Key` header, implement the check-lock-process-store pattern, and return the cached result for duplicate keys. This standard is enforced through an API gateway policy and reviewed in design documents. A staff engineer proposing a new service that skips this standard needs to justify the exception explicitly.

---
