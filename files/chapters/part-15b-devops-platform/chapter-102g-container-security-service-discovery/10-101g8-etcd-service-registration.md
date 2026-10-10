## 102G.8 etcd Service Registration

etcd is the distributed key-value store that backs Kubernetes cluster state, but it also serves as an effective service registry for non-Kubernetes environments. Services register themselves by writing a key with a short TTL and refreshing it periodically using a lease. If the service crashes, the lease expires and the key is automatically deleted, providing free health-check semantics. Watching a key prefix with etcd's watch API gives consumers a real-time stream of register and deregister events, enabling instant convergence without polling.

```go
package etcdreg

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
)

// ServiceInfo holds information about a registered service instance
type ServiceInfo struct {
    Name    string `json:"name"`
    Address string `json:"address"`
    Port    int    `json:"port"`
    Version string `json:"version"`
}

// EtcdRegistry implements service registration using etcd leases
type EtcdRegistry struct {
    client    *clientv3.Client
    leaseID   clientv3.LeaseID
    key       string
    logger    *slog.Logger
    keepalive <-chan *clientv3.LeaseKeepAliveResponse
}

func NewEtcdRegistry(endpoints []string, logger *slog.Logger) (*EtcdRegistry, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("create etcd client: %w", err)
    }

    return &EtcdRegistry{client: client, logger: logger}, nil
}

// Register creates a lease-backed key for service discovery
// The key automatically expires if the keepalive goroutine stops
func (r *EtcdRegistry) Register(ctx context.Context, info ServiceInfo, ttl time.Duration) error {
    // Create lease with TTL
    lease, err := r.client.Grant(ctx, int64(ttl.Seconds()))
    if err != nil {
        return fmt.Errorf("grant lease: %w", err)
    }
    r.leaseID = lease.ID

    // Serialize service info
    data, err := json.Marshal(info)
    if err != nil {
        return fmt.Errorf("marshal service info: %w", err)
    }

    // Key format: /services/{name}/{address}:{port}
    r.key = fmt.Sprintf("/services/%s/%s:%d", info.Name, info.Address, info.Port)

    // Register with lease (key expires when lease expires)
    if _, err := r.client.Put(ctx, r.key, string(data), clientv3.WithLease(lease.ID)); err != nil {
        return fmt.Errorf("put service key: %w", err)
    }

    // Start keepalive: renews lease every ttl/3 seconds
    keepalive, err := r.client.KeepAlive(ctx, lease.ID)
    if err != nil {
        return fmt.Errorf("start keepalive: %w", err)
    }
    r.keepalive = keepalive

    // Drain keepalive responses (required to prevent blocking)
    go func() {
        for range r.keepalive {
            // KeepAlive sends responses every ttl/3 seconds
            // We just need to drain the channel
        }
        r.logger.Warn("etcd keepalive channel closed, service may deregister")
    }()

    r.logger.Info("registered with etcd",
        "key", r.key,
        "lease_id", fmt.Sprintf("%x", r.leaseID),
        "ttl", ttl,
    )
    return nil
}

// Deregister explicitly removes the service registration
func (r *EtcdRegistry) Deregister(ctx context.Context) error {
    // Revoking the lease removes all keys associated with it
    if _, err := r.client.Revoke(ctx, r.leaseID); err != nil {
        return fmt.Errorf("revoke lease: %w", err)
    }
    r.logger.Info("deregistered from etcd", "key", r.key)
    return nil
}

// Discover returns all instances of a service
func (r *EtcdRegistry) Discover(ctx context.Context, serviceName string) ([]ServiceInfo, error) {
    prefix := fmt.Sprintf("/services/%s/", serviceName)

    resp, err := r.client.Get(ctx, prefix, clientv3.WithPrefix())
    if err != nil {
        return nil, fmt.Errorf("etcd get: %w", err)
    }

    var services []ServiceInfo
    for _, kv := range resp.Kvs {
        var info ServiceInfo
        if err := json.Unmarshal(kv.Value, &info); err != nil {
            r.logger.Error("failed to parse service info", "key", string(kv.Key), "err", err)
            continue
        }
        services = append(services, info)
    }

    if len(services) == 0 {
        return nil, fmt.Errorf("no instances of %q found", serviceName)
    }

    return services, nil
}

// Watch returns a channel that emits service list updates
func (r *EtcdRegistry) Watch(ctx context.Context, serviceName string) <-chan []ServiceInfo {
    updates := make(chan []ServiceInfo, 1)
    prefix := fmt.Sprintf("/services/%s/", serviceName)

    go func() {
        defer close(updates)

        // Send initial list
        services, err := r.Discover(ctx, serviceName)
        if err == nil {
            updates <- services
        }

        // Watch for changes
        watchCh := r.client.Watch(ctx, prefix, clientv3.WithPrefix())
        for {
            select {
            case <-ctx.Done():
                return
            case _, ok := <-watchCh:
                if !ok {
                    return
                }
                services, err := r.Discover(ctx, serviceName)
                if err != nil {
                    r.logger.Error("discover after watch event", "err", err)
                    continue
                }
                updates <- services
            }
        }
    }()

    return updates
}
```

---

### Junior → FAANG: Understanding Lease-Based Health Checks

The lease mechanism in etcd is an elegant approach to health checking that replaces explicit heartbeat APIs with an implicit liveness signal. The service renews its lease every `ttl/3` seconds. If the service process dies, the keepalive goroutine dies with it, the lease stops being renewed, and after TTL seconds the key automatically expires. Consul achieves the same thing with HTTP health checks, but the etcd lease model is simpler because the check is implicit in the connection lifecycle rather than requiring a separate polling mechanism.

Prerequisite gap: the comment "drain keepalive responses (required to prevent blocking)" is critical and easy to misunderstand. The `KeepAlive` function returns a channel that must be consumed. If you do not drain this channel, the etcd client's internal goroutine eventually blocks trying to send, and keepalive messages stop being sent, causing the lease to expire even though the service is healthy. This is a silent failure mode that manifests as mysterious service deregistrations in production.

TTL selection is a trade-off: a short TTL (5 seconds) means a crashed service disappears from the registry quickly, reducing the window of routing errors. But it also means any network hiccup that delays a keepalive response causes a false deregistration. A 15-30 second TTL with keepalive every 5-10 seconds is a more reliable starting point.

First-job habit: always implement explicit deregistration on graceful shutdown even when using lease-based registration. `Revoke` removes the lease and all associated keys immediately, without waiting for TTL expiry. A 30-second TTL means 30 seconds of routing errors to a dead pod if you rely only on TTL expiry.

### Senior @ FAANG: etcd Operational Boundaries and Registry Design Decisions

etcd is designed as a consensus store for Kubernetes cluster state, not as a high-throughput service registry for application-layer discovery. Understanding its operational boundaries is critical before using it as a registry in a large-scale system.

The etcd data size limit per key is 1.5 MB by default, and the default total database size limit is 8 GB. For service registry use, the keys are tiny (service metadata is a few hundred bytes). But the watch API has an operational implication: each `Watch` call consumes a watcher slot on the etcd server, and each watcher receives all events for its prefix. In a large cluster with hundreds of services and thousands of watchers, the event fan-out from a single service registration change can create a spike in network traffic from the etcd server to all watchers. This is measurable and has caused etcd performance degradation in large Kubernetes clusters when application teams add additional watch-based service discovery on top of the built-in Kubernetes watcher load.

The ADR question: should you use etcd directly for service discovery, or use it only for Kubernetes cluster state and use Consul or Kubernetes Services for application-layer discovery? The answer in most organizations is: do not use etcd directly for application service discovery. Use it only for Kubernetes cluster state. The Kubernetes API server already provides watch-based resource discovery (Endpoints, EndpointSlices) that is backed by etcd and mediated by the API server's caching layer, which reduces the direct watch load on etcd.

The watch pattern in the code above has a subtle race: it sends the initial list, then watches for changes. A service registration that happens between the initial `Discover` call and the `Watch` call is missed. The correct implementation initializes the watch first (recording the revision at watch start), then fetches the initial list at that revision, then processes watch events with revisions after that point. This is the pattern the Kubernetes informer framework implements. A staff engineer reviewing this code should flag the race and propose the correct revision-anchored initialization.

At FAANG scale, the key space naming convention (`/services/{name}/{address}:{port}`) needs governance. Without an enforced naming convention, services in different teams use different key formats, and discovery queries return inconsistent results. The platform team should own the registry client library (a thin wrapper around the etcd client that enforces the naming convention and the TTL policy) and require product teams to use it rather than the raw etcd client.

