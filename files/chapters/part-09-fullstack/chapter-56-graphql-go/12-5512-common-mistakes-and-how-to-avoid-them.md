## Common Mistakes and How to Avoid Them

### Mistake 1: Not Using Dataloaders (N+1 Queries)

Not using dataloaders is the single most common GraphQL performance mistake: a list of 100 posts each resolving their author triggers 100 separate `SELECT` statements instead of a single `SELECT ... WHERE id IN (...)`. The symptom is a response that feels fast for small lists but degrades catastrophically at scale, and the fix (wrapping the field resolver in a dataloader) is mechanical once the pattern is understood. The before-and-after below shows the resolver change and the query count reduction confirmed by an OpenTelemetry span trace.

```go
// ❌ BAD: N+1 queries - one query per product's category
func (r *productResolver) Category(
    ctx context.Context,
    obj *model.Product,
) (*model.Category, error) {
    // This executes once per product in the list
    return r.DB.GetCategory(ctx, obj.CategoryID)
}

// For 100 products, this executes:
// 1 query for products + 100 queries for categories = 101 queries!

// ✅ GOOD: Use dataloader to batch queries
func (r *productResolver) Category(
    ctx context.Context,
    obj *model.Product,
) (*model.Category, error) {
    // Dataloader batches all category requests in the same tick
    return r.Loaders.CategoryByID.Load(ctx, obj.CategoryID)
}

// With dataloader:
// 1 query for products + 1 batched query for categories = 2 queries!

// Dataloader implementation
func categoryBatcher(repo CategoryRepository) dataloader.BatchFunc[string, *model.Category] {
    return func(ctx context.Context, keys []string) []*dataloader.Result[*model.Category] {
        // Single query: SELECT * FROM categories WHERE id IN (...)
        categories, err := repo.GetByIDs(ctx, keys)
        if err != nil {
            results := make([]*dataloader.Result[*model.Category], len(keys))
            for i := range keys {
                results[i] = &dataloader.Result[*model.Category]{Error: err}
            }
            return results
        }

        // Map results back to keys in order
        categoryMap := make(map[string]*model.Category)
        for _, cat := range categories {
            categoryMap[cat.ID] = cat
        }

        results := make([]*dataloader.Result[*model.Category], len(keys))
        for i, key := range keys {
            results[i] = &dataloader.Result[*model.Category]{Data: categoryMap[key]}
        }
        return results
    }
}
```

### Mistake 2: Exposing Internal Errors to Clients

Forwarding raw Go errors to GraphQL clients leaks implementation details (database driver messages, internal package paths, SQL syntax) that can aid an attacker in crafting targeted requests. The correct pattern wraps errors at the service boundary, logging the full error internally while returning a sanitized message and a stable error code to the client. The error wrapper below classifies known domain errors into GraphQL error extensions and falls back to a generic internal error for unexpected cases.

```go
// ❌ BAD: Leaking internal details in errors
func (r *mutationResolver) CreateOrder(
    ctx context.Context,
    input model.CreateOrderInput,
) (*model.Order, error) {
    order, err := r.OrderService.Create(ctx, input)
    if err != nil {
        // This exposes: "pq: duplicate key value violates unique constraint"
        return nil, err
    }
    return order, nil
}

// ✅ GOOD: Map internal errors to user-friendly messages
func (r *mutationResolver) CreateOrder(
    ctx context.Context,
    input model.CreateOrderInput,
) (*model.Order, error) {
    order, err := r.OrderService.Create(ctx, input)
    if err != nil {
        // Log the actual error for debugging
        slog.Error("order creation failed",
            "error", err,
            "user_id", auth.UserIDFromContext(ctx),
        )

        // Return sanitized error to client
        switch {
        case errors.Is(err, service.ErrInsufficientStock):
            return nil, gqlerror.Errorf("One or more items are out of stock")
        case errors.Is(err, service.ErrInvalidAddress):
            return nil, &gqlerror.Error{
                Message: "Invalid shipping address",
                Extensions: map[string]any{
                    "code": "VALIDATION_ERROR",
                    "field": "shippingAddress",
                },
            }
        case errors.Is(err, service.ErrPaymentFailed):
            return nil, gqlerror.Errorf("Payment processing failed. Please try again.")
        default:
            return nil, gqlerror.Errorf("Unable to create order. Please try again later.")
        }
    }
    return order, nil
}

// Even better: Use a central error presenter
func ErrorPresenter(ctx context.Context, err error) *gqlerror.Error {
    // Log all errors
    slog.Error("graphql error",
        "error", err,
        "path", graphql.GetPath(ctx),
        "request_id", middleware.RequestIDFromContext(ctx),
    )

    // Map to appropriate response
    var gqlErr *gqlerror.Error
    if errors.As(err, &gqlErr) {
        return gqlErr
    }

    // Return generic error for unknown errors
    return &gqlerror.Error{
        Message: "An unexpected error occurred",
        Path:    graphql.GetPath(ctx),
        Extensions: map[string]any{
            "code": "INTERNAL_ERROR",
        },
    }
}
```

### Mistake 3: No Query Complexity Limits

Without query complexity limits, a single deeply nested GraphQL query can trigger exponential resolver fan-out that exhausts CPU and database connections, effectively providing a denial-of-service vector to any authenticated user. gqlgen supports a complexity calculation extension that assigns weights to fields and rejects queries exceeding a configurable threshold before any resolver executes. The configuration below registers the complexity extension, assigns costs to list fields and N+1-prone relationships, and sets a maximum complexity that blocks obviously abusive queries.

```go
// ❌ BAD: No limits on query complexity
// Attacker can send:
// query {
//   users(first: 1000) {
//     orders(first: 1000) {
//       items(first: 1000) {
//         product { reviews(first: 1000) { ... } }
//       }
//     }
//   }
// }
// This could return 1000 * 1000 * 1000 * 1000 = 1 trillion items!

func setupServer() *handler.Server {
    srv := handler.New(schema)
    // No complexity limit - vulnerable to DoS
    return srv
}

// ✅ GOOD: Implement complexity limiting
func setupServer() *handler.Server {
    srv := handler.New(schema)

    // Fixed complexity limit
    srv.Use(extension.FixedComplexityLimit(500))

    // Or custom complexity calculation
    srv.Use(&ComplexityExtension{
        MaxComplexity: 500,
        Calculator:    calculateComplexity,
    })

    // Also limit depth
    srv.Use(&DepthLimitExtension{MaxDepth: 10})

    return srv
}

// Custom complexity calculation
func calculateComplexity(
    es graphql.ExecutableSchema,
    oc *ast.OperationDefinition,
) (int, bool) {
    complexity := 0

    var calculate func(set ast.SelectionSet, multiplier int, depth int)
    calculate = func(set ast.SelectionSet, multiplier int, depth int) {
        for _, sel := range set {
            switch s := sel.(type) {
            case *ast.Field:
                fieldComplexity := 1

                // Check for pagination arguments
                for _, arg := range s.Arguments {
                    if arg.Name == "first" || arg.Name == "last" {
                        if n, err := strconv.Atoi(arg.Value.Raw); err == nil {
                            fieldComplexity = n
                        }
                    }
                }

                complexity += fieldComplexity * multiplier

                if s.SelectionSet != nil {
                    calculate(s.SelectionSet, fieldComplexity*multiplier, depth+1)
                }
            }
        }
    }

    calculate(oc.SelectionSet, 1, 0)

    return complexity, complexity <= 500
}
```

### Mistake 4: Reusing Dataloaders Across Requests

Storing a dataloader in a package-level variable or a long-lived struct causes it to cache values from previous requests, serving stale data to subsequent users, including data they should not be authorized to see. Dataloaders must be created per-request and stored in the request context so their cache lifetime matches the HTTP request lifecycle. The example below contrasts the broken global dataloader with the correct per-request initialization in the middleware chain.

```go
// ❌ BAD: Global dataloaders (cache pollution between requests)
var globalLoaders = NewLoaders(db) // Shared across all requests!

func (r *Resolver) Query() QueryResolver {
    return &queryResolver{r, globalLoaders} // Same loaders for every request
}

// User A requests product 123 -> cached
// User B requests product 123 -> gets stale data from User A's request
// Also: No request-scoped authorization in cache

// ✅ GOOD: Create fresh loaders per request
func DataloaderMiddleware(db *sql.DB) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Create NEW loaders for each request
            loaders := NewLoaders(db)
            ctx := context.WithValue(r.Context(), loadersKey, loaders)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetLoaders(ctx context.Context) *Loaders {
    return ctx.Value(loadersKey).(*Loaders)
}

// In resolver
func (r *productResolver) Category(
    ctx context.Context,
    obj *model.Product,
) (*model.Category, error) {
    // Get request-scoped loaders
    loaders := GetLoaders(ctx)
    return loaders.CategoryByID.Load(ctx, obj.CategoryID)
}
```

### Mistake 5: Blocking Subscriptions on Slow Consumers

A subscription resolver that writes directly to a slow consumer's response channel blocks the entire event bus while waiting for the consumer to drain, causing all other subscribers to experience latency spikes. The fix is a buffered per-subscriber channel with a non-blocking send that drops messages for overloaded subscribers rather than blocking the publisher. The implementation below shows the subscription event loop with the non-blocking send pattern and a drop counter metric.

```go
// ❌ BAD: Blocking send to subscription channel
func (r *subscriptionResolver) OrderUpdates(
    ctx context.Context,
    orderID string,
) (<-chan *model.Order, error) {
    ch := make(chan *model.Order)

    go func() {
        defer close(ch)

        sub := r.PubSub.Subscribe(ctx, "order:"+orderID)
        for msg := range sub.Channel() {
            var order model.Order
            json.Unmarshal([]byte(msg.Payload), &order)

            // If client is slow, this blocks forever
            // and backs up the entire subscription system
            ch <- &order
        }
    }()

    return ch, nil
}

// ✅ GOOD: Non-blocking with backpressure handling
func (r *subscriptionResolver) OrderUpdates(
    ctx context.Context,
    orderID string,
) (<-chan *model.Order, error) {
    // Buffered channel for backpressure
    ch := make(chan *model.Order, 10)

    go func() {
        defer close(ch)

        sub := r.PubSub.Subscribe(ctx, "order:"+orderID)
        defer sub.Close()

        for {
            select {
            case <-ctx.Done():
                return
            case msg := <-sub.Channel():
                var order model.Order
                if err := json.Unmarshal([]byte(msg.Payload), &order); err != nil {
                    slog.Warn("invalid order message", "error", err)
                    continue
                }

                // Non-blocking send with timeout
                select {
                case ch <- &order:
                    // Sent successfully
                case <-time.After(5 * time.Second):
                    // Client too slow, skip this update
                    slog.Warn("subscription client too slow, dropping update",
                        "order_id", orderID,
                    )
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return ch, nil
}
```

### Junior -> FAANG: Internalizing the Mistakes Before You Make Them

The five mistakes in this file follow a pattern: each one is invisible in development and catastrophic in production. Small datasets mask N+1 queries. Low traffic masks missing complexity limits. Browser-crash edge cases mask subscription leaks. Manual testing of specific paths masks authorization bypass via alternative query paths.

The most actionable preparation for your first job: before every code review you send, run through this checklist. Did I add a field resolver that hits the database? It needs a dataloader. Did I return an error from a resolver? It needs to go through the error presenter. Did I create a subscription goroutine? It needs a `ctx.Done()` case. Did I add auth to a root query? Does the same auth apply to all paths that can reach the protected data?

These are not advanced senior concerns. They are habits that distinguish engineers who ship reliable code from engineers who ship code that works in the demo.

### Senior @ FAANG: The Systemic Causes Behind These Mistakes

Individual engineer mistakes are symptoms. At staff level, you address the systemic causes.

N+1 queries exist in production codebases because there is no automated detection. The fix: add a database query counter to the test infrastructure and fail any test where the query count for a list operation exceeds a threshold. Add a lint rule that flags field resolvers that call repository methods without a dataloader. Add a runtime metric that counts database queries per GraphQL operation and alert when it exceeds a configurable limit per operation. Individual vigilance does not scale. Automated enforcement does.

Error leakage exists because there is no central error presenter enforced at the platform level. If each team implements their own error handling, some will forget to sanitize. The fix: the platform SDK exports a `DefaultErrorPresenter` that handles the standard error taxonomy. Individual resolvers cannot return arbitrary errors. They must use the platform error types or have their errors sanitized by the presenter. Code review rubric: any resolver that returns a bare `fmt.Errorf(err.Error())` is a finding.

Complexity limit omissions exist because the default gqlgen setup does not include them. The fix: the platform's base server configuration (the factory function that all services call to create their GraphQL server) includes the complexity limit, the depth limit, and the timeout extension. Individual services cannot accidentally omit them because they are built into the factory, not configured per-service.

Subscription leaks exist because the pattern for correct subscription goroutines is not codified. The fix: provide a `SubscriptionHelper` function in the platform SDK that accepts the context, a `PubSub.Subscribe` call, and a transformation function, and returns the typed channel. The helper handles `ctx.Done()`, buffered channels, non-blocking sends, and cleanup. Individual services call the helper rather than writing raw goroutines.

Global dataloader reuse exists because the error (sharing state across requests) is not immediately visible. The fix: make the dataloader constructor per-request by ensuring it is instantiated inside the middleware function that runs on every request. Add a test that sends two requests with different user contexts and verifies that the second request does not receive the first request's cached data.

---
