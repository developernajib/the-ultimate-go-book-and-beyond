## Section 7: Automated Failover

Automated failover is the process of detecting a primary failure and promoting a standby to take over - without human intervention. The key challenges are:

- **Split-brain**: Both primary and standby believe they are the leader.
- **False positives**: Brief network hiccup triggers unnecessary failover.
- **Data divergence**: Standby is not fully caught up when promoted.

```go
// file: internal/dr/failover/orchestrator.go
package failover

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Region identifies a deployment region.
type Region string

// HealthStatus is the result of a health check.
type HealthStatus struct {
	Region    Region
	Healthy   bool
	Latency   time.Duration
	CheckedAt time.Time
	Error     error
}

// HealthChecker evaluates service health in a region.
type HealthChecker interface {
	Check(ctx context.Context, region Region) (HealthStatus, error)
}

// DNSUpdater flips the active region in DNS.
type DNSUpdater interface {
	SetActive(ctx context.Context, region Region) error
	GetActive(ctx context.Context) (Region, error)
}

// ServicePromoter promotes standby services to active in a region.
type ServicePromoter interface {
	Promote(ctx context.Context, region Region) error
	Demote(ctx context.Context, region Region) error
}

// ReplicationLagChecker verifies replication lag before promotion.
type ReplicationLagChecker interface {
	GetLag(ctx context.Context, region Region) (time.Duration, error)
}

// FailoverConfig controls the orchestrator's behavior.
type FailoverConfig struct {
	PrimaryRegion   Region
	StandbyRegions  []Region
	CheckInterval   time.Duration
	FailureThreshold int           // consecutive failures to trigger failover
	MaxReplicationLag time.Duration // abort if standby lag exceeds this
	LockTimeout     time.Duration
}

// FailoverEvent records a failover action.
type FailoverEvent struct {
	OccurredAt     time.Time
	FromRegion     Region
	ToRegion       Region
	TriggerReason  string
	ReplicationLag time.Duration
	Duration       time.Duration
}

// Orchestrator manages automated regional failover.
type Orchestrator struct {
	cfg        FailoverConfig
	health     HealthChecker
	dns        DNSUpdater
	promoter   ServicePromoter
	lagChecker ReplicationLagChecker
	logger     *slog.Logger

	mu              sync.Mutex
	consecutiveFails map[Region]int
	lastFailover    *FailoverEvent
	failoverInProgress bool
}

func NewOrchestrator(
	cfg FailoverConfig,
	health HealthChecker,
	dns DNSUpdater,
	promoter ServicePromoter,
	lag ReplicationLagChecker,
	logger *slog.Logger,
) *Orchestrator {
	return &Orchestrator{
		cfg:              cfg,
		health:           health,
		dns:              dns,
		promoter:         promoter,
		lagChecker:       lag,
		logger:           logger.With("component", "failover_orchestrator"),
		consecutiveFails: make(map[Region]int),
	}
}

// Run starts the health-check loop. Blocks until ctx is canceled.
func (o *Orchestrator) Run(ctx context.Context) error {
	o.logger.InfoContext(ctx, "failover orchestrator started",
		"primary", o.cfg.PrimaryRegion,
		"standbys", o.cfg.StandbyRegions,
		"check_interval", o.cfg.CheckInterval,
		"failure_threshold", o.cfg.FailureThreshold,
	)

	ticker := time.NewTicker(o.cfg.CheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := o.checkAndMaybeFailover(ctx); err != nil {
				o.logger.ErrorContext(ctx, "check/failover cycle error", "error", err)
			}
		}
	}
}

func (o *Orchestrator) checkAndMaybeFailover(ctx context.Context) error {
	activeRegion, err := o.dns.GetActive(ctx)
	if err != nil {
		return fmt.Errorf("get active region from DNS: %w", err)
	}

	status, err := o.health.Check(ctx, activeRegion)
	if err != nil {
		o.logger.WarnContext(ctx, "health check error",
			"region", activeRegion,
			"error", err,
		)
	}

	o.mu.Lock()
	if status.Healthy {
		o.consecutiveFails[activeRegion] = 0
		o.mu.Unlock()
		return nil
	}

	o.consecutiveFails[activeRegion]++
	fails := o.consecutiveFails[activeRegion]
	o.mu.Unlock()

	o.logger.WarnContext(ctx, "primary health check failed",
		"region", activeRegion,
		"consecutive_fails", fails,
		"threshold", o.cfg.FailureThreshold,
	)

	if fails < o.cfg.FailureThreshold {
		return nil
	}

	// Threshold exceeded: initiate failover.
	return o.executeFailover(ctx, activeRegion, fmt.Sprintf(
		"primary %s failed %d consecutive health checks", activeRegion, fails,
	))
}

func (o *Orchestrator) executeFailover(ctx context.Context, from Region, reason string) error {
	o.mu.Lock()
	if o.failoverInProgress {
		o.mu.Unlock()
		return errors.New("failover already in progress")
	}
	o.failoverInProgress = true
	o.mu.Unlock()

	defer func() {
		o.mu.Lock()
		o.failoverInProgress = false
		o.mu.Unlock()
	}()

	startTime := time.Now()
	o.logger.ErrorContext(ctx, "INITIATING FAILOVER",
		"from", from,
		"reason", reason,
	)

	// Select the best standby: lowest replication lag.
	target, lag, err := o.selectBestStandby(ctx, from)
	if err != nil {
		return fmt.Errorf("select standby for failover: %w", err)
	}

	if lag > o.cfg.MaxReplicationLag {
		return fmt.Errorf(
			"best standby %s has replication lag %s exceeding max %s; manual intervention required",
			target, lag, o.cfg.MaxReplicationLag,
		)
	}

	o.logger.InfoContext(ctx, "selected standby for failover",
		"target", target,
		"replication_lag", lag,
	)

	// Promote standby services.
	if err := o.promoter.Promote(ctx, target); err != nil {
		return fmt.Errorf("promote services in %s: %w", target, err)
	}

	// Update DNS to point to the new primary.
	if err := o.dns.SetActive(ctx, target); err != nil {
		// Critical: try to rollback promotion.
		if rbErr := o.promoter.Demote(ctx, target); rbErr != nil {
			o.logger.ErrorContext(ctx, "DNS update AND rollback both failed",
				"dns_error", err,
				"rollback_error", rbErr,
			)
		}
		return fmt.Errorf("update DNS to %s: %w", target, err)
	}

	event := FailoverEvent{
		OccurredAt:     startTime,
		FromRegion:     from,
		ToRegion:       target,
		TriggerReason:  reason,
		ReplicationLag: lag,
		Duration:       time.Since(startTime),
	}

	o.mu.Lock()
	o.lastFailover = &event
	o.consecutiveFails[from] = 0
	o.mu.Unlock()

	o.logger.ErrorContext(ctx, "FAILOVER COMPLETE",
		"from", from,
		"to", target,
		"duration", event.Duration,
		"replication_lag_at_failover", lag,
	)

	return nil
}

func (o *Orchestrator) selectBestStandby(ctx context.Context, exclude Region) (Region, time.Duration, error) {
	type candidate struct {
		region Region
		lag    time.Duration
	}

	var best *candidate
	for _, standby := range o.cfg.StandbyRegions {
		if standby == exclude {
			continue
		}

		lag, err := o.lagChecker.GetLag(ctx, standby)
		if err != nil {
			o.logger.WarnContext(ctx, "could not get replication lag",
				"region", standby,
				"error", err,
			)
			continue
		}

		if best == nil || lag < best.lag {
			best = &candidate{region: standby, lag: lag}
		}
	}

	if best == nil {
		return "", 0, errors.New("no viable standby regions found")
	}

	return best.region, best.lag, nil
}
```

---

### Junior -> FAANG: Automated Failover as a Reliability Investment

Manual failover is what happens when you have not invested in automated failover. Manual failover requires an on-call engineer to wake up at 3am, read a runbook, execute a sequence of commands, and verify each step manually. Under stress, at 3am, with adrenaline running, humans make mistakes. Automated failover removes the human from the critical path.

The three challenges listed at the top of this section (split-brain, false positive triggers, cascading failures) are the exam questions for automated failover design. For each one, practice explaining the problem and one mitigation:

Split-brain: use fencing tokens or lease-based leader election so only one node can be the designated primary at any time. False positive triggers: require N consecutive failures over T seconds before triggering, not a single failure. Cascading failures: enforce a minimum-healthy-regions invariant that prevents failover when doing so would leave fewer than N regions serving traffic.

The replication lag awareness in `ChooseBestReplica` is worth studying. Promoting a replica that is 5 minutes behind on replication gives you an effective RPO of 5 minutes, even if your SLA says 1 minute. Automated failover must incorporate lag into its promotion decision, not just liveness.

### Senior @ FAANG: Failover Orchestration as a Stateful System with Governance

**Failover state machine must be durable.** The failover orchestrator maintains state (which region is primary, which are replicas, which is currently being promoted). If the orchestrator process crashes during a failover, it must restart and resume from the correct state, not start over. This requires persisting state to a durable store (etcd, PostgreSQL) with each state transition, not holding state in memory. A failover that was 60% complete when the orchestrator crashed should resume from 60%, not trigger a second failover.

**Automatic versus semi-automatic failover.** Fully automated failover (no human in the loop) is appropriate for Tier 0 services where every second of downtime has measurable business cost. For Tier 1 and below, semi-automatic failover (automated detection, human approval before execution) reduces the risk of a misconfigured health check triggering unnecessary failovers. At L6, you design the approval workflow: page the on-call, present the evidence (health scores, alert history, replication lag), provide a one-click approve button, and auto-approve after 5 minutes if no response is received (to handle 3am non-response scenarios).

**Failover run book integration.** Automated failover should not replace the runbook but execute it. The orchestrator's steps (verify primary is unreachable, select best replica by lag, promote replica, update DNS, redirect application traffic, verify writes succeed) should each correspond to a named step in the human runbook. When the orchestrator logs "step 3: promoting replica us-west-2 with lag 2.3s", an engineer who reads the log can follow along with the runbook and intervene at any step. The orchestrator is the runbook's executor, not its replacement.

**Cross-service failover coordination.** When Database A fails and Database B (which serves a downstream service) depends on data that A was writing, both must be considered in the failover decision. Promoting A's replica while leaving B unaware that A's primary has changed causes B to serve stale data from its own replica indefinitely. Automated failover at FAANG scale is not per-service but per-dependency-chain: the orchestrator understands the service graph and sequences failovers to maintain data consistency across dependent services. This is a principal-level architecture concern.

**Post-failover verification.** The failover is not complete when the new primary is promoted. It is complete when writes are confirmed successful, the application's error rate returns to baseline, and replication to the new standby has resumed. A production orchestrator includes a post-failover health check phase that runs for N minutes after promotion and alerts if the new primary does not stabilize. Declaring victory at promotion time is a common mistake that leads to "we thought failover was complete but the service was still degraded."

