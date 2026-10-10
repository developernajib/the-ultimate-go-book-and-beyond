## Company Case Studies: E-Commerce at Scale

Real-world e-commerce platforms face challenges that go far beyond what you encounter in tutorials. The following case studies examine how major companies like Shopify, Amazon, and Stripe have solved problems with multi-tenancy, inventory management, and payment processing at massive scale using Go. Each example includes simplified Go code that illustrates the core pattern, so you can understand the approach and adapt it to your own projects.

### Shopify: Multi-Tenant E-Commerce Platform

Shopify powers millions of stores with Go services:

```go
// Shopify-style multi-tenant e-commerce platform
package shopify

import (
    "context"
    "sync"
    "time"

    "github.com/shopspring/decimal"
)

// StoreService manages multi-tenant store operations
type StoreService struct {
    tenantRouter  *TenantRouter
    inventorySync *InventorySyncService
    checkoutQueue *CheckoutQueue
}

// Store represents a Shopify store tenant
type Store struct {
    ID             string          `json:"id"`
    Domain         string          `json:"domain"`
    CustomDomain   string          `json:"custom_domain,omitempty"`
    Plan           string          `json:"plan"`
    Currency       string          `json:"currency"`
    Timezone       string          `json:"timezone"`
    Settings       *StoreSettings  `json:"settings"`
    Theme          *Theme          `json:"theme"`
    ShippingZones  []ShippingZone  `json:"shipping_zones"`
    PaymentGateways []PaymentGateway `json:"payment_gateways"`
}

// Product with variant inventory tracking
type Product struct {
    ID              string            `json:"id"`
    StoreID         string            `json:"store_id"`
    Title           string            `json:"title"`
    Handle          string            `json:"handle"`
    Description     string            `json:"description"`
    Vendor          string            `json:"vendor"`
    ProductType     string            `json:"product_type"`
    Tags            []string          `json:"tags"`
    Variants        []ProductVariant  `json:"variants"`
    Images          []ProductImage    `json:"images"`
    SEO             *SEOData          `json:"seo"`
    Status          string            `json:"status"`
    PublishedAt     *time.Time        `json:"published_at"`
}

// ProductVariant for SKU-level inventory
type ProductVariant struct {
    ID                  string          `json:"id"`
    ProductID           string          `json:"product_id"`
    Title               string          `json:"title"`
    SKU                 string          `json:"sku"`
    Barcode             string          `json:"barcode"`
    Price               decimal.Decimal `json:"price"`
    CompareAtPrice      decimal.Decimal `json:"compare_at_price"`
    CostPerItem         decimal.Decimal `json:"cost_per_item"`
    InventoryQuantity   int             `json:"inventory_quantity"`
    InventoryPolicy     string          `json:"inventory_policy"` // deny, continue
    FulfillmentService  string          `json:"fulfillment_service"`
    Weight              float64         `json:"weight"`
    WeightUnit          string          `json:"weight_unit"`
    Options             []OptionValue   `json:"options"`
    RequiresShipping    bool            `json:"requires_shipping"`
    Taxable             bool            `json:"taxable"`
}

// CheckoutSession handles distributed checkout
type CheckoutSession struct {
    ID              string              `json:"id"`
    StoreID         string              `json:"store_id"`
    CartToken       string              `json:"cart_token"`
    LineItems       []CheckoutLineItem  `json:"line_items"`
    ShippingAddress *Address            `json:"shipping_address"`
    BillingAddress  *Address            `json:"billing_address"`
    ShippingRate    *ShippingRate       `json:"shipping_rate"`
    Discounts       []Discount          `json:"discounts"`
    Subtotal        decimal.Decimal     `json:"subtotal"`
    ShippingCost    decimal.Decimal     `json:"shipping_cost"`
    TaxTotal        decimal.Decimal     `json:"tax_total"`
    Total           decimal.Decimal     `json:"total"`
    Currency        string              `json:"currency"`
    PaymentStatus   string              `json:"payment_status"`
    CreatedAt       time.Time           `json:"created_at"`
    ExpiresAt       time.Time           `json:"expires_at"`
    mu              sync.Mutex
}

// CreateCheckout initializes checkout with inventory reservation
func (s *StoreService) CreateCheckout(ctx context.Context, storeID string, cart *Cart) (*CheckoutSession, error) {
    store, err := s.tenantRouter.GetStore(ctx, storeID)
    if err != nil {
        return nil, err
    }

    checkout := &CheckoutSession{
        ID:        generateCheckoutID(),
        StoreID:   storeID,
        CartToken: cart.Token,
        Currency:  store.Currency,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(30 * time.Minute),
    }

    // Reserve inventory for each line item
    for _, item := range cart.Items {
        reserved, err := s.inventorySync.ReserveInventory(ctx, item.VariantID, item.Quantity)
        if err != nil {
            // Rollback previous reservations
            s.inventorySync.ReleaseReservations(ctx, checkout.ID)
            return nil, fmt.Errorf("insufficient inventory for %s: %w", item.VariantID, err)
        }

        checkout.LineItems = append(checkout.LineItems, CheckoutLineItem{
            VariantID:     item.VariantID,
            Quantity:      item.Quantity,
            Price:         reserved.Price,
            ReservationID: reserved.ID,
        })
    }

    // Calculate totals
    checkout.Subtotal = s.calculateSubtotal(checkout.LineItems)

    return checkout, nil
}

// CompleteCheckout processes payment and creates order
func (s *StoreService) CompleteCheckout(ctx context.Context, checkoutID string, payment *PaymentInfo) (*Order, error) {
    checkout, err := s.getCheckout(ctx, checkoutID)
    if err != nil {
        return nil, err
    }

    checkout.mu.Lock()
    defer checkout.mu.Unlock()

    if time.Now().After(checkout.ExpiresAt) {
        return nil, ErrCheckoutExpired
    }

    // Process payment through configured gateway
    store, _ := s.tenantRouter.GetStore(ctx, checkout.StoreID)
    gateway := s.getPaymentGateway(store, payment.Method)

    paymentResult, err := gateway.Charge(ctx, &ChargeRequest{
        Amount:   checkout.Total,
        Currency: checkout.Currency,
        Source:   payment.Token,
    })

    if err != nil {
        return nil, fmt.Errorf("payment failed: %w", err)
    }

    // Convert inventory reservations to permanent deductions
    if err := s.inventorySync.CommitReservations(ctx, checkoutID); err != nil {
        // Refund payment on inventory commit failure
        gateway.Refund(ctx, paymentResult.TransactionID)
        return nil, err
    }

    // Create order
    order := s.createOrder(ctx, checkout, paymentResult)

    // Queue fulfillment
    s.checkoutQueue.EnqueueFulfillment(ctx, order)

    return order, nil
}
```

### Amazon: Distributed Inventory Management

Amazon's inventory system across fulfillment centers:

```go
// Amazon-style distributed inventory management
package amazon

import (
    "context"
    "sync"
    "time"
)

// InventoryService manages inventory across fulfillment centers
type InventoryService struct {
    fcClients     map[string]*FulfillmentCenterClient
    inventoryDB   *CockroachDB
    eventStream   *KinesisClient
    reservations  sync.Map
}

// FulfillmentCenter represents an Amazon FC
type FulfillmentCenter struct {
    ID           string   `json:"id"`
    Region       string   `json:"region"`
    Type         string   `json:"type"` // sortable, non-sortable, specialty
    Capacity     int64    `json:"capacity"`
    Capabilities []string `json:"capabilities"`
}

// InventoryLevel tracks stock at each FC
type InventoryLevel struct {
    ASIN              string    `json:"asin"`
    FNSKU             string    `json:"fnsku"`
    FulfillmentCenter string    `json:"fc"`
    Available         int       `json:"available"`
    Reserved          int       `json:"reserved"`
    InTransit         int       `json:"in_transit"`
    Unsellable        int       `json:"unsellable"`
    UpdatedAt         time.Time `json:"updated_at"`
}

// Reservation for multi-item orders
type Reservation struct {
    ID           string            `json:"id"`
    OrderID      string            `json:"order_id"`
    Items        []ReservationItem `json:"items"`
    ExpiresAt    time.Time         `json:"expires_at"`
    Status       string            `json:"status"`
}

// GetAvailableInventory returns sellable quantity across all FCs
func (s *InventoryService) GetAvailableInventory(ctx context.Context, asin string) (*InventorySummary, error) {
    // Query all FCs in parallel
    var wg sync.WaitGroup
    results := make(chan *InventoryLevel, len(s.fcClients))
    errors := make(chan error, len(s.fcClients))

    for fcID, client := range s.fcClients {
        wg.Add(1)
        go func(id string, c *FulfillmentCenterClient) {
            defer wg.Done()
            level, err := c.GetInventory(ctx, asin)
            if err != nil {
                errors <- err
                return
            }
            results <- level
        }(fcID, client)
    }

    go func() {
        wg.Wait()
        close(results)
        close(errors)
    }()

    summary := &InventorySummary{
        ASIN:        asin,
        FCLevels:    make(map[string]*InventoryLevel),
    }

    for level := range results {
        summary.TotalAvailable += level.Available
        summary.TotalReserved += level.Reserved
        summary.FCLevels[level.FulfillmentCenter] = level
    }

    return summary, nil
}

// ReserveInventory allocates inventory from optimal FCs
func (s *InventoryService) ReserveInventory(ctx context.Context, req *ReservationRequest) (*Reservation, error) {
    reservation := &Reservation{
        ID:        generateReservationID(),
        OrderID:   req.OrderID,
        ExpiresAt: time.Now().Add(15 * time.Minute),
        Status:    "pending",
    }

    // Calculate optimal FC allocation
    allocation := s.calculateOptimalAllocation(ctx, req.Items, req.ShipToZip)

    // Reserve from each FC
    for _, alloc := range allocation {
        // Atomic reservation with optimistic locking
        err := s.inventoryDB.Exec(ctx, `
            UPDATE inventory_levels
            SET reserved = reserved + $1,
                available = available - $1,
                updated_at = NOW()
            WHERE asin = $2 AND fc = $3 AND available >= $1
        `, alloc.Quantity, alloc.ASIN, alloc.FC)

        if err != nil {
            // Rollback previous reservations
            s.rollbackReservation(ctx, reservation)
            return nil, ErrInsufficientInventory
        }

        reservation.Items = append(reservation.Items, ReservationItem{
            ASIN:     alloc.ASIN,
            FC:       alloc.FC,
            Quantity: alloc.Quantity,
        })
    }

    reservation.Status = "confirmed"
    s.reservations.Store(reservation.ID, reservation)

    // Schedule expiration
    go s.scheduleExpiration(reservation)

    return reservation, nil
}

// calculateOptimalAllocation selects FCs to minimize shipping cost/time
func (s *InventoryService) calculateOptimalAllocation(ctx context.Context, items []OrderItem, shipToZip string) []Allocation {
    // Get shipping zones for destination
    zone := s.getShippingZone(shipToZip)

    // Score each FC based on:
    // 1. Distance to destination
    // 2. Available inventory
    // 3. Current FC load
    // 4. Shipping cost
    var allocations []Allocation

    for _, item := range items {
        remaining := item.Quantity
        candidateFCs := s.rankFCsForItem(ctx, item.ASIN, zone)

        for _, fc := range candidateFCs {
            if remaining <= 0 {
                break
            }

            available := fc.Available
            if available > remaining {
                available = remaining
            }

            allocations = append(allocations, Allocation{
                ASIN:     item.ASIN,
                FC:       fc.ID,
                Quantity: available,
            })
            remaining -= available
        }

        if remaining > 0 {
            // Could not fully allocate this item
            return nil
        }
    }

    return allocations
}
```

### Stripe: Payment Processing Integration

Stripe's payment processing patterns:

```go
// Stripe payment integration with idempotency
package stripe

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "time"
)

// PaymentService handles Stripe payment processing
type PaymentService struct {
    stripeClient  *StripeClient
    webhookSecret string
    idempotencyStore IdempotencyStore
}

// PaymentIntent represents a Stripe payment intent
type PaymentIntent struct {
    ID                string          `json:"id"`
    Amount            int64           `json:"amount"`
    Currency          string          `json:"currency"`
    Status            string          `json:"status"`
    PaymentMethod     string          `json:"payment_method"`
    ClientSecret      string          `json:"client_secret"`
    CaptureMethod     string          `json:"capture_method"` // automatic, manual
    SetupFutureUsage  string          `json:"setup_future_usage,omitempty"`
    Customer          string          `json:"customer,omitempty"`
    Metadata          map[string]string `json:"metadata"`
    Created           time.Time       `json:"created"`
}

// CreatePaymentIntent creates a payment intent with idempotency
func (s *PaymentService) CreatePaymentIntent(ctx context.Context, req *CreatePaymentRequest) (*PaymentIntent, error) {
    // Check idempotency key
    if req.IdempotencyKey != "" {
        if cached, err := s.idempotencyStore.Get(ctx, req.IdempotencyKey); err == nil {
            return cached.(*PaymentIntent), nil
        }
    }

    params := &stripe.PaymentIntentParams{
        Amount:        stripe.Int64(req.Amount),
        Currency:      stripe.String(req.Currency),
        CaptureMethod: stripe.String(req.CaptureMethod),
        Metadata:      req.Metadata,
    }

    if req.Customer != "" {
        params.Customer = stripe.String(req.Customer)
    }

    if req.PaymentMethod != "" {
        params.PaymentMethod = stripe.String(req.PaymentMethod)
        params.Confirm = stripe.Bool(true)
    }

    // Set idempotency key on Stripe request
    if req.IdempotencyKey != "" {
        params.SetIdempotencyKey(req.IdempotencyKey)
    }

    pi, err := s.stripeClient.PaymentIntents.New(params)
    if err != nil {
        return nil, s.handleStripeError(err)
    }

    result := &PaymentIntent{
        ID:            pi.ID,
        Amount:        pi.Amount,
        Currency:      string(pi.Currency),
        Status:        string(pi.Status),
        ClientSecret:  pi.ClientSecret,
        CaptureMethod: string(pi.CaptureMethod),
        Created:       time.Unix(pi.Created, 0),
    }

    // Cache for idempotency
    if req.IdempotencyKey != "" {
        s.idempotencyStore.Set(ctx, req.IdempotencyKey, result, 24*time.Hour)
    }

    return result, nil
}

// HandleWebhook processes Stripe webhook events
func (s *PaymentService) HandleWebhook(ctx context.Context, payload []byte, signature string) error {
    // Verify webhook signature
    if !s.verifyWebhookSignature(payload, signature) {
        return ErrInvalidSignature
    }

    var event stripe.Event
    if err := json.Unmarshal(payload, &event); err != nil {
        return err
    }

    // Process event based on type
    switch event.Type {
    case "payment_intent.succeeded":
        return s.handlePaymentSucceeded(ctx, event.Data.Object)
    case "payment_intent.payment_failed":
        return s.handlePaymentFailed(ctx, event.Data.Object)
    case "charge.dispute.created":
        return s.handleDisputeCreated(ctx, event.Data.Object)
    case "customer.subscription.updated":
        return s.handleSubscriptionUpdated(ctx, event.Data.Object)
    default:
        // Log unhandled event type
        return nil
    }
}

func (s *PaymentService) verifyWebhookSignature(payload []byte, signature string) bool {
    // Parse signature header
    parts := parseSignatureHeader(signature)
    timestamp := parts["t"]
    sig := parts["v1"]

    // Compute expected signature
    signedPayload := timestamp + "." + string(payload)
    mac := hmac.New(sha256.New, []byte(s.webhookSecret))
    mac.Write([]byte(signedPayload))
    expected := hex.EncodeToString(mac.Sum(nil))

    return hmac.Equal([]byte(sig), []byte(expected))
}
```

### Alibaba: Flash Sale System

Alibaba's high-concurrency flash sale handling:

```go
// Alibaba-style flash sale with inventory protection
package alibaba

import (
    "context"
    "sync/atomic"
    "time"

    "github.com/redis/go-redis/v9"
)

// FlashSaleService handles high-concurrency sales
type FlashSaleService struct {
    redis        *redis.ClusterClient
    inventoryLua *redis.Script
    orderQueue   *KafkaProducer
    rateLimiter  *SlidingWindowLimiter
}

// FlashSale represents a timed sale event
type FlashSale struct {
    ID           string          `json:"id"`
    ProductID    string          `json:"product_id"`
    OriginalPrice int64          `json:"original_price"`
    SalePrice    int64           `json:"sale_price"`
    TotalStock   int             `json:"total_stock"`
    StartTime    time.Time       `json:"start_time"`
    EndTime      time.Time       `json:"end_time"`
    Status       string          `json:"status"`
    soldCount    atomic.Int64
}

// Lua script for atomic inventory decrement
const decrementInventoryScript = `
local key = KEYS[1]
local requestedQty = tonumber(ARGV[1])
local userKey = KEYS[2]
local userID = ARGV[2]
local maxPerUser = tonumber(ARGV[3])

-- Check user purchase limit
local userPurchased = tonumber(redis.call('GET', userKey) or '0')
if userPurchased + requestedQty > maxPerUser then
    return {-2, userPurchased} -- User limit exceeded
end

-- Check and decrement inventory
local current = tonumber(redis.call('GET', key) or '0')
if current < requestedQty then
    return {-1, current} -- Insufficient inventory
end

redis.call('DECRBY', key, requestedQty)
redis.call('INCRBY', userKey, requestedQty)
redis.call('EXPIRE', userKey, 86400) -- 24 hour window

return {0, current - requestedQty}
`

// InitializeFlashSale prepares sale inventory in Redis
func (s *FlashSaleService) InitializeFlashSale(ctx context.Context, sale *FlashSale) error {
    // Pre-warm inventory in Redis
    inventoryKey := fmt.Sprintf("flash_sale:%s:inventory", sale.ID)
    if err := s.redis.Set(ctx, inventoryKey, sale.TotalStock, 0).Err(); err != nil {
        return err
    }

    // Store sale metadata
    saleKey := fmt.Sprintf("flash_sale:%s:meta", sale.ID)
    saleData, _ := json.Marshal(sale)
    if err := s.redis.Set(ctx, saleKey, saleData, 0).Err(); err != nil {
        return err
    }

    return nil
}

// AttemptPurchase handles high-concurrency purchase attempts
func (s *FlashSaleService) AttemptPurchase(ctx context.Context, req *PurchaseRequest) (*PurchaseResult, error) {
    // Rate limit per user
    if !s.rateLimiter.Allow(req.UserID) {
        return nil, ErrRateLimited
    }

    // Check sale is active
    sale, err := s.getSale(ctx, req.SaleID)
    if err != nil {
        return nil, err
    }

    now := time.Now()
    if now.Before(sale.StartTime) {
        return nil, ErrSaleNotStarted
    }
    if now.After(sale.EndTime) {
        return nil, ErrSaleEnded
    }

    // Atomic inventory check and decrement
    inventoryKey := fmt.Sprintf("flash_sale:%s:inventory", req.SaleID)
    userKey := fmt.Sprintf("flash_sale:%s:user:%s", req.SaleID, req.UserID)

    result, err := s.inventoryLua.Run(ctx, s.redis,
        []string{inventoryKey, userKey},
        req.Quantity, req.UserID, 2, // max 2 per user
    ).Slice()

    if err != nil {
        return nil, err
    }

    status := int(result[0].(int64))
    remaining := int(result[1].(int64))

    switch status {
    case -2:
        return nil, ErrUserLimitExceeded
    case -1:
        return nil, ErrSoldOut
    }

    // Queue order for async processing
    order := &FlashSaleOrder{
        ID:        generateOrderID(),
        SaleID:    req.SaleID,
        UserID:    req.UserID,
        Quantity:  req.Quantity,
        Price:     sale.SalePrice,
        Status:    "pending",
        CreatedAt: time.Now(),
    }

    if err := s.orderQueue.Send(ctx, order); err != nil {
        // Rollback inventory
        s.redis.IncrBy(ctx, inventoryKey, int64(req.Quantity))
        return nil, err
    }

    sale.soldCount.Add(int64(req.Quantity))

    return &PurchaseResult{
        OrderID:   order.ID,
        Remaining: remaining,
        Status:    "pending",
    }, nil
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Shopify | Multi-tenant architecture, Liquid templating | 2M+ stores |
| Amazon | Distributed inventory, FC optimization | 300M+ products |
| Stripe | Idempotency keys, webhook reliability | \$1T+ processed |
| Alibaba | Flash sale system, inventory protection | 583K orders/sec peak |

---

### Junior → FAANG: Learning Constraints from Case Studies

Alibaba's flash sale system (583k orders per second) is the extreme end of the inventory consistency spectrum. At that throughput, standard database row locking is impossible: the lock wait queue would be longer than the sale duration. The solution is pre-sharded inventory pools distributed across multiple database instances, with Redis-based counter pre-deduction that is reconciled with the database after the sale. Knowing this pattern shows you understand that standard ACID guarantees have throughput limits.

Shopify's multi-tenant architecture (millions of merchants on shared infrastructure) introduces a different constraint: tenant isolation. A high-traffic merchant must not degrade performance for low-traffic merchants. Rate limiting per merchant, database connection pool limits per tenant, and circuit breakers that isolate a failing merchant's traffic are the mechanisms Shopify uses. Understanding tenant isolation is directly applicable to any SaaS system.

Stripe's idempotency key design is the cleanest implementation of the "network operations are unreliable" principle in production software. Study how they implement it and apply the same pattern to your own distributed writes.

### Senior @ FAANG: Case Studies as Design Review Evidence

At senior level, case studies are referenced in design reviews to justify architectural choices. "Shopify moves to a separate database per merchant beyond a certain size threshold (a choice they documented in their engineering blog) because shared database isolation techniques cannot provide sufficient performance isolation at their scale" is a stronger justification for a multi-database architecture decision than a theoretical argument.

Alibaba's Singles Day architecture (the 583k orders/second peak) demonstrates the value of pre-computation: inventory is pre-allocated to regional warehouses, prices are pre-computed and cached, and the "purchase" operation is reduced to a counter decrement rather than a full database transaction. Pre-computation shifts work from the hot path (purchase) to the cold path (preparation). Understanding when to apply this pattern and how to maintain consistency between pre-computed state and the actual database is a staff-level design capability.

Amazon's inventory system (tracking billions of items across hundreds of warehouses with real-time availability) represents the fully generalized form of the inventory problem in this project. Their solution involves sharded inventory counters, regional inventory pools, and a probability-based availability model ("usually ships in 2 days" rather than "exact count available"). The probabilistic model trades accuracy for availability and is appropriate when the cost of "item out of stock after purchase" is lower than the cost of overselling prevention mechanisms.

---
