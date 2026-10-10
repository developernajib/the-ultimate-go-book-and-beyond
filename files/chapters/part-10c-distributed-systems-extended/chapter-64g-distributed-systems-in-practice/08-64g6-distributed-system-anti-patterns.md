## 64G.6 Distributed System Anti-Patterns

### Anti-Pattern 1: The Distributed Monolith

A distributed monolith looks like microservices but functions like a monolith - services are tightly coupled and can only be deployed together.

```
Signs of a distributed monolith:
- "We can't deploy Service A without also deploying Service B and C"
- All services share a single database schema
- Schema migrations require coordinating downtime across multiple teams
- Service A calls Service B calls Service C synchronously on every request
- A single logical business transaction spans multiple service databases

Detection:
```

```go
// Detecting tight coupling: deployment dependency graph
// If you can draw lines like this, you may have a distributed monolith:
// UserService → OrderService → InventoryService → NotificationService
// (all synchronous, all required for each user action)

// How to break it:
// 1. Identify which calls must be synchronous vs can be async
// 2. Convert non-critical synchronous calls to async events
// 3. Define service contracts (API + event schema) that allow independent deployment

// Strangler fig pattern for breaking coupling:
// Old: HTTP call from OrderService to InventoryService
// New: OrderService emits "order.created" event
//      InventoryService consumes event and reserves stock
//      OrderService doesn't wait for reservation

package antipatterns

import (
    "context"
    "fmt"
)

type Order struct {
    Items []string
}

type Event struct {
    Type string
    Data any
}

type InventoryClient interface {
    Reserve(ctx context.Context, items []string) error
}

type OrderRepository interface {
    Save(ctx context.Context, order Order) error
    SaveWithOutbox(ctx context.Context, order Order, events []Event) error
}

type NotificationClient interface {
    SendConfirmation(ctx context.Context, order Order) error
}

type OrderService struct {
    inventoryClient InventoryClient
    orderRepo       OrderRepository
    notifyClient    NotificationClient
}

// Before:
func (s *OrderService) PlaceOrderSync(ctx context.Context, order Order) error {
    // Synchronous chain - any failure cascades
    if err := s.inventoryClient.Reserve(ctx, order.Items); err != nil {
        return fmt.Errorf("reserving inventory: %w", err)
    }
    if err := s.orderRepo.Save(ctx, order); err != nil {
        return fmt.Errorf("saving order: %w", err)
    }
    if err := s.notifyClient.SendConfirmation(ctx, order); err != nil {
        return fmt.Errorf("sending notification: %w", err) // ← non-critical failure kills order!
    }
    return nil
}

// After:
func (s *OrderService) PlaceOrder(ctx context.Context, order Order) error {
    // Critical: save order atomically
    if err := s.orderRepo.SaveWithOutbox(ctx, order, []Event{
        {Type: "order.created", Data: order},
    }); err != nil {
        return fmt.Errorf("saving order: %w", err)
    }
    // Non-critical operations handled async by event consumers:
    // - InventoryService consumes "order.created" → reserves stock
    // - NotificationService consumes "order.created" → sends email
    // Order placement succeeds even if these services are temporarily down
    return nil
}
```

### Anti-Pattern 2: Chatty Services

Chatty services, those that make dozens of fine-grained RPC calls to fulfill a single user request, amplify network latency and degrade tail latency percentiles as each call adds its own overhead. The following before/after code demonstrates replacing a sequence of individual RPC calls with a single batched query, reducing the number of round trips from O(n) to O(1).

```go
package antipatterns

import (
    "context"

    "golang.org/x/sync/errgroup"
)

type Product struct {
    ID string
}

type Price int64

type ProductDisplay struct {
    Product Product
    Price   Price
    InStock bool
    Rating  float64
}

type Page struct {
    Products []ProductDisplay
}

type ProductClient interface {
    ListByCategory(ctx context.Context, catID string) ([]Product, error)
}

type PricingClient interface {
    GetPrice(ctx context.Context, id string) (Price, error)
    BatchGetPrices(ctx context.Context, ids []string) (map[string]Price, error)
}

type InventoryClient2 interface {
    GetCount(ctx context.Context, id string) (int, error)
    BatchGetCounts(ctx context.Context, ids []string) (map[string]int, error)
}

type ReviewClient interface {
    GetAverageRating(ctx context.Context, id string) (float64, error)
    BatchGetRatings(ctx context.Context, ids []string) (map[string]float64, error)
}

type ProductListingService struct {
    productClient   ProductClient
    pricingClient   PricingClient
    inventoryClient InventoryClient2
    reviewClient    ReviewClient
}

func extractIDs(products []Product) []string {
    ids := make([]string, len(products))
    for i, p := range products {
        ids[i] = p.ID
    }
    return ids
}

// Chatty: service makes N calls to get data for N items
// Example: building a product listing page

// Wrong: N+1 in microservices
func (s *ProductListingService) GetListingPageChatty(ctx context.Context, categoryID string) (*Page, error) {
    products, err := s.productClient.ListByCategory(ctx, categoryID) // 1 call
    if err != nil {
        return nil, err
    }

    page := &Page{}
    for _, p := range products {
        // N additional calls!
        price, _ := s.pricingClient.GetPrice(ctx, p.ID)
        inventory, _ := s.inventoryClient.GetCount(ctx, p.ID)
        ratings, _ := s.reviewClient.GetAverageRating(ctx, p.ID)

        page.Products = append(page.Products, ProductDisplay{
            Product:   p,
            Price:     price,
            InStock:   inventory > 0,
            Rating:    ratings,
        })
    }
    return page, nil
}

// Better: batch calls or use a BFF that aggregates
func (s *ProductListingService) GetListingPage(ctx context.Context, categoryID string) (*Page, error) {
    products, err := s.productClient.ListByCategory(ctx, categoryID)
    if err != nil {
        return nil, err
    }

    ids := extractIDs(products)

    // Parallel batch requests
    var (
        prices    map[string]Price
        inventory map[string]int
        ratings   map[string]float64
        g, gCtx = errgroup.WithContext(ctx)
    )

    g.Go(func() error {
        var err error
        prices, err = s.pricingClient.BatchGetPrices(gCtx, ids)
        return err
    })
    g.Go(func() error {
        var err error
        inventory, err = s.inventoryClient.BatchGetCounts(gCtx, ids)
        return err
    })
    g.Go(func() error {
        var err error
        ratings, err = s.reviewClient.BatchGetRatings(gCtx, ids)
        return err
    })

    if err := g.Wait(); err != nil {
        return nil, err
    }

    // Assemble from pre-fetched data
    page := &Page{}
    for _, p := range products {
        page.Products = append(page.Products, ProductDisplay{
            Product:  p,
            Price:    prices[p.ID],
            InStock:  inventory[p.ID] > 0,
            Rating:   ratings[p.ID],
        })
    }
    return page, nil
}
```

### Anti-Pattern 3: Synchronous Chains Without Timeouts

Synchronous call chains propagate latency amplification: a 100ms timeout at each of five hops compounds to a worst-case 500ms response time even before accounting for retries. The following code shows how to apply `context.WithTimeout` at every service boundary and propagate cancellation so that upstream timeouts immediately abort in-flight downstream work.

```go
package antipatterns

import (
    "context"
    "errors"
    "fmt"
    "net/http"
    "sync"
    "time"
)

type ServiceA struct{}

func (s *ServiceA) callServiceB(ctx context.Context) error { return nil }
func mustGetDeadline(ctx context.Context) time.Time {
    if d, ok := ctx.Deadline(); ok {
        return d
    }
    return time.Now().Add(30 * time.Second)
}

// Synchronous chain: A→B→C→D with timeouts that don't cascade correctly

// Wrong: each service has same timeout
const timeout = 30 * time.Second

// ServiceA timeout: 30s
// ServiceB timeout: 30s
// ServiceC timeout: 30s
// If C takes 29s, B waits 30s, A waits 30s = 87 seconds total user wait!

// Correct: cascading timeouts (each downstream has less time than upstream)
func (s *ServiceA) HandleRequest(r *http.Request) {
    // Propagate deadline from incoming request context
    ctx := r.Context()
    remaining := time.Until(mustGetDeadline(ctx))

    // Give downstream 80% of remaining time
    downstreamTimeout := time.Duration(float64(remaining) * 0.8)
    downstreamCtx, cancel := context.WithTimeout(ctx, downstreamTimeout)
    defer cancel()

    if err := s.callServiceB(downstreamCtx); err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            // ServiceB timed out - respond with 504
        }
    }
}

// Circuit breaker prevents cascading failures
type CircuitBreaker struct {
    mu            sync.Mutex
    state         string // "closed", "open", "half-open"
    failureCount  int
    lastFailure   time.Time
    threshold     int
    resetTimeout  time.Duration
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    state := cb.state
    cb.mu.Unlock()

    switch state {
    case "open":
        // Check if reset timeout has elapsed
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.mu.Lock()
            cb.state = "half-open"
            cb.mu.Unlock()
            // Fall through to execute
        } else {
            return fmt.Errorf("circuit breaker open - fast fail")
        }
    case "half-open":
        // Allow one test request through
    }

    err := fn()

    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failureCount++
        cb.lastFailure = time.Now()
        if cb.failureCount >= cb.threshold || cb.state == "half-open" {
            cb.state = "open"
        }
    } else {
        cb.state = "closed"
        cb.failureCount = 0
    }

    return err
}
```

### Anti-Pattern 4: Missing Backpressure

A service that accepts requests faster than it can process them will queue work indefinitely until it exhausts memory or crashes, rather than signaling overload to callers. The following implementation adds a bounded channel as an admission queue and returns HTTP 429 with a `Retry-After` header when the queue is full, protecting the service while giving clients actionable feedback.

```go
package antipatterns

import (
    "context"
    "fmt"
    "sync"
)

type Job struct {
    ID string
}

func processJob(j Job) {}

// Missing backpressure: producer faster than consumer, queues fill, OOM

// Wrong: unbounded queue
func StartWorker(jobs <-chan Job) {
    go func() {
        for job := range jobs {
            // If processing is slow, jobs channel fills in memory
            processJob(job)
        }
    }()
}

// Correct: bounded queue with backpressure
func StartWorkerPool(ctx context.Context, workers int) (chan<- Job, error) {
    jobs := make(chan Job, workers*2) // Bounded buffer
    var wg sync.WaitGroup

    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case job, ok := <-jobs:
                    if !ok {
                        return
                    }
                    processJob(job)
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    go func() {
        <-ctx.Done()
        close(jobs)
        wg.Wait()
    }()

    return jobs, nil
}

// Caller respects backpressure
func submitJob(ctx context.Context, jobs chan<- Job, job Job) error {
    select {
    case jobs <- job:
        return nil // Job accepted
    case <-ctx.Done():
        return ctx.Err() // Context canceled
    default:
        // Non-blocking check - queue full, apply backpressure to caller
        return fmt.Errorf("worker queue full (backpressure)")
    }
}
```

### Junior → FAANG: Recognizing Anti-Patterns in Code Review

Anti-patterns are most valuable as a code review checklist. When reviewing a pull request for a distributed service, ask four questions corresponding to the four anti-patterns in this section: (1) does this change add a synchronous dependency that was previously async? (2) does this handler make N calls where one batched call would work? (3) does every outbound call have a timeout configured? (4) does every queue or channel have a bounded size?

Asking these questions in code review, and linking to the explanation when you catch an issue, builds both your credibility and your team's distributed systems literacy faster than any internal tech talk.

For FAANG interviews, the chatty service anti-pattern is frequently tested in system design. When an interviewer asks "how would you build a product listing page that aggregates data from inventory, pricing, and reviews?", the expected answer includes batched parallel requests with `errgroup`, not sequential single-item RPCs. Candidates who describe the N+1 approach without recognizing the problem demonstrate a gap that FAANG interviewers consistently flag.

The distributed monolith is the most important anti-pattern to understand for architecture discussions because it is the most common failure mode of "microservices" migrations that did not go well.

### Senior @ FAANG: Anti-Patterns as Organizational Signals

Each anti-pattern in this section is not just a technical problem: it is an organizational signal. Distributed monoliths do not emerge from technical mistakes alone. They emerge when team boundaries do not match service boundaries, when database ownership is not clear, or when "independence" was declared in the org chart before it was earned in the codebase.

**Anti-pattern audits as a quarterly practice.** Staff engineers at FAANG-scale organizations periodically audit the service graph for the four anti-patterns described here, using automated tooling where possible. Distributed monolith detection can be partially automated: identify services with shared database schemas (schema ownership graph), services that cannot be deployed without other services (deployment dependency graph), and synchronous call chains longer than three hops (service mesh telemetry). These graphs, produced from existing infrastructure data, surface distributed monoliths without requiring manual code review.

**Backpressure as a first-class SLO dimension.** A service without backpressure has an implicit availability SLO of "we don't know": under sufficiently high load, it will fail in an uncontrolled way. A service with backpressure has a degradation curve: at 80% capacity it starts returning 429s, at 100% capacity all requests are rejected, but the service itself remains stable and recoverable. The backpressure-aware service has a predictable failure mode. Staff engineers frame this as an SLO requirement: "the service must remain stable (no OOM, no process crash) at up to 200% of expected peak load." Backpressure is the mechanism that makes this SLO achievable.

**Chatty service as a latency SLO violation waiting to happen.** A service that makes N sequential RPCs to build a response has a P99 latency that is the sum of N individual P99 latencies. At FAANG scale, where P99 of any single RPC might be 50ms and N might be 20, the result is a 1000ms P99 for the aggregating service: a 1-second page load that is entirely avoidable. Staff engineers frame chatty service anti-patterns in terms of their latency SLO impact, which makes the refactoring investment concrete and defensible in planning discussions. The batching approach described in this section is not just cleaner code: it is a 20x reduction in worst-case latency for the common case.

**Cascading timeout budgets as a platform constraint.** The synchronous chain anti-pattern is best addressed at the platform level, not the service level. When services use a shared HTTP client library (as they do at FAANG), the library can enforce cascading timeout budgets automatically: if the incoming request context has a deadline, the outbound request context gets at most 80% of the remaining budget. This behavior is the correct default. Services that need to override it can do so explicitly, which makes the override visible in code review rather than the default being unsafe.

---
