## 42.3 Rate Limiting Middleware

### HTTP Middleware

Rate limiting belongs in middleware so it runs before any handler logic. The middleware extracts a key from the request (IP, user ID, or API key), checks the limiter, sets the standard response headers, and either passes the request through or returns a `429`. Key extraction functions are separated out so the same limiter can be keyed differently depending on context, by IP for anonymous traffic, by user ID for authenticated requests, or by endpoint for per-route limits.

Two details in the code below carry most of the production weight. First, the headers follow the IETF draft's consolidated shape rather than the older `X-RateLimit-*` convention, and the reset is expressed as **seconds remaining**, not a Unix timestamp. Second, every key extractor treats its input as hostile, because every one of them reads a request header the client fully controls.

```go
// ... imports omitted for brevity (crypto/sha256, encoding/hex, fmt, net,
// net/http, net/netip, strconv, strings, time)

// setRateLimitHeaders emits the IETF draft headers
// (draft-ietf-httpapi-ratelimit-headers). The draft consolidated the older
// RateLimit-Limit / -Remaining / -Reset trio into one RateLimit header of
// structured-field members bound to a named policy:
//
//	RateLimit-Policy: "api";q=100;w=60
//	RateLimit:        "api";r=95;t=45
//
// q is the quota, w the window in seconds, r the remaining count, and t the
// seconds until reset. t is a *delta*, not a timestamp. Emitting a Unix
// timestamp where a client expects a delta makes well-behaved clients sleep
// for decades, which is a far worse outage than the one you were preventing.
func setRateLimitHeaders(w http.ResponseWriter, policy string, quota, remaining int, window, resetIn time.Duration) {
    if remaining < 0 {
        remaining = 0
    }
    resetSecs := int(resetIn.Seconds())
    if resetSecs < 0 {
        resetSecs = 0
    }

    w.Header().Set("RateLimit-Policy",
        fmt.Sprintf("%q;q=%d;w=%d", policy, quota, int(window.Seconds())))
    w.Header().Set("RateLimit",
        fmt.Sprintf("%q;r=%d;t=%d", policy, remaining, resetSecs))
}

// RateLimitMiddleware creates rate limiting middleware
func RateLimitMiddleware(limiter RateLimiter, window time.Duration, keyFunc func(*http.Request) string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := keyFunc(r)

            allowed, remaining, resetAt := limiter.Allow(key)
            resetIn := time.Until(resetAt)

            setRateLimitHeaders(w, "default", limiter.Limit(), remaining, window, resetIn)

            if !allowed {
                // Retry-After is defined by RFC 9110. Round *up* and floor at
                // 1: rounding down hands the client a delay that is still
                // inside the window, so its retry is rejected too and it
                // learns to ignore the header.
                retryAfter := int(resetIn.Round(time.Second).Seconds())
                if resetIn > 0 && time.Duration(retryAfter)*time.Second < resetIn {
                    retryAfter++
                }
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

Now the key extractors. `IPKeyFunc` takes a count of trusted proxies rather than blindly reading `X-Forwarded-For`, because that header is appended to by each hop and a client can pre-seed it with any value it likes. If your load balancer appends one entry, the only entry you can trust is the last one, and everything to its left is client-authored fiction.

```go
// IPKeyFunc returns an extractor that reads the client IP from
// X-Forwarded-For, trusting exactly trustedProxies hops.
//
// Pass 0 when the service is exposed directly: X-Forwarded-For is then
// ignored entirely, because there is no proxy to have written it and any
// value present is forged. Never take the *leftmost* XFF entry on a public
// service. It is whatever the client typed, so an attacker rotates it per
// request and gets an unlimited number of rate limit buckets, which is the
// same as having no rate limiting at all.
func IPKeyFunc(trustedProxies int) func(*http.Request) string {
    return func(r *http.Request) string {
        host, _, err := net.SplitHostPort(r.RemoteAddr)
        if err != nil {
            host = r.RemoteAddr
        }
        if trustedProxies <= 0 {
            return canonicalIP(host)
        }

        var hops []string
        for _, v := range r.Header.Values("X-Forwarded-For") {
            for _, p := range strings.Split(v, ",") {
                if p = strings.TrimSpace(p); p != "" {
                    hops = append(hops, p)
                }
            }
        }
        // The rightmost entries were appended by our own proxies. Step back
        // trustedProxies hops to find the address our edge actually observed.
        idx := len(hops) - trustedProxies
        if idx < 0 || idx >= len(hops) {
            return canonicalIP(host) // header shorter than expected: distrust it
        }
        return canonicalIP(hops[idx])
    }
}

// canonicalIP normalises the address so that ::1, 0:0:0:0:0:0:0:1 and
// [::1] all collapse to one bucket. Without this an IPv6 client can spell
// its own address several ways and get a fresh quota for each spelling.
func canonicalIP(s string) string {
    addr, err := netip.ParseAddr(strings.Trim(s, "[]"))
    if err != nil {
        return "invalid"
    }
    return addr.Unmap().String()
}

func UserKeyFunc(ipKey func(*http.Request) string) func(*http.Request) string {
    return func(r *http.Request) string {
        if user := GetUser(r.Context()); user != nil {
            return "user:" + user.ID
        }
        return "ip:" + ipKey(r)
    }
}

// APIKeyKeyFunc buckets by a hash of the API key.
//
// Do not slice the raw key. `key[:8]` panics outright on any key shorter
// than 8 bytes, and the key is an attacker-supplied header: sending
// `X-API-Key: abc` yields
//
//	runtime error: slice bounds out of range [:8] with length 3
//
// which the server surfaces as a 500. That is an unauthenticated,
// one-header denial of service against the very middleware meant to
// prevent one.
//
// A prefix is also not "safe". It writes eight bytes of a live credential
// into the limiter's key space, so anyone who can read Redis or a metrics
// label harvests key prefixes. Worse, if the keys share a common prefix
// (`sk_live_...`, as most issued key formats do) every key hashes to the
// same bucket, all tenants share one quota, and one noisy customer rate
// limits everybody. Hashing fixes correctness and confidentiality at once:
// full-key input means no collisions, and a digest leaks nothing.
func APIKeyKeyFunc(ipKey func(*http.Request) string) func(*http.Request) string {
    return func(r *http.Request) string {
        if key := r.Header.Get("X-API-Key"); key != "" {
            sum := sha256.Sum256([]byte(key))
            return "apikey:" + hex.EncodeToString(sum[:])
        }
        return "ip:" + ipKey(r)
    }
}

// EndpointKeyFunc keys by route. Use r.Pattern (Go 1.23+), which is the
// matched route template such as "GET /api/v1/users/{id}", not r.URL.Path.
// Keying on the raw path gives every distinct /users/1, /users/2 its own
// bucket, so an attacker walking IDs is never limited at all.
func EndpointKeyFunc(ipKey func(*http.Request) string) func(*http.Request) string {
    return func(r *http.Request) string {
        route := r.Pattern
        if route == "" {
            route = r.Method + " " + r.URL.Path // not routed by http.ServeMux
        }
        return ipKey(r) + ":" + route
    }
}
```

### Tiered Rate Limiting

Different users deserve different limits. A free-tier user sending 100 requests per minute might be abusive, while an enterprise customer at the same rate is well within their contracted quota. `TieredRateLimiter` maps user tiers to separate token bucket instances, each with its own rate and burst configuration. The middleware reads the user's tier from the request context (set by an earlier auth middleware), selects the matching limiter, and names the tier in the `RateLimit-Policy` header so clients can see which plan their key is on.

Look closely at the burst sizes below. Each one equals a full window's quota, which means a free-tier client can spend all 60 of its per-minute requests in a single millisecond and then wait. That is a deliberate choice, not an oversight: it is friendly to clients that batch work and it still caps sustained throughput at the refill rate. If your downstream cannot absorb 60 simultaneous requests, set the burst to something far smaller than the quota. Burst and rate are independent knobs and conflating them is how a limiter that looks correct on paper takes down a database.

```go
// ... imports omitted for brevity (fmt, net/http, time)

// TieredRateLimiter applies different limits based on user tier
type TieredRateLimiter struct {
    tiers       map[string]RateLimiter
    defaultTier string
    ipKey       func(*http.Request) string // fallback keying for anonymous callers
}

// rate is tokens/second, so the per-minute quota is rate*60.
// trustedProxies is passed through to IPKeyFunc: see the note there.
func NewTieredRateLimiter(trustedProxies int) *TieredRateLimiter {
    return &TieredRateLimiter{
        ipKey: IPKeyFunc(trustedProxies),
        tiers: map[string]RateLimiter{
            "free":       NewTokenBucketLimiter(1, 60),        // 60/min
            "basic":      NewTokenBucketLimiter(10, 600),      // 600/min
            "pro":        NewTokenBucketLimiter(100, 6000),    // 6000/min
            "enterprise": NewTokenBucketLimiter(1000, 60000),  // 60000/min
        },
        defaultTier: "free",
    }
}

func (t *TieredRateLimiter) Middleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := GetUser(r.Context())

            // Determine tier
            tier := t.defaultTier
            if user != nil {
                tier = user.Tier
            }

            limiter, ok := t.tiers[tier]
            if !ok {
                limiter = t.tiers[t.defaultTier]
            }

            // Get key. Namespace it by tier: without the prefix, a user who
            // is downgraded mid-window keeps consuming the bucket they filled
            // under the old tier.
            key := tier + ":anonymous:" + t.ipKey(r)
            if user != nil {
                key = tier + ":user:" + user.ID
            }

            allowed, remaining, resetAt := limiter.Allow(key)
            resetIn := time.Until(resetAt)

            // The tier name is the policy name. No X-RateLimit-Tier needed:
            // the draft already gives us a slot for naming the policy in play.
            setRateLimitHeaders(w, tier, limiter.Limit(), remaining, time.Minute, resetIn)

            if !allowed {
                retryAfter := int(resetIn.Seconds())
                if retryAfter < 1 {
                    retryAfter = 1
                }
                w.Header().Set("Retry-After", strconv.Itoa(retryAfter))

                // RFC 9457 Problem Details, the same error shape the rest of
                // the API uses. A 429 is not special enough to deserve its own
                // bespoke error envelope.
                w.Header().Set("Content-Type", "application/problem+json")
                WriteJSON(w, http.StatusTooManyRequests, map[string]any{
                    "type":     "https://example.com/probs/rate-limit-exceeded",
                    "title":    "Too Many Requests",
                    "status":   http.StatusTooManyRequests,
                    "detail":   fmt.Sprintf("Quota for the %s tier is exhausted. Retry in %ds.", tier, retryAfter),
                    "tier":     tier,
                    "upgrade":  "https://example.com/pricing",
                })
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Per-Endpoint Rate Limiting

Not all endpoints cost the same to serve. A `GET /users` lookup hits an indexed read, while a `POST /export` triggers a minutes-long background job. `EndpointLimits` assigns a separate sliding window limiter to each route, with a configurable default for unregistered routes. The `setupRateLimits` function at the bottom shows how to register tighter limits on security-sensitive paths like login and password reset, and on computationally expensive operations like export.

The lookup key is `r.Pattern`, the route template `http.ServeMux` matched (Go 1.23 and later), rather than `r.URL.Path`. On the static paths registered below the two are identical, which is exactly why the distinction is easy to get wrong and ship. The moment you add `GET /api/v1/users/{id}`, keying on the raw path gives `/users/1` and `/users/2` separate limiter entries. An attacker enumerating IDs would then never touch the same bucket twice and would never be limited, while the map grows one entry per ID probed.

```go
// ... imports omitted for brevity (net/http, sync, time)

// EndpointLimits defines rate limits per endpoint
type EndpointLimits struct {
    mu             sync.RWMutex
    limits         map[string]RateLimiter
    windows        map[string]time.Duration
    defaultLimiter RateLimiter
    defaultWindow  time.Duration
    userKey        func(*http.Request) string
}

func NewEndpointLimits(defaultRate int, defaultWindow time.Duration, trustedProxies int) *EndpointLimits {
    return &EndpointLimits{
        limits:         make(map[string]RateLimiter),
        windows:        make(map[string]time.Duration),
        defaultLimiter: NewSlidingWindowCounterLimiter(defaultRate, defaultWindow),
        defaultWindow:  defaultWindow,
        userKey:        UserKeyFunc(IPKeyFunc(trustedProxies)),
    }
}

// SetLimit sets the rate limit for a route. The pattern must be written
// exactly as it is registered on the mux, e.g. "POST /api/v1/auth/login",
// because that string is what r.Pattern reports back at request time.
func (e *EndpointLimits) SetLimit(pattern string, rate int, window time.Duration) {
    e.mu.Lock()
    defer e.mu.Unlock()
    e.limits[pattern] = NewSlidingWindowCounterLimiter(rate, window)
    e.windows[pattern] = window
}

func (e *EndpointLimits) lookup(pattern string) (RateLimiter, time.Duration) {
    e.mu.RLock()
    defer e.mu.RUnlock()
    if l, ok := e.limits[pattern]; ok {
        return l, e.windows[pattern]
    }
    return e.defaultLimiter, e.defaultWindow
}

func (e *EndpointLimits) Middleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // r.Pattern is the matched route template, not the raw path.
            pattern := r.Pattern
            if pattern == "" {
                pattern = r.Method + " " + r.URL.Path
            }

            limiter, window := e.lookup(pattern)

            // The bucket is per route AND per caller. Keying on the route
            // alone would make every user share one quota, so a single
            // client could lock the whole tenant base out of /login.
            key := pattern + "|" + e.userKey(r)

            allowed, remaining, resetAt := limiter.Allow(key)
            resetIn := time.Until(resetAt)

            setRateLimitHeaders(w, pattern, limiter.Limit(), remaining, window, resetIn)

            if !allowed {
                retryAfter := int(resetIn.Seconds())
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

// Usage. Behind one trusted load balancer, hence trustedProxies = 1.
func setupRateLimits() *EndpointLimits {
    limits := NewEndpointLimits(100, time.Minute, 1) // Default: 100/min

    // Login: strict, to blunt credential stuffing.
    limits.SetLimit("POST /api/v1/auth/login", 5, time.Minute)

    // Password reset: very strict.
    limits.SetLimit("POST /api/v1/auth/reset-password", 3, time.Hour)

    // Search: moderate.
    limits.SetLimit("GET /api/v1/search", 30, time.Minute)

    // Export: expensive operation.
    limits.SetLimit("POST /api/v1/export", 5, time.Hour)

    return limits
}
```


### Junior → FAANG: Middleware Composition and the Key Extraction Problem

Middleware is where theory meets production correctness. The most common mistake in rate limiting middleware is trusting `X-Forwarded-For` unconditionally. That header is a comma-separated list appended to by each hop, and nothing stops a client from arriving with one already in it. Reading the leftmost entry, which many tutorials show, reads whatever the client typed. The consequence is not a subtle inaccuracy. It is total bypass: the attacker sends a different forged leftmost IP on every request, every request lands in a fresh bucket, and the limiter never fires while faithfully reporting healthy metrics. That is why `IPKeyFunc` takes a `trustedProxies` count and steps back exactly that many hops from the right, and why passing 0 makes it ignore the header entirely.

Practice setting this up locally: run a simple Go HTTP server, put nginx in front of it with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, and send requests with a forged header. Observe what your key extraction function sees with `trustedProxies` set to 0 and to 1. Understanding this concretely is what separates a candidate who has read about IP extraction from one who has debugged it.

Two bugs hide in the `key[:8]` version of `APIKeyKeyFunc` that you will still find in production code today. The first is a crash: `key` comes straight from a request header, so `X-API-Key: abc` slices past the end of a three-byte string and panics with `slice bounds out of range [:8] with length 3`. Go recovers the panic per-request, so it becomes a 500 rather than a process death, but it is still a denial of service delivered in one header against the component whose job is preventing denial of service. Any time you slice a string you did not construct, the length check is not optional.

The second bug is quieter and worse. Issued API keys usually share a prefix (`sk_live_`, `AKIA`, and so on). Take the first 8 characters of every key and every tenant lands in the same bucket. The limiter still works, the tests still pass, and every customer now shares a single quota, so your busiest tenant rate limits everyone else. Hashing the whole key with SHA-256 fixes both problems and the confidentiality problem the truncation was supposedly there to solve. The digest is deterministic, fixed-length, collision-free for this purpose, and reveals nothing to whoever can read your Redis keyspace or your metrics labels.

For the tiered middleware, trace the fallback chain: if a user has a tier not listed in the `tiers` map, the code falls back to `defaultTier`. This is a sensible default, but it means a misconfigured user with an unknown tier gets free-tier limits, not an error. Depending on your business rules, this might be the correct behavior or it might mask a configuration bug. Document the choice explicitly.

### Senior @ FAANG: Middleware Architecture for Correctness, Observability, and Tenant Isolation

The middleware code here is readable and, with the key extractors above, safe. A production-grade implementation adds observability on top and pins down the header contract precisely.

**Header correctness and the IETF RateLimit draft.** Most existing APIs emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`, a de-facto convention popularised by GitHub and Twitter. The IETF work in this space (`draft-ietf-httpapi-ratelimit-headers`) went through a design change worth knowing about: earlier revisions mirrored that trio as `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`, and later revisions **consolidated them into a single `RateLimit` header** built from HTTP Structured Fields, paired with `RateLimit-Policy`. Plenty of blog posts and libraries still teach the withdrawn three-header form. The current shape is:

```http
RateLimit-Policy: "burst";q=100;w=60, "daily";q=1000;w=86400
RateLimit: "burst";r=50;t=30
```

`RateLimit-Policy` is a list of the quota policies in force, each a policy name with `q` (quota), optional `w` (window in seconds), and optional `qu` (quota unit, defaulting to requests). `RateLimit` reports live state for the policy that is actually binding, with `r` (remaining) and `t` (seconds until reset). Being a list is the point: an API with both a per-minute burst limit and a per-day quota advertises both, and the client can see which one it is about to hit.

Two things to hold onto. `t` is **seconds remaining, not a Unix timestamp**, and getting that backwards is the single most common implementation bug here, because a client that sleeps for `1704067200` seconds is gone for fifty years. And the draft is explicit that these fields are informative hints, not a guarantee: a server may reject a request even while advertising remaining quota, so a client must still handle a 429 it did not predict. During migration, emit both conventions and remove the `X-` prefixed headers only after your client telemetry says nobody reads them.

**Middleware ordering and the pre-auth problem.** The `UserKeyFunc` in this chapter calls `GetUser(r.Context())`, which requires auth middleware to run first. If the rate limit middleware is installed before auth middleware in the chain, it falls back to IP-based keying for all requests, effectively ignoring user identity. The middleware ordering must be documented and enforced. A common pattern is to install a coarse IP-based limiter early in the chain (before auth) to catch unauthenticated floods, then install a fine-grained user-based limiter after auth middleware. These two layers protect against different threats: the first protects the auth system itself, the second enforces per-user quotas.

**Tenant isolation in the tiered limiter.** The `TieredRateLimiter` uses one `RateLimiter` instance per tier, shared by every user in that tier. Isolation still holds because the key carries the user ID, so counts are tracked per user rather than per tier. What is shared is the instance and therefore its internal map, which grows one entry per active user. For 100,000 pro-tier users that map holds 100,000 entries, and nothing in the code above ever removes them. `NewTokenBucketLimiter` starts no janitor at all, so this is a straightforward unbounded leak, not merely a tuning question: every key that ever appears stays resident for the life of the process. Per-IP keying on a public endpoint makes it an attacker-controlled leak, since the number of distinct keys is the number of distinct source addresses someone is willing to spoof. Any per-key limiter needs a reaper and a `Close()` to stop it, and a limiter type without both should not pass review.

**Cost-based routing at the middleware layer.** The `EndpointLimits` struct assigns a single rate to each route. Cost-based limiting requires knowing the cost of the request before the handler runs, which is impossible for costs that depend on the result (a search's cost depends on the result set size). Two workable models exist. Charge an estimate up front and refund the difference after the handler returns, which keeps the limiter authoritative before any work happens and is what you want when the work is expensive. Or charge the actual cost afterwards and let the *next* request pay for the previous one's overrun, which is simpler but lets a single enormous request through unmetered.

GitHub's GraphQL API is the standard reference here, and it is worth being precise about what it actually does, since it is frequently misdescribed. It scores each query into points from the number of nodes the query could return, budgets 5,000 points per hour, and reports state through `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, and `x-ratelimit-reset`. There is no per-response cost header. A client that wants a specific query's cost asks for it inside the query itself, via the `rateLimit { cost }` field. That is a meaningful design difference: cost is part of the graph, not the transport, and GitHub's own docs steer clients toward the headers rather than spending a call to ask.

**Graceful degradation when the limiter backend is unavailable.** The middleware should have a configurable fail-open or fail-closed policy for when Redis is unreachable. Fail-open (allow all requests when Redis is down) protects availability but removes rate limiting during an outage, which is exactly when abuse traffic is most likely to spike. Fail-closed (deny all requests when Redis is down) protects the system but causes a complete outage if Redis fails. A third option is fail-local: when Redis is unavailable, fall back to an in-process limiter with tighter limits (say, 20 percent of the normal quota) so legitimate traffic can continue at a reduced rate while abuse traffic is still constrained. This policy decision belongs in an ADR with an explicit statement of the business trade-off accepted.
