## 57.6 Mobile BFF Implementation

The mobile BFF serves a fundamentally different response shape than the web BFF. Mobile clients operate under constraints that desktop browsers do not face: limited bandwidth on cellular networks, battery drain from radio usage, and smaller screens that display fewer items at once. The mobile BFF addresses these constraints by returning fewer items per request, using thumbnail image URLs instead of full-resolution images, truncating text fields to display-appropriate lengths, and supporting a low-bandwidth mode that further reduces payload size.

Compare the response types below with the web BFF's `HomeResponse` from the previous section. The mobile version omits promotions, recently viewed items, and review counts entirely. The mobile UI does not render those sections on the home screen.

```go
// services/mobile-bff/internal/handler/home.go
package handler

import (
    "encoding/json"
    "net/http"

    "mobile-bff/internal/aggregator"
)

type HomeHandler struct {
    aggregator *aggregator.HomeAggregator
}

// MobileHomeResponse - Minimal data for mobile
type MobileHomeResponse struct {
    Hero            *MobileHero         `json:"hero"`
    Products        []*MobileProductCard `json:"products"`
    QuickCategories []*QuickCategory     `json:"categories"`
    CartCount       int                  `json:"cart_count"`
}

// MobileHero - Smaller images, less text
type MobileHero struct {
    ImageURL string `json:"image"`
    Link     string `json:"link"`
}

// MobileProductCard - Minimal product data
type MobileProductCard struct {
    ID       string  `json:"id"`
    Name     string  `json:"name"`       // Truncated to 30 chars
    PriceCents int64 `json:"price_cents"`
    ImageURL string  `json:"image"`      // Thumbnail URL
    Rating   float64 `json:"rating"`
    InStock  bool    `json:"in_stock"`
}

// QuickCategory - Just enough for navigation
type QuickCategory struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    Icon string `json:"icon"` // Icon name, not full image
}

func (h *HomeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    userID := getUserID(ctx)

    // Check for low-bandwidth mode
    lowBandwidth := r.Header.Get("X-Low-Bandwidth") == "true"

    homeData, err := h.aggregator.GetHomeData(ctx, userID, lowBandwidth)
    if err != nil {
        respondError(w, err)
        return
    }

    w.Header().Set("Content-Type", "application/json")

    // Mobile responses should be small
    // Enable compression
    w.Header().Set("Content-Encoding", "gzip")

    json.NewEncoder(w).Encode(homeData)
}
```

The mobile aggregator makes fewer concurrent requests than the web version (four goroutines instead of six) and returns empty slices rather than errors on failure. This is a deliberate design choice: on mobile, showing a partially loaded screen is preferable to showing an error message. The `lowBandwidth` flag, set by the client via the `X-Low-Bandwidth` header, further reduces the product count and image resolution.

```go
// services/mobile-bff/internal/aggregator/home.go
package aggregator

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type HomeAggregator struct {
    productClient  *serviceclient.ProductClient
    categoryClient *serviceclient.CategoryClient
    cartClient     *serviceclient.CartClient
    imageService   *ImageService // For thumbnail generation
    cache          Cache
}

func (a *HomeAggregator) GetHomeData(ctx context.Context, userID *string, lowBandwidth bool) (*MobileHomeResponse, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex
    resp := &MobileHomeResponse{}

    // Fewer parallel requests than web - conserve battery

    wg.Add(1)
    go func() {
        defer wg.Done()
        hero := a.getHero(ctx, lowBandwidth)
        mu.Lock()
        resp.Hero = hero
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        products := a.getProducts(ctx, lowBandwidth)
        mu.Lock()
        resp.Products = products
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        categories := a.getQuickCategories(ctx)
        mu.Lock()
        resp.QuickCategories = categories
        mu.Unlock()
    }()

    if userID != nil {
        wg.Add(1)
        go func() {
            defer wg.Done()
            count := a.getCartCount(ctx, *userID)
            mu.Lock()
            resp.CartCount = count
            mu.Unlock()
        }()
    }

    wg.Wait()
    return resp, nil
}

func (a *HomeAggregator) getProducts(ctx context.Context, lowBandwidth bool) []*MobileProductCard {
    // Fewer products for mobile
    limit := 8
    if lowBandwidth {
        limit = 4
    }

    cacheKey := fmt.Sprintf("mobile:home:products:%d", limit)
    var cards []*MobileProductCard
    if err := a.cache.Get(ctx, cacheKey, &cards); err == nil {
        return cards
    }

    products, err := a.productClient.List(ctx, serviceclient.ProductListOptions{
        Limit:  limit,
        SortBy: "featured",
    })
    if err != nil {
        return []*MobileProductCard{}
    }

    cards = make([]*MobileProductCard, len(products.Products))
    for i, p := range products.Products {
        cards[i] = a.transformToMobileCard(p, lowBandwidth)
    }

    a.cache.Set(ctx, cacheKey, cards, 2*time.Minute)
    return cards
}

func (a *HomeAggregator) transformToMobileCard(p *serviceclient.Product, lowBandwidth bool) *MobileProductCard {
    // Truncate name for mobile display
    name := p.Name
    if len(name) > 30 {
        name = name[:27] + "..."
    }

    // Get appropriate image size
    var imageURL string
    if lowBandwidth {
        imageURL = a.imageService.GetThumbnail(p.Images[0], 100) // 100px
    } else {
        imageURL = a.imageService.GetThumbnail(p.Images[0], 200) // 200px
    }

    return &MobileProductCard{
        ID:       p.ID,
        Name:     name,
        PriceCents: p.PriceCents,
        ImageURL: imageURL,
        Rating:   p.Rating,
        InStock:  p.Stock > 0,
    }
}
```

### Junior -> FAANG: Mobile Constraints as Design Inputs

Mobile BFF design starts with constraints, not with copying the web BFF and removing fields. The four constraints that drive every design decision are: bandwidth (cellular networks can be 50-200x slower than wired connections), battery (radio usage for large payloads drains battery faster than computation), latency (round-trip times on 4G can be 100-200ms versus 10-20ms on WiFi), and screen size (a 390px wide screen cannot display 80-character product names or 400x400 images usefully).

Each constraint maps to a design decision. Bandwidth: fewer fields, smaller images, gzip compression. Battery: fewer round trips, pre-aggregation at the BFF instead of multiple client calls. Latency: aggressive caching with longer TTLs, stale-while-revalidate for catalog data. Screen size: truncated text fields, thumbnail image URLs, minimal navigation structure.

The `lowBandwidth` flag controlled by the `X-Low-Bandwidth` header is the right pattern. The client knows its network state better than the BFF does. Expose a mechanism for the client to declare its constraint level and let the BFF adjust. The alternative (server-side network inference from IP ranges or connection speed headers) is less reliable and harder to test.

A first-job interview mistake is not knowing the standard network quality headers (`ECT`, `Save-Data`, `Downlink`). These are W3C standard headers that Chrome and some browsers send automatically. Knowing them signals that you have thought about real mobile production scenarios, not just toy examples.

### Senior @ FAANG: Mobile BFF Reliability and Offline Resilience

At senior level the mobile BFF has two reliability concerns that the web BFF does not: offline resilience and push notification coordination.

Offline resilience: mobile apps frequently operate with intermittent or no connectivity. The BFF design should support cache headers that allow clients to serve cached responses while offline. `Cache-Control: max-age=300, stale-while-revalidate=600` tells the client it can use the cached response for 5 minutes without revalidating, and can continue using it for up to 10 minutes while revalidating in the background. This is implemented at the BFF response header level, not in the client code, which means the BFF team controls the staleness policy.

Push notification coordination: when a mobile BFF serves personalized data, changes to that data (price drops, stock changes, order status updates) may need to trigger push notifications to the app. At FAANG scale this is implemented via an event bus: the product service publishes a `price_changed` event, a notification service consumes it and determines which users have that product in their wishlist, and sends a push notification. The mobile BFF is not involved in this path, which is correct. Do not put push notification logic in the BFF. The BFF's responsibility ends when the HTTP response is sent.

At staff level, the mobile BFF is often the service where payload size budgets are formally enforced. A budget might state: "The homepage response must not exceed 20 KB compressed." This budget is enforced in CI by a test that serializes the maximum expected response, gzip-compresses it, and fails the build if the result exceeds the budget. Establishing payload budgets and CI enforcement is a platform engineering contribution that benefits every mobile client without requiring each team to independently discover the need.

---
