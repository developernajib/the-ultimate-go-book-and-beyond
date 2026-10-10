## 47.4 Service Discovery

### The 2026 landscape: pick the right mechanism for your runtime

Service discovery is a solved problem in 2026, and which solution you use depends almost entirely on where your services run:

- **Kubernetes + DNS is the default.** If your services run on Kubernetes, you get service discovery for free: a `Service` object creates a stable DNS name (`orders.default.svc.cluster.local`) that resolves to healthy pod IPs via kube-proxy or CoreDNS. No client library, no registry protocol. Health is driven by pod `readinessProbe`s. unhealthy pods are removed from the endpoint list automatically. For 80% of Go microservices in 2026, this is all you need - a single `grpc.NewClient("dns:///orders:9090", ...)` with the gRPC DNS resolver and `round_robin` balancer.
- **Consul (or etcd) for non-Kubernetes environments.** VMs, bare metal, mixed on-prem/cloud, or multi-cluster-without-a-mesh scenarios still need an explicit registry. Consul remains the pragmatic choice: agents on every host, health checks, KV store for config, and a mature Go SDK. The client-side-discovery code below targets this case.
- **xDS for dynamic, service-mesh-grade load balancing.** When you need locality-aware routing, canary traffic splitting, weighted subsets, or cross-cluster failover, you graduate to the xDS API family (CDS/EDS/LDS/RDS) served by a control plane like Istio, Envoy Gateway, or a custom `go-control-plane` server. gRPC-Go natively speaks xDS, so application code dials `xds:///orders` and the control plane pushes endpoint updates in real time. This is what large Kubernetes platforms run under the hood when "plain DNS" stops scaling.
- **Cloud-native alternatives.** AWS Cloud Map, GCP Traffic Director (xDS-based), and Azure Service Fabric provide managed equivalents that integrate with their respective load balancers.

The examples below use Consul because it illustrates the registry/health-check/watch primitives explicitly. The same patterns apply to etcd, AWS Cloud Map, or your own xDS control plane.

### Client-Side Discovery

Client-side discovery queries Consul directly to retrieve healthy service instances, then applies a load-balancing strategy inside the calling Go process, eliminating an extra network hop compared to server-side discovery. The implementation watches the Consul catalog for changes using a blocking query, so the local instance list stays current without polling. This pattern is most valuable when callers need fine-grained control over routing (e.g., locality-aware balancing or canary traffic splitting).

```go
package discovery

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/hashicorp/consul/api"
)

// ServiceRegistry manages service discovery
type ServiceRegistry struct {
    client   *api.Client
    services sync.Map // service name -> []ServiceInstance
}

type ServiceInstance struct {
    ID      string
    Address string
    Port    int
    Tags    []string
    Healthy bool
}

func NewServiceRegistry(consulAddr string) (*ServiceRegistry, error) {
    client, err := api.NewClient(&api.Config{
        Address: consulAddr,
    })
    if err != nil {
        return nil, err
    }

    return &ServiceRegistry{client: client}, nil
}

// Register registers a service instance
func (r *ServiceRegistry) Register(ctx context.Context, serviceName, instanceID, address string, port int, tags []string) error {
    registration := &api.AgentServiceRegistration{
        ID:      instanceID,
        Name:    serviceName,
        Address: address,
        Port:    port,
        Tags:    tags,
        Check: &api.AgentServiceCheck{
            HTTP:                           fmt.Sprintf("http://%s:%d/health", address, port),
            Interval:                       "10s",
            Timeout:                        "5s",
            DeregisterCriticalServiceAfter: "1m",
        },
    }

    return r.client.Agent().ServiceRegister(registration)
}

// Deregister removes a service instance
func (r *ServiceRegistry) Deregister(instanceID string) error {
    return r.client.Agent().ServiceDeregister(instanceID)
}

// GetInstances returns healthy instances of a service
func (r *ServiceRegistry) GetInstances(serviceName string) ([]ServiceInstance, error) {
    services, _, err := r.client.Health().Service(serviceName, "", true, nil)
    if err != nil {
        return nil, err
    }

    instances := make([]ServiceInstance, 0, len(services))
    for _, service := range services {
        instances = append(instances, ServiceInstance{
            ID:      service.Service.ID,
            Address: service.Service.Address,
            Port:    service.Service.Port,
            Tags:    service.Service.Tags,
            Healthy: true,
        })
    }

    return instances, nil
}

// Watch watches for service changes
func (r *ServiceRegistry) Watch(ctx context.Context, serviceName string, onChange func([]ServiceInstance)) {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        services, meta, err := r.client.Health().Service(serviceName, "", true, &api.QueryOptions{
            WaitIndex: lastIndex,
            WaitTime:  time.Minute,
        })
        if err != nil {
            time.Sleep(5 * time.Second)
            continue
        }

        if meta.LastIndex != lastIndex {
            lastIndex = meta.LastIndex

            instances := make([]ServiceInstance, 0, len(services))
            for _, service := range services {
                instances = append(instances, ServiceInstance{
                    ID:      service.Service.ID,
                    Address: service.Service.Address,
                    Port:    service.Service.Port,
                    Tags:    service.Service.Tags,
                    Healthy: true,
                })
            }

            onChange(instances)
        }
    }
}
```

### Load Balancer

The load balancer uses `sync/atomic` for a lock-free round-robin counter, avoiding mutex contention on every request while still distributing load evenly across instances. Pairing this with the Consul-backed discovery client means the instance list is refreshed automatically when services register or deregister, so the balancer never routes to a stale endpoint. For weighted or least-connections strategies, the same interface can be satisfied by swapping the balancing implementation without changing callers.

```go
package lb

import (
    "sync"
    "sync/atomic"
)

// LoadBalancer selects service instances
type LoadBalancer interface {
    Next() *ServiceInstance
    Update(instances []ServiceInstance)
}

// RoundRobinLB implements round-robin load balancing
type RoundRobinLB struct {
    mu        sync.RWMutex
    instances []ServiceInstance
    counter   uint64
}

func NewRoundRobinLB() *RoundRobinLB {
    return &RoundRobinLB{}
}

func (lb *RoundRobinLB) Update(instances []ServiceInstance) {
    lb.mu.Lock()
    lb.instances = instances
    lb.mu.Unlock()
}

func (lb *RoundRobinLB) Next() *ServiceInstance {
    lb.mu.RLock()
    defer lb.mu.RUnlock()

    if len(lb.instances) == 0 {
        return nil
    }

    idx := atomic.AddUint64(&lb.counter, 1) % uint64(len(lb.instances))
    return &lb.instances[idx]
}

// WeightedRoundRobinLB with weights
type WeightedRoundRobinLB struct {
    mu        sync.RWMutex
    instances []weightedInstance
    counter   int
}

type weightedInstance struct {
    ServiceInstance
    Weight        int
    CurrentWeight int
}

func (lb *WeightedRoundRobinLB) Next() *ServiceInstance {
    lb.mu.Lock()
    defer lb.mu.Unlock()

    if len(lb.instances) == 0 {
        return nil
    }

    totalWeight := 0
    var selected *weightedInstance

    for i := range lb.instances {
        lb.instances[i].CurrentWeight += lb.instances[i].Weight
        totalWeight += lb.instances[i].Weight

        if selected == nil || lb.instances[i].CurrentWeight > selected.CurrentWeight {
            selected = &lb.instances[i]
        }
    }

    selected.CurrentWeight -= totalWeight
    return &selected.ServiceInstance
}
```

### Junior → FAANG: Service Discovery as a System Design Building Block

Service discovery is a topic that trips up junior candidates because it feels like "infrastructure detail" rather than "design decision." It is both. In a system design interview, after you have drawn your services, the interviewer will ask "how does service A find service B?" You need a concrete answer.

The two-sentence answer for Kubernetes: "On Kubernetes, each service gets a DNS name via a Service object. Clients dial that DNS name and kube-proxy or CoreDNS routes to a healthy pod. No client-side registry code is needed." This is correct and sufficient for most interview contexts.

The two-sentence answer for non-Kubernetes: "We'd run Consul. Each service registers itself on startup, includes a health check endpoint, and deregisters on shutdown. Clients query Consul for healthy instances and apply round-robin load balancing locally."

Health checks are often forgotten in junior-level answers. Always mention: what the health check endpoint returns, how the registry uses it to remove unhealthy instances from the pool, and what the deregistration grace period is during graceful shutdown. A service that shuts down without deregistering will receive traffic for up to the health check interval after it stops serving.

Graceful shutdown in Go: register a shutdown signal handler, call `grpc.GracefulStop()` or `http.Server.Shutdown()`, then deregister from Consul/Kubernetes. The ordering matters. Deregister first, then drain, so no new requests arrive during the drain window.

### Senior @ FAANG: xDS, Mesh-Based Discovery, and Multi-Cluster Routing

Staff-level service discovery thinking operates at the control plane level, not the client-library level. The question is not "which registry do we use" but "how do we model our routing topology so that the control plane can serve it dynamically?"

**xDS as the unifying abstraction.** The xDS API family (CDS, EDS, LDS, RDS, SRDS) is the standard protocol for distributing routing and endpoint information from a control plane to data plane proxies (Envoy) and directly to xDS-capable clients (gRPC-Go with `xds:///` resolver). CDS defines clusters (logical upstreams). EDS provides endpoint lists per cluster. LDS defines listeners. RDS defines HTTP routing rules. When a control plane pushes an EDS update, all Envoy sidecars and gRPC clients reconfigure their endpoint lists in-memory without restart or connection loss. This is the mechanism that makes canary deployments (gradually shift traffic from v1 endpoints to v2 endpoints) and locality-aware routing (prefer same-AZ endpoints) possible at scale.

**CAP theorem applied to service registries.** Consul is CP: it requires quorum for reads and writes, so during a network partition the minority partition stops serving registration updates to preserve consistency. Eureka is AP: it continues serving stale data during a partition (self-preservation mode), preferring availability. In practice, for service discovery, Consul's behavior is usually correct: during a partition you want to stop routing to endpoints you cannot verify are healthy, not continue routing to potentially dead instances with stale data. The exception is read-heavy, latency-sensitive services where a stale-but-available endpoint list is preferable to a "no instances" error. Staff engineers make this tradeoff explicitly and document it.

**Multi-cluster discovery.** Single-cluster discovery is a solved problem. Multi-cluster is the active frontier in 2026. The three patterns: (1) Federation: a central registry (Consul federation or MCS with ServiceImport/ServiceExport) aggregates endpoint lists from multiple clusters. Clients query the federation endpoint. (2) Control-plane mesh: an xDS control plane like Istio's multi-cluster mode pushes cross-cluster endpoints to all sidecars. Traffic crosses clusters via Istio east-west gateways. (3) DNS-based global load balancing: use AWS Route 53 / GCP Cloud DNS with health-checked routing policies to direct traffic to the healthy cluster. Pattern (2) is the most capable for fine-grained routing but the most operationally complex. Pattern (3) is the simplest and sufficient for active-passive failover.

**Thundering herd after partition healing.** When a long partition heals, all services that experienced "no instances" simultaneously retry discovery and then simultaneously send accumulated traffic to the newly-visible instances. The mitigation at the platform level is: jittered blocking query timeouts on the discovery watch loop (already shown in the code), a backpressure signal from the upstream service (overload rejection with 503), and circuit breaker half-open probing (one request per service per interval, not a flood). Staff engineers document this failure mode in the runbook and run a chaos engineering scenario that simulates it before it happens in production.

---
