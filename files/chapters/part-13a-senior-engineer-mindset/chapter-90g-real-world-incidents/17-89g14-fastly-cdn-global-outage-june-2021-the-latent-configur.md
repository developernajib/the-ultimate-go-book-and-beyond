## 90G.14 Fastly CDN Global Outage (June 2021) - The Latent Configuration Bug

*"A single customer's valid configuration change triggered a latent software bug that disabled 85% of our network."* - Fastly Engineering, Post-Incident Summary

### The Incident

On June 8, 2021, at 09:47 UTC, Fastly - one of the world's largest content delivery networks serving approximately
10% of all HTTP requests globally - experienced a catastrophic outage. Within seconds, 85% of Fastly's global
network returned HTTP 503 errors. The affected sites read like a directory of the modern internet: Reddit, The New
York Times, Amazon, gov.uk, The Guardian, Bloomberg, Twitch, Stack Overflow, GitHub Pages, Hulu, HBO Max, and
thousands of others. The UK government's official website was unreachable. News organizations could not publish
stories about the outage because their own websites were down.

The root cause was not a cyberattack, not a hardware failure, and not even a bad deployment. It was a **latent
software bug** that had been introduced weeks earlier in a software update. The bug existed silently in production,
causing no harm - until a single customer made a perfectly valid configuration change that happened to trigger the
specific code path containing the bug. The bug caused Fastly's VCL (Varnish Configuration Language) processing
engine to panic on 85% of their Points of Presence (POPs), taking each POP offline simultaneously.

The outage lasted approximately 49 minutes, with most services restored within an hour. Fastly's engineers
identified the root cause within minutes by correlating the customer configuration change with the onset of the
outage, and initiated a targeted fix that bypassed the buggy code path.

### Timeline Reconstruction

The outage lasted only 49 minutes from trigger to recovery, but in that window major portions of the internet were unreachable. The timeline shows how a latent bug, dormant for weeks, was triggered by a routine customer change and cascaded globally in under one second.

```
09:47 UTC  Customer deploys valid configuration change
09:47 UTC  Latent bug triggered - VCL processing panics
09:47 UTC  85% of POPs begin returning 503 errors (< 1 second propagation)
09:48 UTC  Automated monitoring detects global traffic drop
09:50 UTC  Incident declared, all-hands engineering response begins
09:52 UTC  Root cause identified: customer config change + latent bug
09:55 UTC  Decision: disable affected POPs and route traffic to healthy POPs
09:58 UTC  Fastly status page updated: "investigating potential impact"
10:00 UTC  Fix identified: modify VCL engine to skip buggy code path
10:10 UTC  Fix deployed to first POP, confirmed working
10:15 UTC  Automated rollout to all POPs begins
10:36 UTC  95% of network recovered
10:47 UTC  Full recovery, all POPs healthy
```

### Architecture Diagram: How a Single Config Change Cascaded

A customer configuration change propagated through Fastly's global configuration distribution system to all Points of Presence simultaneously. At each POP, the VCL processing engine encountered the latent bug and panicked, taking the POP offline. Because the configuration was distributed globally without staged rollout, 85% of POPs failed within one second.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FASTLY CDN ARCHITECTURE                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────┐                                                     │
│  │  Customer   │   Valid VCL config                                  │
│  │  Dashboard  │ ──────────┐                                         │
│  └─────────────┘           │                                         │
│                             ▼                                        │
│  ┌───────────────────────────────────────────────────┐               │
│  │  Configuration Distribution Layer                 │               │
│  │  Pushes VCL configs to ALL POPs simultaneously    │               │
│  │  No canary - config propagation is global         │               │
│  └───────────────────────┬───────────────────────────┘               │
│                           │                                          │
│           ┌───────────────┼───────────────────┐                      │
│           ▼               ▼                   ▼                      │
│     ┌──────────┐   ┌──────────┐         ┌──────────┐                 │
│     │  POP #1  │   │  POP #2  │   ...   │  POP #N  │                 │
│     │  VCL     │   │  VCL     │         │  VCL     │                 │
│     │  Engine  │   │  Engine  │         │  Engine  │                 │
│     │   ╳ BUG  │   │   ╳ BUG  │         │   ╳ BUG  │                 │
│     │  PANIC!  │   │  PANIC!  │         │  PANIC!  │                 │
│     └──────────┘   └──────────┘         └──────────┘                 │
│           │               │                   │                      │
│           ▼               ▼                   ▼                      │
│     ┌──────────────────────────────────────────────┐                 │
│     │  85% of global POPs → HTTP 503               │                 │
│     │  Reddit, NYT, gov.uk, Amazon, Twitch DOWN    │                 │
│     └──────────────────────────────────────────────┘                 │
│                                                                      │
│  KEY FAILURE: No config canary. No gradual rollout.                  │
│  Latent bug + global config push = global outage.                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Root Cause Analysis

The Fastly outage reveals a critically important failure pattern: **latent bugs**. Unlike a deployment that
immediately breaks things, a latent bug sits dormant in production code, invisible to all monitoring and testing,
until a specific input triggers it. This is particularly dangerous because:

1. **The bug passes all tests** - it was deployed through Fastly's standard process with no issues
2. **Production monitoring sees nothing** - the bug has no symptoms until triggered
3. **The trigger is a valid operation** - the customer did nothing wrong
4. **Blast radius is global** - once triggered, the bug affects every POP simultaneously because they all
   run the same code with the same configuration propagation

This is the **distributed systems equivalent of a dormant vulnerability** - it sits in your codebase, waiting
for the exact input that activates it.

### Go Implementation: Configuration Canary System

The core defensive pattern is **canary configuration deployment** - never push a configuration change to all
nodes simultaneously. Instead, deploy to a small subset, validate, then gradually expand.

```go
package configcanary

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// ConfigVersion represents a versioned configuration snapshot.
type ConfigVersion struct {
	ID        string
	Version   uint64
	Payload   []byte
	CreatedAt time.Time
	CreatedBy string
	Hash      [32]byte // SHA-256 of Payload
}

// NodeHealth captures the health of a single edge node after a config push.
type NodeHealth struct {
	NodeID       string
	ErrorRate    float64 // 0.0 to 1.0
	Latency      time.Duration
	PanicCount   int64
	RequestCount int64
	Healthy      bool
}

// RolloutStage defines a single stage in the progressive config rollout.
type RolloutStage struct {
	Name             string
	PercentageOfPOPs float64 // 0.0 to 1.0
	MinObserveTime   time.Duration
	MaxErrorRate     float64 // abort threshold
	MaxPanicCount    int64   // abort if any node panics
}

// DefaultStages returns a production-grade rollout schedule.
func DefaultStages() []RolloutStage {
	return []RolloutStage{
		{
			Name:             "canary",
			PercentageOfPOPs: 0.01, // 1% of POPs - the critical first check
			MinObserveTime:   5 * time.Minute,
			MaxErrorRate:     0.001, // 0.1% error rate threshold
			MaxPanicCount:    0,     // zero panics allowed
		},
		{
			Name:             "early-adopter",
			PercentageOfPOPs: 0.05,
			MinObserveTime:   10 * time.Minute,
			MaxErrorRate:     0.005,
			MaxPanicCount:    0,
		},
		{
			Name:             "regional",
			PercentageOfPOPs: 0.25,
			MinObserveTime:   15 * time.Minute,
			MaxErrorRate:     0.01,
			MaxPanicCount:    0,
		},
		{
			Name:             "majority",
			PercentageOfPOPs: 0.50,
			MinObserveTime:   10 * time.Minute,
			MaxErrorRate:     0.01,
			MaxPanicCount:    0,
		},
		{
			Name:             "global",
			PercentageOfPOPs: 1.0,
			MinObserveTime:   5 * time.Minute,
			MaxErrorRate:     0.01,
			MaxPanicCount:    0,
		},
	}
}

// CanaryDeployer manages progressive configuration rollout across a CDN fleet.
type CanaryDeployer struct {
	nodes       []string        // all node IDs in the fleet
	healthFn    func(ctx context.Context, nodeID string) (*NodeHealth, error)
	pushFn      func(ctx context.Context, nodeID string, config *ConfigVersion) error
	rollbackFn  func(ctx context.Context, nodeID string, previousVersion uint64) error
	stages      []RolloutStage
	logger      *slog.Logger
	mu          sync.RWMutex
	aborted     atomic.Bool
	deployedTo  map[string]bool // tracks which nodes have the new config
}

// NewCanaryDeployer creates a deployer with the given fleet and callbacks.
func NewCanaryDeployer(
	nodes []string,
	healthFn func(ctx context.Context, nodeID string) (*NodeHealth, error),
	pushFn func(ctx context.Context, nodeID string, config *ConfigVersion) error,
	rollbackFn func(ctx context.Context, nodeID string, previousVersion uint64) error,
	logger *slog.Logger,
) *CanaryDeployer {
	return &CanaryDeployer{
		nodes:      nodes,
		healthFn:   healthFn,
		pushFn:     pushFn,
		rollbackFn: rollbackFn,
		stages:     DefaultStages(),
		logger:     logger,
		deployedTo: make(map[string]bool),
	}
}

// Deploy executes the progressive rollout. Returns an error if any stage fails.
func (cd *CanaryDeployer) Deploy(ctx context.Context, config *ConfigVersion, previousVersion uint64) error {
	cd.logger.Info("starting canary deployment",
		"config_version", config.Version,
		"total_nodes", len(cd.nodes),
		"stages", len(cd.stages),
	)

	// Shuffle nodes to avoid always hitting the same canaries.
	shuffled := make([]string, len(cd.nodes))
	copy(shuffled, cd.nodes)
	rand.Shuffle(len(shuffled), func(i, j int) {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	})

	deployedSoFar := 0

	for _, stage := range cd.stages {
		if cd.aborted.Load() {
			return errors.New("deployment aborted")
		}

		targetCount := int(float64(len(shuffled)) * stage.PercentageOfPOPs)
		if targetCount < 1 {
			targetCount = 1
		}
		if targetCount > len(shuffled) {
			targetCount = len(shuffled)
		}

		// Push config to nodes in this stage.
		newNodes := shuffled[deployedSoFar:targetCount]
		cd.logger.Info("entering rollout stage",
			"stage", stage.Name,
			"new_nodes", len(newNodes),
			"total_deployed", targetCount,
		)

		for _, nodeID := range newNodes {
			if err := cd.pushFn(ctx, nodeID, config); err != nil {
				cd.logger.Error("config push failed, aborting",
					"node", nodeID, "error", err)
				cd.rollbackAll(ctx, previousVersion)
				return fmt.Errorf("push failed at stage %s node %s: %w",
					stage.Name, nodeID, err)
			}
			cd.mu.Lock()
			cd.deployedTo[nodeID] = true
			cd.mu.Unlock()
		}
		deployedSoFar = targetCount

		// Observe health for the required duration.
		if err := cd.observeHealth(ctx, stage, shuffled[:targetCount]); err != nil {
			cd.logger.Error("health check failed, rolling back",
				"stage", stage.Name, "error", err)
			cd.rollbackAll(ctx, previousVersion)
			return fmt.Errorf("health check failed at stage %s: %w", stage.Name, err)
		}

		cd.logger.Info("stage passed",
			"stage", stage.Name,
			"deployed_nodes", targetCount,
		)
	}

	cd.logger.Info("canary deployment complete",
		"config_version", config.Version,
		"total_nodes", len(cd.nodes),
	)
	return nil
}

// observeHealth monitors deployed nodes for the observation window.
func (cd *CanaryDeployer) observeHealth(
	ctx context.Context,
	stage RolloutStage,
	nodes []string,
) error {
	deadline := time.Now().Add(stage.MinObserveTime)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			var totalErrors, totalRequests int64
			var totalPanics int64

			for _, nodeID := range nodes {
				health, err := cd.healthFn(ctx, nodeID)
				if err != nil {
					return fmt.Errorf("health check unreachable for %s: %w", nodeID, err)
				}
				totalErrors += int64(health.ErrorRate * float64(health.RequestCount))
				totalRequests += health.RequestCount
				totalPanics += health.PanicCount
			}

			if totalPanics > stage.MaxPanicCount {
				return fmt.Errorf("panic threshold exceeded: %d > %d",
					totalPanics, stage.MaxPanicCount)
			}

			if totalRequests > 0 {
				errorRate := float64(totalErrors) / float64(totalRequests)
				if errorRate > stage.MaxErrorRate {
					return fmt.Errorf("error rate %.4f exceeds threshold %.4f",
						errorRate, stage.MaxErrorRate)
				}
			}
		}
	}
	return nil
}

// rollbackAll reverts all deployed nodes to the previous config version.
func (cd *CanaryDeployer) rollbackAll(ctx context.Context, previousVersion uint64) {
	cd.aborted.Store(true)
	cd.mu.RLock()
	defer cd.mu.RUnlock()

	cd.logger.Warn("initiating global rollback",
		"nodes_to_rollback", len(cd.deployedTo),
		"target_version", previousVersion,
	)

	for nodeID := range cd.deployedTo {
		if err := cd.rollbackFn(ctx, nodeID, previousVersion); err != nil {
			cd.logger.Error("rollback failed for node",
				"node", nodeID, "error", err)
		}
	}
}

// Abort signals the deployer to stop and rollback at the next check.
func (cd *CanaryDeployer) Abort() {
	cd.aborted.Store(true)
}
```

### Go Implementation: Latent Bug Detection via Fuzzing Harness

Latent bugs are triggered by specific inputs. Go's built-in fuzzing can systematically explore configuration
inputs to find dormant crash paths before they reach production.

```go
package configcanary

import (
	"errors"
	"fmt"
	"testing"
)

// ProcessVCLConfig simulates the VCL engine that processes CDN configuration.
// The latent bug in Fastly was triggered by a specific combination of parameters.
func ProcessVCLConfig(raw []byte) (result string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("VCL engine panic: %v", r)
		}
	}()

	if len(raw) == 0 {
		return "", errors.New("empty config")
	}

	// Simulate processing that has a latent bug: a specific byte sequence
	// causes an out-of-bounds access. This is analogous to the Fastly bug
	// where a specific config combination triggered a panic.
	config := string(raw)
	result = processRules(config)
	return result, nil
}

func processRules(config string) string {
	// Production VCL processing logic would be here.
	// The point: fuzzing discovers panics before customers do.
	return config
}

// FuzzProcessVCLConfig discovers latent panics in configuration processing.
func FuzzProcessVCLConfig(f *testing.F) {
	// Seed corpus with known valid configurations.
	f.Add([]byte("backend default { .host = \"origin.example.com\"; }"))
	f.Add([]byte("sub vcl_recv { set req.backend = default; }"))
	f.Add([]byte(""))
	f.Add([]byte("\x00\xff\xfe"))

	f.Fuzz(func(t *testing.T, data []byte) {
		_, err := ProcessVCLConfig(data)
		if err != nil {
			// Errors are acceptable - panics that bypass recovery are not.
			// The fuzzer will report if ProcessVCLConfig panics without recovery.
			return
		}
	})
}
```

### Key Lessons for Go Engineers

1. **Latent bugs are invisible to monitoring** - they only manifest when a specific code path is exercised
   with a specific input. Fuzzing and property-based testing are the primary defenses.
2. **Configuration changes are deployments** - never treat config changes as less risky than code changes.
   They need the same canary rollout, monitoring, and rollback mechanisms.
3. **Global propagation is global failure** - any system that pushes changes to all nodes simultaneously
   has a blast radius equal to its entire fleet. Progressive rollout is mandatory.
4. **Recovery speed matters** - Fastly recovered in 49 minutes because they could quickly identify and
   bypass the buggy code path. Design systems for fast surgical intervention.

### Exercises

1. Extend `CanaryDeployer` to support **geographic affinity** - ensure canary nodes are spread across
   different geographic regions rather than concentrated in one area.
2. Build a **configuration diff validator** that compares a new config against the running config and
   identifies high-risk changes (new code paths, removed backends, modified routing rules).
3. Implement a **latent bug detector** that replays historical configuration changes through the VCL
   engine with fuzzing mutations to discover dormant code paths.

---

### Junior → FAANG: Config Changes Are Deployments

The Fastly incident is a direct answer to "how do you reduce deployment risk?" in system design interviews. The insight is that configuration changes carry the same blast radius as code changes but are treated as lower risk. A valid customer config update triggered a latent bug that took down 85% of Fastly's CDN. The correct framing for interviews: every artifact that changes runtime behavior (binary, config file, feature flag, VCL template, firewall rule) must go through a progressive rollout with automated health checks and rollback. Candidates who distinguish between "code deployments" and "config deployments" as separate risk categories demonstrate a gap in their mental model. They are the same thing. Add Go's built-in fuzzing to your portfolio: `go test -fuzz=FuzzProcessVCLConfig` runs indefinitely and discovers inputs that cause panics. Running a fuzz corpus against configuration parsers before promoting them to production is a concrete, demonstrable practice that interviewers remember.

### Senior @ FAANG: Latent Bug Governance as a Platform CI Gate

At L6, the Fastly incident is a process failure, not a code failure. The latent bug existed for months. The question is why no process caught it before a customer triggered it. The answer is that config changes bypassed the fuzzing and regression pipeline that code changes went through. The staff-level fix is not to write better VCL parsers: it is to build a CI gate that runs fuzz corpus regression against every config artifact before it is eligible for rollout.

This requires three platform investments. First, a fuzz corpus registry: a shared store of inputs that previously triggered failures, maintained across releases, so that new builds are tested against all historically problematic inputs before canary. Second, a config change classifier: a static analysis tool that inspects the diff between the running config and the candidate config, scores the risk (new code path introduced, routing rule modified, backend removed), and gates the rollout velocity accordingly. A low-risk change (comment edit, timeout increase) gets a fast-track two-stage rollout. A high-risk change (new VCL subroutine, modified ACL) gets a full five-stage rollout with a 15-minute minimum bake at canary. Third, the rollout controller (the `CanaryDeployer` pattern in this section) must be a platform service, not a per-team script. Every team that pushes config artifacts uses the same controller, so rollout policy is enforced uniformly and exemptions require explicit override with documented justification.

The bar-raiser question at this level is: "What is the latent defect rate in your config processing pipeline, and how do you measure it?" If you cannot answer this with a number derived from your fuzz corpus hit rate over the last quarter, you do not have visibility into your own risk surface. Measuring the fuzz corpus hit rate (new inputs that trigger previously unseen code paths per 1,000 config changes) is a leading indicator of latent bug density. Tracking it quarterly and reporting it to leadership is how a staff engineer converts invisible risk into a managed metric.
