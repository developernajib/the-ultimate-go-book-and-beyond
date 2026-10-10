## Interview Questions

### Question 1: When would you choose BFF over a general-purpose API? What are the tradeoffs?

**What FAANG expects:** Sam Newman's original framing: one BFF per experience, owned by the team that ships that experience. Multiple distinct frontends with different data shapes, aggregation across services, and client-specific auth flows justify BFFs. A single SPA does not. Bonus for naming the death-spiral failure mode (BFFs grow into shared monoliths when ownership blurs) and for contrasting with GraphQL Federation as the "one gateway, per-subgraph ownership" alternative.

**Answer:**

```go
/*
BFF Decision Framework:

USE BFF WHEN:
┌────────────────────────────────────────────────────────────────────┐
│ 1. Multiple distinct frontends with different data needs           │
│    - Web needs rich data with relationships                        │
│    - Mobile needs minimal data (bandwidth/battery)                 │
│    - Admin needs different access patterns                         │
│                                                                    │
│ 2. Frontend teams want autonomy                                    │
│    - Can evolve their API without coordinating                     │
│    - Faster feature development                                    │
│                                                                    │
│ 3. Complex aggregation from multiple services                      │
│    - Dashboard that pulls from 5+ services                         │
│    - Reduce client complexity                                      │
│                                                                    │
│ 4. Different authentication/authorization per client               │
│    - Mobile uses OAuth refresh tokens                              │
│    - Admin requires MFA                                            │
│    - TV uses device codes                                          │
│                                                                    │
│ 5. Platform-specific optimizations                                 │
│    - Image sizes for device screens                                │
│    - Network quality adaptations                                   │
│    - Offline support requirements                                  │
└────────────────────────────────────────────────────────────────────┘

DON'T USE BFF WHEN:
┌────────────────────────────────────────────────────────────────────┐
│ 1. Single frontend application                                     │
│    - Just build a good REST/GraphQL API                            │
│                                                                    │
│ 2. All clients need same data                                      │
│    - BFF adds unnecessary complexity                               │
│                                                                    │
│ 3. Small team                                                      │
│    - Maintaining multiple BFFs is overhead                         │
│                                                                    │
│ 4. Simple CRUD without aggregation                                 │
│    - Direct backend access is simpler                              │
└────────────────────────────────────────────────────────────────────┘

TRADEOFFS:
*/

// Example architecture decision
type ArchitectureDecision struct {
    Option      string
    Pros        []string
    Cons        []string
    UseCases    []string
}

func GetBFFTradeoffs() []ArchitectureDecision {
    return []ArchitectureDecision{
        {
            Option: "BFF Per Frontend",
            Pros: []string{
                "Optimized responses for each client",
                "Frontend team autonomy",
                "Independent deployment and scaling",
                "Client-specific caching strategies",
                "Simplified frontend code",
            },
            Cons: []string{
                "More services to maintain",
                "Potential code duplication",
                "Need shared libraries for consistency",
                "More complex deployment pipeline",
                "Requires good team boundaries",
            },
            UseCases: []string{
                "Netflix (TV, Mobile, Web all different)",
                "Spotify (Desktop, Mobile, Car)",
                "E-commerce (Customer Web, Mobile, Admin)",
            },
        },
        {
            Option: "Single API + Client Adaptation",
            Pros: []string{
                "Single codebase to maintain",
                "Consistent behavior across clients",
                "Simpler deployment",
                "Shared bug fixes",
            },
            Cons: []string{
                "Bloated responses (overfetching)",
                "Complex API trying to serve everyone",
                "Frontend team dependency on backend",
                "Harder to optimize per client",
            },
            UseCases: []string{
                "Simple apps with similar clients",
                "Internal tools",
                "MVPs and prototypes",
            },
        },
        {
            Option: "GraphQL as Universal API",
            Pros: []string{
                "Clients request exactly what they need",
                "Single endpoint",
                "Strong typing",
                "Introspection",
            },
            Cons: []string{
                "Caching complexity (POST requests)",
                "Query complexity attacks",
                "Learning curve",
                "N+1 query risks",
            },
            UseCases: []string{
                "GitHub API",
                "Shopify Storefront",
                "Internal APIs with varied clients",
            },
        },
    }
}

/*
Real-World Example - E-Commerce:

Without BFF:
┌─────────┐    GET /products?include=reviews,category,inventory
│  Web    │ ─────────────────────────────────────────────────────►
│  App    │ ◄───────────── 50KB response (needs all data)
└─────────┘

┌─────────┐    GET /products?include=reviews,category,inventory
│ Mobile  │ ─────────────────────────────────────────────────────►
│  App    │ ◄───────────── 50KB response (only needs 5KB)
└─────────┘
                              ↓
                    Mobile wastes bandwidth
                    Mobile drains battery parsing unused data

With BFF:
┌─────────┐    GET /api/products
│  Web    │ ─────────────────────► ┌─────────┐
│  App    │ ◄───────── 50KB ────── │ Web BFF │ → aggregates full data
└─────────┘                        └─────────┘

┌─────────┐    GET /api/products
│ Mobile  │ ─────────────────────► ┌──────────┐
│  App    │ ◄───────── 5KB ─────── │Mobile BFF│ → minimal data + thumbnails
└─────────┘                        └──────────┘
*/
```

**Follow-ups:**
- *What stops a BFF from becoming a shared monolith over time?* Ownership. Each BFF must be owned by the team that ships the client. If two teams start editing the same BFF, you have already lost. Enforce through CODEOWNERS and separate deploy pipelines.
- *BFF vs API Gateway?* Gateway = cross-cutting concerns (auth, rate limit, routing) for many clients. BFF = client-specific aggregation and shaping. Often both in the path: gateway in front, BFF per experience behind it.
- *How does GraphQL Federation compete with BFF?* Federation gives you one endpoint with per-subgraph ownership. BFF gives per-client endpoint with per-client ownership. Pick BFF when clients diverge more than services do. Pick federation when services diverge more than clients do.

### Question 2: How would you handle version compatibility when multiple BFFs consume the same backend services?

**What FAANG expects:** Contract testing in CI (Pact, `go-playground/contract`), semantic versioning on backend APIs, adapter pattern inside BFFs to hide backend churn from clients, feature flags for gradual migration, and deprecation windows with clear timelines. Bonus for mentioning schema registries (Buf for Protobuf, Apicurio/Confluent for events) and for recognizing that *consumer-driven* contract tests are the right direction (BFFs publish expectations, backend CI enforces them).

**Answer:**

```go
// Version compatibility requires careful API design and client management

package versioning

import (
    "context"
    "encoding/json"
    "net/http"
)

// Strategy 1: Backend services support multiple versions
type VersionedProductClient struct {
    baseClient *BaseClient
    version    string
}

func (c *VersionedProductClient) GetProduct(ctx context.Context, id string) (*Product, error) {
    req, _ := http.NewRequestWithContext(ctx, "GET", c.baseClient.baseURL+"/products/"+id, nil)

    // Request specific API version
    req.Header.Set("Accept-Version", c.version) // "v1", "v2", etc.
    // Or use URL versioning
    // c.baseClient.baseURL = "http://product-service/v2"

    var product Product
    if err := c.baseClient.Do(req, &product); err != nil {
        return nil, err
    }
    return &product, nil
}

// Strategy 2: BFF adapts to backend changes
type ProductAdapter struct {
    client *ProductClient
}

// BFF maintains stable interface even if backend changes
func (a *ProductAdapter) GetProductForWeb(ctx context.Context, id string) (*WebProduct, error) {
    // Backend might return v1 or v2 format
    raw, err := a.client.GetProductRaw(ctx, id)
    if err != nil {
        return nil, err
    }

    // Detect version and adapt
    if _, hasNewField := raw["new_pricing"]; hasNewField {
        return a.adaptV2(raw)
    }
    return a.adaptV1(raw)
}

func (a *ProductAdapter) adaptV1(raw map[string]any) (*WebProduct, error) {
    return &WebProduct{
        ID:    raw["id"].(string),
        Name:  raw["name"].(string),
        PriceCents: int64(raw["price_cents"].(float64)), // JSON numbers arrive as float64
        // V1 had single price field
    }, nil
}

func (a *ProductAdapter) adaptV2(raw map[string]any) (*WebProduct, error) {
    pricing := raw["new_pricing"].(map[string]any)
    return &WebProduct{
        ID:            raw["id"].(string),
        Name:          raw["name"].(string),
        PriceCents:         int64(pricing["current_cents"].(float64)),
        OriginalPriceCents: int64(pricing["original_cents"].(float64)),
        // V2 has structured pricing
    }, nil
}

// Strategy 3: Contract testing between BFF and backends
type ContractTest struct {
    ServiceName string
    Version     string
    Contracts   []Contract
}

type Contract struct {
    Endpoint     string
    Method       string
    Request      any
    Response     any
    StatusCode   int
}

// Each BFF defines its contract expectations
func GetWebBFFContracts() *ContractTest {
    return &ContractTest{
        ServiceName: "product-service",
        Version:     "1.0.0",
        Contracts: []Contract{
            {
                Endpoint:   "/products/{id}",
                Method:     "GET",
                Request:    nil,
                Response: map[string]any{
                    "id":    "string",
                    "name":  "string",
                    "price": "number",
                    // Define expected fields
                },
                StatusCode: 200,
            },
            {
                Endpoint: "/products/batch",
                Method:   "POST",
                Request: map[string]any{
                    "ids": []string{},
                },
                Response: []map[string]any{
                    {"id": "string", "name": "string"},
                },
                StatusCode: 200,
            },
        },
    }
}

// Run in CI/CD to catch breaking changes
func (ct *ContractTest) Validate(serviceURL string) error {
    for _, contract := range ct.Contracts {
        if err := ct.validateContract(serviceURL, contract); err != nil {
            return fmt.Errorf("contract violation for %s %s: %w",
                contract.Method, contract.Endpoint, err)
        }
    }
    return nil
}

// Strategy 4: Feature flags for gradual migration
type FeatureFlags struct {
    client *FeatureFlagClient
}

func (b *WebBFF) GetProduct(ctx context.Context, id string) (*WebProduct, error) {
    // Check if new backend version is enabled for this request
    if b.features.IsEnabled(ctx, "use_product_service_v2") {
        return b.getProductV2(ctx, id)
    }
    return b.getProductV1(ctx, id)
}

func (b *WebBFF) getProductV1(ctx context.Context, id string) (*WebProduct, error) {
    product, err := b.productClientV1.GetProduct(ctx, id)
    if err != nil {
        return nil, err
    }
    return transformV1(product), nil
}

func (b *WebBFF) getProductV2(ctx context.Context, id string) (*WebProduct, error) {
    product, err := b.productClientV2.GetProduct(ctx, id)
    if err != nil {
        // Fallback to V1 if V2 fails
        return b.getProductV1(ctx, id)
    }
    return transformV2(product), nil
}

/*
Best Practices for BFF Version Compatibility:

1. Semantic Versioning for Backend Services
   - MAJOR: Breaking changes (BFFs must update)
   - MINOR: New features, backwards compatible
   - PATCH: Bug fixes

2. Contract Testing in CI/CD
   - BFFs publish expected contracts
   - Backend changes are tested against all BFF contracts
   - Breaking change = failed build

3. Adapter Pattern in BFFs
   - BFF maintains stable external interface
   - Internal adapters handle backend version differences

4. Feature Flags for Migration
   - Gradually roll out new backend versions
   - Quick rollback if issues arise

5. Deprecation Windows
   - Backend announces deprecation with timeline
   - BFFs have time to migrate
   - Old versions removed after window
*/
```

**Follow-ups:**
- *Consumer-driven contracts, what does that mean concretely?* Each BFF publishes a Pact file describing the requests it sends and responses it expects. The backend's CI runs those pacts against the current build. A breaking change fails *the backend's* CI, not the BFF's production.
- *Why adapter pattern inside the BFF?* It decouples the BFF's external API (stable for clients) from the backend API (unstable). Clients never see a backend migration. The adapter handles it.
- *What is the right deprecation window?* Stripe uses years for public APIs. Internal services typically use 1-2 release cycles (weeks). The rule is: long enough that no consumer is surprised, short enough that you do not maintain forever.

### Question 3: How would you design caching for a BFF that serves both authenticated and anonymous users?

**What FAANG expects:** Segment the cache key space by auth state, give anonymous traffic aggressive TTLs (shared across users), cache authenticated data per-user with short TTLs, use a hybrid (shared base + per-user overlay) for list views with per-user personalization flags. Bonus for knowing the Vary header traps (`Vary: Authorization` fragments the CDN cache per token), and for mentioning surrogate keys (Fastly Surrogate-Key, Cloudflare Cache-Tag) as the right invalidation primitive.

**Answer:**

```go
// Caching strategy must consider user context and data sensitivity

package cache

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// BFFCache implements multi-tier caching for different data types
type BFFCache struct {
    redis     *redis.Client
    local     *LocalCache
    config    CacheConfig
}

type CacheConfig struct {
    // Shared data TTLs
    StaticTTL     time.Duration // 1 hour - categories, config
    SemiStaticTTL time.Duration // 5 minutes - featured products
    DynamicTTL    time.Duration // 1 minute - trending, popular

    // User-specific data TTLs
    UserDataTTL   time.Duration // 30 seconds - cart, preferences
    SessionTTL    time.Duration // 5 minutes - auth context

    // Anonymous vs Authenticated
    AnonTTL       time.Duration // Can cache longer for anon
    AuthTTL       time.Duration // Shorter for auth (more personalized)
}

// CacheKey builder for consistent key generation
type CacheKeyBuilder struct {
    prefix string
    parts  []string
}

func NewCacheKey(prefix string) *CacheKeyBuilder {
    return &CacheKeyBuilder{prefix: prefix}
}

func (b *CacheKeyBuilder) WithUser(userID string) *CacheKeyBuilder {
    if userID != "" {
        b.parts = append(b.parts, "user:"+userID)
    } else {
        b.parts = append(b.parts, "anon")
    }
    return b
}

func (b *CacheKeyBuilder) WithResource(resourceType, resourceID string) *CacheKeyBuilder {
    b.parts = append(b.parts, fmt.Sprintf("%s:%s", resourceType, resourceID))
    return b
}

func (b *CacheKeyBuilder) WithParams(params map[string]string) *CacheKeyBuilder {
    if len(params) > 0 {
        // Hash params for consistent key
        h := sha256.New()
        for k, v := range params {
            h.Write([]byte(k + "=" + v))
        }
        b.parts = append(b.parts, "params:"+hex.EncodeToString(h.Sum(nil))[:8])
    }
    return b
}

func (b *CacheKeyBuilder) Build() string {
    key := b.prefix
    for _, part := range b.parts {
        key += ":" + part
    }
    return key
}

// Caching strategies for different data types
type CacheStrategy int

const (
    CacheShared      CacheStrategy = iota // Same for all users
    CachePerUser                          // Different per user
    CacheHybrid                           // Shared base + user overlay
    CacheNone                             // Never cache
)

// GetWithStrategy fetches data with appropriate caching
func (c *BFFCache) GetWithStrategy(
    ctx context.Context,
    key string,
    strategy CacheStrategy,
    userID string,
    ttl time.Duration,
    loader func() (any, error),
    result any,
) error {
    switch strategy {
    case CacheShared:
        return c.getShared(ctx, key, ttl, loader, result)

    case CachePerUser:
        return c.getPerUser(ctx, key, userID, ttl, loader, result)

    case CacheHybrid:
        return c.getHybrid(ctx, key, userID, ttl, loader, result)

    case CacheNone:
        data, err := loader()
        if err != nil {
            return err
        }
        return copyTo(data, result)
    }

    return fmt.Errorf("unknown cache strategy")
}

// getShared - same data for all users
func (c *BFFCache) getShared(
    ctx context.Context,
    key string,
    ttl time.Duration,
    loader func() (any, error),
    result any,
) error {
    // Try local cache first
    if c.local.Get(key, result) == nil {
        return nil
    }

    // Try Redis
    data, err := c.redis.Get(ctx, key).Bytes()
    if err == nil {
        if err := json.Unmarshal(data, result); err == nil {
            // Populate local cache
            c.local.Set(key, result, ttl/2) // Local TTL shorter
            return nil
        }
    }

    // Load from source
    loaded, err := loader()
    if err != nil {
        return err
    }

    // Store in both caches
    bytes, _ := json.Marshal(loaded)
    c.redis.Set(ctx, key, bytes, ttl)
    c.local.Set(key, loaded, ttl/2)

    return copyTo(loaded, result)
}

// getPerUser - user-specific data
func (c *BFFCache) getPerUser(
    ctx context.Context,
    key string,
    userID string,
    ttl time.Duration,
    loader func() (any, error),
    result any,
) error {
    if userID == "" {
        // Anonymous users share a cache (can't personalize)
        return c.getShared(ctx, "anon:"+key, ttl*2, loader, result)
    }

    userKey := fmt.Sprintf("user:%s:%s", userID, key)

    // Only use Redis for user data (not local - memory concerns)
    data, err := c.redis.Get(ctx, userKey).Bytes()
    if err == nil {
        return json.Unmarshal(data, result)
    }

    // Load from source
    loaded, err := loader()
    if err != nil {
        return err
    }

    // Store with shorter TTL for user data
    bytes, _ := json.Marshal(loaded)
    c.redis.Set(ctx, userKey, bytes, ttl)

    return copyTo(loaded, result)
}

// getHybrid - shared base with user-specific overlay
func (c *BFFCache) getHybrid(
    ctx context.Context,
    key string,
    userID string,
    ttl time.Duration,
    loader func() (any, error),
    result any,
) error {
    type HybridResult struct {
        Base any `json:"base"`
        User any `json:"user,omitempty"`
    }

    // This is useful for things like:
    // - Product list (shared) + user's "liked" status (per-user)
    // - Menu items (shared) + user's preferences (per-user)

    // Load shared base
    baseKey := "base:" + key
    var baseData any
    if err := c.getShared(ctx, baseKey, ttl, loader, &baseData); err != nil {
        return err
    }

    // Load user overlay if authenticated
    if userID != "" {
        userKey := fmt.Sprintf("user:%s:overlay:%s", userID, key)
        var userData any
        c.redis.Get(ctx, userKey).Scan(&userData)

        // Merge base + user data
        return mergeHybrid(baseData, userData, result)
    }

    return copyTo(baseData, result)
}

// Example: Product listing with hybrid caching
func (b *BFF) GetProducts(ctx context.Context, userID string, params ProductParams) (*ProductList, error) {
    // Determine cache strategy based on params
    strategy := CacheShared
    if params.Personalized {
        strategy = CacheHybrid
    }

    key := NewCacheKey("products").
        WithParams(params.ToMap()).
        Build()

    var result ProductList

    ttl := b.cache.config.SemiStaticTTL
    if userID == "" {
        ttl = b.cache.config.AnonTTL // Longer for anonymous
    }

    err := b.cache.GetWithStrategy(
        ctx,
        key,
        strategy,
        userID,
        ttl,
        func() (any, error) {
            return b.productClient.ListProducts(ctx, params)
        },
        &result,
    )

    if err != nil {
        return nil, err
    }

    // Add user-specific data overlay
    if userID != "" {
        b.addUserOverlay(ctx, userID, &result)
    }

    return &result, nil
}

func (b *BFF) addUserOverlay(ctx context.Context, userID string, products *ProductList) {
    // Get user's liked products (cached separately)
    var likedIDs []string
    likeKey := fmt.Sprintf("user:%s:likes", userID)
    b.cache.redis.SMembers(ctx, likeKey).ScanSlice(&likedIDs)

    likedSet := make(map[string]bool)
    for _, id := range likedIDs {
        likedSet[id] = true
    }

    // Overlay onto shared product data
    for _, product := range products.Items {
        product.IsLiked = likedSet[product.ID]
    }
}

/*
Cache Hierarchy for BFF:

┌──────────────────────────────────────────────────────────────────┐
│                        Cache Levels                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Level 1: Local In-Memory (per BFF instance)                     │
│  ├── Very fast (microseconds)                                    │
│  ├── Limited size (100MB)                                        │
│  ├── Not shared across instances                                 │
│  └── Best for: Static config, categories, feature flags          │
│                                                                  │
│  Level 2: Redis (shared across BFF instances)                    │
│  ├── Fast (milliseconds)                                         │
│  ├── Large capacity                                              │
│  ├── Shared across all instances                                 │
│  └── Best for: Products, search results, user preferences        │
│                                                                  │
│  Level 3: Backend Service (source of truth)                      │
│  ├── Slower (10s-100s of ms)                                     │
│  ├── Always fresh                                                │
│  └── Fallback when cache misses                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Key Design Decisions:

1. Anonymous users: Cache aggressively (same data for all)
2. Authenticated users: Cache carefully (personalized data)
3. Sensitive data: Don't cache (PII, payment info)
4. Volatile data: Short TTL or no cache (inventory, prices)
5. Stable data: Long TTL (categories, product descriptions)
*/
```

**Follow-ups:**
- *Why is `Vary: Authorization` usually wrong at the CDN?* Every token produces a unique variant, so cache hit rate collapses. Strip auth for anonymous paths, or use a session cookie hashed to a bucket. For personalized auth paths, cache at the BFF, not the CDN.
- *How do you invalidate per-user caches on logout or role change?* Surrogate keys: tag each cached entry with `user:{id}`, `role:{id}`, `tenant:{id}`. Purge by tag on event. Fastly and Cloudflare Enterprise both support this natively.
- *Should you cache authenticated responses at all?* Yes, with short TTL (30-60s) plus `stale-while-revalidate`. The hit rate even at 30s is significant on hot pages. The trade-off is a small window of stale data, which is fine for everything except balances, auth state, or inventory.

### Junior -> FAANG: Preparing for These Exact Questions

All three questions in this file have appeared in FAANG system design interviews. Prepare for them explicitly.

Question 1 (BFF vs general-purpose API) is the most common entry point. Practice the framework: problem statement (clients with divergent data needs), solution (one BFF per client, owned by client team), mechanism (parallel fan-out and transformation), trade-offs (operational overhead vs delivery speed and payload optimization). You should be able to deliver this in ninety seconds before drawing any diagrams.

Question 2 (version compatibility) trips up candidates who have not thought about multi-consumer APIs in production. The key insight is that BFFs are consumers of backend services, and consumer-driven contract testing inverts the validation direction. Backends validate against consumer expectations, not the other way around. Candidates who can name Pact or Buf as tooling for this pattern stand out.

Question 3 (caching for mixed auth state) is where the interview separates candidates who have built caching systems from candidates who have read about them. The `Vary: Authorization` trap is a real production pitfall that almost every team hits once. Knowing it before being asked signals production experience.

For all three questions, close your answer by naming the failure mode you are guarding against. Not just "I would use a circuit breaker" but "I would use a circuit breaker because without it a slow downstream service can exhaust my BFF's goroutine pool during degradation." Naming the failure mode signals that you have debugged real incidents.

### Senior @ FAANG: What Bar-Raisers Look for Beyond the Correct Answer

At senior and staff level, interviewers are not checking whether you know the right answer. They know you know the right answer. They are checking whether you think like a principal engineer: do you reason about system-level behavior, organizational dynamics, and long-term maintainability?

For Question 1, the bar-raiser follow-up is about organizational failure modes: "What stops a BFF from becoming a shared monolith over time?" The answer requires organizational thinking (CODEOWNERS, separate deploy pipelines, team ownership policy) not just technical thinking (don't put business logic in the BFF). Candidates who answer only technically demonstrate senior individual contributor thinking. Candidates who address the organizational dimension demonstrate principal-level thinking.

For Question 2, the bar-raiser follow-up is about deprecation economics: "How long should you maintain a deprecated backend API version?" This requires reasoning about consumer migration velocity, the cost of maintaining two code paths, and the organizational incentive structure. If the backend team bears all the cost of maintaining v1 but the benefit (faster migration) accrues to the BFF teams, the incentive is misaligned. The solution is a deprecation contract that makes migration speed a shared metric tracked in quarterly reviews. This is policy thinking, not engineering thinking, and it is what distinguishes L7 candidates.

For Question 3, the bar-raiser follow-up is about cache architecture at platform scale: "How do you handle cache invalidation across multiple BFF deployments when a product's price changes?" The correct answer involves event-driven invalidation (product service publishes `price_changed` event, all BFF instances subscribe and delete the relevant cache keys) rather than TTL-based staleness. It also involves the monitoring question: how do you know that invalidation is working correctly? You need a metric that tracks the latency between a price change event and the cache returning the new price. This kind of end-to-end observability thinking is the bar-raiser signal.

---
