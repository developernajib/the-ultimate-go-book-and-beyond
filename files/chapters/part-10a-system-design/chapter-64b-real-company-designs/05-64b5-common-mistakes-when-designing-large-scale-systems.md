## Common Mistakes and How to Avoid Them

### Mistake 1: Premature Optimization Without Data

Starting with a highly distributed, microservices-first architecture before you have traffic data is the most expensive mistake in system design. Each service boundary introduces network calls, distributed tracing requirements, independent deployments, and operational overhead that add cost without delivering value at low scale. Real companies (Shopify, Stack Overflow, GitHub) ran monoliths at significant scale before decomposing selectively based on measured bottlenecks.

```go
// BAD: Over-engineering from day one without actual traffic data
type BadArchitecture struct {
    // 50 microservices for a startup with 100 users
    userService        *UserService
    authService        *AuthService
    profileService     *ProfileService
    avatarService      *AvatarService
    notificationEmail  *EmailNotificationService
    notificationPush   *PushNotificationService
    notificationSMS    *SMSNotificationService
    // ... 43 more services
}

// GOOD: Start simple, measure, then optimize
type GoodArchitecture struct {
    // Monolith that handles everything
    app *MonolithApp

    // Clear boundaries ready for extraction when needed
    metrics *MetricsCollector // Know what's slow
}

func (g *GoodArchitecture) ExtractWhenNeeded(ctx context.Context) {
    // Check metrics before extracting
    stats := g.metrics.GetHotspots()

    for _, hotspot := range stats {
        if hotspot.P99Latency > 500*time.Millisecond &&
           hotspot.RequestsPerSecond > 1000 {
            // Now we have data to justify extraction
            log.Printf("Consider extracting %s: p99=%v, rps=%d",
                hotspot.Name, hotspot.P99Latency, hotspot.RequestsPerSecond)
        }
    }
}
```

### Mistake 2: Ignoring Network Partition Reality

The "eight fallacies of distributed computing" begin with "the network is reliable", yet many distributed systems are implemented as if service calls always succeed. A fund transfer that calls two services sequentially without compensation logic will leave the system in an inconsistent state whenever the second call fails after the first has already committed. The saga pattern addresses this by pairing each step with an explicit compensating transaction that undoes its effect, ensuring the overall operation either completes fully or rolls back cleanly.

```go
// BAD: Assumes network is reliable
func (s *BadService) TransferFunds(ctx context.Context, from, to string, amount int64) error {
    // This can partially succeed!
    s.accountService.Debit(ctx, from, amount)   // Succeeds
    s.accountService.Credit(ctx, to, amount)    // Network failure!
    // User lost money!
    return nil
}

// GOOD: Design for network failures with saga pattern
type GoodService struct {
    sagaOrchestrator *SagaOrchestrator
}

func (s *GoodService) TransferFunds(ctx context.Context, from, to string, amount int64) error {
    saga := s.sagaOrchestrator.NewSaga("transfer", map[string]any{
        "from":   from,
        "to":     to,
        "amount": amount,
    })

    // Each step has a compensating action
    saga.AddStep(Step{
        Name:       "debit",
        Execute:    func(ctx context.Context) error { return s.debit(ctx, from, amount) },
        Compensate: func(ctx context.Context) error { return s.credit(ctx, from, amount) },
    })

    saga.AddStep(Step{
        Name:       "credit",
        Execute:    func(ctx context.Context) error { return s.credit(ctx, to, amount) },
        Compensate: func(ctx context.Context) error { return s.debit(ctx, to, amount) },
    })

    return saga.Execute(ctx) // Automatically compensates on failure
}
```

### Mistake 3: Single Point of Failure

Any component that, if unavailable, takes the entire system down is a single point of failure. Databases are the most common SPOF because read traffic, write traffic, and metadata queries all flow through the primary instance. Distributing reads across read replicas reduces load on the primary, while a health-checked read/write router abstracts the topology from application code and allows failover without code changes.

```go
// BAD: All traffic through single database
type BadDesign struct {
    db *sql.DB // One database, no replicas
}

func (b *BadDesign) GetUser(ctx context.Context, id string) (*User, error) {
    // If this DB goes down, entire system is unavailable
    return b.db.QueryContext(ctx, "SELECT * FROM users WHERE id = $1", id)
}

// GOOD: Multiple layers of redundancy
type GoodDesign struct {
    primary   *sql.DB
    replicas  []*sql.DB
    cache     *redis.ClusterClient
    circuitBreaker *gobreaker.CircuitBreaker
}

func (g *GoodDesign) GetUser(ctx context.Context, id string) (*User, error) {
    // Try cache first
    if user, err := g.getUserFromCache(ctx, id); err == nil {
        return user, nil
    }

    // Try with circuit breaker
    result, err := g.circuitBreaker.Execute(func() (any, error) {
        // Try primary
        user, err := g.queryUser(ctx, g.primary, id)
        if err == nil {
            go g.cacheUser(ctx, user) // Async cache population
            return user, nil
        }

        // Failover to replica
        for _, replica := range g.replicas {
            if user, err := g.queryUser(ctx, replica, id); err == nil {
                go g.cacheUser(ctx, user)
                return user, nil
            }
        }

        return nil, err
    })

    if err != nil {
        return nil, err
    }
    return result.(*User), nil
}
```

### Mistake 4: Not Planning for Capacity

Hardcoding worker counts and channel buffer sizes is a silent time bomb: the system works fine in testing but collapses under a traffic spike because there is no mechanism to grow throughput dynamically. The correct approach is to observe queue depth at runtime and adjust the worker pool proportionally, scaling up when the queue is backing up and scaling down when it drains, keeping the system responsive without permanently over-provisioning CPU and memory.

```go
// BAD: Fixed capacity without growth planning
type BadQueueProcessor struct {
    workers int // Fixed at 10
    queue   chan *Task
}

func NewBadProcessor() *BadQueueProcessor {
    return &BadQueueProcessor{
        workers: 10,
        queue:   make(chan *Task, 100), // What if we get 1000 tasks?
    }
}

// GOOD: Auto-scaling based on load
type GoodQueueProcessor struct {
    minWorkers int
    maxWorkers int
    workers    []*Worker
    queue      chan *Task
    metrics    *Metrics
    mu         sync.Mutex
}

func (p *GoodQueueProcessor) Monitor(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            p.adjustWorkers()
        case <-ctx.Done():
            return
        }
    }
}

func (p *GoodQueueProcessor) adjustWorkers() {
    p.mu.Lock()
    defer p.mu.Unlock()

    queueDepth := len(p.queue)
    currentWorkers := len(p.workers)

    // Scale up if queue is backing up
    if queueDepth > currentWorkers*10 && currentWorkers < p.maxWorkers {
        newWorkers := min(currentWorkers*2, p.maxWorkers)
        for i := currentWorkers; i < newWorkers; i++ {
            p.spawnWorker()
        }
    }

    // Scale down if underutilized
    if queueDepth < currentWorkers && currentWorkers > p.minWorkers {
        targetWorkers := max(currentWorkers/2, p.minWorkers)
        for i := currentWorkers; i > targetWorkers; i-- {
            p.stopWorker()
        }
    }
}
```

### Mistake 5: Coupling to Specific Technologies

Embedding a vendor SDK directly in business logic makes provider migration a full rewrite rather than a configuration change. When payment processors go down, get delisted, or charge prohibitive fees, you need to reroute traffic to a backup without touching core logic. Defining a `PaymentProvider` interface keeps all Stripe- or PayPal-specific code isolated in thin adapter structs, so the router can select or failover between providers based on rules, geography, currency, error rate, without any change to the calling code.

```go
// BAD: Tight coupling to specific services
type BadPaymentService struct {
    stripe *stripe.Client // What if we need to add PayPal?
}

func (s *BadPaymentService) ProcessPayment(ctx context.Context, amount int64) error {
    // Stripe-specific code everywhere
    return s.stripe.Charges.Create(amount)
}

// GOOD: Interface-based abstraction
type PaymentProvider interface {
    Charge(ctx context.Context, amount int64, currency string) (*PaymentResult, error)
    Refund(ctx context.Context, chargeID string) error
}

type GoodPaymentService struct {
    providers map[string]PaymentProvider
    router    *PaymentRouter
}

func (s *GoodPaymentService) ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentResult, error) {
    // Route to appropriate provider based on rules
    provider := s.router.SelectProvider(req)

    result, err := provider.Charge(ctx, req.Amount, req.Currency)
    if err != nil {
        // Automatic failover to backup provider
        if backupProvider := s.router.GetBackup(req); backupProvider != nil {
            return backupProvider.Charge(ctx, req.Amount, req.Currency)
        }
    }

    return result, err
}
```

---

### Junior -> FAANG: Five Heuristics for Avoiding These Mistakes Early

Each of the five mistakes in this section corresponds to a heuristic that experienced engineers apply automatically.

Mistake 1 (premature optimization) maps to the heuristic: "Make it work, make it right, make it fast, in that order." Start with a monolith. Extract services only when you can name a measured bottleneck that the extraction will fix.

Mistake 2 (ignoring network partitions) maps to the heuristic: "Every remote call can fail. Every remote call must have a failure path." The saga pattern shown here is one failure path. Others are retry with idempotency, circuit breaker with fallback, and compensation via event sourcing. Know all four and be able to explain when each is appropriate.

Mistake 3 (single point of failure) maps to the heuristic: "Draw your architecture diagram, then ask which single node's failure takes everything down." Every node you identify is a SPOF that needs redundancy. The question is whether the cost of that redundancy is justified by the availability requirement.

Mistake 4 (not planning for capacity) maps to the heuristic: "The number that works today is not the number that will work after the next traffic spike. Build the scaling mechanism before you need it."

Mistake 5 (coupling to technologies) maps to the heuristic: "If your business logic imports a vendor SDK, you have coupled your business logic to a vendor." The interface adapter pattern is not over-engineering. It is the minimum viable abstraction for any external dependency.

### Senior @ FAANG: Platform-Level Enforcement of Each Heuristic

At L6/L7, these heuristics are not personal disciplines, they are platform policies enforced through tooling and process.

Premature optimization is countered by a service decomposition policy: new services require an architecture review that includes a metrics-based justification (here is the bottleneck, here is the measured latency, here is the expected improvement). Services created without this justification are flagged in quarterly architecture reviews.

Network partition handling is countered by a distributed systems checklist in the design review template: does every external call have a retry policy? does every multi-step operation have a compensation path or an idempotency key? is the failure mode documented and tested? Design reviews that do not address these questions are sent back for revision.

Single points of failure are countered by an availability tier system: Tier 0 services (payment, auth, core APIs) require N+2 redundancy across at least two availability zones. Tier 1 services require N+1 redundancy. Tier 2 services can run on a single instance with a documented RTO. New services are assigned a tier at creation and must meet that tier's redundancy requirements before launching to production.

Technology coupling is countered by a vendor-abstraction standard: any dependency on a specific vendor SDK (Stripe, Twilio, specific cloud provider services) must be wrapped in an interface defined in the business domain package. The interface is reviewed for vendor-neutrality. SDK imports are banned from business logic packages via a linting rule. This policy makes vendor migrations a configuration change rather than a code rewrite, which is the correct operational property at scale.