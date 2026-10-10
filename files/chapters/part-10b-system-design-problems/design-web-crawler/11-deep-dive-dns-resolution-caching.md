## Deep Dive: DNS Resolution Caching

At 10,000 pages per second, making a fresh DNS lookup for every request would be a major bottleneck. A cold DNS query takes tens of milliseconds, and public DNS resolvers would quickly rate-limit your crawler. The DNS cache stores resolved IP addresses in memory with a TTL, turning the vast majority of DNS lookups into sub-microsecond hash table reads. At a 99% hit rate, 10,000 pages per second becomes roughly 100 DNS queries per second, which is a load a resolver will tolerate.

Budget the memory honestly. Ten million entries of `map[string]*DNSEntry`, with a typical hostname key and one or two A records, measures at about 1.5GB on a 64-bit heap, roughly 150 bytes per domain once you count the map buckets, the string headers and bytes, the entry struct, and the slice backing arrays. Estimates in the 500MB range assume about 50 bytes per domain, which is not reachable with this structure. If you need it smaller, that is an argument for interning hostnames and storing packed 4-byte IPs in a fixed array instead of `[]string`, not an argument for optimism.

This cache is also more than a latency optimization, and that is easy to miss. Politeness limits are ultimately about not overloading a *server*, and shared hosting and CDNs put many hostnames behind one IP. The resolved address is what lets the rate limiter key on the machine you are actually talking to rather than the name you happened to look up.

Three details in the implementation matter more than the map itself. **Never cache a failed lookup as if it were a result.** Storing the `nil` IP list from a failed resolve and returning the cached value later hands the caller an empty list with a nil error, which is the worst of both worlds: a transient blip silently blackholes the domain for the full TTL, and no error is raised to explain why. Errors get their own short negative TTL, or none at all. **Honor the record's TTL, not a constant.** `net.Resolver.LookupHost` does not expose the record TTL, so a fixed value is a stand-in that will re-resolve a 24-hour record every 5 minutes and hold a 30-second record for 5 minutes. When DNS TTLs matter, use a resolver library that surfaces them. **Collapse concurrent misses.** At this throughput, a popular domain's entry expiring means hundreds of goroutines resolve the same name simultaneously, so a single-flight guard turns that stampede back into one query.

```go
package dns

import (
	"context"
	"net"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	dnsTTL    = 5 * time.Minute  // stand-in: LookupHost does not expose record TTLs
	dnsNegTTL = 10 * time.Second // remember failures only briefly
)

// At 10K pages/sec, DNS per request is a bottleneck.
// Without a cache the resolver becomes the throughput ceiling.
type DNSCache struct {
	cache    map[string]*DNSEntry
	mu       sync.RWMutex
	resolver *net.Resolver
	group    singleflight.Group // collapses concurrent misses for one domain
}

type DNSEntry struct {
	IPs       []string
	ExpiresAt time.Time
	Err       error // non-nil for a negatively cached failure
}

func NewDNSCache(resolver *net.Resolver) *DNSCache {
	return &DNSCache{cache: make(map[string]*DNSEntry), resolver: resolver}
}

func (d *DNSCache) Resolve(ctx context.Context, domain string) ([]string, error) {
	if entry, ok := d.load(domain); ok {
		// A cached failure is replayed as a failure. Never as an empty success:
		// returning (nil, nil) here would blackhole the domain for a full TTL
		// while telling every caller that nothing went wrong.
		if entry.Err != nil {
			return nil, entry.Err
		}
		return entry.IPs, nil
	}

	// singleflight: one in-flight lookup per domain, however many goroutines ask.
	v, err, _ := d.group.Do(domain, func() (interface{}, error) {
		ips, err := d.resolver.LookupHost(ctx, domain)

		entry := &DNSEntry{IPs: ips, Err: err, ExpiresAt: time.Now().Add(dnsTTL)}
		if err != nil {
			entry.ExpiresAt = time.Now().Add(dnsNegTTL)
		}

		d.mu.Lock()
		d.cache[domain] = entry
		d.mu.Unlock()

		return ips, err
	})
	if err != nil {
		return nil, err
	}
	return v.([]string), nil
}

func (d *DNSCache) load(domain string) (*DNSEntry, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	entry, ok := d.cache[domain]
	if !ok || time.Now().After(entry.ExpiresAt) {
		return nil, false
	}
	return entry, true
}

// EvictExpired reclaims expired entries. Call it from a ticker: the map has no
// bound of its own, and the crawler meets an endless supply of new hostnames.
func (d *DNSCache) EvictExpired() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	now := time.Now()
	for domain, entry := range d.cache {
		if now.After(entry.ExpiresAt) {
			delete(d.cache, domain)
			n++
		}
	}
	return n
}

// ~10M domains ≈ 1.5GB measured (about 150 bytes/domain)
// 99% hit rate: 10K pages/sec -> only 100 DNS lookups/sec
```

---
