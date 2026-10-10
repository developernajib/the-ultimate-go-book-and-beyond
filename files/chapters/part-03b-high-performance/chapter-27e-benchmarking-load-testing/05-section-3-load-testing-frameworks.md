## Section 3: Load Testing Frameworks

### 3.0 The 2026 Load-Testing Landscape

By 2026 the open-source load-testing space has consolidated into a small number of tools, each with a clear niche. Pick based on the protocol, the traffic model, and whether you need scenario scripting or raw throughput.

| Tool | Language | Model | Best for | Notes |
|------|----------|-------|----------|-------|
| **k6** (Grafana) | Go runtime + JS scripting | Open, constant-arrival-rate supported | Scenario-based tests in CI, API flows with auth/session state | Now the de-facto industry default. First-class Grafana Cloud integration, gRPC, WebSocket, browser testing |
| **vegeta** | Go | Open, constant-rate by construction | Quick CLI attacks, fixed-RPS API gates, embedding in Go tests | Corrects for coordinated omission by design. No scenario scripting |
| **fortio** (Istio) | Go | Open, constant-rate | HTTP/1, HTTP/2, gRPC benchmarking for service meshes | Built-in HDR histograms, nice web UI |
| **wrk2** | C + Lua | Open, constant-throughput | Accurate tail-latency (p99.9+) measurement | Gil Tene's CO-corrected successor to `wrk`. Use whenever tail numbers matter |
| **bombardier** | Go | Closed (connection-saturating) | Quick "how many RPS can this box do" smoke tests | Fast but coordinates with the server, so its latency numbers are suspect |
| **hey** | Go | Closed | Legacy, replaced for most uses by `bombardier` and `vegeta` | Still in many tutorials, effectively unmaintained |
| **locust** | Python | Open, user-based | Teams that already script in Python, complex stateful flows | Higher per-worker overhead than k6 |
| **wrk** (original) | C + Lua | Closed | Raw throughput on a single box | Suffers coordinated omission. Use `wrk2` for latency work |

**Open vs closed workload**: an *open-model* generator sends requests at a target rate regardless of prior responses, which is what real users do and what you need to expose queuing latency. A *closed-model* generator maintains a fixed pool of virtual users, each of which waits for its previous response before sending the next. Closed models silently apply backpressure and hide tail latency. Prefer open-model tools for anything facing real traffic. k6, vegeta, fortio, and wrk2 are all open-model. `wrk`, `bombardier`, and naive `hey` runs are closed-model.

**Recommendation for a new Go shop in 2026**: k6 for anything involving session state or CI integration, vegeta for one-shot API attacks inside Go test binaries, wrk2 when you genuinely need to characterize the high 9s. The custom Go generator pattern in section 3.2 is still worth knowing for bespoke protocols.

### 3.1 vegeta for HTTP Load Testing

Vegeta issues HTTP requests at a constant rate regardless of server response time, measuring latency under sustained load rather than the throughput-limited response time that tools like `wrk` report. Its Go API allows embedding load tests in test suites to produce latency histograms as part of CI, turning load testing from a manual step into an automated gate. The example below wraps vegeta's attacker in a configurable function that returns structured latency percentiles.

```go
package vegeta_loadtest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	vegeta "github.com/tsenart/vegeta/v12/lib"
)

// LoadTestConfig configures a vegeta load test.
type LoadTestConfig struct {
	TargetURL  string
	Method     string
	Body       any
	Headers    http.Header
	Rate       vegeta.Rate
	Duration   time.Duration
	MaxWorkers uint64
}

// RunLoadTest executes a load test and returns results.
func RunLoadTest(cfg LoadTestConfig) (*LoadTestResult, error) {
	// Encode request body.
	var bodyBytes []byte
	if cfg.Body != nil {
		var err error
		bodyBytes, err = json.Marshal(cfg.Body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
	}

	// Build targeter function.
	targeter := func(tgt *vegeta.Target) error {
		tgt.Method = cfg.Method
		tgt.URL = cfg.TargetURL
		tgt.Body = bodyBytes
		tgt.Header = cfg.Headers
		return nil
	}

	// Configure attacker.
	attacker := vegeta.NewAttacker(
		vegeta.Workers(cfg.MaxWorkers),
		vegeta.MaxConnections(0), // Unlimited.
		vegeta.Timeout(10*time.Second),
		vegeta.KeepAlive(true),
		vegeta.H2C(false),
	)

	// Execute attack.
	var metrics vegeta.Metrics
	for res := range attacker.Attack(targeter, cfg.Rate, cfg.Duration, "load-test") {
		metrics.Add(res)
	}
	metrics.Close()

	return &LoadTestResult{
		Requests: metrics.Requests,
		Rate:     metrics.Rate, // ACHIEVED rate. Compare against cfg.Rate.
		Duration: metrics.Duration,
		Success:  metrics.Success,
		Latencies: LatencyMetrics{
			Mean: metrics.Latencies.Mean,
			P50:  metrics.Latencies.P50,
			P95:  metrics.Latencies.P95,
			P99:  metrics.Latencies.P99,
			P999: metrics.Latencies.P999,
			Max:  metrics.Latencies.Max,
		},
		StatusCodes: metrics.StatusCodes,
		Errors:      metrics.Errors,
	}, nil
}

// LoadTestResult captures load test outcome.
type LoadTestResult struct {
	Requests    uint64
	Rate        float64 // Actual RPS achieved.
	Duration    time.Duration
	Success     float64 // 0.0 - 1.0
	Latencies   LatencyMetrics
	StatusCodes map[string]int
	Errors      []string
}

type LatencyMetrics struct {
	Mean time.Duration
	P50  time.Duration
	P95  time.Duration
	P99  time.Duration
	P999 time.Duration
	Max  time.Duration
}

// String formats the result for display.
func (r *LoadTestResult) String() string {
	return fmt.Sprintf(`
Load Test Results
=================
Requests:    %d
Rate:        %.1f req/s
Duration:    %v
Success:     %.2f%%

Latency Percentiles:
  p50:   %v
  p95:   %v
  p99:   %v
  p99.9: %v
  max:   %v

Status Codes: %v
Errors: %v
`,
		r.Requests, r.Rate, r.Duration, r.Success*100,
		r.Latencies.P50, r.Latencies.P95, r.Latencies.P99, r.Latencies.P999, r.Latencies.Max,
		r.StatusCodes, r.Errors)
}

// RampLoadTest performs a ramp-up load test: starts at lowRPS, ramps to highRPS.
// Useful for finding the service's throughput ceiling.
func RampLoadTest(url string, lowRPS, highRPS, stepRPS int, stepDuration time.Duration) []LoadTestResult {
	var results []LoadTestResult

	for rps := lowRPS; rps <= highRPS; rps += stepRPS {
		cfg := LoadTestConfig{
			TargetURL: url,
			Method:    "GET",
			Rate:      vegeta.Rate{Freq: rps, Per: time.Second},
			Duration:  stepDuration,
			MaxWorkers: 100,
		}
		result, err := RunLoadTest(cfg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Load test at %d RPS failed: %v\n", rps, err)
			break
		}
		results = append(results, *result)
		fmt.Printf("RPS=%d achieved=%.0f p99=%v success=%.1f%%\n",
			rps, result.Rate, result.Latencies.P99, result.Success*100)

		// Always check the ACHIEVED rate against the target. If vegeta could not
		// keep up, the p99 on this row describes a load test that never applied
		// the load you asked for, and the ramp has already left reality behind.
		if result.Rate < float64(rps)*0.95 {
			fmt.Printf("Generator fell behind at %d RPS (achieved %.0f). "+
				"Results beyond this point are not meaningful.\n", rps, result.Rate)
			break
		}

		// Stop if error rate exceeds threshold.
		if result.Success < 0.99 {
			fmt.Printf("Error rate exceeded 1%% at %d RPS, stopping ramp\n", rps)
			break
		}
	}
	return results
}
```

### 3.2 Custom Rate-Controlled Load Generator

A custom load generator built on goroutines gives you control over traffic patterns that fixed-rate tools like vegeta cannot express: ramp-up curves, bursty arrivals, think-time distributions, and session state. A ticker controls request emission and a worker pool executes requests concurrently. The generator below implements configurable rate control, collects per-request latency samples, and computes percentiles from them. Read it critically. It contains a deliberate flaw that section 3.3 then names, and finding it before you get there is the exercise.

```go
package loadgen

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Generator generates requests at a precise rate using a token bucket.
// Unlike vegeta, this allows custom request logic (sessions, auth tokens, etc.)
type Generator struct {
	rate     int // Target requests per second.
	workers  int
	client   *http.Client
	makeReq  func() *http.Request
	onResult func(Result)

	// Metrics.
	sent      atomic.Uint64
	success   atomic.Uint64
	errors    atomic.Uint64
	dropped   atomic.Uint64 // Slots never sent because workers were saturated.
	latencies chan time.Duration
}

// Result represents the outcome of a single request.
type Result struct {
	StatusCode int
	Latency    time.Duration
	Error      error
}

// Config configures the load generator.
type Config struct {
	Rate     int
	Workers  int
	Duration time.Duration
	MakeReq  func() *http.Request
	OnResult func(Result)
}

func New(cfg Config) *Generator {
	return &Generator{
		rate:     cfg.Rate,
		workers:  cfg.Workers,
		makeReq:  cfg.MakeReq,
		onResult: cfg.OnResult,
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        cfg.Workers,
				MaxIdleConnsPerHost: cfg.Workers,
				IdleConnTimeout:     90 * time.Second,
				DisableCompression:  true,
			},
		},
		latencies: make(chan time.Duration, 100000),
	}
}

// Run runs the load test for the specified duration.
func (g *Generator) Run(ctx context.Context, duration time.Duration) Stats {
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()

	// Token bucket: one token per (1/rate) seconds.
	ticker := time.NewTicker(time.Duration(float64(time.Second) / float64(g.rate)))
	defer ticker.Stop()

	// Worker pool.
	work := make(chan struct{}, g.workers*2)
	var wg sync.WaitGroup

	for i := 0; i < g.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range work {
				g.executeRequest()
			}
		}()
	}

	// Rate controller: emit tokens at target rate.
	go func() {
		defer close(work)
		for {
			select {
			case <-ticker.C:
				select {
				case work <- struct{}{}:
					g.sent.Add(1)
				default:
					// The workers are saturated, so this slot's request never
					// goes out. Read the next section before you accept this
					// behavior: THIS IS COORDINATED OMISSION, in the generator
					// you built to avoid it. Exactly when the system is slowest,
					// this generator quietly reduces its own load and stops
					// sampling, so the latencies it fails to record are the only
					// ones that mattered.
					//
					// It is counted as a "dropped" slot rather than an error so
					// that it shows up in the report instead of hiding inside
					// the error rate. A non-zero Dropped means the reported
					// percentiles are optimistic and the achieved rate was below
					// target: the test did not run the experiment you asked for.
					//
					// Real fixes, in order of preference: raise Workers until
					// Dropped is 0, lower Rate to something the generator can
					// actually sustain, or charge the omitted slots their owed
					// latency the way section 3.3 does. Reporting a p99 from a
					// run with dropped slots is reporting a number about your
					// load generator.
					g.dropped.Add(1)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	wg.Wait()
	close(g.latencies)

	return g.collectStats()
}

func (g *Generator) executeRequest() {
	req := g.makeReq()
	start := time.Now()

	resp, err := g.client.Do(req)
	latency := time.Since(start)

	result := Result{Latency: latency}
	if err != nil {
		result.Error = err
		g.errors.Add(1)
	} else {
		result.StatusCode = resp.StatusCode
		resp.Body.Close()
		if resp.StatusCode < 400 {
			g.success.Add(1)
		} else {
			g.errors.Add(1)
		}
	}

	select {
	case g.latencies <- latency:
	default:
		// Buffer full - discard.
	}

	if g.onResult != nil {
		g.onResult(result)
	}
}

// Stats holds aggregate test statistics.
type Stats struct {
	Sent      uint64
	Success   uint64
	Errors    uint64
	Dropped   uint64 // Non-zero invalidates the percentiles below. See Run.
	ErrorRate float64
	Latencies PercentileStats
}

type PercentileStats struct {
	P50  time.Duration
	P75  time.Duration
	P90  time.Duration
	P95  time.Duration
	P99  time.Duration
	P999 time.Duration
	Max  time.Duration
}

func (g *Generator) collectStats() Stats {
	var lats []time.Duration
	for l := range g.latencies {
		lats = append(lats, l)
	}

	sent := g.sent.Load()
	success := g.success.Load()
	errors := g.errors.Load()

	var errRate float64
	if sent > 0 {
		errRate = float64(errors) / float64(sent)
	}

	return Stats{
		Sent:      sent,
		Success:   success,
		Errors:    errors,
		Dropped:   g.dropped.Load(),
		ErrorRate: errRate,
		Latencies: computePercentiles(lats),
	}
}

func computePercentiles(lats []time.Duration) PercentileStats {
	if len(lats) == 0 {
		return PercentileStats{}
	}
	slices.Sort(lats)
	n := len(lats)

	// Nearest-rank percentile, clamped so p999 on a short run cannot walk off
	// the end. Note that any percentile is only as trustworthy as its sample
	// count: p99.9 from 500 samples is interpolating between two data points and
	// should not be quoted to three digits.
	at := func(p float64) time.Duration {
		i := int(float64(n) * p / 100.0)
		return lats[min(max(i, 0), n-1)]
	}
	return PercentileStats{
		P50:  at(50),
		P75:  at(75),
		P90:  at(90),
		P95:  at(95),
		P99:  at(99),
		P999: at(99.9),
		Max:  lats[n-1],
	}
}
```

### 3.3 The Coordinated Omission Problem

Coordinated omission occurs when a load generator stops issuing new requests while it waits for a slow response. The generator and the server "coordinate", and the effect is that the exact moments when the system was worst are the moments the generator sampled least. The tail you most wanted to measure is the tail that goes missing. Gil Tene's correction, implemented in `wrk2` and `hdrhistogram-go`, charges each request from its *intended* arrival time rather than from the moment the generator got around to it. The code below implements an intended-start-time generator and shows honestly what a real HDR histogram is doing for you.

Work the arithmetic once and it stops being abstract. Target 1000 req/s (one request every 1 ms) for 10 seconds, so 10,000 requests. The server handles requests in 0.1 ms except for one 100 ms stall.

- **A closed generator** sends a request, waits, sends the next. When the stall hits, it is blocked, so it issues nothing for 100 ms. It records 9,999 samples at ~0.1 ms and exactly **one** sample at 100 ms. Reported p99: **0.1 ms**. The stall is one sample in ten thousand, so it does not even reach p99.9. The generator also quietly sent 99 fewer requests than it promised.
- **An open generator** owes 100 requests during that 100 ms window, whether or not the server is listening. The request that *should* have gone out when the stall began waits the full 100 ms. The one due 1 ms later waits 99 ms, and so on down to 1 ms. So the corrected picture is 9,900 samples at ~0.1 ms and 100 samples spread evenly from 1 ms to 100 ms. Reported p99: **~1 ms**. p99.9: **~90 ms**.

Same server, same stall. The closed generator reports a p99.9 of 0.1 ms and the open one reports 90 ms, a 900x difference produced entirely by how the generator behaved. Your users experienced the second number. This is why "our p99 looks fine" and "customers are complaining about timeouts" so often coexist.

```go
package coordinated_omission

import (
	"sync/atomic"
	"time"
)

// This package demonstrates why naive load generators produce overly
// optimistic latency measurements, and what the correction actually is.
//
// The fix is to track the INTENDED send time, not the actual send time. If a
// response takes 500 ms, every request that SHOULD have been sent during those
// 500 ms but was not still owes its latency, measured from when it was due.
//
// Two terms, used the way Gil Tene uses them. Keep them straight, because the
// entire argument depends on the distinction:
//
//   - Service time:  actual send -> completion. What the server took.
//   - Response time: intended send -> completion. What the user waited,
//     including time queued behind a system that was not ready for them.
//
// Service time is what a closed generator measures. Response time is what your
// users feel. Only one of them belongs in an SLO.
//
// For real work use github.com/HdrHistogram/HdrHistogram_Go, whose
// RecordCorrectedValue does this accounting for you.

// IntendedStartTimeGenerator generates requests based on intended start time.
// Even if the previous request is slow, the next one starts at the scheduled time.
type IntendedStartTimeGenerator struct {
	rate       float64 // Requests per second.
	start      time.Time
	nextStart  int64 // Unix nanoseconds of next intended send.
	intervalNs int64 // Nanoseconds between requests.
	results    chan SampledResult
}

// SampledResult records both the service time and the CO-corrected response
// time for one request. The gap between them IS the coordinated omission.
type SampledResult struct {
	IntendedStartTime time.Time
	ActualStartTime   time.Time
	EndTime           time.Time
	ServiceTime       time.Duration // actual send -> completion. What the server took.
	ResponseTime      time.Duration // intended send -> completion. What the user waited.
	StatusCode        int
}

func NewIntendedStartTimeGenerator(rate float64) *IntendedStartTimeGenerator {
	intervalNs := int64(float64(time.Second) / rate)
	return &IntendedStartTimeGenerator{
		rate:       rate,
		start:      time.Now(),
		nextStart:  time.Now().UnixNano(),
		intervalNs: intervalNs,
		results:    make(chan SampledResult, 10000),
	}
}

// Next claims the next scheduled slot, blocks until it arrives, and returns it.
// The caller sends the request immediately after Next returns.
//
// The whole correction lives in the "if we are late" case. When the system is
// slow and we have fallen behind schedule, we do NOT sleep and we do NOT skip
// the slot. We send at once and still charge the request from the time it was
// due. A generator that instead waited a fresh interval would be back-pressuring
// itself, which is precisely coordinated omission.
func (g *IntendedStartTimeGenerator) Next() time.Time {
	nextNs := atomic.AddInt64(&g.nextStart, g.intervalNs) - g.intervalNs
	intended := time.Unix(0, nextNs)

	if now := time.Now(); now.Before(intended) {
		time.Sleep(intended.Sub(now))
	}
	return intended
}

// RecordResult records one request's outcome. The caller passes the intended
// slot from Next and the actual time the request went out, because the entire
// point of this exercise is that those two differ under load. Deriving both
// numbers from `intended` would make ServiceTime and ResponseTime identical and
// silently destroy the measurement.
func (g *IntendedStartTimeGenerator) RecordResult(intended, actualStart time.Time, statusCode int) {
	now := time.Now()
	g.results <- SampledResult{
		IntendedStartTime: intended,
		ActualStartTime:   actualStart,
		EndTime:           now,
		ServiceTime:       now.Sub(actualStart), // What the server took.
		ResponseTime:      now.Sub(intended),    // What the user waited. Report THIS.
		StatusCode:        statusCode,
	}
}

// ResultsChan returns the channel of sampled results.
func (g *IntendedStartTimeGenerator) ResultsChan() <-chan SampledResult {
	return g.results
}

// LinearHistogram is a fixed-bucket latency histogram. It is deliberately NOT
// called an HDR histogram, because it is not one, and the difference is the
// point of this section.
//
// HDR stands for High Dynamic Range. A real HDR histogram keeps constant
// RELATIVE precision (say 3 significant figures) across a range spanning many
// orders of magnitude, by making bucket widths grow with magnitude. It can hold
// 1 us and 60 s in the same structure and be within 0.1% at both ends.
//
// This thing has constant ABSOLUTE precision (0.1 ms everywhere) and a hard
// ceiling of 1 s, and both properties are bugs at the tail:
//
//   - It cannot see the tail it exists to measure. Every latency above 1 s
//     clamps into the last bucket. During the incident where p99.9 hits 8 s,
//     this histogram reports exactly 1.0 s, with total confidence.
//   - 0.1 ms buckets are absurdly coarse for a 200 us service (everything lands
//     in bucket 0 or 1) and absurdly fine for a 30 s batch job (300,000 buckets
//     you never allocated).
//
// Shown because a hand-rolled linear histogram is what engineers reach for, and
// because recognizing why it fails is what makes the real library make sense.
// In production use github.com/HdrHistogram/HdrHistogram_Go, which solves both
// problems and gives you RecordCorrectedValue for the coordinated-omission
// accounting above. Do not ship this.
type LinearHistogram struct {
	buckets [10000]atomic.Uint64 // 0.1 ms buckets, saturating at 1 s.
	count   atomic.Uint64
	clamped atomic.Uint64 // Samples that hit the ceiling. Watch this.
}

func (h *LinearHistogram) Record(d time.Duration) {
	bucket := int(d.Microseconds() / 100)
	if bucket >= len(h.buckets) {
		bucket = len(h.buckets) - 1
		// Count what we are lying about, so the lie is at least auditable.
		h.clamped.Add(1)
	}
	if bucket < 0 {
		bucket = 0
	}
	h.buckets[bucket].Add(1)
	h.count.Add(1)
}

// Percentile returns the p'th percentile, p in [0,100].
// If Clamped() is non-zero, treat any high percentile from this as a lower
// bound rather than a measurement.
func (h *LinearHistogram) Percentile(p float64) time.Duration {
	total := h.count.Load()
	if total == 0 {
		return 0
	}
	target := uint64(float64(total) * p / 100.0)

	var cumulative uint64
	for i := range h.buckets {
		cumulative += h.buckets[i].Load()
		if cumulative >= target {
			return time.Duration(i) * 100 * time.Microsecond
		}
	}
	return time.Duration(len(h.buckets)) * 100 * time.Microsecond
}

// Clamped reports how many samples exceeded the 1 s ceiling and were recorded
// as 1 s. Any non-zero value means the tail percentiles are fiction.
func (h *LinearHistogram) Clamped() uint64 { return h.clamped.Load() }
```

### 3.4 Junior → FAANG: the load-test command that should be in your muscle memory

For any HTTP service, memorize this command:

```bash
vegeta attack -rate=1000/s -duration=60s -targets=targets.txt | vegeta report -type=hdrplot
```

or equivalently

```bash
wrk2 -t8 -c200 -d60s -R 1000 --latency http://localhost:8080/endpoint
```

Either command gives you a coordinated-omission-corrected latency histogram at a precise target rate. Internalize the shape of the output (p50, p75, p90, p99, p99.9, p99.99, max) and learn to skim it in 10 seconds. Practice it until you no longer reach for `ab` or `curl` loops. The first time you genuinely need this in an incident, the five seconds it takes you to produce the number beats the thirty minutes someone else takes to reconstruct the tool invocation. Speed with load-testing tools is an operational skill that compounds.

### 3.5 Senior @ FAANG: load-test fidelity as a design question

A load test that does not match production traffic is worse than no load test, because it gives false confidence. At staff level, insist on four fidelity dimensions for any load test that gates a release. First, request shape: methods, paths, payload sizes, header sets, auth tokens must all look like real traffic. Second, key distribution: a uniformly distributed key set exercises cache hit rates and database shards very differently from a power-law distribution (the real shape of most workloads). Third, concurrency pattern: arrival rate, think time, session length, fan-out degree must match production. Fourth, warmup: production has warm caches, primed branch predictors, and populated runtime pools. Load tests that ramp from cold report artificially bad p99. Build a traffic-shape validator that compares your load test against a 24-hour sample of production logs and reports deltas on each dimension. Tests that fail the validator should be treated as non-production-representative and the results adjusted accordingly. The governance cost is real. The alternative (load tests that lie) is worse.

---
