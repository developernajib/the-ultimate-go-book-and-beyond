## 51.2 Service Discovery Integration

### Service Registry

A service registry tracks which instances of each service are running and where to reach them. The gateway queries this registry on every request to resolve a service name to a concrete host and port. Defining the registry as an interface allows the gateway to work with an in-memory implementation during testing and swap in Consul, etcd, or Kubernetes in production without changing the routing logic.

> **Senior track**: In 2026 most teams get service discovery for free from the platform. On Kubernetes, `service.namespace.svc.cluster.local` DNS plus kube-proxy or a CNI handles the resolution, and the gateway (Traefik, Envoy with Istio/Consul xDS, or a Go service) just talks to the stable Service VIP. HashiCorp Consul is common in multi-cluster or VM-heavy environments, and Envoy's xDS API is the standard for dynamic config push from a control plane. Avoid querying the registry on every request. Cache the instance list, watch for changes, and push updates into the gateway's routing table. The common failure mode is stale discovery, the registry says instance X is healthy, instance X has been terminated for 30 seconds, and every request to it returns 502 until the TTL expires. Mitigations: short TTLs, passive health checks at the gateway itself, eject instances on consecutive 5xx.

```go
// pkg/gateway/registry.go
package gateway

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/url"
	"sync"
	"time"
)

// ServiceRegistry manages service discovery
type ServiceRegistry interface {
	Register(ctx context.Context, service *ServiceInstance) error
	Deregister(ctx context.Context, serviceID string) error
	GetServiceURL(serviceName string) (*url.URL, error)
	GetServiceInstances(serviceName string) ([]*ServiceInstance, error)
	Watch(ctx context.Context, serviceName string) (<-chan []*ServiceInstance, error)
}

// ServiceInstance represents a service instance
type ServiceInstance struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Host        string            `json:"host"`
	Port        int               `json:"port"`
	Tags        []string          `json:"tags"`
	Meta        map[string]string `json:"meta"`
	HealthCheck string            `json:"health_check"`
	Weight      int               `json:"weight"`
}

// URL returns the service URL
func (s *ServiceInstance) URL() string {
	return fmt.Sprintf("http://%s:%d", s.Host, s.Port)
}

// InMemoryRegistry is a simple in-memory service registry
type InMemoryRegistry struct {
	services map[string][]*ServiceInstance
	mu       sync.RWMutex
}

// NewInMemoryRegistry creates an in-memory registry
func NewInMemoryRegistry() *InMemoryRegistry {
	return &InMemoryRegistry{
		services: make(map[string][]*ServiceInstance),
	}
}

// Register registers a service instance
func (r *InMemoryRegistry) Register(ctx context.Context, instance *ServiceInstance) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	instances := r.services[instance.Name]
	for i, inst := range instances {
		if inst.ID == instance.ID {
			instances[i] = instance
			return nil
		}
	}

	r.services[instance.Name] = append(instances, instance)
	return nil
}

// Deregister removes a service instance
func (r *InMemoryRegistry) Deregister(ctx context.Context, serviceID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for name, instances := range r.services {
		for i, inst := range instances {
			if inst.ID == serviceID {
				r.services[name] = append(instances[:i], instances[i+1:]...)
				return nil
			}
		}
	}

	return fmt.Errorf("service not found: %s", serviceID)
}

// GetServiceURL returns a URL for the service using load balancing
func (r *InMemoryRegistry) GetServiceURL(serviceName string) (*url.URL, error) {
	r.mu.RLock()
	instances := r.services[serviceName]
	r.mu.RUnlock()

	if len(instances) == 0 {
		return nil, fmt.Errorf("no instances for service: %s", serviceName)
	}

	// Simple random load balancing
	instance := instances[rand.IntN(len(instances))]
	return url.Parse(instance.URL())
}

// GetServiceInstances returns all instances of a service
func (r *InMemoryRegistry) GetServiceInstances(serviceName string) ([]*ServiceInstance, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	instances := r.services[serviceName]
	if len(instances) == 0 {
		return nil, fmt.Errorf("no instances for service: %s", serviceName)
	}

	// Return copy
	result := make([]*ServiceInstance, len(instances))
	copy(result, instances)
	return result, nil
}

// Watch is not implemented for in-memory registry
func (r *InMemoryRegistry) Watch(ctx context.Context, serviceName string) (<-chan []*ServiceInstance, error) {
	return nil, fmt.Errorf("watch not supported")
}
```

### Consul Service Registry

Consul is a widely deployed service discovery backend that provides health-checked service registration, DNS-based and HTTP-based lookups, and blocking queries for change notification. The `ConsulRegistry` below wraps the Consul client with a local cache that has a configurable TTL, reducing the number of round trips to Consul on every inbound request. When the cache expires, it falls back to a fresh Consul query, and if that query fails it returns stale cached data rather than immediately failing the request.

```go
// pkg/gateway/consul.go
package gateway

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/url"
	"sync"
	"time"

	"github.com/hashicorp/consul/api"
)

// ConsulRegistry implements ServiceRegistry using Consul
type ConsulRegistry struct {
	client       *api.Client
	loadBalancer LoadBalancer
	cache        *serviceCache
}

type serviceCache struct {
	mu       sync.RWMutex
	services map[string][]*ServiceInstance
	ttl      time.Duration
	updated  map[string]time.Time
}

// NewConsulRegistry creates a Consul-backed registry
func NewConsulRegistry(addr string) (*ConsulRegistry, error) {
	config := api.DefaultConfig()
	config.Address = addr

	client, err := api.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("create consul client: %w", err)
	}

	return &ConsulRegistry{
		client:       client,
		loadBalancer: &RoundRobinLoadBalancer{},
		cache: &serviceCache{
			services: make(map[string][]*ServiceInstance),
			updated:  make(map[string]time.Time),
			ttl:      30 * time.Second,
		},
	}, nil
}

// Register registers a service with Consul
func (r *ConsulRegistry) Register(ctx context.Context, instance *ServiceInstance) error {
	registration := &api.AgentServiceRegistration{
		ID:      instance.ID,
		Name:    instance.Name,
		Address: instance.Host,
		Port:    instance.Port,
		Tags:    instance.Tags,
		Meta:    instance.Meta,
	}

	if instance.HealthCheck != "" {
		registration.Check = &api.AgentServiceCheck{
			HTTP:                           instance.HealthCheck,
			Interval:                       "10s",
			Timeout:                        "5s",
			DeregisterCriticalServiceAfter: "1m",
		}
	}

	return r.client.Agent().ServiceRegister(registration)
}

// Deregister removes a service from Consul
func (r *ConsulRegistry) Deregister(ctx context.Context, serviceID string) error {
	return r.client.Agent().ServiceDeregister(serviceID)
}

// GetServiceURL returns a URL for the service
func (r *ConsulRegistry) GetServiceURL(serviceName string) (*url.URL, error) {
	instances, err := r.GetServiceInstances(serviceName)
	if err != nil {
		return nil, err
	}

	instance := r.loadBalancer.Select(instances)
	if instance == nil {
		return nil, fmt.Errorf("no healthy instances for service: %s", serviceName)
	}

	return url.Parse(instance.URL())
}

// GetServiceInstances returns healthy instances of a service
func (r *ConsulRegistry) GetServiceInstances(serviceName string) ([]*ServiceInstance, error) {
	// Check cache
	r.cache.mu.RLock()
	instances, exists := r.cache.services[serviceName]
	updated := r.cache.updated[serviceName]
	r.cache.mu.RUnlock()

	if exists && time.Since(updated) < r.cache.ttl {
		return instances, nil
	}

	// Query Consul
	services, _, err := r.client.Health().Service(serviceName, "", true, nil)
	if err != nil {
		// Return cached data on error
		if exists {
			return instances, nil
		}
		return nil, fmt.Errorf("consul query failed: %w", err)
	}

	instances = make([]*ServiceInstance, 0, len(services))
	for _, svc := range services {
		weight := 1
		if w, ok := svc.Service.Meta["weight"]; ok {
			fmt.Sscanf(w, "%d", &weight)
		}

		instances = append(instances, &ServiceInstance{
			ID:     svc.Service.ID,
			Name:   svc.Service.Service,
			Host:   svc.Service.Address,
			Port:   svc.Service.Port,
			Tags:   svc.Service.Tags,
			Meta:   svc.Service.Meta,
			Weight: weight,
		})
	}

	// Update cache
	r.cache.mu.Lock()
	r.cache.services[serviceName] = instances
	r.cache.updated[serviceName] = time.Now()
	r.cache.mu.Unlock()

	return instances, nil
}

// Watch watches for service changes
func (r *ConsulRegistry) Watch(ctx context.Context, serviceName string) (<-chan []*ServiceInstance, error) {
	ch := make(chan []*ServiceInstance, 1)

	go func() {
		defer close(ch)

		var lastIndex uint64

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			services, meta, err := r.client.Health().Service(
				serviceName, "", true,
				&api.QueryOptions{
					WaitIndex: lastIndex,
					WaitTime:  30 * time.Second,
				},
			)
			if err != nil {
				time.Sleep(5 * time.Second)
				continue
			}

			if meta.LastIndex == lastIndex {
				continue
			}
			lastIndex = meta.LastIndex

			instances := make([]*ServiceInstance, 0, len(services))
			for _, svc := range services {
				instances = append(instances, &ServiceInstance{
					ID:   svc.Service.ID,
					Name: svc.Service.Service,
					Host: svc.Service.Address,
					Port: svc.Service.Port,
					Tags: svc.Service.Tags,
					Meta: svc.Service.Meta,
				})
			}

			select {
			case ch <- instances:
			default:
			}
		}
	}()

	return ch, nil
}

// LoadBalancer selects a service instance
type LoadBalancer interface {
	Select(instances []*ServiceInstance) *ServiceInstance
}

// RoundRobinLoadBalancer implements round-robin selection
type RoundRobinLoadBalancer struct {
	counters map[string]int
	mu       sync.Mutex
}

// Select picks the next instance
func (lb *RoundRobinLoadBalancer) Select(instances []*ServiceInstance) *ServiceInstance {
	if len(instances) == 0 {
		return nil
	}

	lb.mu.Lock()
	defer lb.mu.Unlock()

	if lb.counters == nil {
		lb.counters = make(map[string]int)
	}

	name := instances[0].Name
	index := lb.counters[name] % len(instances)
	lb.counters[name]++

	return instances[index]
}

// WeightedLoadBalancer implements weighted selection
type WeightedLoadBalancer struct {
	mu sync.Mutex
}

// Select picks an instance based on weight
func (lb *WeightedLoadBalancer) Select(instances []*ServiceInstance) *ServiceInstance {
	if len(instances) == 0 {
		return nil
	}

	totalWeight := 0
	for _, inst := range instances {
		weight := inst.Weight
		if weight <= 0 {
			weight = 1
		}
		totalWeight += weight
	}

	r := rand.IntN(totalWeight)
	for _, inst := range instances {
		weight := inst.Weight
		if weight <= 0 {
			weight = 1
		}
		r -= weight
		if r < 0 {
			return inst
		}
	}

	return instances[0]
}
```

### Junior -> FAANG: Service Discovery Concepts for Interviews

Service discovery sounds complex but the core idea is simple: services register themselves with an address when they start, and the gateway looks up that address by name. The interview question is almost always "how does the gateway know where service X is?" and the expected answer describes this registry lookup, not hardcoded IPs.

Know these two lookup modes by name: client-side discovery (the gateway queries the registry and load-balances itself, as shown here) and server-side discovery (the gateway sends to a load balancer that queries the registry, like an AWS ALB with ECS service discovery). Each has tradeoffs. Client-side gives the gateway more control, while server-side offloads routing logic but adds a hop.

The `InMemoryRegistry` in this section is your test double. Always write gateway tests against an in-memory registry so tests are deterministic and do not require a Consul cluster. The `ConsulRegistry` is the production implementation. This interface split is exactly what interviewers mean when they ask "how do you make this testable?"

Common interview mistake: saying you would call Consul on every request. The senior expectation is a local cache with watch-based invalidation, as shown in the `ConsulRegistry.GetServiceInstances` method.

### Senior @ FAANG: Service Discovery Reliability Engineering

The `ConsulRegistry` implementation exposes several decisions that matter in production.

**Cache TTL vs watch.** The implementation uses a 30-second TTL. During a scale-down event, terminated instances stay in the cache for up to 30 seconds, causing 502s to clients. The correct production pattern uses Consul blocking queries (`WaitIndex`) to receive push notifications within seconds of a health check change. The cache then stores the most recent watched state rather than polling with a TTL. The TTL acts as a fallback if the watch goroutine restarts.

**Stale reads on Consul failure.** The `GetServiceInstances` method returns stale cached data if the Consul query fails. This is the correct default: serving stale routing beats a hard failure during a Consul outage. But stale data has a limit. If Consul has been unreachable for 10 minutes, cached data may reference services that have scaled to zero. Consider adding a staleness timestamp and escalating to a `SRV`-only fallback (using DNS) after a configurable staleness threshold.

**Load balancer placement.** The `LoadBalancer` interface sits inside the registry implementation. At scale, load balancing logic belongs in a separate layer so it can be swapped independently of the discovery backend. Round-robin and weighted random work for most cases. Power-of-two-choices (pick two random endpoints, send to the one with fewer in-flight requests) gives meaningfully better tail latency under heterogeneous instance performance, which matters when a single slow JVM instance causes a long GC pause.

**Multi-cluster and multi-region.** The `InMemoryRegistry` and `ConsulRegistry` both assume a single Consul datacenter. In multi-region deployments, the gateway needs to prefer local-region instances (lower latency) but fall over to remote regions if the local set is unhealthy. This requires a registry abstraction that understands locality, which is why Envoy's xDS (EDS specifically) is the standard for multi-region gateways: the control plane can push locality-prioritized endpoint lists.

**Weight-based canary routing.** The `WeightedLoadBalancer` selects endpoints by weight. This is the correct primitive for canary deployments at the gateway layer: deploy a new service version, register it with weight 5 while the stable version has weight 95, observe error rates, then shift weight incrementally. This pattern is safer than DNS-based canary because weight changes take effect immediately without a TTL wait.

---
