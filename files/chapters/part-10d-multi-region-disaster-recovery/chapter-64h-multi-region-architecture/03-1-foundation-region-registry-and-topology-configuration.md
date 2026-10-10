## 1. Foundation: Region Registry and Topology Configuration

Every multi-region system starts with a precise model of its own topology. Rather than hard-coding region endpoints, we build a dynamic registry that the entire application consults. Think of the registry as a phone book for your regions: it knows each region's geographic location, its current role (primary, secondary, standby), and its health score. Every other component in the system, from the load balancer to the failover controller, queries this registry to make routing and failover decisions. The registry also auto-detects which region the current process is running in by checking cloud metadata services or environment variables, so your application code never needs to hard-code "I am in us-east-1."

```go
// region/registry.go
package region

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
    "sort"
	"sync"
	"sync/atomic"
	"time"
)

// Topology defines the deployment model.
type Topology int

const (
	TopologyActiveActive  Topology = iota // All regions serve traffic.
	TopologyActivePassive                 // One primary; others are standby.
	TopologyActiveWarm                    // One primary; others warm but reduced capacity.
)

func (t Topology) String() string {
	switch t {
	case TopologyActiveActive:
		return "active-active"
	case TopologyActivePassive:
		return "active-passive"
	case TopologyActiveWarm:
		return "active-warm"
	default:
		return "unknown"
	}
}

// Role describes what a region is currently doing.
type Role int

const (
	RolePrimary  Role = iota
	RoleSecondary
	RoleStandby
	RoleDraining // Receiving no new traffic; finishing in-flight requests.
	RoleOffline
)

func (r Role) String() string {
	names := []string{"primary", "secondary", "standby", "draining", "offline"}
	if int(r) < len(names) {
		return names[r]
	}
	return "unknown"
}

// Region holds metadata and runtime state for a single geographic region.
type Region struct {
	ID       string   // e.g. "us-east-1"
	Name     string   // e.g. "US East (N. Virginia)"
	Endpoint string   // Primary HTTPS endpoint
	Lat      float64  // Latitude (for proximity routing)
	Lon      float64  // Longitude
	Priority int      // Lower = preferred when scores are equal
	Tags     []string // e.g. ["gdpr-compliant", "hipaa"]

	mu            sync.RWMutex
	role          Role
	healthScore   float64 // 0.0-1.0, where 1.0 = fully healthy
	latencyMs     int64   // rolling P99 latency to this region
	trafficWeight int32   // current weight in load balancer (0-100)
}

func (r *Region) SetRole(role Role) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.role = role
}

func (r *Region) GetRole() Role {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.role
}

func (r *Region) UpdateHealth(score float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.healthScore = score
}

func (r *Region) GetHealthScore() float64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.healthScore
}

func (r *Region) SetLatency(ms int64) {
	atomic.StoreInt64(&r.latencyMs, ms)
}

func (r *Region) GetLatency() int64 {
	return atomic.LoadInt64(&r.latencyMs)
}

func (r *Region) SetTrafficWeight(w int32) {
	atomic.StoreInt32(&r.trafficWeight, w)
}

func (r *Region) GetTrafficWeight() int32 {
	return atomic.LoadInt32(&r.trafficWeight)
}

// Registry maintains the full fleet of regions.
type Registry struct {
	mu       sync.RWMutex
	regions  map[string]*Region
	topology Topology
	local    string // ID of the region this process is running in
	logger   *slog.Logger
}

// NewRegistry constructs a registry with the given topology.
func NewRegistry(topology Topology, localRegionID string, logger *slog.Logger) *Registry {
	return &Registry{
		regions:  make(map[string]*Region),
		topology: topology,
		local:    localRegionID,
		logger:   logger,
	}
}

// Register adds or replaces a region entry.
func (reg *Registry) Register(r *Region) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.regions[r.ID] = r
	reg.logger.Info("region registered", "id", r.ID, "role", r.role.String())
}

// Local returns the region this process belongs to.
func (reg *Registry) Local() (*Region, error) {
	reg.mu.RLock()
	defer reg.mu.RUnlock()
	r, ok := reg.regions[reg.local]
	if !ok {
		return nil, fmt.Errorf("local region %q not found in registry", reg.local)
	}
	return r, nil
}

// Healthy returns all regions with health score above threshold, sorted by priority.
func (reg *Registry) Healthy(minScore float64) []*Region {
	reg.mu.RLock()
	defer reg.mu.RUnlock()

	var out []*Region
	for _, r := range reg.regions {
		if r.GetHealthScore() >= minScore && r.GetRole() != RoleOffline {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority < out[j].Priority
		}
		return out[i].GetLatency() < out[j].GetLatency()
	})
	return out
}

// All returns every registered region.
func (reg *Registry) All() []*Region {
	reg.mu.RLock()
	defer reg.mu.RUnlock()
	out := make([]*Region, 0, len(reg.regions))
	for _, r := range reg.regions {
		out = append(out, r)
	}
	return out
}

// DetectLocalRegion attempts to determine the current region from the instance
// metadata service (AWS IMDSv2 pattern) or falls back to an environment variable.
func DetectLocalRegion(ctx context.Context) (string, error) {
	// IMDSv2: first get a session token, then use it.
	tokenCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(tokenCtx, "tcp", "169.254.169.254:80")
	if err != nil {
		// Not on AWS - fall through to environment variable.
		return detectFromEnv()
	}
	conn.Close()

	// Production implementation would use the real IMDSv2 HTTP calls here.
	// For brevity we return a placeholder after confirming network reachability.
	return detectFromEnv()
}

func detectFromEnv() (string, error) {
	// Checked in order of preference.
	for _, v := range []string{"AWS_REGION", "REGION", "FLY_REGION"} {
		if val := getEnv(v); val != "" {
			return val, nil
		}
	}
	return "", fmt.Errorf("cannot determine local region: set AWS_REGION or REGION env var")
}

// getEnv is a thin wrapper so we can swap in test values.
var getEnv = os.Getenv
```

---

### Junior -> FAANG: Why a Registry Instead of Configuration Files

A first-year engineer's instinct is to put region endpoints in a YAML file or environment variable. The registry pattern exists because static configuration cannot express runtime state. A YAML file cannot tell you whether eu-west-1 is currently draining or what its health score is. The registry combines static configuration (coordinates, priority, endpoint) with runtime state (health score, traffic weight, role) into a single queryable source of truth.

The `DetectLocalRegion` function is worth studying carefully. It tries the IMDS metadata service first, then falls back to environment variables. This pattern appears throughout production Go services: prefer authoritative sources, degrade gracefully to manual overrides. In interviews, if asked how your service knows which region it is in, "environment variable" is a weak answer. The strong answer is "instance metadata service with an env-var fallback, so the service works both on cloud instances and in local development."

Practice exercise: add a `Nearest(clientLat, clientLon float64)` method to `Registry` that returns the single closest healthy region using haversine distance. This is a common interview warm-up that tests whether you can work with existing struct fields without modifying the interface.

### Senior @ FAANG: Registry as Platform Infrastructure and Control Plane Design

The `Registry` in this section is a simplified in-process registry. In production at FAANG scale, the registry is a distributed control plane service, backed by etcd or a cloud-native equivalent, with its own availability SLA. Understanding the gap between the local registry and a production control plane is an L6/L7 differentiator.

**Control plane vs. data plane separation.** The registry is control plane: it holds routing policy. The application servers are data plane: they execute requests. These must fail independently. If the control plane registry becomes unavailable, the data plane should continue operating with its last-known-good snapshot, not fail closed. The `Registry` struct above holds state in memory, which means it survives control plane outages for the lifetime of the process. A production registry caches the last-known-good state to disk so it survives process restarts as well.

**Role transitions as state machine events.** The `Role` type models a state machine: Primary, Secondary, Standby, Draining, Offline. In production, transitions between states must be audited, rate-limited, and guarded by quorum. A single health check dipping below threshold should not immediately trigger a drain. You need N consecutive failures over T seconds to avoid flapping. The registry should emit a structured event log entry for every role transition so that postmortem reconstruction is possible.

**Priority-based tiebreaking in health-equal scenarios.** The `Priority` field in `Region` determines the failover order when multiple regions have equal health scores. At staff level, you recognize that priority assignment is a political as well as a technical decision: making ap-east-1 priority 3 means EU users pay higher latency during AP failover. Document priority assignments in the ADR alongside the performance model that justifies them.

**Atomic health score updates and race conditions.** The `Region` struct mixes a `sync.RWMutex` for role and health score with `sync/atomic` for latency and traffic weight. This is a correct but mixed pattern. At a code review, a senior engineer notes that the mixed locking makes reasoning about consistency harder: if a caller reads health score and traffic weight in sequence, they may see inconsistent combinations because each is guarded separately. A production implementation would expose a single `Snapshot() RegionState` method that reads all fields under one lock, giving the caller a consistent point-in-time view.

**Registry observability.** Every `Register`, `SetRole`, and `UpdateHealth` call should emit a structured log entry and increment a metrics counter. The registry is the source of truth for routing, so any change to it should be immediately visible in Grafana dashboards. Without this, a region that is silently unhealthy (health score falling but not yet below threshold) is invisible until it triggers a failover.
