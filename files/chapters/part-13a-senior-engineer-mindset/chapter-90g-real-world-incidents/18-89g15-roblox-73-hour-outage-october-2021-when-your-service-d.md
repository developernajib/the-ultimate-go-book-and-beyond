## 90G.15 Roblox 73-Hour Outage (October 2021) - When Your Service Discovery Eats Itself

*"The core issue was that our internal service discovery system, built on Consul and backed by BoltDB, entered a
pathological state under a specific load pattern that caused write amplification and eventual disk exhaustion."*
 -  Roblox Engineering Blog

### The Incident

On October 28, 2021, Roblox - the gaming platform serving over 50 million daily active users, primarily children
and teenagers - went completely offline. It stayed offline for **73 hours** - over three full days. This was not
a brief blip or a degraded-service event. It was a total, sustained, complete outage of one of the world's largest
gaming platforms during its peak usage period.

The root cause was a perfect storm involving multiple interacting systems:

1. **HashiCorp Consul** was used as Roblox's service discovery backbone
2. Consul used **BoltDB** as its underlying storage engine
3. A new internal streaming feature increased the number of Consul watches (subscriptions) significantly
4. Under the increased load, BoltDB's write patterns caused **write amplification** - each logical write
   triggered many more physical disk writes than expected
5. The write amplification exhausted disk I/O bandwidth on Consul cluster nodes
6. When Consul became slow, dependent services increased their retry rates, creating a **thundering herd**
7. The thundering herd made Consul even slower, creating a positive feedback loop
8. Roblox's attempts to scale up Consul by adding more nodes actually made the problem worse, because
   BoltDB's write amplification scaled with cluster size
9. The only solution was to **replace BoltDB with a different storage engine**, which required code changes
   to Consul itself - a fix that took three days to implement, test, and deploy

### Timeline Reconstruction

The sequence of events below reveals how a single storage-engine pathology snowballed from elevated write latency at 15:00 UTC into a three-day total outage, roughly one hour of slow degradation before complete failure, then 72 more hours before resolution. Particularly notable is the 17:00-20:00 window where the intuitive response of adding Consul nodes was attempted and proven to make the situation measurably worse.

```
Oct 28, 15:00 UTC   Performance degradation begins (Consul write latency increasing)
Oct 28, 16:00 UTC   Service discovery failures cascade to game servers
Oct 28, 16:30 UTC   Complete platform outage - 50M users cannot play
Oct 28, 17:00 UTC   Engineering identifies Consul as the bottleneck
Oct 28, 18:00 UTC   Attempt #1: Scale Consul cluster (adds more nodes)
Oct 28, 20:00 UTC   Scaling makes it WORSE - more nodes = more replication writes
Oct 29, 02:00 UTC   Root cause identified: BoltDB write amplification
Oct 29, 06:00 UTC   Attempt #2: Tune BoltDB parameters - insufficient
Oct 29, 12:00 UTC   Decision: Must replace storage engine in Consul
Oct 29, 18:00 UTC   HashiCorp engineers join to help with Consul modifications
Oct 30, 06:00 UTC   Modified Consul with new storage backend ready for testing
Oct 30, 12:00 UTC   Testing in staging environment
Oct 30, 18:00 UTC   Phased deployment begins
Oct 31, 16:00 UTC   Full service restored - 73 hours after outage began
```

### Architecture Diagram: The Write Amplification Death Spiral

The diagram below shows how BoltDB's write amplification factor of roughly 10x, applied independently on every Consul node, saturated disk I/O across the entire cluster simultaneously. The feedback loop is depicted at the bottom: once Consul slowed, dependent services increased their retry frequency, which generated additional Consul writes, which in turn deepened the I/O saturation, a self-reinforcing cycle with no natural break condition.

```
┌─────────────────────────────────────────────────────────────────────┐
│                  ROBLOX CONSUL DEATH SPIRAL                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────┐     ┌──────────────────┐                      │
│  │  Game Servers    │      │  Backend Services │                    │
│  │  (thousands)     │      │  (hundreds)       │                    │
│  └────────┬─────────┘     └────────┬─────────┘                      │
│           │ Consul watches          │ Service registration          │
│           │ (subscriptions)         │                               │
│           ▼                         ▼                               │
│  ┌─────────────────────────────────────────────┐                    │
│  │          CONSUL CLUSTER (Raft consensus)    │                    │
│  │                                             │                    │
│  │  Node 1 ──Raft──► Node 2 ──Raft──► Node 3   │                    │
│  │    │                  │                     │ │                  │
│  │    ▼                  ▼                 ▼   │                    │
│  │  BoltDB            BoltDB            BoltDB │                    │
│  │  ┌─────┐          ┌─────┐          ┌─────┐  │                    │
│  │  │Write│          │Write│          │Write│  │                    │
│  │  │Amp  │          │Amp  │          │Amp  │  │                    │
│  │  │ 10x │          │ 10x │          │ 10x │  │                    │
│  │  └──┬──┘          └──┬──┘          └──┬──┘  │                    │
│  │     │                │                │     │                    │
│  │     ▼                ▼                ▼     │                    │
│  │  ┌───────────────────────────────────────┐  │                    │
│  │  │     DISK I/O SATURATED (100%)         │  │                    │
│  │  └───────────────────────────────────────┘  │                    │
│  └─────────────────────────────────────────────┘                    │
│           │                                                         │
│           │ Consul becomes slow                                     │
│           ▼                                                         │
│  ┌─────────────────────────────────────────────┐                    │
│  │  Services retry more frequently             │                    │
│  │  → More Consul writes → More BoltDB writes  │                    │
│  │  → More disk I/O → Consul even slower       │                    │
│  │  → POSITIVE FEEDBACK LOOP (death spiral)    │                    │
│  └─────────────────────────────────────────────┘                    │
│                                                                     │
│  SCALING PARADOX: Adding Consul nodes = MORE Raft replication       │
│  = MORE BoltDB writes = MORE disk I/O = WORSE performance           │
└─────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Write Amplification Monitor and Circuit Breaker

The code below provides two complementary defenses against a Roblox-style failure. `WriteAmpMonitor` polls disk I/O stats on a configurable interval and fires a callback whenever the physical-to-logical write ratio or disk utilization crosses a threshold, giving operators an early warning before saturation is reached. `ServiceDiscoveryCircuitBreaker` wraps every Consul lookup with open/half-open/closed state transitions so that a degraded service discovery layer does not trigger a thundering herd, falling back to cached endpoints instead of flooding Consul with retries.

```go
package writeamp

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// DiskIOStats captures I/O metrics for a storage engine.
type DiskIOStats struct {
	LogicalWrites  int64 // writes requested by the application
	PhysicalWrites int64 // actual writes to disk (includes amplification)
	DiskUtilPct    float64
	WriteLatency   time.Duration
	Timestamp      time.Time
}

// WriteAmplificationRatio returns the ratio of physical to logical writes.
func (d DiskIOStats) WriteAmplificationRatio() float64 {
	if d.LogicalWrites == 0 {
		return 0
	}
	return float64(d.PhysicalWrites) / float64(d.LogicalWrites)
}

// WriteAmpMonitor detects dangerous write amplification patterns.
type WriteAmpMonitor struct {
	maxAmplification float64
	maxDiskUtil      float64
	checkInterval    time.Duration
	statsFn          func(ctx context.Context) (*DiskIOStats, error)
	onThreshold      func(stats *DiskIOStats) // called when thresholds breached
	logger           *slog.Logger
	running          atomic.Bool
}

// NewWriteAmpMonitor creates a monitor with the given thresholds.
func NewWriteAmpMonitor(
	maxAmplification float64,
	maxDiskUtil float64,
	checkInterval time.Duration,
	statsFn func(ctx context.Context) (*DiskIOStats, error),
	onThreshold func(stats *DiskIOStats),
	logger *slog.Logger,
) *WriteAmpMonitor {
	return &WriteAmpMonitor{
		maxAmplification: maxAmplification,
		maxDiskUtil:      maxDiskUtil,
		checkInterval:    checkInterval,
		statsFn:          statsFn,
		onThreshold:      onThreshold,
		logger:           logger,
	}
}

// Run starts the monitoring loop. Returns when context is canceled.
func (w *WriteAmpMonitor) Run(ctx context.Context) error {
	w.running.Store(true)
	defer w.running.Store(false)

	ticker := time.NewTicker(w.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			stats, err := w.statsFn(ctx)
			if err != nil {
				w.logger.Error("failed to collect disk stats", "error", err)
				continue
			}

			ratio := stats.WriteAmplificationRatio()
			w.logger.Debug("disk I/O stats",
				"write_amp_ratio", fmt.Sprintf("%.2f", ratio),
				"disk_util_pct", fmt.Sprintf("%.1f", stats.DiskUtilPct),
				"write_latency", stats.WriteLatency,
			)

			if ratio > w.maxAmplification || stats.DiskUtilPct > w.maxDiskUtil {
				w.logger.Warn("write amplification threshold breached",
					"ratio", ratio,
					"max_ratio", w.maxAmplification,
					"disk_util", stats.DiskUtilPct,
					"max_util", w.maxDiskUtil,
				)
				w.onThreshold(stats)
			}
		}
	}
}

// ServiceDiscoveryCircuitBreaker prevents thundering herd on slow Consul.
type ServiceDiscoveryCircuitBreaker struct {
	mu              sync.RWMutex
	state           CircuitState
	failureCount    int64
	successCount    int64
	lastStateChange time.Time
	halfOpenMax     int64
	failureThreshold int64
	resetTimeout    time.Duration
	cachedServices  map[string][]string
	logger          *slog.Logger
}

type CircuitState int

const (
	CircuitClosed CircuitState = iota
	CircuitOpen
	CircuitHalfOpen
)

func (s CircuitState) String() string {
	switch s {
	case CircuitClosed:
		return "closed"
	case CircuitOpen:
		return "open"
	case CircuitHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// NewServiceDiscoveryCircuitBreaker creates a circuit breaker for Consul calls.
func NewServiceDiscoveryCircuitBreaker(
	failureThreshold int64,
	resetTimeout time.Duration,
	logger *slog.Logger,
) *ServiceDiscoveryCircuitBreaker {
	return &ServiceDiscoveryCircuitBreaker{
		state:            CircuitClosed,
		failureThreshold: failureThreshold,
		resetTimeout:     resetTimeout,
		halfOpenMax:      3,
		cachedServices:   make(map[string][]string),
		lastStateChange:  time.Now(),
		logger:           logger,
	}
}

// Lookup resolves a service name to endpoints, using the circuit breaker.
func (cb *ServiceDiscoveryCircuitBreaker) Lookup(
	ctx context.Context,
	serviceName string,
	consulLookup func(ctx context.Context, name string) ([]string, error),
) ([]string, error) {
	cb.mu.RLock()
	state := cb.state
	cb.mu.RUnlock()

	switch state {
	case CircuitOpen:
		if time.Since(cb.lastStateChange) > cb.resetTimeout {
			cb.transition(CircuitHalfOpen)
			return cb.tryLookup(ctx, serviceName, consulLookup)
		}
		return cb.getCached(serviceName)

	case CircuitHalfOpen:
		if atomic.LoadInt64(&cb.successCount) >= cb.halfOpenMax {
			cb.transition(CircuitClosed)
		}
		return cb.tryLookup(ctx, serviceName, consulLookup)

	default:
		return cb.tryLookup(ctx, serviceName, consulLookup)
	}
}

func (cb *ServiceDiscoveryCircuitBreaker) tryLookup(
	ctx context.Context,
	serviceName string,
	consulLookup func(ctx context.Context, name string) ([]string, error),
) ([]string, error) {
	endpoints, err := consulLookup(ctx, serviceName)
	if err != nil {
		failures := atomic.AddInt64(&cb.failureCount, 1)
		if failures >= cb.failureThreshold {
			cb.transition(CircuitOpen)
		}
		cached, cacheErr := cb.getCached(serviceName)
		if cacheErr != nil {
			return nil, fmt.Errorf("consul lookup failed and no cache: %w", err)
		}
		cb.logger.Warn("using cached service endpoints",
			"service", serviceName, "cached_count", len(cached))
		return cached, nil
	}

	atomic.AddInt64(&cb.successCount, 1)
	atomic.StoreInt64(&cb.failureCount, 0)
	cb.mu.Lock()
	cb.cachedServices[serviceName] = endpoints
	cb.mu.Unlock()
	return endpoints, nil
}

func (cb *ServiceDiscoveryCircuitBreaker) transition(newState CircuitState) {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	oldState := cb.state
	cb.state = newState
	cb.lastStateChange = time.Now()
	atomic.StoreInt64(&cb.failureCount, 0)
	atomic.StoreInt64(&cb.successCount, 0)
	cb.logger.Info("circuit breaker state change",
		"from", oldState.String(), "to", newState.String())
}

func (cb *ServiceDiscoveryCircuitBreaker) getCached(serviceName string) ([]string, error) {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	endpoints, ok := cb.cachedServices[serviceName]
	if !ok || len(endpoints) == 0 {
		return nil, fmt.Errorf("no cached endpoints for service %s", serviceName)
	}
	return endpoints, nil
}
```

### Key Lessons for Go Engineers

1. **Understand your storage engine's write characteristics** - BoltDB is an excellent embedded database for
   read-heavy workloads but suffers from write amplification under high write loads. Know the I/O profile
   of every storage engine you depend on.
2. **Scaling can make things worse** - adding nodes to a Raft-based consensus cluster increases replication
   writes. More nodes = more writes = more amplification. Always model the I/O impact of scaling decisions.
3. **Service discovery is the most critical dependency** - when it fails, everything fails. Cache service
   discovery results locally and implement circuit breakers to prevent thundering herds.
4. **Positive feedback loops are the most dangerous failure mode** - slow service leads to more retries leads
   to more load leads to slower service. Circuit breakers are the primary defense against cascading feedback loops.

### Exercises

1. Implement a **storage engine benchmarker** that measures write amplification ratios under increasing load
   for different Go embedded databases (BoltDB, Badger, Pebble).
2. Build a **Consul health dashboard** that tracks write amplification, disk utilization, Raft replication
   lag, and watch count - the four metrics that would have provided early warning at Roblox.
3. Design a **service mesh fallback** that maintains a gossip-based peer discovery protocol as a backup
   when centralized service discovery (Consul/etcd) becomes unavailable.

---

### Junior → FAANG: Write Amplification and Positive Feedback Loops as Interview Topics

The Roblox incident introduces two concepts that appear frequently in system design interviews. Write amplification is the ratio of actual disk writes to logical writes requested by the application. In BoltDB's copy-on-write B-tree, a single logical write causes the entire page chain to be rewritten, so amplification grows with tree depth. Interviewers test this concept when asking about database selection: "Why would you choose LevelDB over BoltDB for a write-heavy workload?" The correct answer references write amplification, not just "LevelDB is faster." The second concept is positive feedback in failure modes. When Consul slowed down, services increased their retry rate, which increased load on Consul, which made it slower. This is a distributed system equivalent of a thermal runaway. Circuit breakers interrupt the feedback loop by stopping retries when a dependency is degraded. Add the `ServiceDiscoveryCircuitBreaker` in this section to your portfolio: it demonstrates knowledge of both the failure mode and its defense in working code.

### Senior @ FAANG: Storage Engine Selection as an ADR and Service Discovery Resilience as a Platform Standard

At L6, the Roblox incident surfaces two platform-level decisions that belong in Architecture Decision Records. The first is storage engine selection. Choosing BoltDB for Consul's backing store was appropriate when Roblox had tens of thousands of service instances. At millions of instances with thousands of concurrent watches, the write amplification became a capacity wall. The ADR for storage engine selection must include the I/O profile at 10x current scale, the write amplification ratio at that scale, and the migration path if the engine cannot keep up. An ADR written only for current load is incomplete. At staff level, you are responsible for making sure your ADRs account for the next two to three years of growth.

The second platform decision is service discovery resilience. Consul is the single dependency whose failure takes down all other service-to-service communication. At L6, you treat it like a tier-0 dependency: redundant deployment across failure domains, circuit-broken clients with local cache fallback (the pattern in this section), and a tested degraded-mode operating procedure where services continue to function on stale endpoint caches for a defined window (30 minutes is a common target). The "tested" qualifier is critical. Roblox's 73-hour outage was extended by recovery procedures that were not verified before the incident. At staff level, your quarterly chaos engineering calendar includes a Consul failure drill: intentionally degrade Consul in a staging environment and verify that every dependent service degrades gracefully on cached endpoints rather than failing immediately. The drill produces a pass/fail report. Failing services are tracked as reliability debt and blocked from new feature work until the circuit breaker and cache fallback are implemented.

