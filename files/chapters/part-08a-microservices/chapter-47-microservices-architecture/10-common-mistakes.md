## 47.8 Common Mistakes

### Mistake 1: Distributed Monolith

A distributed monolith makes synchronous calls to every collaborating service before returning a response, meaning if any single downstream is slow or down the entire operation fails, and worse, side effects like a payment charge may already have occurred. The fix introduces a pending-order pattern: the service persists the order immediately, starts an asynchronous saga, and returns, and callers then poll or subscribe to status updates. This decoupling is the essential trade-off that separates genuine microservices from services that are merely separately deployed modules of the same monolith.

```go
// WRONG: Services are tightly coupled - changing one requires changing others
type OrderService struct {
    userClient     *UserServiceClient     // Direct sync call
    inventoryClient *InventoryServiceClient // Direct sync call
    paymentClient   *PaymentServiceClient   // Direct sync call
    shippingClient  *ShippingServiceClient  // Direct sync call
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // All these calls must succeed - tight coupling
    user, err := s.userClient.GetUser(ctx, req.UserID)
    if err != nil {
        return nil, err // If user service is down, order service is down
    }

    available, err := s.inventoryClient.CheckStock(ctx, req.Items)
    if err != nil {
        return nil, err // If inventory service is down, order service is down
    }

    // This is a distributed monolith - not true microservices
    payment, err := s.paymentClient.Charge(ctx, user.PaymentMethod, req.Total)
    if err != nil {
        return nil, err
    }

    _, err = s.shippingClient.Schedule(ctx, req.ShippingAddress)
    if err != nil {
        // What about the payment we already made?
        return nil, err
    }

    return &Order{/* ... */}, nil
}

// CORRECT: Use async communication and sagas for loose coupling
type OrderServiceFixed struct {
    db        OrderRepository
    publisher EventPublisher
    saga      *OrderSaga
}

func (s *OrderServiceFixed) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Create order in pending state
    order := &Order{
        ID:     uuid.New().String(),
        Status: OrderStatusPending,
        UserID: req.UserID,
        Items:  req.Items,
    }

    if err := s.db.Save(ctx, order); err != nil {
        return nil, err
    }

    // Start saga for async processing
    if err := s.saga.Start(ctx, order); err != nil {
        return nil, err
    }

    // Return immediately - order will be processed asynchronously
    return order, nil
}

// Client can poll or subscribe to order status updates
func (s *OrderServiceFixed) GetOrderStatus(ctx context.Context, orderID string) (*OrderStatus, error) {
    return s.db.GetStatus(ctx, orderID)
}
```

### Mistake 2: Shared Database

Sharing a database across services creates an invisible coupling layer: any schema migration must be coordinated across all services simultaneously, and a runaway query from one service can starve another. The correct approach gives each service its own `*sql.DB` connection pool and its own schema. When the Order service needs user data it makes an explicit API call, and it stores only the minimal fields it needs (like `CustomerEmail`) as a denormalized local copy. This denormalization is deliberate, accepting eventual consistency in exchange for operational independence.

```go
// WRONG: Multiple services access the same database
// This creates tight coupling and prevents independent scaling

// User Service
type UserService struct {
    db *sql.DB // Shared database connection
}

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    return s.db.QueryRow("SELECT * FROM users WHERE id = ?", id).Scan(...)
}

// Order Service - SAME database!
type OrderService struct {
    db *sql.DB // Same shared database!
}

func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Directly accessing users table - violates service boundary!
    var user User
    s.db.QueryRow("SELECT * FROM users WHERE id = ?", req.UserID).Scan(&user)

    // Joining across service boundaries
    s.db.Query(`
        SELECT o.*, u.email
        FROM orders o
        JOIN users u ON o.user_id = u.id
    `)
}

// CORRECT: Each service owns its data
type UserServiceFixed struct {
    db *sql.DB // User service's own database
}

type OrderServiceFixed struct {
    db         *sql.DB // Order service's own database
    userClient UserServiceClient // API call for user data
}

func (s *OrderServiceFixed) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    // Get user info via API - respects service boundary
    user, err := s.userClient.GetUser(ctx, req.UserID)
    if err != nil {
        return nil, fmt.Errorf("get user: %w", err)
    }

    // Store only the reference we need (denormalized)
    order := &Order{
        ID:            uuid.New().String(),
        CustomerID:    user.ID,
        CustomerEmail: user.Email, // Cached/denormalized
        Items:         req.Items,
    }

    return order, s.db.Save(ctx, order)
}
```

### Mistake 3: Synchronous Chains

Synchronous call chains compound latency: if A calls B which calls C which calls D, the end-to-end latency is additive, and any single link's failure propagates immediately to the caller. The fix uses `errgroup.WithContext` to fire independent calls to B and C in parallel Go goroutines, halving latency when the two calls are not data-dependent, then publishes an event for work that doesn't require an immediate response. This approach keeps the call graph shallow and avoids the fan-out fragility that makes deep chains operationally dangerous.

```go
// WRONG: Long synchronous call chains
// A -> B -> C -> D -> E
// Latency adds up, single failure breaks everything

func (s *ServiceA) HandleRequest(ctx context.Context) error {
    // 50ms
    respB, err := s.serviceB.Call(ctx)
    if err != nil {
        return err
    }

    // B calls C (another 50ms)
    // C calls D (another 50ms)
    // D calls E (another 50ms)
    // Total: 200ms minimum, any failure breaks the chain

    return nil
}

// CORRECT: Limit call depth, use async where possible
func (s *ServiceAFixed) HandleRequest(ctx context.Context) error {
    // Call services in parallel when possible
    g, ctx := errgroup.WithContext(ctx)

    var respB *ResponseB
    var respC *ResponseC

    g.Go(func() error {
        var err error
        respB, err = s.serviceB.Call(ctx)
        return err
    })

    g.Go(func() error {
        var err error
        respC, err = s.serviceC.Call(ctx)
        return err
    })

    if err := g.Wait(); err != nil {
        return err
    }

    // Or use events for truly async flows
    s.publisher.Publish(ctx, "request.received", RequestEvent{...})
    return nil // Return immediately
}
```

### Mistake 4: Not Handling Partial Failures

Without partial-failure handling, a shipping error leaves inventory reserved and the customer's card charged with no order record, a consistency nightmare that requires manual intervention to unwind. The correct pattern uses a saga: each step defines a compensating action (release inventory, issue refund), and when any step fails the orchestrator executes compensations in reverse order. Because compensations must be idempotent, they are safe to retry if the compensation itself encounters a transient error.

```go
// WRONG: Assuming all-or-nothing semantics
func (s *OrderService) ProcessOrder(ctx context.Context, order *Order) error {
    // No handling of partial failures
    if err := s.inventoryService.Reserve(ctx, order.Items); err != nil {
        return err
    }

    if err := s.paymentService.Charge(ctx, order.PaymentMethod, order.Total); err != nil {
        // Inventory was reserved but payment failed!
        // We need to release inventory
        return err
    }

    if err := s.shippingService.Schedule(ctx, order.ShippingAddress); err != nil {
        // Inventory reserved, payment charged, but shipping failed!
        return err
    }

    return nil
}

// CORRECT: Handle partial failures with compensating transactions
func (s *OrderServiceFixed) ProcessOrder(ctx context.Context, order *Order) error {
    var reservationID, paymentID string
    var err error

    // Step 1: Reserve inventory
    reservationID, err = s.inventoryService.Reserve(ctx, order.Items)
    if err != nil {
        return fmt.Errorf("reserve inventory: %w", err)
    }

    // Cleanup function in case of later failure
    defer func() {
        if err != nil && reservationID != "" {
            // Compensating transaction: release inventory
            if releaseErr := s.inventoryService.Release(ctx, reservationID); releaseErr != nil {
                slog.Error("failed to release inventory",
                    "reservation_id", reservationID,
                    "error", releaseErr)
            }
        }
    }()

    // Step 2: Process payment
    paymentID, err = s.paymentService.Charge(ctx, order.PaymentMethod, order.Total)
    if err != nil {
        return fmt.Errorf("process payment: %w", err)
    }

    defer func() {
        if err != nil && paymentID != "" {
            // Compensating transaction: refund payment
            if refundErr := s.paymentService.Refund(ctx, paymentID); refundErr != nil {
                slog.Error("failed to refund payment",
                    "payment_id", paymentID,
                    "error", refundErr)
                // Alert for manual intervention
                s.alerter.Alert("MANUAL_REFUND_REQUIRED", paymentID)
            }
        }
    }()

    // Step 3: Schedule shipping
    _, err = s.shippingService.Schedule(ctx, order.ShippingAddress)
    if err != nil {
        return fmt.Errorf("schedule shipping: %w", err)
    }

    return nil
}
```

### Mistake 5: Chatty Interfaces

Chatty interfaces issue many fine-grained API calls to assemble a single response, turning network latency into a multiplicative cost. In the wrong example below, ten separate HTTP or gRPC calls are needed to build a user report, each adds round-trip latency and increases the probability that at least one call fails. The fix consolidates related data behind coarse-grained endpoints (`GetUserSummary`) that return composite objects in a single call, or uses GraphQL to let callers specify exactly the data they need in one request.

```go
// WRONG: Too many fine-grained calls
func (s *ReportService) GenerateUserReport(ctx context.Context, userID string) (*Report, error) {
    // 10 separate API calls!
    user, _ := s.userClient.GetUser(ctx, userID)
    profile, _ := s.userClient.GetProfile(ctx, userID)
    preferences, _ := s.userClient.GetPreferences(ctx, userID)
    orders, _ := s.orderClient.GetOrders(ctx, userID)
    payments, _ := s.paymentClient.GetPaymentHistory(ctx, userID)
    addresses, _ := s.userClient.GetAddresses(ctx, userID)
    reviews, _ := s.reviewClient.GetReviews(ctx, userID)
    wishlist, _ := s.catalogClient.GetWishlist(ctx, userID)
    recommendations, _ := s.recommendClient.GetRecommendations(ctx, userID)
    notifications, _ := s.notificationClient.GetPreferences(ctx, userID)

    // N+1 problem: network latency for each call
    return buildReport(user, profile, preferences, /*...*/)
}

// CORRECT: Coarse-grained APIs with batch operations
type UserServiceClient interface {
    // Single call returns all user-related data
    GetUserSummary(ctx context.Context, userID string) (*UserSummary, error)

    // Batch operation for multiple users
    GetUserSummaries(ctx context.Context, userIDs []string) ([]*UserSummary, error)
}

// Backend service implements efficient batch retrieval
func (s *UserService) GetUserSummary(ctx context.Context, userID string) (*UserSummary, error) {
    // Single database query with JOIN or multiple indexed queries
    return s.db.GetUserWithRelatedData(ctx, userID)
}

// Or use GraphQL for flexible data fetching
type GraphQLClient interface {
    Query(ctx context.Context, query string, variables map[string]any, result any) error
}

func (s *ReportServiceFixed) GenerateUserReport(ctx context.Context, userID string) (*Report, error) {
    var result UserReportData

    // Single GraphQL query for all needed data
    err := s.graphql.Query(ctx, `
        query UserReport($id: ID!) {
            user(id: $id) {
                id name email
                profile { ... }
                orders(limit: 10) { ... }
                reviews { ... }
            }
        }
    `, map[string]any{"id": userID}, &result)

    if err != nil {
        return nil, err
    }

    return buildReport(result)
}
```

### Junior → FAANG: Recognizing Mistakes in Code Review and Interviews

The five mistakes in this section are the most common patterns that appear in code review feedback at early-career FAANG levels. Learning to recognize them before writing them is a significant career accelerator.

Distributed monolith recognition: the tell is a long synchronous call chain in a single request handler. If you see a function that calls four or five external services before returning, that is a distributed monolith pattern. In a code review, the comment is not "make this async" but "what is the failure behavior if service C is down, and is the user waiting for all five of these?" If the answer is "yes, the user waits for all five and sees an error if any fails," the design needs rethinking.

Shared database recognition: in Go, the tell is two services importing the same database connection string or the same ORM model package. If you find `UserModel` defined in a `shared` package imported by both the User service and the Order service, that is a shared database smell. The fix is duplication with intent: the Order service defines its own `CustomerRef` type with only the fields it needs.

Synchronous chain recognition: look for nested calls where the depth exceeds two or three. In Go, a function that calls `serviceB.Call()` and inside that implementation calls `serviceC.Call()` is a chain. The interview test: "what is the total timeout for this operation?" If the answer requires adding timeouts at each layer, the chain is too deep.

Partial failure recognition: look for sequences of external calls in a single function with no compensating actions on error. If `inventoryService.Reserve()` succeeds and then `paymentService.Charge()` fails, what happens to the inventory reservation? If the answer is "it leaks," the code needs a compensation path.

Chatty interface recognition: N+1 calls in a loop. If you see a `for range orders` loop that calls `userService.GetUser()` inside, that is an N+1 pattern. The fix is batch fetching: collect all user IDs from the orders, call `GetUserSummaries(userIDs)` once, then join in memory.

### Senior @ FAANG: Systematic Code Review for Distributed Systems Correctness

At L6/L7, code review in a microservices codebase requires a checklist that goes beyond "does this compile and follow style." The five mistakes in this section map to a set of review questions that should be asked on every inter-service boundary change.

**Distributed monolith review checklist.** For every function that calls an external service: (a) is this call on the critical path of a user-facing request? (b) if this downstream is degraded (200ms p99 instead of 10ms), what does the user experience? (c) is there a circuit breaker? (d) is there a fallback behavior if the circuit is open? (e) is this the only service this function calls synchronously, or is there a chain? For chains longer than two, the review comment is: "consider making step N+1 async or pre-fetching data ahead of time."

**Data boundary review.** For every new field added to a service's public API: does any consumer read this field from the database directly rather than through the API? Grep the codebase for the column name. For every new database migration: which services import this service's database DSN or ORM models? If the answer is "other services," that is a blocker.

**Saga correctness review.** For every multi-step operation that touches more than one service's data: (a) is there a compensating transaction for every step? (b) is every step idempotent (safe to execute twice)? (c) is every compensation idempotent? (d) what is the dead-letter strategy if a compensation fails permanently? (e) is the saga state persisted durably, or does it live only in memory? In-memory saga state that is lost on pod restart is a correctness bug, not a performance issue.

**Chatty interface review.** For every new gRPC or HTTP call added to a handler, check the caller's loop context. Is this call inside a `for range` or a goroutine fan-out? If yes, is there a batch equivalent? If the service does not expose a batch endpoint, is this the right time to add one? The review comment pattern: "this will issue N calls for N items. Can we add `GetUserSummaries([]string)` to avoid this?"

**Observability review.** For every new inter-service call: (a) is the caller's context propagated (for trace correlation)? (b) is there a metric increment on error? (c) is the latency recorded? (d) does the error log include the upstream service name and the correlation ID? Missing observability on a new call is a correctness issue in a distributed system, because without it you cannot diagnose production incidents.

---
