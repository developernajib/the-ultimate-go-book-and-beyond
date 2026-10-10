## 52.15 E-Commerce Platform Pitfalls: Real-World Lessons from Production

### Pitfall 1: The Inventory Overselling Disaster

**Incident Report**: Flash sale for limited edition product. 100 units available. Due to race condition between checking inventory and reserving, 247 orders were placed. 147 customers received cancellation emails after being charged. Social media backlash ensued.

```go
// WRONG: Check-then-act without atomicity
func (s *OrderService) CreateOrder(ctx context.Context, req OrderRequest) (*Order, error) {
    // Check inventory
    available, _ := s.inventoryClient.GetAvailable(ctx, req.ProductID)
    if available < req.Quantity {
        return nil, ErrOutOfStock
    }

    // Race window! Between check and reserve, other orders might succeed

    order := &Order{ID: uuid.New().String(), ...}
    s.db.Create(order)

    // Now try to reserve - might fail!
    err := s.inventoryClient.Reserve(ctx, req.ProductID, req.Quantity)
    if err != nil {
        // Order already created with payment intent - cleanup nightmare
        return nil, err
    }

    return order, nil
}

// CORRECT: Atomic reservation with idempotent operations
func (s *OrderService) CreateOrder(ctx context.Context, req OrderRequest) (*Order, error) {
    orderID := uuid.New().String()

    // Atomic reserve-or-fail in inventory service
    reservation, err := s.inventoryClient.AtomicReserve(ctx, &ReserveRequest{
        OrderID:     orderID,
        ProductID:   req.ProductID,
        Quantity:    req.Quantity,
        IdempotencyKey: fmt.Sprintf("reserve-%s", orderID),
        ExpiresAt:   time.Now().Add(10 * time.Minute),  // Auto-release if order not confirmed
    })
    if err != nil {
        return nil, fmt.Errorf("reserve inventory: %w", err)
    }

    // Inventory reserved - now create order
    order := &Order{
        ID:            orderID,
        ReservationID: reservation.ID,
        Status:        OrderStatusPending,
        ExpiresAt:     reservation.ExpiresAt,
    }

    if err := s.orderRepo.Create(ctx, order); err != nil {
        // Release reservation on failure
        s.inventoryClient.Release(ctx, reservation.ID)
        return nil, fmt.Errorf("create order: %w", err)
    }

    return order, nil
}

// Inventory service: atomic reservation
func (s *InventoryService) AtomicReserve(ctx context.Context, req *ReserveRequest) (*Reservation, error) {
    // Use database transaction with row-level locking
    tx, _ := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    defer tx.Rollback()

    // Check idempotency
    existing, _ := s.getReservationByIdempotencyKey(ctx, tx, req.IdempotencyKey)
    if existing != nil {
        return existing, nil  // Already reserved
    }

    // Lock the inventory row and check
    var available int
    err := tx.QueryRowContext(ctx, `
        SELECT available_quantity FROM inventory
        WHERE product_id = $1 FOR UPDATE
    `, req.ProductID).Scan(&available)
    if err != nil {
        return nil, err
    }

    if available < req.Quantity {
        return nil, ErrInsufficientStock
    }

    // Decrement and create reservation atomically
    _, err = tx.ExecContext(ctx, `
        UPDATE inventory
        SET available_quantity = available_quantity - $1,
            reserved_quantity = reserved_quantity + $1
        WHERE product_id = $2
    `, req.Quantity, req.ProductID)
    if err != nil {
        return nil, err
    }

    reservation := &Reservation{
        ID:             uuid.New().String(),
        OrderID:        req.OrderID,
        ProductID:      req.ProductID,
        Quantity:       req.Quantity,
        IdempotencyKey: req.IdempotencyKey,
        ExpiresAt:      req.ExpiresAt,
    }

    _, err = tx.ExecContext(ctx, `
        INSERT INTO reservations (id, order_id, product_id, quantity, idempotency_key, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, reservation.ID, reservation.OrderID, reservation.ProductID,
       reservation.Quantity, reservation.IdempotencyKey, reservation.ExpiresAt)
    if err != nil {
        return nil, err
    }

    return reservation, tx.Commit()
}
```

### Pitfall 2: The Orphaned Payment After Failed Order

**Incident Report**: Customer's payment succeeded but order creation failed due to database error. Customer was charged $500 but saw "order failed" message. Support ticket created. When they retried, payment was processed again. Customer charged twice.

```go
// WRONG: Payment before order confirmation
func (s *OrderService) ProcessOrder(ctx context.Context, order *Order) error {
    // Charge customer first
    charge, err := s.paymentClient.Charge(ctx, order.CustomerID, order.TotalCents)
    if err != nil {
        return err
    }

    // Save order - might fail!
    order.PaymentID = charge.ID
    if err := s.db.Save(order); err != nil {
        // Payment succeeded but order failed!
        // Manual refund required
        return err
    }

    return nil
}

// CORRECT: Payment authorization with capture after order success
func (s *OrderService) ProcessOrder(ctx context.Context, order *Order) error {
    // Step 1: Authorize payment (hold funds, don't capture)
    auth, err := s.paymentClient.Authorize(ctx, &AuthorizeRequest{
        CustomerID:     order.CustomerID,
        AmountCents:    order.TotalCents,
        IdempotencyKey: fmt.Sprintf("auth-%s", order.ID),
        ExpiresIn:      7 * 24 * time.Hour,  // 7 day hold
    })
    if err != nil {
        return fmt.Errorf("authorize payment: %w", err)
    }

    // Step 2: Save order with auth reference
    order.PaymentAuthID = auth.ID
    order.Status = OrderStatusAuthorized

    if err := s.orderRepo.Save(ctx, order); err != nil {
        // Void the authorization - funds released immediately
        s.paymentClient.Void(ctx, auth.ID)
        return fmt.Errorf("save order: %w", err)
    }

    // Step 3: Capture payment (async, via saga)
    s.sagaOrchestrator.StartOrderFulfillment(ctx, order.ID)

    return nil
}

// Saga step: capture after inventory confirmed
func (s *FulfillmentSaga) CapturePayment(ctx context.Context, orderID string) error {
    order, _ := s.orderRepo.Get(ctx, orderID)

    capture, err := s.paymentClient.Capture(ctx, &CaptureRequest{
        AuthorizationID: order.PaymentAuthID,
        AmountCents:     order.TotalCents,
        IdempotencyKey:  fmt.Sprintf("capture-%s", orderID),
    })
    if err != nil {
        return err
    }

    order.PaymentCaptureID = capture.ID
    order.Status = OrderStatusPaid
    return s.orderRepo.Save(ctx, order)
}

// Compensation: void authorization
func (s *FulfillmentSaga) VoidPayment(ctx context.Context, orderID string) error {
    order, _ := s.orderRepo.Get(ctx, orderID)

    if order.PaymentCaptureID != "" {
        // Already captured - need refund instead
        return s.paymentClient.Refund(ctx, order.PaymentCaptureID, order.TotalCents)
    }

    // Just void the authorization
    return s.paymentClient.Void(ctx, order.PaymentAuthID)
}
```

### Pitfall 3: The Search Index Inconsistency

**Incident Report**: Products were updated in the database but Elasticsearch wasn't synchronized. Customers searched for "blue shirt" and got no results, even though 50 blue shirts were in stock. Product updates went through but search indexing events were lost due to Kafka consumer crash.

```go
// WRONG: Fire-and-forget index updates
func (s *ProductService) UpdateProduct(ctx context.Context, product *Product) error {
    // Update database
    if err := s.db.Save(product); err != nil {
        return err
    }

    // Try to update search - might fail silently
    go func() {
        s.searchClient.Index(context.Background(), product)  // Fire and forget
    }()

    return nil
}

// CORRECT: Transactional outbox with guaranteed delivery
func (s *ProductService) UpdateProduct(ctx context.Context, product *Product) error {
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Update product
    if err := s.productRepo.SaveTx(ctx, tx, product); err != nil {
        return err
    }

    // Write to outbox in same transaction
    event := &ProductUpdatedEvent{
        ProductID:   product.ID,
        Name:        product.Name,
        Description: product.Description,
        PriceCents:  product.PriceCents,
        InStock:     product.Inventory > 0,
        UpdatedAt:   time.Now(),
    }

    if err := s.outboxRepo.WriteTx(ctx, tx, "product.updated", event); err != nil {
        return err
    }

    return tx.Commit()
}

// Outbox processor ensures delivery
func (p *OutboxProcessor) Process(ctx context.Context) {
    events, _ := p.outboxRepo.GetPending(ctx, 100)

    for _, event := range events {
        err := p.kafka.Publish(ctx, event.Topic, event.Payload)
        if err != nil {
            log.Printf("Failed to publish event %s: %v", event.ID, err)
            continue  // Will retry on next iteration
        }

        p.outboxRepo.MarkPublished(ctx, event.ID)
    }
}

// Search consumer with idempotent indexing
func (c *SearchConsumer) HandleProductUpdated(ctx context.Context, event ProductUpdatedEvent) error {
    // Idempotent - safe to reprocess
    return c.search.Index(ctx, &SearchDocument{
        ID:          event.ProductID,
        Name:        event.Name,
        Description: event.Description,
        PriceCents:  event.PriceCents,
        InStock:     event.InStock,
        UpdatedAt:   event.UpdatedAt,
    })
}

// Periodic reconciliation for safety
func (r *Reconciler) ReconcileSearchIndex(ctx context.Context) error {
    // Find products updated but not indexed
    products, _ := r.productRepo.GetUpdatedSince(ctx, time.Now().Add(-1*time.Hour))

    for _, product := range products {
        indexed, _ := r.search.GetByID(ctx, product.ID)
        if indexed == nil || indexed.UpdatedAt.Before(product.UpdatedAt) {
            r.search.Index(ctx, productToDocument(product))
        }
    }

    return nil
}
```

### Pitfall 4: The Cart Abandonment Data Loss

**Incident Report**: Shopping carts stored in Redis with 24h TTL. Redis cluster had a failover. All cart data was lost. Customers who had spent time adding items came back to empty carts. Conversion rate dropped 40% that day.

```go
// WRONG: Cart only in Redis
func (s *CartService) AddItem(ctx context.Context, userID, productID string, quantity int) error {
    key := fmt.Sprintf("cart:%s", userID)

    cart, _ := s.redis.HGetAll(ctx, key).Result()
    cart[productID] = strconv.Itoa(quantity)

    s.redis.HMSet(ctx, key, cart)
    s.redis.Expire(ctx, key, 24*time.Hour)

    return nil
}

// CORRECT: Cart in database with Redis cache
type Cart struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    Items     []CartItem `json:"items"`
    UpdatedAt time.Time `json:"updated_at"`
}

func (s *CartService) AddItem(ctx context.Context, userID, productID string, quantity int) error {
    // Load from cache or database
    cart, err := s.getCart(ctx, userID)
    if err != nil {
        return err
    }

    // Update cart
    cart.AddOrUpdateItem(productID, quantity)
    cart.UpdatedAt = time.Now()

    // Save to database (source of truth)
    if err := s.cartRepo.Save(ctx, cart); err != nil {
        return fmt.Errorf("save cart: %w", err)
    }

    // Update cache (best effort)
    cacheKey := fmt.Sprintf("cart:%s", userID)
    cartJSON, _ := json.Marshal(cart)
    s.redis.Set(ctx, cacheKey, cartJSON, 1*time.Hour)

    return nil
}

func (s *CartService) getCart(ctx context.Context, userID string) (*Cart, error) {
    cacheKey := fmt.Sprintf("cart:%s", userID)

    // Try cache first
    cached, err := s.redis.Get(ctx, cacheKey).Bytes()
    if err == nil {
        var cart Cart
        json.Unmarshal(cached, &cart)
        return &cart, nil
    }

    // Cache miss - load from database
    cart, err := s.cartRepo.GetByUserID(ctx, userID)
    if err == ErrNotFound {
        // Create new cart
        cart = &Cart{
            ID:     uuid.New().String(),
            UserID: userID,
            Items:  []CartItem{},
        }
    } else if err != nil {
        return nil, err
    }

    // Populate cache
    cartJSON, _ := json.Marshal(cart)
    s.redis.Set(ctx, cacheKey, cartJSON, 1*time.Hour)

    return cart, nil
}

// Periodic backup of active carts
func (s *CartService) BackupActiveCarts(ctx context.Context) {
    // Find carts modified in last hour
    carts, _ := s.cartRepo.GetModifiedSince(ctx, time.Now().Add(-1*time.Hour))

    for _, cart := range carts {
        // Archive to S3 for disaster recovery
        s.archiver.Archive(ctx, cart)
    }
}
```

### Pitfall 5: The Order Notification Storm

**Incident Report**: During Black Friday, order volume was 50x normal. Each order triggered 5 notifications (email, SMS, push, webhook, internal). Notification service queued 250,000 messages. Email provider throttled at 10,000/hour. SMS provider charged per message. Notifications were delayed by 8 hours.

```go
// WRONG: Unbounded notification sending
func (s *OrderService) OnOrderCreated(ctx context.Context, order *Order) {
    // Fire all notifications immediately
    go s.emailService.SendOrderConfirmation(order)
    go s.smsService.SendOrderSMS(order)
    go s.pushService.SendOrderPush(order)
    go s.webhookService.NotifyMerchant(order)
    go s.slackService.NotifyInternal(order)
}

// CORRECT: Prioritized, rate-limited notification queue
type NotificationService struct {
    highPriorityQueue chan Notification  // Email confirmations
    normalQueue       chan Notification  // SMS, push
    lowPriorityQueue  chan Notification  // Webhooks, internal
    rateLimiters      map[string]*rate.Limiter
}

func (s *NotificationService) Enqueue(ctx context.Context, notification Notification) error {
    switch notification.Priority {
    case PriorityHigh:
        select {
        case s.highPriorityQueue <- notification:
            return nil
        default:
            // Queue full - persist to database
            return s.persistNotification(ctx, notification)
        }
    case PriorityNormal:
        select {
        case s.normalQueue <- notification:
            return nil
        default:
            return s.persistNotification(ctx, notification)
        }
    default:
        select {
        case s.lowPriorityQueue <- notification:
            return nil
        default:
            return s.persistNotification(ctx, notification)
        }
    }
}

func (s *NotificationService) Worker(ctx context.Context, priority Priority) {
    var queue <-chan Notification
    switch priority {
    case PriorityHigh:
        queue = s.highPriorityQueue
    case PriorityNormal:
        queue = s.normalQueue
    default:
        queue = s.lowPriorityQueue
    }

    for {
        select {
        case <-ctx.Done():
            return
        case notification := <-queue:
            s.processWithRateLimit(ctx, notification)
        }
    }
}

func (s *NotificationService) processWithRateLimit(ctx context.Context, n Notification) {
    limiter := s.rateLimiters[n.Channel]

    // Wait for rate limit
    if err := limiter.Wait(ctx); err != nil {
        s.persistNotification(ctx, n)  // Retry later
        return
    }

    var err error
    switch n.Channel {
    case ChannelEmail:
        err = s.emailClient.Send(ctx, n.To, n.Subject, n.Body)
    case ChannelSMS:
        err = s.smsClient.Send(ctx, n.To, n.Body)
    case ChannelPush:
        err = s.pushClient.Send(ctx, n.To, n.Title, n.Body)
    }

    if err != nil {
        n.Attempts++
        if n.Attempts < 3 {
            // Retry with backoff
            time.AfterFunc(time.Duration(n.Attempts)*time.Minute, func() {
                s.Enqueue(context.Background(), n)
            })
        } else {
            s.markFailed(ctx, n, err)
        }
    }
}

// Order service queues with priorities
func (s *OrderService) OnOrderCreated(ctx context.Context, order *Order) {
    // High priority: customer-facing
    s.notificationService.Enqueue(ctx, Notification{
        Priority: PriorityHigh,
        Channel:  ChannelEmail,
        To:       order.CustomerEmail,
        Subject:  "Order Confirmation",
        OrderID:  order.ID,
    })

    // Normal priority: additional channels
    s.notificationService.Enqueue(ctx, Notification{
        Priority: PriorityNormal,
        Channel:  ChannelSMS,
        To:       order.CustomerPhone,
        OrderID:  order.ID,
    })

    // Low priority: internal/webhooks
    s.notificationService.Enqueue(ctx, Notification{
        Priority: PriorityLow,
        Channel:  ChannelWebhook,
        To:       order.MerchantWebhookURL,
        OrderID:  order.ID,
    })
}
```

### Quick Reference: E-Commerce Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Inventory overselling | More orders than stock | Atomic reservation with row locking |
| Orphaned payments | Charged but no order | Auth/capture pattern with saga |
| Search inconsistency | Products not findable | Transactional outbox, reconciliation |
| Cart data loss | Empty carts after failures | Database as source of truth, Redis as cache |
| Notification storm | Delayed/missing notifications | Prioritized queues, rate limiting |

### Junior → FAANG: Learning From Incidents Without Experiencing Them

These five pitfalls are described as incident reports because that is how the industry learns from them. Reading them as design constraints, not as cautionary tales, is the mindset shift that separates engineers who prevent incidents from engineers who fix them.

**The overselling incident teaches you to find your race windows.** Identify every place in your code where you check a condition and then act on it in a separate step. Each gap between check and act is a potential race condition. The fix is not locking everything. It is identifying which checks must be atomic with their corresponding actions (inventory reservation) and which can tolerate staleness (product listing count).

**The orphaned payment incident teaches you about state machine design.** An order that has been charged but not confirmed is in an undefined state. A well-designed state machine has no undefined states. Draw your state machine before you write any code. Every valid transition is an explicit arc. Every state has defined invariants (an order in `paid` state always has a `payment_id`). This drawing becomes your test oracle: assert the invariants in tests, not just the transitions.

**The search inconsistency incident teaches you about the outbox pattern.** Fire-and-forget indexing is not "eventual consistency." It is "maybe consistency." True eventual consistency requires a durable delivery mechanism, which the outbox pattern provides. Any time you want a side effect (search index update, audit log write, cache invalidation) to be guaranteed after a state change, the outbox pattern is the correct tool.

**First-job habit from the cart data loss incident.** Before any Redis key is created in a system you design, write down the answer to: "What happens to the user experience if this key is lost?" If the answer is "they lose work they cannot recover," Redis must not be the only copy.

**The notification storm incident teaches you about load shedding.** Every service that depends on a third-party provider (email, SMS, push) must have a mechanism to defer or drop lower-priority messages under load. Designing the priority queue and rate limiting before Black Friday is a product responsibility, not just an engineering one. If product management has not defined which notifications are customer-facing and time-sensitive versus internal and deferrable, that is the conversation to initiate before the first peak event.

### Senior @ FAANG: Incident Patterns, Post-Mortem Culture, and Systemic Prevention

Each of these pitfalls is a failure mode with a systemic cause. The staff-level response goes beyond the technical fix to the organizational and process changes that prevent the next incident in the same class.

**The five whys for the overselling incident.** Why did orders exceed stock? Because the check and reserve were not atomic. Why were they not atomic? Because the developer did not know `SELECT ... FOR UPDATE`. Why did not code review catch it? Because the reviewer did not ask "is this atomic?" Why did not testing catch it? Because the load test did not simulate concurrent reservations. Why did not the architecture catch it? Because there was no architectural review checklist that included concurrency safety for inventory operations. The systemic fix is adding "concurrent reservation safety" to the inventory service's design review template, not just fixing this instance.

**Post-mortem culture and blameless review.** Each incident report in this file names a symptom ("247 orders for 100 units") without naming an individual. This is the blameless post-mortem model: incidents are system failures, not individual failures. The questions are: what allowed the system to get into this state, what detection would have caught it earlier, what mitigation exists for the next occurrence, and what prevention eliminates the class of failures? At FAANG, post-mortems are written within 48 hours of resolution, reviewed by the team, and their action items tracked to completion. The action items from the five incidents in this file would include: concurrency tests in the inventory service test suite, idempotency middleware for payment handlers, transactional outbox adoption for search indexing, a Redis durability policy, and a notification priority queue standard.

**Runbook as a platform artifact.** The "correct" code for each pitfall shows the mitigation at the code level. At FAANG, the operational runbook is equally important: how do you detect that the overselling incident is occurring (a Prometheus alert on `orders_per_product > inventory_available`), how do you mitigate in real time (pause new order creation for the affected product), and how do you recover (identify affected orders, initiate refund or re-procurement). The runbook is a platform artifact owned by the on-call rotation, reviewed quarterly, and tested in game days. A staff engineer owning this platform writes the runbooks alongside the code, not six months later during the first incident.

---
