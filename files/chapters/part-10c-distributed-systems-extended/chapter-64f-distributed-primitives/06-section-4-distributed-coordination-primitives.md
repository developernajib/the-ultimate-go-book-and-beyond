## Section 4: Distributed Coordination Primitives

### 4.1 Distributed Barrier

A distributed barrier blocks all participating goroutines or processes until every participant has reached the barrier point, after which all are released simultaneously. This is useful for coordinating phased distributed computations. The following etcd-based Go implementation uses a key-per-participant pattern with a watch on the barrier prefix to detect when all participants have checked in.

```go
package coordination

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// Barrier blocks a set of processes until all have arrived.
// Use case: map-reduce coordination, distributed batch processing.
type Barrier struct {
	client   *clientv3.Client
	prefix   string
	nodeID   string
	n        int // Number of processes that must arrive.
}

func NewBarrier(client *clientv3.Client, prefix, nodeID string, n int) *Barrier {
	return &Barrier{
		client: client,
		prefix: prefix,
		nodeID: nodeID,
		n:      n,
	}
}

// Wait registers arrival and blocks until all n processes have arrived.
func (b *Barrier) Wait(ctx context.Context) error {
	key := b.prefix + "/" + b.nodeID

	// Create a short-lived lease for this arrival (auto-expires if process dies).
	lease, err := b.client.Grant(ctx, 30)
	if err != nil {
		return fmt.Errorf("grant lease: %w", err)
	}
	defer b.client.Revoke(ctx, lease.ID)

	// Register arrival.
	if _, err := b.client.Put(ctx, key, "arrived", clientv3.WithLease(lease.ID)); err != nil {
		return fmt.Errorf("register arrival: %w", err)
	}

	// Keep-alive for the lease.
	keepAliveCh, err := b.client.KeepAlive(ctx, lease.ID)
	if err != nil {
		return fmt.Errorf("keep alive: %w", err)
	}
	go func() {
		for range keepAliveCh {
		}
	}()

	// Wait until n processes have arrived.
	for {
		resp, err := b.client.Get(ctx, b.prefix+"/", clientv3.WithPrefix())
		if err != nil {
			return fmt.Errorf("check barrier: %w", err)
		}

		if int(resp.Count) >= b.n {
			return nil // All processes have arrived.
		}

		// Watch for new arrivals.
		watchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		watchCh := b.client.Watch(watchCtx, b.prefix+"/", clientv3.WithPrefix())
		select {
		case <-watchCh:
		case <-watchCtx.Done():
		case <-ctx.Done():
			cancel()
			return ctx.Err()
		}
		cancel()
	}
}

// DistributedSemaphore limits the number of concurrent processes holding the semaphore.
// Use case: limit concurrent DB connections, API calls, or resource access.
type DistributedSemaphore struct {
	client  *clientv3.Client
	prefix  string
	limit   int
}

func NewDistributedSemaphore(client *clientv3.Client, prefix string, limit int) *DistributedSemaphore {
	return &DistributedSemaphore{
		client: client,
		prefix: prefix,
		limit:  limit,
	}
}

// Acquire acquires one slot in the semaphore.
// Returns a release function to call when done.
func (s *DistributedSemaphore) Acquire(ctx context.Context) (func(), error) {
	session, err := concurrency.NewSession(s.client, concurrency.WithTTL(30))
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	mutex := concurrency.NewMutex(session, s.prefix+"/queue")
	if err := mutex.Lock(ctx); err != nil {
		session.Close()
		return nil, fmt.Errorf("queue for semaphore: %w", err)
	}

	// Check current holders.
	for {
		resp, err := s.client.Get(ctx, s.prefix+"/holders/", clientv3.WithPrefix())
		if err != nil {
			mutex.Unlock(ctx)
			session.Close()
			return nil, err
		}

		if int(resp.Count) < s.limit {
			break // Slot available.
		}

		// Wait for a holder to release.
		watchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		watchCh := s.client.Watch(watchCtx, s.prefix+"/holders/", clientv3.WithPrefix())
		select {
		case <-watchCh:
		case <-watchCtx.Done():
		case <-ctx.Done():
			cancel()
			mutex.Unlock(ctx)
			session.Close()
			return nil, ctx.Err()
		}
		cancel()
	}

	// Claim a slot.
	holderKey := fmt.Sprintf("%s/holders/%x", s.prefix, session.Lease())
	s.client.Put(ctx, holderKey, "holding", clientv3.WithLease(session.Lease()))

	// Release the queue lock.
	mutex.Unlock(ctx)

	release := func() {
		s.client.Delete(context.Background(), holderKey)
		session.Close()
	}
	return release, nil
}

// CountingSemaphore is a distributed semaphore implementation using Redis.
// Faster than etcd for high-throughput semaphore operations.
type CountingSemaphore struct {
	client *redis.Client
	key    string
	limit  int64
}

func NewCountingSemaphore(client *redis.Client, key string, limit int64) *CountingSemaphore {
	return &CountingSemaphore{client: client, key: key, limit: limit}
}

// semaphoreAcquireScript atomically increments the counter if below limit.
var semaphoreAcquireScript = redis.NewScript(`
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local current = tonumber(redis.call("GET", key) or "0")
if current < limit then
    redis.call("INCR", key)
    return 1
else
    return 0
end
`)

// TryAcquire attempts to acquire one slot. Returns false if at limit.
func (s *CountingSemaphore) TryAcquire(ctx context.Context) (bool, error) {
	result, err := semaphoreAcquireScript.Run(ctx, s.client,
		[]string{s.key}, s.limit).Int()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

// Release releases one semaphore slot.
func (s *CountingSemaphore) Release(ctx context.Context) error {
	return s.client.Decr(ctx, s.key).Err()
}
```

### 4.2 Service Registry

A service registry provides the dynamic discovery backbone for microservice architectures, allowing instances to register endpoints on startup, deregister on shutdown, and query healthy peers without relying on static configuration. The following etcd-based Go implementation covers lease-bound registration, watch-based change notifications, and a client-side load-balanced connection pool.

```go
package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// ServiceInstance represents a registered service endpoint.
type ServiceInstance struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Addr     string            `json:"addr"`
	Port     int               `json:"port"`
	Tags     []string          `json:"tags,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
	Health   HealthStatus      `json:"health"`
}

// HealthStatus indicates service health.
type HealthStatus string

const (
	Healthy   HealthStatus = "healthy"
	Unhealthy HealthStatus = "unhealthy"
	Unknown   HealthStatus = "unknown"
)

// ServiceRegistry provides service registration and discovery backed by etcd.
type ServiceRegistry struct {
	client  *clientv3.Client
	prefix  string
	leaseTTL int
}

func NewServiceRegistry(client *clientv3.Client, prefix string, leaseTTL int) *ServiceRegistry {
	return &ServiceRegistry{
		client:   client,
		prefix:   prefix,
		leaseTTL: leaseTTL,
	}
}

// Register registers a service instance with auto-renewal.
// The instance is automatically deregistered if this process dies.
// Returns a deregister function to call on clean shutdown.
func (r *ServiceRegistry) Register(ctx context.Context, instance ServiceInstance) (func(), error) {
	// Encode instance.
	data, err := json.Marshal(instance)
	if err != nil {
		return nil, fmt.Errorf("marshal instance: %w", err)
	}

	// Create lease with TTL.
	lease, err := r.client.Grant(ctx, int64(r.leaseTTL))
	if err != nil {
		return nil, fmt.Errorf("grant lease: %w", err)
	}

	key := r.instanceKey(instance.Name, instance.ID)

	// Register instance.
	if _, err := r.client.Put(ctx, key, string(data), clientv3.WithLease(lease.ID)); err != nil {
		r.client.Revoke(ctx, lease.ID)
		return nil, fmt.Errorf("register: %w", err)
	}

	// Keep lease alive.
	keepAliveCh, err := r.client.KeepAlive(ctx, lease.ID)
	if err != nil {
		r.client.Revoke(ctx, lease.ID)
		return nil, fmt.Errorf("keep alive: %w", err)
	}

	go func() {
		for range keepAliveCh {
			// Drain keep-alive responses.
		}
	}()

	deregister := func() {
		r.client.Revoke(context.Background(), lease.ID)
	}
	return deregister, nil
}

// Discover returns all registered instances of a service.
func (r *ServiceRegistry) Discover(ctx context.Context, serviceName string) ([]ServiceInstance, error) {
	prefix := r.prefix + "/" + serviceName + "/"
	resp, err := r.client.Get(ctx, prefix, clientv3.WithPrefix())
	if err != nil {
		return nil, fmt.Errorf("discover: %w", err)
	}

	instances := make([]ServiceInstance, 0, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		var instance ServiceInstance
		if err := json.Unmarshal(kv.Value, &instance); err != nil {
			continue
		}
		instances = append(instances, instance)
	}
	return instances, nil
}

// Watch returns a channel that receives updates when the service instances change.
func (r *ServiceRegistry) Watch(ctx context.Context, serviceName string) (<-chan []ServiceInstance, error) {
	prefix := r.prefix + "/" + serviceName + "/"
	ch := make(chan []ServiceInstance, 10)

	go func() {
		defer close(ch)

		// Send initial list.
		instances, err := r.Discover(ctx, serviceName)
		if err == nil {
			ch <- instances
		}

		// Watch for changes.
		watchCh := r.client.Watch(ctx, prefix, clientv3.WithPrefix())
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-watchCh:
				if !ok {
					return
				}
				// Fetch updated list.
				instances, err := r.Discover(ctx, serviceName)
				if err == nil {
					ch <- instances
				}
			}
		}
	}()

	return ch, nil
}

// UpdateHealth updates the health status of a service instance.
func (r *ServiceRegistry) UpdateHealth(ctx context.Context, instance ServiceInstance, status HealthStatus) error {
	// Fetch current registration.
	key := r.instanceKey(instance.Name, instance.ID)
	resp, err := r.client.Get(ctx, key)
	if err != nil {
		return fmt.Errorf("get instance: %w", err)
	}

	if len(resp.Kvs) == 0 {
		return fmt.Errorf("instance not registered")
	}

	var current ServiceInstance
	if err := json.Unmarshal(resp.Kvs[0].Value, &current); err != nil {
		return fmt.Errorf("unmarshal instance: %w", err)
	}

	current.Health = status
	data, err := json.Marshal(current)
	if err != nil {
		return err
	}

	// Update with same lease.
	leaseID := clientv3.LeaseID(resp.Kvs[0].Lease)
	_, err = r.client.Put(ctx, key, string(data), clientv3.WithLease(leaseID))
	return err
}

func (r *ServiceRegistry) instanceKey(serviceName, instanceID string) string {
	return fmt.Sprintf("%s/%s/%s", r.prefix, serviceName, instanceID)
}


// HealthChecker periodically checks service health and updates the registry.
type HealthChecker struct {
	registry  *ServiceRegistry
	instance  ServiceInstance
	checkFn   func(ctx context.Context) error
	interval  time.Duration
}

func NewHealthChecker(registry *ServiceRegistry, instance ServiceInstance,
	checkFn func(context.Context) error, interval time.Duration) *HealthChecker {
	return &HealthChecker{
		registry: registry,
		instance: instance,
		checkFn:  checkFn,
		interval: interval,
	}
}

// Run starts periodic health checking.
func (hc *HealthChecker) Run(ctx context.Context) {
	ticker := time.NewTicker(hc.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			status := Healthy
			if err := hc.checkFn(ctx); err != nil {
				status = Unhealthy
			}
			_ = hc.registry.UpdateHealth(ctx, hc.instance, status)
		}
	}
}
```

### Junior → FAANG: Barriers, Semaphores, and Service Registries in System Design

The three primitives in this section (distributed barrier, distributed semaphore, service registry) appear in different interview question categories.

Distributed barriers appear in questions about coordinating distributed batch jobs. "You have a MapReduce-style job where all mappers must finish before any reducer starts. How do you coordinate this?" The barrier is the answer: each mapper registers its arrival when done, the reducers wait on the barrier, and all reducers are released when all mappers have checked in. The implementation detail that matters in an interview: the lease on the barrier registration ensures that if a mapper crashes before finishing, the barrier eventually detects the crash (lease expires) and can implement the "job failed" path.

Distributed semaphores appear in questions about resource limiting. "Your service makes expensive calls to a third-party API that allows at most 10 concurrent connections. How do you enforce this across your 50-instance fleet?" The semaphore is the answer. The counting implementation with Redis `INCR` (atomically increment, only if below limit) is the correct approach for high-throughput scenarios. The etcd semaphore is correct but slower and more appropriate for lower-throughput coordination.

Service registries appear in almost every microservices design question. "How does Service A discover the current endpoints for Service B?" The answer should describe lease-based registration (automatically deregisters on crash), watch-based client-side updates (clients are notified when endpoints change without polling), and health check integration (only healthy endpoints are sent to clients). Kubernetes endpoints and Consul's service catalog implement this pattern.

The `HealthChecker` running on a loop is the "heartbeat" mechanism: if the check function fails, the health status is updated to Unhealthy, and clients watching the registry will stop routing to that instance. This is superior to purely lease-based registration (which only detects crashes, not internal service failures).

### Senior @ FAANG: Service Registry Consistency and Propagation Delay in Production

The service registry in this section provides strong consistency (etcd-backed) with watch-based propagation. At the scale of thousands of service instances and millions of requests per second, the propagation delay from a deregistration event to all clients updating their routing tables is the metric that determines how much traffic is sent to dead instances.

Propagation delay breakdown: instance deregisters (or crashes, causing TTL expiry after N seconds) → etcd watch event fires → client receives watch event → client updates its local endpoint list → next request goes to a healthy endpoint. For a graceful deregistration, the delay is the round-trip time for the watch notification (milliseconds). For a crash, the delay is the TTL (5-30 seconds) plus the watch notification round-trip. During the TTL window, requests routed to the crashed instance will fail, and clients must retry.

The interaction between the service registry TTL and the client-side load balancer retry policy: if the TTL is 10 seconds and the client retries failed requests once after 100ms, the client will make two failed requests to the crashed instance before either its registry cache is updated or the instance is fully removed. This means a 10-second TTL causes approximately (10 seconds / request rate) failed requests per client per crashed instance. At high request rates this can be a significant error volume.

Reducing the impact of crashed instances: the registry TTL determines how long stale entries persist, but clients should also implement passive health tracking (if an instance returns N consecutive errors, remove it from the local endpoint pool, regardless of registry state). Combining registry watch with passive health checking reduces the impact of a crashed instance from TTL-seconds to a few failed requests.

For a platform architect: the service registry is the load-bearing infrastructure for all inter-service traffic in a microservices architecture. Its availability directly determines the ability of all services to discover their dependencies. A service registry that becomes unavailable means all services that attempt to refresh their endpoint lists either use stale caches (acceptable with TTL-bounded staleness) or fail to start (unacceptable). The platform registry should run with higher reliability SLOs than any of the services it serves, typically as a 5-node etcd cluster with cross-zone placement.

ADR for service discovery: the choice between client-side discovery (each service maintains its own endpoint list from the registry) and server-side discovery (a load balancer queries the registry and routes on behalf of clients) has significant operational tradeoffs. Client-side discovery distributes the registry load across all clients and allows client-specific load balancing logic, but requires every client to implement the discovery library correctly. Server-side discovery (Envoy/Istio sidecar proxy pattern) centralizes routing logic but adds a network hop and a single point of configuration complexity.

---
