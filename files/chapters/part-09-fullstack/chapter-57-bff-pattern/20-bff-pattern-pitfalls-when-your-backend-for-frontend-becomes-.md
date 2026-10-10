## BFF Pattern Pitfalls: When Your Backend for Frontend Becomes a Bottleneck

### Pitfall 1: BFF Becoming a Distributed Monolith

**Incident Report**: Mobile BFF started taking 30+ seconds to respond during peak traffic. Investigation revealed the BFF was making 47 synchronous calls to backend services for a single screen load, creating a massive serial dependency chain.

```go
// WRONG: Sequential calls to all services
func (b *MobileBFF) GetHomeScreen(ctx context.Context, userID string) (*HomeScreen, error) {
    // Each call waits for previous to complete
    user, err := b.userService.GetUser(ctx, userID)          // 50ms
    if err != nil { return nil, err }

    preferences, err := b.prefService.GetPreferences(ctx, userID)  // 30ms
    if err != nil { return nil, err }

    recommendations, err := b.recService.GetRecommendations(ctx, userID)  // 200ms
    if err != nil { return nil, err }

    orders, err := b.orderService.GetRecentOrders(ctx, userID)  // 80ms
    if err != nil { return nil, err }

    notifications, err := b.notifService.GetUnread(ctx, userID)  // 40ms
    if err != nil { return nil, err }

    // Problem: Total time = 50+30+200+80+40 = 400ms minimum
    // With network variance: easily 1-2 seconds
    return &HomeScreen{User: user, Preferences: preferences, ...}, nil
}

// CORRECT: Parallel calls with graceful degradation
func (b *MobileBFF) GetHomeScreen(ctx context.Context, userID string) (*HomeScreen, error) {
    ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
    defer cancel()

    result := &HomeScreen{}
    var wg sync.WaitGroup
    var mu sync.Mutex
    errors := make(map[string]error)

    // Critical data - must succeed
    wg.Add(1)
    go func() {
        defer wg.Done()
        user, err := b.userService.GetUser(ctx, userID)
        mu.Lock()
        if err != nil {
            errors["user"] = err
        } else {
            result.User = user
        }
        mu.Unlock()
    }()

    // Non-critical data - can fail gracefully
    wg.Add(1)
    go func() {
        defer wg.Done()
        recs, err := b.recService.GetRecommendations(ctx, userID)
        mu.Lock()
        if err != nil {
            // Use cached or default recommendations
            result.Recommendations = b.getDefaultRecommendations()
        } else {
            result.Recommendations = recs
        }
        mu.Unlock()
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        orders, err := b.orderService.GetRecentOrders(ctx, userID)
        mu.Lock()
        if err != nil {
            // Show empty state, not error
            result.RecentOrders = []*Order{}
            result.OrdersUnavailable = true
        } else {
            result.RecentOrders = orders
        }
        mu.Unlock()
    }()

    wg.Wait()

    // Only fail if critical data missing
    if errors["user"] != nil {
        return nil, fmt.Errorf("failed to load user: %w", errors["user"])
    }

    // Total time = max(individual calls) ≈ 200ms
    return result, nil
}
```

### Pitfall 2: Response Transformation Memory Explosion

**Incident Report**: Web BFF crashed with OOM during flash sale. The BFF was loading entire product catalogs into memory to transform them for frontend consumption, with no streaming or pagination.

```go
// WRONG: Loading everything into memory
func (b *WebBFF) GetProductCatalog(ctx context.Context, categoryID string) (*CatalogResponse, error) {
    // Problem: Category might have 100,000 products
    products, err := b.productService.GetAllProducts(ctx, categoryID)
    if err != nil {
        return nil, err
    }

    // Transform all products in memory
    webProducts := make([]*WebProduct, len(products))
    for i, p := range products {
        webProducts[i] = b.transformProduct(p)  // Each product expands 3x in size
    }

    // Sort in memory
    sort.Slice(webProducts, func(i, j int) bool {
        return webProducts[i].Relevance > webProducts[j].Relevance
    })

    return &CatalogResponse{Products: webProducts}, nil
    // Memory: 100,000 products × 10KB = 1GB per request
}

// CORRECT: Streaming transformation with bounded memory
func (b *WebBFF) GetProductCatalog(ctx context.Context, categoryID string, page, pageSize int) (*CatalogResponse, error) {
    // Request only what's needed
    req := &ProductQuery{
        CategoryID: categoryID,
        Offset:     page * pageSize,
        Limit:      pageSize,
        SortBy:     "relevance",  // Let backend sort
    }

    // Stream products from backend
    stream, err := b.productService.StreamProducts(ctx, req)
    if err != nil {
        return nil, err
    }
    defer stream.Close()

    webProducts := make([]*WebProduct, 0, pageSize)

    for {
        product, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, err
        }

        // Transform one at a time
        webProducts = append(webProducts, b.transformProduct(product))
    }

    // Get total count separately (cached)
    total, _ := b.productService.GetProductCount(ctx, categoryID)

    return &CatalogResponse{
        Products:   webProducts,
        Page:       page,
        PageSize:   pageSize,
        TotalCount: total,
        HasMore:    (page+1)*pageSize < total,
    }, nil
    // Memory: pageSize × 10KB = 200KB per request (with pageSize=20)
}

// For very large responses, stream to client
func (b *WebBFF) StreamProductCatalog(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    categoryID := r.URL.Query().Get("category")

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Transfer-Encoding", "chunked")

    encoder := json.NewEncoder(w)

    // Write opening bracket
    w.Write([]byte(`{"products":[`))

    stream, _ := b.productService.StreamProducts(ctx, &ProductQuery{CategoryID: categoryID})
    defer stream.Close()

    first := true
    for {
        product, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            break
        }

        if !first {
            w.Write([]byte(","))
        }
        first = false

        encoder.Encode(b.transformProduct(product))

        // Flush periodically for streaming
        if flusher, ok := w.(http.Flusher); ok {
            flusher.Flush()
        }
    }

    w.Write([]byte("]}"))
}
```

### Pitfall 3: BFF Cache Inconsistency Across Platform Versions

**Incident Report**: iOS and Android users saw different prices for the same product. Each platform BFF had its own cache with different TTLs, and a price change only propagated to iOS cache first.

```go
// WRONG: Independent caches per BFF
// mobile-bff/cache.go
type MobileBFFCache struct {
    redis *redis.Client
    ttl   time.Duration  // 5 minutes
}

func (c *MobileBFFCache) GetProduct(ctx context.Context, id string) (*Product, error) {
    key := fmt.Sprintf("mobile:product:%s", id)  // mobile-specific key
    // Cache hit returns stale data
}

// web-bff/cache.go (separate deployment)
type WebBFFCache struct {
    redis *redis.Client
    ttl   time.Duration  // 1 minute (different!)
}

func (c *WebBFFCache) GetProduct(ctx context.Context, id string) (*Product, error) {
    key := fmt.Sprintf("web:product:%s", id)  // web-specific key
    // Different cache, different data
}

// CORRECT: Shared cache layer with platform-specific transformations
// shared/cache.go
type SharedCache struct {
    redis       *redis.Client
    invalidator *CacheInvalidator
}

func (c *SharedCache) GetProduct(ctx context.Context, id string) (*Product, error) {
    // Single source of truth for raw product data
    key := fmt.Sprintf("product:%s", id)

    data, err := c.redis.Get(ctx, key).Bytes()
    if err == redis.Nil {
        // Cache miss - fetch and populate
        product, err := c.productService.GetProduct(ctx, id)
        if err != nil {
            return nil, err
        }

        data, _ = json.Marshal(product)
        c.redis.Set(ctx, key, data, 5*time.Minute)
        return product, nil
    }

    var product Product
    json.Unmarshal(data, &product)
    return &product, nil
}

// BFFs transform shared data for their platform
// mobile-bff/product.go
func (b *MobileBFF) GetProduct(ctx context.Context, id string) (*MobileProduct, error) {
    // Get from shared cache
    product, err := b.sharedCache.GetProduct(ctx, id)
    if err != nil {
        return nil, err
    }

    // Transform for mobile (this transformation can be cached separately if expensive)
    return b.transformForMobile(product), nil
}

// Cache invalidation propagates to all BFFs
type CacheInvalidator struct {
    pubsub *redis.PubSub
}

func (i *CacheInvalidator) InvalidateProduct(ctx context.Context, productID string) {
    // Broadcast invalidation
    i.redis.Publish(ctx, "cache:invalidate", fmt.Sprintf("product:%s", productID))
}

func (i *CacheInvalidator) Listen(ctx context.Context, cache *SharedCache) {
    ch := i.pubsub.Channel()
    for msg := range ch {
        cache.redis.Del(ctx, msg.Payload)
    }
}
```

### Pitfall 4: Authentication Token Handling Across BFF Boundaries

**Incident Report**: Security audit found that the BFF was forwarding user JWT tokens to all backend services, including third-party integrations. When a third-party service was compromised, attacker gained access to all user sessions.

```go
// WRONG: Forwarding user tokens everywhere
func (b *BFF) callBackendService(ctx context.Context, service, path string) ([]byte, error) {
    // Extract user's JWT from context
    token := auth.TokenFromContext(ctx)

    req, _ := http.NewRequestWithContext(ctx, "GET", service+path, nil)
    // Problem: User's token forwarded to all services
    req.Header.Set("Authorization", "Bearer "+token)

    return b.httpClient.Do(req)
}

// CORRECT: Service-to-service auth with scoped tokens
type ServiceAuth struct {
    privateKey    *rsa.PrivateKey
    tokenCache    *sync.Map
    tokenLifetime time.Duration
}

func (b *BFF) callBackendService(ctx context.Context, service, path string, scopes []string) ([]byte, error) {
    // Get user context but create service token
    userClaims := auth.ClaimsFromContext(ctx)

    // Create scoped service token
    serviceToken, err := b.serviceAuth.CreateServiceToken(ServiceTokenRequest{
        CallerService: "web-bff",
        TargetService: service,
        UserID:        userClaims.UserID,
        Scopes:        scopes,  // Only permissions needed for this call
        ExpiresIn:     30 * time.Second,
    })
    if err != nil {
        return nil, err
    }

    req, _ := http.NewRequestWithContext(ctx, "GET", service+path, nil)
    req.Header.Set("Authorization", "Bearer "+serviceToken)
    req.Header.Set("X-Request-ID", ctx.Value(requestIDKey).(string))

    return b.httpClient.Do(req)
}

func (s *ServiceAuth) CreateServiceToken(req ServiceTokenRequest) (string, error) {
    claims := jwt.MapClaims{
        "iss":    req.CallerService,
        "sub":    req.UserID,
        "aud":    req.TargetService,
        "scopes": req.Scopes,
        "exp":    time.Now().Add(req.ExpiresIn).Unix(),
        "iat":    time.Now().Unix(),
        "jti":    uuid.New().String(),
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    return token.SignedString(s.privateKey)
}

// Backend service validates scoped token
func (s *BackendService) ValidateToken(tokenString string) (*ServiceClaims, error) {
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Verify issuer is a known BFF
        iss := token.Claims.(jwt.MapClaims)["iss"].(string)
        if !s.isKnownBFF(iss) {
            return nil, errors.New("unknown issuer")
        }

        // Verify audience is this service
        aud := token.Claims.(jwt.MapClaims)["aud"].(string)
        if aud != s.serviceName {
            return nil, errors.New("token not for this service")
        }

        return s.getPublicKey(iss)
    })

    if err != nil {
        return nil, err
    }

    claims := token.Claims.(jwt.MapClaims)
    return &ServiceClaims{
        UserID:  claims["sub"].(string),
        Scopes:  claims["scopes"].([]string),
        Issuer:  claims["iss"].(string),
    }, nil
}
```

### Pitfall 5: BFF Error Response Leaking Internal Details

**Incident Report**: Penetration test revealed that BFF error responses contained internal service URLs, database connection strings, and stack traces that could be used for reconnaissance attacks.

```go
// WRONG: Exposing internal errors to clients
func (b *BFF) GetUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    user, err := b.userService.GetUser(ctx, userID)
    if err != nil {
        // Problem: Internal error details exposed
        return nil, fmt.Errorf("failed to fetch user from http://user-service:8080/users/%s: %w", userID, err)
        // Response: "failed to fetch user from http://user-service:8080/users/123:
        //           connection refused: dial tcp 10.0.0.5:5432: connect: no route to host"
    }
    return transformUser(user), nil
}

// CORRECT: Sanitized errors with internal logging
type BFFError struct {
    Code       string `json:"code"`
    Message    string `json:"message"`
    RequestID  string `json:"request_id"`
    internalErr error  // Never serialized
}

func (e *BFFError) Error() string {
    return e.Message
}

func (b *BFF) GetUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
    requestID := ctx.Value(requestIDKey).(string)

    user, err := b.userService.GetUser(ctx, userID)
    if err != nil {
        // Log full details internally
        b.logger.Error("user service call failed",
            zap.String("request_id", requestID),
            zap.String("user_id", userID),
            zap.String("service", "user-service"),
            zap.Error(err),
        )

        // Return sanitized error to client
        return nil, &BFFError{
            Code:        "USER_FETCH_FAILED",
            Message:     "Unable to load user profile. Please try again.",
            RequestID:   requestID,
            internalErr: err,
        }
    }

    return transformUser(user), nil
}

// Error handler middleware
func (b *BFF) ErrorHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                requestID := r.Context().Value(requestIDKey).(string)

                // Log full panic details
                b.logger.Error("panic recovered",
                    zap.String("request_id", requestID),
                    zap.Any("panic", rec),
                    zap.String("stack", string(debug.Stack())),
                )

                // Return generic error to client
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusInternalServerError)
                json.NewEncoder(w).Encode(map[string]string{
                    "code":       "INTERNAL_ERROR",
                    "message":    "An unexpected error occurred",
                    "request_id": requestID,
                })
            }
        }()

        next.ServeHTTP(w, r)
    })
}

// Map internal errors to client-safe codes
var errorCodeMap = map[error]string{
    ErrUserNotFound:     "USER_NOT_FOUND",
    ErrProductOutOfStock: "OUT_OF_STOCK",
    ErrPaymentDeclined:  "PAYMENT_DECLINED",
    // context.DeadlineExceeded maps to generic timeout
}

func mapToClientError(err error, requestID string) *BFFError {
    for knownErr, code := range errorCodeMap {
        if errors.Is(err, knownErr) {
            return &BFFError{
                Code:      code,
                Message:   userFriendlyMessage(code),
                RequestID: requestID,
            }
        }
    }

    // Default to generic error
    return &BFFError{
        Code:      "SERVICE_ERROR",
        Message:   "Something went wrong. Please try again later.",
        RequestID: requestID,
    }
}
```

### Quick Reference: BFF Pattern Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Distributed monolith | High latency, serial dependencies | Parallel calls with graceful degradation |
| Memory explosion | OOM during high load | Streaming, pagination, bounded buffers |
| Cache inconsistency | Different data across platforms | Shared cache layer with invalidation |
| Token forwarding | Security breach cascade | Scoped service-to-service tokens |
| Error leakage | Internal details exposed | Sanitized responses with internal logging |

### Junior -> FAANG: Incident Post-Mortems as Learning Material

Each pitfall in this file is written as an incident report. This is the format used in production post-mortems. Reading post-mortems is one of the most valuable learning activities available to junior engineers, because they document real failure modes and their root causes rather than textbook abstractions.

The OOM incident (Pitfall 2) has a specific root cause: loading all products into memory before paginating. The fix (request only what is needed, stream the response) applies to any endpoint that handles unbounded collections. Memorize the detection pattern: if a function signature returns `[]*SomeType` and calls a service method that also returns `[]*SomeType` without a `Limit` parameter, it is loading potentially unbounded data.

The cache inconsistency incident (Pitfall 3) has a root cause that is invisible in the code for each individual BFF (each cache looks correct in isolation) but visible only when you look at the system as a whole (two independent caches for the same data). The fix (shared cache layer with shared keys) requires thinking across service boundaries, which is a skill that develops with experience. Start developing it now by always asking: "If another service also needs this data, what key would it use to cache it? Would that key conflict with mine or duplicate it?"

The token forwarding security incident (Pitfall 4) is a design mistake that typically survives multiple code reviews because reviewers check whether auth is present, not whether it is the right type of auth. Build the habit of asking "where did this token come from and where should it go?" during every auth-related code review.

### Senior @ FAANG: Root Cause Analysis and Prevention at Platform Scale

At senior level, incident post-mortems generate action items that span services and teams. A single OOM incident in the web BFF generates action items for the BFF team (fix the unbounded load), the shared library team (add `Limit` parameter validation to the base client), the platform team (add memory usage alerts for all BFFs), and the product service team (add a maximum page size enforcement to the API). Each action item prevents the same class of failure across the entire platform, not just the one BFF where it was discovered.

The sequential call incident (Pitfall 1) is a systemic detection problem. Code review can catch it when the pattern is obvious (loop with service call inside), but it misses it when the sequential calls are hidden across function boundaries (function A calls B which calls C which calls D, each function looking sequential in isolation). The systemic detection requires distributed tracing: a waterfall view of a single BFF request that shows the timing of every downstream call. If calls are sequential, the waterfall shows them as a staircase. If parallel, they overlap. Mandating distributed tracing for all BFF services and establishing a "no staircase" norm in code review is a staff-level platform contribution.

The token forwarding incident (Pitfall 4) has a prevention that goes beyond policy and code review. At platform scale, implement a service mesh policy (Istio authorization policy or Envoy RBAC) that rejects any request to an internal service that presents a user-issued JWT rather than a service-issued JWT. This makes forwarding a user token mechanically impossible rather than just prohibited by policy. The mesh enforces the boundary without requiring every code reviewer to know the policy. Mechanically impossible is always more reliable than policy-enforced at scale.

At staff level, the quick reference table at the bottom of this file is the starting point for a platform-wide BFF reliability checklist. Each row becomes a compliance check that runs automatically in CI (static analysis for sequential calls, payload size checks, cache key audits) or in periodic platform reviews (manual review of auth token flow for all BFF services). Building this automated compliance checking is the work that multiplies a senior engineer's impact across every team using the BFF pattern.

---
