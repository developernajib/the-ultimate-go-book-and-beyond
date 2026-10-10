## 10. Automated Regional Failover Controller

The failover controller watches health scores and triggers draining and traffic shifting automatically. It runs as a continuous control loop: on every tick it reads every region's health score from the registry, compares it against configurable thresholds, and decides whether to drain an unhealthy region or restore a recovered one. The controller includes a critical safety check: it refuses to drain a region if doing so would leave fewer healthy regions than the configured minimum, preventing a cascading failure from taking down the entire system. Every failover action is recorded in an audit history and sent to a notifier (Slack, PagerDuty) so the on-call engineer knows exactly what happened and why.

```go
// failover/controller.go
package failover

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"yourmodule/region"
	"yourmodule/trafficmgr"
)

// Event records a failover action for audit purposes.
type Event struct {
	At          time.Time
	RegionID    string
	FromRole    region.Role
	ToRole      region.Role
	Reason      string
	InitiatedBy string // "auto" or operator email
}

// Notifier is called when a failover event occurs.
type Notifier interface {
	Notify(ctx context.Context, event Event) error
}

// Config holds tuning parameters for the controller.
type Config struct {
	// HealthThreshold: if a region's score drops below this, begin draining.
	HealthThreshold float64
	// RecoveryThreshold: score must exceed this before restoring traffic.
	RecoveryThreshold float64
	// CheckInterval: how frequently health is evaluated.
	CheckInterval time.Duration
	// DrainDuration: time to ramp traffic to zero on a failing region.
	DrainDuration time.Duration
	// MinHealthyRegions: refuse to drain if this would leave fewer regions.
	MinHealthyRegions int
}

// DefaultConfig returns safe conservative defaults.
func DefaultConfig() Config {
	return Config{
		HealthThreshold:   0.4,
		RecoveryThreshold: 0.7,
		CheckInterval:     15 * time.Second,
		DrainDuration:     2 * time.Minute,
		MinHealthyRegions: 1,
	}
}

// Controller monitors region health and automates traffic shifting.
type Controller struct {
	cfg      Config
	registry *region.Registry
	shifter  *trafficmgr.TrafficShifter
	notifier Notifier
	mu       sync.Mutex
	draining map[string]bool // regionID → currently being drained
	history  []Event
	logger   *slog.Logger
}

// NewController constructs a failover controller.
func NewController(
	cfg Config,
	registry *region.Registry,
	shifter *trafficmgr.TrafficShifter,
	notifier Notifier,
	logger *slog.Logger,
) *Controller {
	return &Controller{
		cfg:      cfg,
		registry: registry,
		shifter:  shifter,
		notifier: notifier,
		draining: make(map[string]bool),
		logger:   logger,
	}
}

// Run starts the control loop. Blocks until ctx is canceled.
func (c *Controller) Run(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.CheckInterval)
	defer ticker.Stop()

	c.logger.Info("failover controller started",
		"threshold", c.cfg.HealthThreshold,
		"interval", c.cfg.CheckInterval)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.evaluate(ctx)
		}
	}
}

func (c *Controller) evaluate(ctx context.Context) {
	all := c.registry.All()
	healthy := c.registry.Healthy(c.cfg.HealthThreshold)

	for _, r := range all {
		score := r.GetHealthScore()
		c.mu.Lock()
		alreadyDraining := c.draining[r.ID]
		c.mu.Unlock()

		switch {
		case score < c.cfg.HealthThreshold && !alreadyDraining:
			if len(healthy) <= c.cfg.MinHealthyRegions {
				c.logger.Warn("cannot drain - would violate MinHealthyRegions",
					"region", r.ID, "healthy_count", len(healthy))
				continue
			}
			c.logger.Warn("region below threshold - initiating drain",
				"region", r.ID, "score", score)
			go c.drainRegion(ctx, r)

		case score >= c.cfg.RecoveryThreshold && alreadyDraining:
			c.logger.Info("region recovered - restoring traffic",
				"region", r.ID, "score", score)
			go c.restoreRegion(ctx, r)
		}
	}
}

func (c *Controller) drainRegion(ctx context.Context, r *region.Region) {
	c.mu.Lock()
	c.draining[r.ID] = true
	oldRole := r.GetRole()
	c.mu.Unlock()

	r.SetRole(region.RoleDraining)

	if err := c.shifter.DrainRegion(ctx, r.ID, c.cfg.DrainDuration); err != nil {
		c.logger.ErrorContext(ctx, "drain failed", "region", r.ID, "err", err)
		c.mu.Lock()
		c.draining[r.ID] = false
		c.mu.Unlock()
		r.SetRole(oldRole)
		return
	}

	r.SetRole(region.RoleStandby)
	event := Event{
		At:          time.Now().UTC(),
		RegionID:    r.ID,
		FromRole:    oldRole,
		ToRole:      region.RoleStandby,
		Reason:      fmt.Sprintf("health score dropped below %.2f", c.cfg.HealthThreshold),
		InitiatedBy: "auto",
	}

	c.mu.Lock()
	c.history = append(c.history, event)
	c.mu.Unlock()

	if c.notifier != nil {
		if err := c.notifier.Notify(ctx, event); err != nil {
			c.logger.WarnContext(ctx, "notification failed", "err", err)
		}
	}
}

func (c *Controller) restoreRegion(ctx context.Context, r *region.Region) {
	c.mu.Lock()
	c.draining[r.ID] = false
	c.mu.Unlock()

	r.SetRole(region.RoleSecondary)
	// Rebalance will happen on the next traffic evaluation cycle.
	c.logger.Info("region restored to secondary", "region", r.ID)
}

// History returns a copy of all recorded failover events.
func (c *Controller) History() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Event, len(c.history))
	copy(out, c.history)
	return out
}
```

---

### Junior -> FAANG: Control Loops and the Observe-Decide-Act Pattern

The `Controller.Run` loop is a classic control loop, the same pattern used by Kubernetes controllers, AWS Auto Scaling, and Istio circuit breakers. The structure is always: observe current state (read health scores), compare against desired state (thresholds), decide what action to take, act (drain or restore). Learning to recognize and implement this pattern is a high-value FAANG skill because it applies to any self-healing system.

The `MinHealthyRegions` safety guard is the most interview-worthy line in the controller. Without it, a cascading failure scenario unfolds: region A becomes unhealthy, controller drains it, region B is also unhealthy (because the problem is systemic), controller tries to drain it too, now zero regions are serving traffic. The guard enforces a floor: always keep at least N regions in service regardless of health scores. In interviews, mention this guard proactively to signal you have thought through the failure modes.

The `History` slice is an audit log. In a real incident response, on-call engineers need to know: what actions did the controller take, when, and why? Without this log, the controller acts invisibly and postmortem reconstruction is difficult.

### Senior @ FAANG: Failover Controller as Governance Infrastructure

**The controller is a policy engine, not just automation.** Every threshold in `Config` (HealthThreshold, RecoveryThreshold, DrainDuration, MinHealthyRegions) encodes a business policy: "we are willing to accept this much degradation before we take this action." These policies should be stored in a version-controlled configuration repository, reviewed by an SRE lead when changed, and subject to a change management process (at minimum, a Slack notification to the on-call channel). Embedding them as compiled-in defaults is a code smell at L6+.

**Drain and restore are asymmetric operations.** The controller drains regions gradually (over `DrainDuration`) to avoid dropping in-flight requests. But it restores regions immediately in the code above (`restoreRegion` just sets the role and logs). This asymmetry is intentional for drain (protecting in-flight requests) but the restore should also be gradual. Abruptly sending 33% of traffic to a recovering region may overwhelm it before its connection pools, JIT-compiled code paths, and caches are fully warmed. A production restore ramps traffic from 0 to target over a configurable warmup period, watching error rates during the ramp.

**Concurrent drainRegion goroutines and state coherence.** The `evaluate` method launches `drainRegion` in a goroutine for each unhealthy region. If two regions become unhealthy simultaneously, two goroutines run concurrently. Both goroutines call `shifter.DrainRegion`, which modifies the shared weight map. The `TrafficShifter` uses its own mutex, so no data races occur. But the combined effect of two simultaneous drains may temporarily violate `MinHealthyRegions` if the guard check in `evaluate` runs before either drain completes. A production controller serializes failover decisions through a single decision goroutine, with drain operations as side effects.

**Notifier reliability and PagerDuty integration.** The `Notifier.Notify` call is on the critical path of a drain operation. If PagerDuty or Slack is unavailable during an incident (which is common: infrastructure incidents often degrade monitoring and alerting infrastructure too), `Notify` fails. The controller continues the drain (correct behavior) but the failure is only logged as a warning. A production notifier uses a local queue that buffers notifications and retries with exponential backoff, ensuring on-call engineers eventually receive the alert even if the notifier is temporarily degraded.

**Controller HA and leader election.** The controller above is a singleton. In a production deployment, you run multiple instances for HA, but only one should be the active controller at any time to prevent conflicting failover decisions. This requires leader election via etcd, ZooKeeper, or a cloud-native equivalent. The controller acquires a lease, runs the control loop, renews the lease on each iteration, and gracefully hands off if it fails to renew. Candidates who propose a distributed controller without mentioning leader election are missing a correctness requirement.
