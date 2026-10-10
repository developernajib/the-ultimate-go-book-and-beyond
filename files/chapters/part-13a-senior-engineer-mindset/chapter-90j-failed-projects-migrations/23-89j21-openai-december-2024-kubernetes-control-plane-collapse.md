## 90J.21 OpenAI December 2024: Kubernetes Control Plane Collapse

### The Incident

On December 11, 2024, OpenAI experienced a major outage that took ChatGPT, the API, and Sora offline for
approximately 4 hours. The outage affected all products simultaneously because they shared a common
Kubernetes control plane. The root cause was a telemetry service that overwhelmed the Kubernetes API server,
combined with a circular DNS dependency that prevented recovery.

### What Went Wrong

OpenAI ran their services on large Kubernetes clusters. A new telemetry collection service was deployed that
queried the Kubernetes API to discover pod endpoints for metric scraping. The service worked correctly during
testing with small clusters but had a flaw: it listed all pods in the cluster every 30 seconds, and for each
pod, made additional API calls to fetch labels, annotations, and status. In a cluster with 15,000 pods, this
created approximately 50,000 API calls per 30-second cycle.

The failure chain:

1. **T+0**: The telemetry service scaled up to handle increased observability requirements. More replicas
   meant more parallel API queries
2. **T+5 minutes**: Kubernetes API server CPU saturated. etcd, the backing store, began experiencing write
   latency spikes as the API server's watch cache invalidation created excessive etcd traffic
3. **T+8 minutes**: API server response times exceeded 30 seconds. Controller manager and scheduler could
   not process updates. New pod scheduling stopped
4. **T+10 minutes**: CoreDNS pods, which run inside the same Kubernetes cluster, could not renew their
   endpoints with the API server. DNS resolution began failing
5. **T+12 minutes**: Services that depended on DNS for service discovery (virtually everything) started
   failing. This included the telemetry service itself, which should have been the circuit breaker
6. **T+15 minutes**: The circular dependency was now complete: the API server was overloaded by the telemetry
   service, DNS was failing because CoreDNS pods could not reach the API server, and the telemetry service
   could not be stopped because kubectl (which depends on API server and DNS) was also failing
7. **T+30 minutes**: Engineers gained direct access to etcd and manually identified the source of excessive
   API calls
8. **T+1 hour**: Telemetry service pods manually killed through direct container runtime commands (bypassing
   Kubernetes API)
9. **T+2 hours**: API server recovered, but DNS cache propagation and service reconnection took additional time
10. **T+4 hours**: Full recovery

### The Circular Dependency Problem

The deepest problem was that the Kubernetes control plane was a single point of failure for everything,
including the tools needed to manage the control plane itself:

- **To debug**: you need `kubectl`, which needs the API server
- **To see logs**: you need the logging pipeline, which runs on Kubernetes
- **To resolve service names**: you need CoreDNS, which runs on Kubernetes
- **To stop the offending service**: you need the API server it is overloading

This is the distributed systems equivalent of sawing off the branch you are sitting on.

### Go Implementation: Control Plane Circuit Breaker

The OpenAI incident exposes two independent design failures: an API client with no self-throttling, and a control plane with no load-shedding. The circuit breaker below addresses both sides. On the client side, it tracks real-time RPS, active concurrency, and observed latency, tripping open when any threshold is breached so a single misbehaving consumer cannot saturate the API server. On the server side, the `APILoadShedder` enforces priority queues at the admission layer: scheduling and health-check traffic (P0) is never shed, while telemetry and event-list calls (P3) are dropped first as utilization climbs. The `IndependentDNSResolver` breaks the circular dependency entirely by hard-coding critical service IPs so that `kubectl` and the management plane remain reachable even when CoreDNS pods cannot renew their endpoints.

```go
package controlplane

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// -----------------------------------------------------------------------
// Kubernetes API rate limiter and circuit breaker
// -----------------------------------------------------------------------

// APICircuitBreaker protects the Kubernetes API server from being
// overwhelmed by any single client. It tracks request rates and
// latencies, and trips when thresholds are exceeded.
type APICircuitBreaker struct {
	state          atomic.Int32
	maxRPS         float64
	maxConcurrent  int
	tripLatency    time.Duration
	resetTimeout   time.Duration
	halfOpenMax    int
	mu             sync.Mutex
	requestCount   atomic.Int64
	activeRequests atomic.Int32
	windowStart    time.Time
	lastTrip       time.Time
	latencies      []time.Duration
	latencyIdx     int
	latencyBuf     int
	onTrip         func(reason string)
}

// CircuitState represents the current state of the circuit breaker.
const (
	StateClosed   int32 = iota // normal operation
	StateOpen                  // blocking requests
	StateHalfOpen              // testing recovery
)

// NewAPICircuitBreaker creates a circuit breaker configured to protect
// the Kubernetes API server.
func NewAPICircuitBreaker(maxRPS float64, maxConcurrent int, tripLatency time.Duration) *APICircuitBreaker {
	cb := &APICircuitBreaker{
		maxRPS:        maxRPS,
		maxConcurrent: maxConcurrent,
		tripLatency:   tripLatency,
		resetTimeout:  30 * time.Second,
		halfOpenMax:   5,
		windowStart:   time.Now(),
		latencies:     make([]time.Duration, 100),
		latencyBuf:    100,
		onTrip:        func(reason string) { fmt.Printf("[CIRCUIT BREAKER] TRIPPED: %s\n", reason) },
	}
	cb.state.Store(StateClosed)
	return cb
}

// Execute wraps a Kubernetes API call with circuit breaker protection.
// If the circuit is open, the call is rejected immediately. If the
// circuit is closed, the call proceeds with rate limiting and latency
// monitoring.
func (cb *APICircuitBreaker) Execute(ctx context.Context, name string, fn func(ctx context.Context) error) error {
	state := cb.state.Load()

	switch state {
	case StateOpen:
		// Check if reset timeout has elapsed.
		cb.mu.Lock()
		if time.Since(cb.lastTrip) > cb.resetTimeout {
			cb.state.Store(StateHalfOpen)
			cb.mu.Unlock()
			fmt.Printf("[CIRCUIT BREAKER] Transitioning to half-open for: %s\n", name)
		} else {
			cb.mu.Unlock()
			return fmt.Errorf("circuit breaker open, rejecting: %s", name)
		}

	case StateHalfOpen:
		// Allow limited requests through to test recovery.
		if cb.activeRequests.Load() >= int32(cb.halfOpenMax) {
			return fmt.Errorf("circuit breaker half-open, at max test requests: %s", name)
		}
	}

	// Check concurrency limit.
	current := cb.activeRequests.Add(1)
	defer cb.activeRequests.Add(-1)

	if int(current) > cb.maxConcurrent {
		cb.trip(fmt.Sprintf("concurrency limit exceeded: %d > %d", current, cb.maxConcurrent))
		return fmt.Errorf("concurrency limit exceeded for: %s", name)
	}

	// Check rate limit.
	cb.requestCount.Add(1)
	cb.mu.Lock()
	elapsed := time.Since(cb.windowStart)
	if elapsed >= time.Second {
		rate := float64(cb.requestCount.Load()) / elapsed.Seconds()
		if rate > cb.maxRPS {
			cb.mu.Unlock()
			cb.trip(fmt.Sprintf("rate limit exceeded: %.1f > %.1f RPS", rate, cb.maxRPS))
			return fmt.Errorf("rate limit exceeded for: %s", name)
		}
		cb.requestCount.Store(0)
		cb.windowStart = time.Now()
	}
	cb.mu.Unlock()

	// Execute the actual API call with latency measurement.
	start := time.Now()
	err := fn(ctx)
	latency := time.Since(start)

	// Record latency.
	cb.mu.Lock()
	cb.latencies[cb.latencyIdx%cb.latencyBuf] = latency
	cb.latencyIdx++
	cb.mu.Unlock()

	// Check if latency exceeds threshold.
	if latency > cb.tripLatency {
		cb.trip(fmt.Sprintf("latency %v exceeds threshold %v for: %s",
			latency, cb.tripLatency, name))
		return err
	}

	// If half-open and request succeeded, close the circuit.
	if cb.state.Load() == StateHalfOpen && err == nil {
		cb.state.Store(StateClosed)
		fmt.Printf("[CIRCUIT BREAKER] Circuit closed - recovery confirmed for: %s\n", name)
	}

	return err
}

func (cb *APICircuitBreaker) trip(reason string) {
	cb.state.Store(StateOpen)
	cb.mu.Lock()
	cb.lastTrip = time.Now()
	cb.mu.Unlock()
	cb.onTrip(reason)
}

// State returns the current circuit breaker state.
func (cb *APICircuitBreaker) State() string {
	switch cb.state.Load() {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// -----------------------------------------------------------------------
// DNS independence layer
// -----------------------------------------------------------------------

// IndependentDNSResolver provides DNS resolution that does not depend
// on the Kubernetes control plane. This breaks the circular dependency
// where DNS resolution requires Kubernetes, which requires DNS.
type IndependentDNSResolver struct {
	staticHosts   map[string]string // hostname -> IP for critical services
	externalDNS   []string          // external DNS servers (e.g., 8.8.8.8)
	cache         map[string]cachedEntry
	mu            sync.RWMutex
	cacheTTL      time.Duration
}

type cachedEntry struct {
	address   string
	expiresAt time.Time
}

// NewIndependentDNSResolver creates a resolver with static mappings
// for critical infrastructure and external DNS as fallback.
func NewIndependentDNSResolver(staticHosts map[string]string, externalDNS []string) *IndependentDNSResolver {
	return &IndependentDNSResolver{
		staticHosts: staticHosts,
		externalDNS: externalDNS,
		cache:       make(map[string]cachedEntry),
		cacheTTL:    5 * time.Minute,
	}
}

// Resolve returns the IP address for a hostname, using static mappings
// first, then cache, then external DNS - never depending on CoreDNS.
func (r *IndependentDNSResolver) Resolve(hostname string) (string, error) {
	// Priority 1: Static mappings for critical services.
	if addr, ok := r.staticHosts[hostname]; ok {
		return addr, nil
	}

	// Priority 2: Local cache.
	r.mu.RLock()
	if entry, ok := r.cache[hostname]; ok && time.Now().Before(entry.expiresAt) {
		r.mu.RUnlock()
		return entry.address, nil
	}
	r.mu.RUnlock()

	// Priority 3: External DNS resolution.
	for _, dnsServer := range r.externalDNS {
		addr, err := r.queryExternal(hostname, dnsServer)
		if err == nil {
			r.mu.Lock()
			r.cache[hostname] = cachedEntry{
				address:   addr,
				expiresAt: time.Now().Add(r.cacheTTL),
			}
			r.mu.Unlock()
			return addr, nil
		}
	}

	return "", fmt.Errorf("failed to resolve %s via all methods", hostname)
}

func (r *IndependentDNSResolver) queryExternal(_ string, _ string) (string, error) {
	// In production, this would use net.Resolver with a custom dialer
	// pointed at the external DNS server.
	return "", fmt.Errorf("not implemented in example")
}

// -----------------------------------------------------------------------
// API server load shedding
// -----------------------------------------------------------------------

// APILoadShedder sits in front of the Kubernetes API server (or is
// integrated into the API client) to shed load when the control plane
// is under pressure. It prioritizes critical operations (scheduling,
// health checks) over non-critical ones (telemetry, logging).
type APILoadShedder struct {
	priorities map[string]RequestPriority
	maxLoad    int
	current    atomic.Int32
	mu         sync.RWMutex
}

// RequestPriority determines which requests are shed first under load.
type RequestPriority int

const (
	PriorityCritical RequestPriority = iota // scheduling, health checks
	PriorityHigh                             // service discovery, config
	PriorityNormal                           // general queries
	PriorityLow                              // telemetry, logging, audit
)

// NewAPILoadShedder creates a load shedder with the given capacity.
func NewAPILoadShedder(maxConcurrent int) *APILoadShedder {
	return &APILoadShedder{
		maxLoad: maxConcurrent,
		priorities: map[string]RequestPriority{
			"pods/status":     PriorityCritical,
			"nodes":           PriorityCritical,
			"endpoints":       PriorityHigh,
			"configmaps":      PriorityHigh,
			"pods":            PriorityNormal,
			"pods/list-all":   PriorityLow,
			"metrics":         PriorityLow,
			"events":          PriorityLow,
		},
	}
}

// Allow determines whether a request should be admitted based on its
// priority and current load. Under heavy load, low-priority requests
// are shed first.
func (s *APILoadShedder) Allow(resource string) bool {
	current := int(s.current.Load())
	priority := s.getPriority(resource)

	// Load thresholds: at what load percentage do we start shedding
	// each priority level?
	switch {
	case current > s.maxLoad*90/100:
		// Above 90%: only critical requests allowed
		return priority == PriorityCritical
	case current > s.maxLoad*75/100:
		// Above 75%: shed low priority
		return priority <= PriorityNormal
	case current > s.maxLoad*50/100:
		// Above 50%: shed only lowest priority
		return priority <= PriorityHigh
	default:
		return true
	}
}

// Track increments the active request counter.
func (s *APILoadShedder) Track() func() {
	s.current.Add(1)
	return func() { s.current.Add(-1) }
}

func (s *APILoadShedder) getPriority(resource string) RequestPriority {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.priorities[resource]; ok {
		return p
	}
	return PriorityNormal
}
```

**The Lesson**: Never run critical infrastructure control plane dependencies (DNS, service discovery, secrets
management) on the same platform they are required to manage. The circular dependency between Kubernetes, CoreDNS,
and the services running on Kubernetes means that a control plane failure can prevent its own recovery. Always
maintain an out-of-band management path - static DNS entries, direct IP access to the API server, and circuit
breakers on API clients that prevent any single consumer from overwhelming the control plane.

---

### Junior → FAANG: Control Plane Independence and Circular Dependencies as Interview Topics

The OpenAI Kubernetes incident is the interview answer to "what is the danger of running your control plane on the same infrastructure it manages?" When Kubernetes, CoreDNS, and service discovery all depend on each other, a control plane degradation creates a circular failure: services cannot look up the Kubernetes API server, the Kubernetes API server cannot start new CoreDNS pods, and CoreDNS cannot resolve the API server address. For FAANG interviews, the control plane independence principle is: every critical infrastructure component must have an out-of-band access path that does not depend on the component it manages. For Kubernetes, this means: direct IP access to the API server (not via DNS), static DNS entries for the API server and core services, and circuit breakers on all API server clients that prevent thundering herd reconnection during recovery. Naming the circular dependency pattern and its solution in a system design interview demonstrates operational thinking that most candidates do not display.

### Senior @ FAANG: Kubernetes Platform Resilience as a Infrastructure Architecture Standard

At L6, the OpenAI incident reveals the architectural constraints that should govern Kubernetes cluster design for high-availability workloads. The staff engineer's contribution is defining and enforcing the cluster architecture standards that prevent control plane circular dependencies. Three standards matter most. First, the Kubernetes API server must be accessible via a static IP or a DNS name hosted outside the cluster (not CoreDNS), so that clients can reach the API server even when DNS within the cluster has failed. The static endpoint must be tested quarterly by a chaos experiment that disables CoreDNS and verifies that cluster management operations can still be performed. Second, all critical control plane components (CoreDNS, kube-proxy, CNI plugins) must have circuit breakers on their API server calls that implement exponential backoff with jitter and a maximum retry rate per client. The API server overwhelm pattern in the OpenAI incident (API clients flooding the recovering API server with reconnection attempts) is a thundering herd problem that circuit breakers on each client prevent. Third, for workloads where control plane recovery time is a business-critical SLA, maintain a minimum of three API server replicas in different availability zones, with an etcd cluster that can sustain the loss of any one replica without losing quorum. The recovery time SLA must be verified by a quarterly controlled failure test, not by theoretical availability calculations. At the organizational level, these standards should be embedded in the cluster provisioning templates so that no new cluster can be created without them, rather than requiring individual teams to implement them independently.

---
