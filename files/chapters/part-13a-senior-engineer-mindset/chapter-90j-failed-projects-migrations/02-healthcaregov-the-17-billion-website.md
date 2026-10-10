## 90J.1 Healthcare.gov: The $1.7 Billion Website (2013)

### The Promise

In March 2010, President Obama signed the Affordable Care Act into law, creating the most ambitious government
technology project since the moon landing. Healthcare.gov would serve as the federal health insurance marketplace
for 36 states, allowing millions of Americans to compare and purchase health insurance plans. The site needed to
integrate with systems from the IRS, the Social Security Administration, the Department of Homeland Security,
state Medicaid agencies, and hundreds of private insurance companies. The launch date was set for October 1, 2013.

### The Timeline of Disaster

**2010-2011: The Contracting Phase**

The Centers for Medicare and Medicaid Services (CMS) split the project across 55 different contractors, with no
single systems integrator responsible for making the pieces work together. CGI Federal won the primary contract
for the federal marketplace, but dozens of other contractors were responsible for different subsystems. The
contracting process itself took over a year, driven by federal procurement rules that optimized for compliance
rather than technical capability.

**2012: Warning Signs Emerge**

By mid-2012, internal reviews showed the project was significantly behind schedule. The requirements were still
changing - political negotiations meant that key decisions about plan structures, subsidy calculations, and
enrollment workflows were not finalized until months before launch. The original architecture called for a
modular system with clear interfaces between components, but as deadlines compressed, contractors began building
tightly coupled integrations to save time.

**Early 2013: The Testing Crisis**

With the launch date approaching, only 23% of the system had been tested. Integration testing between contractor
systems was virtually nonexistent. A McKinsey report from March 2013 warned CMS that the project was at serious
risk, but the political decision to proceed with the October 1 launch was treated as immovable. The site had
never been load tested with realistic traffic volumes. Internal estimates suggested 50,000-60,000 concurrent
users at launch, but no testing had validated whether the system could handle even a fraction of that.

**September 2013: The Final Weeks**

In the final weeks before launch, end-to-end testing began for the first time. Engineers discovered that the
system could barely handle 500 concurrent users. The account creation system had a critical bottleneck - it
made synchronous calls to an identity verification service that had a 5-second timeout, and under load these
calls would queue up, exhausting connection pools and causing cascading failures. Rather than delay the launch,
the team attempted to patch the worst issues while political pressure mounted to ship on time.

**October 1, 2013: Launch Day**

On launch day, approximately 250,000 users attempted to access the site simultaneously. The system collapsed
within minutes. The account creation flow - the very first step - failed for the vast majority of users. The
Oracle database backing the account system hit its connection limit. The identity verification service returned
errors. The front-end JavaScript had bugs that prevented error messages from displaying, leaving users staring
at blank screens. Only six people successfully enrolled on the first day.

**October-November 2013: The Crisis Response**

Over the next two months, the site remained largely unusable. The administration brought in a "tech surge" team
led by Jeff Zients, along with engineers from Google, Red Hat, and other technology companies. What they found
was staggering: no monitoring infrastructure, no centralized logging, no deployment pipeline, no load testing
capability, and no clear understanding of the system architecture even among the contractors who built it.

**December 2013: The Recovery**

By December 1, 2013, the site had been stabilized enough to handle 50,000 concurrent users, meeting the
original (inadequate) capacity target. The final cost of building and fixing Healthcare.gov exceeded $1.7 billion.

### Root Cause Analysis

1. **No systems integrator**: 55 contractors with no single entity responsible for integration
2. **Late requirements**: Political decisions finalized months before launch
3. **No load testing**: The system was never tested under realistic conditions
4. **Synchronous architecture**: Account creation made blocking calls to external services
5. **No monitoring**: No visibility into system behavior under load
6. **Political deadline**: The launch date was immovable regardless of technical readiness
7. **23% tested**: The vast majority of the system was untested at launch

### Go Code: Production Load Testing Framework

The Healthcare.gov disaster fundamentally came down to not testing the system under realistic load conditions.
Here is a production load testing framework in Go that generates realistic traffic patterns, measures
response characteristics, and identifies breaking points before they are discovered in production:

```go
package loadtest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Core types for the load testing framework
// -----------------------------------------------------------------------

// Scenario defines a single load testing scenario with its parameters,
// traffic pattern, and validation rules.
type Scenario struct {
	Name            string
	Description     string
	BaseURL         string
	Duration        time.Duration
	RampUpDuration  time.Duration
	RampDownDuration time.Duration
	MaxConcurrency  int
	TargetRPS       int
	Timeout         time.Duration
	Steps           []Step
	Thresholds      Thresholds
}

// Step represents a single action in a load test scenario, such as
// creating an account, verifying identity, or selecting a plan.
type Step struct {
	Name       string
	Method     string
	Path       string
	Headers    map[string]string
	Body       func() []byte
	Validate   func(resp *http.Response, body []byte) error
	ThinkTime  time.Duration
	Weight     float64 // probability of this step being selected (0-1)
}

// Thresholds define the pass/fail criteria for a load test. If any
// threshold is breached, the test reports a failure.
type Thresholds struct {
	MaxP50Latency    time.Duration
	MaxP95Latency    time.Duration
	MaxP99Latency    time.Duration
	MaxErrorRate     float64 // 0.0 to 1.0
	MinRequestsPerSec float64
}

// RequestResult captures the outcome of a single HTTP request during
// the load test.
type RequestResult struct {
	StepName   string
	StatusCode int
	Latency    time.Duration
	Error      error
	Timestamp  time.Time
	BytesIn    int64
	BytesOut   int64
}

// PhaseResult captures aggregate metrics for a specific phase of the
// load test (ramp-up, steady state, ramp-down).
type PhaseResult struct {
	Phase          string
	Duration       time.Duration
	TotalRequests  int64
	SuccessCount   int64
	ErrorCount     int64
	Latencies      []time.Duration
	ErrorsByType   map[string]int64
	RequestsPerSec float64
}

// LoadTestReport is the final output of a load test run, containing
// all metrics needed to determine whether the system is ready for
// production traffic.
type LoadTestReport struct {
	ScenarioName   string                `json:"scenario_name"`
	StartTime      time.Time             `json:"start_time"`
	EndTime        time.Time             `json:"end_time"`
	TotalDuration  time.Duration         `json:"total_duration"`
	TotalRequests  int64                 `json:"total_requests"`
	SuccessCount   int64                 `json:"success_count"`
	ErrorCount     int64                 `json:"error_count"`
	ErrorRate      float64               `json:"error_rate"`
	RequestsPerSec float64              `json:"requests_per_sec"`
	P50Latency     time.Duration         `json:"p50_latency"`
	P90Latency     time.Duration         `json:"p90_latency"`
	P95Latency     time.Duration         `json:"p95_latency"`
	P99Latency     time.Duration         `json:"p99_latency"`
	MaxLatency     time.Duration         `json:"max_latency"`
	MinLatency     time.Duration         `json:"min_latency"`
	AvgLatency     time.Duration         `json:"avg_latency"`
	Phases         []PhaseResult         `json:"phases"`
	StepMetrics    map[string]*StepMetrics `json:"step_metrics"`
	ThresholdsPassed bool                `json:"thresholds_passed"`
	FailedThresholds []string            `json:"failed_thresholds,omitempty"`
}

// StepMetrics captures per-step aggregate metrics.
type StepMetrics struct {
	Name           string        `json:"name"`
	TotalRequests  int64         `json:"total_requests"`
	SuccessCount   int64         `json:"success_count"`
	ErrorCount     int64         `json:"error_count"`
	P50Latency     time.Duration `json:"p50_latency"`
	P95Latency     time.Duration `json:"p95_latency"`
	P99Latency     time.Duration `json:"p99_latency"`
	AvgLatency     time.Duration `json:"avg_latency"`
}

// -----------------------------------------------------------------------
// Load test runner
// -----------------------------------------------------------------------

// Runner executes load test scenarios and produces reports.
type Runner struct {
	client  *http.Client
	results chan RequestResult
	mu      sync.Mutex
	allResults []RequestResult
}

// NewRunner creates a new load test runner with the given HTTP client
// configuration.
func NewRunner() *Runner {
	transport := &http.Transport{
		MaxIdleConns:        1000,
		MaxIdleConnsPerHost: 1000,
		MaxConnsPerHost:     1000,
		IdleConnTimeout:     90 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}
	return &Runner{
		client:  client,
		results: make(chan RequestResult, 100000),
	}
}

// Run executes the given scenario and returns a detailed report.
func (r *Runner) Run(ctx context.Context, scenario Scenario) (*LoadTestReport, error) {
	fmt.Printf("[LOAD TEST] Starting scenario: %s\n", scenario.Name)
	fmt.Printf("[LOAD TEST] Duration: %v, Max Concurrency: %d, Target RPS: %d\n",
		scenario.Duration, scenario.MaxConcurrency, scenario.TargetRPS)

	startTime := time.Now()

	// Collector goroutine aggregates results from workers.
	var collectorWg sync.WaitGroup
	collectorWg.Add(1)
	go func() {
		defer collectorWg.Done()
		for result := range r.results {
			r.mu.Lock()
			r.allResults = append(r.allResults, result)
			r.mu.Unlock()
		}
	}()

	// Execute the three phases: ramp-up, steady state, ramp-down.
	r.executeRampUp(ctx, scenario)
	r.executeSteadyState(ctx, scenario)
	r.executeRampDown(ctx, scenario)

	close(r.results)
	collectorWg.Wait()

	endTime := time.Now()

	// Build the report from collected results.
	report := r.buildReport(scenario, startTime, endTime)
	return report, nil
}

// executeRampUp gradually increases concurrency from 0 to MaxConcurrency
// over the ramp-up duration. This simulates realistic traffic growth
// and helps identify the point at which the system begins to degrade.
func (r *Runner) executeRampUp(ctx context.Context, scenario Scenario) {
	if scenario.RampUpDuration == 0 {
		return
	}
	fmt.Printf("[LOAD TEST] Ramp-up phase: %v\n", scenario.RampUpDuration)

	steps := 10
	stepDuration := scenario.RampUpDuration / time.Duration(steps)

	for i := 1; i <= steps; i++ {
		select {
		case <-ctx.Done():
			return
		default:
		}

		concurrency := (scenario.MaxConcurrency * i) / steps
		rps := (scenario.TargetRPS * i) / steps

		fmt.Printf("[LOAD TEST]   Ramp step %d/%d: %d concurrent, %d RPS\n",
			i, steps, concurrency, rps)

		r.executePhase(ctx, scenario, concurrency, rps, stepDuration)
	}
}

// executeSteadyState runs at full concurrency and target RPS for the
// main duration of the test. This is where the system's sustained
// performance characteristics are measured.
func (r *Runner) executeSteadyState(ctx context.Context, scenario Scenario) {
	steadyDuration := scenario.Duration - scenario.RampUpDuration - scenario.RampDownDuration
	if steadyDuration <= 0 {
		return
	}
	fmt.Printf("[LOAD TEST] Steady state phase: %v at %d concurrent, %d RPS\n",
		steadyDuration, scenario.MaxConcurrency, scenario.TargetRPS)

	r.executePhase(ctx, scenario, scenario.MaxConcurrency, scenario.TargetRPS, steadyDuration)
}

// executeRampDown gradually decreases concurrency, measuring how the
// system recovers when load is reduced.
func (r *Runner) executeRampDown(ctx context.Context, scenario Scenario) {
	if scenario.RampDownDuration == 0 {
		return
	}
	fmt.Printf("[LOAD TEST] Ramp-down phase: %v\n", scenario.RampDownDuration)

	steps := 5
	stepDuration := scenario.RampDownDuration / time.Duration(steps)

	for i := steps; i >= 1; i-- {
		select {
		case <-ctx.Done():
			return
		default:
		}

		concurrency := (scenario.MaxConcurrency * i) / steps
		rps := (scenario.TargetRPS * i) / steps

		r.executePhase(ctx, scenario, concurrency, rps, stepDuration)
	}
}

// executePhase runs load at the specified concurrency and RPS for the
// given duration. It uses a token bucket approach to maintain consistent
// request rates.
func (r *Runner) executePhase(
	ctx context.Context,
	scenario Scenario,
	concurrency int,
	targetRPS int,
	duration time.Duration,
) {
	if concurrency == 0 || targetRPS == 0 {
		return
	}

	phaseCtx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()

	// Token bucket for rate limiting.
	interval := time.Second / time.Duration(targetRPS)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for {
		select {
		case <-phaseCtx.Done():
			wg.Wait()
			return
		case <-ticker.C:
			sem <- struct{}{}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-sem }()

				step := r.selectStep(scenario.Steps)
				result := r.executeStep(phaseCtx, scenario, step)
				r.results <- result
			}()
		}
	}
}

// selectStep picks a step based on weight distribution, simulating
// realistic user behavior where some actions are more common than others.
func (r *Runner) selectStep(steps []Step) Step {
	if len(steps) == 0 {
		return Step{}
	}
	if len(steps) == 1 {
		return steps[0]
	}

	totalWeight := 0.0
	for _, s := range steps {
		totalWeight += s.Weight
	}

	roll := rand.Float64() * totalWeight
	cumulative := 0.0
	for _, s := range steps {
		cumulative += s.Weight
		if roll <= cumulative {
			return s
		}
	}
	return steps[len(steps)-1]
}

// executeStep performs a single HTTP request and captures the result.
func (r *Runner) executeStep(
	ctx context.Context,
	scenario Scenario,
	step Step,
) RequestResult {
	url := scenario.BaseURL + step.Path

	var bodyReader *strings.Reader
	var bodyBytes []byte
	if step.Body != nil {
		bodyBytes = step.Body()
		bodyReader = strings.NewReader(string(bodyBytes))
	}

	timeout := scenario.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var req *http.Request
	var err error
	if bodyReader != nil {
		req, err = http.NewRequestWithContext(reqCtx, step.Method, url, bodyReader)
	} else {
		req, err = http.NewRequestWithContext(reqCtx, step.Method, url, nil)
	}

	if err != nil {
		return RequestResult{
			StepName:  step.Name,
			Error:     fmt.Errorf("request creation failed: %w", err),
			Timestamp: time.Now(),
		}
	}

	for k, v := range step.Headers {
		req.Header.Set(k, v)
	}

	start := time.Now()
	resp, err := r.client.Do(req)
	latency := time.Since(start)

	if err != nil {
		return RequestResult{
			StepName:  step.Name,
			Latency:   latency,
			Error:     err,
			Timestamp: start,
			BytesOut:  int64(len(bodyBytes)),
		}
	}
	defer resp.Body.Close()

	result := RequestResult{
		StepName:   step.Name,
		StatusCode: resp.StatusCode,
		Latency:    latency,
		Timestamp:  start,
		BytesOut:   int64(len(bodyBytes)),
	}

	if step.Validate != nil {
		if validationErr := step.Validate(resp, nil); validationErr != nil {
			result.Error = validationErr
		}
	}

	if resp.StatusCode >= 400 {
		result.Error = fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	return result
}

// buildReport aggregates all collected results into a final report.
func (r *Runner) buildReport(
	scenario Scenario,
	startTime, endTime time.Time,
) *LoadTestReport {
	r.mu.Lock()
	results := make([]RequestResult, len(r.allResults))
	copy(results, r.allResults)
	r.mu.Unlock()

	if len(results) == 0 {
		return &LoadTestReport{
			ScenarioName: scenario.Name,
			StartTime:    startTime,
			EndTime:      endTime,
		}
	}

	var successCount, errorCount int64
	var latencies []time.Duration
	stepResults := make(map[string][]RequestResult)

	for _, res := range results {
		if res.Error != nil {
			errorCount++
		} else {
			successCount++
		}
		latencies = append(latencies, res.Latency)
		stepResults[res.StepName] = append(stepResults[res.StepName], res)
	}

	sort.Slice(latencies, func(i, j int) bool {
		return latencies[i] < latencies[j]
	})

	totalDuration := endTime.Sub(startTime)
	totalRequests := int64(len(results))

	report := &LoadTestReport{
		ScenarioName:   scenario.Name,
		StartTime:      startTime,
		EndTime:        endTime,
		TotalDuration:  totalDuration,
		TotalRequests:  totalRequests,
		SuccessCount:   successCount,
		ErrorCount:     errorCount,
		ErrorRate:      float64(errorCount) / float64(totalRequests),
		RequestsPerSec: float64(totalRequests) / totalDuration.Seconds(),
		P50Latency:     percentile(latencies, 50),
		P90Latency:     percentile(latencies, 90),
		P95Latency:     percentile(latencies, 95),
		P99Latency:     percentile(latencies, 99),
		MaxLatency:     latencies[len(latencies)-1],
		MinLatency:     latencies[0],
		AvgLatency:     avgDuration(latencies),
		StepMetrics:    make(map[string]*StepMetrics),
	}

	// Build per-step metrics.
	for stepName, stepRes := range stepResults {
		var sLatencies []time.Duration
		var sSuccess, sError int64
		for _, sr := range stepRes {
			sLatencies = append(sLatencies, sr.Latency)
			if sr.Error != nil {
				sError++
			} else {
				sSuccess++
			}
		}
		sort.Slice(sLatencies, func(i, j int) bool {
			return sLatencies[i] < sLatencies[j]
		})
		report.StepMetrics[stepName] = &StepMetrics{
			Name:          stepName,
			TotalRequests: int64(len(stepRes)),
			SuccessCount:  sSuccess,
			ErrorCount:    sError,
			P50Latency:    percentile(sLatencies, 50),
			P95Latency:    percentile(sLatencies, 95),
			P99Latency:    percentile(sLatencies, 99),
			AvgLatency:    avgDuration(sLatencies),
		}
	}

	// Evaluate thresholds.
	report.ThresholdsPassed = true
	if scenario.Thresholds.MaxP50Latency > 0 && report.P50Latency > scenario.Thresholds.MaxP50Latency {
		report.ThresholdsPassed = false
		report.FailedThresholds = append(report.FailedThresholds,
			fmt.Sprintf("P50 latency %v exceeds threshold %v",
				report.P50Latency, scenario.Thresholds.MaxP50Latency))
	}
	if scenario.Thresholds.MaxP95Latency > 0 && report.P95Latency > scenario.Thresholds.MaxP95Latency {
		report.ThresholdsPassed = false
		report.FailedThresholds = append(report.FailedThresholds,
			fmt.Sprintf("P95 latency %v exceeds threshold %v",
				report.P95Latency, scenario.Thresholds.MaxP95Latency))
	}
	if scenario.Thresholds.MaxP99Latency > 0 && report.P99Latency > scenario.Thresholds.MaxP99Latency {
		report.ThresholdsPassed = false
		report.FailedThresholds = append(report.FailedThresholds,
			fmt.Sprintf("P99 latency %v exceeds threshold %v",
				report.P99Latency, scenario.Thresholds.MaxP99Latency))
	}
	if scenario.Thresholds.MaxErrorRate > 0 && report.ErrorRate > scenario.Thresholds.MaxErrorRate {
		report.ThresholdsPassed = false
		report.FailedThresholds = append(report.FailedThresholds,
			fmt.Sprintf("Error rate %.4f exceeds threshold %.4f",
				report.ErrorRate, scenario.Thresholds.MaxErrorRate))
	}
	if scenario.Thresholds.MinRequestsPerSec > 0 && report.RequestsPerSec < scenario.Thresholds.MinRequestsPerSec {
		report.ThresholdsPassed = false
		report.FailedThresholds = append(report.FailedThresholds,
			fmt.Sprintf("RPS %.2f below threshold %.2f",
				report.RequestsPerSec, scenario.Thresholds.MinRequestsPerSec))
	}

	return report
}

// PrintReport outputs a human-readable summary of the load test results.
func (r *LoadTestReport) PrintReport() {
	fmt.Println("\n" + strings.Repeat("=", 70))
	fmt.Printf("  LOAD TEST REPORT: %s\n", r.ScenarioName)
	fmt.Println(strings.Repeat("=", 70))
	fmt.Printf("  Duration:     %v\n", r.TotalDuration)
	fmt.Printf("  Total Reqs:   %d\n", r.TotalRequests)
	fmt.Printf("  Success:      %d (%.2f%%)\n", r.SuccessCount,
		float64(r.SuccessCount)/float64(r.TotalRequests)*100)
	fmt.Printf("  Errors:       %d (%.2f%%)\n", r.ErrorCount, r.ErrorRate*100)
	fmt.Printf("  RPS:          %.2f\n", r.RequestsPerSec)
	fmt.Println(strings.Repeat("-", 70))
	fmt.Printf("  Latency P50:  %v\n", r.P50Latency)
	fmt.Printf("  Latency P90:  %v\n", r.P90Latency)
	fmt.Printf("  Latency P95:  %v\n", r.P95Latency)
	fmt.Printf("  Latency P99:  %v\n", r.P99Latency)
	fmt.Printf("  Latency Max:  %v\n", r.MaxLatency)
	fmt.Printf("  Latency Min:  %v\n", r.MinLatency)
	fmt.Printf("  Latency Avg:  %v\n", r.AvgLatency)
	fmt.Println(strings.Repeat("-", 70))

	if r.ThresholdsPassed {
		fmt.Println("  THRESHOLDS: ALL PASSED")
	} else {
		fmt.Println("  THRESHOLDS: FAILED")
		for _, t := range r.FailedThresholds {
			fmt.Printf("    - %s\n", t)
		}
	}
	fmt.Println(strings.Repeat("=", 70))
}

// SaveJSON writes the report to a JSON file for CI/CD integration.
func (r *LoadTestReport) SaveJSON(path string) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling report: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// -----------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func avgDuration(durations []time.Duration) time.Duration {
	if len(durations) == 0 {
		return 0
	}
	var total time.Duration
	for _, d := range durations {
		total += d
	}
	return total / time.Duration(len(durations))
}

// -----------------------------------------------------------------------
// Example: Healthcare.gov-style scenario
// -----------------------------------------------------------------------

// HealthcareEnrollmentScenario creates a load test scenario that
// simulates the Healthcare.gov enrollment workflow. This is the test
// that should have been run months before the October 2013 launch.
func HealthcareEnrollmentScenario(baseURL string) Scenario {
	return Scenario{
		Name:             "Healthcare Enrollment Flow",
		Description:      "Simulates the full enrollment workflow including account creation, identity verification, plan browsing, and enrollment",
		BaseURL:          baseURL,
		Duration:         30 * time.Minute,
		RampUpDuration:   5 * time.Minute,
		RampDownDuration: 2 * time.Minute,
		MaxConcurrency:   10000,
		TargetRPS:        5000,
		Timeout:          10 * time.Second,
		Steps: []Step{
			{
				Name:   "create_account",
				Method: "POST",
				Path:   "/api/v1/accounts",
				Headers: map[string]string{
					"Content-Type": "application/json",
				},
				Body: func() []byte {
					return []byte(fmt.Sprintf(`{
						"email": "user%d@loadtest.local",
						"password": "TestPass123!",
						"first_name": "Load",
						"last_name": "Tester"
					}`, rand.IntN(10000000)))
				},
				Weight: 0.2,
			},
			{
				Name:    "browse_plans",
				Method:  "GET",
				Path:    "/api/v1/plans?state=CA&zip=94102",
				Weight:  0.4,
			},
			{
				Name:   "verify_identity",
				Method: "POST",
				Path:   "/api/v1/identity/verify",
				Headers: map[string]string{
					"Content-Type": "application/json",
				},
				Body: func() []byte {
					return []byte(`{"ssn_last4": "1234", "dob": "1990-01-15"}`)
				},
				Weight: 0.15,
			},
			{
				Name:   "calculate_subsidy",
				Method: "POST",
				Path:   "/api/v1/subsidies/calculate",
				Headers: map[string]string{
					"Content-Type": "application/json",
				},
				Body: func() []byte {
					return []byte(`{"household_size": 3, "annual_income": 45000}`)
				},
				Weight: 0.15,
			},
			{
				Name:   "enroll",
				Method: "POST",
				Path:   "/api/v1/enrollments",
				Headers: map[string]string{
					"Content-Type": "application/json",
				},
				Body: func() []byte {
					return []byte(`{"plan_id": "BCBS-GOLD-2024", "effective_date": "2024-01-01"}`)
				},
				Weight: 0.1,
			},
		},
		Thresholds: Thresholds{
			MaxP50Latency:     500 * time.Millisecond,
			MaxP95Latency:     2 * time.Second,
			MaxP99Latency:     5 * time.Second,
			MaxErrorRate:      0.01, // 1% max error rate
			MinRequestsPerSec: 1000,
		},
	}
}
```

### Engineering Lessons

1. **Load test with realistic traffic volumes** - if you expect 250,000 concurrent users, test with 500,000.
2. **A system without monitoring is a system without understanding** - you cannot fix what you cannot see.
3. **Synchronous calls to external services are a cascading failure waiting to happen** - use async patterns,
   circuit breakers, and timeouts.
4. **Political deadlines do not change the laws of physics** - software that is not ready is not ready.
5. **55 contractors with no integrator is 55 independent projects** - someone must own the integration.
6. **23% tested means 77% unknown** - untested code is broken code that has not been discovered yet.

---

### Junior → FAANG: Load Testing and Integration Ownership as Interview Entry Points

Healthcare.gov is the interview answer to two distinct FAANG questions. For "how would you test a system before launch," the answer anchors to 23% test coverage and 250,000 concurrent users: realistic load testing at twice the expected peak, end-to-end integration testing across all contractor boundaries, and a hard go/no-go gate that a political deadline cannot override. For "how do you manage a project with many teams," the answer anchors to 55 contractors with no integrator: every large project needs a single owner for the integration layer who can reject work that does not meet the contract, and that owner must have the authority to delay the launch when the contract is not met. Naming the Healthcare.gov incident demonstrates that you understand the failure at the organizational level, not just the technical level.

### Senior @ FAANG: Integration Risk as a First-Class Project Deliverable

At L6, the Healthcare.gov failure is the clearest example of a project that had technically competent individual contributors but no integration engineering. Each of the 55 contractors delivered components that passed their own tests. The system failed because nobody owned the seams between those components, and the seams were where the most dangerous assumptions lived. The staff engineer's contribution to any large multi-team project is to make integration risk a named, tracked, first-class deliverable from day one. This means: defining explicit interface contracts with acceptance tests that cross team boundaries, scheduling regular full-system integration tests (not just per-component tests) throughout the project, owning the load test environment and ensuring it reflects production topology, and holding weekly integration health reviews that report the actual test coverage percentage to project leadership. When test coverage is at 23% four months before launch, that number needs to reach the person who can delay the launch. The staff engineer's job is to make that number visible, to explain in business terms what 77% untested means (unknown failure modes under production load), and to recommend the specific additional investment required to close the gap. At Healthcare.gov, nobody with the authority to delay the launch understood what 23% test coverage meant. That is the governance failure the staff engineer prevents.

---
