## 102G.9 DNS-Based Service Discovery

DNS-based service discovery is the simplest form of service discovery: the registry is a DNS server and service addresses are SRV or A records. In Kubernetes, CoreDNS automatically creates DNS records for every Service object, making `http://my-service.my-namespace.svc.cluster.local` resolve to the service's ClusterIP with no additional infrastructure. For external services or non-Kubernetes environments, a custom DNS resolver like the one below queries SRV records to discover ports alongside IP addresses, enabling zero-configuration client setup when combined with a dynamic DNS provider.

```go
package dns

import (
    "context"
    "fmt"
    "net"
    "time"
)

// LookupSRV resolves a Kubernetes SRV record for service discovery
// In Kubernetes: _http._tcp.{service}.{namespace}.svc.cluster.local
func LookupSRV(ctx context.Context, service, namespace string) ([]string, error) {
    // SRV record format in Kubernetes DNS
    srvName := fmt.Sprintf("_http._tcp.%s.%s.svc.cluster.local", service, namespace)

    var resolver net.Resolver
    _, addrs, err := resolver.LookupSRV(ctx, "", "", srvName)
    if err != nil {
        return nil, fmt.Errorf("SRV lookup %q: %w", srvName, err)
    }

    if len(addrs) == 0 {
        return nil, fmt.Errorf("no SRV records for %q", srvName)
    }

    var endpoints []string
    for _, addr := range addrs {
        // addr.Target is like: shopapp-api.shopapp-production.svc.cluster.local
        endpoints = append(endpoints, fmt.Sprintf("%s:%d", addr.Target, addr.Port))
    }

    return endpoints, nil
}

// ResolveWithRetry performs DNS lookup with exponential backoff
// Useful during startup when DNS may not have propagated
func ResolveWithRetry(ctx context.Context, host string, maxAttempts int) ([]net.IP, error) {
    var lastErr error
    backoff := time.Second

    for range maxAttempts {
        ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
        if err == nil && len(ips) > 0 {
            addrs := make([]net.IP, len(ips))
            for j, ip := range ips {
                addrs[j] = ip.IP
            }
            return addrs, nil
        }
        lastErr = err

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(backoff):
            backoff *= 2
            if backoff > 30*time.Second {
                backoff = 30 * time.Second
            }
        }
    }

    return nil, fmt.Errorf("DNS resolution failed after %d attempts: %w", maxAttempts, lastErr)
}
```

---

### Junior → FAANG: DNS as the Simplest Path and Its Limitations

DNS-based discovery is the right default for most Kubernetes services because it requires zero application code. Your Go service calls `http://payment-service.production.svc.cluster.local` and CoreDNS resolves it. You do not need to know what Consul is. Understanding when this default is insufficient is what interviews test.

The `ResolveWithRetry` function handles a real operational scenario: a service starts and immediately tries to connect to a dependency that has not yet propagated through DNS. This is common during cluster restarts or rolling deployments. The exponential backoff with a maximum of 30 seconds avoids hammering DNS during propagation while eventually succeeding when the record is available.

Prerequisite gap: the difference between A records and SRV records. An A record returns an IP address. An SRV record returns a hostname, port, weight, and priority, allowing DNS to encode the port number and load balancing hints. In Kubernetes, headless services (ClusterIP: None) return individual pod IPs as A records, enabling client-side load balancing. Regular services return a single ClusterIP. Knowing when to use a headless service is a question that comes up in stateful workload design interviews (StatefulSets use headless services for stable pod DNS names).

First-job habit: always use the full DNS name (`service.namespace.svc.cluster.local`) in configuration rather than the short form (`service`). The short form relies on the pod's search domain list, which adds latency for each unqualified lookup and can resolve to the wrong namespace in multi-namespace clusters.

### Senior @ FAANG: CoreDNS Governance and DNS Performance at Scale

At the platform level, CoreDNS is a critical path component. Every service-to-service call in the cluster goes through DNS resolution (unless the connection is long-lived and reuses a resolved address). CoreDNS availability and latency directly affect the SLA of every service in the cluster.

The CoreDNS capacity model: at 1000 requests per second per service instance, with 100 services, each making 10 DNS lookups per second, you have 1 million DNS queries per second hitting CoreDNS. A default CoreDNS deployment (2 replicas) will saturate well before this point. Platform engineers need to capacity plan CoreDNS based on the cluster's service call rate, not just the number of services.

The DNS TTL issue at scale: Kubernetes Services have a fixed DNS TTL (typically 5 seconds for CoreDNS's default cache). During a rolling deployment, the old pod's IP remains in DNS for up to TTL seconds after it stops serving traffic. With a TTL of 5 seconds and a deployment rollout window of 60 seconds, you have a well-understood window of potential routing to terminating pods. The mitigation is `preStop` lifecycle hooks that add a sleep before the pod terminates, giving DNS time to propagate. This is an operational detail that staff engineers include in their deployment runbooks but juniors discover for the first time during an incident.

The ndots configuration is a subtle performance issue that affects Go services. The default Kubernetes pod DNS search path has `ndots:5`, meaning any hostname with fewer than 5 dots triggers additional search domain queries before a direct lookup. `payment-service` becomes five separate DNS queries before resolving. A Go HTTP client making thousands of requests per second with short-lived connections generates thousands of redundant DNS queries. The mitigation is using FQDNs (ending with a dot, or having 5+ dots) in service addresses, which bypasses the search domain logic. A staff engineer profiling DNS latency should check for ndots-related query amplification, which is one of the most common sources of unexpected DNS load in Kubernetes clusters.

ADR: should you use CoreDNS caching (NodeLocal DNSCache) to reduce latency? NodeLocal DNSCache runs a DNS proxy on each node that caches responses locally, reducing the number of queries that reach CoreDNS and eliminating the network hop to the CoreDNS pods. The trade-off is operational complexity (a DaemonSet on every node) and a potential for stale cache entries during rapid IP changes. The correct answer for clusters above a few hundred nodes is yes, use NodeLocal DNSCache, with a cache TTL tuned to match the expected Endpoints update latency.
