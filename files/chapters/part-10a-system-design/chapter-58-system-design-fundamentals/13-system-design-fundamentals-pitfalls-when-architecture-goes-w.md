## System Design Fundamentals Pitfalls: When Architecture Goes Wrong

### Pitfall 1: Over-Engineering for Scale You Don't Have

**Incident Report**: Startup spent 6 months building a "Netflix-scale" architecture for an app with 100 daily users. The system required 15 microservices, Kubernetes cluster, and 3 full-time DevOps engineers just to keep running. They ran out of runway before reaching product-market fit.

```go
// WRONG: Premature distributed complexity
// For a simple todo app with 100 users

// 15 separate microservices:
// - user-service
// - auth-service
// - todo-service
// - notification-service
// - analytics-service
// - search-service
// - file-service
// - email-service
// - sms-service
// - payment-service (for "future premium")
// - recommendation-service
// - api-gateway
// - config-service
// - logging-service
// - metrics-service

// Each with its own:
// - Database
// - Kubernetes deployment
// - CI/CD pipeline
// - Monitoring dashboard

// CORRECT: Start simple, scale when needed
// Single service that does everything
type TodoApp struct {
    db     *sql.DB
    cache  *sync.Map  // In-memory cache, upgrade to Redis when needed
    mailer *SimpleMailer
}

func NewTodoApp(dbURL string) (*TodoApp, error) {
    db, err := sql.Open("postgres", dbURL)
    if err != nil {
        return nil, err
    }

    return &TodoApp{
        db:     db,
        cache:  &sync.Map{},
        mailer: NewSimpleMailer(),
    }, nil
}

// All features in one codebase
func (app *TodoApp) CreateTodo(ctx context.Context, userID string, todo *Todo) error {
    // Database write
    _, err := app.db.ExecContext(ctx,
        "INSERT INTO todos (user_id, title, completed) VALUES ($1, $2, $3)",
        userID, todo.Title, todo.Completed)
    if err != nil {
        return err
    }

    // Invalidate cache
    app.cache.Delete("todos:" + userID)

    // Send notification (inline, not separate service)
    if todo.DueDate != nil {
        app.mailer.ScheduleReminder(userID, todo)
    }

    return nil
}

// Scale guidance:
// - 1-1K users: Single server, SQLite/Postgres
// - 1K-10K users: Add Redis cache, read replica
// - 10K-100K users: Consider splitting auth, add CDN
// - 100K+ users: Now microservices make sense
```

### Pitfall 2: Ignoring the CAP Theorem in Design Decisions

**Incident Report**: E-commerce platform designed for "strong consistency everywhere" using synchronous writes across 3 data centers. During a network partition, the entire site went down for 4 hours because no region could achieve quorum.

```go
// WRONG: Assuming you can have all three (C, A, P)
type InventoryService struct {
    primary   *sql.DB  // US-East
    secondary *sql.DB  // US-West
    tertiary  *sql.DB  // EU
}

func (s *InventoryService) ReserveStock(ctx context.Context, productID string, quantity int) error {
    // Synchronous write to ALL regions - requires all to be available
    tx1, _ := s.primary.BeginTx(ctx, nil)
    tx2, _ := s.secondary.BeginTx(ctx, nil)
    tx3, _ := s.tertiary.BeginTx(ctx, nil)

    // Problem: If ANY region is unreachable, entire operation fails
    // During partition: 100% failure rate

    _, err := tx1.Exec("UPDATE inventory SET stock = stock - $1 WHERE product_id = $2", quantity, productID)
    if err != nil {
        tx1.Rollback(); tx2.Rollback(); tx3.Rollback()
        return err
    }

    // ... same for tx2 and tx3

    tx1.Commit(); tx2.Commit(); tx3.Commit()
    return nil
}

// CORRECT: Design for partition tolerance with explicit trade-offs
type InventoryService struct {
    localDB    *sql.DB
    replicator *AsyncReplicator
    resolver   *ConflictResolver
}

func (s *InventoryService) ReserveStock(ctx context.Context, productID string, quantity int) error {
    // Write to local region (availability during partition)
    reservation := &Reservation{
        ID:        uuid.New().String(),
        ProductID: productID,
        Quantity:  quantity,
        Region:    s.region,
        Timestamp: time.Now(),
        Status:    "pending",
    }

    // Local write succeeds even during partition
    if _, err := s.localDB.ExecContext(ctx,
        `INSERT INTO reservations (id, product_id, quantity, region, ts, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        reservation.ID, reservation.ProductID, reservation.Quantity,
        reservation.Region, reservation.Timestamp, reservation.Status,
    ); err != nil {
        return err
    }

    // Async replication with conflict detection
    s.replicator.Enqueue(ReplicationEvent{
        Type:      "stock_reservation",
        Payload:   reservation,
        Timestamp: time.Now(),
    })

    return nil
}

// Conflict resolution for when partition heals
func (r *ConflictResolver) ResolveStockConflicts(ctx context.Context, productID string) error {
    // Get reservations from all regions
    reservations := r.getAllReservations(productID)

    // Sort by timestamp (last-writer-wins for this use case)
    sort.Slice(reservations, func(i, j int) bool {
        return reservations[i].Timestamp.Before(reservations[j].Timestamp)
    })

    // Apply in order, reject if oversold
    availableStock := r.getCurrentStock(productID)
    for _, res := range reservations {
        if res.Quantity <= availableStock {
            res.Status = "confirmed"
            availableStock -= res.Quantity
        } else {
            res.Status = "rejected_insufficient_stock"
            // Notify customer, offer alternatives
            r.notifyOversold(res)
        }
        r.updateReservation(res)
    }

    return nil
}
```

### Pitfall 3: Single Point of Failure in "Highly Available" Design

**Incident Report**: Company marketed their system as "99.99% available" with redundant everything. A single DNS configuration error took down all services for 6 hours because every service resolved the same DNS server.

```go
// WRONG: Hidden SPOFs in seemingly redundant architecture
func main() {
    // "Redundant" setup
    primary := connectDB("primary-db.company.internal")
    replica := connectDB("replica-db.company.internal")

    cache1 := connectRedis("cache-1.company.internal")
    cache2 := connectRedis("cache-2.company.internal")

    // Problem: All resolve through single internal DNS
    // DNS goes down = everything goes down

    // Problem 2: Single load balancer config
    // Wrong config pushed = all traffic black-holed
}

// CORRECT: Eliminate hidden SPOFs
type ResilientService struct {
    dbPool      *DBPool
    cachePool   *CachePool
    dnsResolver *MultiResolver
}

func NewResilientService() *ResilientService {
    return &ResilientService{
        // Multiple DNS resolvers
        dnsResolver: &MultiResolver{
            resolvers: []string{
                "8.8.8.8",           // Google
                "1.1.1.1",           // Cloudflare
                "internal-dns-1",    // Primary internal
                "internal-dns-2",    // Secondary internal
            },
        },

        // Database pool with multiple connection paths
        dbPool: &DBPool{
            connections: []*DBConnection{
                {Host: "10.0.1.5", Port: 5432},  // Direct IP, no DNS
                {Host: "primary-db.company.internal", Port: 5432},
                {Host: "replica-db.region2.internal", Port: 5432},
            },
        },

        // Cache with fallback
        cachePool: &CachePool{
            primary:   "10.0.2.10:6379",  // Direct IP
            secondary: "10.0.3.10:6379",
            localFallback: NewLocalCache(),  // In-memory if all Redis down
        },
    }
}

// Multi-path DNS resolution
func (r *MultiResolver) Resolve(host string) (string, error) {
    var lastErr error

    for _, resolver := range r.resolvers {
        ip, err := r.resolveWith(resolver, host)
        if err == nil {
            return ip, nil
        }
        lastErr = err
    }

    return "", fmt.Errorf("all DNS resolvers failed: %w", lastErr)
}

// SPOF checklist for any design:
// 1. DNS - Multiple resolvers, cache results, use IPs as fallback
// 2. Load balancer - Multiple LBs, health checks, direct-to-server fallback
// 3. Config - Multiple config sources, local cache, safe defaults
// 4. Certificates - Multiple cert issuers, early renewal, monitoring
// 5. Authentication - Local token validation, cached sessions
// 6. Logging/Metrics - Fire-and-forget, don't block on send failure
```

### Pitfall 4: Underestimating Network Latency in Capacity Planning

**Incident Report**: System designed for 10,000 QPS handled only 500 QPS in production. Each request made 20 network calls (database, cache, other services), and the 50ms network latency per call meant 1 second per request.

```go
// WRONG: Ignoring network latency in design
func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
    // Each call adds 50ms latency

    user, _ := s.userService.GetUser(ctx, order.UserID)          // 50ms
    address, _ := s.addressService.Validate(ctx, order.Address)  // 50ms
    inventory, _ := s.inventoryService.Check(ctx, order.Items)   // 50ms
    price, _ := s.pricingService.Calculate(ctx, order.Items)     // 50ms
    discount, _ := s.promotionService.Apply(ctx, order)          // 50ms
    tax, _ := s.taxService.Calculate(ctx, price, address)        // 50ms
    fraud, _ := s.fraudService.Check(ctx, user, order)           // 50ms
    payment, _ := s.paymentService.Authorize(ctx, order)         // 50ms
    _, _ = s.orderDB.Create(ctx, order)                          // 50ms
    _ = s.notificationService.Send(ctx, user, order)             // 50ms
    _ = s.analyticsService.Track(ctx, "order_created", order)    // 50ms
    _ = s.searchService.Index(ctx, order)                        // 50ms

    // Total: 600ms per request
    // Max throughput: ~1.6 QPS per thread (not 10,000!)

    return nil
}

// CORRECT: Design for network reality
func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
    ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
    defer cancel()

    var (
        wg      sync.WaitGroup
        results = make(map[string]any)
        errs    = make(map[string]error)
        mu      sync.Mutex
    )

    // Parallel critical-path calls
    criticalCalls := []struct {
        name string
        fn   func() (any, error)
    }{
        {"user", func() (any, error) { return s.userService.GetUser(ctx, order.UserID) }},
        {"inventory", func() (any, error) { return s.inventoryService.Check(ctx, order.Items) }},
        {"fraud", func() (any, error) { return s.fraudService.Check(ctx, order.UserID, order) }},
    }

    for _, call := range criticalCalls {
        wg.Add(1)
        go func(c struct {
            name string
            fn   func() (any, error)
        }) {
            defer wg.Done()
            result, err := c.fn()
            mu.Lock()
            results[c.name] = result
            errs[c.name] = err
            mu.Unlock()
        }(call)
    }

    wg.Wait()

    // Check critical results
    for name, err := range errs {
        if err != nil {
            return fmt.Errorf("%s failed: %w", name, err)
        }
    }

    // Non-critical calls: fire and forget
    go s.analyticsService.Track(context.Background(), "order_created", order)
    go s.searchService.Index(context.Background(), order)

    // Batch database write
    return s.orderDB.Create(ctx, order)

    // Total: max(50ms, 50ms, 50ms) + 50ms = 100ms
    // 10x improvement, now ~10 QPS per thread
}
```

### Pitfall 5: Not Planning for Graceful Degradation

**Incident Report**: Recommendation engine went down, causing the entire homepage to return 500 errors. The frontend required all components to load successfully, making a non-critical feature a critical dependency.

```go
// WRONG: All-or-nothing responses
func (s *HomepageService) GetHomepage(ctx context.Context, userID string) (*Homepage, error) {
    products, err := s.productService.GetFeatured(ctx)
    if err != nil {
        return nil, err  // Page fails if featured products unavailable
    }

    recommendations, err := s.recService.GetPersonalized(ctx, userID)
    if err != nil {
        return nil, err  // Page fails if recommendations unavailable
    }

    deals, err := s.dealService.GetActive(ctx)
    if err != nil {
        return nil, err  // Page fails if deals unavailable
    }

    return &Homepage{
        Featured:        products,
        Recommendations: recommendations,
        Deals:           deals,
    }, nil
}

// CORRECT: Graceful degradation with fallbacks
type HomepageService struct {
    productService  *ProductService
    recService      *RecommendationService
    dealService     *DealService
    fallbackCache   *FallbackCache
    circuitBreakers map[string]*CircuitBreaker
}

func (s *HomepageService) GetHomepage(ctx context.Context, userID string) (*Homepage, error) {
    homepage := &Homepage{
        RenderHints: make(map[string]string),
    }

    // The three loaders below run concurrently and each writes a
    // different struct field, which is safe. The shared RenderHints
    // map is not: concurrent map writes panic, so guard it.
    var mu sync.Mutex
    setHint := func(k, v string) {
        mu.Lock()
        homepage.RenderHints[k] = v
        mu.Unlock()
    }

    var wg sync.WaitGroup

    // Featured products - critical, has fallback
    wg.Add(1)
    go func() {
        defer wg.Done()

        if s.circuitBreakers["products"].IsOpen() {
            homepage.Featured = s.fallbackCache.GetFeatured()
            setHint("featured", "cached")
            return
        }

        products, err := s.productService.GetFeatured(ctx)
        if err != nil {
            s.circuitBreakers["products"].RecordFailure()
            homepage.Featured = s.fallbackCache.GetFeatured()
            setHint("featured", "fallback")
        } else {
            homepage.Featured = products
            s.fallbackCache.UpdateFeatured(products)
        }
    }()

    // Recommendations - non-critical, can be empty
    wg.Add(1)
    go func() {
        defer wg.Done()

        if s.circuitBreakers["recommendations"].IsOpen() {
            // Show generic popular items instead
            homepage.Recommendations = s.fallbackCache.GetPopular()
            setHint("recommendations", "popular_fallback")
            return
        }

        recs, err := s.recService.GetPersonalized(ctx, userID)
        if err != nil {
            s.circuitBreakers["recommendations"].RecordFailure()
            homepage.Recommendations = nil  // Frontend shows "Check out trending" section
            setHint("recommendations", "unavailable")
        } else {
            homepage.Recommendations = recs
        }
    }()

    // Deals - non-critical
    wg.Add(1)
    go func() {
        defer wg.Done()

        deals, err := s.dealService.GetActive(ctx)
        if err != nil {
            homepage.Deals = nil  // Frontend hides deals section
            setHint("deals", "hidden")
        } else {
            homepage.Deals = deals
        }
    }()

    wg.Wait()

    // Homepage always returns, even if degraded
    return homepage, nil
}
```

### Quick Reference: System Design Fundamentals Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Over-engineering | High complexity for low traffic | Start simple, scale when needed |
| CAP ignorance | Total failure during partitions | Explicit trade-offs, async replication |
| Hidden SPOFs | "HA" system has single failures | SPOF checklist, multiple paths |
| Latency blindness | 10x lower throughput than expected | Parallel calls, batch operations |
| All-or-nothing | Partial failures crash everything | Graceful degradation, fallbacks |

### Junior → FAANG: Recognizing Pitfalls in Design Reviews and Interviews

The five pitfalls in this section are all failures of over-confidence: teams that assumed their system would work as designed without testing the failure cases. For junior engineers, the lesson is to develop the habit of asking "what could go wrong?" for every component you propose.

A concrete practice: after you finish designing any system in an interview or on paper, go through each component and ask three questions. Can this component fail? What happens to the overall system when it does? Is there a degraded mode that still serves the user? If you cannot answer all three for any component, the design is not complete.

The network latency pitfall (Pitfall 4) is particularly important for Go engineers. Go makes it easy to spawn goroutines for parallel calls. The pattern of fanning out 10-20 service calls in parallel and collecting results is common and correct. What is less commonly appreciated is that each of those calls has a timeout, and the composite operation's timeout must be shorter than the minimum timeout of any individual call. Context propagation with deadlines is the right tool in Go: create a deadline context at the start of the request and pass it to every downstream call. When the deadline is reached, all in-flight calls are canceled, and you return a graceful degraded response rather than hanging until all 20 calls complete or time out independently.

The SPOF pitfall (Pitfall 3) is worth memorizing as a checklist item for any production architecture: DNS, load balancer configuration, certificate issuance, authentication services, logging and metrics pipelines, and the configuration management system itself. Each of these is a hidden dependency that can take down a "highly available" system if it fails.

### Senior @ FAANG: Pitfall Prevention as Organizational Practice

At staff level, pitfall prevention is a governance function. Individual engineers make mistakes. An organization with good design review processes and tooling catches those mistakes before they reach production.

**The over-engineering pitfall and architectural governance.** Pitfall 1 (over-engineering) is symptomatic of teams that lack a clear definition of "done" for their architecture. A service is over-engineered when its operational complexity exceeds its operational value at the current scale. At the staff level, you define and enforce a principle of "architecture earns its complexity," where each layer of distributed complexity must be justified by a specific, measured requirement. This principle, enforced in design reviews, prevents the pattern of building a streaming event processing pipeline for a workload that generates 100 events per day.

**CAP theorem governance in incident retrospectives.** Many production incidents involving data inconsistency have a root cause in an undocumented CAP trade-off decision. A synchronous three-region write that was added for correctness causes an availability failure when the third region has a transient network issue. An eventually-consistent store that was used for performance shows stale inventory data during a traffic spike. At the staff level, you build the habit of reviewing post-mortems through the lens of CAP: which property was violated, was that violation anticipated, and is the current system design explicit about the trade-off? If the answer to the last question is no, the post-mortem action item is to document the trade-off, not just fix the immediate bug.

**SPOF detection as a mandatory design review step.** Pitfall 3 reveals that highly available systems can have hidden single points of failure in surprising places (DNS resolver, load balancer config distribution, certificate issuance). At the staff level, you build a SPOF detection protocol into every design review: map every external dependency, name the failure mode for each, and verify that the failure of any single dependency does not cause a complete system outage. The test for this is: "if this service is the only thing that fails right now, does our system still serve users?" For DNS, the answer is often no, and the mitigation (IP-based fallbacks, multiple resolver providers, local DNS caching) must be explicitly designed in.

**Graceful degradation as a product contract.** Pitfall 5 (all-or-nothing responses) is a design pattern problem, but it is also a product contract problem. The frontend expects certain components to always be present. When the backend cannot provide them, the frontend returns a 500. The fix requires changes on both sides: the backend must return partial results with degradation hints, and the frontend must be designed to handle missing components gracefully. At the staff level, you establish this as an organizational standard: every service that aggregates multiple data sources must define which sources are critical (failure returns an error), which are optional (failure returns empty), and which have fallbacks (failure returns cached or default data). This contract is documented in the service interface definition, not discovered during an incident.

---
