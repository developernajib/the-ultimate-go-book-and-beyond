## 80.10 Company-Specific Go Interview Processes

### Google Interview Process

Google's Go interviews focus on algorithmic thinking with idiomatic Go:

```go
// Google-style question: Design a rate limiter with distributed coordination
// Expected: Clean interfaces, testability, production considerations

package ratelimit

import (
    "context"
    "sync"
    "time"
)

// RateLimiter defines the rate limiting interface
type RateLimiter interface {
    // Allow returns true if request is allowed
    Allow(ctx context.Context, key string) (bool, error)
    // AllowN returns true if n requests are allowed
    AllowN(ctx context.Context, key string, n int) (bool, error)
}

// TokenBucket implements a local token bucket rate limiter
type TokenBucket struct {
    rate       float64 // tokens per second
    burst      int     // maximum bucket size
    buckets    map[string]*bucket
    mu         sync.Mutex
}

type bucket struct {
    tokens     float64
    lastUpdate time.Time
}

// NewTokenBucket creates a new token bucket limiter
func NewTokenBucket(rate float64, burst int) *TokenBucket {
    return &TokenBucket{
        rate:    rate,
        burst:   burst,
        buckets: make(map[string]*bucket),
    }
}

func (tb *TokenBucket) Allow(ctx context.Context, key string) (bool, error) {
    return tb.AllowN(ctx, key, 1)
}

func (tb *TokenBucket) AllowN(ctx context.Context, key string, n int) (bool, error) {
    select {
    case <-ctx.Done():
        return false, ctx.Err()
    default:
    }

    tb.mu.Lock()
    defer tb.mu.Unlock()

    now := time.Now()
    b, ok := tb.buckets[key]
    if !ok {
        b = &bucket{tokens: float64(tb.burst), lastUpdate: now}
        tb.buckets[key] = b
    }

    // Add tokens based on elapsed time
    elapsed := now.Sub(b.lastUpdate).Seconds()
    b.tokens = min(float64(tb.burst), b.tokens+elapsed*tb.rate)
    b.lastUpdate = now

    if b.tokens >= float64(n) {
        b.tokens -= float64(n)
        return true, nil
    }

    return false, nil
}

// Note: Uses builtin min() available since Go 1.21

// Google follow-up: Make it distributed with Redis
// They want to see your approach to consistency vs availability trade-offs
```

**Google Interview Expectations:**
- Clean, readable code following Go conventions
- Proper error handling and context usage
- Discussion of trade-offs and alternatives
- Testing strategy explanation
- Scalability considerations

### Meta Interview Process

Meta focuses on practical production scenarios:

```go
// Meta-style question: Implement a concurrent cache with TTL and size limits

package cache

import (
    "container/list"
    "context"
    "sync"
    "time"
)

// Cache provides thread-safe caching with TTL and LRU eviction
type Cache struct {
    maxSize   int
    defaultTTL time.Duration

    mu        sync.RWMutex
    items     map[string]*cacheItem
    evictList *list.List

    // Metrics for production monitoring
    hits      int64
    misses    int64
}

type cacheItem struct {
    key       string
    value     any
    expiresAt time.Time
    element   *list.Element
}

// NewCache creates a new cache instance
func NewCache(maxSize int, defaultTTL time.Duration) *Cache {
    c := &Cache{
        maxSize:    maxSize,
        defaultTTL: defaultTTL,
        items:      make(map[string]*cacheItem),
        evictList:  list.New(),
    }

    // Start cleanup goroutine
    go c.cleanupLoop()

    return c
}

// Get retrieves a value from cache
func (c *Cache) Get(key string) (any, bool) {
    c.mu.RLock()
    item, ok := c.items[key]
    c.mu.RUnlock()

    if !ok {
        c.mu.Lock()
        c.misses++
        c.mu.Unlock()
        return nil, false
    }

    if time.Now().After(item.expiresAt) {
        c.Delete(key)
        c.mu.Lock()
        c.misses++
        c.mu.Unlock()
        return nil, false
    }

    c.mu.Lock()
    c.hits++
    c.evictList.MoveToFront(item.element)
    c.mu.Unlock()

    return item.value, true
}

// Set stores a value in cache
func (c *Cache) Set(key string, value any) {
    c.SetWithTTL(key, value, c.defaultTTL)
}

// SetWithTTL stores a value with custom TTL
func (c *Cache) SetWithTTL(key string, value any, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Update existing item
    if item, ok := c.items[key]; ok {
        item.value = value
        item.expiresAt = time.Now().Add(ttl)
        c.evictList.MoveToFront(item.element)
        return
    }

    // Evict if at capacity
    for c.evictList.Len() >= c.maxSize {
        c.evictOldest()
    }

    // Add new item
    item := &cacheItem{
        key:       key,
        value:     value,
        expiresAt: time.Now().Add(ttl),
    }
    item.element = c.evictList.PushFront(item)
    c.items[key] = item
}

// Delete removes an item from cache
func (c *Cache) Delete(key string) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if item, ok := c.items[key]; ok {
        c.evictList.Remove(item.element)
        delete(c.items, key)
    }
}

func (c *Cache) evictOldest() {
    element := c.evictList.Back()
    if element != nil {
        item := element.Value.(*cacheItem)
        c.evictList.Remove(element)
        delete(c.items, item.key)
    }
}

func (c *Cache) cleanupLoop() {
    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        c.cleanup()
    }
}

func (c *Cache) cleanup() {
    c.mu.Lock()
    defer c.mu.Unlock()

    now := time.Now()
    for key, item := range c.items {
        if now.After(item.expiresAt) {
            c.evictList.Remove(item.element)
            delete(c.items, key)
        }
    }
}

// Stats returns cache statistics
func (c *Cache) Stats() (hits, misses int64, size int) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.hits, c.misses, c.evictList.Len()
}
```

**Meta Interview Expectations:**
- Production-ready code with monitoring hooks
- Concurrent data structure handling
- Memory efficiency considerations
- Clear API design

### Amazon Interview Process

Amazon interviews focus on leadership principles alongside coding:

```go
// Amazon-style question: Design an order processing system
// They evaluate: Customer obsession, ownership, dive deep

package orders

import (
    "context"
    "errors"
    "sync"
    "time"
)

var (
    ErrOrderNotFound     = errors.New("order not found")
    ErrInvalidTransition = errors.New("invalid state transition")
    ErrInventoryLow      = errors.New("insufficient inventory")
)

// OrderState represents order lifecycle states
type OrderState string

const (
    StateCreated    OrderState = "created"
    StatePending    OrderState = "pending"
    StateConfirmed  OrderState = "confirmed"
    StateShipped    OrderState = "shipped"
    StateDelivered  OrderState = "delivered"
    StateCanceled  OrderState = "canceled"
)

// Order represents a customer order
type Order struct {
    ID          string
    CustomerID  string
    Items       []OrderItem
    State       OrderState
    TotalAmountCents int64
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type OrderItem struct {
    ProductID string
    Quantity  int
    PriceCents int64
}

// OrderProcessor handles order state transitions
type OrderProcessor struct {
    orders    map[string]*Order
    mu        sync.RWMutex

    // Dependencies (would be injected in production)
    inventory InventoryService
    payment   PaymentService
    notify    NotificationService
}

type InventoryService interface {
    Reserve(ctx context.Context, items []OrderItem) error
    Release(ctx context.Context, items []OrderItem) error
}

type PaymentService interface {
    Charge(ctx context.Context, customerID string, amountCents int64) error
    Refund(ctx context.Context, customerID string, amountCents int64) error
}

type NotificationService interface {
    NotifyCustomer(ctx context.Context, customerID, message string) error
}

// Valid state transitions
var validTransitions = map[OrderState][]OrderState{
    StateCreated:   {StatePending, StateCanceled},
    StatePending:   {StateConfirmed, StateCanceled},
    StateConfirmed: {StateShipped, StateCanceled},
    StateShipped:   {StateDelivered},
    StateDelivered: {},
    StateCanceled: {},
}

// NewOrderProcessor creates a new order processor
func NewOrderProcessor(inv InventoryService, pay PaymentService, notify NotificationService) *OrderProcessor {
    return &OrderProcessor{
        orders:    make(map[string]*Order),
        inventory: inv,
        payment:   pay,
        notify:    notify,
    }
}

// CreateOrder creates a new order
func (p *OrderProcessor) CreateOrder(ctx context.Context, customerID string, items []OrderItem) (*Order, error) {
    // Calculate total
    var totalCents int64
    for _, item := range items {
        totalCents += item.PriceCents * int64(item.Quantity)
    }

    order := &Order{
        ID:          generateID(),
        CustomerID:  customerID,
        Items:       items,
        State:       StateCreated,
        TotalAmountCents: totalCents,
        CreatedAt:   time.Now(),
        UpdatedAt:   time.Now(),
    }

    p.mu.Lock()
    p.orders[order.ID] = order
    p.mu.Unlock()

    return order, nil
}

// ProcessOrder moves order through workflow
func (p *OrderProcessor) ProcessOrder(ctx context.Context, orderID string) error {
    p.mu.Lock()
    order, ok := p.orders[orderID]
    if !ok {
        p.mu.Unlock()
        return ErrOrderNotFound
    }
    p.mu.Unlock()

    switch order.State {
    case StateCreated:
        return p.transitionToPending(ctx, order)
    case StatePending:
        return p.transitionToConfirmed(ctx, order)
    case StateConfirmed:
        return p.transitionToShipped(ctx, order)
    case StateShipped:
        return p.transitionToDelivered(ctx, order)
    default:
        return ErrInvalidTransition
    }
}

func (p *OrderProcessor) transitionToPending(ctx context.Context, order *Order) error {
    // Reserve inventory
    if err := p.inventory.Reserve(ctx, order.Items); err != nil {
        return err
    }

    return p.updateState(order, StatePending)
}

func (p *OrderProcessor) transitionToConfirmed(ctx context.Context, order *Order) error {
    // Charge payment
    if err := p.payment.Charge(ctx, order.CustomerID, order.TotalAmountCents); err != nil {
        // Release inventory on payment failure
        p.inventory.Release(ctx, order.Items)
        return err
    }

    if err := p.updateState(order, StateConfirmed); err != nil {
        return err
    }

    // Notify customer
    p.notify.NotifyCustomer(ctx, order.CustomerID, "Your order has been confirmed!")
    return nil
}

func (p *OrderProcessor) transitionToShipped(ctx context.Context, order *Order) error {
    if err := p.updateState(order, StateShipped); err != nil {
        return err
    }

    p.notify.NotifyCustomer(ctx, order.CustomerID, "Your order has been shipped!")
    return nil
}

func (p *OrderProcessor) transitionToDelivered(ctx context.Context, order *Order) error {
    if err := p.updateState(order, StateDelivered); err != nil {
        return err
    }

    p.notify.NotifyCustomer(ctx, order.CustomerID, "Your order has been delivered!")
    return nil
}

// CancelOrder cancels an order
func (p *OrderProcessor) CancelOrder(ctx context.Context, orderID string) error {
    p.mu.Lock()
    order, ok := p.orders[orderID]
    if !ok {
        p.mu.Unlock()
        return ErrOrderNotFound
    }
    p.mu.Unlock()

    // Check if cancellation is allowed
    if !p.canTransition(order.State, StateCanceled) {
        return ErrInvalidTransition
    }

    // Release inventory if reserved
    if order.State != StateCreated {
        p.inventory.Release(ctx, order.Items)
    }

    // Refund if payment was made
    if order.State == StateConfirmed || order.State == StateShipped {
        p.payment.Refund(ctx, order.CustomerID, order.TotalAmountCents)
    }

    return p.updateState(order, StateCanceled)
}

func (p *OrderProcessor) canTransition(from, to OrderState) bool {
    valid, ok := validTransitions[from]
    if !ok {
        return false
    }
    for _, state := range valid {
        if state == to {
            return true
        }
    }
    return false
}

func (p *OrderProcessor) updateState(order *Order, newState OrderState) error {
    if !p.canTransition(order.State, newState) {
        return ErrInvalidTransition
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    order.State = newState
    order.UpdatedAt = time.Now()
    return nil
}

func generateID() string {
    return time.Now().Format("20060102150405.000000")
}
```

**Amazon Interview Expectations:**
- State machine design for business workflows
- Error handling with customer impact consideration
- Idempotency and retry handling
- Clear separation of concerns

### Uber Interview Process

Uber emphasizes real-time systems and reliability:

```go
// Uber-style question: Design a surge pricing calculator
// Focus: Real-time data processing, geographic computation

package surge

import (
    "math"
    "sync"
    "time"
)

// GeoHash represents a geographic region
type GeoHash string

// SurgePricing calculates dynamic pricing based on supply/demand
type SurgePricing struct {
    // Active drivers per region
    drivers map[GeoHash]int
    // Active ride requests per region
    requests map[GeoHash]int
    // Historical baseline per region
    baseline map[GeoHash]float64

    mu sync.RWMutex

    // Configuration
    minMultiplier float64
    maxMultiplier float64
    smoothingFactor float64
}

// NewSurgePricing creates a new surge pricing calculator
func NewSurgePricing() *SurgePricing {
    return &SurgePricing{
        drivers:         make(map[GeoHash]int),
        requests:        make(map[GeoHash]int),
        baseline:        make(map[GeoHash]float64),
        minMultiplier:   1.0,
        maxMultiplier:   5.0,
        smoothingFactor: 0.3,
    }
}

// UpdateDriverCount updates active driver count for a region
func (sp *SurgePricing) UpdateDriverCount(region GeoHash, count int) {
    sp.mu.Lock()
    defer sp.mu.Unlock()
    sp.drivers[region] = count
}

// UpdateRequestCount updates ride request count for a region
func (sp *SurgePricing) UpdateRequestCount(region GeoHash, count int) {
    sp.mu.Lock()
    defer sp.mu.Unlock()
    sp.requests[region] = count
}

// GetSurgeMultiplier returns the current surge multiplier for a region
func (sp *SurgePricing) GetSurgeMultiplier(region GeoHash) float64 {
    sp.mu.RLock()
    defer sp.mu.RUnlock()

    drivers := sp.drivers[region]
    requests := sp.requests[region]
    baseline := sp.baseline[region]

    if baseline == 0 {
        baseline = 1.0
    }

    // Calculate raw supply/demand ratio
    var ratio float64
    if drivers > 0 {
        ratio = float64(requests) / float64(drivers)
    } else if requests > 0 {
        ratio = sp.maxMultiplier // No drivers = max surge
    } else {
        ratio = 1.0 // No demand, no surge
    }

    // Apply smoothing to prevent sudden changes
    smoothedRatio := baseline + sp.smoothingFactor*(ratio-baseline)

    // Clamp to valid range
    multiplier := math.Max(sp.minMultiplier, math.Min(sp.maxMultiplier, smoothedRatio))

    return math.Round(multiplier*10) / 10 // Round to 1 decimal
}

// CalculatePrice calculates the final price with surge (integer cents policy)
func (sp *SurgePricing) CalculatePrice(region GeoHash, basePriceCents int64) int64 {
    multiplier := sp.GetSurgeMultiplier(region)
    return int64(math.Round(float64(basePriceCents) * multiplier))
}

// Location represents a GPS coordinate
type Location struct {
    Lat, Lng float64
}

// EncodeGeoHash converts location to geohash (simplified)
func EncodeGeoHash(loc Location, precision int) GeoHash {
    // Simplified geohash encoding
    latBin := int((loc.Lat + 90) / 180 * float64(1<<precision))
    lngBin := int((loc.Lng + 180) / 360 * float64(1<<precision))
    return GeoHash(string(rune(latBin)) + string(rune(lngBin)))
}

// GetNeighborRegions returns adjacent regions for broader surge analysis
func GetNeighborRegions(region GeoHash) []GeoHash {
    // Return neighboring geohash cells
    // Implementation would calculate adjacent cells
    return []GeoHash{region} // Simplified
}
```

**Uber Interview Expectations:**
- Geographic data handling
- Real-time data processing
- Mathematical modeling
- Performance under high throughput

---

### Junior → FAANG: Company Research as Interview Preparation, Not Networking

Many junior candidates treat company-specific research as a soft-skills activity ("so you can say you are excited about the company's mission"). At FAANG, it is a technical preparation activity. The specific focus areas for Go at each company reflect real production requirements. Tesla's emphasis on embedded systems and real-time constraints means concurrency questions will lean toward deterministic scheduling. Cloudflare's focus on network programming means you need to understand Go's `net` package, connection pooling, and zero-copy patterns more deeply than for application-layer roles.

Concrete preparation: for each company you are targeting, read their engineering blog for the past 12 months. Identify the Go-specific content. Note the stack (what observability tools, what storage systems, what deployment model), because interviewers often draw problems from real systems they work on.

First-job habit: the habit of reading engineering blogs to understand the company's technical reality is the same habit that will help you ramp up on your first day, understand why decisions were made, and contribute meaningfully in the first month.

### Senior @ FAANG: Company-Specific Go Expectations as a Signal of Platform Maturity

For senior candidates, company-specific Go expectations are not just topics to study. They are signals about the engineering culture and the kind of problems you would work on. A senior engineer evaluates companies during the interview process, not just after receiving an offer.

Signals to probe: what is the company's Go versioning strategy (are they current with the latest Go release or running N-2)? What is their internal tooling posture for Go (are they using `buf` for Protobuf, `golangci-lint` for static analysis, custom linters for their domain)? What is the ratio of green-field Go work versus maintaining existing Go services? These questions, asked intelligently during the "do you have questions for me" section of an interview, demonstrate that you are evaluating fit as a senior contributor, not just trying to pass.

ADR thinking for company selection: treat your company selection process as an architectural decision. Document your criteria (team size, Go usage maturity, technical challenge, level of investment in platform engineering), evaluate the options against those criteria, and make a reasoned choice. The same structured decision-making that makes good ADRs makes good career decisions, and being able to articulate this process in a behavioral interview is an L6-level signal.
