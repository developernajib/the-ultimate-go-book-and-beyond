## 51.8 Company Case Studies

### Netflix: Zuul Gateway Architecture

Netflix open-sourced its Zuul gateway (documented in Netflix TechBlog's architecture retrospectives on Zuul 2), which processes requests through a filter chain organized into four phases: pre-routing (authentication, rate limiting), routing (service discovery, load balancing), post-routing (response transformation, metrics), and error handling. The implementation below demonstrates these patterns in Go. The `RequestPassport` struct tracks timestamps at each filter phase, giving operators a per-request breakdown of where latency was spent.

```go
// pkg/gateway/netflix/zuul_patterns.go
package netflix

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

/*
Netflix Zuul Gateway Patterns:
- Dynamic routing based on request attributes
- Filter chains for request/response processing
- Origin concurrency protection
- Adaptive retries with backoff
- Request passport for debugging

Filter Types:
1. Pre-filters: Auth, rate limiting, routing
2. Route filters: Service discovery, load balancing
3. Post-filters: Response transformation, metrics
4. Error filters: Error handling, fallbacks
*/

// ZuulGateway represents Netflix's gateway pattern
type ZuulGateway struct {
	preFilters    []Filter
	routeFilters  []Filter
	postFilters   []Filter
	errorFilters  []Filter
	originManager *OriginManager
	logger        *slog.Logger
}

// Filter represents a Zuul-style filter
type Filter interface {
	FilterType() string // pre, route, post, error
	FilterOrder() int
	ShouldFilter(ctx *RequestContext) bool
	Run(ctx *RequestContext) error
}

// RequestContext holds request state through filter chain
type RequestContext struct {
	Request      *http.Request
	Response     http.ResponseWriter
	Route        *Route
	Origin       string
	StartTime    time.Time
	Passport     *RequestPassport
	Error        error
	ResponseSent bool
	Data         map[string]any
	mu           sync.RWMutex
}

// RequestPassport tracks request journey for debugging
type RequestPassport struct {
	RequestID     string            `json:"request_id"`
	ClientIP      string            `json:"client_ip"`
	Timestamps    map[string]int64  `json:"timestamps"`
	FilterResults map[string]string `json:"filter_results"`
	OriginLatency int64             `json:"origin_latency_ms"`
}

type Route struct {
	Path        string
	ServiceID   string
	StripPrefix bool
}

// OriginManager handles connection to backend services
type OriginManager struct {
	concurrency   map[string]*sync.Mutex
	semaphores    map[string]chan struct{}
	maxConcurrent int
}

func NewZuulGateway() *ZuulGateway {
	return &ZuulGateway{
		preFilters:   make([]Filter, 0),
		routeFilters: make([]Filter, 0),
		postFilters:  make([]Filter, 0),
		errorFilters: make([]Filter, 0),
		originManager: &OriginManager{
			semaphores:    make(map[string]chan struct{}),
			maxConcurrent: 100,
		},
		logger: slog.Default(),
	}
}

func (g *ZuulGateway) AddFilter(f Filter) {
	switch f.FilterType() {
	case "pre":
		g.preFilters = append(g.preFilters, f)
	case "route":
		g.routeFilters = append(g.routeFilters, f)
	case "post":
		g.postFilters = append(g.postFilters, f)
	case "error":
		g.errorFilters = append(g.errorFilters, f)
	}
}

func (g *ZuulGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := &RequestContext{
		Request:   r,
		Response:  w,
		StartTime: time.Now(),
		Passport: &RequestPassport{
			RequestID:     r.Header.Get("X-Request-ID"),
			ClientIP:      r.RemoteAddr,
			Timestamps:    make(map[string]int64),
			FilterResults: make(map[string]string),
		},
		Data: make(map[string]any),
	}

	ctx.Passport.Timestamps["start"] = ctx.StartTime.UnixMilli()

	// Run pre-filters
	for _, f := range g.preFilters {
		if f.ShouldFilter(ctx) {
			if err := f.Run(ctx); err != nil {
				ctx.Error = err
				g.runErrorFilters(ctx)
				return
			}
		}
	}
	ctx.Passport.Timestamps["pre_complete"] = time.Now().UnixMilli()

	// Run route filters
	for _, f := range g.routeFilters {
		if f.ShouldFilter(ctx) {
			if err := f.Run(ctx); err != nil {
				ctx.Error = err
				g.runErrorFilters(ctx)
				return
			}
		}
	}
	ctx.Passport.Timestamps["route_complete"] = time.Now().UnixMilli()

	// Run post-filters
	for _, f := range g.postFilters {
		if f.ShouldFilter(ctx) {
			f.Run(ctx)
		}
	}
	ctx.Passport.Timestamps["post_complete"] = time.Now().UnixMilli()

	// Log request passport for debugging
	g.logPassport(ctx)
}

func (g *ZuulGateway) runErrorFilters(ctx *RequestContext) {
	for _, f := range g.errorFilters {
		if f.ShouldFilter(ctx) {
			f.Run(ctx)
		}
	}
}

func (g *ZuulGateway) logPassport(ctx *RequestContext) {
	passport, _ := json.Marshal(ctx.Passport)
	g.logger.Info("request complete",
		"passport", string(passport),
		"duration_ms", time.Since(ctx.StartTime).Milliseconds(),
	)
}

// OriginConcurrencyFilter limits concurrent requests to origins
type OriginConcurrencyFilter struct {
	manager *OriginManager
}

func (f *OriginConcurrencyFilter) FilterType() string { return "route" }
func (f *OriginConcurrencyFilter) FilterOrder() int   { return 10 }

func (f *OriginConcurrencyFilter) ShouldFilter(ctx *RequestContext) bool {
	return ctx.Origin != ""
}

func (f *OriginConcurrencyFilter) Run(ctx *RequestContext) error {
	sem := f.manager.getSemaphore(ctx.Origin)

	select {
	case sem <- struct{}{}:
		// Got slot, proceed
		defer func() { <-sem }()
		return nil
	default:
		// Origin at capacity
		ctx.Passport.FilterResults["origin_concurrency"] = "rejected"
		return fmt.Errorf("origin %s at max concurrency", ctx.Origin)
	}
}

func (m *OriginManager) getSemaphore(origin string) chan struct{} {
	if m.semaphores[origin] == nil {
		m.semaphores[origin] = make(chan struct{}, m.maxConcurrent)
	}
	return m.semaphores[origin]
}
```

### Amazon: API Gateway with Lambda Integration

AWS API Gateway introduced patterns that are now standard across managed gateway products (detailed in AWS Architecture Center's guidance on serverless API gateways): stage-based deployments (dev, staging, prod each with their own variables and throttle settings), usage plans that tie API keys to quota and rate limits, and Lambda authorizers that run custom authentication logic without modifying the backend. The Go implementation below models these patterns, showing how stage configuration, API key validation, and request validation can be layered in a self-hosted gateway.

```go
// pkg/gateway/amazon/api_gateway.go
package amazon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

/*
Amazon API Gateway Patterns:
- Stage deployments (dev, staging, prod)
- Usage plans and API keys
- Request validation with JSON Schema
- Lambda authorizers for custom auth
- Throttling at method and stage level
- Caching with TTL configuration

Integration Types:
1. Lambda Proxy: Full request to Lambda
2. Lambda: Mapping templates for transform
3. HTTP Proxy: Direct to HTTP backend
4. HTTP: With request/response mapping
5. Mock: Return configured response
*/

// APIGateway represents Amazon-style API gateway
type APIGateway struct {
	stages       map[string]*Stage
	usagePlans   map[string]*UsagePlan
	authorizers  map[string]Authorizer
	logger       *slog.Logger
}

// Stage represents a deployment stage
type Stage struct {
	Name          string
	Description   string
	Variables     map[string]string
	DefaultThrottle ThrottleSettings
	CacheEnabled  bool
	CacheTTL      time.Duration
}

// ThrottleSettings defines rate limiting
type ThrottleSettings struct {
	RateLimit  float64 // requests per second
	BurstLimit int     // max concurrent
}

// UsagePlan defines API usage limits
type UsagePlan struct {
	ID          string
	Name        string
	Throttle    ThrottleSettings
	Quota       QuotaSettings
	APIStages   []APIStage
	APIKeys     []string
}

type QuotaSettings struct {
	Limit  int
	Period string // DAY, WEEK, MONTH
}

type APIStage struct {
	APIID   string
	Stage   string
}

// Authorizer validates requests
type Authorizer interface {
	Authorize(ctx context.Context, req *http.Request) (*AuthResult, error)
}

type AuthResult struct {
	PrincipalID string
	PolicyDoc   PolicyDocument
	Context     map[string]any
}

type PolicyDocument struct {
	Version   string
	Statement []PolicyStatement
}

type PolicyStatement struct {
	Action   string
	Effect   string
	Resource string
}

// LambdaAuthorizer implements custom authorization
type LambdaAuthorizer struct {
	lambdaFunc string
	ttl        time.Duration
	cache      map[string]*AuthResult
}

func (a *LambdaAuthorizer) Authorize(ctx context.Context, req *http.Request) (*AuthResult, error) {
	// Extract token
	token := req.Header.Get("Authorization")
	if token == "" {
		return nil, fmt.Errorf("missing authorization header")
	}

	// Check cache
	if cached, ok := a.cache[token]; ok {
		return cached, nil
	}

	// Call Lambda authorizer (simplified)
	result := &AuthResult{
		PrincipalID: "user-123",
		PolicyDoc: PolicyDocument{
			Version: "2012-10-17",
			Statement: []PolicyStatement{
				{
					Action:   "execute-api:Invoke",
					Effect:   "Allow",
					Resource: "*",
				},
			},
		},
		Context: map[string]any{
			"userId":  "user-123",
			"tenantId": "tenant-456",
		},
	}

	// Cache result
	a.cache[token] = result

	return result, nil
}

// RequestValidator validates request against schema
type RequestValidator struct {
	validateBody    bool
	validateParams  bool
	bodySchema      map[string]any
}

func (v *RequestValidator) Validate(req *http.Request) error {
	if v.validateParams {
		// Validate query parameters
		for key, values := range req.URL.Query() {
			if len(values) == 0 {
				return fmt.Errorf("missing required parameter: %s", key)
			}
		}
	}

	if v.validateBody {
		// Validate request body against JSON schema
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			return fmt.Errorf("invalid JSON body: %w", err)
		}
		// Schema validation would go here
	}

	return nil
}

// Integration handles backend integration
type Integration struct {
	Type             string // LAMBDA_PROXY, HTTP_PROXY, etc.
	URI              string
	RequestTemplates map[string]string
	ResponseTemplates map[string]string
	CacheKey         []string
}

// MethodHandler handles a single API method
type MethodHandler struct {
	HTTPMethod    string
	Authorization string
	APIKeyRequired bool
	Validator     *RequestValidator
	Integration   *Integration
	Throttle      *ThrottleSettings
}

func (g *APIGateway) HandleRequest(stage, path, method string, w http.ResponseWriter, r *http.Request) {
	// Get stage configuration
	stg, ok := g.stages[stage]
	if !ok {
		http.Error(w, "Stage not found", http.StatusNotFound)
		return
	}

	// Apply stage variables to request context
	ctx := context.WithValue(r.Context(), "stageVariables", stg.Variables)
	r = r.WithContext(ctx)

	// Check API key if required
	apiKey := r.Header.Get("x-api-key")
	if apiKey != "" {
		plan := g.findUsagePlan(apiKey)
		if plan != nil {
			// Apply usage plan throttling
			if !g.checkThrottle(plan, apiKey) {
				http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
				return
			}
		}
	}

	// Run authorizer if configured
	// ... authorization logic

	// Route to integration
	// ... routing logic

	g.logger.Info("request processed",
		"stage", stage,
		"path", path,
		"method", method,
	)
}

func (g *APIGateway) findUsagePlan(apiKey string) *UsagePlan {
	for _, plan := range g.usagePlans {
		for _, key := range plan.APIKeys {
			if key == apiKey {
				return plan
			}
		}
	}
	return nil
}

func (g *APIGateway) checkThrottle(plan *UsagePlan, key string) bool {
	// Simplified throttle check
	return true
}
```

### Stripe: API Gateway for Payment Security

Stripe's public API is notable for three gateway-level design decisions (published across Stripe Engineering's technical blogs on idempotency and reliable API versioning): idempotency keys that make POST requests safely retryable, header-based API versioning that decouples client upgrades from server deployments, and webhook signature verification using HMAC-SHA256 to prevent payload tampering. The implementation below demonstrates each of these patterns. The `SecureGateway` validates API keys with scope and IP restrictions, checks an idempotency store before executing duplicate mutations, and provides a `VerifyWebhookSignature` method for inbound webhook validation.

```go
// pkg/gateway/stripe/secure_gateway.go
package stripe

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

/*
Stripe Gateway Patterns:
- API key authentication with restricted keys
- Request signing for webhooks
- Idempotency keys for safe retries
- API versioning in headers
- Structured error responses
- Expand parameters for related resources

Security Features:
1. TLS 1.2+ required
2. API key scoping (read/write)
3. Webhook signature verification
4. Request replay protection
5. IP allowlisting for restricted keys
*/

// SecureGateway implements Stripe-style API gateway
type SecureGateway struct {
	apiKeys         map[string]*APIKey
	idempotencyStore IdempotencyStore
	webhookSecret   string
	logger          *slog.Logger
}

// APIKey represents a Stripe-style API key
type APIKey struct {
	ID           string
	Type         string // secret, publishable, restricted
	Permissions  []string
	AccountID    string
	Livemode     bool
	Created      time.Time
	LastUsed     time.Time
	IPAllowlist  []string
}

// IdempotencyStore tracks idempotent requests
type IdempotencyStore interface {
	Get(ctx context.Context, key string) (*IdempotencyRecord, error)
	Set(ctx context.Context, key string, record *IdempotencyRecord) error
}

type IdempotencyRecord struct {
	Key          string
	RequestHash  string
	Response     []byte
	StatusCode   int
	CreatedAt    time.Time
	ExpiresAt    time.Time
}

// APIError represents structured error response
type APIError struct {
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
	Param   string `json:"param,omitempty"`
	DocURL  string `json:"doc_url,omitempty"`
}

func NewSecureGateway(webhookSecret string) *SecureGateway {
	return &SecureGateway{
		apiKeys:       make(map[string]*APIKey),
		webhookSecret: webhookSecret,
		logger:        slog.Default(),
	}
}

func (g *SecureGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Extract and validate API key
	apiKey, err := g.authenticateRequest(r)
	if err != nil {
		g.writeError(w, http.StatusUnauthorized, APIError{
			Type:    "invalid_request_error",
			Message: "Invalid API key provided",
		})
		return
	}

	// Check API version header
	apiVersion := r.Header.Get("Stripe-Version")
	if apiVersion == "" {
		apiVersion = "2023-10-16" // Default version
	}

	// Store context
	ctx := context.WithValue(r.Context(), "apiKey", apiKey)
	ctx = context.WithValue(ctx, "apiVersion", apiVersion)
	r = r.WithContext(ctx)

	// Handle idempotency for mutating requests
	if r.Method == http.MethodPost {
		idempotencyKey := r.Header.Get("Idempotency-Key")
		if idempotencyKey != "" {
			if cached, err := g.checkIdempotency(ctx, idempotencyKey, r); err == nil && cached != nil {
				w.WriteHeader(cached.StatusCode)
				w.Write(cached.Response)
				return
			}
		}
	}

	// Route and handle request
	g.routeRequest(w, r)
}

func (g *SecureGateway) authenticateRequest(r *http.Request) (*APIKey, error) {
	// Extract bearer token
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fmt.Errorf("invalid authorization header")
	}

	keyString := strings.TrimPrefix(auth, "Bearer ")

	// Validate key format (sk_live_xxx or sk_test_xxx)
	if !strings.HasPrefix(keyString, "sk_") {
		return nil, fmt.Errorf("invalid key format")
	}

	// Look up key
	apiKey, ok := g.apiKeys[keyString]
	if !ok {
		return nil, fmt.Errorf("key not found")
	}

	// Check IP allowlist for restricted keys
	if apiKey.Type == "restricted" && len(apiKey.IPAllowlist) > 0 {
		clientIP := r.RemoteAddr
		allowed := false
		for _, ip := range apiKey.IPAllowlist {
			if ip == clientIP {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("IP not allowed")
		}
	}

	return apiKey, nil
}

func (g *SecureGateway) checkIdempotency(ctx context.Context, key string, r *http.Request) (*IdempotencyRecord, error) {
	record, err := g.idempotencyStore.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	if record != nil && time.Now().Before(record.ExpiresAt) {
		return record, nil
	}

	return nil, nil
}

func (g *SecureGateway) storeIdempotency(ctx context.Context, key string, response []byte, statusCode int) error {
	record := &IdempotencyRecord{
		Key:        key,
		Response:   response,
		StatusCode: statusCode,
		CreatedAt:  time.Now(),
		ExpiresAt:  time.Now().Add(24 * time.Hour),
	}
	return g.idempotencyStore.Set(ctx, key, record)
}

func (g *SecureGateway) routeRequest(w http.ResponseWriter, r *http.Request) {
	// Route based on path
	// Implementation depends on your routing needs
}

func (g *SecureGateway) writeError(w http.ResponseWriter, status int, apiErr APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	response := map[string]any{
		"error": apiErr,
	}
	json.NewEncoder(w).Encode(response)
}

// VerifyWebhookSignature verifies Stripe webhook signatures
func (g *SecureGateway) VerifyWebhookSignature(payload []byte, sigHeader string) error {
	// Parse signature header
	// Format: t=timestamp,v1=signature
	parts := strings.Split(sigHeader, ",")
	if len(parts) < 2 {
		return fmt.Errorf("invalid signature header format")
	}

	var timestamp, signature string
	for _, part := range parts {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			timestamp = kv[1]
		case "v1":
			signature = kv[1]
		}
	}

	// Check timestamp tolerance (5 minutes)
	// ... timestamp validation

	// Compute expected signature
	signedPayload := fmt.Sprintf("%s.%s", timestamp, string(payload))
	mac := hmac.New(sha256.New, []byte(g.webhookSecret))
	mac.Write([]byte(signedPayload))
	expectedSig := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(signature), []byte(expectedSig)) {
		return fmt.Errorf("signature verification failed")
	}

	return nil
}

// ExpandHandler handles Stripe's expand parameter
type ExpandHandler struct {
	expandableFields map[string]func(ctx context.Context, id string) (any, error)
}

func (h *ExpandHandler) Expand(ctx context.Context, obj map[string]any, expandFields []string) error {
	for _, field := range expandFields {
		if expander, ok := h.expandableFields[field]; ok {
			if id, ok := obj[field].(string); ok {
				expanded, err := expander(ctx, id)
				if err != nil {
					return err
				}
				obj[field] = expanded
			}
		}
	}
	return nil
}
```

### Junior -> FAANG: What FAANG Interviews Take from These Case Studies

Each company case study above encodes a specific interview lesson.

Netflix Zuul teaches the filter chain pattern: pre, route, post, error. This maps directly to middleware ordering. The `RequestPassport` is what interviewers mean when they ask "how do you debug a slow request in a gateway?" The passport records timestamps at each phase. The gap between phases is where the latency lives.

Amazon API Gateway teaches that stage-based deployment (dev/staging/prod with separate throttle settings and stage variables) is a first-class concept in managed gateways. If you design an API gateway in an interview and the interviewer asks "how do teams promote config changes from dev to prod?", describing stages is the expected answer.

Stripe's pattern teaches three gateway-level features that appear in nearly every payment or fintech interview: idempotency keys (safe POST retries without duplicate side effects), header-based API versioning (clients opt into a new version by sending `Stripe-Version: 2023-10-16`, without requiring a URL change), and webhook signature verification (HMAC-SHA256 over timestamp + body prevents replay attacks).

For entry-level interviews, knowing the name and purpose of each pattern matters more than being able to code it from memory. Know why idempotency keys exist (network failures cause retries, retries without idempotency cause duplicate charges), and be able to explain the verification flow at a whiteboard level.

### Senior @ FAANG: Extracting Architectural Decisions from Case Studies

**Netflix Zuul: filter ordering and independent deployability.** The Zuul filter chain allows filters to be added, removed, and reordered without modifying the gateway core. Each filter is independently deployable. This is the gateway equivalent of the open-closed principle: you extend behavior by adding filters, not by modifying the routing engine. At scale, Netflix ran dozens of filters managed by different teams. The governance model required each filter to declare its order and type, so the gateway could compose the chain deterministically from metadata rather than from code.

The `OriginConcurrencyFilter` using a semaphore per origin is an important pattern: without it, a slow or overloaded upstream can absorb all in-flight gateway goroutines, starving healthy upstreams. This is a form of bulkhead isolation at the gateway layer. A bar-raiser interview question: "what happens if the semaphore capacity is 100 and you have 150 concurrent requests trying to reach the same origin?" Requests that cannot acquire a slot get 503 immediately, protecting the origin from more load than it can handle.

**Amazon API Gateway: usage plans as a product primitive.** Usage plans (quota, throttle) tied to API keys are not just rate limiting. They are a product and business model primitive. They allow you to offer tiered API access (free tier: 1000 calls per day, paid tier: 100000 calls per day) that can be enforced at the gateway without per-service changes. Staff engineers who design internal developer platforms use this pattern to create internal SLAs: team A's service is allowed to make X calls per second to team B's service, enforced at the gateway without coordination between the teams.

**Stripe: idempotency as a gateway contract.** The `IdempotencyRecord` caches the full response for a given key. This means the idempotency store must hold the response for at least 24 hours (Stripe's actual TTL). At scale, this is a significant storage commitment. The design decision: store full responses (simple to return, large storage) vs store only the side-effect result (smaller storage, requires re-running non-side-effecting logic). Stripe stores full responses because the guarantee is deterministic replay, not just deduplicated side effects.

The `VerifyWebhookSignature` function uses `hmac.Equal` for constant-time comparison, preventing timing attacks that would allow an attacker to guess the signature one byte at a time. This is a security detail that senior engineers must catch in code review. Any comparison of cryptographic material must use a constant-time function.

---
