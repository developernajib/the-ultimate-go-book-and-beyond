## 64B.1 Netflix Architecture

Netflix serves over 300 million subscribers across 190 countries, streaming video at a scale that accounts for roughly 15% of global internet bandwidth during peak hours. Their architecture evolved from a single-datacenter monolith to a fully microservices-based system running on AWS, with a custom CDN (Open Connect) handling content delivery.

### Content Delivery Architecture

Netflix's architecture (detailed in Netflix Tech Blog publications including *"Fault Tolerance in a High Volume, Distributed System"* and Adrian Cockcroft's architectural retrospectives) separates the control plane, where clients authenticate, receive personalized recommendations, and resolve the best CDN server to use, from the data plane, where actual video bytes flow directly from Open Connect edge servers to the viewer's device without touching the AWS origin. All client requests first pass through the Zuul API gateway, which handles authentication, rate limiting, and request routing before forwarding to the appropriate microservice cluster. The data tier relies on Cassandra for globally distributed user and content metadata, EVCache (a multi-region Memcached layer) for low-latency read acceleration, Kafka for event streaming between services, and S3 for durable object storage of encoded video assets.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Netflix Architecture                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────┐    ┌─────────┐    ┌─────────────┐    ┌─────────────┐   │
│   │ Client  │───►│  Zuul   │───►│  API Layer  │───►│Microservices│   │
│   │  Apps   │    │ Gateway │    │ (Falcor)    │    │             │   │
│   └─────────┘    └─────────┘    └─────────────┘    └─────────────┘   │
│                                                           │          │
│                                      ┌────────────────────┘          │
│                                      ▼                               │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │                    Microservices Layer                      │    │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │    │
│   │  │Playback  │  │ Personal │  │  Search  │  │  Billing │     │    │
│   │  │ Service  │  │   ization│  │  Service │  │  Service │     │    │
│   │  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │                     Data Layer                              │    │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │    │
│   │  │ Cassandra│  │EVCache   │  │ Kafka    │  │ S3       │     │    │
│   │  │          │  │(Memcached│  │          │  │          │     │    │
│   │  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │                     Open Connect CDN                        │    │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │    │
│   │  │ Edge     │  │ Edge     │  │ Edge     │  │ Edge     │     │    │
│   │  │ Server   │  │ Server   │  │ Server   │  │ Server   │     │    │
│   │  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │    │
│   └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Patterns: Circuit Breaker with Hystrix

Netflix's Hystrix pattern wraps every remote call in an `HystrixCommand` that enforces three protective constraints: a semaphore-based bulkhead that caps the number of concurrent in-flight calls, a timeout that aborts calls that run too long, and a circuit breaker that opens when the rolling error rate exceeds a configurable threshold. Once the circuit is open, all subsequent calls immediately return an error (or invoke a fallback) without touching the downstream service, giving it time to recover during the `SleepWindow`. After the sleep window elapses the circuit transitions to half-open, allowing one probe request through. A success closes the circuit while any failure reopens it immediately.

```go
// netflix/hystrix.go
package netflix

import (
    "context"
    "errors"
    "sync"
    "time"
)

var (
    ErrCircuitOpen      = errors.New("circuit open")
    ErrMaxConcurrency   = errors.New("max concurrency reached")
    ErrTimeout          = errors.New("command timeout")
)

// HystrixCommand represents a circuit-protected command
type HystrixCommand struct {
    Name            string
    Timeout         time.Duration
    MaxConcurrent   int
    ErrorThreshold  float64
    SleepWindow     time.Duration

    mu              sync.RWMutex
    state           CircuitState
    failures        int64
    successes       int64
    lastFailure     time.Time
    openedAt        time.Time

    semaphore       chan struct{}
    fallback        func(error) (any, error)
}

type CircuitState int

const (
    Closed CircuitState = iota
    Open
    HalfOpen
)

// Execute runs a command with circuit breaker protection
func (c *HystrixCommand) Execute(ctx context.Context, run func() (any, error)) (any, error) {
    // Check circuit state
    if !c.allowRequest() {
        if c.fallback != nil {
            return c.fallback(ErrCircuitOpen)
        }
        return nil, ErrCircuitOpen
    }

    // Acquire semaphore for concurrency limiting
    select {
    case c.semaphore <- struct{}{}:
        defer func() { <-c.semaphore }()
    default:
        // Bulkhead full
        if c.fallback != nil {
            return c.fallback(ErrMaxConcurrency)
        }
        return nil, ErrMaxConcurrency
    }

    // Execute with timeout
    resultCh := make(chan commandResult, 1)
    go func() {
        result, err := run()
        resultCh <- commandResult{result: result, err: err}
    }()

    select {
    case result := <-resultCh:
        if result.err != nil {
            c.recordFailure()
            if c.fallback != nil {
                return c.fallback(result.err)
            }
            return nil, result.err
        }
        c.recordSuccess()
        return result.result, nil

    case <-time.After(c.Timeout):
        c.recordFailure()
        if c.fallback != nil {
            return c.fallback(ErrTimeout)
        }
        return nil, ErrTimeout

    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

type commandResult struct {
    result any
    err    error
}

func (c *HystrixCommand) allowRequest() bool {
    c.mu.RLock()
    state := c.state
    c.mu.RUnlock()

    switch state {
    case Closed:
        return true
    case Open:
        // Check if sleep window has passed
        c.mu.Lock()
        defer c.mu.Unlock()
        if time.Since(c.openedAt) >= c.SleepWindow {
            c.state = HalfOpen
            return true
        }
        return false
    case HalfOpen:
        return true
    }
    return false
}

func (c *HystrixCommand) recordSuccess() {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.successes++

    if c.state == HalfOpen {
        c.state = Closed
        c.failures = 0
    }
}

func (c *HystrixCommand) recordFailure() {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.failures++
    c.lastFailure = time.Now()

    // Check error threshold
    total := c.failures + c.successes
    if total >= 20 { // Minimum sample size
        errorRate := float64(c.failures) / float64(total)
        if errorRate >= c.ErrorThreshold {
            c.state = Open
            c.openedAt = time.Now()
        }
    }

    if c.state == HalfOpen {
        c.state = Open
        c.openedAt = time.Now()
    }
}
```

### EVCache: Distributed Caching

EVCache is Netflix's multi-region Memcached/Redis layer that replicates every write to all availability zones simultaneously so that a zone failure never causes a cache miss wave that would hammer the origin databases. Reads are satisfied from the local zone first to minimize latency. If the local zone misses, the client falls through to remote zones and asynchronously backfills the found value into the local zone for future requests. This combination of synchronous multi-zone writes and lazy local-zone backfill gives EVCache both high availability and low read latency without requiring a strongly-consistent distributed protocol.

```go
// netflix/evcache.go
package netflix

import (
    "context"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrCacheMiss = errors.New("cache miss")

// EVCache provides Netflix-style distributed caching
type EVCache struct {
    zones       map[string]*redis.ClusterClient // availability zone -> client
    localZone   string
    prefix      string
    defaultTTL  time.Duration
}

// NewEVCache creates a new EVCache client
func NewEVCache(localZone string, zoneConfigs map[string][]string) *EVCache {
    zones := make(map[string]*redis.ClusterClient)

    for zone, addrs := range zoneConfigs {
        zones[zone] = redis.NewClusterClient(&redis.ClusterOptions{
            Addrs: addrs,
        })
    }

    return &EVCache{
        zones:      zones,
        localZone:  localZone,
        defaultTTL: time.Hour,
    }
}

// Get retrieves from local zone first, then remote zones
func (c *EVCache) Get(ctx context.Context, key string) ([]byte, error) {
    fullKey := c.prefix + ":" + key

    // Try local zone first (lowest latency)
    if client, ok := c.zones[c.localZone]; ok {
        val, err := client.Get(ctx, fullKey).Bytes()
        if err == nil {
            return val, nil
        }
    }

    // Try other zones
    for zone, client := range c.zones {
        if zone == c.localZone {
            continue
        }

        val, err := client.Get(ctx, fullKey).Bytes()
        if err == nil {
            // Backfill to local zone
            go func() {
                if localClient, ok := c.zones[c.localZone]; ok {
                    localClient.Set(context.Background(), fullKey, val, c.defaultTTL)
                }
            }()
            return val, nil
        }
    }

    return nil, ErrCacheMiss
}

// Set writes to all zones for redundancy
func (c *EVCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    fullKey := c.prefix + ":" + key

    // Replicate to remote zones asynchronously. Two details matter:
    // the local zone is skipped here (it gets a synchronous write
    // below, doubling up would be wasted work), and the goroutines
    // detach from the caller's context so an early caller cancel
    // cannot abort remote replication mid-flight.
    bgCtx := context.WithoutCancel(ctx)
    for zone, client := range c.zones {
        if zone == c.localZone {
            continue
        }
        go func(cl *redis.ClusterClient) {
            cl.Set(bgCtx, fullKey, value, ttl)
        }(client)
    }

    // Wait for local zone write
    if client, ok := c.zones[c.localZone]; ok {
        return client.Set(ctx, fullKey, value, ttl).Err()
    }

    return nil
}

// Delete removes from all zones
func (c *EVCache) Delete(ctx context.Context, key string) error {
    fullKey := c.prefix + ":" + key

    bgCtx := context.WithoutCancel(ctx)
    for _, client := range c.zones {
        go func(cl *redis.ClusterClient) {
            cl.Del(bgCtx, fullKey)
        }(client)
    }

    return nil
}
```

---

### Junior -> FAANG: What Hystrix and EVCache Teach About Resilience Patterns

The circuit breaker and the distributed cache are the two most important resilience patterns in a microservices architecture. Understand each one as a protection against a specific failure mode.

The circuit breaker protects a caller from a slow or failing downstream service. Without it, a service that takes 30 seconds to respond will hold the caller's goroutine for 30 seconds, exhausting the goroutine pool and cascading the failure to the caller's callers. The circuit breaker short-circuits slow calls after the error rate crosses a threshold, returning an immediate error (or a fallback response) so the caller's goroutines are freed immediately. The state machine (Closed, Open, HalfOpen) is the key concept: it prevents the system from hammering a recovering service with full traffic, instead sending a single probe request to test recovery before reopening the circuit.

EVCache teaches the multi-zone write pattern. When you write to a cache, write to all availability zones synchronously for the local zone and asynchronously for remote zones. This ensures that a zone failure does not cause a cold-cache wave (all requests missing the cache and hitting the database simultaneously, which can overload the database). The backfill pattern (read from a remote zone on a local miss, then write back to the local zone asynchronously) keeps the local cache warm without adding synchronous latency to reads.

Interview habit: when asked "how do you make a service resilient to dependency failures?", structure your answer in three layers: circuit breaker (fast fail), retry with backoff (handle transient errors), and fallback (serve degraded response). This three-layer structure maps to Hystrix's design and demonstrates that you understand the hierarchy of failure responses.

### Senior @ FAANG: Production Circuit Breaker Configuration and Operational Concerns

The circuit breaker implementation here uses rolling window error rate with a minimum sample size of 20 requests. The minimum sample size is critical: without it, a circuit breaker opens on the first error, which causes false positives during cold starts and low-traffic periods. The production configuration at Netflix (and in the original Hystrix library) uses a 10-second rolling window with a minimum of 20 requests and a 50% error threshold as starting defaults, then tunes per-command.

The semaphore-based bulkhead (the `semaphore` channel in the implementation) is the mechanism that prevents a slow downstream from consuming all available goroutines. The semaphore size sets the maximum concurrency for a specific command. If the upstream traffic rate exceeds `semaphore_size / average_latency` requests per second, new requests will immediately fail the bulkhead check rather than queuing indefinitely. This is intentional: queuing indefinitely under overload amplifies the problem. Failing fast allows the load balancer to route to a healthy instance.

EVCache's async remote-zone writes have a consistency implication that the implementation glosses over. If the local-zone write succeeds and a remote-zone write fails (dropped in a goroutine), the remote zone serves stale data until the next write to that key. For most Netflix use cases (recommendations, thumbnails, user preferences), this eventual consistency window (typically milliseconds to seconds) is acceptable. For data where cross-zone consistency is required (session tokens, payment state), EVCache is the wrong tool: use a strongly consistent store with multi-region replication (DynamoDB Global Tables, Spanner) instead.

The Hystrix metrics aggregation (rolling error rate over a 10-second window) is a data structure problem that the simple implementation here avoids. A production circuit breaker uses a ring buffer of fixed-size time buckets, discarding the oldest bucket and adding a new one every second, to compute the rolling error rate without scanning the full window. This is the "leaky bucket" variant of the rolling window and is O(1) per request rather than O(window_size).