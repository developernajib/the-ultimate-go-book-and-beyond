## 2. Global Load Balancing - GeoDNS and Latency-Based Routing

GeoDNS routes DNS queries to the nearest healthy region. The Go application layer mirrors this logic for service-to-service calls and client-side routing decisions. The core idea is simple: when a user in Tokyo makes a request, they should be served by the Tokyo region rather than waiting for a round trip to Virginia. The `HaversineResolver` below calculates the great-circle distance between the user's IP-derived coordinates and each region's known location, then returns regions sorted nearest-first. For cases where geographic proximity does not equal network proximity (a common reality with submarine cable routing), the `LatencyRouter` tracks actual observed round-trip times and prefers the fastest region regardless of physical distance.

```go
// routing/geodns.go
package routing

import (
	"context"
	"math"
	"net"
    "slices"
	"sort"
	"sync"
	"time"

	"log/slog"

	"yourmodule/region"
)

// GeoResolver maps a client IP to an ordered list of regions, nearest first.
type GeoResolver interface {
	Resolve(ctx context.Context, clientIP net.IP) ([]*region.Region, error)
}

// HaversineResolver uses the haversine formula for great-circle distance.
// In production, replace clientIP→lat/lon lookup with MaxMind GeoIP2 or
// ip-api.com - here we accept pre-resolved coordinates for testability.
type HaversineResolver struct {
	registry *region.Registry
	geoLookup GeoLookupFunc
	logger    *slog.Logger
}

// GeoLookupFunc maps a client IP to (lat, lon). Inject MaxMind in production.
type GeoLookupFunc func(ip net.IP) (lat, lon float64, err error)

func NewHaversineResolver(
	registry *region.Registry,
	lookup GeoLookupFunc,
	logger *slog.Logger,
) *HaversineResolver {
	return &HaversineResolver{
		registry:  registry,
		geoLookup: lookup,
		logger:    logger,
	}
}

func (h *HaversineResolver) Resolve(ctx context.Context, clientIP net.IP) ([]*region.Region, error) {
	lat, lon, err := h.geoLookup(clientIP)
	if err != nil {
		h.logger.WarnContext(ctx, "geo lookup failed; falling back to health-ordered list",
			"ip", clientIP.String(), "err", err)
		return h.registry.Healthy(0.5), nil
	}

	type scored struct {
		r    *region.Region
		dist float64
	}

	healthy := h.registry.Healthy(0.5)
	scored_regions := make([]scored, 0, len(healthy))
	for _, r := range healthy {
		scored_regions = append(scored_regions, scored{
			r:    r,
			dist: haversine(lat, lon, r.Lat, r.Lon),
		})
	}

	sort.Slice(scored_regions, func(i, j int) bool {
		return scored_regions[i].dist < scored_regions[j].dist
	})

	result := make([]*region.Region, len(scored_regions))
	for i, s := range scored_regions {
		result[i] = s.r
	}
	return result, nil
}

// haversine returns the great-circle distance in kilometres between two points.
func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0 // Earth radius in km
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// LatencyRouter tracks observed round-trip times and prefers the fastest region.
type LatencyRouter struct {
	mu      sync.RWMutex
	samples map[string][]time.Duration // regionID → recent RTTs
	window  int
	logger  *slog.Logger
}

func NewLatencyRouter(window int, logger *slog.Logger) *LatencyRouter {
	return &LatencyRouter{
		samples: make(map[string][]time.Duration),
		window:  window,
		logger:  logger,
	}
}

// RecordRTT records an observed RTT for a region.
func (lr *LatencyRouter) RecordRTT(regionID string, d time.Duration) {
	lr.mu.Lock()
	defer lr.mu.Unlock()
	s := lr.samples[regionID]
	s = append(s, d)
	if len(s) > lr.window {
		s = s[len(s)-lr.window:]
	}
	lr.samples[regionID] = s
}

// P99 returns the P99 latency for a region.
func (lr *LatencyRouter) P99(regionID string) time.Duration {
	lr.mu.RLock()
	defer lr.mu.RUnlock()
	s := lr.samples[regionID]
	if len(s) == 0 {
		return time.Duration(math.MaxInt64)
	}
	sorted := make([]time.Duration, len(s))
	copy(sorted, s)
	slices.Sort(sorted)
	idx := int(math.Ceil(float64(len(sorted))*0.99)) - 1
	if idx < 0 {
		idx = 0
	}
	return sorted[idx]
}

// BestRegion returns the region ID with the lowest P99 latency from those provided.
func (lr *LatencyRouter) BestRegion(candidates []string) string {
	var best string
	var bestLatency = time.Duration(math.MaxInt64)
	for _, id := range candidates {
		if p99 := lr.P99(id); p99 < bestLatency {
			bestLatency = p99
			best = id
		}
	}
	return best
}
```

---

### Junior -> FAANG: GeoDNS, Anycast, and Why Physical Distance Does Not Equal Network Distance

The haversine formula computes the great-circle distance between two geographic points on a sphere. It is the correct formula for "how far apart are these two cities on Earth." But network latency does not follow great-circle distance. A user in Los Angeles connecting to Singapore may have lower latency than a user in Paris connecting to Singapore, because the cable routes between LA and Singapore are better provisioned than those between Paris and Singapore.

This is why the `LatencyRouter` exists alongside the `HaversineResolver`. Geographic proximity is a good first estimate, but observed RTT is the ground truth. In interviews, a strong answer to "how do you route users to the nearest region?" is: "Use GeoDNS for initial DNS resolution as a fast approximation, then track real observed round-trip times and prefer the lowest-latency region for service-to-service calls where you control the client."

The `GeoLookupFunc` injection point is worth noting for interviews. Injecting the geo-lookup function rather than calling MaxMind directly makes the resolver testable without network access. This is the dependency injection principle applied to I/O: the function under test does not care whether coordinates come from MaxMind, a mock, or a lookup table.

Practice: write a test for `HaversineResolver` that injects a `GeoLookupFunc` returning fixed coordinates and verifies that the nearest region is returned first.

### Senior @ FAANG: Routing Policy Ownership and Latency SLO Design

**Geo-routing is a policy, not just an algorithm.** The haversine resolver picks the nearest region. But "nearest" may not mean "cheapest" or "most compliant." A user in Germany should be routed to Frankfurt even if London has lower latency at the moment, because GDPR requires their data to stay in the EU. At L6, you recognize that the routing policy has at least three dimensions: proximity, compliance, and cost. These dimensions sometimes conflict, and resolving the conflict requires a policy document, not just an algorithm.

**P99 latency windows and EWMA trade-offs.** The `LatencyRouter` stores a sliding window of samples and computes P99. This is correct but has two operational concerns. First, window size determines how quickly the router adapts: a window of 100 samples adapts slowly to sudden latency changes, while a window of 10 adapts quickly but is noisy. Second, storing raw samples is O(window) memory per region. At hundreds of regions or thousands of client goroutines, an Exponentially Weighted Moving Average (EWMA) is more memory-efficient. A senior engineer chooses between window and EWMA based on the latency distribution shape and the acceptable adaptation lag, and documents that choice.

**DNS TTL management during failover.** GeoDNS failover speed is bounded by DNS TTL. Route 53 health checks can detect failure in 10 seconds, but if the DNS record has a 60-second TTL, some clients will continue sending traffic to the failed region for up to 60 more seconds. At staff level, you set TTLs deliberately: 30-60 seconds for health-checked records (balancing DNS cache efficiency against failover speed), and document this in the deployment runbook. Reducing TTL to 10 seconds increases DNS query volume and cost.

**Anycast versus GeoDNS is a buying decision at most companies.** Anycast routing requires BGP control, which means either owning your own AS or using a provider like Cloudflare or AWS Global Accelerator. GeoDNS is available via Route 53 or NS1 without BGP control. Most application teams use GeoDNS. Platform and infrastructure teams evaluate Anycast when failover time becomes a P0 business requirement. A bar-raiser interview question: "When would you choose Anycast over GeoDNS?" expects the answer to include BGP operational complexity, failover speed difference (Anycast sub-second versus GeoDNS 30-60 seconds), and cost.

**Latency-based routing and the thundering herd.** When a region fails and latency-based routing shifts all traffic to the next-closest region, that region may be temporarily undersized for the combined load. A senior engineer provisions standby regions at 120-150% of their expected normal capacity specifically to absorb this surge during failover. This capacity headroom should be captured in the SLA design document, not left implicit.
