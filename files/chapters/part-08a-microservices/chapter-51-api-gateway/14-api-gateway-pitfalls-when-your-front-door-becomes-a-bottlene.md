## 51.12 API Gateway Pitfalls: When Your Front Door Becomes a Bottleneck

### Pitfall 1: The Gateway as Central Failure Point

**Incident Report**: A company routed all traffic through a single API gateway cluster. During a DDoS attack, the gateway's rate limiter consumed all memory tracking IP addresses. The gateway crashed, taking down all 30 microservices behind it. Complete outage lasted 45 minutes.

```go
// WRONG: Gateway does too much, becomes single point of failure
func (g *Gateway) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // All these operations in the critical path
    user, _ := g.auth.ValidateToken(r.Header.Get("Authorization"))
    if !g.rateLimiter.Allow(r.RemoteAddr) {  // Unbounded memory for IPs
        http.Error(w, "rate limited", 429)
        return
    }
    transformed := g.transformer.Transform(r)  // Memory allocation
    cached := g.cache.Get(r.URL.Path)          // More memory
    if cached != nil {
        w.Write(cached)
        return
    }
    // Complex routing logic...
}

// CORRECT: Thin gateway with defense in depth
type ThinGateway struct {
    router      *Router
    healthCheck *HealthChecker
}

func (g *ThinGateway) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Gateway only does routing
    // Rate limiting is at CDN/LB layer (Cloudflare, AWS WAF)
    // Auth is validated by services or sidecars
    // Caching is at CDN layer

    route, ok := g.router.Match(r)
    if !ok {
        http.Error(w, "not found", 404)
        return
    }

    // Simple header forwarding
    r.Header.Set("X-Request-ID", uuid.New().String())
    r.Header.Set("X-Forwarded-For", r.RemoteAddr)

    // Direct proxy with minimal processing
    g.proxyTo(w, r, route.Backend)
}

// Rate limiting moved to CDN/edge
// Auth moved to sidecar or per-service
// Caching moved to CDN

// Multiple gateway instances with no shared state
// Each can handle any request independently
```

### Pitfall 2: The Request Aggregation Timeout Cascade

**Incident Report**: The gateway aggregated data from 5 services for the dashboard endpoint. Each service had a 10s timeout. One slow service caused the gateway to wait 10s, then timeout. But by then, the user had already retried twice, creating 15 parallel requests to already-stressed services.

```go
// WRONG: Sequential aggregation with independent timeouts
func (g *Gateway) GetDashboard(ctx context.Context) (*Dashboard, error) {
    // Each call has its own 10s timeout
    ctx1, _ := context.WithTimeout(ctx, 10*time.Second)
    user, _ := g.userService.GetProfile(ctx1)  // Might take 10s

    ctx2, _ := context.WithTimeout(ctx, 10*time.Second)
    orders, _ := g.orderService.GetRecent(ctx2)  // Another 10s

    ctx3, _ := context.WithTimeout(ctx, 10*time.Second)
    recommendations, _ := g.recService.Get(ctx3)  // Another 10s

    // Total possible wait: 30+ seconds!
    return &Dashboard{User: user, Orders: orders, Recs: recommendations}, nil
}

// CORRECT: Parallel aggregation with shared deadline
func (g *Gateway) GetDashboard(ctx context.Context) (*Dashboard, error) {
    // Overall deadline for entire aggregation
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    var (
        user    *User
        orders  []*Order
        recs    []*Product
        wg      sync.WaitGroup
        errOnce sync.Once
        aggErr  error
    )

    // Parallel fetches with same deadline
    wg.Add(3)

    go func() {
        defer wg.Done()
        var err error
        user, err = g.userService.GetProfile(ctx)
        if err != nil {
            errOnce.Do(func() { aggErr = fmt.Errorf("user: %w", err) })
        }
    }()

    go func() {
        defer wg.Done()
        var err error
        orders, err = g.orderService.GetRecent(ctx)
        if err != nil {
            // Orders optional - don't fail entire request
            log.Printf("orders failed: %v", err)
        }
    }()

    go func() {
        defer wg.Done()
        var err error
        recs, err = g.recService.Get(ctx)
        if err != nil {
            // Recommendations optional
            log.Printf("recs failed: %v", err)
        }
    }()

    wg.Wait()

    // User is required, others are optional
    if user == nil {
        return nil, fmt.Errorf("required service failed: %w", aggErr)
    }

    return &Dashboard{
        User:            user,
        Orders:          orders,  // May be nil
        Recommendations: recs,    // May be nil
    }, nil
}
```

### Pitfall 3: The Authentication Token Validation Bottleneck

**Incident Report**: The API gateway validated every JWT by calling an auth service. Under load, the auth service became slow (100ms → 2s). All gateway requests backed up waiting for auth validation. 99th percentile latency went from 200ms to 15s.

```go
// WRONG: Remote auth validation on every request
func (g *Gateway) AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")

        // Remote call on EVERY request
        user, err := g.authService.ValidateToken(context.Background(), token)
        if err != nil {
            http.Error(w, "unauthorized", 401)
            return
        }

        ctx := context.WithValue(r.Context(), "user", user)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// CORRECT: Local JWT validation with cached public keys
type LocalAuthValidator struct {
    publicKeys   map[string]*rsa.PublicKey
    keysMu       sync.RWMutex
    issuer       string
    refreshEvery time.Duration
}

func NewLocalAuthValidator(issuer string) *LocalAuthValidator {
    v := &LocalAuthValidator{
        publicKeys:   make(map[string]*rsa.PublicKey),
        issuer:       issuer,
        refreshEvery: 5 * time.Minute,
    }
    v.refreshKeys()
    go v.periodicRefresh()
    return v
}

func (v *LocalAuthValidator) ValidateToken(tokenString string) (*Claims, error) {
    // Parse without validation first to get key ID
    token, _, err := new(jwt.Parser).ParseUnverified(tokenString, &Claims{})
    if err != nil {
        return nil, fmt.Errorf("parse token: %w", err)
    }

    kid, ok := token.Header["kid"].(string)
    if !ok {
        return nil, errors.New("missing key ID")
    }

    // Get cached public key
    v.keysMu.RLock()
    publicKey, ok := v.publicKeys[kid]
    v.keysMu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("unknown key: %s", kid)
    }

    // Validate locally - no network call
    token, err = jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (any, error) {
        return publicKey, nil
    })
    if err != nil {
        return nil, fmt.Errorf("validate token: %w", err)
    }

    claims := token.Claims.(*Claims)

    // Validate issuer and expiry
    if claims.Issuer != v.issuer {
        return nil, errors.New("invalid issuer")
    }
    if claims.ExpiresAt.Before(time.Now()) {
        return nil, errors.New("token expired")
    }

    return claims, nil
}

func (v *LocalAuthValidator) periodicRefresh() {
    ticker := time.NewTicker(v.refreshEvery)
    for range ticker.C {
        v.refreshKeys()
    }
}

func (v *LocalAuthValidator) refreshKeys() {
    // Fetch JWKS from auth service
    resp, err := http.Get(v.issuer + "/.well-known/jwks.json")
    if err != nil {
        log.Printf("Failed to refresh keys: %v", err)
        return
    }
    defer resp.Body.Close()

    var jwks JWKS
    json.NewDecoder(resp.Body).Decode(&jwks)

    v.keysMu.Lock()
    defer v.keysMu.Unlock()

    for _, key := range jwks.Keys {
        publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(key.X5c[0]))
        if err != nil {
            continue
        }
        v.publicKeys[key.Kid] = publicKey
    }
}
```

### Pitfall 4: The Circuit Breaker Synchronized Failure

**Incident Report**: All gateway instances shared a Redis-backed circuit breaker. When one service failed, all gateway instances simultaneously opened their circuits. When the circuit closed (after 30s), all instances simultaneously sent requests, overwhelming the recovering service. This repeated in a deadly synchronized pattern.

```go
// WRONG: Globally synchronized circuit breaker
func (g *Gateway) CallService(ctx context.Context, service string, req Request) Response {
    // All instances check same Redis key
    state, _ := g.redis.Get(ctx, "circuit:"+service).Result()
    if state == "open" {
        return ErrorResponse{Code: 503, Message: "service unavailable"}
    }

    resp, err := g.client.Call(ctx, service, req)
    if err != nil {
        failures, _ := g.redis.Incr(ctx, "circuit:"+service+":failures").Result()
        if failures > 10 {
            // All instances open circuit at same time!
            g.redis.Set(ctx, "circuit:"+service, "open", 30*time.Second)
        }
        return ErrorResponse{Err: err}
    }

    return resp
}

// CORRECT: Local circuit breakers with jitter
type LocalCircuitBreaker struct {
    failures      atomic.Int64
    state         atomic.Int32  // 0=closed, 1=open, 2=half-open
    lastFailure   atomic.Int64
    openDuration  time.Duration
    halfOpenLimit int64
    threshold     int64
}

const (
    stateClosed int32 = iota
    stateOpen
    stateHalfOpen
)

func (cb *LocalCircuitBreaker) Allow() bool {
    state := cb.state.Load()

    switch state {
    case stateClosed:
        return true

    case stateOpen:
        // Add jitter to avoid thundering herd
        jitter := time.Duration(rand.Int64N(int64(cb.openDuration / 4)))
        openTime := time.Unix(0, cb.lastFailure.Load())
        if time.Since(openTime) > cb.openDuration+jitter {
            // Transition to half-open
            if cb.state.CompareAndSwap(stateOpen, stateHalfOpen) {
                cb.failures.Store(0)
            }
            return true
        }
        return false

    case stateHalfOpen:
        // Allow limited requests to test recovery
        return cb.failures.Load() < cb.halfOpenLimit
    }

    return false
}

func (cb *LocalCircuitBreaker) RecordSuccess() {
    if cb.state.Load() == stateHalfOpen {
        // Successful request in half-open → close circuit
        cb.state.Store(stateClosed)
        cb.failures.Store(0)
    }
}

func (cb *LocalCircuitBreaker) RecordFailure() {
    failures := cb.failures.Add(1)
    cb.lastFailure.Store(time.Now().UnixNano())

    state := cb.state.Load()
    switch state {
    case stateClosed:
        if failures >= cb.threshold {
            cb.state.Store(stateOpen)
        }
    case stateHalfOpen:
        // Any failure in half-open → back to open
        cb.state.Store(stateOpen)
    }
}

// Each gateway instance has its own circuit breaker state
// They will open/close at slightly different times due to:
// 1. Different request patterns
// 2. Jitter in recovery timing
// This prevents synchronized avalanche
```

### Pitfall 5: The Service Discovery Cache Stale Data

**Incident Report**: Gateway cached service endpoints from Consul for 5 minutes. When a service scaled down, traffic continued routing to terminated instances. 30% of requests failed for up to 5 minutes after each scale event.

```go
// WRONG: Long TTL cache for service discovery
type ServiceDiscovery struct {
    cache    map[string][]string
    cacheTTL time.Duration  // 5 minutes - too long!
}

func (sd *ServiceDiscovery) GetEndpoints(service string) []string {
    if cached, ok := sd.cache[service]; ok {
        return cached  // May be stale
    }

    endpoints := sd.fetchFromConsul(service)
    sd.cache[service] = endpoints
    return endpoints
}

// CORRECT: Watch-based discovery with immediate updates
type WatchingServiceDiscovery struct {
    consul    *consul.Client
    endpoints sync.Map  // service -> []string
}

func (sd *WatchingServiceDiscovery) Start(ctx context.Context) {
    // Watch for changes to all services we care about
    services := []string{"user-service", "order-service", "product-service"}

    for _, service := range services {
        go sd.watchService(ctx, service)
    }
}

func (sd *WatchingServiceDiscovery) watchService(ctx context.Context, service string) {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        // Blocking query - returns immediately on change
        services, meta, err := sd.consul.Health().Service(service, "", true, &consul.QueryOptions{
            WaitIndex: lastIndex,
            WaitTime:  30 * time.Second,  // Long poll
        })

        if err != nil {
            log.Printf("Watch error for %s: %v", service, err)
            time.Sleep(time.Second)
            continue
        }

        if meta.LastIndex > lastIndex {
            lastIndex = meta.LastIndex

            endpoints := make([]string, len(services))
            for i, svc := range services {
                endpoints[i] = fmt.Sprintf("%s:%d", svc.Service.Address, svc.Service.Port)
            }

            sd.endpoints.Store(service, endpoints)
            log.Printf("Updated %s endpoints: %v", service, endpoints)
        }
    }
}

func (sd *WatchingServiceDiscovery) GetEndpoints(service string) []string {
    if eps, ok := sd.endpoints.Load(service); ok {
        return eps.([]string)
    }
    return nil
}
```

### Quick Reference: API Gateway Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Gateway SPOF | Complete outage on gateway failure | Thin gateway, concerns at edge/sidecar |
| Aggregation timeout cascade | Long waits, retry storms | Parallel calls with shared deadline |
| Auth validation bottleneck | High latency under load | Local JWT validation with cached keys |
| Synchronized circuit breaker | Thundering herd on recovery | Local breakers with jitter |
| Stale service discovery | Requests to dead instances | Watch-based discovery with immediate updates |

### Junior -> FAANG: Pitfall Recognition for System Design Interviews

Each pitfall in this section has a corresponding system design interview question. Learning to recognize the pitfall from the question framing helps you answer before the interviewer needs to hint.

"Your gateway is a single point of failure. How do you address that?" The answer has two parts: redundancy (multiple gateway instances behind a load balancer with no shared mutable state between them) and defense in depth (rate limiting at CDN, auth validation locally in the gateway without remote calls, caching to reduce blast radius when an upstream is slow).

"You have an aggregation endpoint. One upstream is slow. How does that affect your gateway?" The answer is Pitfall 2: without a shared outer deadline and parallel execution, a slow optional upstream holds the response open for all clients. Demonstrate that you know the fix: one shared `context.WithTimeout`, all calls in parallel goroutines, optional calls that fail contribute to `_errors` but do not block the response.

"Your auth service becomes slow. What happens to your gateway?" The answer is Pitfall 3: every request blocks waiting for auth, gateway p99 latency tracks auth service latency. Demonstrate the fix: local JWT validation with cached JWKS public keys, no network call on the hot path.

For first-job habits: after each pull request to the gateway, ask "have I introduced a new hot-path dependency that can make the gateway slow if it degrades?" If yes, add a fallback.

### Senior @ FAANG: Pitfall Post-Mortems as Platform Learning

At staff level, the pitfalls in this section are post-mortem patterns. Each describes an incident that has happened at a real company. A staff engineer extracts systemic improvements from incidents rather than point fixes.

**Pitfall 1 systemic fix.** The incident: rate limiter consumes all memory tracking IPs during DDoS. The point fix is bounded memory (use a fixed-size LRU for IP state). The systemic fix is a capacity review: every component in the gateway critical path must have a documented memory bound under adversarial traffic. For IP tracking: LRU with max N entries, evict oldest. For API key tracking: Redis with TTL. For route table: static at startup, bounded. For request body buffers: enforced size limit per route. A platform team documents these bounds in a runbook so the next on-call engineer knows what to look at during a memory spike.

**Pitfall 2 systemic fix.** The incident: timeout cascade causes retry storm. The point fix is parallel calls with shared deadline. The systemic fix is a timeout budget policy: every gateway route has a documented timeout budget, and every aggregation call within that route has a shorter per-call budget. Timeouts are not configurable by individual teams without platform team review. Timeout changes to aggregation endpoints require load testing with the new values. This is an ADR that the platform team owns.

**Pitfall 4 systemic fix.** The incident: synchronized circuit breaker causes thundering herd on recovery. The point fix is local breakers with jitter. The systemic fix is a load testing exercise after every circuit breaker configuration change: simulate the upstream recovering, measure the request rate the recovering upstream receives in the first 10 seconds, and verify it is below the upstream's tested capacity. This exercise is part of the platform team's reliability testing runbook, not a one-time fix.

**Pitfall 5 systemic fix.** The incident: stale discovery causes 30% error rate for 5 minutes after scale events. The point fix is watch-based discovery. The systemic fix is a deployment runbook change: any scaling operation on a service that is registered in Consul must include a gateway health check that routes a test request through the gateway to the scaled service within 30 seconds of the scale event. If the health check fails, the deployment pipeline blocks and alerts. This catches discovery propagation failures before they affect production traffic.

---
