## 26.10 Company Case Studies

### Google: Gradualized Releases with Flag Guards

Google rolls out features through a series of stages, 1%, 5%, 10%, 25%, 50%, 100%, with automatic metric checks at each gate. If error rates or latency exceed thresholds, the rollout pauses or rolls back automatically. The `GraduatedRollout` struct below models this pattern: each stage specifies a target percentage, a minimum soak duration, and a set of metric checks that must pass before the system advances to the next stage.

```go
// Example: Google-style graduated rollout

package rollout

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// GraduatedRollout implements Google-style gradual rollout.
type GraduatedRollout struct {
	flagKey       string
	stages        []RolloutStage
	currentStage  int
	metrics       MetricsChecker
	updater       FlagUpdater
	alerter       Alerter
	logger        *slog.Logger
	mu            sync.RWMutex
	checkInterval time.Duration
}

// RolloutStage defines a stage in graduated rollout.
type RolloutStage struct {
	Percentage     int           // Target percentage
	MinDuration    time.Duration // Minimum time at this stage
	RequiredMetrics []MetricCheck // Metrics that must pass
}

// MetricCheck defines a metric to check before advancing.
type MetricCheck struct {
	Name      string
	Threshold float64
	Operator  string // "lt", "gt", "eq"
}

// MetricsChecker reads a metric for a flag. Implementations query Prometheus,
// Monarch, CloudWatch, or whatever your SRE stack exposes. It returns an error
// rather than a bare float: see the note below on why that matters here.
type MetricsChecker interface {
	GetMetric(ctx context.Context, flagKey, metric string) (float64, error)
}

// Alerter notifies humans when a rollout stalls or reverses.
type Alerter interface {
	Alert(ctx context.Context, flagKey, message string) error
}

// FlagUpdater applies a new rollout percentage to the flag store.
type FlagUpdater interface {
	SetPercentage(ctx context.Context, flagKey string, percentage int) error
}

// NewGraduatedRollout creates a new graduated rollout. Every collaborator is
// injected: a nil MetricsChecker would panic on the first tick, and a rollout
// driver that panics is worse than no rollout driver.
func NewGraduatedRollout(
	flagKey string,
	metrics MetricsChecker,
	updater FlagUpdater,
	alerter Alerter,
	logger *slog.Logger,
) (*GraduatedRollout, error) {
	if metrics == nil || updater == nil || alerter == nil || logger == nil {
		return nil, errors.New("rollout: metrics, updater, alerter and logger are all required")
	}
	return &GraduatedRollout{
		flagKey: flagKey,
		stages: []RolloutStage{
			{Percentage: 1, MinDuration: 1 * time.Hour, RequiredMetrics: defaultMetrics()},
			{Percentage: 5, MinDuration: 2 * time.Hour, RequiredMetrics: defaultMetrics()},
			{Percentage: 10, MinDuration: 4 * time.Hour, RequiredMetrics: defaultMetrics()},
			{Percentage: 25, MinDuration: 8 * time.Hour, RequiredMetrics: defaultMetrics()},
			{Percentage: 50, MinDuration: 24 * time.Hour, RequiredMetrics: defaultMetrics()},
			{Percentage: 100, MinDuration: 0, RequiredMetrics: nil},
		},
		metrics:       metrics,
		updater:       updater,
		alerter:       alerter,
		logger:        logger,
		checkInterval: 5 * time.Minute,
	}, nil
}

// updatePercentage applies the stage percentage to the flag store.
func (g *GraduatedRollout) updatePercentage(ctx context.Context, pct int) error {
	if err := g.updater.SetPercentage(ctx, g.flagKey, pct); err != nil {
		g.logger.Error("failed to update rollout percentage",
			"flag", g.flagKey, "percentage", pct, "error", err)
		return err
	}
	return nil
}

func defaultMetrics() []MetricCheck {
	return []MetricCheck{
		{Name: "error_rate", Threshold: 0.01, Operator: "lt"},    // <1% errors
		{Name: "p99_latency_ms", Threshold: 500, Operator: "lt"}, // <500ms p99
		{Name: "success_rate", Threshold: 0.99, Operator: "gt"},  // >99% success
	}
}

// Start begins the graduated rollout.
func (g *GraduatedRollout) Start(ctx context.Context) error {
	g.logger.Info("starting graduated rollout",
		"flag", g.flagKey,
		"stages", len(g.stages),
	)

	ticker := time.NewTicker(g.checkInterval)
	defer ticker.Stop()

	stageStart := time.Now()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			g.mu.RLock()
			stage := g.stages[g.currentStage]
			atLastStage := g.currentStage >= len(g.stages)-1
			g.mu.RUnlock()

			if time.Since(stageStart) < stage.MinDuration {
				continue // still soaking
			}

			// Query metrics WITHOUT holding the lock. This is a network call,
			// and Rollback needs the same lock to stop a bad rollout.
			if !g.checkMetrics(ctx, stage.RequiredMetrics) {
				g.logger.Warn("metrics check failed, holding at current stage",
					"flag", g.flagKey,
					"percentage", stage.Percentage,
				)
				continue
			}

			if atLastStage {
				g.logger.Info("rollout complete", "flag", g.flagKey)
				return nil
			}

			g.mu.Lock()
			g.currentStage++
			newStage := g.stages[g.currentStage]
			g.mu.Unlock()

			stageStart = time.Now()
			g.logger.Info("advancing rollout",
				"flag", g.flagKey,
				"new_percentage", newStage.Percentage,
				"stage", g.currentStage,
			)

			if err := g.updatePercentage(ctx, newStage.Percentage); err != nil {
				// The flag store rejected the change, so the rollout is not
				// actually where we think it is. Stop and get a human.
				g.alerter.Alert(ctx, g.flagKey, "rollout advance failed: "+err.Error())
				return err
			}
		}
	}
}

// checkMetrics reports whether every required metric passes. It fails CLOSED:
// any error, any unknown operator, and any unreadable metric means "do not
// advance". Read the note below before relaxing this.
func (g *GraduatedRollout) checkMetrics(ctx context.Context, checks []MetricCheck) bool {
	for _, check := range checks {
		value, err := g.metrics.GetMetric(ctx, g.flagKey, check.Name)
		if err != nil {
			// We cannot see the metric, so we cannot claim the stage is
			// healthy. Hold position.
			g.logger.Warn("metric unavailable, refusing to advance rollout",
				"metric", check.Name, "flag", g.flagKey, "error", err)
			return false
		}

		var passed bool
		switch check.Operator {
		case "lt":
			passed = value < check.Threshold
		case "gt":
			passed = value > check.Threshold
		case "eq":
			passed = value == check.Threshold
		default:
			g.logger.Error("unknown metric operator, refusing to advance",
				"operator", check.Operator, "metric", check.Name)
			return false
		}

		if !passed {
			g.logger.Debug("metric check failed",
				"metric", check.Name,
				"value", value,
				"threshold", check.Threshold,
				"operator", check.Operator,
			)
			return false
		}
	}
	return true
}

// Rollback rolls back to previous stage or disables.
func (g *GraduatedRollout) Rollback(ctx context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.currentStage > 0 {
		g.currentStage--
		stage := g.stages[g.currentStage]
		g.logger.Warn("rolling back",
			"flag", g.flagKey,
			"new_percentage", stage.Percentage,
		)
		return g.updatePercentage(ctx, stage.Percentage)
	}

	// Disable completely
	g.logger.Warn("disabling flag", "flag", g.flagKey)
	return g.updatePercentage(ctx, 0)
}
```

> **The metric gate must fail closed, and the original could not.** `GetMetric` returned a bare `float64` with no error. Ask what that returns when Prometheus is unreachable, when the query is misspelled, or when the flag is so new that no series exists yet. The honest answer is `0`. Now walk the gate: `error_rate < 0.01` is satisfied by 0. `p99_latency_ms < 500` is satisfied by 0. Every "less than" check passes, so a monitoring outage reads as a perfectly healthy service and the rollout **accelerates through every stage to 100%** precisely when you have lost the ability to see what it is doing. The one check that would have saved you, `success_rate > 0.99`, fails on 0 and blocks the advance, so the safety of the whole system rests on an accident of which comparison operator someone happened to choose.
>
> This is the single most important idea in this section. A health gate that cannot distinguish "healthy" from "I don't know" is not a gate. Returning `(float64, error)` forces the distinction into the type, and `checkMetrics` then treats unknown exactly like unhealthy: hold position and tell a human. The same reasoning applies to the unknown-operator branch, where `passed` was left at its zero value of `false` by luck rather than intent. Write the `default` case and say what you mean.
>
> Note also that the nil `metrics` field was never assigned by the constructor, so the first tick would have dereferenced a nil interface and panicked. Injecting collaborators and rejecting nil in the constructor turns a 3am panic into a startup error.

**Google's Key Practices:**
- Graduated rollouts with automatic advancement
- Metric-based gates that fail closed: unknown health is treated as bad health
- Automatic rollback on metric degradation
- Minimum soak time at each percentage
- Integration with SRE alerting

### Netflix: Kill Switches and Circuit Breakers

Netflix treats feature flags primarily as kill switches: any feature can be disabled in seconds during an incident without a deployment. A circuit breaker layer monitors error rates within a sliding time window, and when the error threshold is exceeded, the kill switch trips automatically. Optional auto-recovery re-enables the feature after a cooldown period, preventing manual intervention for transient failures.

```go
// Example: Netflix-style kill switch implementation

package killswitch

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// KillSwitch provides rapid feature disabling.
type KillSwitch struct {
	name           string
	enabled        atomic.Bool
	tripCount      atomic.Int64
	lastTripped    atomic.Int64
	autoRecovery   bool
	recoveryDelay  time.Duration
	circuitBreaker *CircuitBreaker
	logger         *slog.Logger
	closeCh        chan struct{}
}

// CircuitBreaker provides automatic tripping based on errors.
type CircuitBreaker struct {
	errorThreshold float64
	windowSize     time.Duration
	errors         []errorEvent
	mu             sync.Mutex
}

type errorEvent struct {
	timestamp time.Time
	isError   bool
}

// NewKillSwitch creates a new kill switch. Call Close to stop the recovery
// goroutine.
func NewKillSwitch(name string, autoRecovery bool, recoveryDelay time.Duration, logger *slog.Logger) *KillSwitch {
	ks := &KillSwitch{
		name:          name,
		autoRecovery:  autoRecovery,
		recoveryDelay: recoveryDelay,
		logger:        logger,
		closeCh:       make(chan struct{}),
		circuitBreaker: &CircuitBreaker{
			errorThreshold: 0.5, // 50% error rate trips
			windowSize:     1 * time.Minute,
			errors:         make([]errorEvent, 0),
		},
	}
	ks.enabled.Store(true)

	if autoRecovery {
		go ks.recoveryLoop()
	}

	return ks
}

// Close stops the recovery loop.
func (ks *KillSwitch) Close() { close(ks.closeCh) }

// IsEnabled checks if the feature is enabled.
func (ks *KillSwitch) IsEnabled() bool {
	return ks.enabled.Load()
}

// Trip disables the feature. The CompareAndSwap makes this idempotent: only
// the first caller to flip true->false logs, so a burst of failing requests
// produces one alert rather than thousands.
func (ks *KillSwitch) Trip(reason string) {
	if ks.enabled.CompareAndSwap(true, false) {
		ks.tripCount.Add(1)
		ks.lastTripped.Store(time.Now().UnixNano())
		// Actually record the reason. A kill switch that trips without
		// saying why leaves responders guessing during an incident.
		ks.logger.Error("kill switch tripped",
			"switch", ks.name,
			"reason", reason,
			"trip_count", ks.tripCount.Load(),
		)
	}
}

// Reset re-enables the feature.
func (ks *KillSwitch) Reset() {
	if ks.enabled.CompareAndSwap(false, true) {
		ks.logger.Warn("kill switch reset", "switch", ks.name)
	}
}

// RecordResult records a success or failure.
func (ks *KillSwitch) RecordResult(isError bool) {
	ks.circuitBreaker.Record(isError)

	if ks.circuitBreaker.ShouldTrip() {
		ks.Trip("circuit breaker tripped")
	}
}

// Record records an event in the circuit breaker.
func (cb *CircuitBreaker) Record(isError bool) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.errors = append(cb.errors, errorEvent{
		timestamp: time.Now(),
		isError:   isError,
	})

	// Cleanup old events
	cutoff := time.Now().Add(-cb.windowSize)
	filtered := cb.errors[:0]
	for _, e := range cb.errors {
		if e.timestamp.After(cutoff) {
			filtered = append(filtered, e)
		}
	}
	cb.errors = filtered
}

// Reset clears the error window. Auto-recovery MUST call this: without it the
// window still holds the failures that caused the trip, so the very next
// recorded result re-trips the switch and "recovery" never happens.
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.errors = cb.errors[:0]
}

// ShouldTrip returns true if error rate exceeds threshold.
func (cb *CircuitBreaker) ShouldTrip() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if len(cb.errors) < 10 { // Minimum sample size
		return false
	}

	errorCount := 0
	for _, e := range cb.errors {
		if e.isError {
			errorCount++
		}
	}

	errorRate := float64(errorCount) / float64(len(cb.errors))
	return errorRate >= cb.errorThreshold
}

// recoveryLoop attempts automatic recovery until Close is called.
func (ks *KillSwitch) recoveryLoop() {
	ticker := time.NewTicker(ks.recoveryDelay)
	defer ticker.Stop()

	for {
		select {
		case <-ks.closeCh:
			return // without this, the goroutine outlives the KillSwitch forever
		case <-ticker.C:
			if ks.IsEnabled() {
				continue
			}
			lastTripped := time.Unix(0, ks.lastTripped.Load())
			if time.Since(lastTripped) >= ks.recoveryDelay {
				// Reset clears the switch but NOT the circuit breaker window.
				// See the note below: this matters.
				ks.circuitBreaker.Reset()
				ks.Reset()
			}
		}
	}
}
```

> **Auto-recovery that does not clear the error window is not auto-recovery.** `Reset` flipped `enabled` back to `true` and stopped there, leaving the circuit breaker's sliding window full of the failures that caused the trip. The window is one minute wide and only prunes on `Record`, so at the moment of recovery it still holds 20 errors at a 100% error rate. The first request after recovery then calls `RecordResult`, which calls `ShouldTrip`, which reads a window that is still overwhelmingly red, and trips again immediately. Measured: after recovery, the first request **succeeds** and the switch trips anyway. The feature is permanently dead despite `autoRecovery: true`, and the logs show a recovery followed instantly by a trip, over and over, which reads like a flapping dependency rather than a bug in the switch. Recovery has to clear the evidence it is recovering from.
>
> Two smaller fixes worth noting. `Trip(reason string)` accepted a reason and dropped it on the floor behind a `// Log and alert` comment, so the one artifact an on-call engineer needs at 3am, *why the feature turned itself off*, never existed. And `recoveryLoop` ran `for range ticker.C` with no exit, so every `KillSwitch` ever constructed leaked a goroutine for the life of the process. Both are the same underlying failure: the comment described the intent, and the code did not implement it. A comment is not an implementation.

**Netflix's Key Practices:**
- Kill switches for rapid incident response
- Circuit breakers for automatic protection
- Chaos engineering with feature flags
- Regional kill switches
- Integration with Spinnaker for deployment

### Uber: Experiment Platform

Uber couples feature flags with a full experimentation platform that manages traffic allocation, variant assignment, and statistical analysis. Each experiment defines a hypothesis, primary and secondary metrics, minimum sample sizes, and a set of variants with weighted traffic splits. The assignment flow first hashes the user into the experiment's traffic pool, then assigns them to a specific variant within that pool, two separate hashes that allow independent control over how many users enter the experiment and how they are distributed across variants.

```go
// Example: Uber-style experiment platform

package experiment

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// Experiment represents an A/B test.
type Experiment struct {
	Key           string
	Status        Status
	Hypothesis    string
	Metrics       []MetricDefinition
	Variants      []Variant
	// Traffic is a FRACTION in [0,1], not a percentage. 0.1 means 10% of
	// users enter the experiment. See the note below: the units of this
	// field and Variant.Traffic are the easiest thing in this file to get
	// wrong, and the failure is silent.
	Traffic       float64
	StartTime     time.Time
	EndTime       *time.Time
	MinSampleSize int
	Results       *ExperimentResults
}

// Status represents experiment status.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusRunning   Status = "running"
	StatusPaused    Status = "paused"
	StatusAnalyzing Status = "analyzing"
	StatusCompleted Status = "completed"
)

// Variant represents an experiment variant.
type Variant struct {
	Key       string
	Name      string
	Traffic   float64 // FRACTION in [0,1] within the experiment. Must sum to 1.0 across variants.
	IsControl bool
	Value     any
}

// Validate rejects an experiment whose traffic numbers cannot mean what they
// say. Catching this at creation is the difference between a rejected API call
// and an experiment that silently allocated every user to one arm.
func (e *Experiment) Validate() error {
	if e.Traffic < 0 || e.Traffic > 1 {
		return fmt.Errorf("experiment %s: traffic must be a fraction in [0,1], got %v", e.Key, e.Traffic)
	}
	sum := 0.0
	for _, v := range e.Variants {
		if v.Traffic < 0 || v.Traffic > 1 {
			return fmt.Errorf("experiment %s: variant %s traffic must be in [0,1], got %v", e.Key, v.Key, v.Traffic)
		}
		sum += v.Traffic
	}
	// Float arithmetic will not land exactly on 1.0, so allow a small epsilon.
	if math.Abs(sum-1.0) > 1e-9 {
		return fmt.Errorf("experiment %s: variant traffic sums to %v, want 1.0", e.Key, sum)
	}
	return nil
}

// MetricDefinition defines a metric to track.
type MetricDefinition struct {
	Name        string
	Type        MetricType
	MinDetectable float64 // Minimum detectable effect
	IsPrimary   bool
}

type MetricType string

const (
	MetricConversion MetricType = "conversion"
	MetricContinuous MetricType = "continuous"
	MetricCount      MetricType = "count"
)

// ExperimentResults contains analysis results.
type ExperimentResults struct {
	AnalyzedAt       time.Time
	SampleSize       int
	VariantResults   map[string]*VariantResult
	StatisticalPower float64
	Winner           string
	Confidence       float64
}

// VariantResult contains results for a single variant.
type VariantResult struct {
	SampleSize     int
	ConversionRate float64
	Mean           float64
	StdDev         float64
	Lift           float64 // vs control
	PValue         float64
	ConfidenceInterval [2]float64
}

// ExperimentService manages experiments.
type ExperimentService struct {
	experiments map[string]*Experiment
	mu          sync.RWMutex
}

// NewExperimentService creates a new experiment service.
func NewExperimentService() *ExperimentService {
	return &ExperimentService{
		experiments: make(map[string]*Experiment),
	}
}

// Assign assigns a user to an experiment variant.
func (s *ExperimentService) Assign(ctx context.Context, expKey, userID string) (*Assignment, error) {
	s.mu.RLock()
	exp, exists := s.experiments[expKey]
	s.mu.RUnlock()

	if !exists {
		return nil, nil
	}

	if exp.Status != StatusRunning {
		return nil, nil
	}

	// Check if user is in experiment traffic
	trafficBucket := calculateBucket(userID, expKey+"_traffic")
	if float64(trafficBucket) >= exp.Traffic*100 {
		return nil, nil // Not in experiment
	}

	// Assign to variant
	variantBucket := calculateBucket(userID, expKey+"_variant")
	cumulative := 0.0
	for _, variant := range exp.Variants {
		cumulative += variant.Traffic * 100
		if float64(variantBucket) < cumulative {
			return &Assignment{
				ExperimentKey: expKey,
				VariantKey:    variant.Key,
				IsControl:     variant.IsControl,
				Value:         variant.Value,
				UserID:        userID,
				AssignedAt:    time.Now(),
			}, nil
		}
	}

	return nil, nil
}

// Assignment represents a user's experiment assignment.
type Assignment struct {
	ExperimentKey string
	VariantKey    string
	IsControl     bool
	Value         any
	UserID        string
	AssignedAt    time.Time
}

// calculateBucket calculates consistent bucket 0-99.
func calculateBucket(userID, salt string) int {
	h := sha256.New()
	h.Write([]byte(userID + ":" + salt))
	hash := h.Sum(nil)
	n := binary.BigEndian.Uint32(hash[:4])
	return int(n % 100)
}

// Analyze performs statistical analysis on experiment.
func (s *ExperimentService) Analyze(ctx context.Context, expKey string) (*ExperimentResults, error) {
	// In production: fetch data from analytics warehouse
	// and perform statistical analysis

	results := &ExperimentResults{
		AnalyzedAt:     time.Now(),
		VariantResults: make(map[string]*VariantResult),
	}

	// Example: Z-test for conversion rate
	// In production: use proper statistical methods

	return results, nil
}

// ZTest performs a two-proportion Z-test and returns the Z-score.
// It returns an error rather than NaN or +Inf for the degenerate inputs that
// occur constantly in real experiments: see the note below.
func ZTest(control, treatment *VariantResult) (float64, error) {
	n1 := float64(control.SampleSize)
	n2 := float64(treatment.SampleSize)
	if n1 <= 0 || n2 <= 0 {
		return 0, errors.New("ztest: both variants need a non-zero sample size")
	}

	p1 := control.ConversionRate
	p2 := treatment.ConversionRate

	// Pooled proportion under the null hypothesis that p1 == p2.
	p := (p1*n1 + p2*n2) / (n1 + n2)

	// Standard error. This is exactly 0 when the pooled rate is 0 or 1,
	// meaning nobody converted or everybody did. Dividing by it yields
	// +Inf or NaN, which silently poisons every downstream comparison.
	se := math.Sqrt(p * (1 - p) * (1/n1 + 1/n2))
	if se == 0 {
		return 0, errors.New("ztest: zero variance (pooled conversion rate is 0 or 1), no signal to test")
	}

	return (p2 - p1) / se, nil
}
```

> **The doc comment and the code disagreed about units, and the code won.** `Traffic` was documented as "Percentage of users in experiment" while `Assign` computed `exp.Traffic*100` and compared against a 0-99 bucket, which only makes sense if `Traffic` is a fraction. Both readings are defensible from the field name. Only one is correct, and nothing in the type system says which.
>
> Follow the mistake through. An engineer reads "Percentage", writes `Traffic: 1` intending a cautious 1% experiment, and the gate computes `bucket >= 100`, which is never true for a bucket in 0-99. **Every user enters the experiment.** Measured: `Traffic: 1` puts 100% of users in, and `Traffic: 50` also puts 100% in. The intended 1% ships to everyone, and it ships *silently*, because an experiment running at 100% traffic looks exactly like an experiment running correctly except for the numbers on a dashboard nobody is watching yet. The same ambiguity in `Variant.Traffic` puts every user in the first variant.
>
> There are three fixes and you want all of them. Say the unit in the comment. Validate at creation, since `Traffic: 50` is unrepresentable as a fraction and should be rejected by the API rather than interpreted. And make variant fractions sum to 1.0, which catches the copy-paste error where a third variant is added and the split still reads 50/50. If you want to eliminate the class entirely, use a named type (`type Fraction float64`) or store integer basis points, so the compiler is the one enforcing the unit rather than a comment.
>
> **`ZTest` returned NaN on inputs you should expect.** When nobody converted in either arm, or everybody did, the pooled variance is exactly 0 and `(p2-p1)/se` is `NaN`. An empty control arm gives `0`. Neither is a Z-score. NaN is uniquely nasty here because **every comparison against NaN is false**, so `if z > 1.96 { declareWinner() }` never fires and `if z < -1.96 { rollback() }` never fires either. The experiment silently reports no significance forever, and the guardrail that was supposed to auto-rollback a bad variant silently never triggers. A statistics function must return an error for degenerate input rather than a float that poisons every comparison it touches.

**Uber's Key Practices:**
- Experimentation platform integrated with feature flags
- Statistical rigor with sample size calculation
- Multi-armed bandit for optimization
- Guardrail metrics to prevent regressions
- Automated experiment analysis

### Staff Lens: Experimentation Requires Discipline

A/B tests need correct sample sizes, predefined metrics, guardrails, and statistical analysis. Without these, experiments produce noise. Partner with data science. Do not DIY.

---
