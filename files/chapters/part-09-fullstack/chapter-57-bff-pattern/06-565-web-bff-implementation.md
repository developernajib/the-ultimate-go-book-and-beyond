## 57.5 Web BFF Implementation

The web BFF assembles data-rich responses for desktop browsers, where bandwidth is plentiful and the UI renders complex layouts with multiple content sections visible simultaneously. A typical web homepage might display a hero banner, featured product grid, category navigation, promotions, recently viewed items, and personalized recommendations, all above the fold. Rather than forcing the browser to make six separate API calls, the web BFF aggregates all of this into a single response.

The handler below defines the response types for the homepage. Each struct is shaped to match what the frontend template renders, so the JavaScript layer does no data transformation. It binds the JSON directly to UI components.

```go
// services/web-bff/internal/handler/home.go
package handler

import (
    "encoding/json"
    "net/http"

    "web-bff/internal/aggregator"
)

type HomeHandler struct {
    aggregator *aggregator.HomeAggregator
}

func NewHomeHandler(agg *aggregator.HomeAggregator) *HomeHandler {
    return &HomeHandler{aggregator: agg}
}

// HomeResponse is optimized for web - rich data for above-the-fold content
type HomeResponse struct {
    Hero           *HeroSection           `json:"hero"`
    FeaturedProducts []*ProductCard       `json:"featured_products"`
    Categories     []*CategoryCard        `json:"categories"`
    RecentlyViewed []*ProductCard         `json:"recently_viewed,omitempty"`
    Recommendations []*ProductCard        `json:"recommendations,omitempty"`
    Promotions     []*Promotion           `json:"promotions"`
    User           *UserSummary           `json:"user,omitempty"`
}

type HeroSection struct {
    Title       string `json:"title"`
    Subtitle    string `json:"subtitle"`
    ImageURL    string `json:"image_url"`
    CTAText     string `json:"cta_text"`
    CTALink     string `json:"cta_link"`
}

type ProductCard struct {
    ID            string   `json:"id"`
    Name          string   `json:"name"`
    PriceCents    int64  `json:"price_cents"`
    OriginalPriceCents *int64 `json:"original_price_cents,omitempty"`
    Discount      *int     `json:"discount_percent,omitempty"`
    ImageURL      string   `json:"image_url"`
    Rating        float64  `json:"rating"`
    ReviewCount   int      `json:"review_count"`
    InStock       bool     `json:"in_stock"`
    Badge         string   `json:"badge,omitempty"` // "New", "Sale", "Popular"
}

type CategoryCard struct {
    ID          string `json:"id"`
    Name        string `json:"name"`
    ImageURL    string `json:"image_url"`
    ProductCount int   `json:"product_count"`
}

type Promotion struct {
    ID       string `json:"id"`
    Title    string `json:"title"`
    ImageURL string `json:"image_url"`
    Link     string `json:"link"`
}

type UserSummary struct {
    Name        string `json:"name"`
    Avatar      string `json:"avatar"`
    CartCount   int    `json:"cart_count"`
    WishlistCount int  `json:"wishlist_count"`
}

func (h *HomeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Get user ID from auth context (may be nil for anonymous)
    userID := getUserID(ctx)

    // Aggregate all home page data
    homeData, err := h.aggregator.GetHomeData(ctx, userID)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(homeData)
}
```

The aggregator is where the real work happens. It fans out concurrent requests to five downstream services, collects the results under a mutex, and returns a partially populated response even if some upstream calls fail. This pattern (fire all requests in parallel, degrade gracefully on partial failure) is the core value proposition of a BFF. The `sync.WaitGroup` coordinates goroutine completion, while the mutex protects shared writes to the response struct.

```go
// services/web-bff/internal/aggregator/home.go
package aggregator

import (
    "context"
    "log/slog"
    "sync"
    "time"

    "shared/pkg/serviceclient"
)

type HomeAggregator struct {
    productClient   *serviceclient.ProductClient
    categoryClient  *serviceclient.CategoryClient
    userClient      *serviceclient.UserClient
    promoClient     *serviceclient.PromotionClient
    recommendClient *serviceclient.RecommendationClient
    cache           Cache
}

func NewHomeAggregator(
    productClient *serviceclient.ProductClient,
    categoryClient *serviceclient.CategoryClient,
    userClient *serviceclient.UserClient,
    promoClient *serviceclient.PromotionClient,
    recommendClient *serviceclient.RecommendationClient,
    cache Cache,
) *HomeAggregator {
    return &HomeAggregator{
        productClient:   productClient,
        categoryClient:  categoryClient,
        userClient:      userClient,
        promoClient:     promoClient,
        recommendClient: recommendClient,
        cache:           cache,
    }
}

func (a *HomeAggregator) GetHomeData(ctx context.Context, userID *string) (*HomeResponse, error) {
    var (
        wg           sync.WaitGroup
        mu           sync.Mutex
        errs         []error
        resp         = &HomeResponse{}
    )

    // Parallel fetch of independent data

    // 1. Hero section (cached)
    wg.Add(1)
    go func() {
        defer wg.Done()
        hero, err := a.getHeroSection(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Hero = hero
        }
        mu.Unlock()
    }()

    // 2. Featured products
    wg.Add(1)
    go func() {
        defer wg.Done()
        products, err := a.getFeaturedProducts(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.FeaturedProducts = products
        }
        mu.Unlock()
    }()

    // 3. Categories
    wg.Add(1)
    go func() {
        defer wg.Done()
        categories, err := a.getTopCategories(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Categories = categories
        }
        mu.Unlock()
    }()

    // 4. Promotions
    wg.Add(1)
    go func() {
        defer wg.Done()
        promos, err := a.getActivePromotions(ctx)
        mu.Lock()
        if err != nil {
            errs = append(errs, err)
        } else {
            resp.Promotions = promos
        }
        mu.Unlock()
    }()

    // 5. User-specific data (if authenticated)
    if userID != nil {
        wg.Add(1)
        go func() {
            defer wg.Done()
            userData, err := a.getUserData(ctx, *userID)
            mu.Lock()
            if err != nil {
                errs = append(errs, err)
            } else {
                resp.User = userData.Summary
                resp.RecentlyViewed = userData.RecentlyViewed
            }
            mu.Unlock()
        }()

        wg.Add(1)
        go func() {
            defer wg.Done()
            recs, err := a.getRecommendations(ctx, *userID)
            mu.Lock()
            if err != nil {
                errs = append(errs, err)
            } else {
                resp.Recommendations = recs
            }
            mu.Unlock()
        }()
    }

    wg.Wait()

    // Return partial data even if some requests failed
    // Log errors for monitoring
    for _, err := range errs {
        slog.Warn("home aggregation partial failure", "error", err)
    }

    return resp, nil
}

func (a *HomeAggregator) getHeroSection(ctx context.Context) (*HeroSection, error) {
    // Check cache first
    var hero HeroSection
    if err := a.cache.Get(ctx, "home:hero", &hero); err == nil {
        return &hero, nil
    }

    // Fetch from promotions service
    heroData, err := a.promoClient.GetHero(ctx)
    if err != nil {
        return nil, err
    }

    hero = HeroSection{
        Title:    heroData.Title,
        Subtitle: heroData.Subtitle,
        ImageURL: heroData.ImageURL,
        CTAText:  heroData.CTAText,
        CTALink:  heroData.CTALink,
    }

    // Cache for 5 minutes
    a.cache.Set(ctx, "home:hero", hero, 5*time.Minute)

    return &hero, nil
}

func (a *HomeAggregator) getFeaturedProducts(ctx context.Context) ([]*ProductCard, error) {
    // Check cache
    var cards []*ProductCard
    if err := a.cache.Get(ctx, "home:featured", &cards); err == nil {
        return cards, nil
    }

    // Fetch products
    resp, err := a.productClient.List(ctx, serviceclient.ProductListOptions{
        Limit:  12,
        SortBy: "featured",
    })
    if err != nil {
        return nil, err
    }

    // Transform to cards
    cards = make([]*ProductCard, len(resp.Products))
    for i, p := range resp.Products {
        cards[i] = transformProductToCard(p)
    }

    // Cache for 2 minutes
    a.cache.Set(ctx, "home:featured", cards, 2*time.Minute)

    return cards, nil
}

func (a *HomeAggregator) getTopCategories(ctx context.Context) ([]*CategoryCard, error) {
    var cards []*CategoryCard
    if err := a.cache.Get(ctx, "home:categories", &cards); err == nil {
        return cards, nil
    }

    categories, err := a.categoryClient.GetTop(ctx, 8)
    if err != nil {
        return nil, err
    }

    cards = make([]*CategoryCard, len(categories))
    for i, c := range categories {
        cards[i] = &CategoryCard{
            ID:           c.ID,
            Name:         c.Name,
            ImageURL:     c.ImageURL,
            ProductCount: c.ProductCount,
        }
    }

    a.cache.Set(ctx, "home:categories", cards, 10*time.Minute)
    return cards, nil
}

func transformProductToCard(p *serviceclient.Product) *ProductCard {
    card := &ProductCard{
        ID:          p.ID,
        Name:        p.Name,
        PriceCents:  p.PriceCents,
        ImageURL:    p.Images[0], // First image for card
        Rating:      p.Rating,
        ReviewCount: p.ReviewCount,
        InStock:     p.Stock > 0,
    }

    // Add badge logic
    if p.IsNew {
        card.Badge = "New"
    } else if p.OriginalPriceCents != nil && *p.OriginalPriceCents > p.PriceCents {
        card.Badge = "Sale"
        card.OriginalPriceCents = p.OriginalPriceCents
        discount := int((*p.OriginalPriceCents - p.PriceCents) * 100 / *p.OriginalPriceCents)
        card.Discount = &discount
    } else if p.ReviewCount > 100 && p.Rating >= 4.5 {
        card.Badge = "Popular"
    }

    return card
}
```

### Junior -> FAANG: Understanding Fan-Out and Partial Failure

The `GetHomeData` aggregator above is the canonical BFF fan-out pattern. Read it carefully and make sure you can reproduce it from memory in a live coding interview.

The key decisions to understand: `sync.WaitGroup` coordinates goroutine completion. `sync.Mutex` protects shared writes to `resp` and `errs`. Each goroutine is independent: one failing does not cancel the others. The function returns partial data even when some goroutines fail, with errors logged for monitoring rather than returned to the caller.

A common first-attempt mistake is using a channel instead of a mutex to collect results. Channels work for single values but require careful coordination when goroutines produce different fields on the same struct. The mutex pattern is simpler and less error-prone for this use case. Use channels when the goroutines produce homogeneous values that need to be processed by the caller in order.

Another first-attempt mistake is not setting a timeout on the context before fanning out. If the hero service hangs indefinitely, the `wg.Wait()` call hangs indefinitely, and your BFF handler goroutine is stuck. Always derive a timeout context before starting the fan-out: `ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)` followed by `defer cancel()`.

For the interview, if asked "how do you build a homepage that requires data from five services in under 200ms?", walk through this pattern step by step: concurrent goroutines, shared mutex, partial failure tolerance, and timeout propagation.

### Senior @ FAANG: Fan-Out Architecture at Scale

The `sync.WaitGroup` plus mutex pattern shown here is correct and readable for small fan-outs (under ten goroutines). At higher fan-out counts, consider `golang.org/x/sync/errgroup` with a context, which provides built-in cancellation on the first error and avoids the manual `mu.Lock()` dance.

But the more important senior concern is bounding the fan-out. An unbounded fan-out to twenty-three downstream services from a single request is a reliability risk. Each additional service in the fan-out multiplies the probability of at least one failure. With twenty services each at 99.9% availability, the probability that all twenty succeed simultaneously is 0.999^20 = 98%. That sounds good until you realize that 2% of your homepage requests will have at least one service failure. At Netflix's traffic scale, 2% is millions of failed requests per hour.

The solution is to classify upstream dependencies by criticality and structure the fan-out accordingly. Critical dependencies (the hero section, featured products) must succeed or the response is degraded to an error. Non-critical dependencies (recommendations, recently viewed) can fail silently with empty defaults. Document this classification in the code with comments and enforce it through separate error handling paths. The `HomeResponse` struct should have boolean fields like `RecommendationsAvailable` that the frontend uses to decide whether to show a placeholder, not just rely on nil checks.

At L6/L7, you are also thinking about the fan-out's effect on downstream services during traffic spikes. When your BFF scales from 10 instances to 100 instances under load, each instance fans out to five services. The product service sees 100x its normal request rate during your BFF's scale event. If the product service does not have sufficient capacity or if it has a response time SLA calibrated for your BFF's normal traffic, this scale event can cascade. Senior engineers proactively capacity-plan downstream services as part of BFF deployment planning, not as a reaction to an incident.

---
