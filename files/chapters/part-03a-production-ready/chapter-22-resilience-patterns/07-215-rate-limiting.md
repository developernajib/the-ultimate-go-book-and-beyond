## 22.5 Rate Limiting

### Token Bucket

The `golang.org/x/time/rate` package implements a token bucket limiter: tokens accrue at the specified rate up to the burst capacity, and each request consumes one token. `Allow` returns immediately without blocking, while `Wait` blocks until a token is available or the context is canceled, giving callers flexible control over backpressure.

```go
// Imports for every snippet in this section.
import (
    "math"
    "net"
    "net/http"
    "strconv"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// 10 requests per second, burst of 20
limiter := rate.NewLimiter(10, 20)

func handler(w http.ResponseWriter, r *http.Request) {
    if !limiter.Allow() {
        http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
        return
    }
    // Handle request
}

// With context (blocking)
func handlerBlocking(w http.ResponseWriter, r *http.Request) {
    if err := limiter.Wait(r.Context()); err != nil {
        http.Error(w, "Request canceled", http.StatusServiceUnavailable)
        return
    }
    // Handle request
}
```

### Per-Client Rate Limiting

A global rate limiter protects the server from aggregate overload, but per-client limiting prevents a single noisy caller from consuming the full allowed rate. The `ClientLimiter` maintains a separate token bucket for each client, lazily creating limiters on first access and evicting idle ones.

Two things below look like details and are not: **how the client key is derived**, and **what removes entries from the map**. Get either wrong and you have a limiter that does not limit, or a memory leak that is also a denial-of-service vector. Both mistakes are demonstrated right after the code.

```go
type clientEntry struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

type ClientLimiter struct {
    mu       sync.Mutex
    clients  map[string]*clientEntry
    rate     rate.Limit
    burst    int
    ttl      time.Duration
}

func NewClientLimiter(r rate.Limit, burst int, ttl time.Duration) *ClientLimiter {
    cl := &ClientLimiter{
        clients: make(map[string]*clientEntry),
        rate:    r,
        burst:   burst,
        ttl:     ttl,
    }
    go cl.reapLoop()
    return cl
}

func (cl *ClientLimiter) GetLimiter(clientID string) *rate.Limiter {
    cl.mu.Lock()
    defer cl.mu.Unlock()

    e, exists := cl.clients[clientID]
    if !exists {
        e = &clientEntry{limiter: rate.NewLimiter(cl.rate, cl.burst)}
        cl.clients[clientID] = e
    }
    e.lastSeen = time.Now()
    return e.limiter
}

// reapLoop evicts idle clients. Without it, the map is an unbounded,
// attacker-controlled allocation: one entry per distinct key, forever.
func (cl *ClientLimiter) reapLoop() {
    ticker := time.NewTicker(cl.ttl)
    defer ticker.Stop()
    for range ticker.C {
        cutoff := time.Now().Add(-cl.ttl)
        cl.mu.Lock()
        for id, e := range cl.clients {
            if e.lastSeen.Before(cutoff) {
                delete(cl.clients, id)
            }
        }
        cl.mu.Unlock()
    }
}

// clientKey derives a STABLE identity for the caller.
func clientKey(r *http.Request) string {
    if id := r.Header.Get("X-Client-ID"); id != "" {
        return "id:" + id
    }
    // r.RemoteAddr is "IP:port". The port is a fresh ephemeral number on
    // every connection, so it must be stripped or the key is never stable.
    host, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        host = r.RemoteAddr
    }
    return "ip:" + host
}

func rateLimitMiddleware(cl *ClientLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            limiter := cl.GetLimiter(clientKey(r))

            // Reserve rather than Allow, so we can tell the client exactly
            // how long to wait instead of guessing "1".
            res := limiter.Reserve()
            if !res.OK() || res.Delay() > 0 {
                res.Cancel() // give the token back: we are not serving this
                retryAfter := int(math.Ceil(res.Delay().Seconds()))
                if retryAfter < 1 {
                    retryAfter = 1
                }
                w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Two Bugs That Make a Rate Limiter Decorative

**`r.RemoteAddr` is not a client identity.** It is `"IP:port"`, and the port is a new ephemeral value for every TCP connection. Key the map on it and every connection mints a brand new bucket with a full burst allowance. Configure a limiter at 1 req/s with a burst of 2, then send 100 requests from a single IP across 100 connections:

```
ONE client IP, 100 requests across 100 connections
limiter configured: 1 req/s, burst 2
  allowed: 100 / 100   denied: 0 / 100
  distinct limiters retained in map: 100
```

Every request allowed. The limiter is pure decoration, and the only thing it reliably does is allocate. Strip the port and key on the IP, and the same 100 requests behave as configured:

```
keying by IP only:
  allowed: 2 / 100   denied: 98 / 100
  distinct limiters retained in map: 1
```

Two tokens of burst, then correctly shed. This is worth an integration test in your own codebase, because the broken version passes every unit test written with a single hardcoded `RemoteAddr`.

**A map keyed by client is an unbounded allocation.** Even keyed correctly, entries are created on first sight and never removed, so memory grows with the number of *distinct* clients ever seen. From the public internet that set is effectively unbounded, and since the key comes from the request, an attacker chooses how fast you allocate. Spraying requests from many source IPs (or many `X-Client-ID` values, which are even cheaper to forge) turns your rate limiter into the thing that exhausts your memory. The limiter designed to protect you becomes the attack surface.

The TTL reaper above is the minimum fix. For a hard bound, use an LRU with a fixed maximum instead, so worst-case memory is a constant you choose rather than a function of attacker behaviour.

A closing note on the key itself: behind a load balancer, `RemoteAddr` is the *proxy's* address, so every client shares one bucket and one noisy neighbour shuts out everyone. You need `X-Forwarded-For` there, but only trust it when the hop is your own proxy, since clients can forge the header freely. An authenticated identity (API key, user ID) is always the better key when you have one, because it is the only one the caller cannot cheaply rotate.

### Staff Lens: In-Process vs Distributed

Per-instance rate limits protect one process. Distributed rate limits (Redis-backed) enforce global quotas across replicas. For public APIs, you need distributed. For in-process protection, per-instance suffices. Know which you need.

### Proper 429 Semantics

Return `429 Too Many Requests` with a `Retry-After` header. Clients that respect it back off. Clients that do not are broken and should be tracked.

Compute the value rather than hardcoding `"1"`. `limiter.Reserve()` returns a `*rate.Reservation` whose `Delay()` says exactly how long until a token is available, which is strictly better information than a constant guess. Two rules when using it:

- **Always `Cancel()` a reservation you are not going to honour.** `Reserve` *takes* the token immediately and `Delay()` tells you when it becomes valid. If you reject the request without cancelling, you have consumed a token to serve nobody, and the client's next attempt is throttled by a request that never ran.
- **Never use `Wait()` on an inbound request path under overload.** `Wait` blocks the handler, so a flood of excess requests becomes a pile of goroutines each holding a connection and its buffers. That converts a rate limit into a memory-exhaustion vector. Shed with `Allow`/`Reserve` at the edge, and save `Wait` for *outbound* calls, where blocking is exactly the backpressure you want.

---
