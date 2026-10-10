## 51.11 Exercises with Complete Solutions

### Exercise 1: Build a Complete API Gateway

**Challenge:** Create an API gateway with routing, authentication, rate limiting, and circuit breaking. The solution below combines all the patterns from this chapter into a single self-contained binary. It uses prefix-based route matching, token-bucket rate limiting keyed by client IP or API key, per-service circuit breakers with half-open recovery, and Prometheus metrics for observability. Study how the middleware chain, route configuration, and graceful shutdown fit together.

```go
// exercises/gateway/complete/solution/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Gateway is the main API gateway
type Gateway struct {
	routes         map[string]*Route
	middleware     []Middleware
	rateLimiter    *RateLimiter
	circuitBreaker *CircuitBreakerRegistry
	metrics        *GatewayMetrics
	logger         *slog.Logger
	mu             sync.RWMutex
}

// Route defines a gateway route
type Route struct {
	Path           string
	Methods        []string
	ServiceURL     string
	StripPrefix    bool
	AuthRequired   bool
	RateLimit      int
	CircuitBreaker string
}

// Middleware is a gateway middleware function
type Middleware func(http.Handler) http.Handler

// RateLimiter implements token bucket rate limiting
type RateLimiter struct {
	buckets map[string]*TokenBucket
	mu      sync.RWMutex
}

type TokenBucket struct {
	tokens     float64
	maxTokens  float64
	refillRate float64
	lastRefill time.Time
	mu         sync.Mutex
}

// CircuitBreakerRegistry manages circuit breakers
type CircuitBreakerRegistry struct {
	breakers map[string]*CircuitBreaker
	mu       sync.RWMutex
}

type CircuitBreaker struct {
	name        string
	failures    int
	successes   int
	state       string // closed, open, half-open
	threshold   int
	resetTime   time.Time
	mu          sync.Mutex
}

// GatewayMetrics holds Prometheus metrics
type GatewayMetrics struct {
	requestsTotal   *prometheus.CounterVec
	requestDuration *prometheus.HistogramVec
	circuitState    *prometheus.GaugeVec
}

func NewGateway() *Gateway {
	metrics := &GatewayMetrics{
		requestsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "gateway_requests_total",
				Help: "Total requests by route and status",
			},
			[]string{"route", "method", "status"},
		),
		requestDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "gateway_request_duration_seconds",
				Help:    "Request duration by route",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"route", "method"},
		),
		circuitState: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "gateway_circuit_state",
				Help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
			},
			[]string{"service"},
		),
	}

	prometheus.MustRegister(
		metrics.requestsTotal,
		metrics.requestDuration,
		metrics.circuitState,
	)

	return &Gateway{
		routes: make(map[string]*Route),
		rateLimiter: &RateLimiter{
			buckets: make(map[string]*TokenBucket),
		},
		circuitBreaker: &CircuitBreakerRegistry{
			breakers: make(map[string]*CircuitBreaker),
		},
		metrics: metrics,
		logger:  slog.Default(),
	}
}

// AddRoute adds a route to the gateway
func (g *Gateway) AddRoute(route *Route) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.routes[route.Path] = route

	// Create circuit breaker if specified
	if route.CircuitBreaker != "" {
		g.circuitBreaker.GetOrCreate(route.CircuitBreaker, 5)
	}
}

// Use adds middleware to the gateway
func (g *Gateway) Use(mw Middleware) {
	g.middleware = append(g.middleware, mw)
}

// ServeHTTP implements http.Handler
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	// Build middleware chain
	var handler http.Handler = http.HandlerFunc(g.handleRequest)
	for i := len(g.middleware) - 1; i >= 0; i-- {
		handler = g.middleware[i](handler)
	}

	// Wrap with metrics
	rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
	handler.ServeHTTP(rw, r)

	// Record metrics
	g.metrics.requestsTotal.WithLabelValues(
		r.URL.Path, r.Method, fmt.Sprintf("%d", rw.statusCode),
	).Inc()
	g.metrics.requestDuration.WithLabelValues(
		r.URL.Path, r.Method,
	).Observe(time.Since(start).Seconds())
}

func (g *Gateway) handleRequest(w http.ResponseWriter, r *http.Request) {
	// Find matching route
	route := g.matchRoute(r.URL.Path)
	if route == nil {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	// Check method
	methodAllowed := false
	for _, m := range route.Methods {
		if m == r.Method {
			methodAllowed = true
			break
		}
	}
	if !methodAllowed {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check rate limit
	if route.RateLimit > 0 {
		clientID := r.Header.Get("X-API-Key")
		if clientID == "" {
			clientID = r.RemoteAddr
		}
		if !g.rateLimiter.Allow(clientID, route.RateLimit) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "Rate Limit Exceeded", http.StatusTooManyRequests)
			return
		}
	}

	// Check circuit breaker
	if route.CircuitBreaker != "" {
		cb := g.circuitBreaker.Get(route.CircuitBreaker)
		if cb != nil && !cb.Allow() {
			http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
			return
		}
	}

	// Proxy request
	g.proxyRequest(w, r, route)
}

func (g *Gateway) matchRoute(path string) *Route {
	g.mu.RLock()
	defer g.mu.RUnlock()

	// Simple prefix matching (production would use trie)
	for routePath, route := range g.routes {
		if len(path) >= len(routePath) && path[:len(routePath)] == routePath {
			return route
		}
	}
	return nil
}

func (g *Gateway) proxyRequest(w http.ResponseWriter, r *http.Request, route *Route) {
	target, _ := url.Parse(route.ServiceURL)

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		if route.StripPrefix {
			req.URL.Path = req.URL.Path[len(route.Path):]
		}
		req.Header.Set("X-Forwarded-Host", req.Host)
		req.Header.Set("X-Gateway-Request-ID", generateRequestID())
	}

	// Handle circuit breaker
	if route.CircuitBreaker != "" {
		cb := g.circuitBreaker.Get(route.CircuitBreaker)
		proxy.ModifyResponse = func(resp *http.Response) error {
			if resp.StatusCode >= 500 {
				cb.RecordFailure()
			} else {
				cb.RecordSuccess()
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			cb.RecordFailure()
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
		}
	}

	proxy.ServeHTTP(w, r)
}

// RateLimiter methods
func (rl *RateLimiter) Allow(clientID string, limit int) bool {
	rl.mu.Lock()
	bucket, ok := rl.buckets[clientID]
	if !ok {
		bucket = &TokenBucket{
			tokens:     float64(limit),
			maxTokens:  float64(limit),
			refillRate: float64(limit) / 60.0, // per minute
			lastRefill: time.Now(),
		}
		rl.buckets[clientID] = bucket
	}
	rl.mu.Unlock()

	return bucket.Take(1)
}

func (tb *TokenBucket) Take(tokens float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	// Refill tokens
	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	tb.tokens = min(tb.maxTokens, tb.tokens+elapsed*tb.refillRate)
	tb.lastRefill = now

	if tb.tokens >= tokens {
		tb.tokens -= tokens
		return true
	}
	return false
}

// CircuitBreaker methods
func (cbr *CircuitBreakerRegistry) GetOrCreate(name string, threshold int) *CircuitBreaker {
	cbr.mu.Lock()
	defer cbr.mu.Unlock()

	if cb, ok := cbr.breakers[name]; ok {
		return cb
	}

	cb := &CircuitBreaker{
		name:      name,
		state:     "closed",
		threshold: threshold,
	}
	cbr.breakers[name] = cb
	return cb
}

func (cbr *CircuitBreakerRegistry) Get(name string) *CircuitBreaker {
	cbr.mu.RLock()
	defer cbr.mu.RUnlock()
	return cbr.breakers[name]
}

func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case "closed":
		return true
	case "open":
		if time.Now().After(cb.resetTime) {
			cb.state = "half-open"
			return true
		}
		return false
	case "half-open":
		return true
	}
	return false
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.successes++
	if cb.state == "half-open" && cb.successes >= 3 {
		cb.state = "closed"
		cb.failures = 0
		cb.successes = 0
	}
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures++
	cb.successes = 0

	if cb.failures >= cb.threshold {
		cb.state = "open"
		cb.resetTime = time.Now().Add(30 * time.Second)
	}
}

// Middleware implementations
func LoggingMiddleware(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(rw, r)

			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.statusCode,
				"duration_ms", time.Since(start).Milliseconds(),
				"client_ip", r.RemoteAddr,
			)
		})
	}
}

func AuthMiddleware(jwtSecret string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth for certain paths
			if r.URL.Path == "/health" || r.URL.Path == "/metrics" {
				next.ServeHTTP(w, r)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Parse JWT
			tokenString := authHeader[7:] // Remove "Bearer "
			token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
				return []byte(jwtSecret), nil
			})

			if err != nil || !token.Valid {
				http.Error(w, "Invalid token", http.StatusUnauthorized)
				return
			}

			// Add user info to context
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				ctx := context.WithValue(r.Context(), "user", claims)
				r = r.WithContext(ctx)
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Helper types and functions
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func generateRequestID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// Note: Uses builtin min() available since Go 1.21

func main() {
	gateway := NewGateway()

	// Add middleware
	gateway.Use(LoggingMiddleware(slog.Default()))
	gateway.Use(AuthMiddleware("your-secret-key"))

	// Add routes
	gateway.AddRoute(&Route{
		Path:           "/api/users",
		Methods:        []string{"GET", "POST"},
		ServiceURL:     "http://user-service:8080",
		StripPrefix:    true,
		AuthRequired:   true,
		RateLimit:      100,
		CircuitBreaker: "user-service",
	})

	gateway.AddRoute(&Route{
		Path:           "/api/orders",
		Methods:        []string{"GET", "POST"},
		ServiceURL:     "http://order-service:8080",
		StripPrefix:    true,
		AuthRequired:   true,
		RateLimit:      50,
		CircuitBreaker: "order-service",
	})

	gateway.AddRoute(&Route{
		Path:           "/api/products",
		Methods:        []string{"GET"},
		ServiceURL:     "http://product-service:8080",
		StripPrefix:    true,
		AuthRequired:   false,
		RateLimit:      200,
		CircuitBreaker: "product-service",
	})

	// Health check endpoint
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
	})

	// Metrics endpoint
	http.Handle("/metrics", promhttp.Handler())

	// Gateway handler
	http.Handle("/", gateway)

	server := &http.Server{
		Addr:         ":8080",
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		slog.Info("starting gateway", "addr", server.Addr)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	server.Shutdown(ctx)
	slog.Info("gateway shutdown complete")
}
```

### Junior -> FAANG: Studying Exercises to Build Interview Readiness

Each exercise in this section is a rehearsal for a specific interview coding question. Treat them as drills, not optional extras.

Exercise 1 (complete gateway) teaches you to wire subsystems together. The most common junior failure in live coding is starting from scratch on each component rather than composing existing building blocks. Study how `NewGateway`, `AddRoute`, `Use`, and `ServeHTTP` connect. That composition pattern appears in nearly every Go HTTP server question.

Exercise 3 (rate limiting) should be fully coded from memory. Sliding window with Redis sorted sets is the standard FAANG rate limiter implementation. Know the five Redis operations in order: `ZRemRangeByScore` (evict old entries), `ZAdd` (add current timestamp), `ZCard` (count window), `Expire` (set key TTL), `Exec` (pipeline). Know the three response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`.

Exercise 5 (API aggregation with partial failure) is the most commonly asked backend coding problem at FAANG mid-level interviews. You must be able to write parallel fan-out with `sync.WaitGroup`, separate required from optional calls, collect errors for optional calls into a side-car field, and return a partial success without panicking. Practice writing this without looking at the book.

### Senior @ FAANG: Extending the Exercises into Production Problems

The solution in this section is a correct, minimal implementation. A senior engineer extends each exercise with production concerns.

**Exercise 1 extension: graceful shutdown under load.** `server.Shutdown(ctx)` stops accepting new connections and waits for in-flight requests to complete. But the gateway may have in-flight aggregation requests with multiple downstream calls. If a downstream call is still running when the shutdown deadline fires, `server.Shutdown` returns an error and the process exits, dropping that downstream call in flight. The extension: track all in-flight downstream `http.Client` calls in a `sync.WaitGroup`, and wait for that WaitGroup after `server.Shutdown` returns, using the same deadline. This ensures all downstream calls (not just the inbound handlers) complete before the process exits.

**Exercise 2 extension: circuit breaker observability.** The `CircuitBreaker.RecordFailure` and `RecordSuccess` methods update state silently. A production circuit breaker emits a state change event (a log line at WARN level and a Prometheus gauge update) on every transition: closed to open, open to half-open, half-open to closed. SREs configure alerts on the "open" state. The alert fires within one scrape interval (typically 15-30 seconds) of the first trip. Without this, circuit breaker opens are discovered hours later in a post-mortem rather than minutes later by a pager.

**Exercise 4 extension: watch-based discovery with error handling.** The watch goroutine in exercise 4 calls `consul.Health().Service` with a blocking query and retries on error with `time.Sleep(time.Second)`. In production: use exponential backoff (not fixed sleep), cap at 30 seconds, log the error with the consecutive failure count, and emit a metric on consecutive failures so the platform team can alert when Consul watch is broken without gateway restart. The watch goroutine should also drain its error budget before falling back to the TTL cache, not on the first error, to avoid flapping.

**Exercise 8 extension: high-cardinality Prometheus labels.** Recording `r.URL.Path` as a label creates one time series per unique path. With path parameters (`/users/123`, `/users/456`) this is unbounded. The extension replaces the raw path label with the normalized route pattern (stored in the request context at routing time). This is a required change before the gateway can be observed at production scale. Implement it as part of the metrics exercise because it demonstrates that you understand Prometheus cardinality, which is a common senior-level observability interview question.

---
