## 52.12 Common Mistakes

### Mistake 1: Distributed Monolith - Tight Coupling Between Services

When every service call is synchronous and every service must be online for any request to succeed, you have a distributed monolith: all the operational complexity of microservices with none of the resilience benefits. The fix is to reserve synchronous calls for the critical path (inventory check) and use events for everything else, so a downed notification service does not block order creation.

```go
// ❌ Bad: Services directly call each other synchronously for everything
type OrderService struct {
    userClient      *UserServiceClient
    inventoryClient *InventoryServiceClient
    paymentClient   *PaymentServiceClient
    shippingClient  *ShippingServiceClient
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Chain of synchronous calls - if any fails, everything fails
    user, err := s.userClient.GetUser(ctx, req.UserID)
    if err != nil {
        return nil, err // User service down = orders down
    }

    inventory, err := s.inventoryClient.CheckStock(ctx, req.Items)
    if err != nil {
        return nil, err // Inventory service down = orders down
    }

    payment, err := s.paymentClient.ProcessPayment(ctx, req.PaymentDetails)
    if err != nil {
        return nil, err // Payment service down = orders down
    }

    shipping, err := s.shippingClient.CreateShipment(ctx, req.ShippingAddr)
    if err != nil {
        return nil, err // Shipping service down = orders down
    }

    // All services must be up simultaneously
    return &Order{...}, nil
}

// ✅ Good: Event-driven with graceful degradation
type OrderService struct {
    db           *sql.DB
    publisher    EventPublisher
    inventory    *InventoryServiceClient
    cache        *OrderCache
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Only synchronous call is inventory check (critical path)
    available, err := s.inventory.CheckStockWithFallback(ctx, req.Items)
    if err != nil {
        // Use cached inventory data as fallback
        available, err = s.cache.GetCachedAvailability(req.Items)
        if err != nil {
            return nil, ErrServiceTemporarilyUnavailable
        }
    }

    if !available {
        return nil, ErrInsufficientStock
    }

    // Create order locally
    order := &Order{
        ID:        generateID(),
        UserID:    req.UserID,
        Items:     req.Items,
        Status:    OrderPending,
        CreatedAt: time.Now(),
    }

    if err := s.saveOrder(ctx, order); err != nil {
        return nil, err
    }

    // Publish event - other services react asynchronously
    s.publisher.Publish(ctx, "order.created", OrderCreatedEvent{
        OrderID:   order.ID,
        UserID:    order.UserID,
        Items:     order.Items,
        Timestamp: time.Now(),
    })

    return order, nil
}
```

### Mistake 2: Missing Idempotency in Event Handlers

Kafka guarantees at-least-once delivery, which means your event handlers will occasionally receive the same event twice (after a consumer crash, rebalance, or network hiccup). Without idempotency checks, a duplicate `order.created` event processes payment twice, charging the customer double. The correct approach checks both an idempotency store and the existence of the payment record before processing.

```go
// ❌ Bad: Non-idempotent event handler
func (h *PaymentHandler) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
    // If this handler runs twice (retry), payment will be processed twice!
    payment, err := h.paymentService.ProcessPayment(ctx, &PaymentRequest{
        OrderID: event.OrderID,
        Amount:  event.TotalAmount,
    })
    if err != nil {
        return err
    }

    return h.notifyPaymentSuccess(ctx, payment)
}

// ✅ Good: Idempotent event handler
func (h *PaymentHandler) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
    // Check if we've already processed this event
    processed, err := h.idempotencyStore.IsProcessed(ctx, event.EventID)
    if err != nil {
        return err
    }
    if processed {
        return nil // Already handled, skip
    }

    // Check if payment already exists for this order
    existing, err := h.paymentService.GetPaymentByOrderID(ctx, event.OrderID)
    if err == nil && existing != nil {
        // Payment already exists, mark event as processed
        return h.idempotencyStore.MarkProcessed(ctx, event.EventID)
    }

    // Process payment with idempotency key
    payment, err := h.paymentService.ProcessPayment(ctx, &PaymentRequest{
        OrderID:        event.OrderID,
        Amount:         event.TotalAmount,
        IdempotencyKey: fmt.Sprintf("payment-%s", event.OrderID),
    })
    if err != nil {
        return err
    }

    // Mark event as processed AFTER successful handling
    if err := h.idempotencyStore.MarkProcessed(ctx, event.EventID); err != nil {
        // Log but don't fail - next retry will skip via idempotency check
        log.Warn("Failed to mark event processed", "event_id", event.EventID)
    }

    return h.notifyPaymentSuccess(ctx, payment)
}
```

### Mistake 3: Missing Circuit Breakers for External Services

A circuit breaker monitors calls to a dependency and opens the circuit, failing fast, when the error rate exceeds a threshold. After a configurable cooldown period, the circuit transitions to half-open, allowing a probe request to test whether the dependency has recovered.

```go
// ❌ Bad: No protection against failing dependencies
type ProductService struct {
    db              *sql.DB
    searchClient    *ElasticsearchClient
    recommendClient *RecommendationClient
}

func (s *ProductService) GetProductPage(ctx context.Context, productID string) (*ProductPage, error) {
    product, err := s.db.GetProduct(ctx, productID)
    if err != nil {
        return nil, err
    }

    // If search service is slow/down, this request hangs
    related, err := s.searchClient.GetRelatedProducts(ctx, productID)
    if err != nil {
        return nil, err // Fail entire request because of optional feature
    }

    // If recommendation service is down, request fails
    recommendations, err := s.recommendClient.GetRecommendations(ctx, productID)
    if err != nil {
        return nil, err
    }

    return &ProductPage{product, related, recommendations}, nil
}

// ✅ Good: Circuit breakers with graceful degradation
type ProductService struct {
    db               *sql.DB
    searchClient     *ElasticsearchClient
    recommendClient  *RecommendationClient
    searchBreaker    *gobreaker.CircuitBreaker
    recommendBreaker *gobreaker.CircuitBreaker
    cache            *ProductCache
}

func (s *ProductService) GetProductPage(ctx context.Context, productID string) (*ProductPage, error) {
    // Core data must succeed
    product, err := s.db.GetProduct(ctx, productID)
    if err != nil {
        return nil, err
    }

    page := &ProductPage{Product: product}

    // Related products with circuit breaker
    result, err := s.searchBreaker.Execute(func() (any, error) {
        ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
        defer cancel()
        return s.searchClient.GetRelatedProducts(ctx, productID)
    })

    if err == nil {
        page.RelatedProducts = result.([]Product)
    } else {
        // Fallback to cached data
        page.RelatedProducts = s.cache.GetCachedRelated(productID)
        log.Warn("Search service unavailable, using cache", "product_id", productID)
    }

    // Recommendations with circuit breaker
    result, err = s.recommendBreaker.Execute(func() (any, error) {
        ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
        defer cancel()
        return s.recommendClient.GetRecommendations(ctx, productID)
    })

    if err == nil {
        page.Recommendations = result.([]Product)
    } else {
        // Degrade gracefully - show popular products instead
        page.Recommendations = s.cache.GetPopularProducts()
    }

    return page, nil
}
```

### Mistake 4: Shared Database Between Services

When two services write to the same table, you lose independent deployability: changing the inventory schema requires coordinating with the order service team. You also introduce race conditions, since both services issue concurrent writes without awareness of each other's transactions. The fix is strict data ownership, each service controls its own tables and exposes data through APIs or events.

```go
// ❌ Bad: Multiple services accessing same tables
// Order Service
func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) error {
    tx, _ := s.db.BeginTx(ctx, nil)

    // Order service directly updates inventory table
    _, err := tx.ExecContext(ctx,
        "UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2",
        req.Quantity, req.ProductID)

    // Creates tight coupling - can't change inventory schema without affecting orders
    return tx.Commit()
}

// Inventory Service also uses same table
func (s *InventoryService) UpdateStock(ctx context.Context, productID string, qty int) error {
    // Both services write to same table = race conditions, coupling
    _, err := s.db.ExecContext(ctx,
        "UPDATE inventory SET quantity = $1 WHERE product_id = $2",
        qty, productID)
    return err
}

// ✅ Good: Each service owns its data, communicates via APIs/events
// Order Service - only manages orders table
type OrderService struct {
    db               *sql.DB  // Only orders database
    inventoryClient  InventoryClient
    publisher        EventPublisher
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) error {
    // Reserve inventory via service API
    reservation, err := s.inventoryClient.Reserve(ctx, &ReserveRequest{
        OrderID:   req.OrderID,
        ProductID: req.ProductID,
        Quantity:  req.Quantity,
    })
    if err != nil {
        return fmt.Errorf("reserve inventory: %w", err)
    }

    // Create order in own database
    order := &Order{
        ID:            req.OrderID,
        ReservationID: reservation.ID,
        Status:        OrderPending,
    }

    if err := s.saveOrder(ctx, order); err != nil {
        // Compensate - release reservation
        s.inventoryClient.Release(ctx, reservation.ID)
        return err
    }

    s.publisher.Publish(ctx, "order.created", order)
    return nil
}

// Inventory Service - owns inventory database
type InventoryService struct {
    db *sql.DB  // Only inventory database
}

func (s *InventoryService) Reserve(ctx context.Context, req *ReserveRequest) (*Reservation, error) {
    // Full control over inventory data and schema
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Check and reserve atomically
    var available int
    tx.QueryRowContext(ctx,
        "SELECT quantity FROM stock WHERE product_id = $1 FOR UPDATE",
        req.ProductID).Scan(&available)

    if available < req.Quantity {
        return nil, ErrInsufficientStock
    }

    // Create reservation record
    reservation := &Reservation{
        ID:        generateID(),
        OrderID:   req.OrderID,
        ProductID: req.ProductID,
        Quantity:  req.Quantity,
        Status:    ReservationActive,
        ExpiresAt: time.Now().Add(15 * time.Minute),
    }

    // Insert reservation, update stock
    tx.ExecContext(ctx, "INSERT INTO reservations ...")
    tx.ExecContext(ctx, "UPDATE stock SET quantity = quantity - $1 WHERE product_id = $2",
        req.Quantity, req.ProductID)

    tx.Commit()
    return reservation, nil
}
```

### Mistake 5: No Observability Across Service Boundaries

When a request fails after traversing five services, unstructured `log.Printf` calls make root-cause analysis nearly impossible. You cannot correlate the order service's "inventory failed" log with the inventory service's timeout log because nothing links them. Distributed tracing (OpenTelemetry) solves this by propagating a trace ID through every service call, and structured logging attaches that trace ID to every log entry.

```go
// ❌ Bad: No distributed tracing or correlation
func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    log.Printf("Creating order for user %s", req.UserID) // No correlation

    // Call inventory - no trace propagation
    _, err := s.inventoryClient.Reserve(ctx, req.Items)
    if err != nil {
        log.Printf("Inventory failed: %v", err) // Can't correlate with inventory logs
        return nil, err
    }

    // Call payment - no trace propagation
    _, err = s.paymentClient.Process(ctx, req.Payment)
    if err != nil {
        log.Printf("Payment failed: %v", err) // Can't trace across services
        return nil, err
    }

    return order, nil
}

// ✅ Good: Full observability with distributed tracing
func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Start span
    ctx, span := s.tracer.Start(ctx, "OrderService.CreateOrder")
    defer span.End()

    // Add attributes for debugging
    span.SetAttributes(
        attribute.String("user_id", req.UserID),
        attribute.Int("item_count", len(req.Items)),
    )

    // Structured logging with trace context
    s.logger.Info("Creating order",
        "trace_id", span.SpanContext().TraceID().String(),
        "user_id", req.UserID,
        "items", len(req.Items),
    )

    // Call inventory - context carries trace
    _, err := s.inventoryClient.Reserve(ctx, req.Items) // Trace propagates
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "inventory reservation failed")
        s.logger.Error("Inventory reservation failed",
            "trace_id", span.SpanContext().TraceID().String(),
            "error", err,
        )
        return nil, err
    }

    // Metrics
    s.metrics.OrdersCreated.Inc()
    s.metrics.OrderValue.Observe(req.TotalAmount)

    // Call payment - context carries trace
    _, err = s.paymentClient.Process(ctx, req.Payment)
    if err != nil {
        span.RecordError(err)
        s.metrics.PaymentFailures.Inc()
        // ... compensation
        return nil, err
    }

    span.SetStatus(codes.Ok, "order created successfully")
    return order, nil
}

// Middleware to propagate trace context to downstream services
func TracingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract trace from incoming request
        ctx := otel.GetTextMapPropagator().Extract(
            r.Context(),
            propagation.HeaderCarrier(r.Header),
        )

        // Continue trace
        ctx, span := tracer.Start(ctx, r.URL.Path)
        defer span.End()

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Junior → FAANG: Why These Mistakes Are Universal, Not Just Beginner Mistakes

The five mistakes in this file are not beginner mistakes that experienced engineers avoid naturally. They are organizational failure modes that recur even in experienced teams because they require architectural discipline to prevent, not just individual knowledge.

**Distributed monolith is an organizational failure, not a code failure.** A team that syncs calls across five services is doing it because it is faster to write synchronous code than to design and operate an event-driven flow. The fix is not knowledge alone. It requires an architectural standard (synchronous calls only for critical-path dependencies), a design review process that enforces the standard, and tooling that makes event-driven code as easy to write as synchronous code.

**Missing idempotency is a testing failure as much as a design failure.** If every Kafka consumer had an integration test that replayed the same event twice and asserted that the side effect happened exactly once, missing idempotency would be caught before production. Get in the habit of writing this test for every event handler you build. The test is a two-line addition: process the event, process it again with the same event ID, assert that the database or external call was invoked exactly once.

**Circuit breakers are not optional for non-critical dependencies.** Mistake 3 shows a service that fails entirely because an optional recommendation call timed out. In an interview, the correct answer always includes: "For any non-critical dependency, I wrap the call in a circuit breaker and define a graceful degradation behavior." Name the library you would use (`github.com/sony/gobreaker` in Go) and describe what the fallback returns.

**First-job habit from mistake 4.** The fastest way to catch shared database usage is to search your codebase for table names. If the string `inventory` appears in a SQL query inside the order service, you have a shared database problem. Make this search part of your code review checklist.

### Senior @ FAANG: Preventing These Mistakes at the Platform Level

Individual code reviews catch individual instances. Platform-level prevention catches them before they are written. The staff-level response to each of these mistakes is not a code fix. It is a platform capability or process.

**Architectural fitness functions for the distributed monolith.** A fitness function is an automated test that measures whether the architecture satisfies a constraint. For the "no synchronous calls to non-critical dependencies" constraint, a fitness function might: parse the call graph from traces (OpenTelemetry span data), identify all synchronous service-to-service calls, and flag any that are not on the critical path (defined as: the call chain from API gateway to the response). This fitness function runs in CI and fails the build if a new synchronous call is introduced without architectural review. This turns an architectural standard into an enforceable constraint.

**Platform-level idempotency infrastructure.** Rather than requiring every team to implement their own idempotency check, the platform can provide it as a middleware. An idempotency middleware on the Kafka consumer wrapper automatically checks a shared processed-events store (Redis or a database table) before invoking the handler, and marks the event as processed after successful handling. Teams opt in to the middleware rather than implementing the pattern from scratch. This reduces the surface area for missing idempotency.

**Service mesh for circuit breaking.** Mistake 3 requires every service to configure and manage its own circuit breakers. A service mesh (Istio, Linkerd) moves this concern to the infrastructure layer: circuit breaking, retry policies, and timeout budgets are configured in traffic policies, not application code. Teams still need to define their degradation behavior (what to return when the circuit is open), but the circuit management is no longer application code. At FAANG, migrating circuit breaking to the mesh is a platform investment that reduces per-service operational complexity.

**Data ownership governance.** Mistake 4 (shared database) cannot be detected by CI once it is established, because cross-service database access does not appear in import graphs when both services share a database. The prevention mechanism is access control: each service's database user has `GRANT` permissions only on that service's tables. A service that tries to query another service's table gets a permission error, not a silent data access. Implementing this as a database security standard, enforced at provisioning time, prevents the problem at the infrastructure layer. At FAANG, the platform team owns the database provisioning scripts and enforces the per-service permission model by default.

---
