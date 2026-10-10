## GraphQL in Go Pitfalls: When Flexibility Becomes a Vulnerability

### Pitfall 1: N+1 Query Explosion with Nested Resolvers

**Incident Report**: Product catalog API had 50ms latency for simple queries but 15 seconds for queries requesting products with categories. Each product triggered a separate database query to fetch its category.

```go
// WRONG: Naive resolver implementation
func (r *productResolver) Category(ctx context.Context, obj *model.Product) (*model.Category, error) {
    // Problem: Called once PER product in a list query
    // Query for 100 products = 100 category queries
    return r.DB.QueryRow("SELECT * FROM categories WHERE id = $1", obj.CategoryID).Scan(...)
}

// Resolver for Query.products
func (r *queryResolver) Products(ctx context.Context, first int) ([]*model.Product, error) {
    // 1 query for products
    products, _ := r.DB.Query("SELECT * FROM products LIMIT $1", first)
    return products, nil
    // Then N queries for categories via Category resolver
}

// CORRECT: Dataloader pattern for batched loading
type CategoryLoader struct {
    db    *sql.DB
    batch *dataloader.Loader
}

func NewCategoryLoader(db *sql.DB) *CategoryLoader {
    return &CategoryLoader{
        db: db,
        batch: dataloader.NewBatchedLoader(
            func(ctx context.Context, keys dataloader.Keys) []*dataloader.Result {
                // Batch all category IDs into single query
                ids := make([]string, len(keys))
                for i, key := range keys {
                    ids[i] = key.String()
                }

                rows, _ := db.QueryContext(ctx,
                    "SELECT id, name, description FROM categories WHERE id = ANY($1)",
                    pq.Array(ids))

                // Map results back to keys
                categoryMap := make(map[string]*model.Category)
                for rows.Next() {
                    var c model.Category
                    rows.Scan(&c.ID, &c.Name, &c.Description)
                    categoryMap[c.ID] = &c
                }

                results := make([]*dataloader.Result, len(keys))
                for i, key := range keys {
                    if cat, ok := categoryMap[key.String()]; ok {
                        results[i] = &dataloader.Result{Data: cat}
                    } else {
                        results[i] = &dataloader.Result{Error: errors.New("not found")}
                    }
                }
                return results
            },
            dataloader.WithWait(2*time.Millisecond),  // Batch window
            dataloader.WithBatchCapacity(100),
        ),
    }
}

func (r *productResolver) Category(ctx context.Context, obj *model.Product) (*model.Category, error) {
    // Now batched: 100 products = 1 category query
    loader := ctx.Value(categoryLoaderKey).(*CategoryLoader)
    thunk := loader.batch.Load(ctx, dataloader.StringKey(obj.CategoryID))
    result, err := thunk()
    if err != nil {
        return nil, err
    }
    return result.(*model.Category), nil
}
```

### Pitfall 2: Unbounded Query Depth Attack (DoS via Nested Queries)

**Incident Report**: GraphQL API went down after receiving queries with 50+ levels of nesting. A single malicious query consumed all server memory by requesting self-referential types recursively.

```graphql
# Malicious query exploiting unbounded depth
query AttackQuery {
  user(id: "1") {
    friends {
      friends {
        friends {
          friends {
            friends {
              # ... repeat 50 times
            }
          }
        }
      }
    }
  }
}
```

```go
// WRONG: No query depth or complexity limits
srv := handler.New(generated.NewExecutableSchema(cfg))
http.Handle("/graphql", srv)

// CORRECT: Multiple layers of protection
srv := handler.New(generated.NewExecutableSchema(cfg))

// Layer 1: Query depth limit
srv.Use(extension.FixedComplexityLimit(200))

// Layer 2: Custom complexity calculator
srv.AroundOperations(func(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
    oc := graphql.GetOperationContext(ctx)

    // Calculate query complexity
    complexity := calculateComplexity(oc)
    if complexity > 500 {
        graphql.AddError(ctx, &gqlerror.Error{
            Message: fmt.Sprintf("query complexity %d exceeds maximum 500", complexity),
        })
        return func(ctx context.Context) *graphql.Response {
            return graphql.ErrorResponse(ctx, "query too complex")
        }
    }

    return next(ctx)
})

// Layer 3: Query depth limit
func calculateDepth(selectionSet ast.SelectionSet, depth int) int {
    maxDepth := depth
    for _, selection := range selectionSet {
        switch s := selection.(type) {
        case *ast.Field:
            if s.SelectionSet != nil {
                childDepth := calculateDepth(s.SelectionSet, depth+1)
                if childDepth > maxDepth {
                    maxDepth = childDepth
                }
            }
        case *ast.InlineFragment:
            childDepth := calculateDepth(s.SelectionSet, depth)
            if childDepth > maxDepth {
                maxDepth = childDepth
            }
        }
    }
    return maxDepth
}

// Layer 4: Query timeout
srv.AroundOperations(func(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    return next(ctx)
})

// Layer 5: Per-IP rate limiting
type RateLimiter struct {
    limiter *rate.Limiter
}

srv.AroundOperations(func(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
    ip := getClientIP(ctx)
    if !rateLimiter.Allow(ip) {
        graphql.AddError(ctx, gqlerror.Errorf("rate limit exceeded"))
        return nil
    }
    return next(ctx)
})
```

### Pitfall 3: Subscription Memory Leak with Long-Running Connections

**Incident Report**: GraphQL server memory grew linearly over 24 hours. Subscriptions weren't being cleaned up when clients disconnected ungracefully (browser crash, network loss).

```go
// WRONG: No subscription cleanup
func (r *subscriptionResolver) MessageAdded(ctx context.Context, roomID string) (<-chan *model.Message, error) {
    ch := make(chan *model.Message, 10)

    // Problem: Goroutine runs forever if client disconnects
    go func() {
        for {
            msg := r.pubsub.Subscribe(roomID)
            ch <- msg  // Blocks forever if client gone
        }
    }()

    return ch, nil
}

// CORRECT: Proper subscription lifecycle management
type SubscriptionManager struct {
    subscriptions map[string]map[string]chan *model.Message  // room -> subID -> channel
    mu            sync.RWMutex
    metrics       *SubscriptionMetrics
}

func (r *subscriptionResolver) MessageAdded(ctx context.Context, roomID string) (<-chan *model.Message, error) {
    ch := make(chan *model.Message, 10)
    subID := uuid.New().String()

    // Register subscription
    r.subManager.Add(roomID, subID, ch)
    r.metrics.ActiveSubscriptions.Inc()

    // Background worker with context cancellation
    go func() {
        defer func() {
            r.subManager.Remove(roomID, subID)
            r.metrics.ActiveSubscriptions.Dec()
            close(ch)
        }()

        subscription := r.pubsub.Subscribe(roomID)
        defer subscription.Close()

        for {
            select {
            case <-ctx.Done():
                // Client disconnected or context canceled
                return
            case msg, ok := <-subscription.Channel():
                if !ok {
                    return
                }
                // Non-blocking send with timeout
                select {
                case ch <- msg:
                case <-time.After(5 * time.Second):
                    // Client too slow, close connection
                    r.metrics.SlowConsumerDrops.Inc()
                    return
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return ch, nil
}

// Health check: periodically clean stale subscriptions
func (m *SubscriptionManager) CleanStale() {
    m.mu.Lock()
    defer m.mu.Unlock()

    for room, subs := range m.subscriptions {
        for subID, ch := range subs {
            select {
            case ch <- nil:  // Test if channel is writable
                // Channel is alive, remove test message
                <-ch
            default:
                // Channel blocked, remove subscription
                delete(subs, subID)
            }
        }
        if len(subs) == 0 {
            delete(m.subscriptions, room)
        }
    }
}
```

### Pitfall 4: Authorization Bypass via Field-Level Access Control Gaps

**Incident Report**: Users could access other users' private data by requesting specific fields in nested queries. Authorization was only checked at the root query level.

```go
// WRONG: Authorization only at query level
func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
    currentUser := auth.UserFromContext(ctx)
    if currentUser.ID != id && !currentUser.IsAdmin {
        return nil, errors.New("unauthorized")
    }
    return r.DB.GetUser(id)
}

// Problem: Email field is accessible via friends query
// Even if user query is protected, this bypasses it:
// query { user(id: "me") { friends { email, ssn } } }
```

```graphql
# schema.graphql
type User {
  id: ID!
  name: String!
  email: String! @auth(requires: OWNER)
  ssn: String! @auth(requires: ADMIN)
  friends: [User!]!
}
```

```go
// Directive implementation
func AuthDirective(ctx context.Context, obj any, next graphql.Resolver, requires Role) (any, error) {
    currentUser := auth.UserFromContext(ctx)
    if currentUser == nil {
        return nil, errors.New("authentication required")
    }

    // Get the parent object to check ownership
    parent, ok := obj.(*model.User)
    if !ok {
        return nil, errors.New("invalid parent type")
    }

    switch requires {
    case RoleOwner:
        if currentUser.ID != parent.ID && !currentUser.IsAdmin {
            return nil, errors.New("access denied: owner only")
        }
    case RoleAdmin:
        if !currentUser.IsAdmin {
            return nil, errors.New("access denied: admin only")
        }
    }

    return next(ctx)
}

// Configuration
cfg := generated.Config{
    Resolvers: &Resolver{},
    Directives: generated.DirectiveRoot{
        Auth: AuthDirective,
    },
}

// Now every field access is checked, regardless of query path
```

### Pitfall 5: Schema Stitching Cache Poisoning

**Incident Report**: Federated GraphQL gateway returned incorrect data after a subgraph was updated. The gateway cached the old schema and was sending queries with fields that no longer existed.

```go
// WRONG: Static schema loading at startup
func main() {
    // Schema loaded once at startup
    productSchema, _ := loadSchema("http://products-service/graphql")
    userSchema, _ := loadSchema("http://users-service/graphql")

    gateway := stitchSchemas(productSchema, userSchema)

    http.ListenAndServe(":8080", gateway)
    // Problem: Schema changes in subgraphs are never picked up
}

// CORRECT: Dynamic schema refresh with validation
type SchemaRegistry struct {
    schemas    map[string]*graphql.Schema
    mu         sync.RWMutex
    httpClient *http.Client
    endpoints  []string
}

func NewSchemaRegistry(endpoints []string) *SchemaRegistry {
    registry := &SchemaRegistry{
        schemas:    make(map[string]*graphql.Schema),
        httpClient: &http.Client{Timeout: 10 * time.Second},
        endpoints:  endpoints,
    }

    // Initial load
    registry.refreshAll()

    // Periodic refresh with health checks
    go registry.watchForChanges()

    return registry
}

func (r *SchemaRegistry) watchForChanges() {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        for _, endpoint := range r.endpoints {
            newSchema, err := r.fetchSchema(endpoint)
            if err != nil {
                log.Printf("Failed to refresh schema from %s: %v", endpoint, err)
                continue
            }

            r.mu.RLock()
            oldSchema := r.schemas[endpoint]
            r.mu.RUnlock()

            if !schemasEqual(oldSchema, newSchema) {
                // Validate new schema before applying
                if err := r.validateCompatibility(oldSchema, newSchema); err != nil {
                    log.Printf("Schema incompatibility detected: %v", err)
                    // Alert, don't auto-apply breaking changes
                    continue
                }

                r.mu.Lock()
                r.schemas[endpoint] = newSchema
                r.mu.Unlock()

                r.rebuildGateway()
                log.Printf("Schema updated for %s", endpoint)
            }
        }
    }
}

func (r *SchemaRegistry) validateCompatibility(old, new *graphql.Schema) error {
    // Check for breaking changes
    breakingChanges := detectBreakingChanges(old, new)
    if len(breakingChanges) > 0 {
        return fmt.Errorf("breaking changes detected: %v", breakingChanges)
    }
    return nil
}

func detectBreakingChanges(old, new *graphql.Schema) []string {
    var changes []string

    // Check removed types
    for typeName := range old.TypeMap() {
        if _, exists := new.TypeMap()[typeName]; !exists {
            changes = append(changes, fmt.Sprintf("type %s removed", typeName))
        }
    }

    // Check removed fields
    for typeName, oldType := range old.TypeMap() {
        newType, exists := new.TypeMap()[typeName]
        if !exists {
            continue
        }

        oldFields := getFields(oldType)
        newFields := getFields(newType)

        for fieldName := range oldFields {
            if _, exists := newFields[fieldName]; !exists {
                changes = append(changes, fmt.Sprintf("field %s.%s removed", typeName, fieldName))
            }
        }
    }

    return changes
}
```

### Pitfall 6: Mutation Side Effects in Batched Operations

**Incident Report**: Batch mutation request partially succeeded but returned as complete failure. Some orders were created but the response indicated all failed, causing users to retry and create duplicate orders.

```go
// WRONG: All-or-nothing batch mutation
func (r *mutationResolver) CreateOrders(ctx context.Context, inputs []*model.OrderInput) ([]*model.Order, error) {
    var orders []*model.Order

    for _, input := range inputs {
        order, err := r.orderService.Create(ctx, input)
        if err != nil {
            // Problem: Previous orders already created, but error returned for whole batch
            return nil, fmt.Errorf("failed to create order: %w", err)
        }
        orders = append(orders, order)
    }

    return orders, nil
}

// CORRECT: Partial success with detailed results
type OrderResult struct {
    Order   *model.Order `json:"order,omitempty"`
    Error   *string      `json:"error,omitempty"`
    Success bool         `json:"success"`
    Index   int          `json:"index"`
}

func (r *mutationResolver) CreateOrders(ctx context.Context, inputs []*model.OrderInput) ([]*model.OrderResult, error) {
    results := make([]*model.OrderResult, len(inputs))

    // Use transaction for atomicity if required
    // Or process individually with partial success

    for i, input := range inputs {
        result := &model.OrderResult{Index: i}

        // Validate before creating
        if err := validateOrderInput(input); err != nil {
            errStr := err.Error()
            result.Error = &errStr
            result.Success = false
            results[i] = result
            continue
        }

        // Create with idempotency key to prevent duplicates on retry
        order, err := r.orderService.CreateIdempotent(ctx, input, input.IdempotencyKey)
        if err != nil {
            errStr := err.Error()
            result.Error = &errStr
            result.Success = false
        } else {
            result.Order = order
            result.Success = true
        }

        results[i] = result
    }

    // Return all results, let client handle partial success
    return results, nil
}
```

GraphQL schema supporting partial results:

```graphql
type OrderResult {
  order: Order
  error: String
  success: Boolean!
  index: Int!
}

type Mutation {
  createOrders(inputs: [OrderInput!]!): [OrderResult!]!
}
```

### Quick Reference: GraphQL Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| N+1 queries | Exponential query count | Dataloader for batched loading |
| Query depth attack | OOM, CPU exhaustion | Depth limits, complexity analysis, timeouts |
| Subscription leak | Memory grows over time | Context cancellation, cleanup routines |
| Authorization bypass | Unauthorized data access | Field-level directives, not just query-level |
| Schema cache poison | Stale data, query errors | Dynamic refresh with compatibility validation |
| Batch partial failure | Duplicate operations | Partial success responses, idempotency keys |

### Junior -> FAANG: Reading Incident Reports as a Learning Tool

Each pitfall in this file is presented as an incident report. This format is how post-mortems are written at FAANG companies. The structure is: what was the observable symptom (15-second latency, server crash, duplicate orders), what was the root cause, and what was the fix. Reading post-mortems from public engineering blogs (GitHub Engineering, Shopify Engineering, Netflix Tech Blog) using this same pattern trains your pattern recognition for diagnosing production issues.

For pitfall 1 (N+1), the diagnostic signal is "latency scales linearly with list size." If a query for 10 items takes 100ms and a query for 100 items takes 1000ms, you have an N+1 problem.

For pitfall 2 (unbounded depth), the diagnostic signal is "a single request causes CPU to spike to 100% on the server." The query is not returning a large response. It is causing exponential resolver fan-out.

For pitfall 3 (subscription leak), the diagnostic signal is "memory grows linearly over time, independent of traffic." This is almost always a goroutine leak. Run `pprof` and look at the goroutine count over time.

For pitfall 4 (authorization bypass), the diagnostic signal may be absence: no error, no crash, just data that should not have been returned. These bugs often surface through security audits or bug bounty programs, not production monitoring.

### Senior @ FAANG: Preventing Pitfalls Through Platform Design

At staff level, your job is to make it structurally impossible (or at minimum, structurally difficult) for individual engineers to fall into these pitfalls.

**Preventing N+1 at the platform level.** The dataloader requirement is not a code review suggestion. It is a platform constraint. Add a static analysis rule (using `go/analysis` or a custom `go vet` pass) that flags field resolvers calling repository methods directly. The rule is: if a method on a `*XyzResolver` type calls a repository function and does not go through a loader from the context, it is a warning. This does not catch all N+1 paths, but it catches the most common one.

**Preventing unbounded queries at the platform level.** The base server factory (the `NewGraphQLServer(...)` function in the platform SDK that all teams use) must include complexity limiting, depth limiting, and a query timeout. These are not optional parameters with defaults. They are required values that the calling team must supply. This forces each team to think about appropriate limits for their service rather than relying on a default that may not fit their schema.

**Preventing subscription leaks at the platform level.** Provide a `ManagedSubscription[T any]` helper in the platform SDK that encapsulates the lifecycle correctly: buffered channel creation, `ctx.Done()` monitoring, non-blocking send with configurable drop policy, and cleanup on exit. Teams implement their event sourcing logic as a `BatchFunc` that the helper calls. The helper owns the goroutine lifecycle. Individual teams cannot accidentally omit the `ctx.Done()` case because it is inside the helper.

**Preventing authorization bypass at the platform level.** The authorization directive implementation (the `@auth` and `@hasRole` directive handlers) should live in the platform SDK, not in each service's `directives.go`. The platform SDK's implementation is reviewed by the security team, covered by penetration testing, and updated centrally when vulnerabilities are found. Individual services import it and configure which roles exist in their domain. They do not reimplement the authorization logic themselves.

**Preventing schema cache staleness at the platform level.** The gateway's schema refresh loop should include breaking change detection before applying a new schema. The `detectBreakingChanges` function in pitfall 5 is the right pattern. At FAANG, this is extended with a notification: when a breaking change is detected, an alert goes to the owning team's on-call channel rather than automatically refusing the update. This gives the team visibility that their schema change has a compatibility issue, while preventing the gateway from silently serving stale data.

---
