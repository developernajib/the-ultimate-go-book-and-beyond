## Section 4: Chaos Engineering with Go

Chaos engineering is the practice of deliberately introducing failures into a production (or production-like) environment to verify that the system remains resilient. Netflix pioneered Chaos Monkey, and at FAANG scale, chaos is continuous, automated, and hypothesis-driven.

### 4.1 The Chaos Hypothesis Model

Every chaos experiment must follow:

1. **Steady State**: Define measurable normal behavior (p99 latency < 50ms, error rate < 0.1%)
2. **Hypothesis**: "The system will maintain steady state when X fails"
3. **Variable**: The fault to inject (kill a pod, add latency, drop packets)
4. **Rollback**: Automatic abort if steady state is violated beyond threshold

```go
// file: internal/chaos/experiment.go
package chaos

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// SteadyStateCheck measures a system property and returns whether it is healthy.
type SteadyStateCheck func(ctx context.Context) (healthy bool, metric float64, err error)

// FaultInjector applies and removes a fault.
type FaultInjector interface {
	Name() string
	Inject(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// ExperimentConfig defines a chaos experiment.
type ExperimentConfig struct {
	Name            string
	Description     string
	SteadyState     SteadyStateCheck
	Injector        FaultInjector
	Duration        time.Duration
	CheckInterval   time.Duration
	AbortThreshold  float64 // abort if metric degrades beyond this fraction
	DryRun          bool
}

// ExperimentResult captures the outcome.
type ExperimentResult struct {
	Name        string
	StartedAt   time.Time
	EndedAt     time.Time
	Hypothesis  string
	Passed      bool
	Aborted     bool
	AbortReason string
	Metrics     []MetricSample
}

// MetricSample is a time-stamped measurement during the experiment.
type MetricSample struct {
	Timestamp time.Time
	Value     float64
	Healthy   bool
}

// Runner executes chaos experiments.
type Runner struct {
	logger *slog.Logger
	mu     sync.Mutex
	active bool
}

func NewRunner(logger *slog.Logger) *Runner {
	return &Runner{logger: logger.With("component", "chaos_runner")}
}

// Run executes a single chaos experiment.
func (r *Runner) Run(ctx context.Context, cfg ExperimentConfig) (*ExperimentResult, error) {
	r.mu.Lock()
	if r.active {
		r.mu.Unlock()
		return nil, errors.New("another chaos experiment is already active")
	}
	r.active = true
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.active = false
		r.mu.Unlock()
	}()

	result := &ExperimentResult{
		Name:      cfg.Name,
		StartedAt: time.Now().UTC(),
	}

	r.logger.InfoContext(ctx, "chaos experiment starting",
		"name", cfg.Name,
		"description", cfg.Description,
		"duration", cfg.Duration,
		"dry_run", cfg.DryRun,
	)

	// Establish steady state before injecting fault.
	healthy, baselineMetric, err := cfg.SteadyState(ctx)
	if err != nil {
		return nil, fmt.Errorf("steady state check failed before experiment: %w", err)
	}
	if !healthy {
		return nil, fmt.Errorf("system not in steady state before experiment (metric=%.4f); aborting", baselineMetric)
	}

	r.logger.InfoContext(ctx, "steady state confirmed",
		"baseline_metric", baselineMetric,
	)

	// Inject the fault (unless dry run).
	if !cfg.DryRun {
		if err := cfg.Injector.Inject(ctx); err != nil {
			return nil, fmt.Errorf("inject fault %s: %w", cfg.Injector.Name(), err)
		}
		r.logger.InfoContext(ctx, "fault injected", "injector", cfg.Injector.Name())
	}

	// Always ensure rollback on exit.
	defer func() {
		if !cfg.DryRun {
			rbCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if rbErr := cfg.Injector.Rollback(rbCtx); rbErr != nil {
				r.logger.ErrorContext(rbCtx, "fault rollback failed",
					"injector", cfg.Injector.Name(),
					"error", rbErr,
				)
			} else {
				r.logger.InfoContext(rbCtx, "fault rolled back", "injector", cfg.Injector.Name())
			}
		}
		result.EndedAt = time.Now().UTC()
	}()

	// Monitor steady state during the experiment.
	experimentCtx, cancel := context.WithTimeout(ctx, cfg.Duration)
	defer cancel()

	ticker := time.NewTicker(cfg.CheckInterval)
	defer ticker.Stop()

	passed := true
	for {
		select {
		case <-experimentCtx.Done():
			// Experiment duration elapsed normally.
			result.Passed = passed
			r.logger.InfoContext(ctx, "chaos experiment complete",
				"name", cfg.Name,
				"passed", passed,
				"samples", len(result.Metrics),
			)
			return result, nil

		case <-ticker.C:
			healthy, metric, checkErr := cfg.SteadyState(ctx)
			sample := MetricSample{
				Timestamp: time.Now().UTC(),
				Value:     metric,
				Healthy:   healthy,
			}
			result.Metrics = append(result.Metrics, sample)

			if checkErr != nil {
				r.logger.WarnContext(ctx, "steady state check error during experiment",
					"error", checkErr,
				)
				continue
			}

			// Check abort threshold: if metric has degraded by more than threshold.
			if baselineMetric > 0 && metric > baselineMetric*(1+cfg.AbortThreshold) {
				result.Aborted = true
				result.AbortReason = fmt.Sprintf(
					"metric %.4f exceeded abort threshold (baseline=%.4f, threshold=%.2f%%)",
					metric, baselineMetric, cfg.AbortThreshold*100,
				)
				result.Passed = false
				r.logger.ErrorContext(ctx, "experiment aborted",
					"reason", result.AbortReason,
				)
				cancel() // stop the experiment
				return result, nil
			}

			if !healthy {
				passed = false
				r.logger.WarnContext(ctx, "steady state violated during experiment",
					"metric", metric,
					"baseline", baselineMetric,
				)
			}
		}
	}
}
```

### 4.2 Fault Injectors

Fault injectors are the building blocks of chaos engineering: each injector targets a specific failure mode (network latency, CPU saturation, disk I/O errors, service crashes) and can be activated and deactivated programmatically during a chaos experiment. The following Go implementation defines a `FaultInjector` interface with implementations for latency injection, resource exhaustion, and process termination.

```go
// file: internal/chaos/injectors.go
package chaos

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// LatencyInjector adds artificial latency to an HTTP transport.
type LatencyInjector struct {
	name       string
	transport  *InstrumentedTransport
	latency    time.Duration
	percentage float64 // fraction of requests to affect
	logger     *slog.Logger
}

// InstrumentedTransport is a replaceable http.RoundTripper with injected latency.
type InstrumentedTransport struct {
	mu      sync.RWMutex
	base    http.RoundTripper
	latency time.Duration
	pct     float64
	counter atomic.Int64
}

func (t *InstrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.RLock()
	lat := t.latency
	pct := t.pct
	t.mu.RUnlock()

	if lat > 0 && pct > 0 {
		count := t.counter.Add(1)
		// Inject latency for the configured percentage of requests.
		if float64(count%100)/100.0 < pct {
			select {
			case <-time.After(lat):
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
	}
	return t.base.RoundTrip(req)
}

func NewLatencyInjector(
	transport *InstrumentedTransport,
	latency time.Duration,
	percentage float64,
	logger *slog.Logger,
) *LatencyInjector {
	return &LatencyInjector{
		name:       fmt.Sprintf("latency_%s_%.0fpct", latency, percentage*100),
		transport:  transport,
		latency:    latency,
		percentage: percentage,
		logger:     logger,
	}
}

func (i *LatencyInjector) Name() string { return i.name }

func (i *LatencyInjector) Inject(ctx context.Context) error {
	i.transport.mu.Lock()
	defer i.transport.mu.Unlock()
	i.transport.latency = i.latency
	i.transport.pct = i.percentage
	i.logger.InfoContext(ctx, "latency injected",
		"latency", i.latency,
		"percentage", i.percentage,
	)
	return nil
}

func (i *LatencyInjector) Rollback(ctx context.Context) error {
	i.transport.mu.Lock()
	defer i.transport.mu.Unlock()
	i.transport.latency = 0
	i.transport.pct = 0
	i.logger.InfoContext(ctx, "latency removed")
	return nil
}

// ProcessKillInjector kills a process by name to simulate service crash.
type ProcessKillInjector struct {
	processName string
	startCmd    []string // command to restart the process
	pid         int
	logger      *slog.Logger
}

func NewProcessKillInjector(processName string, startCmd []string, logger *slog.Logger) *ProcessKillInjector {
	return &ProcessKillInjector{
		processName: processName,
		startCmd:    startCmd,
		logger:      logger,
	}
}

func (i *ProcessKillInjector) Name() string {
	return fmt.Sprintf("process_kill_%s", i.processName)
}

func (i *ProcessKillInjector) Inject(ctx context.Context) error {
	// Find PID by name using pgrep.
	out, err := exec.CommandContext(ctx, "pgrep", "-f", i.processName).Output()
	if err != nil {
		return fmt.Errorf("pgrep %s: %w", i.processName, err)
	}

	var pid int
	if _, err := fmt.Sscanf(string(out), "%d", &pid); err != nil {
		return fmt.Errorf("parse pid from pgrep output: %w", err)
	}

	i.pid = pid
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process %d: %w", pid, err)
	}

	if err := proc.Kill(); err != nil {
		return fmt.Errorf("kill process %d (%s): %w", pid, i.processName, err)
	}

	i.logger.InfoContext(ctx, "process killed",
		"process", i.processName,
		"pid", pid,
	)
	return nil
}

func (i *ProcessKillInjector) Rollback(ctx context.Context) error {
	if len(i.startCmd) == 0 {
		i.logger.WarnContext(ctx, "no restart command configured; process not restarted",
			"process", i.processName,
		)
		return nil
	}

	cmd := exec.CommandContext(ctx, i.startCmd[0], i.startCmd[1:]...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("restart %s: %w", i.processName, err)
	}

	i.logger.InfoContext(ctx, "process restarted",
		"process", i.processName,
		"new_pid", cmd.Process.Pid,
	)
	return nil
}

// PacketDropInjector uses tc/iptables to drop a percentage of packets.
// Requires root or CAP_NET_ADMIN.
type PacketDropInjector struct {
	iface      string
	dropPct    int // 0-100
	logger     *slog.Logger
}

func NewPacketDropInjector(iface string, dropPct int, logger *slog.Logger) *PacketDropInjector {
	return &PacketDropInjector{iface: iface, dropPct: dropPct, logger: logger}
}

func (i *PacketDropInjector) Name() string {
	return fmt.Sprintf("packet_drop_%s_%dpct", i.iface, i.dropPct)
}

func (i *PacketDropInjector) Inject(ctx context.Context) error {
	// tc qdisc add dev eth0 root netem loss 10%
	args := []string{
		"qdisc", "add", "dev", i.iface,
		"root", "netem", "loss", fmt.Sprintf("%d%%", i.dropPct),
	}
	if err := exec.CommandContext(ctx, "tc", args...).Run(); err != nil {
		return fmt.Errorf("tc qdisc add (packet drop %d%% on %s): %w", i.dropPct, i.iface, err)
	}
	i.logger.InfoContext(ctx, "packet drop injected",
		"interface", i.iface,
		"drop_percent", i.dropPct,
	)
	return nil
}

func (i *PacketDropInjector) Rollback(ctx context.Context) error {
	args := []string{"qdisc", "del", "dev", i.iface, "root"}
	if err := exec.CommandContext(ctx, "tc", args...).Run(); err != nil {
		return fmt.Errorf("tc qdisc del on %s: %w", i.iface, err)
	}
	i.logger.InfoContext(ctx, "packet drop removed", "interface", i.iface)
	return nil
}

// CPUSpikeInjector consumes CPU to simulate resource exhaustion.
type CPUSpikeInjector struct {
	goroutines int
	stopCh     chan struct{}
	logger     *slog.Logger
}

func NewCPUSpikeInjector(goroutines int, logger *slog.Logger) *CPUSpikeInjector {
	return &CPUSpikeInjector{
		goroutines: goroutines,
		stopCh:     make(chan struct{}),
		logger:     logger,
	}
}

func (i *CPUSpikeInjector) Name() string {
	return fmt.Sprintf("cpu_spike_%d_goroutines", i.goroutines)
}

func (i *CPUSpikeInjector) Inject(ctx context.Context) error {
	i.stopCh = make(chan struct{})
	for n := 0; n < i.goroutines; n++ {
		go func() {
			for {
				select {
				case <-i.stopCh:
					return
				default:
					// Busy-loop to consume CPU.
					_ = n * n
				}
			}
		}()
	}
	i.logger.InfoContext(ctx, "CPU spike injected", "goroutines", i.goroutines)
	return nil
}

func (i *CPUSpikeInjector) Rollback(ctx context.Context) error {
	close(i.stopCh)
	i.logger.InfoContext(ctx, "CPU spike removed")
	return nil
}
```

---

### Junior -> FAANG: Chaos Engineering as a Structured Testing Discipline

The hypothesis model described at the start of this section is the most important concept to internalize before any chaos engineering conversation. Without a hypothesis, you are not doing chaos engineering, you are doing random fault injection. The difference is observable in results: a hypothesis-driven experiment produces a measurable answer ("the system maintained P99 below 200ms under this fault condition") while random injection produces only "we broke things and some stuff recovered."

For interview preparation, memorize the four-step pattern: steady state, hypothesis, experiment, analysis. Be able to apply it to a concrete scenario: "We hypothesize that killing the primary database node will trigger Patroni promotion within 30 seconds, and the service will resume serving writes within 60 seconds. We measure this by running 10 writes per second during the kill and observing the gap between the last successful write before kill and the first successful write after promotion."

The Go-specific implementation advantage is the `context` package. Chaos experiments need to run for a fixed duration and then stop. A context with deadline is the natural expression of this: `ctx, cancel := context.WithTimeout(parent, experimentDuration)`. When the context expires, the chaos goroutine stops, and automated rollback fires. This is why Go is a good language for chaos tooling.

### Senior @ FAANG: Production Chaos Engineering Program Design

**Chaos experiment catalog and ownership.** A mature chaos engineering program maintains a catalog of all approved experiments: what fault is injected, what service it targets, what the blast radius limit is, who is the approver, and what the rollback procedure is. New experiments are reviewed by the SRE lead before being added to the catalog. Unapproved experiments in production are incidents, not experiments. At L7, you build the catalog governance process, not just individual experiments.

**Continuous chaos versus scheduled GameDays.** Scheduled GameDays are valuable but they test a point-in-time behavior. Continuous chaos (experiments running automatically on a schedule during low-traffic windows) tests behavior under the normal operational state of the system, catching regressions introduced by recent deployments. At Netflix's maturity level, most chaos experiments run continuously. The transition from scheduled to continuous requires: automated rollback, blast radius limits enforced by the platform, and steady-state monitoring that can distinguish chaos-induced degradation from organic degradation.

**Measuring experiment outcomes against steady-state baselines.** The chaos framework in this section injects faults but does not measure whether steady state is maintained during injection. A production chaos platform queries Prometheus or Datadog for the specific metrics defined in the steady-state hypothesis and compares them against the pre-experiment baseline. If P99 latency exceeds 150% of baseline during the experiment, the experiment stops and the rollback fires automatically. The measurement system is as important as the injection system.

**Chaos engineering and on-call morale.** Running chaos experiments without warning the on-call engineer is a trust violation. Even well-designed experiments can trigger alerts, and an on-call who receives an alert without knowing a chaos experiment is running wastes 10-30 minutes diagnosing a problem that is intentional. Production chaos programs notify the on-call before each experiment, provide a direct link to the experiment status page, and include a one-click abort button. Respecting on-call time builds the organizational trust that allows chaos programs to run continuously rather than being canceled after the first unexpected alert.

