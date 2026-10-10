## 64G.7 Production Incident Patterns

### Cascading Failures

A cascading failure occurs when the failure of one service overloads another, which fails and overloads a third, and so on.

```
Cascade example:
1. AuthService starts getting slow (DB query plan regression)
2. OrderService's AuthService calls start timing out after 30s
3. OrderService's goroutines pile up waiting for auth, memory grows
4. OrderService OOMs, crashes
5. UserService's OrderService calls all fail
6. UserService error rate hits 100%
7. Complete outage from a single slow DB query in AuthService

Prevention:
```

```go
package incidents

import (
    "context"
    "encoding/json"
    "errors"
    "net/http"
    "strings"
    "time"
)

type User struct {
    ID string
}

type AuthClient interface {
    Verify(ctx context.Context, token string) (*User, error)
}

type CircuitBreaker interface {
    Execute(fn func() error) (any, error)
}

var (
    authClient          AuthClient
    orderCircuitBreaker CircuitBreaker
)

func processOrderLogic(ctx context.Context, u *User) error { return nil }

// Timeout budget propagation prevents cascade amplification
func orderHandler(w http.ResponseWriter, r *http.Request) {
    // Use the request's existing deadline (set by load balancer or client)
    ctx := r.Context()

    // Don't add MORE time than the client is willing to wait
    // If client timeout is 5s, don't give auth 30s timeout
    authCtx, authCancel := context.WithTimeout(ctx, 2*time.Second) // Max 2s for auth
    defer authCancel()

    user, err := authClient.Verify(authCtx, r.Header.Get("Authorization"))
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            http.Error(w, "auth timeout", http.StatusGatewayTimeout)
            return
        }
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }

    // Use circuit breaker around downstream calls
    result, err := orderCircuitBreaker.Execute(func() error {
        return processOrderLogic(ctx, user)
    })
    if err != nil {
        if strings.Contains(err.Error(), "circuit breaker open") {
            http.Error(w, "service temporarily unavailable", http.StatusServiceUnavailable)
            return
        }
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(result)
}
```

### Thundering Herd at Startup

When many service instances restart simultaneously (after a deployment or a cascading failure), they all attempt to warm up caches and establish connections at the same time, overwhelming downstream dependencies. The following implementation adds jittered startup delays and staggered connection pool warmup to distribute the load spike across a configurable time window.

```go
package incidents

import (
    "context"
    "database/sql"
    "encoding/json"
    "math"
    "math/rand/v2"
    "time"

    "github.com/redis/go-redis/v9"
    "golang.org/x/sync/singleflight"
)

type Product struct {
    ID   string
    Name string
}

func WarmPopularProducts(ctx context.Context, cache *redis.Client, db *sql.DB) {}

func (s *CachedProductService) fetchFromDB(ctx context.Context, id string) (*Product, error) {
    return &Product{ID: id}, nil
}

func (s *CachedProductService) cacheGetWithTTL(ctx context.Context, id string) (*Product, time.Duration, error) {
    return &Product{ID: id}, 2 * time.Minute, nil
}

func (s *CachedProductService) refreshCache(ctx context.Context, id string) {}

func (s *CachedProductService) fetchWithSingleflight(ctx context.Context, id string) (*Product, error) {
    return s.GetProduct(ctx, id)
}

// Problem: all N service instances start simultaneously after deploy

type CachedProductService struct {
    group singleflight.Group
    cache *redis.Client
    db    *sql.DB
}

func (s *CachedProductService) GetProduct(ctx context.Context, id string) (*Product, error) {
    // Multiple concurrent requests for same product ID: only ONE hits the DB
    result, err, _ := s.group.Do(id, func() (any, error) {
        // Check cache
        if p, err := s.cache.Get(ctx, id).Result(); err == nil {
            var product Product
            json.Unmarshal([]byte(p), &product)
            return &product, nil
        }

        // Cache miss: fetch from DB
        product, err := s.fetchFromDB(ctx, id)
        if err != nil {
            return nil, err
        }

        // Populate cache
        data, _ := json.Marshal(product)
        s.cache.SetEx(ctx, id, data, 5*time.Minute)

        return product, nil
    })
    if err != nil {
        return nil, err
    }
    return result.(*Product), nil
}

// Solution 3: Probabilistic early expiration (PER)
// Prevents thundering herd by refreshing cache BEFORE it expires
func (s *CachedProductService) GetProductPER(ctx context.Context, id string) (*Product, error) {
    val, ttlRemaining, err := s.cacheGetWithTTL(ctx, id)
    if err == nil {
        // Probabilistic early refresh: as TTL approaches 0, chance of refresh increases
        beta := 1.0
        gap := float64(ttlRemaining)
        maxGap := 5 * time.Minute
        earlyRefreshProb := math.Exp(-beta * gap / float64(maxGap))

        if rand.Float64() < earlyRefreshProb {
            // This instance races to refresh - other instances serve stale until refresh completes
            go s.refreshCache(context.Background(), id)
        }
        return val, nil
    }

    // Full cache miss - singleflight for DB
    return s.fetchWithSingleflight(ctx, id)
}
```

### Split-Brain Detection and Resolution

Split-brain occurs when two partitioned cluster segments each believe they hold the leader role and accept conflicting writes, leading to data divergence that must be reconciled after the partition heals. The following Go implementation uses fencing tokens and a quorum-check before every write to detect and reject writes from a partitioned former leader, preventing divergence at the cost of availability during the partition.

```go
package incidents

import (
    "context"
    "fmt"
    "sync"

    "go.etcd.io/etcd/api/v3/mvccpb"
    clientv3 "go.etcd.io/etcd/client/v3"
)

func (s *StorageService) doWrite(data []byte) error { return nil }

// Split-brain: two nodes both believe they are the leader
// Cause: network partition heals but old leader didn't know it lost leadership

// Fencing tokens: monotonically increasing token from lock service
// Old leader's token will be rejected by any resource it tries to access

type FencingToken struct {
    Token   int64  // Monotonically increasing
    LeaderID string
    Epoch   int64
}

// Resource guard: reject operations with stale fencing token
type StorageService struct {
    mu           sync.Mutex
    highestToken int64
}

func (s *StorageService) Write(ctx context.Context, token FencingToken, data []byte) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if token.Token < s.highestToken {
        // Old leader trying to write - it lost leadership but doesn't know yet
        return fmt.Errorf("stale fencing token: got %d, have %d", token.Token, s.highestToken)
    }

    s.highestToken = token.Token
    return s.doWrite(data)
}

// Heartbeat-based leader detection
type LeaderWatcher struct {
    etcd      *clientv3.Client
    leaderKey string
    onLost    func() // Called when this node loses leadership
}

func (w *LeaderWatcher) Watch(ctx context.Context) {
    watchChan := w.etcd.Watch(ctx, w.leaderKey)

    for watchResp := range watchChan {
        for _, event := range watchResp.Events {
            if event.Type == mvccpb.DELETE {
                // Leader key deleted - current leader died or session expired
                // If we are not the new leader, call onLost
                w.onLost()
            }
        }
    }
}
```

### Junior → FAANG: Incident Patterns as Interview Scenarios

Cascading failures, thundering herds, and split-brain are the three incident patterns that appear most often in FAANG system design interviews because they are the three patterns that most commonly cause large-scale outages in practice.

For cascading failure interviews: when asked "how does your system handle a slow downstream dependency?", the answer must include timeout budgets (not equal timeouts at every tier), circuit breakers (with specific state transitions: closed, open, half-open), and bulkhead isolation (separate goroutine pools per downstream so one slow dependency does not exhaust all workers). Candidates who mention only "retry with exponential backoff" are demonstrating incomplete understanding: retries without circuit breakers amplify a cascading failure.

For thundering herd: `singleflight` is the Go-idiomatic answer, but understand its limitation: it deduplicates concurrent requests for the same key within a single process. Across multiple instances, the thundering herd problem still exists. Probabilistic early expiration (PER) is the cross-instance solution. Know both.

For split-brain: the fencing token pattern is the correct answer for preventing stale lock holders from writing. Be able to explain the GC pause scenario: a process pauses for longer than its lock TTL, the lock expires and another process acquires it, then the paused process resumes and thinks it still holds the lock. Fencing tokens prevent the stale writer from succeeding.

### Senior @ FAANG: Incident Pattern Prevention as Platform Engineering

At L6 scope, the goal is not to handle these incidents well after they happen: it is to make them structurally impossible or automatically detectable before they propagate.

**Cascading failure prevention through load shedding platforms.** Circuit breakers are a service-level mitigation. Load shedding is a platform-level mitigation. At FAANG, load shedding is implemented in the service mesh or load balancer layer: when a service's queue depth exceeds a configured threshold, the load balancer stops sending new traffic to that instance and redirects to healthy instances, or returns a 503 to the client with a `Retry-After` header. This happens without any application-level code change. Staff engineers design the load shedding policy: what is the queue depth threshold, what is the 503 retry delay, and is the shedding per-instance or per-cluster? These are operational parameters that require SLO analysis, not just engineering judgment.

**Thundering herd prevention through platform-level request coalescing.** Singleflight within a process is insufficient at FAANG scale. The platform-level solution is request coalescing at the cache or CDN layer: when multiple servers simultaneously miss on the same cache key, the caching layer serializes backend fetches and distributes the result to all waiters. Varnish's grace mode and Nginx's proxy_cache_lock implement this pattern at the reverse proxy level. Staff engineers evaluate whether the application-level singleflight, the caching layer, or the CDN layer is the right place to implement coalescing for each traffic pattern. The answer depends on whether the thundering herd is within a single datacenter (application-level is sufficient) or across multiple datacenters (CDN-level is required).

**Split-brain prevention through epoch-based fencing.** The fencing token implementation in this section is correct but requires that every resource that the lock protects validates the token. This is a distributed systems coordination problem: if any one resource does not validate the token, split-brain is still possible on that resource. At FAANG, fencing is implemented at the storage layer (not the application layer): the storage service validates fencing tokens atomically with every write, and the lock service is the single issuer of tokens. Application code never performs the validation directly. This architectural constraint eliminates the class of bugs where a developer forgets to validate the fencing token before writing.

**Post-mortem patterns and systemic fixes.** Each of the three incident patterns in this section has a class of post-mortem actions that are genuinely systemic versus superficially systemic. A cascading failure post-mortem that concludes "add a circuit breaker to this specific call" is a local fix. A cascading failure post-mortem that concludes "require circuit breakers on all inter-service calls as a deployment gate" is a systemic fix. Staff engineers advocate for systemic fixes and measure their effectiveness by tracking the recurrence rate of the same incident pattern class across the organization, not just within their team.

---
