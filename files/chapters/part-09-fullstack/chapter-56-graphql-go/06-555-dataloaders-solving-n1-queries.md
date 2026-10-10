## 56.5 Dataloaders: Solving N+1 Queries

The N+1 problem is GraphQL's most common performance pitfall. When a query returns a list of 20 products and each product resolver individually fetches its category, the server executes 21 database queries instead of 2. Dataloaders solve this by collecting all keys requested within a single execution tick, issuing one batched query (using `WHERE id IN (...)`), and distributing the results back to each waiting resolver. The `graph-gophers/dataloader` library provides a generic, request-scoped loader that handles batching, deduplication, and per-request caching.

```go
// internal/dataloader/loaders.go
package dataloader

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/graph-gophers/dataloader/v7"
    "graphql-api/graph/model"
    "graphql-api/internal/repository"
)

// Loaders contains all dataloaders
type Loaders struct {
    UserByID               *dataloader.Loader[string, *model.User]
    ProductByID            *dataloader.Loader[string, *model.Product]
    CategoryByID           *dataloader.Loader[string, *model.Category]
    OrdersByUserID         *dataloader.Loader[string, *model.OrderConnection]
    ReviewsByProductID     *dataloader.Loader[string, *model.ReviewConnection]
    OrderItemsByOrderID    *dataloader.Loader[string, []*model.OrderItem]
    AverageRatingByProductID *dataloader.Loader[string, *float64]
}

// NewLoaders creates a new Loaders instance
func NewLoaders(repos *repository.Repositories) *Loaders {
    return &Loaders{
        UserByID: dataloader.NewBatchedLoader(
            userBatcher(repos.User),
            dataloader.WithWait[string, *model.User](2*time.Millisecond),
            dataloader.WithBatchCapacity[string, *model.User](100),
        ),
        ProductByID: dataloader.NewBatchedLoader(
            productBatcher(repos.Product),
            dataloader.WithWait[string, *model.Product](2*time.Millisecond),
            dataloader.WithBatchCapacity[string, *model.Product](100),
        ),
        CategoryByID: dataloader.NewBatchedLoader(
            categoryBatcher(repos.Category),
            dataloader.WithWait[string, *model.Category](2*time.Millisecond),
        ),
        OrdersByUserID: dataloader.NewBatchedLoader(
            ordersByUserBatcher(repos.Order),
            dataloader.WithWait[string, *model.OrderConnection](2*time.Millisecond),
        ),
        ReviewsByProductID: dataloader.NewBatchedLoader(
            reviewsByProductBatcher(repos.Review),
            dataloader.WithWait[string, *model.ReviewConnection](2*time.Millisecond),
        ),
        OrderItemsByOrderID: dataloader.NewBatchedLoader(
            orderItemsBatcher(repos.OrderItem),
            dataloader.WithWait[string, []*model.OrderItem](2*time.Millisecond),
        ),
        AverageRatingByProductID: dataloader.NewBatchedLoader(
            avgRatingBatcher(repos.Review),
            dataloader.WithWait[string, *float64](2*time.Millisecond),
        ),
    }
}

// Batcher functions

func userBatcher(repo repository.UserRepository) dataloader.BatchFunc[string, *model.User] {
    return func(ctx context.Context, keys []string) []*dataloader.Result[*model.User] {
        // Batch fetch all users by IDs in a single query
        users, err := repo.GetByIDs(ctx, keys)
        if err != nil {
            // Return error for all keys
            results := make([]*dataloader.Result[*model.User], len(keys))
            for i := range keys {
                results[i] = &dataloader.Result[*model.User]{Error: err}
            }
            return results
        }

        // Create a map for O(1) lookup
        userMap := make(map[string]*model.User, len(users))
        for _, user := range users {
            userMap[user.ID] = user
        }

        // Return results in the same order as keys
        results := make([]*dataloader.Result[*model.User], len(keys))
        for i, key := range keys {
            user, ok := userMap[key]
            if !ok {
                results[i] = &dataloader.Result[*model.User]{
                    Error: fmt.Errorf("user not found: %s", key),
                }
            } else {
                results[i] = &dataloader.Result[*model.User]{Data: user}
            }
        }
        return results
    }
}

func productBatcher(repo repository.ProductRepository) dataloader.BatchFunc[string, *model.Product] {
    return func(ctx context.Context, keys []string) []*dataloader.Result[*model.Product] {
        products, err := repo.GetByIDs(ctx, keys)
        if err != nil {
            results := make([]*dataloader.Result[*model.Product], len(keys))
            for i := range keys {
                results[i] = &dataloader.Result[*model.Product]{Error: err}
            }
            return results
        }

        productMap := make(map[string]*model.Product, len(products))
        for _, p := range products {
            productMap[p.ID] = p
        }

        results := make([]*dataloader.Result[*model.Product], len(keys))
        for i, key := range keys {
            if p, ok := productMap[key]; ok {
                results[i] = &dataloader.Result[*model.Product]{Data: p}
            } else {
                results[i] = &dataloader.Result[*model.Product]{
                    Error: fmt.Errorf("product not found: %s", key),
                }
            }
        }
        return results
    }
}

func categoryBatcher(repo repository.CategoryRepository) dataloader.BatchFunc[string, *model.Category] {
    return func(ctx context.Context, keys []string) []*dataloader.Result[*model.Category] {
        categories, err := repo.GetByIDs(ctx, keys)
        if err != nil {
            results := make([]*dataloader.Result[*model.Category], len(keys))
            for i := range keys {
                results[i] = &dataloader.Result[*model.Category]{Error: err}
            }
            return results
        }

        catMap := make(map[string]*model.Category, len(categories))
        for _, c := range categories {
            catMap[c.ID] = c
        }

        results := make([]*dataloader.Result[*model.Category], len(keys))
        for i, key := range keys {
            if c, ok := catMap[key]; ok {
                results[i] = &dataloader.Result[*model.Category]{Data: c}
            } else {
                results[i] = &dataloader.Result[*model.Category]{
                    Error: fmt.Errorf("category not found: %s", key),
                }
            }
        }
        return results
    }
}

func ordersByUserBatcher(repo repository.OrderRepository) dataloader.BatchFunc[string, *model.OrderConnection] {
    return func(ctx context.Context, userIDs []string) []*dataloader.Result[*model.OrderConnection] {
        // Fetch all orders for all users in one query
        ordersMap, err := repo.GetByUserIDs(ctx, userIDs)
        if err != nil {
            results := make([]*dataloader.Result[*model.OrderConnection], len(userIDs))
            for i := range userIDs {
                results[i] = &dataloader.Result[*model.OrderConnection]{Error: err}
            }
            return results
        }

        results := make([]*dataloader.Result[*model.OrderConnection], len(userIDs))
        for i, userID := range userIDs {
            orders := ordersMap[userID]
            connection := buildOrderConnection(orders)
            results[i] = &dataloader.Result[*model.OrderConnection]{Data: connection}
        }
        return results
    }
}

func avgRatingBatcher(repo repository.ReviewRepository) dataloader.BatchFunc[string, *float64] {
    return func(ctx context.Context, productIDs []string) []*dataloader.Result[*float64] {
        // Calculate average ratings for all products in one query
        // SELECT product_id, AVG(rating) FROM reviews WHERE product_id IN (...) GROUP BY product_id
        ratings, err := repo.GetAverageRatings(ctx, productIDs)
        if err != nil {
            results := make([]*dataloader.Result[*float64], len(productIDs))
            for i := range productIDs {
                results[i] = &dataloader.Result[*float64]{Error: err}
            }
            return results
        }

        results := make([]*dataloader.Result[*float64], len(productIDs))
        for i, productID := range productIDs {
            if rating, ok := ratings[productID]; ok {
                results[i] = &dataloader.Result[*float64]{Data: &rating}
            } else {
                results[i] = &dataloader.Result[*float64]{Data: nil}
            }
        }
        return results
    }
}

// Middleware to inject loaders into context
func Middleware(repos *repository.Repositories) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Create fresh loaders for each request
            // This ensures proper request-scoped caching
            loaders := NewLoaders(repos)
            ctx := context.WithValue(r.Context(), loadersKey, loaders)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

type contextKey string

const loadersKey contextKey = "dataloaders"

// GetLoaders retrieves loaders from context
func GetLoaders(ctx context.Context) *Loaders {
    return ctx.Value(loadersKey).(*Loaders)
}
```

### N+1 Problem Visualization

The N+1 problem in GraphQL occurs when a list query triggers a separate database call for each item's related field, turning a single query into hundreds of round trips that are invisible in the schema but devastating to latency. This visualization traces the execution flow of a naïve posts-with-authors resolver to make the query multiplication concrete before introducing the dataloader solution in the next section. Understanding the exact mechanism is prerequisite to avoiding it in custom resolvers.

```
WITHOUT Dataloaders (N+1 Problem):
┌─────────────────────────────────────────────────────────────┐
│ Query: { products { category { name } } }                   │
├─────────────────────────────────────────────────────────────┤
│ 1. SELECT * FROM products                     → 20 products │
│ 2. SELECT * FROM categories WHERE id = 'cat1' → 1 category  │
│ 3. SELECT * FROM categories WHERE id = 'cat2' → 1 category  │
│ 4. SELECT * FROM categories WHERE id = 'cat1' → 1 category  │  DUPLICATE!
│ 5. SELECT * FROM categories WHERE id = 'cat3' → 1 category  │
│ ...                                                         │ 
│ 21. SELECT * FROM categories WHERE id = 'cat5'              │ 
│                                                             │ 
│ TOTAL: 21 queries (1 + N where N = 20)                      │ 
└─────────────────────────────────────────────────────────────┘

WITH Dataloaders:
┌──────────────────────────────────────────────────────────────┐
│ Query: { products { category { name } } }                    │
├──────────────────────────────────────────────────────────────┤
│ 1. SELECT * FROM products                     → 20 products  │
│ 2. SELECT * FROM categories WHERE id IN       → 5 categories │
│    ('cat1', 'cat2', 'cat3', 'cat4', 'cat5')                  │
│                                                              │
│ TOTAL: 2 queries (batched + deduplicated)                    │
└──────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Making Dataloaders Second Nature

The dataloader pattern feels like magic until you understand the timing mechanism. The batch function is not called immediately when a resolver calls `Load`. Instead, the loader collects all `Load` calls that happen within a short time window (typically 1-2 milliseconds, the `WithWait` duration) or until the batch reaches its capacity limit, then calls the batch function once with all collected keys. The batch function issues a single `WHERE id IN (...)` query and distributes results back to the individual `Load` calls.

The critical constraint for correctness: the batch function must return results in the same order as the input keys. If the database returns rows in arbitrary order (which it will, absent an explicit `ORDER BY id` that matches the key slice order), you must build a map from key to result and then iterate over the input keys to produce the output slice. This is shown in the `userBatcher` function: build `userMap`, then range over `keys` to populate `results`.

For your first job: get in the habit of adding dataloaders for every field resolver that fetches a related object by a foreign key. The pattern is mechanical and the performance impact is significant. Missing one is not immediately obvious in development with small datasets, but it manifests as severe latency degradation in production with real data volumes.

Interview question you should expect: "what is the N+1 problem and how do dataloaders solve it?" Practice giving the answer in 60 seconds without code: list queries trigger one resolver call per item, without batching each resolver call issues a database query, and dataloaders collect keys across a tick of the event loop and issue one batched query, and deduplication means even duplicate keys (same category requested by multiple products) only produce one fetch.

### Senior @ FAANG: Dataloader Design Decisions at Platform Scale

The standard dataloader implementation hides several design decisions that matter at scale.

**The batching window trade-off.** The `WithWait` duration (2ms in the examples) controls the trade-off between batching efficiency and added latency. A longer wait collects more keys per batch and issues fewer database queries, but adds latency to every load call by that duration. At high concurrency, the batch fills to capacity quickly and the timer fires early anyway, so the effective latency addition is less than the configured wait. At low concurrency, the full wait is added to every response. The right value depends on your concurrency profile: high-concurrency APIs can use shorter waits, while lower-concurrency APIs may need longer waits to achieve meaningful batching.

**Cache scope and invalidation.** The per-request cache in the standard dataloader prevents redundant fetches within a single GraphQL operation. This is correct for read operations. For mutation-then-read patterns within the same request (a mutation that modifies a record followed by a query that reads it), the cached value from before the mutation may be served. The solution is to clear the cache for affected keys after mutations, using the loader's `Clear` method. At platform level, document this as a known limitation and design mutation resolvers to avoid read-after-write patterns within the same GraphQL operation.

**Dataloader library selection.** The `graph-gophers/dataloader/v7` library uses generics to provide type-safe loaders. Older code using `v6` or the original `facebook/dataloader` port uses `interface{}` and requires type assertions. For new code, `v7` is the correct choice. Platform teams should standardize on one library version to enable shared error handling patterns and metrics instrumentation.

**Observability for dataloaders.** In production, you want to know: how many batches are being issued per request, what is the average batch size, and are any loaders consistently producing singleton batches (indicating that the batching is not actually working as expected). Wrap the batch function with a metrics emitter that records batch size as a histogram and batch count as a counter, tagged by loader name. Singleton batches for a loader that should be batching indicate a timing issue: the resolvers are not being invoked concurrently, or the wait window is too short for your system's goroutine scheduling latency.

**Batch function error semantics.** When the batch function returns an error for some keys but not others, you must return per-key results rather than a top-level error. A top-level error from the batch function means all waiters receive that error, even if only one key was unfetchable. The correct pattern (returning `[]*dataloader.Result` with per-element errors) ensures partial success: a missing category does not cause the entire product list to fail.

**Cross-request dataloader sharing.** Some teams attempt to share dataloader instances across requests to reduce initialization overhead. This is incorrect. Dataloaders maintain a per-instance cache. A shared instance caches values from one user's request and serves them to another user's request, which is both a data consistency issue and a potential authorization bypass (serving data the second user should not see). Dataloaders must be created per-request and stored in the request context.

---
