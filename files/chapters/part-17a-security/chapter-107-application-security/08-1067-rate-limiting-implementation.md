## 107.7 Rate Limiting Implementation

Rate limiting prevents abuse and DoS attacks. Here's a production-ready implementation.

```go
package ratelimit

import (
    "net"
    "net/http"
    "strings"
    "sync"
    "time"
)

// TokenBucket implements token bucket algorithm
type TokenBucket struct {
    capacity int64
    tokens   int64
    rate     int64 // tokens per second
    lastTime time.Time
    mu       sync.Mutex
}

func NewTokenBucket(capacity, rate int64) *TokenBucket {
    return &TokenBucket{
        capacity: capacity,
        tokens:   capacity,
        rate:     rate,
        lastTime: time.Now(),
    }
}

// Allow checks if request is allowed under rate limit
func (tb *TokenBucket) Allow() bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(tb.lastTime).Seconds()

    // Add tokens based on elapsed time
    tb.tokens += int64(elapsed * float64(tb.rate))
    if tb.tokens > tb.capacity {
        tb.tokens = tb.capacity
    }

    tb.lastTime = now

    if tb.tokens >= 1 {
        tb.tokens--
        return true
    }

    return false
}

// RateLimiter manages rate limits per identifier (IP, user, etc.)
type RateLimiter struct {
    buckets map[string]*TokenBucket
    mu      sync.RWMutex
    capacity int64
    rate    int64
}

func NewRateLimiter(capacity, rate int64) *RateLimiter {
    rl := &RateLimiter{
        buckets:  make(map[string]*TokenBucket),
        capacity: capacity,
        rate:     rate,
    }

    // Clean up old buckets periodically
    go rl.cleanup()

    return rl
}

// Allow checks if identifier can make request
func (rl *RateLimiter) Allow(identifier string) bool {
    rl.mu.RLock()
    bucket, exists := rl.buckets[identifier]
    rl.mu.RUnlock()

    if !exists {
        rl.mu.Lock()
        // Re-check under write lock: another goroutine may have
        // created the bucket between RUnlock and Lock
        bucket, exists = rl.buckets[identifier]
        if !exists {
            bucket = NewTokenBucket(rl.capacity, rl.rate)
            rl.buckets[identifier] = bucket
        }
        rl.mu.Unlock()
    }

    return bucket.Allow()
}

// cleanup removes unused buckets
func (rl *RateLimiter) cleanup() {
    ticker := time.NewTicker(10 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        rl.mu.Lock()
        // In production, implement smarter cleanup based on last access time
        if len(rl.buckets) > 10000 {
            rl.buckets = make(map[string]*TokenBucket)
        }
        rl.mu.Unlock()
    }
}

// Middleware creates rate limiting middleware
func Middleware(limiter *RateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Use IP address as identifier
            identifier := GetClientIP(r)

            if !limiter.Allow(identifier) {
                w.Header().Set("Retry-After", "60")
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// GetClientIP extracts client IP from request.
//
// SECURITY: X-Forwarded-For and X-Real-IP are client-controlled headers.
// Only trust them when your own trusted proxy sets or overwrites them.
// If this service is directly internet-facing, use only r.RemoteAddr,
// otherwise clients can spoof these headers to bypass IP rate limits.
func GetClientIP(r *http.Request) string {
    // Check X-Forwarded-For header (only valid behind a trusted proxy)
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        // Take first IP if multiple
        if idx := strings.Index(xff, ","); idx != -1 {
            return strings.TrimSpace(xff[:idx])
        }
        return strings.TrimSpace(xff)
    }

    // Check X-Real-IP header
    if xri := r.Header.Get("X-Real-IP"); xri != "" {
        return strings.TrimSpace(xri)
    }

    // Fallback to RemoteAddr
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    return ip
}
```

### Junior → FAANG: Building Rate Limiting That Survives Production

Rate limiting looks simple but has more edge cases than most juniors expect. An in-process rate limiter works in a single-instance deployment and fails in a horizontally scaled deployment. Understanding this distinction is expected knowledge at FAANG companies.

**Gap to close:** Understand the difference between in-process rate limiting (using `golang.org/x/time/rate`) and distributed rate limiting (using Redis or a dedicated rate limiting service). In-process limiting counts only requests handled by the current instance. If you have 10 instances and a per-user limit of 100 requests per minute, a determined attacker can make 1000 requests per minute by distributing across instances. For any limit that must be enforced globally, use distributed state.

**First-job habit:** Label rate limiting denials in your metrics: counter name, endpoint, client identifier (IP or user ID). This makes it straightforward to identify which clients are being throttled and whether the limit is too restrictive or appropriately calibrated. Without this, tuning rate limits is guesswork.

**Interview framing:** When asked to design a rate limiter, describe the token bucket algorithm (tokens refill at a constant rate, each request consumes a token, requests are denied when the bucket is empty) and sliding window (count requests in a rolling time window). Know the trade-offs: token bucket allows bursts up to the bucket size, sliding window is smoother. Then mention the distributed case and how Redis with Lua scripts provides atomic increment operations for safe distributed counting.

### Senior @ FAANG: Rate Limiting as Infrastructure, Not Per-Service Code

At senior level, rate limiting is a platform concern. Every service implementing its own rate limiter is a scaling and consistency problem. The org-wide answer is a shared rate limiting infrastructure that services consume as a policy.

**Rate limiting architecture patterns:** At L6+, evaluate three deployment patterns. First: gateway-level rate limiting (the API gateway or load balancer enforces limits before requests reach services). Second: sidecar rate limiting (an Envoy or Linkerd sidecar enforces limits per-pod with centralized coordination). Third: application-level rate limiting with a shared Redis cluster. Each pattern has trade-offs on latency, accuracy, and operational complexity. Document your choice in an ADR with explicit reasoning about your scale and failure mode requirements.

**Failure mode design:** What happens when the Redis cluster used for rate limiting is unavailable? Fail open (allow all requests) maintains availability but removes the protection. Fail closed (deny all requests) is safe but causes a complete service outage. Fail open with alerting is the most common production choice, with an SLA for Redis availability high enough that the window of exposure is minimal. Document this decision explicitly. The wrong default causes either an availability incident or an unmitigated abuse window.

**Rate limit policy as data:** At scale, rate limit policies should be stored as data (in a database or configuration service) rather than hardcoded in service configuration. This allows policies to be adjusted dynamically in response to abuse patterns without deploying code. Build a policy management UI or API that the operations team can use to tighten limits on a specific customer or endpoint in real time.

**Differentiated limits:** Apply different limits to different request classes. Authenticated users get higher limits than unauthenticated users. Premium tier customers get higher limits than free tier customers. Read operations get higher limits than write operations. Implement these distinctions through a rate limit policy that takes the request context as input, not through multiple separate middleware registrations. A single middleware that consults a policy table is more maintainable than five separate middleware instances with hardcoded limits.

**Measurement and capacity planning:** Rate limiting data tells you about your abuse profile and your organic traffic patterns. Track the ratio of rate-limited to successful requests per endpoint. A ratio above 1% on a non-authentication endpoint warrants investigation. Use rate limit admission data to inform capacity planning: if 15% of requests are being dropped due to rate limits, you may need to raise limits and scale out rather than turn away legitimate traffic.

---
