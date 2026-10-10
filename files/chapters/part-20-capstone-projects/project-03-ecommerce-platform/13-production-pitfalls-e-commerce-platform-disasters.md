## Production Pitfalls: E-commerce Platform Disasters

### Pitfall 1: The Overselling Catastrophe

**Real Incident Report**: During a flash sale, a popular item showed 100 units available. Due to a race condition, 347 orders were placed for those 100 units. The company had to cancel 247 orders and deal with furious customers, negative press, and regulatory scrutiny.

**The Anti-Pattern**:
```go
// DANGEROUS: Check-then-update race condition
func (s *InventoryService) Reserve(ctx context.Context, productID string, qty int) error {
    product, err := s.db.GetProduct(ctx, productID)
    if err != nil {
        return err
    }

    // Race condition window: multiple requests can pass this check
    if product.Stock < qty {
        return ErrInsufficientStock
    }

    // By the time this runs, stock might already be reserved by others
    return s.db.UpdateStock(ctx, productID, product.Stock-qty)
}
```

**The Better Approach**:
```go
func (s *InventoryService) Reserve(ctx context.Context, productID string, qty int) (string, error) {
    reservationID := uuid.New().String()

    // Atomic decrement with conditional check
    result, err := s.redis.Eval(ctx, `
        local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
        local requested = tonumber(ARGV[1])
        local reservationID = ARGV[2]
        local ttl = tonumber(ARGV[3])

        if stock < requested then
            return {-1, stock}
        end

        redis.call('DECRBY', KEYS[1], requested)
        redis.call('HSET', KEYS[2], reservationID, requested)
        redis.call('EXPIRE', KEYS[2], ttl)

        return {1, stock - requested}
    `, []string{
        fmt.Sprintf("inventory:%s", productID),
        fmt.Sprintf("reservations:%s", productID),
    }, qty, reservationID, 900).Result() // 15 min TTL

    if err != nil {
        return "", err
    }

    status := result.([]any)[0].(int64)
    if status == -1 {
        return "", ErrInsufficientStock
    }

    // Start async timer to release reservation if not confirmed
    go s.scheduleReservationExpiry(reservationID, productID, qty, 15*time.Minute)

    return reservationID, nil
}

func (s *InventoryService) ConfirmReservation(ctx context.Context, reservationID, productID string) error {
    // Remove from pending reservations (item is sold)
    result, err := s.redis.HDel(ctx,
        fmt.Sprintf("reservations:%s", productID),
        reservationID,
    ).Result()

    if err != nil {
        return err
    }

    if result == 0 {
        return ErrReservationNotFound // Already expired or confirmed
    }

    return nil
}

func (s *InventoryService) ReleaseReservation(ctx context.Context, reservationID, productID string) error {
    // Get quantity from reservation
    qty, err := s.redis.HGet(ctx,
        fmt.Sprintf("reservations:%s", productID),
        reservationID,
    ).Int()

    if err == redis.Nil {
        return nil // Already released
    }
    if err != nil {
        return err
    }

    // Atomic: remove reservation and restore stock
    _, err = s.redis.Eval(ctx, `
        local removed = redis.call('HDEL', KEYS[1], ARGV[1])
        if removed > 0 then
            redis.call('INCRBY', KEYS[2], ARGV[2])
        end
        return removed
    `, []string{
        fmt.Sprintf("reservations:%s", productID),
        fmt.Sprintf("inventory:%s", productID),
    }, reservationID, qty).Result()

    return err
}
```

**Key Insight**: Use atomic operations (Redis Lua scripts or database row-level locks) for inventory management. Implement time-bounded reservations that auto-release if not confirmed.

---

### Pitfall 2: The Double Charge Disaster

**Real Incident Report**: Network issues caused payment confirmations to fail intermittently. The system retried payments without proper idempotency, resulting in hundreds of customers being charged multiple times. Total overcharges: \$450,000.

**The Anti-Pattern**:
```go
// DANGEROUS: No idempotency
func (s *PaymentService) Charge(ctx context.Context, orderID string, amount int64) error {
    // If this succeeds but response is lost, retry will charge again!
    return s.stripe.Charges.Create(ctx, &stripe.ChargeParams{
        Amount:   stripe.Int64(amount),
        Currency: stripe.String("usd"),
    })
}
```

**The Better Approach**:
```go
type IdempotentPaymentService struct {
    stripe          *stripe.Client
    idempotencyStore *redis.Client
    db              *sql.DB
}

func (s *IdempotentPaymentService) Charge(ctx context.Context, req *ChargeRequest) (*ChargeResult, error) {
    // Generate deterministic idempotency key
    idempotencyKey := fmt.Sprintf("charge:%s:%d", req.OrderID, req.Amount)

    // Check if already processed
    existing, err := s.getExistingCharge(ctx, idempotencyKey)
    if err == nil {
        return existing, nil // Return cached result
    }

    // Acquire lock for this idempotency key
    lock, err := s.acquireLock(ctx, idempotencyKey, 30*time.Second)
    if err != nil {
        return nil, ErrChargeInProgress
    }
    defer lock.Release()

    // Double-check after acquiring lock
    existing, err = s.getExistingCharge(ctx, idempotencyKey)
    if err == nil {
        return existing, nil
    }

    // Process payment with Stripe's idempotency
    charge, err := s.stripe.Charges.Create(ctx, &stripe.ChargeParams{
        Amount:   stripe.Int64(req.Amount),
        Currency: stripe.String("usd"),
        Params: stripe.Params{
            IdempotencyKey: stripe.String(idempotencyKey),
        },
        Metadata: map[string]string{
            "order_id": req.OrderID,
        },
    })

    result := &ChargeResult{
        IdempotencyKey: idempotencyKey,
        OrderID:        req.OrderID,
        Amount:         req.Amount,
        Timestamp:      time.Now(),
    }

    if err != nil {
        result.Status = "failed"
        result.Error = err.Error()
    } else {
        result.Status = "success"
        result.ChargeID = charge.ID
    }

    // Store result for future lookups (even failures)
    s.storeResult(ctx, idempotencyKey, result)

    if err != nil {
        return result, err
    }
    return result, nil
}

func (s *IdempotentPaymentService) storeResult(ctx context.Context, key string, result *ChargeResult) {
    data, _ := json.Marshal(result)

    // Store in Redis with 7-day TTL
    s.idempotencyStore.Set(ctx, key, data, 7*24*time.Hour)

    // Also store in database for audit
    s.db.ExecContext(ctx, `
        INSERT INTO payment_idempotency (idempotency_key, result, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (idempotency_key) DO NOTHING
    `, key, data, time.Now())
}
```

**Key Insight**: Always use idempotency keys for payment operations. Store results (including failures) to enable safe retries. Use both provider-side and application-side idempotency.

---

### Pitfall 3: The Saga Compensation Failure

**Real Incident Report**: An order saga failed mid-way through. The compensation logic had a bug that didn't release the inventory reservation. Over time, "ghost reservations" accumulated, showing items as sold out when they were actually available.

**The Anti-Pattern**:
```go
// DANGEROUS: Incomplete compensation
func (s *OrderSaga) Execute(ctx context.Context, order *Order) error {
    // Step 1: Reserve inventory
    if err := s.inventory.Reserve(ctx, order.Items); err != nil {
        return err
    }

    // Step 2: Charge payment
    if err := s.payment.Charge(ctx, order); err != nil {
        // BUG: If this fails, inventory stays reserved!
        return err
    }

    // Step 3: Create shipment
    if err := s.shipping.CreateShipment(ctx, order); err != nil {
        // BUG: Payment charged but shipment failed!
        return err
    }

    return nil
}
```

**The Better Approach**:
```go
type SagaStep struct {
    Name        string
    Execute     func(ctx context.Context, state *SagaState) error
    Compensate  func(ctx context.Context, state *SagaState) error
}

type SagaState struct {
    OrderID          string
    CompletedSteps   []string
    StepResults      map[string]any
    CompensationData map[string]any
}

type OrderSaga struct {
    steps     []SagaStep
    stateRepo SagaStateRepository
}

func NewOrderSaga(inventory, payment, shipping Service) *OrderSaga {
    return &OrderSaga{
        steps: []SagaStep{
            {
                Name: "reserve_inventory",
                Execute: func(ctx context.Context, state *SagaState) error {
                    reservationID, err := inventory.Reserve(ctx, state.OrderID)
                    if err != nil {
                        return err
                    }
                    state.CompensationData["reservation_id"] = reservationID
                    return nil
                },
                Compensate: func(ctx context.Context, state *SagaState) error {
                    reservationID := state.CompensationData["reservation_id"].(string)
                    return inventory.ReleaseReservation(ctx, reservationID)
                },
            },
            {
                Name: "charge_payment",
                Execute: func(ctx context.Context, state *SagaState) error {
                    chargeID, err := payment.Charge(ctx, state.OrderID)
                    if err != nil {
                        return err
                    }
                    state.CompensationData["charge_id"] = chargeID
                    return nil
                },
                Compensate: func(ctx context.Context, state *SagaState) error {
                    chargeID := state.CompensationData["charge_id"].(string)
                    return payment.Refund(ctx, chargeID)
                },
            },
            {
                Name: "create_shipment",
                Execute: func(ctx context.Context, state *SagaState) error {
                    shipmentID, err := shipping.CreateShipment(ctx, state.OrderID)
                    if err != nil {
                        return err
                    }
                    state.CompensationData["shipment_id"] = shipmentID
                    return nil
                },
                Compensate: func(ctx context.Context, state *SagaState) error {
                    shipmentID := state.CompensationData["shipment_id"].(string)
                    return shipping.CancelShipment(ctx, shipmentID)
                },
            },
        },
    }
}

func (s *OrderSaga) Execute(ctx context.Context, orderID string) error {
    state := &SagaState{
        OrderID:          orderID,
        StepResults:      make(map[string]any),
        CompensationData: make(map[string]any),
    }

    // Persist initial state
    s.stateRepo.Save(ctx, state)

    for i, step := range s.steps {
        if err := step.Execute(ctx, state); err != nil {
            // Log the failure
            log.Error("Saga step failed", "step", step.Name, "error", err)

            // Compensate all completed steps in reverse order
            for j := i - 1; j >= 0; j-- {
                compensateStep := s.steps[j]
                if err := s.compensateWithRetry(ctx, compensateStep, state); err != nil {
                    // Critical: compensation failed, need manual intervention
                    s.alertOps(ctx, state, compensateStep.Name, err)
                }
            }

            return fmt.Errorf("saga failed at step %s: %w", step.Name, err)
        }

        state.CompletedSteps = append(state.CompletedSteps, step.Name)
        s.stateRepo.Save(ctx, state) // Persist after each step
    }

    return nil
}

func (s *OrderSaga) compensateWithRetry(ctx context.Context, step SagaStep, state *SagaState) error {
    var lastErr error

    for attempt := 0; attempt < 3; attempt++ {
        if err := step.Compensate(ctx, state); err != nil {
            lastErr = err
            time.Sleep(time.Duration(attempt+1) * time.Second)
            continue
        }
        return nil
    }

    // Queue for background retry
    s.queueCompensationRetry(state, step.Name)

    return lastErr
}
```

**Key Insight**: Each saga step must have a corresponding compensation action. Store state to enable recovery. Retry compensations and alert operations on persistent failures.

---

### Pitfall 4: The Cart Abandonment Data Loss

**Real Incident Report**: Cart data was stored only in Redis with a 24-hour TTL. During a Redis failover, all cart data was lost. Thousands of customers lost their carefully curated shopping carts, resulting in a 30% drop in conversion rate.

**The Anti-Pattern**:
```go
// DANGEROUS: Cart only in volatile storage
func (s *CartService) AddItem(ctx context.Context, userID, productID string, qty int) error {
    key := fmt.Sprintf("cart:%s", userID)
    // If Redis dies, cart is gone!
    return s.redis.HSet(ctx, key, productID, qty).Err()
}
```

**The Better Approach**:
```go
type DurableCartService struct {
    redis    *redis.Client
    db       *sql.DB
    syncChan chan CartSync
}

func (s *DurableCartService) AddItem(ctx context.Context, userID, productID string, qty int) error {
    // Write to Redis for speed
    key := fmt.Sprintf("cart:%s", userID)
    pipe := s.redis.Pipeline()
    pipe.HSet(ctx, key, productID, qty)
    pipe.Expire(ctx, key, 7*24*time.Hour)
    _, err := pipe.Exec(ctx)

    if err != nil {
        // Redis failed, write directly to DB
        return s.writeToDBDirect(ctx, userID, productID, qty)
    }

    // Queue async sync to database
    s.syncChan <- CartSync{
        UserID:    userID,
        ProductID: productID,
        Quantity:  qty,
        Timestamp: time.Now(),
    }

    return nil
}

func (s *DurableCartService) syncWorker() {
    batch := make([]CartSync, 0, 100)
    ticker := time.NewTicker(time.Second)

    for {
        select {
        case sync := <-s.syncChan:
            batch = append(batch, sync)
            if len(batch) >= 100 {
                s.batchSyncToDb(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                s.batchSyncToDb(batch)
                batch = batch[:0]
            }
        }
    }
}

func (s *DurableCartService) GetCart(ctx context.Context, userID string) (*Cart, error) {
    key := fmt.Sprintf("cart:%s", userID)

    // Try Redis first
    items, err := s.redis.HGetAll(ctx, key).Result()
    if err == nil && len(items) > 0 {
        return s.parseCart(items), nil
    }

    // Fallback to database
    cart, err := s.loadFromDB(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Warm cache
    if cart != nil {
        s.warmCache(ctx, userID, cart)
    }

    return cart, nil
}

// Recovery: Restore carts from DB to Redis after failover
func (s *DurableCartService) RecoverCarts(ctx context.Context, since time.Time) error {
    rows, err := s.db.QueryContext(ctx, `
        SELECT user_id, product_id, quantity
        FROM cart_items
        WHERE updated_at > $1
    `, since)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var userID, productID string
        var qty int
        rows.Scan(&userID, &productID, &qty)

        key := fmt.Sprintf("cart:%s", userID)
        s.redis.HSet(ctx, key, productID, qty)
        s.redis.Expire(ctx, key, 7*24*time.Hour)
    }

    return nil
}
```

**Key Insight**: Use Redis for performance, but async-sync to a durable database. Implement recovery procedures to rebuild cache from persistent storage.

---

### Pitfall 5: The Price Inconsistency Bug

**Real Incident Report**: Prices were cached at checkout time but not locked. Users added items when a sale was active, then checked out hours later after the sale ended. The system charged the old (lower) cached price instead of the current price. Loss: \$125,000 in one week.

**The Anti-Pattern**:
```go
// DANGEROUS: Price cached in cart, not verified at checkout
func (s *CartService) AddItem(ctx context.Context, userID, productID string) error {
    product, _ := s.products.Get(ctx, productID)

    item := CartItem{
        ProductID: productID,
        Price:     product.Price, // Cached price - might change!
    }

    return s.redis.HSet(ctx, "cart:"+userID, productID, item).Err()
}

func (s *CheckoutService) Checkout(ctx context.Context, userID string) (*Order, error) {
    cart, _ := s.cartService.GetCart(ctx, userID)

    // Uses cached prices from cart!
    total := cart.CalculateTotal()

    return s.createOrder(ctx, userID, cart, total)
}
```

**The Better Approach**:
```go
type CheckoutService struct {
    products   ProductService
    pricing    PricingService
    inventory  InventoryService
}

func (s *CheckoutService) Checkout(ctx context.Context, userID string, cart *Cart) (*Order, error) {
    // Lock cart to prevent modifications during checkout
    lockKey := fmt.Sprintf("checkout_lock:%s", userID)
    lock, err := s.acquireLock(ctx, lockKey, 5*time.Minute)
    if err != nil {
        return nil, ErrCheckoutInProgress
    }
    defer lock.Release()

    // Verify and lock prices at checkout time
    verifiedItems := make([]VerifiedItem, 0, len(cart.Items))

    for _, item := range cart.Items {
        // Get current price
        product, err := s.products.Get(ctx, item.ProductID)
        if err != nil {
            return nil, fmt.Errorf("product %s not found", item.ProductID)
        }

        // Check if price changed significantly
        if item.CachedPrice != product.Price {
            priceDiff := math.Abs(float64(item.CachedPrice-product.Price)) / float64(item.CachedPrice)
            if priceDiff > 0.01 { // More than 1% change
                return nil, &PriceChangedError{
                    ProductID: item.ProductID,
                    OldPrice:  item.CachedPrice,
                    NewPrice:  product.Price,
                }
            }
        }

        // Apply any active promotions
        finalPrice, promo := s.pricing.CalculatePrice(ctx, product, userID)

        verifiedItems = append(verifiedItems, VerifiedItem{
            ProductID:     item.ProductID,
            Quantity:      item.Quantity,
            UnitPrice:     finalPrice,
            OriginalPrice: product.Price,
            Promotion:     promo,
            VerifiedAt:    time.Now(),
        })
    }

    // Verify inventory availability
    for _, item := range verifiedItems {
        available, err := s.inventory.CheckAvailability(ctx, item.ProductID, item.Quantity)
        if err != nil || !available {
            return nil, &OutOfStockError{ProductID: item.ProductID}
        }
    }

    // Create order with verified prices
    order := &Order{
        ID:           uuid.New().String(),
        UserID:       userID,
        Items:        verifiedItems,
        Total:        calculateTotal(verifiedItems),
        PricesLocked: true,
        LockedAt:     time.Now(),
        ExpiresAt:    time.Now().Add(15 * time.Minute), // Price lock expires
    }

    return order, nil
}
```

**Key Insight**: Always verify prices at checkout against current database values. Notify users of price changes. Lock prices only for a short duration during checkout.

---

### Quick Reference: E-commerce Pitfalls

| Pitfall | Impact | Prevention |
|---------|--------|------------|
| Overselling | Canceled orders, angry customers | Atomic inventory operations, reservations |
| Double charging | Refund costs, trust damage | Idempotency keys, payment deduplication |
| Saga compensation failures | Ghost reservations, inconsistent state | Persistent saga state, retry compensation |
| Cart data loss | Lost sales, poor UX | Async-sync to durable storage |
| Price inconsistency | Revenue loss | Verify prices at checkout, lock briefly |

---

### Junior → FAANG: Pitfalls as Interview Scenario Preparation

The overselling catastrophe is the most commonly asked e-commerce failure scenario in FAANG interviews. Know the three prevention mechanisms: database-level atomic decrement with `WHERE stock > 0`, optimistic locking with version numbers, and pre-reservation with TTL. Know when each is appropriate and what its limitations are.

Price inconsistency (cart showing one price, checkout charging another) is both a customer experience problem and a legal problem in many jurisdictions. The fix (re-validating prices at checkout against the authoritative price database, not the cached cart price) is simple to describe but requires disciplined implementation to ensure the check always runs.

Double payment (charging a customer twice for one order) is the failure mode with the most severe consequences: immediate customer damage, dispute fees from the payment processor, and potential regulatory action. The fix (idempotency keys in payment API calls) is the most important payment integration detail to know for interviews.

### Senior @ FAANG: Pitfall Analysis as Risk Identification

At senior level, the pitfall table is a risk register for the e-commerce system. Before each production launch, a senior engineer walks through the known failure modes, confirms that each mitigation is in place, and identifies any gaps.

Distributed Saga failure (some services complete, others fail, leaving the system in an intermediate state) is the hardest pitfall to detect and remediate. The mitigation (Saga orchestrator with explicit state tracking and compensating actions) requires its own monitoring: alert when a Saga is stuck in a non-terminal state for longer than the expected maximum duration. The runbook for a stuck Saga must include how to diagnose which step failed, how to retry that step, and how to manually trigger compensating actions if retry is not possible.

Flash sale inventory exhaustion (legitimate users unable to purchase because bots reserved all inventory with abandoned carts) is a product and engineering problem. The mitigation is a combination of bot detection (challenge on cart add), reduced soft reservation TTL (5 minutes instead of 30), and per-user purchase limits. Each mitigation has a false-positive rate (legitimate users occasionally triggered by bot detection). The product team must accept the false-positive rate before engineering implements the mitigation. That conversation is a senior engineer's responsibility to facilitate.

---
