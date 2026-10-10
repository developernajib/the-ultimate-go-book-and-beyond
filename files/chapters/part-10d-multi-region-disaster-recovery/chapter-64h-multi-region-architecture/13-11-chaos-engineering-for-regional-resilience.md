## 11. Chaos Engineering for Regional Resilience

Chaos tests must be first-class citizens. We build a framework that injects regional faults in a controlled, observable way. The idea behind chaos engineering is simple: if you do not test your failure-handling code by actually injecting failures, you will only discover whether it works during a real incident, which is the worst possible time to find bugs. The `Injector` below supports four fault types: artificial latency (making a region slow), packet loss (randomly dropping a percentage of requests), full network partition (completely isolating a region), and slow disk I/O. Each fault has a configurable duration and magnitude, and faults are automatically cleaned up when their duration expires or the context is canceled. The `RunExperiment` method lets you compose multiple faults into a structured experiment with automatic rollback on failure.

```go
// chaos/region.go
package chaos

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"yourmodule/region"
)

// FaultType defines what kind of failure to inject.
type FaultType string

const (
	FaultLatency    FaultType = "latency"    // Add artificial delay
	FaultPacketLoss FaultType = "packet_loss" // Drop requests randomly
	FaultPartition  FaultType = "partition"   // Cut the region off entirely
	FaultSlow       FaultType = "slow_disk"   // Simulate slow I/O
)

// Fault describes a single chaos injection.
type Fault struct {
	ID         string
	RegionID   string
	Type       FaultType
	Duration   time.Duration
	Magnitude  float64  // Interpretation varies by type: ms for latency, 0-1 for loss
	StartAt    time.Time
	EndsAt     time.Time
	Active     bool
}

// Experiment defines a chaos run with one or more faults.
type Experiment struct {
	Name     string
	Faults   []Fault
	Rollback func(ctx context.Context) error
}

// Injector manages active chaos faults.
type Injector struct {
	mu      sync.RWMutex
	active  map[string]*Fault // faultID → fault
	registry *region.Registry
	logger  *slog.Logger
	rng     *rand.Rand
}

// NewInjector creates a chaos injector.
func NewInjector(registry *region.Registry, logger *slog.Logger) *Injector {
	return &Injector{
		active:   make(map[string]*Fault),
		registry: registry,
		logger:   logger,
		rng:      rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0)),
	}
}

// Inject activates a fault for its duration, then auto-removes it.
func (inj *Injector) Inject(ctx context.Context, f *Fault) error {
	if f.Duration <= 0 {
		return errors.New("fault duration must be positive")
	}

	f.Active = true
	f.StartAt = time.Now().UTC()
	f.EndsAt = f.StartAt.Add(f.Duration)

	inj.mu.Lock()
	inj.active[f.ID] = f
	inj.mu.Unlock()

	inj.logger.WarnContext(ctx, "chaos fault injected",
		"id", f.ID, "region", f.RegionID, "type", f.Type,
		"magnitude", f.Magnitude, "duration", f.Duration)

	go func() {
		select {
		case <-ctx.Done():
		case <-time.After(f.Duration):
		}
		inj.Remove(f.ID)
		inj.logger.Info("chaos fault removed", "id", f.ID, "region", f.RegionID)
	}()

	return nil
}

// Remove deactivates a fault immediately.
func (inj *Injector) Remove(faultID string) {
	inj.mu.Lock()
	defer inj.mu.Unlock()
	if f, ok := inj.active[faultID]; ok {
		f.Active = false
		delete(inj.active, faultID)
	}
}

// ShouldDrop returns true if a packet-loss fault is active for the region
// and this request should be dropped (based on magnitude as probability).
func (inj *Injector) ShouldDrop(regionID string) bool {
	inj.mu.RLock()
	defer inj.mu.RUnlock()
	for _, f := range inj.active {
		if f.RegionID == regionID && f.Type == FaultPacketLoss {
			return inj.rng.Float64() < f.Magnitude
		}
	}
	return false
}

// AddedLatency returns the artificial delay to add for a region, or 0.
func (inj *Injector) AddedLatency(regionID string) time.Duration {
	inj.mu.RLock()
	defer inj.mu.RUnlock()
	for _, f := range inj.active {
		if f.RegionID == regionID && f.Type == FaultLatency {
			return time.Duration(f.Magnitude) * time.Millisecond
		}
	}
	return 0
}

// IsPartitioned returns true if the region is being isolated.
func (inj *Injector) IsPartitioned(regionID string) bool {
	inj.mu.RLock()
	defer inj.mu.RUnlock()
	for _, f := range inj.active {
		if f.RegionID == regionID && f.Type == FaultPartition {
			return true
		}
	}
	return false
}

// ActiveFaults returns a snapshot of currently active faults.
func (inj *Injector) ActiveFaults() []Fault {
	inj.mu.RLock()
	defer inj.mu.RUnlock()
	out := make([]Fault, 0, len(inj.active))
	for _, f := range inj.active {
		out = append(out, *f)
	}
	return out
}

// RunExperiment executes a structured chaos experiment with automatic rollback.
func (inj *Injector) RunExperiment(ctx context.Context, exp *Experiment) error {
	inj.logger.Info("starting chaos experiment", "name", exp.Name)

	injectedIDs := make([]string, 0, len(exp.Faults))
	for i := range exp.Faults {
		f := &exp.Faults[i]
		if err := inj.Inject(ctx, f); err != nil {
			// Rollback already-injected faults.
			for _, id := range injectedIDs {
				inj.Remove(id)
			}
			return fmt.Errorf("injecting fault %q: %w", f.ID, err)
		}
		injectedIDs = append(injectedIDs, f.ID)
	}

	// Wait for all faults to expire or context to cancel.
	maxDuration := time.Duration(0)
	for _, f := range exp.Faults {
		if f.Duration > maxDuration {
			maxDuration = f.Duration
		}
	}

	select {
	case <-ctx.Done():
		for _, id := range injectedIDs {
			inj.Remove(id)
		}
	case <-time.After(maxDuration):
	}

	if exp.Rollback != nil {
		if err := exp.Rollback(ctx); err != nil {
			inj.logger.ErrorContext(ctx, "experiment rollback failed", "name", exp.Name, "err", err)
			return fmt.Errorf("rollback: %w", err)
		}
	}

	inj.logger.Info("chaos experiment completed", "name", exp.Name)
	return nil
}
```

---

### Junior -> FAANG: Chaos Engineering as Hypothesis Testing

The most common misconception about chaos engineering among junior engineers is that it means "randomly break things and see what happens." That is not chaos engineering. That is chaos. Chaos engineering is hypothesis-driven: you form a specific, testable hypothesis about how the system will behave under a specific failure condition, and then you design an experiment to test that hypothesis against the actual system.

A well-formed hypothesis follows the structure: "We believe the system will maintain [steady-state metric] when [failure condition] because [mechanism]." Example: "We believe P99 latency will remain below 200ms when the ap-east-1 region is fully partitioned, because the latency router will detect the partition within 5 seconds and shift traffic to ap-southeast-1." This is testable. The `RunExperiment` method in this section is the scaffolding for running such a test.

The `ShouldDrop` and `AddedLatency` methods demonstrate the two most common fault types. Latency injection is more realistic than full partition injection for discovering timeout misconfiguration: if your service calls a downstream with a 30-second timeout and the downstream starts adding 25 seconds of latency, your request threads fill up before the timeout fires. This is a common production failure mode that latency injection exposes in testing.

### Senior @ FAANG: Chaos Engineering Maturity and Organization-Level Integration

**The maturity model for chaos engineering.** Teams progress through four stages: (1) manual chaos experiments during business hours with engineers on standby, (2) automated experiments in staging environments only, (3) automated experiments in production during low-traffic windows with automated rollback, (4) continuous automated experiments in production with no pre-scheduled windows. Most FAANG teams operate at stage 3. Netflix operates at stage 4 for their most stable systems. Assessing where your team is and articulating the path to stage 4 is an L6/L7 conversation, not an L3/L4 one.

**Blast radius management as a first-class concern.** The `Injector` above injects faults at a single region level. Production chaos frameworks also define blast radius: the maximum percentage of users or traffic that should be exposed to a fault at any given time. An experiment that partitions ap-east-1 has a blast radius equal to ap-east-1's traffic share (say, 15%). An experiment that simultaneously partitions two regions has a blast radius of 30%. A staff engineer defines blast radius policy and enforces it as a pre-condition check in `RunExperiment`: refuse to run experiments whose combined blast radius exceeds a configured maximum.

**Steady-state hypothesis measurement.** The `Experiment` struct has a name and a list of faults but no mechanism for measuring whether the steady-state hypothesis holds. A production experiment framework includes a `SteadyStateVerifier` that runs before, during, and after the experiment, querying Prometheus or Datadog for the specific metrics that define steady state. If the pre-experiment check finds the system already degraded (latency already elevated), the experiment is aborted rather than injected on top of an existing problem.

**Automated rollback triggers.** The `RunExperiment` method above calls `exp.Rollback` after all faults expire. A production framework also monitors steady-state metrics during the experiment and triggers early rollback if they breach the acceptable threshold. For example: if the experiment injects 200ms latency on ap-east-1 and the P99 across all regions climbs above 500ms (the steady-state threshold), the experiment terminates early, the fault is removed, and the rollback function is called. Without this safety net, a badly-calibrated experiment can cause a real outage.

**GameDay integration at organization scale.** The chaos injector above is a library that individual services use. At FAANG scale, chaos experiments are scheduled and coordinated at the organization level by a dedicated chaos engineering platform (Netflix's Chaos Engineering Service, Amazon's Fault Injection Simulator). This platform ensures that simultaneous experiments from different teams do not accidentally combine into a blast radius that exceeds the safety threshold. At L7, you design this coordination layer, not just the injection mechanism.
