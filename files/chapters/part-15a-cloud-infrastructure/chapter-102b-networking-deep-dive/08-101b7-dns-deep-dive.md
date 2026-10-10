## 102B.7 DNS Deep Dive

### DNS Hierarchy

DNS (Domain Name System) is a distributed, hierarchical database mapping names to addresses.

```
.                          ← Root zone (13 root server clusters, anycast)
├── com.                   ← TLD (Verisign operates .com)
│   ├── example.com.       ← Authoritative zone (your DNS provider: Route53, Cloudflare)
│   │   ├── api.example.com.  A 203.0.113.10
│   │   ├── www.example.com.  CNAME api.example.com.
│   │   └── _smtp.example.com. MX mail.example.com.
```

**DNS resolution flow:**

```
Browser                Recursive        Root NS      .com NS     Authoritative NS
  │                    Resolver         (.root)      (verisign)  (route53)
  │──api.example.com──►│
  │                    │──NS for .com?──►│
  │                    │◄──ns1.verisign──│
  │                    │──NS for example.com?──────►│
  │                    │◄──ns1.example.com.──────────│
  │                    │──A record api.example.com?──────────────►│
  │                    │◄──203.0.113.10 (TTL=300)────────────────│
  │◄──203.0.113.10─────│
  │                    │  [Cached for 300 seconds]
```

### DNS Record Types

| Record | Purpose | Example |
|--------|---------|---------|
| `A` | IPv4 address | `api.example.com. A 203.0.113.10` |
| `AAAA` | IPv6 address | `api.example.com. AAAA 2001:db8::1` |
| `CNAME` | Canonical name alias | `www.example.com. CNAME api.example.com.` |
| `MX` | Mail exchange with priority | `example.com. MX 10 mail.example.com.` |
| `TXT` | Arbitrary text (SPF, DKIM, verification) | `example.com. TXT "v=spf1 include:sendgrid.net ~all"` |
| `SRV` | Service location with port | `_grpc._tcp.example.com. SRV 0 5 50051 grpc.example.com.` |
| `PTR` | Reverse lookup (IP → name) | `10.113.0.203.in-addr.arpa. PTR api.example.com.` |
| `NS` | Name server for zone | `example.com. NS ns1.example.com.` |
| `SOA` | Start of authority (zone metadata) | Zone transfer and serial number |

**SRV records** are critical for gRPC service discovery. They encode host, port, priority, and weight, allowing clients to discover backend instances without hardcoded addresses.

### TTL and Service Deployments

TTL (Time To Live) determines how long a DNS record is cached by resolvers. A TTL of 300 (5 minutes) means after a DNS change, up to 5 minutes may pass before all clients see the new value.

**Deployment pattern for zero-downtime DNS changes:**
1. 24-48 hours before change: lower TTL to 60 seconds
2. Make the DNS change
3. Wait 60 seconds for all caches to expire
4. After traffic has shifted, raise TTL back to 300+

**Kubernetes services:** Kubernetes creates DNS entries automatically. A service `my-service` in namespace `default` is reachable at `my-service.default.svc.cluster.local`. The TTL for Kubernetes DNS entries is 30 seconds.

### Go DNS Resolution

Go provides two DNS resolver backends: the pure-Go resolver and the CGO resolver that delegates to the platform's `getaddrinfo`. The pure-Go resolver (`PreferGo: true`) gives you control over timeouts and the choice of DNS server, but critically it does not cache responses, every `net.Dial` or `http.Get` that requires a DNS lookup triggers a fresh UDP query. In a service making thousands of outbound requests per second, this creates measurable latency and load on your cluster's DNS infrastructure. The code below demonstrates a custom resolver, SRV lookups for service discovery, and a simple TTL-aware caching layer to address the no-cache problem.

```go
package dnsutil

import (
    "context"
    "net"
    "sync"
    "time"
)

// CustomResolver demonstrates using a specific DNS server with timeout.
// By default, Go uses the OS-configured resolver (/etc/resolv.conf).
// In containers, this is often CoreDNS or kube-dns.
func LookupWithCustomResolver(ctx context.Context, host string) ([]string, error) {
    r := &net.Resolver{
        PreferGo: true, // use Go's built-in DNS resolver instead of CGO
        Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
            d := net.Dialer{Timeout: 3 * time.Second}
            // Use Google's DNS-over-TCP for large responses (>512 bytes).
            // UDP is limited to 512 bytes (EDNS0 extends this to ~4KB but not universally supported).
            return d.DialContext(ctx, "tcp", "8.8.8.8:53")
        },
    }
    return r.LookupHost(ctx, host)
}

// LookupSRV performs an SRV record lookup for gRPC service discovery.
// Returns endpoints sorted by priority and weight.
func LookupSRV(ctx context.Context, service, proto, name string) ([]*net.SRV, error) {
    _, addrs, err := net.DefaultResolver.LookupSRV(ctx, service, proto, name)
    if err != nil {
        return nil, err
    }
    return addrs, nil
}

// CachingResolver wraps net.Resolver with a simple TTL cache.
// Go's built-in resolver does NOT cache DNS responses.
// In production, use a sidecar (like dnsmasq) or a library (like dnscache).
type CachingResolver struct {
    resolver *net.Resolver
    cache    sync.Map // key: string, value: *cacheEntry
}

type cacheEntry struct {
    addrs   []string
    expires time.Time
}

func (r *CachingResolver) LookupHost(ctx context.Context, host string) ([]string, error) {
    if v, ok := r.cache.Load(host); ok {
        entry := v.(*cacheEntry)
        if time.Now().Before(entry.expires) {
            return entry.addrs, nil
        }
    }

    addrs, err := r.resolver.LookupHost(ctx, host)
    if err != nil {
        return nil, err
    }

    // Cache with a 30-second TTL.
    // In production, use the actual TTL from the DNS response.
    r.cache.Store(host, &cacheEntry{
        addrs:   addrs,
        expires: time.Now().Add(30 * time.Second),
    })
    return addrs, nil
}
```

**Go DNS caching caveat:** Go's pure-Go DNS resolver (enabled by `PreferGo: true` or the `GODNS_OVERRIDE_LOCALHOST` environment variable) does not cache DNS responses. Each lookup sends a new DNS query. For services making DNS lookups on the hot path, this is a significant performance issue. Solutions:

1. Cache IPs at the application level with TTL-aware expiry
2. Use a local caching resolver (dnsmasq, unbound) in the pod
3. Use `dnscache` library which hooks into Go's dialer

---

### Junior → FAANG: DNS Behavior in Go and Why It Matters for Performance

Go's DNS resolution behavior has a specific consequence that surprises many engineers: Go does not cache DNS results by default. Every connection to a new host requires a DNS lookup, which adds a round-trip to the DNS resolver. For services that make many connections to the same external APIs, this DNS resolution overhead can be significant.

The `net.DefaultResolver` uses Go's pure-Go DNS implementation (by default) or the system's `getaddrinfo` (when CGO is enabled or when using the netgo build tag). The pure-Go implementation runs each DNS query as a goroutine, which is efficient for concurrent resolution but still performs a network round-trip for each uncached result.

DNS TTL values are the cache expiry time. A TTL of 60 seconds means that after 60 seconds, Go's resolver will re-query DNS for that hostname. For rapidly changing DNS records (like those used for load balancing or failover), short TTLs ensure clients pick up changes quickly. For stable services, longer TTLs reduce DNS resolution overhead.

### Senior @ FAANG: DNS at Scale and the Kubernetes DNS Architecture

At staff level, DNS is infrastructure, not just a naming service. In Kubernetes, CoreDNS is the cluster-internal DNS server that resolves service names (like `myapp.mynamespace.svc.cluster.local`) to ClusterIPs. At large cluster scales, CoreDNS becomes a bottleneck: if every pod is performing DNS lookups for every connection, the CoreDNS replicas receive enormous query rates.

The mitigation strategies at scale: NodeLocal DNSCache (a DaemonSet that runs a DNS cache on each node, so most DNS queries are answered from local cache without hitting CoreDNS), ndots configuration tuning (reducing the number of search domain lookups required for a given hostname), and application-level DNS caching (using `dnscache` or similar libraries to cache resolved IPs for connection pool reuse).

The ndots configuration is a subtle Kubernetes DNS performance issue. With `ndots:5` (the default), a lookup for `api.example.com` tries 5 fully-qualified variations before reaching the correct answer: `api.example.com.mynamespace.svc.cluster.local`, `api.example.com.svc.cluster.local`, `api.example.com.cluster.local`, `api.example.com.svc.cluster.local`, and finally `api.example.com.`. Each variation is a separate DNS query. Reducing ndots to 3 or using fully-qualified domain names (with a trailing dot) in service configurations eliminates unnecessary queries and measurably reduces DNS resolution latency for external domains.
