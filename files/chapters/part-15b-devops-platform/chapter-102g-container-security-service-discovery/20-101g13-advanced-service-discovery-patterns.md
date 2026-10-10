## 102G.18 Advanced Service Discovery Patterns

### Health Check Endpoint Design

Kubernetes supports three distinct probe types, and conflating them is a common source of outages:

| Probe | Meaning | Failure action |
|-------|---------|---------------|
| **Liveness** | Is the process alive? | Restart the container |
| **Readiness** | Is the process ready for traffic? | Remove from Service endpoints |
| **Startup** | Has initial startup completed? | Delay liveness/readiness checks |

A well-designed Go health check server separates these concerns:

```go
// internal/health/server.go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync/atomic"
    "time"
)

// Checker is a named health check function.
type Checker struct {
    Name  string
    Check func(ctx context.Context) error
}

// Server implements /healthz (liveness), /readyz (readiness), /startupz.
type Server struct {
    checkers   []Checker         // run for readiness
    ready      atomic.Bool       // flipped true when startup completes
    startTime  time.Time
}

// NewServer creates a health check server with the given readiness checks.
func NewServer(checkers ...Checker) *Server {
    return &Server{
        checkers:  checkers,
        startTime: time.Now(),
    }
}

// SetReady marks the application as having completed initialization.
// Call this after database migrations, cache warm-up, etc.
func (s *Server) SetReady() {
    s.ready.Store(true)
}

// Handler returns an http.Handler for all health endpoints.
func (s *Server) Handler() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", s.liveness)   // liveness: is process alive?
    mux.HandleFunc("/readyz", s.readiness)   // readiness: can handle traffic?
    mux.HandleFunc("/startupz", s.startup)   // startup: finished init?
    return mux
}

// liveness: only fails if the process is truly dead or in a fatal loop.
// Never check external dependencies here - that causes flapping restarts.
func (s *Server) liveness(w http.ResponseWriter, _ *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "alive"}) //nolint:errcheck
}

// readiness: checks all registered dependencies. Failing removes pod from LB.
func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
    if !s.ready.Load() {
        http.Error(w, `{"status":"not_ready","reason":"startup_incomplete"}`,
            http.StatusServiceUnavailable)
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    results := make(map[string]string, len(s.checkers))
    allHealthy := true

    for _, c := range s.checkers {
        if err := c.Check(ctx); err != nil {
            results[c.Name] = err.Error()
            allHealthy = false
        } else {
            results[c.Name] = "ok"
        }
    }

    status := http.StatusOK
    statusMsg := "ready"
    if !allHealthy {
        status = http.StatusServiceUnavailable
        statusMsg = "not_ready"
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
        "status": statusMsg,
        "checks": results,
    })
}

// startup: used as a startup probe. Once ready, stays healthy forever.
func (s *Server) startup(w http.ResponseWriter, _ *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    if s.ready.Load() {
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "started"}) //nolint:errcheck
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
            "status": "starting",
            "uptime": time.Since(s.startTime).String(),
        })
    }
}
```

Usage in a Go service:

```go
// In main.go
db := connectDatabase()
cache := connectRedis()

healthSrv := health.NewServer(
    health.Checker{
        Name: "database",
        Check: func(ctx context.Context) error {
            return db.PingContext(ctx)
        },
    },
    health.Checker{
        Name: "redis",
        Check: func(ctx context.Context) error {
            return cache.Ping(ctx).Err()
        },
    },
)

// Run health server on separate port (don't expose to public)
go http.ListenAndServe(":9090", healthSrv.Handler())

// After migrations and warm-up:
runMigrations(db)
warmCache(cache)
healthSrv.SetReady()   // now receives traffic
```

Kubernetes probe configuration aligned with the above:

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 9090
  initialDelaySeconds: 5
  periodSeconds: 15
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /readyz
    port: 9090
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 3

startupProbe:
  httpGet:
    path: /startupz
    port: 9090
  failureThreshold: 30    # 30 * 10s = 5 minutes max startup time
  periodSeconds: 10
```

### DNS-Based Service Discovery: CoreDNS Internals

Kubernetes Services are assigned DNS names following a predictable pattern:

```
<service>.<namespace>.svc.<cluster-domain>
```

For a service named `payment-api` in namespace `billing`, the FQDN is:
`payment-api.billing.svc.cluster.local`

CoreDNS (the cluster DNS server) is configured via a `Corefile` ConfigMap and handles these lookups by querying the Kubernetes API:

```
# CoreDNS Corefile (default)
.:53 {
    errors
    health {
        lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf
    cache 30
    loop
    reload
    loadbalance
}
```

Key behaviors to understand:
- **TTL 30**: DNS responses are cached for 30 seconds. Updates to service endpoints propagate within 30 seconds - not instantly.
- **`loadbalance`**: CoreDNS shuffles A records returned for the same hostname, providing basic DNS round-robin load balancing.
- **Headless services**: When `clusterIP: None`, CoreDNS returns individual pod IPs instead of the service VIP - required for StatefulSets where each pod needs to be addressable independently.

```yaml
# Headless service for StatefulSet (e.g., database cluster)
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
spec:
  clusterIP: None      # Headless - no virtual IP
  selector:
    app: postgres
  ports:
    - port: 5432
```

With this headless service, `postgres-0.postgres-headless.default.svc.cluster.local` resolves to the IP of pod `postgres-0`. The Go client can connect to a specific replica for reads:

```go
// Connect to a specific StatefulSet replica by ordinal
func replicaDSN(ordinal int) string {
    return fmt.Sprintf(
        "postgres://user:pass@postgres-%d.postgres-headless.default.svc.cluster.local:5432/mydb",
        ordinal,
    )
}
```

### Consul Service Discovery - Multi-Cloud and Multi-Cluster

While Kubernetes DNS works within a single cluster, Consul supports service discovery across multiple clusters, cloud providers, and legacy VMs. A Consul-aware Go client for multi-region discovery:

```go
// internal/discovery/consul_client.go
package discovery

import (
    "context"
    "fmt"
    "log/slog"
    "math/rand/v2"
    "sync"
    "time"

    "github.com/hashicorp/consul/api"
)

// ServiceInstance represents a single healthy instance of a service.
type ServiceInstance struct {
    ID      string
    Address string
    Port    int
    Tags    []string
    Meta    map[string]string
}

// ConsulDiscovery provides real-time service discovery backed by Consul.
type ConsulDiscovery struct {
    client  *api.Client
    cache   map[string][]ServiceInstance
    mu      sync.RWMutex
    logger  *slog.Logger
}

// NewConsulDiscovery creates a discovery client connected to Consul.
func NewConsulDiscovery(addr string, logger *slog.Logger) (*ConsulDiscovery, error) {
    cfg := api.DefaultConfig()
    cfg.Address = addr

    client, err := api.NewClient(cfg)
    if err != nil {
        return nil, fmt.Errorf("consul client: %w", err)
    }

    return &ConsulDiscovery{
        client: client,
        cache:  make(map[string][]ServiceInstance),
        logger: logger,
    }, nil
}

// Watch starts a long-polling watch for the given service, updating the
// in-memory cache whenever Consul reports a change.
func (d *ConsulDiscovery) Watch(ctx context.Context, service string) error {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        opts := &api.QueryOptions{
            WaitIndex: lastIndex,
            WaitTime:  30 * time.Second,
        }

        entries, meta, err := d.client.Health().Service(service, "", true, opts.WithContext(ctx))
        if err != nil {
            d.logger.Warn("consul watch error",
                slog.String("service", service),
                slog.String("error", err.Error()),
            )
            time.Sleep(2 * time.Second)
            continue
        }

        if meta.LastIndex == lastIndex {
            continue // No change
        }
        lastIndex = meta.LastIndex

        instances := make([]ServiceInstance, 0, len(entries))
        for _, entry := range entries {
            instances = append(instances, ServiceInstance{
                ID:      entry.Service.ID,
                Address: entry.Service.Address,
                Port:    entry.Service.Port,
                Tags:    entry.Service.Tags,
                Meta:    entry.Service.Meta,
            })
        }

        d.mu.Lock()
        d.cache[service] = instances
        d.mu.Unlock()

        d.logger.Info("service instances updated",
            slog.String("service", service),
            slog.Int("count", len(instances)),
        )
    }
}

// Pick returns a random healthy instance of the named service.
// Returns error if no instances are available.
func (d *ConsulDiscovery) Pick(service string) (*ServiceInstance, error) {
    d.mu.RLock()
    instances := d.cache[service]
    d.mu.RUnlock()

    if len(instances) == 0 {
        return nil, fmt.Errorf("no healthy instances for service %q", service)
    }

    // Simple random selection - replace with round-robin or least-connections as needed
    idx := rand.IntN(len(instances))
    inst := instances[idx]
    return &inst, nil
}

// Addr returns "host:port" for a picked instance.
func (d *ConsulDiscovery) Addr(service string) (string, error) {
    inst, err := d.Pick(service)
    if err != nil {
        return "", err
    }
    return fmt.Sprintf("%s:%d", inst.Address, inst.Port), nil
}
```

### Service Mesh Traffic Policies with Istio VirtualService

Service mesh (Istio) adds traffic management above the DNS/IP layer. VirtualService defines routing rules applied by the Envoy sidecar - no application code changes needed:

```yaml
# virtualservice-payment-api.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-api
spec:
  hosts:
    - payment-api
  http:
    - timeout: 3s              # Overall request timeout
      retries:
        attempts: 3
        perTryTimeout: 1s
        retryOn: "5xx,reset,connect-failure,retriable-4xx"
      route:
        - destination:
            host: payment-api
            subset: stable
          weight: 90
        - destination:
            host: payment-api
            subset: canary
          weight: 10
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-api
spec:
  host: payment-api
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
    outlierDetection:
      consecutive5xxErrors: 5    # circuit-break after 5 consecutive errors
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50     # never eject more than 50% of instances
  subsets:
    - name: stable
      labels:
        version: stable
    - name: canary
      labels:
        version: canary
```

The `outlierDetection` block is Istio's circuit breaker: if any individual host returns 5 consecutive 5xx responses within 30 seconds, it is ejected from the load balancing pool for 30 seconds. This is automatic and requires zero application-level circuit breaker code.

---

### Junior → FAANG: Health Check Design as an Interview Signal

The three-probe model (liveness, readiness, startup) is a Kubernetes design question that comes up frequently in senior-track interviews. The key insight: liveness should never check external dependencies. If your liveness probe pings the database and the database has a brief hiccup, Kubernetes restarts the pod, which makes a database connectivity issue into a pod restart cascade. The readiness probe is the right place for dependency checks because failure removes the pod from the load balancer (stops traffic) without restarting the pod (preserving connection pool state).

The `SetReady()` pattern (using an atomic bool that is flipped after initialization completes) is the correct implementation for the common case where a service does schema migrations, cache warmup, or index loading at startup. Without a startup probe or an explicit readiness gate, Kubernetes may send traffic to a pod before it is ready, resulting in errors during the startup window.

First-job habit: put the health server on a separate port from the application server (port 9090 in the example, not 8080). This means health check traffic does not share the main server's connection pool, rate limiter, or request logging. A health check that shows up in application logs makes them noisy. A health check that shares a rate limiter can get throttled exactly when Kubernetes needs the probe to succeed during high load.

Prerequisite gap: the `maxEjectionPercent: 50` in the Istio DestinationRule is critical. Without it, the outlier detection algorithm could eject every instance of a service if they all happen to have a spike in errors simultaneously (for example, during a downstream database degradation). Ejecting 100% of instances routes all traffic to... nowhere, which is worse than routing to degraded instances. Know this setting by name.

### Senior @ FAANG: Advanced Service Discovery as Platform Infrastructure

The Istio VirtualService and DestinationRule YAML in this section represents infrastructure-as-code that the platform team owns, not the product team. The product team declares "my service is called payment-api and it should support canary deployments." The platform team provides the VirtualService template and the tooling that parameterizes it. This separation of concerns is the platform product model.

The `consecutive5xxErrors: 5` threshold for circuit breaking needs to be tuned per service. A high-throughput service making 10,000 requests per second can have 5 consecutive errors in under a millisecond during a routine retry storm. A low-throughput service making 10 requests per second might take 30 seconds to accumulate 5 consecutive errors, during which unhealthy instances continue receiving traffic. The platform team should provide a library of circuit breaker profiles (high-throughput, medium-throughput, low-throughput) that teams select from based on their measured traffic rate, rather than a single set of defaults that works poorly for both extremes.

The CoreDNS TTL of 30 seconds (in the Corefile) is a tunable that has cluster-wide implications. Lowering it to 5 seconds means endpoint changes propagate faster but increases the query load on CoreDNS (more cache misses mean more API server queries). Raising it to 60 seconds reduces DNS load but means a newly scaled-up pod takes up to 60 seconds to appear in DNS responses. A staff engineer tuning this setting must measure the actual endpoint update rate in the cluster and the CoreDNS CPU usage before making a change, and must have an observability dashboard that shows DNS query volume, cache hit rate, and API server query rate as metrics that can be correlated with the TTL setting.

The StatefulSet headless service pattern (`postgres-0.postgres-headless.svc.cluster.local`) is a specific design choice with operational implications: it requires the application to know the replica topology (which ordinal is the primary, which are replicas) and to make routing decisions based on that topology. For PostgreSQL, this typically means using a Go library that understands pgBouncer or Patroni's leader election to route write queries to the primary. A staff engineer designing the database access layer for a StatefulSet must own this routing logic and its failure modes (what happens when the primary changes during a Patroni failover, and how the application detects and adapts to the new primary's ordinal).

Bar-raiser depth: the `Watch` function in the Consul discovery client has a goroutine leak risk. If the context is canceled, the goroutine exits. But if `Watch` is called and the goroutine is started, and then the caller loses the reference to the `ConsulDiscovery` struct, the goroutine continues running until the context is canceled. The correct design is for `Watch` to take the context and for the caller to cancel it when discovery is no longer needed. Reviewing this pattern and identifying the goroutine lifecycle is the kind of code review depth that bar-raisers demonstrate.

