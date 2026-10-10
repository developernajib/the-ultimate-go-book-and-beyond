## 102G.7 Consul Service Registration

Consul is a service mesh and service registry from HashiCorp that supports health-checked registration, KV storage, and service-to-service mTLS via Consul Connect. When a Go service starts, it registers itself with the local Consul agent including a health check definition. Typically an HTTP endpoint or TCP check. So that the registry only returns instances that are currently passing their checks. Deregistering on graceful shutdown is critical: without it, Consul continues serving the stopped instance's address until the health check fails, which causes a brief window of routing errors.

```go
package consul

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "os"
    "sync"
    "time"

    consulapi "github.com/hashicorp/consul/api"
)

// ServiceRegistry manages Consul service registration and health checks
type ServiceRegistry struct {
    client      *consulapi.Client
    serviceID   string
    serviceName string
    port        int
    logger      *slog.Logger
}

func NewServiceRegistry(serviceName string, port int, logger *slog.Logger) (*ServiceRegistry, error) {
    config := consulapi.DefaultConfig()
    config.Address = getEnv("CONSUL_HTTP_ADDR", "consul:8500")

    client, err := consulapi.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("create consul client: %w", err)
    }

    hostname, _ := os.Hostname()
    serviceID := fmt.Sprintf("%s-%s-%d", serviceName, hostname, port)

    return &ServiceRegistry{
        client:      client,
        serviceID:   serviceID,
        serviceName: serviceName,
        port:        port,
        logger:      logger,
    }, nil
}

// Register registers the service with health check
func (r *ServiceRegistry) Register(ctx context.Context) error {
    // Get pod IP for registration
    podIP, err := getPodIP()
    if err != nil {
        return fmt.Errorf("get pod IP: %w", err)
    }

    registration := &consulapi.AgentServiceRegistration{
        ID:      r.serviceID,
        Name:    r.serviceName,
        Address: podIP,
        Port:    r.port,
        Tags: []string{
            "go",
            "v1",
            getEnv("APP_ENV", "dev"),
        },
        Meta: map[string]string{
            "version":    getEnv("APP_VERSION", "unknown"),
            "started_at": time.Now().UTC().Format(time.RFC3339),
        },
        Check: &consulapi.AgentServiceCheck{
            HTTP:                           fmt.Sprintf("http://%s:%d/health", podIP, r.port),
            Interval:                       "10s",
            Timeout:                        "3s",
            DeregisterCriticalServiceAfter: "1m",
        },
    }

    if err := r.client.Agent().ServiceRegister(registration); err != nil {
        return fmt.Errorf("consul register: %w", err)
    }

    r.logger.Info("registered with consul",
        "service_id", r.serviceID,
        "address", podIP,
        "port", r.port,
    )
    return nil
}

// Deregister removes the service from Consul
func (r *ServiceRegistry) Deregister() error {
    if err := r.client.Agent().ServiceDeregister(r.serviceID); err != nil {
        return fmt.Errorf("consul deregister: %w", err)
    }
    r.logger.Info("deregistered from consul", "service_id", r.serviceID)
    return nil
}

// Discover returns healthy instances of a service
func (r *ServiceRegistry) Discover(ctx context.Context, serviceName string) ([]*consulapi.ServiceEntry, error) {
    entries, _, err := r.client.Health().Service(serviceName, "", true, &consulapi.QueryOptions{
        RequireConsistent: true,
        Context:           ctx,
    })
    if err != nil {
        return nil, fmt.Errorf("consul health query: %w", err)
    }

    if len(entries) == 0 {
        return nil, fmt.Errorf("no healthy instances of %q found", serviceName)
    }

    return entries, nil
}

// WatchService watches for service changes and sends updates to the channel
func (r *ServiceRegistry) WatchService(ctx context.Context, serviceName string, updates chan<- []*consulapi.ServiceEntry) {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        entries, meta, err := r.client.Health().Service(serviceName, "", true, &consulapi.QueryOptions{
            WaitIndex: lastIndex,
            WaitTime:  30 * time.Second,
            Context:   ctx,
        })
        if err != nil {
            if ctx.Err() != nil {
                return
            }
            r.logger.Error("consul watch error", "service", serviceName, "err", err)
            time.Sleep(5 * time.Second)
            continue
        }

        if meta.LastIndex > lastIndex {
            lastIndex = meta.LastIndex
            updates <- entries
        }
    }
}

// LoadBalancer provides round-robin load balancing over Consul service entries
type LoadBalancer struct {
    registry *ServiceRegistry
    service  string
    entries  []*consulapi.ServiceEntry
    idx      int
    mu       sync.Mutex
}

func NewLoadBalancer(registry *ServiceRegistry, serviceName string) *LoadBalancer {
    lb := &LoadBalancer{
        registry: registry,
        service:  serviceName,
    }

    // Start background watch for service updates
    updates := make(chan []*consulapi.ServiceEntry, 1)
    go registry.WatchService(context.Background(), serviceName, updates)
    go func() {
        for entries := range updates {
            lb.mu.Lock()
            lb.entries = entries
            lb.mu.Unlock()
        }
    }()

    return lb
}

// Next returns the next healthy service instance (round-robin)
func (lb *LoadBalancer) Next() (string, error) {
    lb.mu.Lock()
    defer lb.mu.Unlock()

    if len(lb.entries) == 0 {
        return "", fmt.Errorf("no healthy instances of %q", lb.service)
    }

    entry := lb.entries[lb.idx%len(lb.entries)]
    lb.idx++

    return fmt.Sprintf("%s:%d", entry.Service.Address, entry.Service.Port), nil
}

func getPodIP() (string, error) {
    // In Kubernetes, use downward API: MY_POD_IP env var
    if ip := os.Getenv("MY_POD_IP"); ip != "" {
        return ip, nil
    }
    // Fallback: get outbound IP
    conn, err := net.Dial("udp", "8.8.8.8:80")
    if err != nil {
        return "", err
    }
    defer conn.Close()
    return conn.LocalAddr().(*net.UDPAddr).IP.String(), nil
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

---

### Junior → FAANG: Registration Lifecycle and Health Check Design

The most common mistake juniors make with Consul registration is forgetting to deregister on shutdown. The `DeregisterCriticalServiceAfter: "1m"` field in the health check definition is the safety net, not the primary deregistration mechanism. If your service crashes without calling `Deregister`, Consul will wait up to 1 minute before removing the entry. During that minute, 1 in N requests to that service will fail. In a graceful shutdown, you call `Deregister` immediately and the removal is instant.

The health check endpoint design matters: `/health` should return quickly (under 10ms), should not depend on downstream services (a database connectivity check in your health endpoint makes every pod look unhealthy when the database has a blip), and should return 200 only when the pod is genuinely ready to serve traffic. The `Interval: "10s"` and `Timeout: "3s"` values in the registration are sensible defaults but should be tuned based on your service's startup time.

Prerequisite gap: the `RequireConsistent: true` flag in `Discover` means the query goes to the Consul leader rather than a follower, guaranteeing the response reflects all writes up to that point. The cost is higher latency. Know when consistency matters (during a deployment, when you need the freshest instance list) versus when eventual consistency is acceptable (steady-state routing).

First-job interview framing: if asked "how do you handle service discovery in a microservice architecture," walk through registration at startup, health check polling, discovery via the registry, and deregistration at shutdown. That complete lifecycle answer, including the failure modes at each step, is what distinguishes a candidate who has operated a system from one who has read about it.

### Senior @ FAANG: Consul as Platform Infrastructure and Operational Ownership

At the staff level, Consul is platform infrastructure, not a library your service uses. The platform team runs the Consul cluster (raft consensus across 3 or 5 servers for HA), monitors its health, manages upgrades, and defines the policies that govern what services can register and how.

The `WatchService` pattern using Consul's blocking queries is the correct implementation for live discovery. But at scale, this pattern has an operational implication: every service instance maintains a long-polling connection to the Consul agent. With 500 services each running 10 instances, you have 5,000 concurrent long-polling connections to the Consul cluster. The Consul server's connection limits and the agent's memory usage must be sized for this. A staff engineer designing the Consul platform needs to model this connection load before the cluster is in production.

The load balancer implementation here (round-robin) is intentionally simple. At FAANG scale, you need weighted round-robin (to route more traffic to higher-capacity instances), latency-aware routing (to prefer the instance with the lowest recent p99), and circuit breaking (to stop sending traffic to an instance that is returning errors even if its health check still passes). These capabilities are where a service mesh (Consul Connect, Envoy) provides more value than a client-side load balancer implemented in application code, because they are implemented once in the proxy rather than once per language.

ADR question: should you use Consul for service discovery or Kubernetes-native service discovery? If you are fully on Kubernetes, Kubernetes DNS is the simpler answer with less operational overhead. Consul adds value when: you have services outside Kubernetes that need to register, you need cross-datacenter service discovery, or you need KV store capabilities. A staff engineer making this recommendation needs to document the operational cost of running Consul (server maintenance, upgrade cadence, capacity planning) and weigh it against the additional capabilities.

The `getPodIP` fallback using a UDP dial to 8.8.8.8 is a well-known pattern but has a failure mode: in an environment with strict egress network policies that block outbound UDP, this call fails. The correct production pattern is the Kubernetes downward API (`MY_POD_IP` from the fieldRef), which is always available inside a Kubernetes pod without any network call. A staff engineer reviewing this code should flag the fallback as unsafe for environments with strict network policies.

