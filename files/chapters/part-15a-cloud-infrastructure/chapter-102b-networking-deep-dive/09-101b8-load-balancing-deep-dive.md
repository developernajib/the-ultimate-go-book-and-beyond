## 102B.8 Load Balancing Deep Dive

### L4 vs L7 Load Balancing

**L4 Load Balancing** (Transport layer):
- Operates on IP and TCP without looking at application data
- Fast: no HTTP parsing overhead, packets are forwarded in kernel space
- Connection-level routing: once a TCP connection is assigned to a backend, all packets follow
- Cannot route based on URL path, headers, or HTTP method
- Examples: AWS NLB, Linux `ipvs`, HAProxy in TCP mode

**L7 Load Balancing** (Application layer):
- Parses HTTP/gRPC to make routing decisions
- Can route based on path (`/api` → service A, `/static` → service B), headers, or request content
- Can terminate TLS, inspect, and re-encrypt (SSL offloading)
- More expensive: requires full HTTP parsing per request
- Enables advanced features: retries, timeouts, circuit breaking, canary deployments
- Examples: AWS ALB, Nginx, Envoy, Traefik, Istio's sidecar proxy

### Load Balancing Algorithms

**Round Robin:** requests cycle through backends in sequence. Simple, effective when backends are identical. Fails when backend capacities differ or when requests have variable processing times.

**Least Connections:** route to the backend with the fewest active connections. Better than round robin when request durations vary significantly. Requires connection state tracking.

**Consistent Hashing:** hash the client IP or request key to select a backend. The same key always routes to the same backend (unless topology changes). Essential for stateful workloads (cache servers, session stores).

**EWMA (Exponentially Weighted Moving Average):** track the latency to each backend using an exponential moving average. Route to the backend with the lowest recent latency. Used by Finagle (Twitter/X's RPC framework) and increasingly in modern service meshes.

### Go: Custom Load Balancer with Consistent Hashing

```go
package loadbalancer

import (
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "slices"
    "sync"
)

// ConsistentHashBalancer implements consistent hashing with virtual nodes.
// Virtual nodes ensure even distribution even with few backends.
type ConsistentHashBalancer struct {
    mu       sync.RWMutex
    ring     []uint64         // sorted hash ring
    nodes    map[uint64]string // hash → backend URL
    replicas int              // virtual nodes per backend
    proxies  map[string]*httputil.ReverseProxy
}

func NewConsistentHashBalancer(replicas int) *ConsistentHashBalancer {
    return &ConsistentHashBalancer{
        replicas: replicas,
        nodes:    make(map[uint64]string),
        proxies:  make(map[string]*httputil.ReverseProxy),
    }
}

// AddBackend adds a backend to the hash ring.
func (b *ConsistentHashBalancer) AddBackend(backendURL string) error {
    target, err := url.Parse(backendURL)
    if err != nil {
        return fmt.Errorf("parse backend URL %s: %w", backendURL, err)
    }

    b.mu.Lock()
    defer b.mu.Unlock()

    for i := range b.replicas {
        key := fmt.Sprintf("%s#%d", backendURL, i)
        hash := hashKey(key)
        b.ring = append(b.ring, hash)
        b.nodes[hash] = backendURL
    }

    slices.Sort(b.ring)

    b.proxies[backendURL] = httputil.NewSingleHostReverseProxy(target)
    return nil
}

// RemoveBackend removes a backend from the hash ring (for graceful scale-down).
func (b *ConsistentHashBalancer) RemoveBackend(backendURL string) {
    b.mu.Lock()
    defer b.mu.Unlock()

    // Remove virtual nodes.
    for i := range b.replicas {
        key := fmt.Sprintf("%s#%d", backendURL, i)
        hash := hashKey(key)
        delete(b.nodes, hash)
        // Remove from ring.
        if idx, found := slices.BinarySearch(b.ring, hash); found {
            b.ring = append(b.ring[:idx], b.ring[idx+1:]...)
        }
    }

    delete(b.proxies, backendURL)
}

// ServeHTTP selects a backend using consistent hashing on the request path.
func (b *ConsistentHashBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Use request path + user ID header as the routing key.
    // This ensures a user's requests consistently go to the same backend.
    routingKey := r.URL.Path
    if userID := r.Header.Get("X-User-ID"); userID != "" {
        routingKey = userID
    }

    backend := b.selectBackend(routingKey)
    if backend == "" {
        http.Error(w, "no backends available", http.StatusServiceUnavailable)
        return
    }

    b.mu.RLock()
    proxy := b.proxies[backend]
    b.mu.RUnlock()

    proxy.ServeHTTP(w, r)
}

func (b *ConsistentHashBalancer) selectBackend(key string) string {
    b.mu.RLock()
    defer b.mu.RUnlock()

    if len(b.ring) == 0 {
        return ""
    }

    hash := hashKey(key)
    // Binary search for the first node with hash >= key hash.
    idx, _ := slices.BinarySearch(b.ring, hash)
    // Wrap around the ring.
    if idx == len(b.ring) {
        idx = 0
    }
    return b.nodes[b.ring[idx]]
}

func hashKey(key string) uint64 {
    h := sha256.Sum256([]byte(key))
    return binary.BigEndian.Uint64(h[:8])
}
```

### Health Checks and Connection Draining

Zero-downtime deployments require two coordinated steps: first, tell the load balancer to stop sending new traffic before the process exits. Second, wait for in-flight requests to complete. The `HealthChecker` solves the first step by immediately returning HTTP 503 on `SIGTERM`, which causes the LB to mark the instance unhealthy within one health-check interval. The deliberate 15-second sleep accounts for the LB's unhealthy threshold (typically 2 consecutive failures at 5-second intervals), ensuring no new connections arrive before `srv.Shutdown` begins draining existing ones.

```go
package loadbalancer

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// HealthChecker implements health checks for load balancers.
// Also compatible with AWS ALB, Kubernetes readiness probes, and Envoy.
type HealthChecker struct {
    mu      sync.RWMutex
    healthy bool
    reason  string
}

func (h *HealthChecker) SetHealthy(healthy bool, reason string) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.healthy = healthy
    h.reason = reason
}

func (h *HealthChecker) Handler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        h.mu.RLock()
        defer h.mu.RUnlock()
        if h.healthy {
            w.WriteHeader(http.StatusOK)
            fmt.Fprint(w, "OK")
        } else {
            w.WriteHeader(http.StatusServiceUnavailable)
            fmt.Fprintf(w, "UNHEALTHY: %s", h.reason)
        }
    }
}

// GracefulShutdown implements connection draining for zero-downtime deployments.
// The load balancer health check returns 503 immediately, causing the LB to
// stop sending new traffic. Existing connections are drained over drainTimeout.
func GracefulShutdown(srv *http.Server, health *HealthChecker, drainTimeout time.Duration) {
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    log.Println("Received shutdown signal, starting graceful shutdown")

    // Immediately mark unhealthy to stop new traffic from load balancer.
    health.SetHealthy(false, "shutting down")

    // Wait for load balancer to detect unhealthy state and stop routing.
    // This depends on LB health check interval + unhealthy threshold.
    // AWS ALB: interval=5s, threshold=2 → wait at least 10s.
    time.Sleep(15 * time.Second)

    // Shutdown with timeout for in-flight requests.
    ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }
    log.Println("Shutdown complete")
}
```

---

### Junior → FAANG: Load Balancing Concepts and Their Go Service Implications

The L4 versus L7 load balancing distinction has concrete implications for Go services. L4 load balancers (NLB on AWS, TCP load balancers on GCP) forward TCP connections without inspecting content: the connection is established between the client and one backend, and all traffic in that connection goes to the same backend. L7 load balancers (ALB on AWS, HTTPS load balancers on GCP) terminate the connection, inspect the HTTP headers and routing rules, and forward individual requests (potentially to different backends).

For Go services with long-lived HTTP/2 connections, L4 load balancing can cause uneven traffic distribution: all requests on a connection go to the same backend, and connections may be long-lived. L7 load balancing distributes individual requests across backends, providing better load distribution for long-lived connections.

The health check configuration matters: the load balancer routes traffic only to backends that pass health checks. Go services must implement a health endpoint that the load balancer can reach and that accurately reflects the service's ability to handle traffic. A health endpoint that always returns 200 (without checking actual readiness) defeats the purpose of health-based routing.

### Senior @ FAANG: Load Balancing Architecture and Consistent Hashing

At staff level, load balancing algorithm selection is an architectural decision. Round-robin distributes requests evenly but may route requests for the same user to different backends, defeating any connection-affinity or local cache benefits. Least-connections routes to the backend with fewest active connections, producing better distribution for variable-duration requests. Consistent hashing routes requests for the same key (user ID, session ID) to the same backend, enabling backend-side caching and session affinity.

Consistent hashing is the algorithm that enables stateful request routing at scale. When used with a ring-based algorithm (ketama or a similar variant), adding or removing a backend node redistributes only a fraction of the keys, minimizing cache invalidation and session disruption. This is the algorithm used by distributed caches (Redis Cluster, Memcached with client-side consistent hashing) and is increasingly used in application load balancers for session-affinity use cases.

The global load balancing layer (AWS Global Accelerator, GCP Global Load Balancer) introduces additional complexity: traffic is routed from the user to the nearest point of presence, then forwarded to the appropriate region. Designing failover behavior for regional failures, understanding the anycast routing properties, and monitoring the regional traffic distribution are platform-level concerns that require networking expertise at the staff level.
