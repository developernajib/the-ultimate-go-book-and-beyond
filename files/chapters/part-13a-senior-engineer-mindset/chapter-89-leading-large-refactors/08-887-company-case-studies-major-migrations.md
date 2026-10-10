## 89.7 Company Case Studies: Major Migrations

### Google's Monorepo Migrations

Google operates one of the world's largest monorepos, and migrations at this scale are legendary:

```
GOOGLE'S LARGE-SCALE CHANGES (LSCs):

Google has specialized tooling and processes for migrations
that touch thousands of files:

1. ROSIE (Large-Scale Change System)
   - Automated tool for making bulk code changes
   - Creates individual CLs (changelists) per project
   - Auto-assigns to appropriate reviewers
   - Handles the coordination complexity

2. LSC PROCESS:
   ┌─────────────────────────────────────────────────────────────┐
   │  PHASE 1: PREPARATION                                       │
   │  - Write migration tool/script                              │
   │  - Create codemod (automated transformation)                │
   │  - Test on sample of codebase                               │
   │  - Get approval from language/API team                      │
   │                                                             │
   │  PHASE 2: SPLIT INTO SHARDS                                 │
   │  - Break into per-project changes                           │
   │  - Each shard is independently reviewable                   │
   │  - Usually 50-200 files per shard                           │
   │                                                             │
   │  PHASE 3: AUTOMATED REVIEW                                  │
   │  - Static analysis checks                                   │
   │  - Build verification                                       │
   │  - Test suite execution                                     │
   │                                                             │
   │  PHASE 4: HUMAN REVIEW                                      │
   │  - Rosie assigns to OWNERS of each directory                │
   │  - Standard review process                                  │
   │  - Can approve in bulk if change is mechanical              │
   │                                                             │
   │  PHASE 5: SUBMIT                                            │
   │  - Automatic submission when approved                       │
   │  - Rollback capability if issues found                      │
   └─────────────────────────────────────────────────────────────┘

3. SCALE EXAMPLES:
   - Go 1 release: 600K+ files modified
   - API deprecations: 10K+ callsites updated
   - Security fixes: rolled out in hours across all of Google
```

```go
// Example: Google-style codemod for error handling migration

package migration

import (
    "go/ast"
    "go/token"

    "golang.org/x/tools/go/ast/astutil"
)

// MigrateErrorHandling transforms old error handling to new pattern
// Old: if err != nil { return err }
// New: if err != nil { return fmt.Errorf("context: %w", err) }
type ErrorHandlingMigration struct {
    fset    *token.FileSet
    changes []Change
}

func (m *ErrorHandlingMigration) Visit(node ast.Node) ast.Visitor {
    ifStmt, ok := node.(*ast.IfStmt)
    if !ok {
        return m
    }

    // Check if this is: if err != nil { return err }
    if !m.isSimpleErrorReturn(ifStmt) {
        return m
    }

    // Get the enclosing function name for context
    funcName := m.getEnclosingFuncName(node)

    // Record the change
    m.changes = append(m.changes, Change{
        Position: m.fset.Position(ifStmt.Pos()),
        Old:      "return err",
        New:      fmt.Sprintf(`return fmt.Errorf("%s: %%w", err)`, funcName),
    })

    return m
}

// Apply changes across entire codebase
func RunMigration(patterns []string) (*MigrationResult, error) {
    result := &MigrationResult{}

    for _, pattern := range patterns {
        files, _ := filepath.Glob(pattern)
        for _, file := range files {
            changes, err := MigrateFile(file)
            if err != nil {
                result.Errors = append(result.Errors, err)
                continue
            }
            result.Changes = append(result.Changes, changes...)
        }
    }

    return result, nil
}

// At Google scale:
// - Pattern matches 500K+ Go files
// - Resulting in 50K+ individual CLs
// - Reviewed by 5K+ engineers
// - Completed over 6 months
```

### Amazon's Microservice Decomposition

Amazon's famous migration from monolith to microservices:

```
AMAZON'S MONOLITH DECOMPOSITION STORY:

Early 2000s: amazon.com was a monolith called "Obidos"
- Single massive codebase
- Deployments took hours
- Scaling was expensive
- Teams blocked each other

THE MIGRATION (2001-2004):
1. Identified service boundaries along team/domain lines
2. Extracted services one at a time
3. Strangler fig pattern (facade in front of monolith)
4. Eventually deleted monolith code

LESSONS LEARNED:
┌─────────────────────────────────────────────────────────────────┐
│  1. TWO-PIZZA TEAMS                                             │
│     Services owned by teams small enough to feed with 2 pizzas  │
│     ~6-8 engineers per service                                  │
│                                                                 │
│  2. "YOU BUILD IT, YOU RUN IT"                                  │
│     Teams own their service end-to-end                          │
│     Operational ownership drives good design                    │
│                                                                 │
│  3. API-FIRST                                                   │
│     All communication through well-defined APIs                 │
│     No direct database access across services                   │
│                                                                 │
│  4. CELL-BASED ARCHITECTURE                                     │
│     Services deployed in independent cells                      │
│     Blast radius contained                                      │
│     Gradual rollouts possible                                   │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Example: Amazon-style service extraction pattern

package extraction

// Phase 1: Identify the boundary
// The Order domain is extracted from the monolith

// BEFORE: In monolith
type MonolithOrderHandler struct {
    db       *sql.DB  // Shared database
    paymentClient  *PaymentService
    inventoryClient *InventoryService
}

func (h *MonolithOrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    // All logic in one place
    // Direct DB access
    // Tight coupling
}

// Phase 2: Create internal API interface
type OrderService interface {
    CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error)
    GetOrder(ctx context.Context, id string) (*Order, error)
    CancelOrder(ctx context.Context, id string) error
}

// Phase 3: Implement facade that can route to old or new
type OrderServiceFacade struct {
    monolith    OrderService  // Old implementation
    microservice OrderService  // New implementation
    router      *TrafficRouter
}

func (f *OrderServiceFacade) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Route based on configuration or percentage
    if f.router.UseNewService(ctx, "order.create") {
        return f.microservice.CreateOrder(ctx, req)
    }
    return f.monolith.CreateOrder(ctx, req)
}

// Phase 4: New microservice implementation
type OrderMicroservice struct {
    db          *OrderDB         // Own database
    eventBus    *EventBus        // Async communication
    paymentAPI  *PaymentClient   // HTTP/gRPC clients
    inventoryAPI *InventoryClient
}

func (s *OrderMicroservice) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Own database, own schema
    order, err := s.db.Create(ctx, req)
    if err != nil {
        return nil, err
    }

    // Communicate via events (decoupled)
    s.eventBus.Publish(ctx, &OrderCreatedEvent{Order: order})

    return order, nil
}

// Phase 5: Gradual traffic migration
// Week 1: 1% to new service
// Week 2: 10% to new service
// Week 4: 50% to new service
// Week 6: 100% to new service
// Week 8: Remove monolith order code
```

### Uber's Architecture Evolution

Uber's journey from monolith to microservices to domain-oriented architecture:

```
UBER'S ARCHITECTURE EVOLUTION:

2014: MONOLITH ERA
- Single Python application
- Worked for first 100 engineers
- Deployments: multiple times per day

2015-2018: MICROSERVICES ERA
- Broke into ~3000 microservices
- Teams could deploy independently
- But: service mesh complexity exploded
- Call graphs became impossible to understand

2020+: DOMAIN-ORIENTED MICROSERVICES (DOMA)
- Group microservices into domains
- Each domain has gateway + internal services
- Domains communicate via well-defined interfaces
- Reduced cross-team dependencies

DOMA MIGRATION PROCESS:
┌─────────────────────────────────────────────────────────────────┐
│  1. IDENTIFY DOMAINS                                            │
│     Group related services by business capability               │
│     ~50 domains from 3000 services                              │
│                                                                 │
│  2. DEFINE DOMAIN INTERFACES                                    │
│     Each domain exposes public API                              │
│     Internal services hidden behind gateway                     │
│                                                                 │
│  3. MIGRATE INCREMENTALLY                                       │
│     Start with stable, well-understood domains                  │
│     Leave complex domains for later                             │
│                                                                 │
│  4. ENFORCE BOUNDARIES                                          │
│     Tooling prevents direct service-to-service calls            │
│     All cross-domain traffic through gateways                   │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Example: Uber DOMA pattern

package doma

// Domain Gateway: Single entry point for a domain
type RidesDomainGateway struct {
    // Internal services (not exposed)
    matchingService    *MatchingService
    pricingService     *PricingService
    dispatchService    *DispatchService

    // Domain's own data store
    ridesDB *RidesDatabase
}

// Public interface: Other domains only see this
type RidesDomainAPI interface {
    RequestRide(ctx context.Context, req *RideRequest) (*Ride, error)
    GetRide(ctx context.Context, id string) (*Ride, error)
    CancelRide(ctx context.Context, id string) error

    // Events published by this domain
    SubscribeToRideEvents(handler RideEventHandler) error
}

func (g *RidesDomainGateway) RequestRide(ctx context.Context, req *RideRequest) (*Ride, error) {
    // Orchestrate internal services
    // But external callers don't know about this

    // 1. Get pricing (internal)
    price, err := g.pricingService.Calculate(ctx, req.Origin, req.Destination)
    if err != nil {
        return nil, fmt.Errorf("calculate price: %w", err)
    }

    // 2. Find driver (internal)
    driver, err := g.matchingService.FindDriver(ctx, req.Origin, req.RideType)
    if err != nil {
        return nil, fmt.Errorf("find driver: %w", err)
    }

    // 3. Dispatch (internal)
    ride, err := g.dispatchService.Dispatch(ctx, req, driver, price)
    if err != nil {
        return nil, fmt.Errorf("dispatch: %w", err)
    }

    return ride, nil
}

// Other domains (e.g., Payments) call through gateway only
type PaymentsDomain struct {
    ridesAPI RidesDomainAPI  // Interface, not implementation
}

func (p *PaymentsDomain) ProcessRidePayment(ctx context.Context, rideID string) error {
    // Can only use public API
    ride, err := p.ridesAPI.GetRide(ctx, rideID)
    if err != nil {
        return err
    }
    // Process payment...
    return nil
}
```

### Netflix's Migration Patterns

Netflix's approach to continuous migration:

```
NETFLIX'S MIGRATION PHILOSOPHY:

1. "CONTINUOUSLY MIGRATE"
   - Treat migration as ongoing process, not project
   - Always be improving architecture
   - Small, frequent changes over big bang

2. MIGRATION TECHNIQUES:
   ┌────────────────────────────────────────────────────────────┐
   │  TECHNIQUE         USE CASE                                │
   │  ────────────────────────────────────────────────────────  │
   │  Blue-Green        Stateless services                      │
   │  Canary            Risky changes, need gradual rollout     │
   │  Shadow Traffic    Validation before real traffic          │
   │  Sticky Canary     Stateful services (user sees one ver)   │
   └────────────────────────────────────────────────────────────┘

3. ZUUL (API GATEWAY) FOR MIGRATIONS:
   - Route traffic based on any criteria
   - Percentage-based rollouts
   - Instant rollback capability
   - A/B testing built-in
```

```go
// Example: Netflix-style migration with Zuul patterns

package migration

// Zuul-inspired traffic routing for migrations
type MigrationRouter struct {
    oldService    Service
    newService    Service
    config        *MigrationConfig
    metrics       *MigrationMetrics
}

type MigrationConfig struct {
    Enabled        bool
    Percentage     int     // 0-100
    StickySession  bool    // Same user always goes to same version
    ShadowTraffic  bool    // Send to both, return from old
    CompareResults bool    // Compare results if shadow
}

func (r *MigrationRouter) Route(ctx context.Context, req *Request) (*Response, error) {
    start := time.Now()

    if !r.config.Enabled {
        return r.oldService.Handle(ctx, req)
    }

    // Determine routing
    useNew := r.shouldUseNew(ctx, req)

    if r.config.ShadowTraffic {
        return r.handleShadow(ctx, req, useNew)
    }

    if useNew {
        resp, err := r.newService.Handle(ctx, req)
        r.metrics.RecordLatency("new", time.Since(start))
        if err != nil {
            r.metrics.RecordError("new", err)
        }
        return resp, err
    }

    resp, err := r.oldService.Handle(ctx, req)
    r.metrics.RecordLatency("old", time.Since(start))
    return resp, err
}

func (r *MigrationRouter) handleShadow(ctx context.Context, req *Request, useNew bool) (*Response, error) {
    // Send to both services
    var wg sync.WaitGroup
    var oldResp, newResp *Response
    var oldErr, newErr error

    wg.Add(2)
    go func() {
        defer wg.Done()
        oldResp, oldErr = r.oldService.Handle(ctx, req)
    }()
    go func() {
        defer wg.Done()
        newResp, newErr = r.newService.Handle(ctx, req)
    }()
    wg.Wait()

    // Compare results if configured
    if r.config.CompareResults && oldErr == nil && newErr == nil {
        if !r.compareResponses(oldResp, newResp) {
            r.metrics.RecordMismatch(req, oldResp, newResp)
            log.Warn("Response mismatch",
                "request", req.ID,
                "old", oldResp,
                "new", newResp,
            )
        }
    }

    // Always return old service response in shadow mode
    return oldResp, oldErr
}

// Sticky session routing (user always sees same version)
func (r *MigrationRouter) shouldUseNew(ctx context.Context, req *Request) bool {
    if r.config.StickySession {
        // Hash user ID to get consistent routing
        userID := getUserID(ctx)
        hash := xxhash.Sum64String(userID)
        return int(hash%100) < r.config.Percentage
    }

    // Random routing
    return rand.IntN(100) < r.config.Percentage
}
```

### Key Insights Across Companies

Across Google, Amazon, Uber, and Netflix, a consistent set of patterns emerges regardless of language, team size, or system type. The common thread is that successful migrations treat rollback as a first-class requirement rather than an afterthought. Every technique described above (Rosie shards, facade routing, domain gateways, Zuul percentages) exists specifically to make reverting a change cheaper than the cost of a failed deployment.

```
┌──────────────────────────────────────────────────────────────────┐
│          MIGRATION BEST PRACTICES FROM FAANG                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. STRANGLER FIG IS UNIVERSAL                                   │
│     Every company uses gradual migration patterns                │
│     Big bang is almost never the answer at scale                 │
│                                                                  │
│  2. INVEST IN TOOLING                                            │
│     Google: Rosie for LSCs                                       │
│     Netflix: Zuul for traffic management                         │
│     Uber: Domain gateways                                        │
│     Good tools make migration possible                           │
│                                                                  │
│  3. MEASURE EVERYTHING                                           │
│     Compare old vs new on every metric:                          │
│     - Latency                                                    │
│     - Error rate                                                 │
│     - Business metrics                                           │
│     - Resource usage                                             │
│                                                                  │
│  4. PLAN FOR ROLLBACK                                            │
│     Always have a way back                                       │
│     Test rollback before you need it                             │
│     Feature flags enable instant rollback                        │
│                                                                  │
│  5. COMMUNICATE OBSESSIVELY                                      │
│     Migrations affect everyone                                   │
│     Regular updates, clear timelines                             │
│     Make it easy for teams to track progress                     │
│                                                                  │
│  6. CLEAN UP THE OLD                                             │
│     Migration isn't done until old code is deleted               │
│     Set deadline for decommission                                │
│     Don't let "temporary" become permanent                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using Case Studies in Behavioral Answers

These case studies are interview ammunition. When asked about large-scale refactoring, referencing Google's Rosie pattern or Amazon's API-first service extraction shows breadth. But use case studies to frame your own experience, not as a substitute for it. "I used a similar strangler fig approach to what Amazon did, though at a much smaller scale: I extracted our notification service from our monolith over eight weeks" is far more compelling than "Amazon did this interesting thing."

### Senior @ FAANG: What Bar-Raisers Take from These Case Studies

The common thread across Google, Amazon, Uber, and Netflix is not the technical pattern. It is the organizational investment: dedicated migration teams, explicit roadmap allocation, tooling built specifically for the migration, and measured business outcomes. At L6, a bar-raiser is assessing whether you understand that a successful migration requires organizational design, not just technical skill. Your answer to "how did you resource this migration?" is as important as your answer to "what pattern did you use?"

The decommission point is where most migrations fail at scale. Google's Rosie works because the codemods run automatically and the CI gate rejects new violations. Without enforcement, teams always have something more urgent to do. If you are designing a migration for your org, the question to answer before you start is: what makes the old path unavailable? Feature flag expiry, CI enforcement, API deprecation with a hard sunset date. Without a forcing function, you will be maintaining dual systems indefinitely.

---
