## Common Mistakes and How to Avoid Them

### Mistake 1: Premature Optimization

Premature optimization creates accidental complexity before the system's actual bottlenecks are known, resulting in codebases that are hard to understand and modify without a corresponding performance benefit. Starting with a simple monolith and evolving toward microservices only when scaling requirements demand it is almost always the right approach. The anti-pattern below shows a todo application split into ten microservices before any user has been acquired. The code contrast demonstrates that the simple approach can be production-ready at moderate scale while remaining maintainable and deployable by a small team.

```go
// ❌ BAD: Over-engineering from the start
type OverEngineeredSystem struct {
    // 10 microservices for a TODO app
    userService       *UserService
    authService       *AuthService
    todoService       *TodoService
    notificationSvc   *NotificationService
    analyticsService  *AnalyticsService
    searchService     *SearchService
    // ... 4 more services

    // Kafka for 100 users
    kafka *KafkaCluster

    // Kubernetes with 20 pods
    k8s *K8sDeployment

    // 3 databases for "flexibility"
    postgres    *sql.DB
    mongodb     *mongo.Client
    elasticsearch *elastic.Client
}

// ✅ GOOD: Start simple, scale when needed
type RightSizedSystem struct {
    db    *sql.DB        // Single Postgres handles millions of rows
    cache *redis.Client  // Cache when profiling shows it's needed
}

func NewRightSizedSystem() *RightSizedSystem {
    // Start with a monolith
    // Add complexity only when:
    // 1. Profiling shows bottlenecks
    // 2. Team size requires service boundaries
    // 3. Different scaling needs are proven, not assumed

    return &RightSizedSystem{
        db:    connectPostgres(),
        cache: nil, // Add later when needed
    }
}

// Scale incrementally based on metrics
func (s *RightSizedSystem) MaybeAddCache() {
    // Check if cache is actually needed
    dbLatency := s.metrics.P99Latency("database")
    if dbLatency > 100*time.Millisecond && s.metrics.QPS() > 1000 {
        s.cache = redis.NewClient(&redis.Options{
            Addr: "localhost:6379",
        })
    }
}
```

### Mistake 2: Ignoring the CAP Theorem Trade-offs

The CAP theorem states that a distributed system can guarantee only two of Consistency, Availability, and Partition Tolerance simultaneously, yet many teams design as if all three are achievable at once. The naive implementation below waits for every node to confirm a write, which hangs indefinitely during a network partition, while the well-designed version makes the trade-off explicit through a `ConsistencyLevel` parameter. Choosing the right level, strong for financial writes, eventual for analytics, is a deliberate architectural decision that must be documented and communicated to the whole team.

```go
// ❌ BAD: Trying to have it all
type NaiveDistributedSystem struct {
    // "We'll have strong consistency AND high availability AND partition tolerance"
    nodes []*Node
}

func (s *NaiveDistributedSystem) Write(ctx context.Context, key string, value []byte) error {
    // Waits for ALL nodes to acknowledge
    // During network partition: HANGS FOREVER
    for _, node := range s.nodes {
        if err := node.Write(ctx, key, value); err != nil {
            return err // Single node failure = whole write fails
        }
    }
    return nil
}

// ✅ GOOD: Explicit trade-off decisions
type WellDesignedSystem struct {
    nodes         []*Node
    writeQuorum   int
    readQuorum    int
    consistency   ConsistencyLevel
}

type ConsistencyLevel int

const (
    StrongConsistency ConsistencyLevel = iota // Wait for all nodes
    QuorumConsistency                          // Wait for majority
    EventualConsistency                        // Async replication
)

func (s *WellDesignedSystem) Write(ctx context.Context, key string, value []byte, level ConsistencyLevel) error {
    switch level {
    case StrongConsistency:
        // For critical financial data - accept higher latency
        return s.writeToAll(ctx, key, value)

    case QuorumConsistency:
        // For most use cases - good balance
        return s.writeQuorum(ctx, key, value)

    case EventualConsistency:
        // For analytics, logging - maximum throughput
        return s.writeAsync(ctx, key, value)
    }
    return nil
}

func (s *WellDesignedSystem) writeQuorum(ctx context.Context, key string, value []byte) error {
    responses := make(chan error, len(s.nodes))

    for _, node := range s.nodes {
        go func(n *Node) {
            responses <- n.Write(ctx, key, value)
        }(node)
    }

    // Wait for quorum (majority)
    successes := 0
    for i := 0; i < len(s.nodes); i++ {
        if err := <-responses; err == nil {
            successes++
            if successes >= s.writeQuorum {
                return nil // Quorum achieved
            }
        }
    }

    return ErrQuorumNotReached
}
```

### Mistake 3: Not Planning for Failure

Distributed services fail in partial and unpredictable ways, a downstream call may time out, a payment may be partially applied, or a message may be delivered twice on retry. The fragile implementation below has no timeouts, no idempotency key, and no compensation logic, so a single transient error leaves the system in an inconsistent state. The resilient version wraps each external call in a circuit breaker with a timeout, uses an idempotency key to prevent double charges, and performs a compensating refund if the order creation step fails after a successful payment.

```go
// ❌ BAD: Assuming everything works
func (s *FragileService) ProcessOrder(ctx context.Context, order Order) error {
    // No timeouts
    inventory, err := s.inventoryService.Check(ctx, order.Items)
    if err != nil {
        return err // Propagates up, no recovery
    }

    // No retries
    payment, err := s.paymentService.Charge(ctx, order.Total)
    if err != nil {
        return err // User gets error, no compensation
    }

    // No idempotency - double charge possible on retry
    return s.orderService.Create(ctx, order)
}

// ✅ GOOD: Design for failure at every step
func (s *ResilientService) ProcessOrder(ctx context.Context, order Order) error {
    // Use idempotency key
    idempotencyKey := order.ID

    // Check if already processed
    if existing, _ := s.orderService.GetByIdempotencyKey(ctx, idempotencyKey); existing != nil {
        return nil // Already processed, return success
    }

    // Circuit breaker for inventory service
    var inventory *Inventory
    err := s.inventoryCB.Execute(func() error {
        var err error
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()

        inventory, err = s.inventoryService.Check(ctx, order.Items)
        return err
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            // Circuit is open - use cached inventory or degrade gracefully
            inventory = s.getCachedInventory(ctx, order.Items)
            if inventory == nil {
                return ErrServiceDegraded
            }
        } else {
            return fmt.Errorf("inventory check failed: %w", err)
        }
    }

    // Payment with idempotency and retries
    var payment *Payment
    err = retry.Do(
        func() error {
            var err error
            payment, err = s.paymentService.ChargeIdempotent(ctx, order.Total, idempotencyKey)
            return err
        },
        retry.Attempts(3),
        retry.Delay(100*time.Millisecond),
        retry.RetryIf(isRetryable),
    )

    if err != nil {
        // Payment failed - no cleanup needed (nothing was charged)
        return fmt.Errorf("payment failed: %w", err)
    }

    // Create order with compensation on failure
    err = s.orderService.CreateIdempotent(ctx, order, idempotencyKey)
    if err != nil {
        // Order creation failed - need to refund
        s.paymentService.Refund(ctx, payment.ID)
        return fmt.Errorf("order creation failed: %w", err)
    }

    return nil
}
```

### Mistake 4: Cache Stampede

A cache stampede occurs when many concurrent requests all experience a cache miss at the same moment, typically because a popular key expired, and then simultaneously fall through to the database, which can be overwhelmed in seconds. The naive implementation lets every goroutine independently query the database on a miss, while three defensive strategies are demonstrated: single-flight (coalescing concurrent fetches into one), probabilistic early expiration (proactively refreshing before the TTL reaches zero), and distributed locking (allowing only one writer while others wait). Choosing among these depends on the acceptable read staleness and whether your cache client supports atomic `SetNX` operations.

```go
// ❌ BAD: Classic cache stampede
func (s *Service) GetPopularItem(ctx context.Context, id string) (*Item, error) {
    // Cache expires at exactly the same time for all requests
    item, err := s.cache.Get(ctx, "item:"+id)
    if err == nil {
        return item, nil
    }

    // 1000 concurrent requests all miss cache simultaneously
    // All 1000 requests hit the database
    // Database overwhelmed, latency spikes
    return s.db.GetItem(ctx, id)
}

// ✅ GOOD: Multiple strategies to prevent stampede
func (s *Service) GetPopularItemSafe(ctx context.Context, id string) (*Item, error) {
    key := "item:" + id

    // Strategy 1: Single-flight (coalesce concurrent requests)
    result, err, _ := s.sfGroup.Do(key, func() (any, error) {
        // Only one request hits the database
        return s.loadAndCache(ctx, key, id)
    })

    if err != nil {
        return nil, err
    }
    return result.(*Item), nil
}

// Strategy 2: Probabilistic early expiration
func (s *Service) GetWithEarlyExpiry(ctx context.Context, id string) (*Item, error) {
    key := "item:" + id

    item, ttl, err := s.cache.GetWithTTL(ctx, key)
    if err == nil {
        // Probabilistically refresh before expiry
        // As TTL approaches 0, probability of refresh increases
        if s.shouldRefresh(ttl) {
            go s.refreshCache(context.Background(), key, id)
        }
        return item, nil
    }

    return s.loadAndCache(ctx, key, id)
}

func (s *Service) shouldRefresh(ttl time.Duration) bool {
    // Higher probability as TTL decreases:
    // at 10% remaining TTL there is a ~90% chance of refresh
    threshold := float64(ttl) / float64(s.baseTTL)
    return rand.Float64() > threshold
}

// Strategy 3: Lock-based refresh
func (s *Service) GetWithLock(ctx context.Context, id string) (*Item, error) {
    key := "item:" + id
    lockKey := "lock:" + key

    item, err := s.cache.Get(ctx, key)
    if err == nil {
        return item, nil
    }

    // Try to acquire lock
    acquired, err := s.cache.SetNX(ctx, lockKey, "1", 10*time.Second)
    if err != nil {
        return nil, err
    }

    if acquired {
        defer s.cache.Delete(ctx, lockKey)
        return s.loadAndCache(ctx, key, id)
    }

    // Another request is loading - wait and retry
    time.Sleep(50 * time.Millisecond)
    return s.GetWithLock(ctx, id)
}
```

### Mistake 5: Improper Database Sharding

Sharding by `user_id` seems intuitive but creates hot spots when a small number of power users, such as large marketplace sellers, generate a disproportionate fraction of the data, concentrating all of their rows on a single shard. The better approach shards products by `product_id` so data spreads uniformly, then handles the "get all products for a seller" query either through a scatter-gather fan-out across all shards or via a lightweight seller-to-product-IDs index table. The scatter-gather implementation uses goroutines to query all shards in parallel and merges results, keeping latency bounded regardless of which shard holds the data.

```go
// ❌ BAD: Shard by user_id for an e-commerce platform
// Problem: All operations for popular sellers on same shard
type BadSharding struct {
    shards []*sql.DB
}

func (s *BadSharding) GetShard(userID string) *sql.DB {
    // Popular seller with 1M products: ALL on one shard
    hash := fnv32(userID)
    return s.shards[hash%uint32(len(s.shards))]
}

func (s *BadSharding) GetSellerProducts(ctx context.Context, sellerID string, page int) ([]*Product, error) {
    shard := s.GetShard(sellerID)
    // This shard is overloaded with popular sellers
    return queryProducts(ctx, shard, sellerID, page)
}

// ✅ GOOD: Shard by product_id, composite key strategies
type GoodSharding struct {
    shards     []*sql.DB
    hotShards  []*sql.DB // Dedicated shards for hot data
    directory  *ShardDirectory
}

func (s *GoodSharding) GetProductShard(productID string) *sql.DB {
    // Products distributed across all shards
    hash := fnv32(productID)
    return s.shards[hash%uint32(len(s.shards))]
}

func (s *GoodSharding) GetSellerProducts(ctx context.Context, sellerID string, page int) ([]*Product, error) {
    // Option 1: Query all shards in parallel (for small result sets)
    if s.isSmallSeller(sellerID) {
        return s.scatterGather(ctx, "SELECT * FROM products WHERE seller_id = ?", sellerID)
    }

    // Option 2: Use product index table
    // seller_products table maps seller_id -> product_ids (sharded by seller_id)
    productIDs, err := s.getSellerProductIDs(ctx, sellerID, page)
    if err != nil {
        return nil, err
    }

    // Parallel fetch from product shards
    return s.batchGetProducts(ctx, productIDs)
}

func (s *GoodSharding) scatterGather(ctx context.Context, query string, args ...any) ([]*Product, error) {
    results := make(chan []*Product, len(s.shards))
    errs := make(chan error, len(s.shards))

    for _, shard := range s.shards {
        go func(db *sql.DB) {
            products, err := queryProducts(ctx, db, args...)
            if err != nil {
                errs <- err
                return
            }
            results <- products
        }(shard)
    }

    var allProducts []*Product
    for i := 0; i < len(s.shards); i++ {
        select {
        case products := <-results:
            allProducts = append(allProducts, products...)
        case err := <-errs:
            return nil, err
        }
    }

    return allProducts, nil
}
```

### Junior → FAANG: Recognizing Mistakes Before They Happen

The five mistakes in this section are extremely common in interviews as well as in production. Interviewers at FAANG frequently use anti-pattern recognition as a filter: a candidate who proposes a naively sharded system without mentioning hot spots, or who adds a Kafka cluster to a system that processes 100 requests per day, raises a flag.

A first-job habit that prevents premature optimization: always anchor your design to a specific, quantified scale. "This system needs to handle 10,000 DAU with p95 latency under 200ms and 99.9% availability" is a design requirement. "This system needs to be highly scalable" is not. When you have a concrete scale target, the right solution usually becomes obvious: a single PostgreSQL instance, a small Redis cluster, and a handful of application servers. The Netflix-scale architecture only makes sense at Netflix scale.

The CAP theorem mistake (Mistake 2) is particularly common because it is invisible during development. A system that requires all nodes to acknowledge writes works perfectly in local development, where there is no network partitioning. It fails catastrophically in production, where partitions happen for dozens of reasons. The defensive habit: whenever you design a write path that touches more than one node, explicitly ask "what happens if one of these nodes is unreachable for 30 seconds?" and document the answer.

The cache stampede (Mistake 4) is a classic example of a problem that only appears under load. The solution, single-flight deduplication, is easy to apply in Go using `golang.org/x/sync/singleflight`. Make it a habit to use `singleflight` for any fetch-and-cache operation from your first job forward. It costs nothing and prevents a class of production incidents.

### Senior @ FAANG: Mistake Prevention at Organizational Scale

At staff level, the goal is not to prevent your own team from making these mistakes. It is to create conditions where every team in your domain finds it easier to avoid these mistakes than to make them.

**Premature optimization as an organizational failure mode.** Over-engineering is not just a technical mistake. It is a resourcing and priority mistake. A startup that builds a Kafka-backed event-driven microservices architecture before reaching product-market fit has burned months of engineering time on infrastructure that provides no user value at their current scale. At the staff level, you recognize this pattern in design reviews before it is too late. The question is not "can this scale?" but "does this need to scale in the next 12 months, and what is the minimum viable architecture that gets us to 10x our current scale while being maintainable by the team we have?" Starting with a monolith and extracting services along proven boundaries is a well-documented pattern (the "strangler fig") that reduces risk significantly.

**CAP theorem governance in architecture reviews.** The pattern of "strong consistency everywhere" is a recurring mistake at early-stage companies that have experienced a consistency bug and overcorrected. The staff-level response is: map each data type to its required consistency model explicitly, and use the most relaxed model that is correct for each type. Strong consistency has a real cost (write latency, reduced availability during partitions) and should be reserved for data types where the cost of inconsistency is measurable and direct (financial balances, inventory counts, authentication tokens). Social feeds, recommendation scores, and analytics aggregates almost always tolerate eventual consistency.

**Failure planning as an architectural requirement.** Mistake 3 (not planning for failure) is the most expensive mistake in this list, measured by incident cost. At FAANG, post-mortems reveal that the majority of production incidents have a root cause in a missing timeout, a missing retry budget, or a missing compensation transaction. The staff-level response is to make failure handling a blocking checklist item in design reviews, not an optional enhancement. For every external call in a design: what is the timeout, what is the retry strategy, what is the circuit breaker threshold, and what happens to the user when the circuit is open? If these questions cannot be answered for a service that is about to go to production, the design review is not complete.

**Sharding strategy governance.** Improper sharding (Mistake 5) is particularly hard to fix in production because the fix requires a data migration. The staff-level response is to treat the sharding key as a schema contract and require explicit justification for any choice other than a high-cardinality, uniformly-distributed key. The hot-shard problem is predictable for any entity type where a small number of records generate a disproportionate fraction of activity (sellers, authors, popular content). The mitigation strategies (separate hot-shard handling, directory-based routing, application-level fan-out) should be selected and documented before the sharding is implemented, not discovered after a hot shard causes an outage.

---
