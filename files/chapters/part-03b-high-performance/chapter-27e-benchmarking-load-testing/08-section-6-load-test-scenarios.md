## Section 6: Load Test Scenarios

### 6.1 Traffic Pattern Simulation

Realistic traffic patterns account for diurnal variation (low overnight, peak during business hours), user session behavior (clustered API calls after login), and the long tail of requests that take 10x longer than the median. Flat-rate tests miss the queue buildup and resource contention that these patterns expose. The traffic simulator below implements several pattern types, constant, sine wave, step spike, and gradual ramp, along with a Zipf distribution for modeling the 80/20 key access pattern common in production workloads.

```go
package traffic_patterns

import (
	"math"
	"math/rand/v2"
	"time"
)

// TrafficPattern generates request rates following a pattern.
type TrafficPattern interface {
	Rate(t time.Time) float64 // Returns desired RPS at time t.
}

// ConstantPattern generates a constant request rate.
type ConstantPattern struct {
	RPS float64
}

func (p *ConstantPattern) Rate(_ time.Time) float64 { return p.RPS }

// SinePattern simulates daily traffic patterns (peaks and valleys).
// Used to test how services handle time-of-day traffic variation.
type SinePattern struct {
	BaseRPS float64
	PeakRPS float64
	PeriodH float64 // Period in hours.
	PhaseH  float64 // Phase shift in hours.
}

func (p *SinePattern) Rate(t time.Time) float64 {
	hourOfDay := float64(t.Hour()) + float64(t.Minute())/60.0
	amplitude := (p.PeakRPS - p.BaseRPS) / 2.0
	center := p.BaseRPS + amplitude
	phase := (hourOfDay - p.PhaseH) / p.PeriodH * 2 * math.Pi
	return center + amplitude*math.Sin(phase)
}

// StepPattern simulates load spikes - sudden traffic bursts.
// Use to test autoscaling and connection pool behavior.
type StepPattern struct {
	BaseRPS   float64
	SpikePct  float64       // Percentage above base during spike.
	SpikeAt   time.Duration // Duration into test when spike starts.
	SpikeLen  time.Duration // Duration of spike.
	startTime time.Time
}

func (p *StepPattern) Start() { p.startTime = time.Now() }

func (p *StepPattern) Rate(t time.Time) float64 {
	elapsed := t.Sub(p.startTime)
	if elapsed >= p.SpikeAt && elapsed < p.SpikeAt+p.SpikeLen {
		return p.BaseRPS * (1.0 + p.SpikePct/100.0)
	}
	return p.BaseRPS
}

// GradualRampPattern ramps from startRPS to maxRPS over rampDuration.
// After ramp, sustains at maxRPS.
type GradualRampPattern struct {
	StartRPS     float64
	MaxRPS       float64
	RampDuration time.Duration
	startTime    time.Time
}

func (p *GradualRampPattern) Start() { p.startTime = time.Now() }

func (p *GradualRampPattern) Rate(t time.Time) float64 {
	elapsed := t.Sub(p.startTime)
	if elapsed >= p.RampDuration {
		return p.MaxRPS
	}
	fraction := float64(elapsed) / float64(p.RampDuration)
	return p.StartRPS + (p.MaxRPS-p.StartRPS)*fraction
}

// ZipfDistribution models a skewed (power-law) key distribution.
//
// "80% of traffic hits 20% of keys" is a slogan, not a setting. How skewed the
// output actually is depends entirely on `exponent`, and the range you can
// select is far more concentrated than 80/20 nearly everywhere.
//
// Measured, maxKey=10000, 2,000,000 samples, seed 42, share of traffic taken by
// the hottest 20% of the keyspace:
//
//	exponent 1.01  ->  84.3%
//	exponent 1.10  ->  89.5%
//	exponent 1.16  ->  92.2%
//	exponent 1.20  ->  93.8%
//	exponent 1.30  ->  96.5%
//	exponent 1.50  ->  99.1%
//	exponent 2.00  -> 100.0%
//
// Note what this table says. There is no exponent above the required s > 1 that
// gives you a gentle 80/20: the mildest legal skew is already 84/20, and by 1.5
// essentially all traffic lands in a fifth of the keys. So an exponent picked by
// vibes is not "realistic", it is an arbitrary and usually far more punishing
// workload than production. The numbers also move with maxKey, so they are not
// portable constants.
//
// Do this instead: take a day of production access logs, compute what fraction
// of traffic your real hottest 20% of keys receives, and fit exponent to match
// that measurement. If you cannot, say in the test's own output which exponent
// you assumed, so nobody reads the resulting p99 as a fact about production.
//
// The seed is fixed at 42 so runs are comparable. Vary it deliberately when you
// want to know whether a result depends on one unlucky key ordering.
type ZipfDistribution struct {
	gen *rand.Zipf
	max uint64
}

// NewZipfDistribution builds the generator. exponent must be > 1: rand.NewZipf
// panics otherwise.
func NewZipfDistribution(maxKey uint64, exponent float64) *ZipfDistribution {
	src := rand.NewPCG(42, 0)
	r := rand.New(src)
	return &ZipfDistribution{
		gen: rand.NewZipf(r, exponent, 1.0, maxKey),
		max: maxKey,
	}
}

// NextKey returns the next key, in [0, maxKey], following the configured Zipf
// distribution. Low-numbered keys are the hot ones.
func (z *ZipfDistribution) NextKey() uint64 {
	return z.gen.Uint64()
}

// WorkloadSimulator generates realistic mixed workloads.
type WorkloadSimulator struct {
	readPct float64 // 0.0 to 1.0
	keys    *ZipfDistribution
	payload PayloadGenerator
}

// PayloadGenerator generates request payloads.
type PayloadGenerator struct {
	minSize int
	maxSize int
}

func (pg PayloadGenerator) Generate() []byte {
	size := pg.minSize + rand.IntN(pg.maxSize-pg.minSize+1)
	payload := make([]byte, size)
	// math/rand/v2 has no top-level Read - fill the buffer manually.
	// For non-deterministic bytes use crypto/rand.Read instead.
	for i := range payload {
		payload[i] = byte(rand.UintN(256))
	}
	return payload
}

type RequestSpec struct {
	Method  string
	Key     uint64
	Payload []byte
}

// Next generates the next request in the workload.
func (w *WorkloadSimulator) Next() RequestSpec {
	if rand.Float64() < w.readPct {
		return RequestSpec{Method: "GET", Key: w.keys.NextKey()}
	}
	return RequestSpec{
		Method:  "PUT",
		Key:     w.keys.NextKey(),
		Payload: w.payload.Generate(),
	}
}
```

### 6.2 End-to-End Load Test Example

An end-to-end load test exercises the complete request path, DNS, TLS handshake, application server, database, downstream services, under production-representative load. Running against a staging environment with production-scale data validates that all components meet their SLAs under combined load. The test below executes a multi-phase load profile (baseline, ramp, full load, spike, recovery) and asserts that p99 latency and error rates remain within defined thresholds throughout each phase.

```go
package e2e_loadtest

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SLO thresholds, defined once. These were originally duplicated between
// runPhase and Analyze, which is how a suite ends up reporting a phase as
// Passed while the summary calls the same numbers a failure.
const (
	maxErrorRate  = 0.01 // 1%
	maxP99Latency = 100 * time.Millisecond
	maxSpikeP99   = 500 * time.Millisecond // Degraded budget during a 2x burst.
)

// sloFor returns the p99 budget for a phase.
func sloFor(phase string) time.Duration {
	if phase == "spike" {
		return maxSpikeP99
	}
	return maxP99Latency
}

// ServiceLoadTest runs a comprehensive load test against a service.
type ServiceLoadTest struct {
	BaseURL  string
	Duration time.Duration
	MaxRPS   int
}

// Run executes the full load test suite.
func (t *ServiceLoadTest) Run(ctx context.Context) (*LoadTestSuite, error) {
	suite := &LoadTestSuite{
		StartTime: time.Now(),
		Results:   make(map[string]*LoadTestResult),
	}

	// Phase 1: Baseline (10% of target RPS).
	fmt.Println("Phase 1: Baseline (10% load)...")
	baseline, err := t.runPhase(ctx, "baseline", t.MaxRPS/10, 30*time.Second)
	if err != nil {
		return nil, err
	}
	suite.Results["baseline"] = baseline

	// Phase 2: Ramp to 50% over 60 seconds.
	fmt.Println("Phase 2: Ramp to 50%...")
	ramp50, err := t.runPhase(ctx, "ramp-50pct", t.MaxRPS/2, 60*time.Second)
	if err != nil {
		return nil, err
	}
	suite.Results["ramp-50pct"] = ramp50

	// Phase 3: Full load.
	fmt.Println("Phase 3: Full load...")
	full, err := t.runPhase(ctx, "full-load", t.MaxRPS, t.Duration)
	if err != nil {
		return nil, err
	}
	suite.Results["full-load"] = full

	// Phase 4: Spike test (2× target for 30 seconds).
	fmt.Println("Phase 4: Spike test (2x load)...")
	spike, err := t.runPhase(ctx, "spike", t.MaxRPS*2, 30*time.Second)
	if err != nil {
		return nil, err
	}
	suite.Results["spike"] = spike

	// Phase 5: Recovery after spike.
	fmt.Println("Phase 5: Recovery...")
	recovery, err := t.runPhase(ctx, "recovery", t.MaxRPS/10, 30*time.Second)
	if err != nil {
		return nil, err
	}
	suite.Results["recovery"] = recovery

	suite.Duration = time.Since(suite.StartTime)
	suite.Analyze()
	return suite, nil
}

func (t *ServiceLoadTest) runPhase(ctx context.Context, name string, rps int, duration time.Duration) (*LoadTestResult, error) {
	gen := New(Config{
		Rate:     rps,
		Workers:  min(rps/10, 200),
		Duration: duration,
		MakeReq: func() *http.Request {
			req, _ := http.NewRequest("GET", t.BaseURL+"/api/v1/health", nil)
			return req
		},
		OnResult: nil,
	})

	stats := gen.Run(ctx, duration)
	res := &LoadTestResult{
		Phase:      name,
		TargetRPS:  rps,
		ActualRPS:  float64(stats.Sent) / duration.Seconds(),
		Dropped:    stats.Dropped,
		ErrorRate:  stats.ErrorRate,
		P50Latency: stats.Latencies.P50,
		P99Latency: stats.Latencies.P99,
		MaxLatency: stats.Latencies.Max,
	}
	res.Passed = res.ErrorRate < maxErrorRate && res.P99Latency < sloFor(name)

	// A phase whose generator could not keep up did not run the experiment. Its
	// latencies describe a reduced load, so a green result here means nothing.
	// Surface it as a failure rather than letting the suite report a pass it did
	// not earn.
	if stats.Dropped > 0 {
		res.Passed = false
	}
	return res, nil
}

// LoadTestResult represents one phase's results.
type LoadTestResult struct {
	Phase      string
	TargetRPS  int
	ActualRPS  float64
	Dropped    uint64 // Slots the generator never sent. Non-zero invalidates the run.
	ErrorRate  float64
	P50Latency time.Duration
	P99Latency time.Duration
	MaxLatency time.Duration
	Passed     bool
}

// LoadTestSuite aggregates all phase results.
type LoadTestSuite struct {
	StartTime time.Time
	Duration  time.Duration
	Results   map[string]*LoadTestResult
	Passed    bool
	Issues    []string
}

// Analyze checks if the service met its SLOs, using the same thresholds
// runPhase used. One definition, one verdict.
func (s *LoadTestSuite) Analyze() {
	s.Passed = true

	for phase, result := range s.Results {
		threshold := sloFor(phase)

		if result.Dropped > 0 {
			s.Issues = append(s.Issues,
				fmt.Sprintf("%s: load generator dropped %d requests, so this "+
					"phase never applied its target load and its latencies are "+
					"not meaningful", phase, result.Dropped))
			s.Passed = false
		}

		if result.ErrorRate > maxErrorRate {
			s.Issues = append(s.Issues,
				fmt.Sprintf("%s: error rate %.2f%% exceeds limit %.2f%%",
					phase, result.ErrorRate*100, maxErrorRate*100))
			s.Passed = false
		}

		if result.P99Latency > threshold {
			s.Issues = append(s.Issues,
				fmt.Sprintf("%s: p99 latency %v exceeds limit %v",
					phase, result.P99Latency, threshold))
			s.Passed = false
		}
	}
}

// Report prints a formatted test report.
func (s *LoadTestSuite) Report() string {
	status := "PASSED"
	if !s.Passed {
		status = "FAILED"
	}

	report := fmt.Sprintf("Load Test Suite: %s (duration: %v)\n", status, s.Duration)
	report += strings.Repeat("─", 60) + "\n"

	for _, phase := range []string{"baseline", "ramp-50pct", "full-load", "spike", "recovery"} {
		result, ok := s.Results[phase]
		if !ok {
			continue
		}
		phaseStatus := "✓"
		if !result.Passed {
			phaseStatus = "✗"
		}
		report += fmt.Sprintf("%s %-12s  RPS: %6.0f/%-6d  p99: %-8v  err: %.2f%%",
			phaseStatus, result.Phase,
			result.ActualRPS, result.TargetRPS, result.P99Latency, result.ErrorRate*100)
		// Always print achieved against target. A reader who sees only the
		// achieved rate cannot tell a passing test from a test that quietly
		// gave up.
		if result.Dropped > 0 {
			report += fmt.Sprintf("  DROPPED: %d", result.Dropped)
		}
		report += "\n"
	}

	if len(s.Issues) > 0 {
		report += "\nIssues:\n"
		for _, issue := range s.Issues {
			report += "  - " + issue + "\n"
		}
	}
	return report
}
```

### 6.3 The scenario suite every production service should have

A mature service should have at least five distinct load-test scenarios, each answering a different question. **Baseline**: does the service hold p99 under typical load. **Peak**: does the service hold p99 at projected peak RPS for the next two quarters. **Spike**: does the service survive a 2x burst for 60 seconds without cascading failure. **Soak**: does the service hold p99 over a 4-hour sustained run (catches memory leaks, goroutine leaks, connection pool drift). **Degradation**: with a downstream dependency artificially slowed by 10x, does the service fail fast and shed load gracefully, or does it cascade. Run baseline and peak in CI on release candidates, spike and soak weekly in staging, degradation quarterly as part of chaos engineering. The scenario mix is what separates "we load-tested it once" from "we know how this service behaves under the conditions we care about." Services with the full mix survive unexpected production patterns. Services with only baseline are a coin flip.

### 6.4 Junior → FAANG: the Zipf distribution is not a detail

When you write a load test, ask one question up front: is the production key distribution uniform or power-law? For almost every user-facing service the answer is power-law, the hot-key problem. A uniform-key load test will overstate cache hit rate, understate database load, and lie about p99 because it never exercises hot-key contention.

But do not stop at "use Zipf and feel realistic", because the *degree* of skew is the whole ballgame and it is a parameter you are choosing. As the measurements in section 6.1 show, `rand.Zipf` at exponent 1.01 sends 84 percent of traffic to the hottest 20 percent of keys, and at exponent 1.5 it sends 99 percent. Those are wildly different services: one has a working set, the other has a single hot key and a cache that either saves you completely or not at all. Picking 1.5 because it sounded reasonable is not modeling production, it is inventing a workload and then being surprised by the p99 it produces.

So: sample keys from a production log if you can. If you cannot, fit the exponent to one number you *can* measure (the share of traffic your top 20 percent of keys actually gets) and state the assumption in the test output. The one-line lesson: the key distribution must match production in shape *and* in degree, or the test is a synthetic exercise that will not predict real behavior.

### 6.5 Senior @ FAANG: the load-test contract with SRE

At staff level, the load test is not an engineering artifact. It is an agreement with SRE, product, and leadership about the capacity and behavior the service will deliver. The contract needs six elements in writing: (1) the peak RPS target and its source (projected from growth, historical peak times N). (2) the p50, p99, p999 SLO at that rate. (3) the error budget and the acceptable degradation shape (fail fast with 503 vs slow with 200). (4) the load test scenarios that validate each dimension. (5) the cadence of the tests (every release, nightly, weekly) and who reviews results. (6) the escalation path when a test regresses (who approves shipping, who approves rollback). Put this contract in a document that engineering, SRE, and product leadership all sign. Re-read it quarterly. Update it when the product evolves. Services with this contract operate predictably. Services without it ship, pray, and have recurring "why didn't we catch this?" conversations.

---
