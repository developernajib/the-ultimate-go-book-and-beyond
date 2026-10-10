## Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Partial Failures

When a BFF issues parallel downstream calls and one fails, returning a top-level 500 deprives the client of all successfully fetched data, degrading user experience far more than necessary. The correct behavior is to return a 200 with the available data and an error extension indicating which sections are unavailable, allowing the frontend to render partial content with appropriate placeholders. The implementation below uses `errgroup` with a custom error accumulator that distinguishes terminal failures from degradable ones.

```go
// ❌ BAD: Single failure breaks entire response
func (b *WebBFF) GetHomePage(ctx context.Context, userID string) (*HomePage, error) {
    // If ANY of these fail, the whole request fails
    hero, err := b.promoClient.GetHero(ctx)
    if err != nil {
        return nil, err // User sees error page
    }

    products, err := b.productClient.GetFeatured(ctx)
    if err != nil {
        return nil, err // User sees error page
    }

    categories, err := b.categoryClient.GetTop(ctx)
    if err != nil {
        return nil, err // User sees error page
    }

    return &HomePage{
        Hero:       hero,
        Products:   products,
        Categories: categories,
    }, nil
}

// ✅ GOOD: Graceful degradation with partial data
func (b *WebBFF) GetHomePage(ctx context.Context, userID string) (*HomePage, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex

    home := &HomePage{}
    var errs []error

    // Fetch all sections in parallel
    wg.Add(3)

    go func() {
        defer wg.Done()
        hero, err := b.promoClient.GetHero(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, fmt.Errorf("hero: %w", err))
            // Use fallback hero
            home.Hero = b.getFallbackHero()
        } else {
            home.Hero = hero
        }
        mu.Unlock()
    }()

    go func() {
        defer wg.Done()
        products, err := b.productClient.GetFeatured(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, fmt.Errorf("products: %w", err))
            // Try cache
            if cached := b.cache.GetFeatured(ctx); cached != nil {
                home.Products = cached
                home.ProductsStale = true
            }
        } else {
            home.Products = products
        }
        mu.Unlock()
    }()

    go func() {
        defer wg.Done()
        categories, err := b.categoryClient.GetTop(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, fmt.Errorf("categories: %w", err))
            // Categories can be omitted - not critical
        } else {
            home.Categories = categories
        }
        mu.Unlock()
    }()

    wg.Wait()

    // Log partial failures but still return data
    if len(errs) > 0 {
        slog.Warn("home page partial failure",
            "errors", errs,
            "user_id", userID,
        )
    }

    return home, nil
}
```

### Mistake 2: N+1 Service Calls

A BFF that fetches a list of items and then calls a downstream service per item to enrich each one makes N+1 service calls, the same antipattern as N+1 SQL queries but over the network with its associated latency multiplication. The fix is to batch all enrichment calls into a single bulk request to the downstream service, either using a purpose-built batch endpoint or by grouping IDs into a single query-parameter list. The optimization below replaces a sequential loop over service calls with a single batched call and demonstrates the latency difference under load.

```go
// ❌ BAD: N+1 calls to backend services
func (b *BFF) GetOrders(ctx context.Context, userID string) ([]*OrderResponse, error) {
    orders, err := b.orderClient.GetUserOrders(ctx, userID)
    if err != nil {
        return nil, err
    }

    responses := make([]*OrderResponse, len(orders))
    for i, order := range orders {
        // One call per order to get items
        items, _ := b.orderClient.GetOrderItems(ctx, order.ID)

        // One call per item to get product details
        for j, item := range items {
            product, _ := b.productClient.GetProduct(ctx, item.ProductID) // N+1!
            items[j].Product = product
        }

        // One call per order for user details
        user, _ := b.userClient.GetUser(ctx, order.UserID) // N+1!

        responses[i] = &OrderResponse{
            Order: order,
            Items: items,
            User:  user,
        }
    }
    // For 10 orders with 3 items each: 1 + 10 + 30 + 10 = 51 service calls!

    return responses, nil
}

// ✅ GOOD: Batch service calls
func (b *BFF) GetOrders(ctx context.Context, userID string) ([]*OrderResponse, error) {
    orders, err := b.orderClient.GetUserOrders(ctx, userID)
    if err != nil {
        return nil, err
    }

    if len(orders) == 0 {
        return []*OrderResponse{}, nil
    }

    // Collect all IDs needed
    orderIDs := make([]string, len(orders))
    userIDs := make(map[string]bool)
    for i, o := range orders {
        orderIDs[i] = o.ID
        userIDs[o.UserID] = true
    }

    var wg sync.WaitGroup
    var mu sync.Mutex

    // Maps to store fetched data
    itemsByOrder := make(map[string][]*OrderItem)
    productsMap := make(map[string]*Product)
    usersMap := make(map[string]*User)

    // Batch fetch order items
    wg.Add(1)
    go func() {
        defer wg.Done()
        items, _ := b.orderClient.GetItemsBatch(ctx, orderIDs) // Single call!
        mu.Lock()
        for _, item := range items {
            itemsByOrder[item.OrderID] = append(itemsByOrder[item.OrderID], item)
        }
        mu.Unlock()
    }()

    // Batch fetch users
    wg.Add(1)
    go func() {
        defer wg.Done()
        userIDList := make([]string, 0, len(userIDs))
        for id := range userIDs {
            userIDList = append(userIDList, id)
        }
        users, _ := b.userClient.GetUsersBatch(ctx, userIDList) // Single call!
        mu.Lock()
        for _, u := range users {
            usersMap[u.ID] = u
        }
        mu.Unlock()
    }()

    wg.Wait()

    // Now get unique product IDs from items
    productIDs := make(map[string]bool)
    for _, items := range itemsByOrder {
        for _, item := range items {
            productIDs[item.ProductID] = true
        }
    }

    // Batch fetch products
    productIDList := make([]string, 0, len(productIDs))
    for id := range productIDs {
        productIDList = append(productIDList, id)
    }
    products, _ := b.productClient.GetProductsBatch(ctx, productIDList) // Single call!
    for _, p := range products {
        productsMap[p.ID] = p
    }

    // Assemble responses
    responses := make([]*OrderResponse, len(orders))
    for i, order := range orders {
        items := itemsByOrder[order.ID]
        for _, item := range items {
            item.Product = productsMap[item.ProductID]
        }

        responses[i] = &OrderResponse{
            Order: order,
            Items: items,
            User:  usersMap[order.UserID],
        }
    }
    // Total: 1 + 1 + 1 + 1 = 4 service calls regardless of order count!

    return responses, nil
}
```

### Mistake 3: Caching Responses Instead of Data

Caching the fully assembled BFF response conflates user-specific fields with shared data, either requiring per-user cache keys that destroy hit rate or accidentally serving one user's private data to another. Caching the downstream service responses before aggregation allows a high hit-rate shared cache for the common data while assembling user-specific fields fresh on each request. The architecture change below moves cache population to the individual client layer rather than the BFF aggregation layer.

```go
// ❌ BAD: Caching entire responses (wasteful and inflexible)
func (b *BFF) GetProductDetail(ctx context.Context, productID, userID string) (*ProductDetail, error) {
    // Cache key includes user - can't share between users!
    cacheKey := fmt.Sprintf("product_detail:%s:%s", productID, userID)

    var cached ProductDetail
    if err := b.cache.Get(ctx, cacheKey, &cached); err == nil {
        return &cached, nil
    }

    // Fetch everything
    product, _ := b.productClient.GetProduct(ctx, productID)
    reviews, _ := b.reviewClient.GetReviews(ctx, productID)
    userLikes, _ := b.userClient.GetLikedProducts(ctx, userID)
    related, _ := b.productClient.GetRelated(ctx, productID)

    detail := &ProductDetail{
        Product:   product,
        Reviews:   reviews,
        IsLiked:   contains(userLikes, productID),
        Related:   related,
    }

    // Cache for 5 minutes - but it's user-specific so limited sharing!
    b.cache.Set(ctx, cacheKey, detail, 5*time.Minute)

    return detail, nil
}

// ✅ GOOD: Cache data at appropriate granularity
func (b *BFF) GetProductDetail(ctx context.Context, productID, userID string) (*ProductDetail, error) {
    var wg sync.WaitGroup

    detail := &ProductDetail{}

    // Product data - shared across all users, cache longer
    wg.Add(1)
    go func() {
        defer wg.Done()
        cacheKey := fmt.Sprintf("product:%s", productID)
        var product *Product

        if err := b.cache.Get(ctx, cacheKey, &product); err != nil {
            product, _ = b.productClient.GetProduct(ctx, productID)
            // Cache product for 10 minutes
            b.cache.Set(ctx, cacheKey, product, 10*time.Minute)
        }
        detail.Product = product
    }()

    // Reviews - shared, semi-frequent updates
    wg.Add(1)
    go func() {
        defer wg.Done()
        cacheKey := fmt.Sprintf("reviews:%s", productID)
        var reviews []*Review

        if err := b.cache.Get(ctx, cacheKey, &reviews); err != nil {
            reviews, _ = b.reviewClient.GetReviews(ctx, productID)
            // Cache reviews for 2 minutes
            b.cache.Set(ctx, cacheKey, reviews, 2*time.Minute)
        }
        detail.Reviews = reviews
    }()

    // Related products - shared, stable
    wg.Add(1)
    go func() {
        defer wg.Done()
        cacheKey := fmt.Sprintf("related:%s", productID)
        var related []*Product

        if err := b.cache.Get(ctx, cacheKey, &related); err != nil {
            related, _ = b.productClient.GetRelated(ctx, productID)
            // Cache related for 30 minutes
            b.cache.Set(ctx, cacheKey, related, 30*time.Minute)
        }
        detail.Related = related
    }()

    // User-specific data - short TTL or no cache
    wg.Add(1)
    go func() {
        defer wg.Done()
        // User likes change frequently - cache briefly per user
        cacheKey := fmt.Sprintf("user_likes:%s", userID)
        var likes []string

        if err := b.cache.Get(ctx, cacheKey, &likes); err != nil {
            likes, _ = b.userClient.GetLikedProducts(ctx, userID)
            // Cache user likes for 30 seconds
            b.cache.Set(ctx, cacheKey, likes, 30*time.Second)
        }
        detail.IsLiked = contains(likes, productID)
    }()

    wg.Wait()

    return detail, nil
}
```

### Mistake 4: BFF Doing Too Much Business Logic

When the BFF accumulates business rules (discount calculations, availability logic, personalization algorithms) it becomes a bottleneck that blocks frontend deployments on backend changes and makes the rules difficult to test in isolation. Business logic belongs in domain services. The BFF should only transform and aggregate their outputs. The refactoring below moves misplaced business logic back into the appropriate domain service and replaces it in the BFF with a simple field mapping.

```go
// ❌ BAD: BFF implementing business logic
func (b *BFF) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    // BFF shouldn't calculate prices!
    var totalCents int64
    for _, item := range req.Items {
        product, _ := b.productClient.GetProduct(ctx, item.ProductID)
        totalCents += product.PriceCents * int64(item.Quantity)

        // BFF shouldn't check inventory!
        if product.Stock < item.Quantity {
            return nil, fmt.Errorf("insufficient stock for %s", product.Name)
        }
    }

    // BFF shouldn't apply discounts!
    if req.PromoCode != "" {
        promo, _ := b.promoClient.GetPromo(ctx, req.PromoCode)
        totalCents = totalCents * (100 - promo.DiscountPercent) / 100
    }

    // BFF shouldn't calculate tax!
    taxCents := (totalCents*8 + 50) / 100
    totalCents += taxCents

    // Now create order with calculated values
    order, err := b.orderClient.CreateOrder(ctx, &CreateOrderInput{
        UserID:     req.UserID,
        Items:      req.Items,
        TotalCents: totalCents,
        TaxCents:   taxCents,
    })

    return order, err
}

// ✅ GOOD: BFF only aggregates and transforms
func (b *BFF) CreateOrder(ctx context.Context, req CreateOrderRequest) (*OrderResponse, error) {
    // BFF creates the request, backend service does the logic
    order, err := b.orderClient.CreateOrder(ctx, &CreateOrderInput{
        UserID:    req.UserID,
        Items:     req.Items,
        PromoCode: req.PromoCode,
        // Backend calculates total, validates inventory, applies promo
    })
    if err != nil {
        // Transform backend error to user-friendly message
        return nil, b.transformOrderError(err)
    }

    // BFF aggregates additional data for display
    var wg sync.WaitGroup
    response := &OrderResponse{Order: order}

    wg.Add(2)

    go func() {
        defer wg.Done()
        // Get product details for display
        productIDs := make([]string, len(order.Items))
        for i, item := range order.Items {
            productIDs[i] = item.ProductID
        }
        products, _ := b.productClient.GetProductsBatch(ctx, productIDs)
        response.Products = products
    }()

    go func() {
        defer wg.Done()
        // Get shipping estimate
        estimate, _ := b.shippingClient.GetEstimate(ctx, order.ID)
        response.ShippingEstimate = estimate
    }()

    wg.Wait()

    return response, nil
}
```

### Mistake 5: Not Sharing Code Between BFFs

Three independent BFF services that each implement their own HTTP client, retry logic, authentication middleware, and response envelope types will inevitably diverge, creating maintenance overhead proportional to the number of BFFs. Extracting shared infrastructure into a `pkg/bffkit` library (client base types, tracing helpers, standard error formats) gives each BFF a consistent foundation without coupling them to each other's domain logic. The shared package below defines the minimal common abstractions that all BFFs in this project import.

```go
// ❌ BAD: Duplicating service clients across BFFs
// web-bff/internal/client/product.go
type ProductClient struct {
    baseURL string
    client  *http.Client
}

func (c *ProductClient) GetProduct(ctx context.Context, id string) (*Product, error) {
    // Implementation duplicated in mobile-bff and admin-bff
}

// mobile-bff/internal/client/product.go
type ProductClient struct {
    baseURL string
    client  *http.Client
}

func (c *ProductClient) GetProduct(ctx context.Context, id string) (*Product, error) {
    // Same implementation, different package
}

// ✅ GOOD: Shared service clients in common package
// shared/pkg/client/product.go
package client

import (
    "context"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// ProductClient is shared across all BFFs
type ProductClient struct {
    base *BaseClient
}

// Product is the canonical product type
type Product struct {
    ID          string    `json:"id"`
    Name        string    `json:"name"`
    Description string    `json:"description"`
    PriceCents  int64     `json:"price_cents"`
    Stock       int       `json:"stock"`
    Images      []string  `json:"images"`
    CategoryID  string    `json:"category_id"`
    Rating      float64   `json:"rating"`
    CreatedAt   time.Time `json:"created_at"`
}

func NewProductClient(cfg ClientConfig) *ProductClient {
    return &ProductClient{
        base: NewBaseClient(cfg),
    }
}

func (c *ProductClient) GetProduct(ctx context.Context, id string) (*Product, error) {
    var product Product
    if err := c.base.Get(ctx, "/products/"+id, &product); err != nil {
        return nil, err
    }
    return &product, nil
}

func (c *ProductClient) GetProductsBatch(ctx context.Context, ids []string) ([]*Product, error) {
    var products []*Product
    if err := c.base.Post(ctx, "/products/batch", map[string][]string{"ids": ids}, &products); err != nil {
        return nil, err
    }
    return products, nil
}

// BFFs use transformers for client-specific responses
// web-bff/internal/transformer/product.go
package transformer

import "shared/pkg/client"

// WebProductCard is web-specific representation
type WebProductCard struct {
    ID            string   `json:"id"`
    Name          string   `json:"name"`
    PriceCents    int64    `json:"price_cents"`
    OriginalPriceCents *int64 `json:"original_price_cents,omitempty"`
    Image         string   `json:"image"`
    Rating        float64  `json:"rating"`
    InStock       bool     `json:"in_stock"`
}

func ToWebProductCard(p *client.Product) *WebProductCard {
    return &WebProductCard{
        ID:      p.ID,
        Name:    p.Name,
        PriceCents: p.PriceCents,
        Image:   p.Images[0], // First image for card
        Rating:  p.Rating,
        InStock: p.Stock > 0,
    }
}

// mobile-bff/internal/transformer/product.go
package transformer

// MobileProductCard is mobile-optimized
type MobileProductCard struct {
    ID    string  `json:"id"`
    Name  string  `json:"name"`  // Truncated
    PriceCents int64 `json:"price_cents"`
    Image string  `json:"img"`   // Thumbnail
}

func ToMobileProductCard(p *client.Product, imgService ImageService) *MobileProductCard {
    name := p.Name
    if len(name) > 25 {
        name = name[:22] + "..."
    }

    return &MobileProductCard{
        ID:    p.ID,
        Name:  name,
        PriceCents: p.PriceCents,
        Image: imgService.Thumbnail(p.Images[0], 100),
    }
}
```

### Junior -> FAANG: Building a Mistake Checklist

Turn each mistake in this file into a checklist item you run through before every BFF code review. After reading this section, create a personal checklist with five items: (1) Are all downstream calls issued in parallel, not sequentially? (2) Are responses paginated with bounded page sizes? (3) Is shared data cached under a key that does not include user ID? (4) Is the BFF issuing scoped service tokens, not forwarding user JWTs? (5) Are internal error details stripped before the response is serialized?

The N+1 call mistake (Mistake 2) is especially common in first production BFFs. When you see a loop over items followed by a service call inside the loop body, that is an N+1 pattern. Fix it by collecting all IDs from the list, making a single batch call, and joining the results in memory. Your first instinct in code review should be to look for loops that contain service calls.

The caching granularity mistake (Mistake 3) has a simple detection method: look at your cache key construction. If any key includes a user ID for data that is conceptually shared (product catalog, category list, promotions), you are caching at too fine a granularity and destroying your hit rate. Shared data should have shared keys. User-specific data should have user-scoped keys. Never mix them.

For interviews, you can use these five mistakes as a self-quiz framework: "Here is the BFF design I described. Let me walk through the five most common BFF mistakes and verify my design avoids each one." This signals systematic engineering thinking, not just happy-path design.

### Senior @ FAANG: Systematic Failure Mode Analysis

At senior level, the five mistakes in this file are entry points into a broader failure mode analysis that spans the entire BFF architecture. Each mistake has a detection method, a root cause, a fix, and a prevention mechanism. Document all four for each failure mode your team might encounter.

The distributed monolith failure mode (Mistake 1, sequential calls) is often not visible in code review because each individual call looks reasonable in isolation. The systemic detection requires measuring actual fan-out latency in production: if your BFF's p99 latency consistently equals the sum of individual downstream p99 latencies, you have sequential calls somewhere. If it equals the max, you have true parallel fan-out. Add per-service latency histograms to your BFF metrics and build an alert that fires when BFF p99 exceeds 1.5x the slowest downstream service p99, indicating sequential chaining.

The token forwarding security mistake (Mistake 4) is a design-time failure that does not appear in code review unless reviewers know to look for it. Prevent it at the architecture level by defining a policy: "BFF services never forward incoming auth tokens to downstream services. All downstream calls use service-to-service tokens issued by the BFF's own auth client." Make this policy explicit in your architecture decision records and reference it in code review checklists.

The error leakage mistake (Mistake 5) has a compliance dimension beyond security. In GDPR scope, an error response that includes a user ID or database record ID constitutes exposure of personal data even if it is only an error. The `BFFError` struct with an unexported `internalErr` field is the right design. Enforce it by adding a linter rule that detects any call to `fmt.Errorf` in a handler function that includes an upstream error directly. All upstream errors must pass through `mapToClientError` before reaching the response writer.

At staff level, you run a failure mode and effects analysis on the BFF platform before major traffic events (product launches, shopping events, live streams). For each downstream service dependency, ask: "What happens to the BFF if this service is completely unavailable for ten minutes?" If the answer is "BFF returns 500 to all clients," you have a gap in your partial failure handling. If the answer is "BFF returns degraded responses with fallback data and the SLO remains green," you have resilience. The analysis result becomes the on-call runbook for the event.

---
