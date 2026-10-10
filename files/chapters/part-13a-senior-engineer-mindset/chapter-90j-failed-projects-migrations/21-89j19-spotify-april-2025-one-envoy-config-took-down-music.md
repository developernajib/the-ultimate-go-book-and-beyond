## 90J.19 Spotify April 2025: One Envoy Config Took Down Music

### The Incident

On April 16, 2025, Spotify experienced a global outage lasting approximately 2.5 hours. Hundreds of millions
of users could not stream music, load playlists, or log in. The outage cascaded across every client platform  - 
mobile, desktop, web, smart speakers, and car integrations - simultaneously. The incident was particularly
notable because it was caused not by a code change, but by a configuration change to Spotify's Envoy proxy
fleet that had been deployed through their standard pipeline.

### What Went Wrong

Spotify's backend traffic was routed through Envoy proxy sidecars deployed alongside every microservice. These
proxies handled service-to-service authentication, rate limiting, circuit breaking, retries, and observability.
A routine configuration update reordered HTTP filter chains in the Envoy configuration. Specifically, a rate
limiting filter was moved ahead of an authentication filter.

The new order exposed a latent bug: the rate limiting filter, when placed before authentication, attempted to
extract a user identity from the request to apply per-user rate limits. Without the authentication filter
having run first, the user identity was empty, causing the rate limiter to treat all requests as coming from
the same anonymous user. This triggered global rate limiting, rejecting the vast majority of traffic.

The failure cascade:

1. **T+0**: Configuration pushed to Envoy sidecars globally (no canary deployment for config changes)
2. **T+30 seconds**: Rate limiter began rejecting 95% of requests with 429 Too Many Requests
3. **T+1 minute**: Client applications received mass 429s and began retrying with their default retry policy
4. **T+2 minutes**: The retry storm generated 5x the original request volume, overwhelming rate limiters
   and upstream services that were still functional
5. **T+5 minutes**: Engineers identified the configuration change but discovered the rollback pipeline had
   a 15-minute propagation delay due to the same Envoy infrastructure being degraded
6. **T+20 minutes**: Manual rollback initiated by directly pushing configurations to Envoy control planes
7. **T+45 minutes**: Configuration rolled back, but thundering herd from accumulated client retries kept
   services overloaded
8. **T+2.5 hours**: Full recovery after client retry storms naturally subsided

### The Critical Mistakes

1. **No canary for config changes**: Code deployments went through canary analysis, but configuration changes
   were applied globally because they were considered "safe"
2. **Latent ordering dependency**: The correctness of the filter chain depended on ordering, but there were
   no integration tests validating filter interactions
3. **Client retry amplification**: Default retry policies with no jitter or backoff created a thundering herd
4. **Rollback depended on the broken system**: The configuration distribution system used the same Envoy
   infrastructure it was trying to fix

### Go Implementation: Canary Deployment with Health Verification

Spotify's outage happened because config changes bypassed the same progressive-rollout gate that protected code deployments. The `CanaryDeployer` below fixes this by treating every configuration push identically to a binary deployment: it starts at a configurable `CanaryPercent`, verifies error rate and P99 latency against both absolute thresholds and a live baseline from non-canary targets, then advances in `StepPercent` increments only after the canary has been healthy for `MinHealthyDuration`. Crucially, the `rollback` path pushes the old config directly to all targets simultaneously using the same `ConfigDistributor` interface. It does not route through the partially-broken Envoy infrastructure it is trying to fix.

```go
package canary

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Canary deployment system for configuration changes
// -----------------------------------------------------------------------

// DeploymentConfig defines the parameters for a canary deployment.
type DeploymentConfig struct {
	CanaryPercent      float64       // initial percentage of targets (e.g., 1%)
	StepPercent        float64       // percentage increase per step
	StepInterval       time.Duration // time between steps
	MinHealthyDuration time.Duration // how long canary must be healthy before stepping
	MaxErrorRate       float64       // error rate threshold for rollback
	MaxLatencyP99      time.Duration // latency threshold for rollback
	RollbackOnFailure  bool
}

// Target represents a deployment target (server, sidecar, instance).
type Target struct {
	ID       string
	Region   string
	Endpoint string
	IsCanary bool
}

// HealthMetrics contains the health signals collected from a target.
type HealthMetrics struct {
	TargetID    string
	Timestamp   time.Time
	ErrorRate   float64
	LatencyP50  time.Duration
	LatencyP99  time.Duration
	RequestRate float64
	StatusCodes map[int]int
}

// ConfigVersion represents a configuration version being deployed.
type ConfigVersion struct {
	Version   string
	Content   []byte
	CreatedAt time.Time
	Hash      string
}

// CanaryDeployer manages progressive configuration rollouts with
// automatic health verification and rollback.
type CanaryDeployer struct {
	config      DeploymentConfig
	targets     []*Target
	mu          sync.RWMutex
	distributor ConfigDistributor
	monitor     HealthMonitor
	currentStep int
	state       DeploymentState
}

// DeploymentState tracks the current state of a canary deployment.
type DeploymentState int

const (
	StateIdle DeploymentState = iota
	StateCanaryActive
	StateProgressing
	StateRollingBack
	StateComplete
	StateFailed
)

// ConfigDistributor pushes configuration to targets.
type ConfigDistributor interface {
	Push(ctx context.Context, targets []*Target, config *ConfigVersion) error
	GetCurrentVersion(ctx context.Context, target *Target) (string, error)
}

// HealthMonitor collects health metrics from targets.
type HealthMonitor interface {
	GetMetrics(ctx context.Context, target *Target) (*HealthMetrics, error)
	GetBaselineMetrics(ctx context.Context, region string) (*HealthMetrics, error)
}

// NewCanaryDeployer creates a deployer with the given configuration.
func NewCanaryDeployer(
	config DeploymentConfig,
	targets []*Target,
	distributor ConfigDistributor,
	monitor HealthMonitor,
) *CanaryDeployer {
	return &CanaryDeployer{
		config:      config,
		targets:     targets,
		distributor: distributor,
		monitor:     monitor,
		state:       StateIdle,
	}
}

// Deploy executes a canary deployment of the new configuration. It
// progressively rolls out to more targets, verifying health at each
// step, and automatically rolls back if health degrades.
func (d *CanaryDeployer) Deploy(ctx context.Context, newConfig *ConfigVersion, oldConfig *ConfigVersion) error {
	d.mu.Lock()
	d.state = StateCanaryActive
	d.currentStep = 0
	d.mu.Unlock()

	totalTargets := len(d.targets)

	for {
		select {
		case <-ctx.Done():
			return d.rollback(context.Background(), oldConfig)
		default:
		}

		// Calculate how many targets should have the new config.
		currentPercent := d.config.CanaryPercent + (d.config.StepPercent * float64(d.currentStep))
		if currentPercent > 100 {
			currentPercent = 100
		}
		targetCount := int(math.Ceil(float64(totalTargets) * currentPercent / 100))
		if targetCount > totalTargets {
			targetCount = totalTargets
		}

		// Select targets for this step.
		canaryTargets := d.targets[:targetCount]
		fmt.Printf("[CANARY] Step %d: deploying to %d/%d targets (%.1f%%)\n",
			d.currentStep, targetCount, totalTargets, currentPercent)

		// Push config to canary targets.
		if err := d.distributor.Push(ctx, canaryTargets, newConfig); err != nil {
			fmt.Printf("[CANARY] Push failed: %v, rolling back\n", err)
			return d.rollback(ctx, oldConfig)
		}

		// Mark targets as canary.
		for _, t := range canaryTargets {
			t.IsCanary = true
		}

		// Wait for health to stabilize, then verify.
		if err := d.verifyHealth(ctx, canaryTargets); err != nil {
			fmt.Printf("[CANARY] Health verification failed: %v\n", err)
			if d.config.RollbackOnFailure {
				return d.rollback(ctx, oldConfig)
			}
			return err
		}

		// Check if we have deployed to all targets.
		if targetCount >= totalTargets {
			d.mu.Lock()
			d.state = StateComplete
			d.mu.Unlock()
			fmt.Println("[CANARY] Deployment complete - all targets updated")
			return nil
		}

		// Advance to next step.
		d.mu.Lock()
		d.currentStep++
		d.state = StateProgressing
		d.mu.Unlock()

		// Wait before next step.
		select {
		case <-ctx.Done():
			return d.rollback(context.Background(), oldConfig)
		case <-time.After(d.config.StepInterval):
		}
	}
}

// verifyHealth checks that canary targets are healthy by comparing
// their metrics against both absolute thresholds and the baseline
// from non-canary targets.
func (d *CanaryDeployer) verifyHealth(ctx context.Context, canaryTargets []*Target) error {
	// Wait for the minimum healthy duration before collecting metrics.
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d.config.MinHealthyDuration):
	}

	for _, target := range canaryTargets {
		metrics, err := d.monitor.GetMetrics(ctx, target)
		if err != nil {
			return fmt.Errorf("failed to get metrics for %s: %w", target.ID, err)
		}

		// Check absolute thresholds.
		if metrics.ErrorRate > d.config.MaxErrorRate {
			return fmt.Errorf("target %s error rate %.4f exceeds threshold %.4f",
				target.ID, metrics.ErrorRate, d.config.MaxErrorRate)
		}
		if metrics.LatencyP99 > d.config.MaxLatencyP99 {
			return fmt.Errorf("target %s P99 latency %v exceeds threshold %v",
				target.ID, metrics.LatencyP99, d.config.MaxLatencyP99)
		}

		// Check against baseline (non-canary) metrics.
		baseline, err := d.monitor.GetBaselineMetrics(ctx, target.Region)
		if err != nil {
			return fmt.Errorf("failed to get baseline for region %s: %w", target.Region, err)
		}

		// Error rate should not be more than 2x baseline.
		if baseline.ErrorRate > 0 && metrics.ErrorRate > baseline.ErrorRate*2 {
			return fmt.Errorf("target %s error rate %.4f is >2x baseline %.4f",
				target.ID, metrics.ErrorRate, baseline.ErrorRate)
		}

		// P99 latency should not be more than 1.5x baseline.
		if baseline.LatencyP99 > 0 && metrics.LatencyP99 > time.Duration(float64(baseline.LatencyP99)*1.5) {
			return fmt.Errorf("target %s P99 %v is >1.5x baseline %v",
				target.ID, metrics.LatencyP99, baseline.LatencyP99)
		}

		fmt.Printf("[CANARY] Target %s healthy: error_rate=%.4f, p99=%v\n",
			target.ID, metrics.ErrorRate, metrics.LatencyP99)
	}

	return nil
}

// rollback reverts all targets to the old configuration. Uses a
// separate rollback path that does not depend on the canary
// infrastructure.
func (d *CanaryDeployer) rollback(ctx context.Context, oldConfig *ConfigVersion) error {
	d.mu.Lock()
	d.state = StateRollingBack
	d.mu.Unlock()

	fmt.Printf("[CANARY] Rolling back all %d targets to version %s\n",
		len(d.targets), oldConfig.Version)

	// Rollback all targets simultaneously (not progressively).
	if err := d.distributor.Push(ctx, d.targets, oldConfig); err != nil {
		d.mu.Lock()
		d.state = StateFailed
		d.mu.Unlock()
		return fmt.Errorf("rollback failed: %w", err)
	}

	// Reset canary flags.
	for _, t := range d.targets {
		t.IsCanary = false
	}

	d.mu.Lock()
	d.state = StateFailed
	d.mu.Unlock()

	fmt.Println("[CANARY] Rollback complete")
	return nil
}

// Status returns the current state of the deployment.
func (d *CanaryDeployer) Status() (DeploymentState, int) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.state, d.currentStep
}
```

**The Lesson**: Configuration changes are code changes. They deserve the same canary deployment, health
verification, and automatic rollback infrastructure. The assumption that "config changes are safe" has
caused more outages than any other misconception in distributed systems. Always canary. Always verify.
Always have a rollback path that does not depend on the system you are changing.

---

### Junior → FAANG: Configuration Change Safety as an Interview Signal

The Spotify Envoy incident is the interview answer to "how do you deploy configuration changes safely?" A configuration change that bypassed canary deployment took down Spotify globally. For FAANG interviews, the answer to configuration safety is: configuration changes are code changes and must go through the same deployment pipeline. The canary phase for a configuration change is: deploy the new configuration to 1% of instances, measure error rate and latency for 10 minutes, promote to 10% if metrics are within threshold, wait 10 more minutes, then promote to 100% with automatic rollback if any metric exceeds the threshold at any stage. The rollback path must be tested: before any configuration change is deployed, verify that the rollback can be applied within 60 seconds and that the rollback mechanism does not depend on the service being configured. Knowing these specific requirements, rather than vaguely stating "we would test the change," is the signal that distinguishes a candidate who has operated production systems from one who has only built them.

### Senior @ FAANG: Service Mesh Configuration Governance as Platform Architecture

At L6, the Spotify incident reveals the governance gap in service mesh configuration management. Envoy and other service mesh proxies are extremely powerful but also extremely fragile: a single misconfiguration can drop all traffic routed through the affected proxies. The platform engineering response has three components. First, service mesh configuration must be managed as code with the same review and deployment process as application code, including mandatory canary deployment, health verification between stages, and automatic rollback on anomaly detection. The canary deployment for a mesh configuration change must route real traffic through the new configuration at the canary percentage, not just validate the configuration syntax. Second, the rollback mechanism for mesh configuration must be pre-deployed and ready to invoke before the change is applied. If the rollback requires a network call to a configuration server that might be affected by the change, the rollback is unreliable. Rollback should be triggered by a signal that is independent of the service mesh, such as a direct API call to the mesh control plane using a static endpoint. Third, measure the blast radius of each configuration change as a pre-deployment gate. A change that affects the routing configuration for all services in a cluster has a blast radius of 100% and should require a second approval, a documented rollback test in staging, and a deployment window outside peak traffic hours. A change that affects only one service in one region has a blast radius of 1% and can proceed through the normal canary process without additional gates. Blast radius assessment as a pre-deployment gate, enforced by the configuration management platform rather than individual team judgment, is the mechanism that prevents the Spotify scenario from repeating.

---
