## 3. Active-Active Traffic Management with Weight-Based Shifting

In an active-active setup every region handles live traffic. We shift weights progressively during failover rather than performing hard cut-overs. Each region is assigned a traffic weight between 0 and 100, and the weights across all regions must always sum to exactly 100. When a region becomes unhealthy, its weight is gradually ramped down to zero over a configurable duration while the other regions absorb the redistributed traffic proportionally. This gradual approach is critical because abruptly cutting traffic to a region causes in-flight requests to fail and produces error spikes that are visible to users. The `TrafficShifter` below performs this linear interpolation, updating weights at regular step intervals until the target distribution is reached.

```go
// trafficmgr/shifter.go
package trafficmgr

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"yourmodule/region"
)

// WeightMap maps regionID → traffic weight (sum must equal 100).
type WeightMap map[string]int32

// Validate ensures weights sum to 100 and all values are non-negative.
func (w WeightMap) Validate() error {
	var sum int32
	for id, v := range w {
		if v < 0 {
			return fmt.Errorf("region %q has negative weight %d", id, v)
		}
		sum += v
	}
	if sum != 100 {
		return fmt.Errorf("weights must sum to 100, got %d", sum)
	}
	return nil
}

// TrafficShifter gradually moves traffic weight between regions.
type TrafficShifter struct {
	mu       sync.Mutex
	registry *region.Registry
	current  WeightMap
	logger   *slog.Logger
}

// NewTrafficShifter initializes with equal weights across healthy regions.
func NewTrafficShifter(registry *region.Registry, logger *slog.Logger) *TrafficShifter {
	ts := &TrafficShifter{
		registry: registry,
		current:  make(WeightMap),
		logger:   logger,
	}
	ts.rebalance()
	return ts
}

func (ts *TrafficShifter) rebalance() {
	healthy := ts.registry.Healthy(0.5)
	if len(healthy) == 0 {
		ts.logger.Error("no healthy regions available")
		return
	}
	base := int32(100 / len(healthy))
	remainder := int32(100) - base*int32(len(healthy))
	for i, r := range healthy {
		w := base
		if int32(i) < remainder {
			w++
		}
		ts.current[r.ID] = w
		r.SetTrafficWeight(w)
	}
}

// ShiftWeight performs a smooth linear ramp from current weights to target weights
// over the given duration, updating every step interval.
func (ts *TrafficShifter) ShiftWeight(
	ctx context.Context,
	target WeightMap,
	duration time.Duration,
	step time.Duration,
) error {
	if err := target.Validate(); err != nil {
		return fmt.Errorf("invalid target weight map: %w", err)
	}

	ts.mu.Lock()
	start := cloneWeightMap(ts.current)
	ts.mu.Unlock()

	steps := int(duration / step)
	if steps < 1 {
		steps = 1
	}

	ticker := time.NewTicker(step)
	defer ticker.Stop()

	for i := 1; i <= steps; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			ts.mu.Lock()
			frac := float64(i) / float64(steps)
			for id, startW := range start {
				targetW, ok := target[id]
				if !ok {
					targetW = 0
				}
				interpolated := int32(float64(startW) + frac*float64(targetW-startW))
				ts.current[id] = interpolated

				if r := ts.regionByID(id); r != nil {
					r.SetTrafficWeight(interpolated)
				}
			}
			ts.mu.Unlock()

			ts.logger.Info("traffic weight update",
				"step", i, "total_steps", steps, "fraction", fmt.Sprintf("%.2f", frac))
		}
	}

	// Commit exact target values.
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for id, w := range target {
		ts.current[id] = w
		if r := ts.regionByID(id); r != nil {
			r.SetTrafficWeight(w)
		}
	}
	ts.logger.Info("traffic shift complete", "target", target)
	return nil
}

// DrainRegion ramps the given region to zero weight over duration.
func (ts *TrafficShifter) DrainRegion(ctx context.Context, regionID string, duration time.Duration) error {
	ts.mu.Lock()
	current := cloneWeightMap(ts.current)
	ts.mu.Unlock()

	if current[regionID] == 0 {
		return nil // already drained
	}

	// Redistribute drained weight proportionally to remaining regions.
	target := make(WeightMap)
	drainedWeight := current[regionID]
	remaining := make(map[string]int32)
	var remainSum int32
	for id, w := range current {
		if id != regionID {
			remaining[id] = w
			remainSum += w
		}
	}
	target[regionID] = 0

	distributed := int32(0)
	ids := sortedKeys(remaining)
	for i, id := range ids {
		if i == len(ids)-1 {
			// Last region gets any rounding remainder.
			target[id] = remaining[id] + drainedWeight - distributed
		} else {
			share := int32(float64(drainedWeight) * float64(remaining[id]) / float64(remainSum))
			target[id] = remaining[id] + share
			distributed += share
		}
	}

	return ts.ShiftWeight(ctx, target, duration, 5*time.Second)
}

func (ts *TrafficShifter) regionByID(id string) *region.Region {
	for _, r := range ts.registry.All() {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func cloneWeightMap(m WeightMap) WeightMap {
	c := make(WeightMap, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}

func sortedKeys(m map[string]int32) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// sort for determinism
	for i := 0; i < len(keys)-1; i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[i] > keys[j] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}
```

---

### Junior -> FAANG: Traffic Shifting as a Risk Management Tool

The `TrafficShifter` implements a pattern called progressive delivery: instead of instantly routing 100% of traffic to a new configuration, you move a small percentage first and watch for errors. The same technique applies to feature rollouts (canary deployments), not just failover. Understanding this mental model opens up a large class of FAANG interview problems.

The key invariant to memorize: weights must always sum to exactly 100. This seems obvious but it is easy to violate when you subtract weight from one region and add it proportionally to multiple others with integer rounding. The `Validate()` method enforces this at write time. In interviews, when discussing traffic shifting, mention the invariant and the rounding strategy (give the last region any rounding remainder) because this signals you have thought through the edge cases.

The drain pattern (`DrainRegion` ramping to zero over a configurable duration) is the correct answer to "how do you take a region offline without dropping requests?" Abrupt removal causes connection resets on in-flight requests. Gradual weight reduction lets those requests complete while stopping new ones from being assigned. This is the same technique used for pod termination in Kubernetes (graceful shutdown with `terminationGracePeriodSeconds`).

### Senior @ FAANG: Weight Management at Scale and Operational Safety

**The weight map is a distributed state consistency problem.** The `TrafficShifter` updates an in-process `WeightMap`. In a deployment with multiple instances of the failover controller (for HA), each instance has its own in-process map. If two instances simultaneously decide to drain the same region, they may produce weight distributions that each sum to 100 independently but conflict in practice. A production implementation stores the weight map in a distributed CAS (compare-and-swap) store such as etcd, and uses optimistic concurrency control to prevent concurrent modifications.

**Step duration tuning is workload-specific.** The `ShiftWeight` method steps through linear interpolation with a configurable step duration. For a payment service where each in-flight transaction takes 100ms, a 5-second step interval is more than sufficient to avoid dropping transactions. For a WebSocket-based streaming service where connections last minutes, a 5-minute step interval may be necessary. A staff engineer builds a capacity model that derives step duration from the 99th percentile request duration of the target service, not a fixed default.

**Monitoring the shift in real time.** Each step of the weight ramp should emit a metrics data point: current weight per region, error rate per region, and latency per region. The on-call engineer monitoring a failover needs to see these metrics updating in real time to gain confidence that the drain is proceeding correctly. If error rate on the receiving regions spikes during the ramp, the engineer should be able to issue an emergency stop that freezes weights at the current state, not roll back to the start. The `TrafficShifter` should support a `Freeze()` method for this operational pattern.

**Weight-based shifting is not the same as request-level routing.** The `WeightMap` controls what percentage of new connections go to each region, but it does not guarantee that exactly N% of in-flight requests are in each region at any given moment. Existing connections continue until they close. This distinction matters when calculating how long the drain needs to run: you need enough time for all connections established under the old weights to close naturally, which may be longer than a single step interval. For long-lived connections (database connection pools, gRPC streams), communicate the drain timeline to the connection pool management layer explicitly.

**Negative weight guard and audit trail.** The `Validate()` method catches negative weights and non-100 sums. A production system also emits an audit log entry for every `ShiftWeight` call including caller identity, reason string, and the before and after weight maps. This audit trail is essential during postmortems to reconstruct exactly what the traffic distribution was at each minute of an incident.
