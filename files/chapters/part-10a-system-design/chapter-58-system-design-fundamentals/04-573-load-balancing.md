## 58.3 Load Balancing

### Load Balancing Algorithms

Load balancing algorithms determine how incoming requests are distributed across backend servers, with each algorithm making different trade-offs between simplicity, latency, and server utilization. Round-robin is stateless and predictable but ignores server load. Least-connections routes to the least-busy server, improving utilization when requests have variable processing times. Consistent hashing enables session affinity and is essential for stateful protocols or cache locality. The implementations below show how each algorithm can be expressed concisely in Go using atomic operations for thread safety in the stateful variants.

```go
// Load balancing algorithm implementations

// 1. Round Robin - Simple rotation
type RoundRobin struct {
    servers []Server
    current uint64
}

func (r *RoundRobin) Next() Server {
    n := atomic.AddUint64(&r.current, 1)
    return r.servers[n%uint64(len(r.servers))]
}

// 2. Weighted Round Robin - Accounts for server capacity
type WeightedRoundRobin struct {
    servers []WeightedServer
    weights []int
    current int
    gcd     int
    max     int
}

type WeightedServer struct {
    Server Server
    Weight int
}

func (w *WeightedRoundRobin) Next() Server {
    for {
        w.current = (w.current + 1) % len(w.servers)
        if w.current == 0 {
            w.max = w.max - w.gcd
            if w.max <= 0 {
                w.max = w.maxWeight()
            }
        }
        if w.servers[w.current].Weight >= w.max {
            return w.servers[w.current].Server
        }
    }
}

// 3. Least Connections - Send to server with fewest active connections
type LeastConnections struct {
    servers []*ServerWithConnections
    mu      sync.Mutex
}

type ServerWithConnections struct {
    Server      Server
    Connections int64
}

func (l *LeastConnections) Next() Server {
    l.mu.Lock()
    defer l.mu.Unlock()

    var min *ServerWithConnections
    for _, s := range l.servers {
        if min == nil || s.Connections < min.Connections {
            min = s
        }
    }

    min.Connections++ // already under l.mu, no atomic needed
    return min.Server
}

// 4. Consistent Hashing - Same key always goes to same server
type ConsistentHash struct {
    ring     *hashring.Ring
    replicas int
}

func (c *ConsistentHash) Get(key string) Server {
    return c.ring.Get(key)
}

// 5. Random - Simple but effective for uniform distribution
type Random struct {
    servers []Server
    rng     *rand.Rand
}

func (r *Random) Next() Server {
    return r.servers[r.rng.Intn(len(r.servers))]
}
```

### Layer 4 vs Layer 7 Load Balancing

The OSI layer at which a load balancer operates determines what routing information it can see and act on. A Layer 4 balancer forwards TCP/UDP streams based solely on IP address and port, it never parses the payload, so it has minimal CPU overhead and can handle millions of connections per second, but it cannot distinguish `/api` traffic from `/static` traffic on the same port. A Layer 7 balancer terminates the TCP connection itself, parses HTTP headers, cookies, and paths, and makes content-aware routing decisions. This allows A/B routing, canary deployments by path, and SSL offloading, at the cost of higher per-connection latency and resource use.

```
Layer 4 (Transport Layer):
┌─────────────────────────────────────────────────────────┐
│ - Operates on TCP/UDP level                             │
│ - Routes based on IP and port                           │
│ - Cannot inspect HTTP content                           │
│ - Lower latency, higher throughput                      │
│ - Example: AWS NLB, HAProxy (mode tcp)                  │
│                                                         │
│   Client → LB → Server (single TCP connection)          │
└─────────────────────────────────────────────────────────┘

Layer 7 (Application Layer):
┌─────────────────────────────────────────────────────────┐
│ - Operates on HTTP/HTTPS level                          │
│ - Can inspect headers, cookies, URLs                    │
│ - Content-based routing                                 │
│ - SSL termination                                       │
│ - Higher latency, more features                         │
│ - Example: AWS ALB, Nginx, HAProxy (mode http)          │
│                                                         │
│   Routing examples:                                     │
│   /api/* → API servers                                  │
│   /static/* → CDN                                       │
│   Host: api.example.com → API cluster                   │
│   Cookie: region=eu → EU servers                        │
└─────────────────────────────────────────────────────────┘
```

### Health Checks

Routing requests to an unhealthy server produces errors that are indistinguishable from application bugs unless the load balancer actively probes each backend. The `HealthChecker` below polls every server's `/health` endpoint on a configurable interval, tracking the `Healthy` flag under a `sync.RWMutex` so reads by the balancer never block the concurrent probes. Each check runs in its own goroutine via `checkAll`, so a slow or unresponsive server does not delay health evaluation for the others, essential when a network partition causes some backends to hang rather than refuse connections.

```go
// Health check implementation
package loadbalancer

import (
    "context"
    "log"
    "net/http"
    "sync"
    "time"
)

type HealthChecker struct {
    servers  []*Server
    interval time.Duration
    timeout  time.Duration
    client   *http.Client
    mu       sync.RWMutex
}

type Server struct {
    URL     string
    Healthy bool
    Weight  int
}

func NewHealthChecker(servers []*Server, interval, timeout time.Duration) *HealthChecker {
    return &HealthChecker{
        servers:  servers,
        interval: interval,
        timeout:  timeout,
        client: &http.Client{
            Timeout: timeout,
        },
    }
}

func (h *HealthChecker) Start(ctx context.Context) {
    ticker := time.NewTicker(h.interval)
    defer ticker.Stop()

    // Initial check
    h.checkAll()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            h.checkAll()
        }
    }
}

func (h *HealthChecker) checkAll() {
    var wg sync.WaitGroup
    for _, server := range h.servers {
        wg.Add(1)
        go func(s *Server) {
            defer wg.Done()
            h.check(s)
        }(server)
    }
    wg.Wait()
}

func (h *HealthChecker) check(server *Server) {
    resp, err := h.client.Get(server.URL + "/health")

    h.mu.Lock()
    defer h.mu.Unlock()

    wasHealthy := server.Healthy
    server.Healthy = err == nil && resp != nil && resp.StatusCode == http.StatusOK

    if wasHealthy && !server.Healthy {
        log.Printf("Server %s is now unhealthy", server.URL)
    } else if !wasHealthy && server.Healthy {
        log.Printf("Server %s is now healthy", server.URL)
    }

    if resp != nil {
        resp.Body.Close()
    }
}

func (h *HealthChecker) GetHealthyServers() []*Server {
    h.mu.RLock()
    defer h.mu.RUnlock()

    var healthy []*Server
    for _, s := range h.servers {
        if s.Healthy {
            healthy = append(healthy, s)
        }
    }
    return healthy
}
```

### Junior → FAANG: Load Balancing Fundamentals for Interviews

The most important thing to understand about load balancing algorithms before a FAANG screen is that each algorithm solves a specific problem, and interviewers want to hear you match algorithm to problem rather than defaulting to "round-robin."

Round-robin works when all requests are roughly equal in cost and all backends have equal capacity. The moment request cost varies (some API calls take 10ms, others take 500ms), least-connections produces better utilization. The moment you need cache affinity (every request for user 42 should hit the same cache-warmed backend), consistent hashing is the right choice.

Consistent hashing is one of the most frequently tested concepts at FAANG. The core insight is that when a node is added or removed, only 1/N of the keys need to be remapped, versus all keys for modulo hashing. Be able to explain this with a concrete example: in a 4-node ring, adding a 5th node moves approximately 20% of keys. In modulo hashing, adding a 5th node could move close to 80% of keys. This difference matters enormously for cache efficiency during deployments.

Health checking is often treated as an implementation detail, but it is actually a correctness requirement. If your load balancer routes to an unhealthy backend, the user gets an error that looks like a bug. Interview tip: when you mention health checking, follow it immediately with "and I would configure the check interval, timeout, and unhealthy threshold carefully, because an overly aggressive health check can mark a slow-but-functional server as down during a traffic spike."

### Senior @ FAANG: Load Balancing at Platform Scale

At staff level, load balancing is a platform concern. Individual teams should not be configuring their own load balancer algorithms or health check parameters. They should be choosing from a set of pre-validated options that the platform team has tested under realistic traffic patterns.

**Layer 4 versus Layer 7 as an organizational decision.** The choice between L4 and L7 load balancing is not just a latency trade-off. It is a security and observability decision. L7 terminates TLS, which means the load balancer can inspect and log request headers, enforce authentication policies, and apply WAF rules before traffic reaches application servers. For internal service-to-service traffic (east-west), many FAANG teams use mutual TLS (mTLS) enforced by a service mesh (Envoy, Linkerd), which provides authentication, authorization, and encrypted transport without requiring application changes. At L7, you design the layer at which TLS is terminated and the policy for what happens to traffic that cannot present a valid certificate.

**Consistent hashing and the rebalancing problem.** Consistent hashing is elegant in theory but has operational subtleties at scale. Virtual nodes (a single physical server occupies multiple positions on the ring) improve key distribution when physical servers have unequal capacity. However, adding virtual nodes to an existing ring shifts keys, which causes cache misses. At Netflix, EVCache uses a controlled virtual node count per cluster and tests rebalancing behavior in staging before every node change. At the staff level, you define the protocol for adding or removing cache nodes (announce the change, warm the new node, validate hit rate before cutting over) rather than leaving it to individual on-call engineers.

**Health check design as a reliability contract.** A poorly designed health check endpoint is a frequent source of incidents at scale. A `/health` endpoint that queries the database on every invocation will cause a thundering-herd problem: when the load balancer marks a backend unhealthy and removes it, the remaining backends receive more traffic, which increases their database load, which makes their health checks slower, which can trigger more removals. At the staff level, you define what a health check endpoint is allowed to do: it should check local process health (not downstream dependencies), and it should be served from a dedicated goroutine with its own timeout that does not share a connection pool with the request path. The shallow versus deep health check distinction (shallow checks only local state, deep checks downstream dependencies) is a design decision with a documented trade-off, not an implementation accident.

**Retry budgets and load balancer interaction.** Client-side retries interact badly with load balancing during cascading failures. If a service is degraded and returning errors, clients retry, which doubles or triples the effective load on the service, which makes it more degraded, which causes more retries. A staff engineer addresses this by: setting a retry budget at the load balancer or service mesh level (no more than 10% of requests can be retries at any moment), using exponential backoff with jitter in all clients, and configuring circuit breakers that open before the retry storm reaches the backend. These are organizational standards, not per-service configurations, because one service that violates them can destabilize services it depends on.

---
