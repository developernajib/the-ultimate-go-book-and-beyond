## 51.10 Interview Questions

### Question 1: When should you build a custom gateway vs use an off-the-shelf solution?

**Answer:**

```
CUSTOM GATEWAY vs OFF-THE-SHELF

Build Custom Gateway When:
1. Unique business logic required at gateway layer
2. Complex aggregation patterns specific to your domain
3. Special protocol requirements (proprietary, legacy)
4. Need deep integration with internal systems
5. Performance requirements exceed typical solutions
6. Team has expertise and capacity to maintain

Use Off-the-Shelf (Kong, Envoy, AWS API Gateway) When:
1. Standard routing and middleware needs
2. Want proven, battle-tested solution
3. Need plugin ecosystem for extensions
4. Limited engineering resources for maintenance
5. Need quick time-to-market
6. Want enterprise support options

Hybrid Approach:
- Use Envoy/Kong for edge routing, TLS, basic auth
- Custom BFF layer for aggregation and transformation
- Separate concerns: infrastructure vs business logic

Cost Considerations:
- Custom: Engineering time, maintenance, on-call burden
- Off-shelf: Licensing costs, operational complexity, learning curve
```

**What FAANG expects:** A senior answer frames this as a build vs buy decision anchored in three questions. (1) Does the org already run Envoy/Kong/Traefik for other traffic. Reuse that control plane. (2) Is the custom logic aggregation or transformation. Build a thin BFF layer behind a commodity gateway rather than forking the gateway itself. (3) What is the team's on-call capacity. A custom Go gateway that nobody can debug at 3 AM is worse than a Kong cluster with vendor support. The worst answer is, we built our own because Kong felt slow, without benchmarks or a specific missing feature.

**Follow-ups to expect:**
- How would you migrate from a custom gateway to Envoy without downtime. Answer: shadow traffic via the new gateway, diff responses, cut over per-route, keep the old gateway as a fallback for weeks.
- Where do you put auth if both a managed gateway (AWS API Gateway) and Envoy sit in front of services. Answer: outermost layer does coarse authN (API key, JWT signature), inner layer re-validates claims and enforces fine-grained authZ. Never trust upstream headers from an untrusted network.
- Kong is Lua on NGINX, Traefik and KrakenD are Go. Does language matter. Answer: for plugin velocity yes, for data-plane throughput the runtime matters less than the hot path design (connection pooling, zero-copy proxying, avoiding body buffering).

### Question 2: How do you handle rate limiting at the gateway?

**Answer:** Rate limiting at the gateway typically uses one of four algorithms: token bucket (smooth traffic with burst allowance), sliding window (accurate without boundary-burst artifacts), fixed window (simple but prone to edge spikes), or leaky bucket (constant output rate). In production, limits are applied at multiple granularities, per user, per IP, per endpoint, and globally, with Redis as the shared state backend for distributed enforcement.

```go
// pkg/gateway/interview/rate_limiting.go
package interview

import (
	"context"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
)

/*
RATE LIMITING STRATEGIES

1. Token Bucket: Smooth traffic, allows bursts
2. Sliding Window: Accurate, prevents edge bursts
3. Fixed Window: Simple, but has boundary issues
4. Leaky Bucket: Constant output rate

Implementation Levels:
- Per user/API key
- Per IP address
- Per endpoint
- Global
*/

// SlidingWindowRateLimiter implements sliding window with Redis
type SlidingWindowRateLimiter struct {
	redis       *redis.Client
	windowSize  time.Duration
	maxRequests int
}

func (l *SlidingWindowRateLimiter) Allow(ctx context.Context, key string) (bool, int, error) {
	now := time.Now().UnixMilli()
	windowStart := now - l.windowSize.Milliseconds()

	pipe := l.redis.Pipeline()

	// Remove old entries
	pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart))

	// Add current request
	pipe.ZAdd(ctx, key, &redis.Z{
		Score:  float64(now),
		Member: fmt.Sprintf("%d", now),
	})

	// Count requests in window
	countCmd := pipe.ZCard(ctx, key)

	// Set TTL
	pipe.Expire(ctx, key, l.windowSize)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return false, 0, err
	}

	count := int(countCmd.Val())
	remaining := l.maxRequests - count

	if count > l.maxRequests {
		return false, 0, nil
	}

	return true, remaining, nil
}

// Multi-tier rate limiting
type TieredRateLimiter struct {
	limiters map[string]*SlidingWindowRateLimiter
}

func (t *TieredRateLimiter) Check(ctx context.Context, userID, ip, endpoint string) (bool, map[string]int) {
	remaining := make(map[string]int)

	// Check user limit (highest priority)
	if allowed, rem, _ := t.limiters["user"].Allow(ctx, "user:"+userID); !allowed {
		return false, remaining
	} else {
		remaining["user"] = rem
	}

	// Check IP limit
	if allowed, rem, _ := t.limiters["ip"].Allow(ctx, "ip:"+ip); !allowed {
		return false, remaining
	} else {
		remaining["ip"] = rem
	}

	// Check endpoint limit
	if allowed, rem, _ := t.limiters["endpoint"].Allow(ctx, "endpoint:"+endpoint); !allowed {
		return false, remaining
	} else {
		remaining["endpoint"] = rem
	}

	return true, remaining
}
```

**What FAANG expects:** The interviewer wants to hear about distributed correctness, not just algorithm choice. Token buckets in per-process memory do not work behind a load balancer. Redis atomic scripts (Lua `EVALSHA`) or Redis sorted sets under a single key give you global counters, and you must reason about what happens when Redis is down (fail open, fail closed, or degrade to local limits). Mention rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) so clients can back off. Mention hot keys (a celebrity user) and sharding the limiter key space. A staff-level answer also calls out that rate limiting is a fairness mechanism, not a DDoS defense. Real DDoS is absorbed at L3/L4 by Cloudflare, AWS Shield, or the CDN before the gateway ever sees the packet.

**Follow-ups to expect:**
- Redis goes down during an attack. What happens. Answer: fail open for normal traffic with a strict per-instance local limiter as a safety net. Alert on rate-limiter unavailability.
- How do you rate limit a tenant that has 1000 VMs behind one IP versus a residential user behind CGNAT. Answer: authenticated tenant ID is the correct key, IP is a weak fallback only for anonymous endpoints.
- Sliding window log uses O(N) memory per key. What if a user makes 10k req/s. Answer: switch to sliding window counter (two fixed windows with weighted interpolation), or GCRA (leaky bucket variant) with O(1) memory.

### Question 3: How do you implement request aggregation efficiently?

**Answer:** Efficient aggregation fans out independent service calls in parallel under a shared context deadline, caches frequently requested sub-results, and distinguishes required calls (which fail the entire request) from optional ones (which degrade gracefully). Dependent calls that need a parent result execute after their dependency completes, while independent calls proceed concurrently.

```go
// pkg/gateway/interview/aggregation.go
package interview

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

/*
EFFICIENT REQUEST AGGREGATION

Patterns:
1. Parallel fan-out with timeout
2. Selective aggregation (only fetch what's needed)
3. Caching at aggregation layer
4. Circuit breakers per service
5. Graceful degradation
*/

// AggregationEngine handles efficient multi-service calls
type AggregationEngine struct {
	services map[string]ServiceClient
	cache    Cache
	timeout  time.Duration
}

type ServiceClient interface {
	Call(ctx context.Context, method string, params map[string]any) (any, error)
}

type Cache interface {
	Get(key string) (any, bool)
	Set(key string, value any, ttl time.Duration)
}

// AggregationRequest defines what to aggregate
type AggregationRequest struct {
	Queries []ServiceQuery `json:"queries"`
}

type ServiceQuery struct {
	Name      string                 `json:"name"`
	Service   string                 `json:"service"`
	Method    string                 `json:"method"`
	Params    map[string]any `json:"params"`
	CacheTTL  time.Duration          `json:"cache_ttl"`
	Required  bool                   `json:"required"`
	DependsOn string                 `json:"depends_on,omitempty"`
}

func (e *AggregationEngine) Execute(ctx context.Context, req *AggregationRequest) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	results := make(map[string]any)
	errors := make(map[string]error)
	var mu sync.Mutex

	// Group queries by dependencies
	independent := []ServiceQuery{}
	dependent := map[string][]ServiceQuery{}

	for _, q := range req.Queries {
		if q.DependsOn == "" {
			independent = append(independent, q)
		} else {
			dependent[q.DependsOn] = append(dependent[q.DependsOn], q)
		}
	}

	// Execute independent queries in parallel
	var wg sync.WaitGroup
	for _, q := range independent {
		wg.Add(1)
		go func(query ServiceQuery) {
			defer wg.Done()

			result, err := e.executeQuery(ctx, query)

			mu.Lock()
			if err != nil {
				errors[query.Name] = err
			} else {
				results[query.Name] = result
			}
			mu.Unlock()

			// Execute dependent queries
			if deps, ok := dependent[query.Name]; ok && err == nil {
				for _, depQuery := range deps {
					// Inject dependency result into params
					depQuery.Params["_parent"] = result
					wg.Add(1)
					go func(dq ServiceQuery) {
						defer wg.Done()
						r, e := e.executeQuery(ctx, dq)
						mu.Lock()
						if e != nil {
							errors[dq.Name] = e
						} else {
							results[dq.Name] = r
						}
						mu.Unlock()
					}(depQuery)
				}
			}
		}(q)
	}

	wg.Wait()

	// Check required queries
	for _, q := range req.Queries {
		if q.Required {
			if _, ok := results[q.Name]; !ok {
				return nil, errors[q.Name]
			}
		}
	}

	return results, nil
}

func (e *AggregationEngine) executeQuery(ctx context.Context, q ServiceQuery) (any, error) {
	// Check cache
	cacheKey := generateCacheKey(q)
	if cached, ok := e.cache.Get(cacheKey); ok {
		return cached, nil
	}

	// Call service
	client := e.services[q.Service]
	result, err := client.Call(ctx, q.Method, q.Params)
	if err != nil {
		return nil, err
	}

	// Cache result
	if q.CacheTTL > 0 {
		e.cache.Set(cacheKey, result, q.CacheTTL)
	}

	return result, nil
}

func generateCacheKey(q ServiceQuery) string {
	params, _ := json.Marshal(q.Params)
	return fmt.Sprintf("%s:%s:%s", q.Service, q.Method, string(params))
}
```

**What FAANG expects:** The critical point is cascading failure. If your aggregator calls 5 services and each has 99.9% availability, your aggregate availability is 99.5%. Worse, if one slow dependency buffers responses, you hold connections open and starve goroutines. A senior answer says: bound every fan-out call with its own short timeout (not just the outer context), wrap each call in a per-service circuit breaker, classify calls as required vs optional so optional failures degrade gracefully (return partial data with a `X-Partial: true` header or a per-field null), and cache aggressively at the aggregation layer with stale-while-revalidate. Mention that aggregation belongs in a BFF, not in a shared gateway, because different clients want different shapes. KrakenD exists specifically for this pattern, declarative JSON, no code.

**Follow-ups to expect:**
- One upstream is slow but not failing. Circuit breaker does not trip. What happens. Answer: per-call timeout fires, the breaker records a failure, and after enough consecutive timeouts the breaker opens. Tune timeout below p99 of the dependency, not average.
- Should the gateway do GraphQL-style field-level composition. Answer: possible with GraphQL federation (Apollo, gqlgen) but now the gateway parses queries. Most teams keep the gateway dumb and put GraphQL behind it as a separate tier.
- How do you avoid the N+1 problem when aggregating. Answer: batch loaders (DataLoader pattern), collapse downstream calls, or push aggregation into the owning service via a purpose-built endpoint.

### Junior -> FAANG: How to Prepare for Gateway Interview Questions

The three questions in this section represent the three most common gateway topics in system design interviews. Practice answering each in 60-90 seconds before expanding into detail. Interviewers interrupt rambling answers. A crisp opening statement signals confidence.

For Question 1 (custom vs off-the-shelf): open with "it depends on three factors" and then name them: whether the team already operates a standard gateway, whether the custom logic is aggregation or infrastructure, and whether the team has on-call capacity to maintain a custom binary. Then say which you would recommend for the specific scenario in the question. End with the hybrid option (standard gateway for edge, custom BFF for aggregation).

For Question 2 (rate limiting): open with the algorithm comparison (token bucket allows bursts, sliding window is accurate, fixed window has edge spikes). Then move to distributed state (Redis is the standard). Then mention the failure mode (Redis down, fall open with local limiter). Finish with hot key considerations (celebrity user, CGNAT).

For Question 3 (aggregation): open with the availability math (five 99.9% services give 99.5% aggregate). Then describe fan-out with shared deadline. Then required vs optional. Then circuit breaker per upstream. Finish with caching at the aggregation layer.

### Senior @ FAANG: What Bar-Raisers Listen for in Gateway Questions

Bar-raisers at L6/L7 listen for second and third-order reasoning, not just correct first-order answers.

**Build vs buy second order.** After you say "use Kong for edge routing," the bar-raiser asks "Kong uses Lua plugins on NGINX. What are the operational implications when your team is primarily Go engineers?" The expected answer addresses: Lua plugin development requires a different toolchain, debugging Lua inside NGINX is harder than debugging Go code, and Kong's plugin ecosystem is mature but adding custom plugins requires Lua expertise. The alternative is Traefik or KrakenD (Go-native) which have smaller plugin ecosystems but better fit a Go-centric team.

**Rate limiting second order.** After you describe sliding window with Redis, the bar-raiser asks "a single user is sending 100k requests per second from a botnet. Your Redis cluster has 10ms average latency. Walk me through what happens." The expected answer: at 100k RPS the Redis pipeline for this user's key becomes a bottleneck even with pipelining. Sliding window log (sorted set per user) is now the hot key. You need key sharding (distribute the user's counter across N Redis keys and aggregate), or a different algorithm (GCRA with O(1) memory and a single key per user), or you accept that bot traffic should be absorbed at the CDN/WAF layer before it reaches the gateway.

**Aggregation second order.** After you describe parallel fan-out with a shared deadline, the bar-raiser asks "your aggregation endpoint calls a service that takes 4.9 seconds reliably (just under your 5-second deadline). Clients are complaining about high latency but the service is healthy. How do you fix this?" The expected answers: (a) cache the slow service's response aggressively since it is deterministic, (b) make it optional and return a partial response immediately if it has not returned within a shorter per-call timeout, (c) move the call out of the aggregation to a background prefetch triggered by a user session event, or (d) work with the service team to understand why it takes 4.9 seconds (likely a database query without an index) and fix the root cause. A bar-raiser wants to see that you reach for the root cause fix rather than accepting latency as fixed.

---
