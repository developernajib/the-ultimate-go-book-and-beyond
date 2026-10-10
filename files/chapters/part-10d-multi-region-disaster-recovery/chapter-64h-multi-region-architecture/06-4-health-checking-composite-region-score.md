## 4. Health Checking - Composite Region Score

Regional health is never a binary up/down. We compute a composite score from multiple signals: HTTP health endpoints, database replication lag, queue depth, and error rate. A region might have perfectly healthy application servers but a database that is 30 seconds behind on replication, making it unsafe for reads that need recent data. By combining multiple probes into a single 0.0-to-1.0 score, the failover controller can make nuanced decisions rather than flipping a crude on/off switch. Each probe runs concurrently in its own goroutine for speed, and each carries a configurable weight so you can express that database health matters more than, say, queue depth for your specific workload.

```go
// health/checker.go
package health

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"yourmodule/region"
)

// Signal is a named health dimension with a weight.
type Signal struct {
	Name   string
	Weight float64 // Fraction of total score this signal contributes.
	Score  float64 // 0.0-1.0
}

// HealthProbe checks a single dimension of regional health.
type HealthProbe interface {
	Probe(ctx context.Context, r *region.Region) (score float64, err error)
}

// CompositeChecker aggregates multiple probes into a single regional score.
type CompositeChecker struct {
	probes  []weightedProbe
	logger  *slog.Logger
}

type weightedProbe struct {
	probe  HealthProbe
	weight float64
	name   string
}

func NewCompositeChecker(logger *slog.Logger) *CompositeChecker {
	return &CompositeChecker{logger: logger}
}

// AddProbe registers a probe with the given weight.
func (c *CompositeChecker) AddProbe(name string, weight float64, probe HealthProbe) {
	c.probes = append(c.probes, weightedProbe{probe: probe, weight: weight, name: name})
}

// Check computes a composite health score for the region.
func (c *CompositeChecker) Check(ctx context.Context, r *region.Region) float64 {
	type result struct {
		name   string
		score  float64
		weight float64
	}

	results := make([]result, len(c.probes))
	var wg sync.WaitGroup
	for i, wp := range c.probes {
		wg.Add(1)
		go func(idx int, wp weightedProbe) {
			defer wg.Done()
			score, err := wp.probe.Probe(ctx, r)
			if err != nil {
				c.logger.WarnContext(ctx, "probe error",
					"probe", wp.name, "region", r.ID, "err", err)
				score = 0.0
			}
			results[idx] = result{name: wp.name, score: score, weight: wp.weight}
		}(i, wp)
	}
	wg.Wait()

	var totalWeight, weightedSum float64
	for _, res := range results {
		weightedSum += res.score * res.weight
		totalWeight += res.weight
		c.logger.DebugContext(ctx, "probe result",
			"probe", res.name, "region", r.ID, "score", fmt.Sprintf("%.3f", res.score))
	}

	if totalWeight == 0 {
		return 0
	}
	return weightedSum / totalWeight
}

// HTTPHealthProbe checks the /health endpoint of a region.
type HTTPHealthProbe struct {
	client  *http.Client
	path    string
}

func NewHTTPHealthProbe(timeout time.Duration, path string) *HTTPHealthProbe {
	return &HTTPHealthProbe{
		client: &http.Client{Timeout: timeout},
		path:   path,
	}
}

type healthResponse struct {
	Status string  `json:"status"`
	Score  float64 `json:"score,omitempty"`
}

func (p *HTTPHealthProbe) Probe(ctx context.Context, r *region.Region) (float64, error) {
	url := r.Endpoint + p.path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, fmt.Errorf("building request: %w", err)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("probe request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var hr healthResponse
		if err := json.NewDecoder(resp.Body).Decode(&hr); err == nil && hr.Score > 0 {
			return hr.Score, nil
		}
		return 1.0, nil
	}
	if resp.StatusCode >= 500 {
		return 0, nil
	}
	return 0.5, nil
}

// ReplicationLagProbe scores based on database replication lag.
// A lag under 1s scores 1.0 - at maxLag it scores 0.0.
type ReplicationLagProbe struct {
	getLag func(ctx context.Context, regionID string) (time.Duration, error)
	maxLag time.Duration
}

func NewReplicationLagProbe(
	getLag func(ctx context.Context, regionID string) (time.Duration, error),
	maxLag time.Duration,
) *ReplicationLagProbe {
	return &ReplicationLagProbe{getLag: getLag, maxLag: maxLag}
}

func (p *ReplicationLagProbe) Probe(ctx context.Context, r *region.Region) (float64, error) {
	lag, err := p.getLag(ctx, r.ID)
	if err != nil {
		return 0, err
	}
	if lag <= time.Second {
		return 1.0, nil
	}
	score := 1.0 - float64(lag)/float64(p.maxLag)
	if score < 0 {
		return 0, nil
	}
	return score, nil
}

// HealthLoop continuously evaluates region health and updates the registry.
type HealthLoop struct {
	checker  *CompositeChecker
	registry *region.Registry
	interval time.Duration
	logger   *slog.Logger
}

func NewHealthLoop(
	checker *CompositeChecker,
	registry *region.Registry,
	interval time.Duration,
	logger *slog.Logger,
) *HealthLoop {
	return &HealthLoop{
		checker:  checker,
		registry: registry,
		interval: interval,
		logger:   logger,
	}
}

func (hl *HealthLoop) Run(ctx context.Context) {
	ticker := time.NewTicker(hl.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, r := range hl.registry.All() {
				r := r
				go func() {
					score := hl.checker.Check(ctx, r)
					r.UpdateHealth(score)
					hl.logger.Info("health updated",
						"region", r.ID, "score", fmt.Sprintf("%.3f", score))
				}()
			}
		}
	}
}
```

---

### Junior -> FAANG: Why Binary Health Checks Are Not Enough

Most engineers first encounter health checks as a binary concept: the service is up or it is down. Kubernetes liveness probes return 200 OK or they do not. But a service can return 200 OK on its liveness endpoint while simultaneously being unable to serve real traffic because its database replica is 45 seconds behind on replication and all user queries return stale data. Binary health checks miss this class of degraded-but-not-dead failures.

The composite score model solves this by adding weighted signals. A database replica that is 5 seconds behind on replication should reduce the region's score by some amount, and the failover controller can decide how much degradation is acceptable before routing around the region. This is a much more nuanced signal than a binary up/down.

For interview preparation: when asked "how do you detect that a service is unhealthy?", the weak answer is "/health endpoint returns 200." The strong answer is "a composite check combining liveness (HTTP), readiness (can it serve traffic?), and saturation signals (replication lag, queue depth, connection pool utilization), combined into a score that drives gradual traffic shifting rather than binary failover."

### Senior @ FAANG: Health Scoring as a Platform Contract and Operational Runbook

**Weight assignment is a policy that belongs in an ADR.** The `CompositeChecker.AddProbe` call in the bootstrap code assigns `0.6` to HTTP and `0.4` to replication lag. These numbers determine how quickly a region is drained when the database falls behind. If the database weight is too high, a brief replication lag spike triggers an unnecessary failover with user impact. If it is too low, a sustained lag accumulates undetected stale reads. These weights should be calibrated against historical incident data and reviewed quarterly, not set once and forgotten.

**Probe independence and failure isolation.** The `CompositeChecker` runs each probe in a separate goroutine. This is correct, but each goroutine shares the same `ctx`. If the context is canceled (because the health loop is shutting down), all probes receive the cancellation simultaneously. A production implementation uses a derived context with a per-probe timeout that is shorter than the overall check interval, preventing a single slow probe from blocking the entire health update cycle.

**Oscillation and hysteresis.** A region whose score oscillates around the `HealthThreshold` (e.g., bouncing between 0.38 and 0.42) would cause the failover controller to repeatedly drain and restore it, creating a flapping condition that is worse than leaving it alone. Production health controllers implement hysteresis: a separate lower threshold for starting a drain and a higher threshold for restoring traffic, with a mandatory quiet period between transitions. The gap between drain threshold and recovery threshold prevents oscillation.

**Replication lag probe calibration.** The `ReplicationLagProbe` uses a linear mapping from lag to score, scoring 0 at `maxLag`. This mapping is too aggressive for most workloads: a replica that is 29 seconds behind when `maxLag` is 30 seconds gets a score of 0.03, triggering a drain, but a replica that is 30.1 seconds behind gets score 0, also triggering a drain. There is no meaningful difference between these two states from a user impact perspective. A production probe uses a sigmoid or step function with a dead zone around the acceptable lag range, reserving the low scores for truly unacceptable lag rather than for the 29-vs-30-second boundary.

**Probing from outside the region.** The health loop above runs inside each region and probes the region's own endpoints. This means it cannot detect network partitions between regions: a region that is isolated from the rest of the world will report itself as healthy. A production health architecture includes cross-region probes: health checks sent from each region to every other region, with the global health controller aggregating the results. A region that reports itself healthy but is unreachable from three other regions is likely partitioned, and that information changes the failover decision.
