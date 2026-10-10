## Part 5: Built-in Plugins

Now that we have the plugin framework in place, it is time to build the actual plugins that give our gateway its real power. Each plugin below handles a specific cross-cutting concern that would otherwise need to be duplicated across every backend service. For example, the JWT authentication plugin verifies tokens so your backend services do not have to, the rate limiter protects your services from being overwhelmed, and the circuit breaker prevents cascading failures when a backend goes down. These plugins are registered automatically using Go's `init()` function, so enabling them is as simple as adding a few lines to your configuration file.

### JWT Authentication Plugin

Authentication middleware validates JWT tokens on every WebSocket upgrade request and HTTP API call, attaching the verified user identity to the request context. Stateless token validation scales without shared session storage, and token expiration limits the blast radius of leaked credentials.

```go
// internal/plugins/auth/jwt.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
    "github.com/yourusername/gatewaygo/internal/plugin"
)

// JWTAuthPlugin validates JWT tokens
type JWTAuthPlugin struct {
    secret    []byte
    algorithm string
    header    string
    prefix    string
}

func NewJWTAuthPlugin() plugin.Plugin {
    return &JWTAuthPlugin{
        header: "Authorization",
        prefix: "Bearer ",
    }
}

func (p *JWTAuthPlugin) Name() string {
    return "jwt_auth"
}

func (p *JWTAuthPlugin) Priority() int {
    return 100 // Run early
}

func (p *JWTAuthPlugin) Init(config map[string]any) error {
    if secret, ok := config["secret"].(string); ok {
        p.secret = []byte(secret)
    } else {
        return fmt.Errorf("secret is required")
    }

    if alg, ok := config["algorithm"].(string); ok {
        p.algorithm = alg
    } else {
        p.algorithm = "HS256"
    }

    if header, ok := config["header"].(string); ok {
        p.header = header
    }

    if prefix, ok := config["prefix"].(string); ok {
        p.prefix = prefix
    }

    return nil
}

func (p *JWTAuthPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Extract token from header
    authHeader := req.Header.Get(p.header)
    if authHeader == "" {
        return nil, fmt.Errorf("missing authorization header")
    }

    tokenString := strings.TrimPrefix(authHeader, p.prefix)
    if tokenString == authHeader {
        return nil, fmt.Errorf("invalid authorization format")
    }

    // Parse and validate token
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Verify algorithm
        if token.Method.Alg() != p.algorithm {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return p.secret, nil
    })

    if err != nil {
        return nil, fmt.Errorf("invalid token: %w", err)
    }

    if !token.Valid {
        return nil, fmt.Errorf("token is not valid")
    }

    // Add claims to context
    if claims, ok := token.Claims.(jwt.MapClaims); ok {
        ctx = context.WithValue(ctx, "jwt_claims", claims)
        req = req.WithContext(ctx)
    }

    return req, nil
}

func (p *JWTAuthPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func init() {
    plugin.Register("jwt_auth", NewJWTAuthPlugin)
}
```

### API Key Authentication Plugin

Authentication middleware validates JWT tokens on every WebSocket upgrade request and HTTP API call, attaching the verified user identity to the request context. Stateless token validation scales without shared session storage, and token expiration limits the blast radius of leaked credentials.

```go
// internal/plugins/auth/apikey.go
package auth

import (
    "context"
    "fmt"
    "net/http"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// APIKeyAuthPlugin validates API keys
type APIKeyAuthPlugin struct {
    keys   map[string]bool
    header string
    query  string
}

func NewAPIKeyAuthPlugin() plugin.Plugin {
    return &APIKeyAuthPlugin{
        header: "X-API-Key",
        query:  "api_key",
        keys:   make(map[string]bool),
    }
}

func (p *APIKeyAuthPlugin) Name() string {
    return "api_key_auth"
}

func (p *APIKeyAuthPlugin) Priority() int {
    return 100
}

func (p *APIKeyAuthPlugin) Init(config map[string]any) error {
    if keys, ok := config["keys"].([]any); ok {
        for _, key := range keys {
            if keyStr, ok := key.(string); ok {
                p.keys[keyStr] = true
            }
        }
    }

    if len(p.keys) == 0 {
        return fmt.Errorf("at least one API key required")
    }

    if header, ok := config["header"].(string); ok {
        p.header = header
    }

    if query, ok := config["query"].(string); ok {
        p.query = query
    }

    return nil
}

func (p *APIKeyAuthPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Try header first
    apiKey := req.Header.Get(p.header)

    // Fallback to query parameter
    if apiKey == "" {
        apiKey = req.URL.Query().Get(p.query)
    }

    if apiKey == "" {
        return nil, fmt.Errorf("missing API key")
    }

    if !p.keys[apiKey] {
        return nil, fmt.Errorf("invalid API key")
    }

    return req, nil
}

func (p *APIKeyAuthPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func init() {
    plugin.Register("api_key_auth", NewAPIKeyAuthPlugin)
}
```

### Rate Limiting Plugin

Rate limiting protects the service from abuse by enforcing per-client request quotas using a token bucket or sliding window algorithm. This middleware intercepts requests before they reach application handlers and returns HTTP 429 responses when a client's quota is exhausted.

```go
// internal/plugins/ratelimit/ratelimit.go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/yourusername/gatewaygo/internal/plugin"
    "golang.org/x/time/rate"
)

// RateLimitPlugin implements token bucket rate limiting
type RateLimitPlugin struct {
    limiters sync.Map // key -> *rate.Limiter
    rps      float64
    burst    int
    keyFunc  KeyFunc
}

// KeyFunc extracts a rate limit key from the request
type KeyFunc func(*http.Request) string

func NewRateLimitPlugin() plugin.Plugin {
    return &RateLimitPlugin{
        keyFunc: ipKeyFunc,
    }
}

func (p *RateLimitPlugin) Name() string {
    return "rate_limit"
}

func (p *RateLimitPlugin) Priority() int {
    return 200
}

func (p *RateLimitPlugin) Init(config map[string]any) error {
    if rps, ok := config["requests_per_second"].(float64); ok {
        p.rps = rps
    } else if rps, ok := config["requests_per_second"].(int); ok {
        p.rps = float64(rps)
    } else {
        p.rps = 100 // default
    }

    if burst, ok := config["burst"].(int); ok {
        p.burst = burst
    } else if burst, ok := config["burst"].(float64); ok {
        p.burst = int(burst)
    } else {
        p.burst = int(p.rps * 2) // default: 2x rate
    }

    // Configure key function
    if keyType, ok := config["key"].(string); ok {
        switch keyType {
        case "ip":
            p.keyFunc = ipKeyFunc
        case "header":
            if header, ok := config["header"].(string); ok {
                p.keyFunc = headerKeyFunc(header)
            }
        case "path":
            p.keyFunc = pathKeyFunc
        }
    }

    return nil
}

func (p *RateLimitPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    key := p.keyFunc(req)

    limiter := p.getLimiter(key)

    if !limiter.Allow() {
        return nil, &RateLimitError{
            RetryAfter: time.Second / time.Duration(p.rps),
        }
    }

    return req, nil
}

func (p *RateLimitPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func (p *RateLimitPlugin) getLimiter(key string) *rate.Limiter {
    if limiter, ok := p.limiters.Load(key); ok {
        return limiter.(*rate.Limiter)
    }

    limiter := rate.NewLimiter(rate.Limit(p.rps), p.burst)
    p.limiters.Store(key, limiter)
    return limiter
}

// RateLimitError represents a rate limit exceeded error
type RateLimitError struct {
    RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
    return fmt.Sprintf("rate limit exceeded, retry after %v", e.RetryAfter)
}

// Key extraction functions
func ipKeyFunc(req *http.Request) string {
    ip := req.Header.Get("X-Forwarded-For")
    if ip == "" {
        ip = req.Header.Get("X-Real-IP")
    }
    if ip == "" {
        ip = req.RemoteAddr
    }
    return ip
}

func headerKeyFunc(header string) KeyFunc {
    return func(req *http.Request) string {
        return req.Header.Get(header)
    }
}

func pathKeyFunc(req *http.Request) string {
    return req.URL.Path
}

func init() {
    plugin.Register("rate_limit", NewRateLimitPlugin)
}
```

### CORS Plugin

The CORS plugin handles preflight OPTIONS requests and adds Access-Control headers based on a configurable allowed origins list, methods, and headers.

```go
// internal/plugins/cors/cors.go
package cors

import (
    "context"
    "net/http"
    "strings"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// CORSPlugin handles Cross-Origin Resource Sharing
type CORSPlugin struct {
    allowOrigins     []string
    allowMethods     []string
    allowHeaders     []string
    exposeHeaders    []string
    allowCredentials bool
    maxAge           int
}

func NewCORSPlugin() plugin.Plugin {
    return &CORSPlugin{
        allowOrigins: []string{"*"},
        allowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        allowHeaders: []string{"*"},
        maxAge:       3600,
    }
}

func (p *CORSPlugin) Name() string {
    return "cors"
}

func (p *CORSPlugin) Priority() int {
    return 50 // Run early, before auth
}

func (p *CORSPlugin) Init(config map[string]any) error {
    if origins, ok := config["allow_origins"].([]any); ok {
        p.allowOrigins = make([]string, len(origins))
        for i, origin := range origins {
            p.allowOrigins[i] = origin.(string)
        }
    }

    if methods, ok := config["allow_methods"].([]any); ok {
        p.allowMethods = make([]string, len(methods))
        for i, method := range methods {
            p.allowMethods[i] = method.(string)
        }
    }

    if headers, ok := config["allow_headers"].([]any); ok {
        p.allowHeaders = make([]string, len(headers))
        for i, header := range headers {
            p.allowHeaders[i] = header.(string)
        }
    }

    if expose, ok := config["expose_headers"].([]any); ok {
        p.exposeHeaders = make([]string, len(expose))
        for i, header := range expose {
            p.exposeHeaders[i] = header.(string)
        }
    }

    if creds, ok := config["allow_credentials"].(bool); ok {
        p.allowCredentials = creds
    }

    if maxAge, ok := config["max_age"].(int); ok {
        p.maxAge = maxAge
    }

    return nil
}

func (p *CORSPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    origin := req.Header.Get("Origin")

    // Handle preflight request
    if req.Method == "OPTIONS" {
        // This will be handled in ProcessResponse
        return req, nil
    }

    // Check if origin is allowed
    if origin != "" && !p.isOriginAllowed(origin) {
        return nil, &CORSError{Origin: origin}
    }

    return req, nil
}

func (p *CORSPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    req := resp.Request
    origin := req.Header.Get("Origin")

    if origin == "" {
        return resp, nil
    }

    // Set CORS headers
    if p.isOriginAllowed(origin) {
        if len(p.allowOrigins) == 1 && p.allowOrigins[0] == "*" {
            resp.Header.Set("Access-Control-Allow-Origin", "*")
        } else {
            resp.Header.Set("Access-Control-Allow-Origin", origin)
            resp.Header.Set("Vary", "Origin")
        }
    }

    if req.Method == "OPTIONS" {
        resp.Header.Set("Access-Control-Allow-Methods", strings.Join(p.allowMethods, ", "))
        resp.Header.Set("Access-Control-Allow-Headers", strings.Join(p.allowHeaders, ", "))

        if p.maxAge > 0 {
            resp.Header.Set("Access-Control-Max-Age", fmt.Sprintf("%d", p.maxAge))
        }
    }

    if len(p.exposeHeaders) > 0 {
        resp.Header.Set("Access-Control-Expose-Headers", strings.Join(p.exposeHeaders, ", "))
    }

    if p.allowCredentials {
        resp.Header.Set("Access-Control-Allow-Credentials", "true")
    }

    return resp, nil
}

func (p *CORSPlugin) isOriginAllowed(origin string) bool {
    for _, allowed := range p.allowOrigins {
        if allowed == "*" || allowed == origin {
            return true
        }

        // Support wildcard subdomains: *.example.com
        if strings.HasPrefix(allowed, "*.") {
            suffix := allowed[1:] // .example.com
            if strings.HasSuffix(origin, suffix) {
                return true
            }
        }
    }
    return false
}

type CORSError struct {
    Origin string
}

func (e *CORSError) Error() string {
    return fmt.Sprintf("origin not allowed: %s", e.Origin)
}

func init() {
    plugin.Register("cors", NewCORSPlugin)
}
```

### Request/Response Transformation Plugin

RESP (REdis Serialization Protocol) is a simple text-based line protocol optimized for fast parsing and request/response communication over TCP. Implementing RESP compatibility allows the distributed cache to be used with existing Redis client libraries across every major programming language.

```go
// internal/plugins/transform/transform.go
package transform

import (
    "bytes"
    "context"
    "encoding/json"
    "io"
    "net/http"
    "regexp"
    "strings"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// TransformPlugin transforms requests and responses
type TransformPlugin struct {
    addHeaders     map[string]string
    removeHeaders  []string
    replaceHeaders map[string]string
    addQuery       map[string]string
    removeQuery    []string
    pathRewrite    map[string]string // regex -> replacement
}

func NewTransformPlugin() plugin.Plugin {
    return &TransformPlugin{
        addHeaders:     make(map[string]string),
        replaceHeaders: make(map[string]string),
        addQuery:       make(map[string]string),
        pathRewrite:    make(map[string]string),
    }
}

func (p *TransformPlugin) Name() string {
    return "transform"
}

func (p *TransformPlugin) Priority() int {
    return 300
}

func (p *TransformPlugin) Init(config map[string]any) error {
    if add, ok := config["add_headers"].(map[string]any); ok {
        for k, v := range add {
            p.addHeaders[k] = v.(string)
        }
    }

    if remove, ok := config["remove_headers"].([]any); ok {
        for _, h := range remove {
            p.removeHeaders = append(p.removeHeaders, h.(string))
        }
    }

    if replace, ok := config["replace_headers"].(map[string]any); ok {
        for k, v := range replace {
            p.replaceHeaders[k] = v.(string)
        }
    }

    if add, ok := config["add_query"].(map[string]any); ok {
        for k, v := range add {
            p.addQuery[k] = v.(string)
        }
    }

    if remove, ok := config["remove_query"].([]any); ok {
        for _, q := range remove {
            p.removeQuery = append(p.removeQuery, q.(string))
        }
    }

    if rewrite, ok := config["path_rewrite"].(map[string]any); ok {
        for k, v := range rewrite {
            p.pathRewrite[k] = v.(string)
        }
    }

    return nil
}

func (p *TransformPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Transform headers
    for key, value := range p.addHeaders {
        req.Header.Add(key, value)
    }

    for _, key := range p.removeHeaders {
        req.Header.Del(key)
    }

    for key, value := range p.replaceHeaders {
        req.Header.Set(key, value)
    }

    // Transform query parameters
    query := req.URL.Query()

    for key, value := range p.addQuery {
        query.Add(key, value)
    }

    for _, key := range p.removeQuery {
        query.Del(key)
    }

    req.URL.RawQuery = query.Encode()

    // Transform path
    for pattern, replacement := range p.pathRewrite {
        re := regexp.MustCompile(pattern)
        newPath := re.ReplaceAllString(req.URL.Path, replacement)
        if newPath != req.URL.Path {
            req.URL.Path = newPath
            break
        }
    }

    return req, nil
}

func (p *TransformPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    // Transform response headers
    for key, value := range p.addHeaders {
        resp.Header.Add(key, value)
    }

    for _, key := range p.removeHeaders {
        resp.Header.Del(key)
    }

    return resp, nil
}

func init() {
    plugin.Register("transform", NewTransformPlugin)
}
```

### Circuit Breaker Plugin

The circuit breaker plugin tracks upstream error rates and opens the circuit after a configurable failure threshold, returning 503 immediately instead of forwarding requests to a failing backend.

```go
// internal/plugins/circuit/breaker.go
package circuit

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// State represents circuit breaker state
type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "closed"
    case StateOpen:
        return "open"
    case StateHalfOpen:
        return "half-open"
    default:
        return "unknown"
    }
}

// CircuitBreakerPlugin implements the circuit breaker pattern
type CircuitBreakerPlugin struct {
    mu                  sync.RWMutex
    state               State
    errorThreshold      int
    successThreshold    int
    timeout             time.Duration
    halfOpenMaxRequests int

    failures            int
    successes           int
    halfOpenRequests    int
    lastStateChange     time.Time
}

func NewCircuitBreakerPlugin() plugin.Plugin {
    return &CircuitBreakerPlugin{
        state:            StateClosed,
        lastStateChange:  time.Now(),
    }
}

func (p *CircuitBreakerPlugin) Name() string {
    return "circuit_breaker"
}

func (p *CircuitBreakerPlugin) Priority() int {
    return 400
}

func (p *CircuitBreakerPlugin) Init(config map[string]any) error {
    if threshold, ok := config["error_threshold"].(int); ok {
        p.errorThreshold = threshold
    } else {
        p.errorThreshold = 50
    }

    if threshold, ok := config["success_threshold"].(int); ok {
        p.successThreshold = threshold
    } else {
        p.successThreshold = 5
    }

    if timeout, ok := config["timeout"].(string); ok {
        dur, err := time.ParseDuration(timeout)
        if err != nil {
            return fmt.Errorf("invalid timeout: %w", err)
        }
        p.timeout = dur
    } else {
        p.timeout = 60 * time.Second
    }

    if max, ok := config["half_open_max_requests"].(int); ok {
        p.halfOpenMaxRequests = max
    } else {
        p.halfOpenMaxRequests = 3
    }

    return nil
}

func (p *CircuitBreakerPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Check if we should transition from open to half-open
    if p.state == StateOpen {
        if time.Since(p.lastStateChange) > p.timeout {
            p.transitionTo(StateHalfOpen)
        }
    }

    // Reject request if circuit is open
    if p.state == StateOpen {
        return nil, &CircuitBreakerError{
            State:      p.state,
            RetryAfter: p.timeout - time.Since(p.lastStateChange),
        }
    }

    // Limit concurrent requests in half-open state
    if p.state == StateHalfOpen {
        if p.halfOpenRequests >= p.halfOpenMaxRequests {
            return nil, &CircuitBreakerError{
                State:      p.state,
                RetryAfter: time.Second,
            }
        }
        p.halfOpenRequests++
    }

    return req, nil
}

func (p *CircuitBreakerPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Record success or failure based on status code
    if resp.StatusCode >= 500 {
        p.recordFailure()
    } else {
        p.recordSuccess()
    }

    if p.state == StateHalfOpen {
        p.halfOpenRequests--
    }

    return resp, nil
}

func (p *CircuitBreakerPlugin) recordSuccess() {
    p.failures = 0
    p.successes++

    if p.state == StateHalfOpen && p.successes >= p.successThreshold {
        p.transitionTo(StateClosed)
    }
}

func (p *CircuitBreakerPlugin) recordFailure() {
    p.successes = 0
    p.failures++

    if p.state == StateClosed && p.failures >= p.errorThreshold {
        p.transitionTo(StateOpen)
    } else if p.state == StateHalfOpen {
        p.transitionTo(StateOpen)
    }
}

func (p *CircuitBreakerPlugin) transitionTo(state State) {
    p.state = state
    p.lastStateChange = time.Now()
    p.failures = 0
    p.successes = 0
    p.halfOpenRequests = 0
}

type CircuitBreakerError struct {
    State      State
    RetryAfter time.Duration
}

func (e *CircuitBreakerError) Error() string {
    return fmt.Sprintf("circuit breaker %s, retry after %v", e.State, e.RetryAfter)
}

func init() {
    plugin.Register("circuit_breaker", NewCircuitBreakerPlugin)
}
```

### Cache Plugin

The cache plugin stores response bodies keyed by request URL and method, serving cached responses for subsequent identical requests until the TTL expires.

```go
// internal/plugins/cache/cache.go
package cache

import (
    "bytes"
    "context"
    "crypto/sha256"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// CacheEntry represents a cached response
type CacheEntry struct {
    StatusCode int
    Headers    http.Header
    Body       []byte
    CreatedAt  time.Time
    TTL        time.Duration
}

func (e *CacheEntry) IsExpired() bool {
    return time.Since(e.CreatedAt) > e.TTL
}

// CachePlugin caches responses
type CachePlugin struct {
    mu       sync.RWMutex
    cache    map[string]*CacheEntry
    ttl      time.Duration
    methods  map[string]bool
    statuses map[int]bool
}

func NewCachePlugin() plugin.Plugin {
    return &CachePlugin{
        cache: make(map[string]*CacheEntry),
        methods: map[string]bool{
            "GET":  true,
            "HEAD": true,
        },
        statuses: map[int]bool{
            200: true,
            203: true,
            204: true,
            206: true,
            300: true,
            301: true,
            404: true,
            405: true,
            410: true,
            414: true,
            501: true,
        },
    }
}

func (p *CachePlugin) Name() string {
    return "cache"
}

func (p *CachePlugin) Priority() int {
    return 500
}

func (p *CachePlugin) Init(config map[string]any) error {
    if ttl, ok := config["ttl"].(string); ok {
        dur, err := time.ParseDuration(ttl)
        if err != nil {
            return fmt.Errorf("invalid ttl: %w", err)
        }
        p.ttl = dur
    } else {
        p.ttl = 5 * time.Minute
    }

    if methods, ok := config["methods"].([]any); ok {
        p.methods = make(map[string]bool)
        for _, m := range methods {
            p.methods[m.(string)] = true
        }
    }

    if statuses, ok := config["statuses"].([]any); ok {
        p.statuses = make(map[int]bool)
        for _, s := range statuses {
            if status, ok := s.(int); ok {
                p.statuses[status] = true
            } else if status, ok := s.(float64); ok {
                p.statuses[int(status)] = true
            }
        }
    }

    // Start cleanup goroutine
    go p.cleanupExpired()

    return nil
}

func (p *CachePlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Only cache configured methods
    if !p.methods[req.Method] {
        return req, nil
    }

    // Generate cache key
    key := p.cacheKey(req)

    // Check cache
    p.mu.RLock()
    entry, exists := p.cache[key]
    p.mu.RUnlock()

    if exists && !entry.IsExpired() {
        // Cache hit - store entry in context for ProcessResponse
        ctx = context.WithValue(ctx, "cache_entry", entry)
        ctx = context.WithValue(ctx, "cache_hit", true)
        return req.WithContext(ctx), nil
    }

    // Cache miss - store key in context for ProcessResponse
    ctx = context.WithValue(ctx, "cache_key", key)
    return req.WithContext(ctx), nil
}

func (p *CachePlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    // Check if this was a cache hit
    if hit, ok := ctx.Value("cache_hit").(bool); ok && hit {
        if entry, ok := ctx.Value("cache_entry").(*CacheEntry); ok {
            // Return cached response
            resp.StatusCode = entry.StatusCode
            resp.Header = entry.Headers.Clone()
            resp.Body = io.NopCloser(bytes.NewReader(entry.Body))
            resp.Header.Set("X-Cache", "HIT")
            return resp, nil
        }
    }

    // Not cacheable
    if !p.shouldCache(resp) {
        resp.Header.Set("X-Cache", "SKIP")
        return resp, nil
    }

    // Read and cache response
    key, ok := ctx.Value("cache_key").(string)
    if !ok {
        return resp, nil
    }

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return resp, err
    }
    resp.Body.Close()

    // Create cache entry
    entry := &CacheEntry{
        StatusCode: resp.StatusCode,
        Headers:    resp.Header.Clone(),
        Body:       body,
        CreatedAt:  time.Now(),
        TTL:        p.ttl,
    }

    // Store in cache
    p.mu.Lock()
    p.cache[key] = entry
    p.mu.Unlock()

    // Restore response body
    resp.Body = io.NopCloser(bytes.NewReader(body))
    resp.Header.Set("X-Cache", "MISS")

    return resp, nil
}

func (p *CachePlugin) shouldCache(resp *http.Response) bool {
    // Check status code
    if !p.statuses[resp.StatusCode] {
        return false
    }

    // Check Cache-Control header
    cacheControl := resp.Header.Get("Cache-Control")
    if cacheControl == "no-cache" || cacheControl == "no-store" || cacheControl == "private" {
        return false
    }

    return true
}

func (p *CachePlugin) cacheKey(req *http.Request) string {
    // Generate key from method, host, path, and query
    key := fmt.Sprintf("%s:%s%s?%s", req.Method, req.Host, req.URL.Path, req.URL.RawQuery)
    hash := sha256.Sum256([]byte(key))
    return fmt.Sprintf("%x", hash)
}

func (p *CachePlugin) cleanupExpired() {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        p.mu.Lock()
        for key, entry := range p.cache {
            if entry.IsExpired() {
                delete(p.cache, key)
            }
        }
        p.mu.Unlock()
    }
}

func init() {
    plugin.Register("cache", NewCachePlugin)
}
```
