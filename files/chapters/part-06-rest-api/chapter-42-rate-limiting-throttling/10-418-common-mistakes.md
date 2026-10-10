## 42.8 Common Mistakes

### Mistake 1: Not Handling Redis Failures Gracefully

When Redis is unavailable, failing closed blocks all traffic (effectively a self-inflicted outage) while failing open risks letting abuse through. The `ResilientRateLimiter` wraps the Redis limiter in a circuit breaker: once the breaker trips, requests fall through to a local in-process limiter until a background goroutine confirms Redis has recovered.

Fail-open is the usual default, but state the trade-off rather than absorbing it as folklore. Failing open on a *login* limiter during a Redis outage hands an attacker an unmetered credential-stuffing window, and "we were fixing Redis" is not a defence anyone accepts afterwards. The real answer is per-endpoint: fail open on ordinary reads where the downside is cost, fail closed (or fall back to a much tighter local limit) on the endpoints whose limiter exists for security rather than for capacity.

```go
// WRONG: Fail closed on Redis errors
func (r *RateLimiter) Allow(ctx context.Context, key string) bool {
    result, err := r.client.Incr(ctx, key).Result()
    if err != nil {
        // Redis is down - reject all requests!
        return false
    }
    return result <= int64(r.limit)
}

// CORRECT: Fail open with fallback
func (r *RateLimiter) Allow(ctx context.Context, key string) bool {
    // Try Redis first
    result, err := r.checkRedis(ctx, key)
    if err != nil {
        // Log the error, but NOT the key. The rate limit key is derived from
        // an API key or a user identity. Logging it copies a credential into
        // your log pipeline, where it is replicated, indexed, shipped to a
        // third-party aggregator, and retained for a year. Log a hash, or a
        // key class, and never the raw value.
        r.logger.Error("redis rate limit check failed",
            "error", err,
            "key_hash", keyHash(key))

        // Increment failure counter
        r.redisFailures.Inc()

        // Fall back to local limiter
        return r.localLimiter.Allow(key)
    }

    return result
}

// Even better: Circuit breaker for Redis
type ResilientRateLimiter struct {
    redis    *RedisRateLimiter
    local    *LocalRateLimiter
    breaker  *circuitbreaker.CircuitBreaker
    useLocal atomic.Bool
}

func (r *ResilientRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    if r.useLocal.Load() {
        return r.local.Allow(key), nil
    }

    result, err := r.breaker.Execute(func() (any, error) {
        return r.redis.Allow(ctx, key)
    })

    if err != nil {
        // Circuit is open, switch to local.
        //
        // CompareAndSwap, not Store. With Store, every in-flight request
        // that observes the error spawns its own recovery goroutine: at
        // 10k rps a Redis blip launches thousands of pollers, each dialing
        // Redis on a ticker, and the recovery probe becomes the thing that
        // keeps Redis down. CAS guarantees exactly one goroutine wins the
        // transition and starts exactly one poller.
        if r.useLocal.CompareAndSwap(false, true) {
            go r.checkRedisRecovery()
        }

        return r.local.Allow(key), nil
    }

    return result.(bool), nil
}
```

One more consideration that the code cannot express on its own: what rate should the local fallback limiter use? It cannot be the global limit. If the global limit is 100/s and you have 20 pods each running a local limiter at 100/s, failing over admits 2,000/s, so your response to a Redis outage is a 20x traffic increase to a system that is already degraded. Seed the local limiter at roughly `global_limit / expected_pod_count`, and lower still if you want margin for the pod count being wrong. Fail-open is a decision to admit *some* excess. It should never be a decision to admit an unbounded multiple of your limit.

### Mistake 2: Race Conditions in Distributed Rate Limiting

The most common distributed rate limiting bug is a check-then-act race: read the counter, compare it to the limit, then increment. Between the read and the increment, dozens of concurrent requests can all see a count below the threshold and all pass through. The fix is to make the check and increment atomic, either with a Lua script (preferred, since it runs on the Redis server in a single evaluation) or with a `WATCH`/`MULTI`/`EXEC` transaction.

Note what the `WATCH` variant below does and does not do. `WATCH` gives you optimistic concurrency: if another client touches the key between the `WATCH` and the `EXEC`, the transaction aborts with `redis.TxFailedErr`. It does not retry for you. The code as written treats that abort as a rejection, which is defensible for a limiter (an aborted transaction means contention, and contention means the client is near its limit anyway) but is *not* the same as being correct under contention. If you need the retry, you write the loop yourself, and under high concurrency that loop is why Lua is the better answer: it never aborts, so it never needs one.

```go
// WRONG: Non-atomic check-and-increment
func (r *RateLimiter) Allow(ctx context.Context, key string) bool {
    // Race condition: multiple requests can pass before any increment!
    count, _ := r.client.Get(ctx, key).Int()
    if count >= r.limit {
        return false
    }

    r.client.Incr(ctx, key)
    return true
}

// CORRECT: Use Lua script for atomicity
func (r *RateLimiter) Allow(ctx context.Context, key string) bool {
    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])

        local current = redis.call('INCR', key)

        if current == 1 then
            redis.call('EXPIRE', key, window)
        end

        return current <= limit and 1 or 0
    `)

    result, err := script.Run(ctx, r.client, []string{key}, r.limit, r.window).Int()
    if err != nil {
        return true // Fail open
    }

    return result == 1
}

// ALTERNATIVE: Use Redis MULTI/EXEC for simpler cases
func (r *RateLimiter) AllowWithTransaction(ctx context.Context, key string) bool {
    // Watch the key for changes
    err := r.client.Watch(ctx, func(tx *redis.Tx) error {
        count, err := tx.Get(ctx, key).Int()
        if err != nil && err != redis.Nil {
            return err
        }

        if count >= r.limit {
            return ErrRateLimited
        }

        _, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
            pipe.Incr(ctx, key)
            pipe.Expire(ctx, key, r.window)
            return nil
        })

        return err
    }, key)

    return err == nil
}
```

### Mistake 3: Not Including Retry-After Header

A `429` response without `Retry-After` forces clients to use arbitrary delays or exponential backoff from zero, potentially causing a thundering herd when thousands of clients retry at the same moment. Setting `Retry-After` to the seconds until the window resets distributes retry timing and prevents the spike from overwhelming the server when the window opens.

```go
// WRONG: No guidance for when to retry
func rateLimitHandler(w http.ResponseWriter, r *http.Request) {
    if !limiter.Allow(r) {
        http.Error(w, "Too many requests", http.StatusTooManyRequests)
        return
    }
    // Handle request...
}

// CORRECT: Always include retry information
func rateLimitHandler(w http.ResponseWriter, r *http.Request) {
    allowed, remaining, reset := limiter.Allow(r)

    // Always set rate limit headers (IETF draft shape: see 42.6).
    resetIn := time.Until(reset)
    w.Header().Set("RateLimit-Policy",
        fmt.Sprintf("%q;q=%d;w=60", "default", limiter.Limit()))
    w.Header().Set("RateLimit",
        fmt.Sprintf("%q;r=%d;t=%d", "default", max(remaining, 0),
            max(int(resetIn.Seconds()), 0)))

    if !allowed {
        // Round UP. Rounding down returns a delay that still lands inside
        // the window, so the client's obedient retry is rejected too.
        retryAfter := int(resetIn.Seconds())
        if time.Duration(retryAfter)*time.Second < resetIn {
            retryAfter++
        }
        retryAfter = max(retryAfter, 1)

        w.Header().Set("Retry-After", strconv.Itoa(retryAfter))

        // RFC 9457 Problem Details
        w.Header().Set("Content-Type", "application/problem+json")
        w.WriteHeader(http.StatusTooManyRequests)
        json.NewEncoder(w).Encode(map[string]any{
            "type":                "https://example.com/probs/rate-limit-exceeded",
            "title":               "Too Many Requests",
            "status":              http.StatusTooManyRequests,
            "detail":              "Too many requests. Please retry after the specified time.",
            "retry_after_seconds": retryAfter,
        })
        return
    }

    // Handle request...
}
```

### Mistake 4: Using IP Address Without Considering Proxies

`r.RemoteAddr` always contains the address of the last network hop (usually a load balancer or ingress proxy), so rate limiting by it counts all users on the same proxy as one client. `IPExtractor` walks the `X-Forwarded-For` chain from right to left, stopping at the first address not belonging to a trusted proxy CIDR, which prevents IP spoofing through forged headers.

```go
// WRONG: Direct RemoteAddr ignores proxies
func getClientIP(r *http.Request) string {
    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host // This is the proxy's IP, not client's!
}

// STILL WRONG: "validating" the header value is not validating its origin.
//
// This version is the one most likely to survive code review, because it
// looks careful. It is not. Every header in that list is attacker-supplied
// unless you first establish that the request actually came from the proxy
// that sets it. Nothing here checks who the TCP peer is, so:
//
//   curl -H 'CF-Connecting-IP: 9.9.9.9' https://your-api/
//
// wins on the first iteration of the loop. The attacker rotates that value
// per request, gets a fresh bucket every time, and your per-IP limiter
// never fires. isValidIP only checks that the string parses and is not
// private, which an attacker satisfies trivially by picking any public IP.
//
// Taking ips[0] from X-Forwarded-For has the same flaw: the leftmost entry
// is the one furthest from you, so it is the one entry in the chain that
// no infrastructure of yours ever wrote.
func getClientIP(r *http.Request) string {
    headers := []string{
        "CF-Connecting-IP",     // Cloudflare
        "X-Real-IP",            // Nginx
        "True-Client-IP",       // Akamai
        "X-Forwarded-For",      // Standard
    }

    for _, header := range headers {
        if value := r.Header.Get(header); value != "" {
            if header == "X-Forwarded-For" {
                ips := strings.Split(value, ",")
                ip := strings.TrimSpace(ips[0]) // <-- forged by the client
                if isValidIP(ip) {
                    return ip
                }
            } else {
                if isValidIP(value) { // <-- also forged by the client
                    return value
                }
            }
        }
    }

    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host
}

func isValidIP(ip string) bool {
    parsed := net.ParseIP(ip)
    if parsed == nil {
        return false
    }

    // Reject private/internal IPs as client IPs
    // (they're likely proxy addresses)
    privateRanges := []string{
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "127.0.0.0/8",
    }

    for _, cidr := range privateRanges {
        _, network, _ := net.ParseCIDR(cidr)
        if network.Contains(parsed) {
            return false
        }
    }

    return true
}

// CORRECT: establish the ORIGIN of the header before believing its CONTENT.
//
// The rule: an entry in X-Forwarded-For is only as trustworthy as the hop
// that appended it. Start at the TCP peer, which is the one address the
// client cannot forge, and walk leftward for exactly as long as each hop is
// a proxy you operate. The first address that is not one of your proxies is
// the client, and everything to its left is unverifiable.
type IPExtractor struct {
    trustedProxies []*net.IPNet
}

func (e *IPExtractor) GetClientIP(r *http.Request) string {
    remoteIP, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        remoteIP = r.RemoteAddr
    }

    // The TCP peer is not one of our proxies, so no forwarding header can be
    // believed. This is also the correct branch for a directly-exposed
    // service: ignore the headers entirely.
    if !e.isTrustedProxy(remoteIP) {
        return remoteIP
    }

    // Collect the chain. Use Values, not Get: X-Forwarded-For legitimately
    // appears as several header lines, and Get returns only the first, which
    // silently drops the hops that matter most.
    var hops []string
    for _, v := range r.Header.Values("X-Forwarded-For") {
        for _, p := range strings.Split(v, ",") {
            if p = strings.TrimSpace(p); p != "" {
                hops = append(hops, p)
            }
        }
    }

    // Walk right to left. Stop at the first hop we did not append ourselves.
    for i := len(hops) - 1; i >= 0; i-- {
        ip := strings.TrimSpace(hops[i])
        if net.ParseIP(ip) == nil {
            // A garbage entry means the chain is untrustworthy from here
            // leftward. Fall back to the last address we are sure of.
            return remoteIP
        }
        if !e.isTrustedProxy(ip) {
            return ip // first untrusted hop is the real client
        }
    }

    // Every hop was one of ours, so the client is a proxy we operate.
    return remoteIP
}
```

Compare the three versions by asking one question of each: *which address in this data did an attacker choose?* In the first, `RemoteAddr` is chosen by the network and cannot be forged, but it identifies the proxy rather than the client. In the second, every candidate is chosen by the attacker, which is why "validating" the string accomplishes nothing. In the third, the walk starts from the unforgeable address and stops the moment it leaves infrastructure you control, so the answer is "none of the ones we used."

This is the general shape of the problem, not a quirk of `X-Forwarded-For`. When a security decision reads a value, trace who wrote it before you trust it.

### Mistake 5: Not Implementing Gradual Backoff for Clients

A fixed one-second retry delay causes all rate-limited clients to hammer the server simultaneously at the end of each second, defeating the purpose of rate limiting. Exponential backoff with full jitter spreads retries over a widening time window so individual clients gradually back off and the server never receives a synchronized burst on recovery.

Be precise about what "with jitter" means, because the common half-measure does not buy what people think. Simulate 5,000 clients all rate-limited at the same instant with a 1.6s backoff cap, and count the worst 50ms slot:

| Strategy | Peak clients in one 50ms slot |
|---|---|
| No jitter (sleep exactly `cap`) | 5,000 (100% of the fleet) |
| Additive jitter (`cap` ± 25%) | ~331 (7%) |
| **Full jitter** (uniform in `[0, cap)`) | ~177 (4%) |

No jitter is a self-inflicted DDoS: the entire fleet returns in one instant. Additive jitter fixes most of that, and it is where most implementations stop. But it confines every client to a band of width `cap/2` centred on `cap`, so the herd is blurred rather than dispersed, and the peak is roughly twice full jitter's. Full jitter uses the whole interval, which is the point.

The same arithmetic applies to `Retry-After`, and this is the part almost everyone misses. Every client limited in the same window receives the *same* `Retry-After` value, so a client that obeys it exactly is perfectly synchronised with every other client. Honouring `Retry-After` to the millisecond reproduces the 100% row of that table. Wait the interval, then add jitter on top.

```go
// WRONG: Fixed retry delay
func (c *Client) MakeRequest(ctx context.Context) (*Response, error) {
    for i := 0; i < 3; i++ {
        resp, err := c.doRequest(ctx)
        if err == nil {
            return resp, nil
        }

        if isRateLimited(err) {
            time.Sleep(1 * time.Second) // Same delay every time!
            continue
        }

        return nil, err
    }
    return nil, ErrMaxRetriesExceeded
}

// CORRECT: Exponential backoff with FULL jitter, honouring Retry-After
func (c *Client) MakeRequest(ctx context.Context) (*Response, error) {
    maxRetries := 5
    baseDelay := 100 * time.Millisecond
    maxDelay := 30 * time.Second
    jitterWindow := time.Second // spread the herd after Retry-After elapses

    for attempt := 0; attempt < maxRetries; attempt++ {
        resp, err := c.doRequest(ctx)
        if err == nil {
            return resp, nil
        }

        rateLimitErr, ok := err.(*RateLimitError)
        if !ok {
            return nil, err // Non-rate-limit error
        }

        // Compute the delay.
        var delay time.Duration
        if rateLimitErr.RetryAfter > 0 {
            // Honour Retry-After, but do NOT sleep exactly that long.
            // Every client limited in this window received the same value,
            // so obeying it precisely re-synchronises the entire client
            // fleet onto one instant. Wait the full interval (retrying
            // sooner is pointless, the quota is not back yet) and then
            // spread the herd across a jitter window after it.
            delay = rateLimitErr.RetryAfter +
                time.Duration(rand.Int64N(int64(jitterWindow)))
        } else {
            // Exponential backoff with FULL jitter.
            //
            // cap = base * 2^attempt, then sleep uniformly in [0, cap).
            // This is the "Full Jitter" variant from AWS's backoff analysis,
            // and it is not the same as cap +/- 25%. Additive jitter keeps
            // every client clustered in a narrow band around cap, so the
            // herd stays a herd, just a slightly blurrier one. Full jitter
            // spreads clients across the entire interval, which is what
            // actually decorrelates them.
            cap := baseDelay * time.Duration(1<<attempt)
            if cap > maxDelay {
                cap = maxDelay
            }
            delay = time.Duration(rand.Int64N(int64(cap)))
        }

        c.logger.Info("rate limited, backing off",
            "attempt", attempt+1,
            "delay", delay,
            "retry_after", rateLimitErr.RetryAfter)

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(delay):
        }
    }

    return nil, ErrMaxRetriesExceeded
}

type RateLimitError struct {
    StatusCode int
    RetryAfter time.Duration
    Reset      time.Time
}
```

### Junior → FAANG: Internalizing the Common Mistakes

Each mistake in this chapter represents a class of production incident, not just a code smell. Understanding the underlying failure mode accelerates your growth from someone who fixes bugs to someone who prevents them.

**Mistake 1 (Redis failure):** The instinct to fail closed feels safe because it prevents abuse. The operational reality is that a Redis outage causes an immediate, complete service outage for all users if you fail closed, which is usually worse than briefly admitting excess traffic. Train yourself to ask "what is the worst case of each failure mode?" before choosing a default. For rate limiting, the worst case of failing open is a burst of abuse for the outage duration. The worst case of failing closed is a total outage for the same duration. Then notice that the answer flips depending on the endpoint: on `POST /login`, "a burst of abuse" means an unmetered credential-stuffing window, and there the outage is the cheaper failure. "Fail open" is a default, not a principle.

**Mistake 2 (race conditions):** The check-then-act pattern is one of the most common concurrency bugs in distributed systems. The rule is: any operation that reads state and then writes state based on that reading must be atomic. In Redis, Lua scripts are the standard tool. `WATCH/MULTI/EXEC` is an alternative, but it aborts on conflict rather than retrying, so you must write the retry loop and pay for it in latency exactly when contention is highest. For rate limiting at high QPS, Lua is the right choice. Be precise in an interview: Lua on Redis gives you *atomicity* (the script is not interleaved with other clients), not *transactionality* (a mid-script error does not roll back the writes already made).

**Mistake 3 (missing Retry-After):** This mistake compounds because it forces every client to implement their own retry strategy, producing N different backoff behaviors across N SDKs. When a thundering herd results, it looks like a DDoS from your own clients. The fix is trivial, the consequence of omitting it is not.

**Mistake 4 (IP extraction):** The key insight is that correctness depends on which proxies you trust, not on whether the header value looks like an IP. Study the middle example above until the trap is obvious, because it is the version you are most likely to write and most likely to approve in review: it has a header priority list, it parses, it rejects private ranges, and it is completely bypassable with one `curl -H`. Validating the *content* of an attacker-supplied header proves nothing about its *origin*. The trusted-proxy CIDR list is a security boundary. Configure it explicitly, and re-review it whenever your ingress topology changes.

**Mistake 5 (fixed retry delay):** Exponential backoff with full jitter is the correct default. "Full jitter" means the delay is uniformly random in `[0, cap)`, not `cap ± some_fraction`. The distinction is not pedantry: additive jitter leaves the fleet clustered in a band around `cap` and roughly doubles the peak concurrent retry rate versus full jitter, as the table above measures. And remember that `Retry-After` is a shared value, so honouring it exactly re-synchronises every client that received it. Wait it out, then jitter.

### Senior @ FAANG: Systematizing Mistake Prevention

**Making Failures Observable**

The mistakes in this chapter share a property: they are invisible until they cause an incident. Mistake 1 is silent during normal operation and catastrophic during a Redis outage. Mistake 2 produces subtle over-admission that is hard to distinguish from a legitimate traffic surge. Mistake 4 allows IP spoofing that looks like normal usage in access logs.

Senior engineers build observability into the rate limiter as a first-class concern, not a logging afterthought:

- Emit a metric whenever the fallback local limiter is activated (Mistake 1 detection).
- Emit a metric for the "admitted while at limit" rate, which should be near zero for a correct atomic implementation and elevated if a race condition exists (Mistake 2 detection).
- Log a warning whenever a request's derived client IP differs from `RemoteAddr`, and periodically audit the trusted-proxy CIDR list against the current load balancer configuration (Mistake 4 detection).
- Track the distribution of `Retry-After` values actually used by clients (inferred from the gap between sequential requests from the same key) to detect whether clients are honoring the header or ignoring it (Mistake 3 and 5 detection).

**Governance for IP Trust Configuration**

The trusted-proxy CIDR list is a security boundary, and security boundaries require change control. At FAANG, this configuration belongs in a system of record that:

1. Requires a code review from the security team before any CIDR is added.
2. Alerts when a new IP appears in `X-Forwarded-For` that is not in the trusted list, which may indicate a misconfigured proxy or an infrastructure change that bypassed the review process.
3. Provides a diff between the current list and the deployed infrastructure so drift is detected automatically.

Treating the CIDR list as an application config value that any engineer can update in a PR without security review is a common weakness that allows IP spoofing vulnerabilities to be introduced silently.

**Retry Budget as a Platform Contract**

Mistake 5 (fixed retry delay) is a client-side mistake, but the platform team is responsible for providing the infrastructure that makes the correct behavior easy. A good platform SDK includes a default retry policy with exponential backoff and jitter, a maximum retry budget (total time, not just attempt count), and a circuit breaker that stops retrying if error rate exceeds a threshold. Teams that use raw HTTP clients instead of the platform SDK will reproduce Mistake 5 independently. The concrete benefit is in the SDK, not in documentation.

**Thundering Herd Prevention at Platform Level**

Even with `Retry-After` set correctly, a synchronized reset can cause a thundering herd if all clients received their `429` at the same moment and all retry exactly at the reset time. The mitigation is to jitter the reset timestamp itself: instead of resetting at a fixed window boundary, reset at `window_boundary + hash(client_id) % jitter_window`. This distributes reset events across a time interval proportional to the jitter window, preventing the synchronized burst even when clients follow `Retry-After` precisely. This is a platform-level design decision that belongs in the rate limiter implementation, not in client SDKs.

**Bar-Raiser Interview Signals**

"How do you detect that your distributed rate limiter has a race condition in production?" A weak answer is "add a test." A strong answer is "emit a metric for the ratio of admitted requests to total requests at the limit boundary, compare it to the theoretical maximum for your concurrency, and alert when the observed ratio exceeds the theoretical by more than a small margin. A race condition causes the observed ratio to trend above 1.0 over time."

"Your rate limiter uses `RemoteAddr` for IP-based limiting. An engineer proposes switching to `X-Forwarded-For`. What is the security review process?" Strong answers cover: auditing all upstream paths to determine which send `X-Forwarded-For`, validating that the direct TCP peer for each path is a controlled proxy, configuring the trusted-proxy CIDR list, and adding monitoring to detect forged headers. The answer should also include a rollback plan if the migration causes a regression.

---
