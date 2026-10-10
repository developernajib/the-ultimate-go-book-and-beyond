## 51.9 Common Mistakes

### Mistake 1: Not Handling Partial Failures in Aggregation

When a gateway aggregates responses from multiple upstream services (e.g., combining user, order, and inventory data into one response), failing the entire request if any single upstream errors returns a `500` even when the client only needed two of three data sources. The fix fires all upstream calls in parallel using `errgroup` and collects partial results: if the inventory service is down, the gateway returns the user and order data it did receive along with a partial-failure indicator, letting the client decide whether to render a degraded view or retry the missing field.

```go
// pkg/gateway/mistakes/aggregation.go
package mistakes

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// BAD: Aggregation fails entirely if one service fails
type BadAggregator struct {
	userService    ServiceClient
	orderService   ServiceClient
	productService ServiceClient
}

type ServiceClient interface {
	Get(ctx context.Context, path string) ([]byte, error)
}

func (a *BadAggregator) GetDashboard(ctx context.Context, userID string) (map[string]any, error) {
	// Problem: If ANY service fails, entire request fails
	user, err := a.userService.Get(ctx, "/users/"+userID)
	if err != nil {
		return nil, err // Dashboard fails completely
	}

	orders, err := a.orderService.Get(ctx, "/users/"+userID+"/orders")
	if err != nil {
		return nil, err // Dashboard fails completely
	}

	recommendations, err := a.productService.Get(ctx, "/recommendations/"+userID)
	if err != nil {
		return nil, err // Dashboard fails completely
	}

	return map[string]any{
		"user":            user,
		"orders":          orders,
		"recommendations": recommendations,
	}, nil
}

// GOOD: Graceful degradation with partial results
type GoodAggregator struct {
	userService    ServiceClient
	orderService   ServiceClient
	productService ServiceClient
	timeout        time.Duration
}

type AggregatedResult struct {
	Data    map[string]any `json:"data"`
	Errors  map[string]string      `json:"errors,omitempty"`
	Partial bool                   `json:"partial"`
}

func (a *GoodAggregator) GetDashboard(ctx context.Context, userID string) (*AggregatedResult, error) {
	result := &AggregatedResult{
		Data:   make(map[string]any),
		Errors: make(map[string]string),
	}

	// Use timeout context
	ctx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	var wg sync.WaitGroup
	var mu sync.Mutex

	// Fetch in parallel with error isolation
	fetchData := func(name string, fetcher func() ([]byte, error)) {
		defer wg.Done()
		data, err := fetcher()

		mu.Lock()
		defer mu.Unlock()

		if err != nil {
			result.Errors[name] = err.Error()
			result.Partial = true
			// Don't fail - continue with partial data
		} else {
			var parsed any
			json.Unmarshal(data, &parsed)
			result.Data[name] = parsed
		}
	}

	wg.Add(3)
	go fetchData("user", func() ([]byte, error) {
		return a.userService.Get(ctx, "/users/"+userID)
	})
	go fetchData("orders", func() ([]byte, error) {
		return a.orderService.Get(ctx, "/users/"+userID+"/orders")
	})
	go fetchData("recommendations", func() ([]byte, error) {
		return a.productService.Get(ctx, "/recommendations/"+userID)
	})

	wg.Wait()

	// User data is critical - fail if missing
	if _, hasUser := result.Data["user"]; !hasUser {
		return nil, result.Errors["user"]
	}

	return result, nil
}
```

### Mistake 2: Single Point of Failure Without Fallbacks

A gateway with no fallback strategy becomes a single point of failure: if the primary upstream is unreachable, every client request returns an error even when a cached response or secondary upstream could serve the request acceptably. The fallback implementation here tries the primary upstream first. On failure it checks a local response cache, and only if the cache is empty does it return an error to the client. Cache entries carry a TTL so stale data is served for at most a configurable window, after which clients will see errors until the primary recovers or the cache is refreshed.

```go
// pkg/gateway/mistakes/fallback.go
package mistakes

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// BAD: No fallback when backend is down
type BadGateway struct {
	authService string
}

func (g *BadGateway) Authenticate(r *http.Request) (*User, error) {
	// Problem: If auth service is down, all requests fail
	resp, err := http.Get(g.authService + "/validate")
	if err != nil {
		return nil, err // Complete failure
	}
	defer resp.Body.Close()

	var user User
	json.NewDecoder(resp.Body).Decode(&user)
	return &user, nil
}

type User struct {
	ID    string
	Email string
	Role  string
}

// GOOD: Fallback strategies for resilience
type GoodGateway struct {
	authService    string
	tokenCache     *TokenCache
	circuitBreaker *CircuitBreaker
}

type TokenCache struct {
	cache map[string]*CachedAuth
	mu    sync.RWMutex
	ttl   time.Duration
}

type CachedAuth struct {
	User      *User
	CachedAt  time.Time
	ExpiresAt time.Time
}

type CircuitBreaker struct {
	failures    int
	threshold   int
	resetTime   time.Time
	halfOpen    bool
	mu          sync.Mutex
}

func (g *GoodGateway) Authenticate(ctx context.Context, r *http.Request) (*User, error) {
	token := r.Header.Get("Authorization")

	// Strategy 1: Check local cache first
	if cached := g.tokenCache.Get(token); cached != nil {
		return cached.User, nil
	}

	// Strategy 2: Check circuit breaker
	if !g.circuitBreaker.Allow() {
		// Circuit is open - use cached data if available (stale)
		if cached := g.tokenCache.GetStale(token); cached != nil {
			return cached.User, nil
		}
		return nil, ErrServiceUnavailable
	}

	// Strategy 3: Try primary auth service
	user, err := g.callAuthService(ctx, token)
	if err != nil {
		g.circuitBreaker.RecordFailure()

		// Strategy 4: Try fallback - decode JWT locally
		if user, err := g.decodeJWTLocally(token); err == nil {
			return user, nil
		}

		// Strategy 5: Return cached stale data
		if cached := g.tokenCache.GetStale(token); cached != nil {
			return cached.User, nil
		}

		return nil, err
	}

	g.circuitBreaker.RecordSuccess()

	// Cache the result
	g.tokenCache.Set(token, user)

	return user, nil
}

func (g *GoodGateway) callAuthService(ctx context.Context, token string) (*User, error) {
	// Implementation
	return nil, nil
}

func (g *GoodGateway) decodeJWTLocally(token string) (*User, error) {
	// Local JWT validation as fallback
	return nil, nil
}

func (c *TokenCache) Get(token string) *CachedAuth {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if cached, ok := c.cache[token]; ok {
		if time.Now().Before(cached.ExpiresAt) {
			return cached
		}
	}
	return nil
}

func (c *TokenCache) GetStale(token string) *CachedAuth {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if cached, ok := c.cache[token]; ok {
		// Return even if expired (stale read)
		return cached
	}
	return nil
}

func (c *TokenCache) Set(token string, user *User) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.cache[token] = &CachedAuth{
		User:      user,
		CachedAt:  time.Now(),
		ExpiresAt: time.Now().Add(c.ttl),
	}
}

func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.failures >= cb.threshold {
		if time.Now().After(cb.resetTime) {
			cb.halfOpen = true
			return true // Allow one request through
		}
		return false
	}
	return true
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures = 0
	cb.halfOpen = false
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures++
	if cb.failures >= cb.threshold {
		cb.resetTime = time.Now().Add(30 * time.Second)
	}
}

var ErrServiceUnavailable = &GatewayError{Code: 503, Message: "Service unavailable"}

type GatewayError struct {
	Code    int
	Message string
}

func (e *GatewayError) Error() string {
	return e.Message
}
```

### Mistake 3: Not Propagating Request Context

When the gateway proxies a request to an upstream, creating the outbound request with `http.NewRequest` instead of `http.NewRequestWithContext` silently drops the original request's deadline, cancellation signal, and trace span. The upstream call runs without a timeout even if the client has already disconnected, wasting resources. The fix passes the original `r.Context()` through to the outbound request and explicitly propagates tracing and correlation headers so that distributed tracing tools can stitch the full request path together.

```go
// pkg/gateway/mistakes/context.go
package mistakes

import (
	"context"
	"net/http"
)

// BAD: Losing request context when proxying
type BadProxy struct{}

func (p *BadProxy) ProxyRequest(w http.ResponseWriter, r *http.Request, targetURL string) {
	// Problem: Using background context loses deadline, cancellation, and tracing
	req, _ := http.NewRequest(r.Method, targetURL, r.Body)

	// Lost: Original request timeout
	// Lost: Client cancellation
	// Lost: Tracing context
	// Lost: Request-scoped values

	client := &http.Client{}
	resp, _ := client.Do(req)
	defer resp.Body.Close()
	// ... copy response
}

// GOOD: Properly propagate context
type GoodProxy struct {
	client *http.Client
}

func (p *GoodProxy) ProxyRequest(w http.ResponseWriter, r *http.Request, targetURL string) error {
	// Use original request's context
	ctx := r.Context()

	// Create request with context
	req, err := http.NewRequestWithContext(ctx, r.Method, targetURL, r.Body)
	if err != nil {
		return err
	}

	// Propagate important headers
	propagateHeaders := []string{
		"X-Request-ID",
		"X-Correlation-ID",
		"X-B3-TraceId",
		"X-B3-SpanId",
		"X-B3-ParentSpanId",
		"X-B3-Sampled",
		"traceparent",
		"tracestate",
		"Authorization",
		"X-Forwarded-For",
		"X-Real-IP",
	}

	for _, header := range propagateHeaders {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}

	// Add gateway-specific headers
	req.Header.Set("X-Forwarded-Host", r.Host)
	req.Header.Set("X-Gateway-Request-Time", r.Header.Get("X-Request-Start-Time"))

	// Respect context cancellation and timeouts
	resp, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() == context.Canceled {
			return &GatewayError{Code: 499, Message: "Client closed request"}
		}
		if ctx.Err() == context.DeadlineExceeded {
			return &GatewayError{Code: 504, Message: "Gateway timeout"}
		}
		return err
	}
	defer resp.Body.Close()

	// Copy response
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	// io.Copy(w, resp.Body)

	return nil
}

func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}
```

### Junior -> FAANG: Common Mistakes as Interview Red Flags

Interviewers deliberately probe for the mistakes documented in this section. Knowing them transforms common trick questions into easy ones.

"How do you handle partial failures in aggregation?" If you answer "return an error if any call fails," you have demonstrated Mistake 1. The correct answer is required vs optional classification with partial-response signaling.

"What is a single point of failure in a gateway?" If you cannot name concrete examples (no fallback auth, no circuit breaker, rate limiter with unbounded memory), you have demonstrated Mistake 2 at a conceptual level.

"Show me how your proxy code handles client disconnection." If you use `http.NewRequest` with a background context, you have demonstrated Mistake 3. The interviewer is checking whether you understand that context carries deadlines and cancellation, not just values.

For your first job, adopt one preventive habit for each mistake: code review checklist item for partial failure handling in any fan-out, architecture checklist for fallback strategies on every external dependency, and a linter or PR template that flags `http.NewRequest` without context in any middleware or proxy code.

### Senior @ FAANG: Mistake Patterns at Organizational Scale

**Mistake 1 at scale: gateway scope creep.** The bad aggregator in Mistake 1 is a symptom of a broader pattern: teams add domain logic to the gateway because it is the most convenient shared entry point. Left unchecked, the gateway accumulates business rules, service-specific transformations, and client-specific response shapes. This is how gateways become distributed monoliths. The governance solution is a written policy (enforced in pull request review) that any gateway change must be limited to: routing, auth enforcement, rate limiting, header manipulation, path rewriting, circuit breaking. Any other logic belongs in the service or a BFF, and the PR is returned to the author.

**Mistake 2 at scale: availability chains.** The fallback chain in the good gateway (token cache, then circuit breaker, then remote auth, then local JWT, then stale cache) is correct for a single gateway. At scale with 50 gateway replicas, the local JWT fallback means that a JWT with a revoked claim (e.g., account suspended) will still pass local validation until the token expires. Revocation is the unsolvable problem with pure local JWT validation: you cannot revoke a token without either calling a remote service (Mistake 3) or accepting a revocation window equal to the token lifetime. The production answer is short-lived tokens (15-minute expiry) combined with local validation. Revocation takes effect at most 15 minutes after it is issued. This is the actual tradeoff FAANG engineers make.

**Mistake 3 at scale: context propagation governance.** The good proxy propagates a list of named headers. In an organization with 50 services built by 20 teams, each team independently invents header names for trace IDs, request IDs, tenant IDs, and user IDs. The gateway receives a header from one team's service in a format that a different team's downstream service does not recognize. The platform team's solution is a header policy: one canonical set of header names (in an internal RFC or ADR), enforced at the gateway which translates non-standard variants to canonical names. This translation belongs in gateway middleware (a `HeaderNormalizationMiddleware`) not in each individual service.

---
