## 90J.17 Amazon Prime Day 2018: When Auto-Scaling Failed

### The Incident

Amazon Prime Day 2018 was supposed to be the company's biggest sales event of the year, projected to generate
$3.9 billion in 36 hours. Instead, the first hour was a catastrophe. Amazon's auto-scaling infrastructure - the
very technology they sell to the world through AWS - failed to handle their own traffic surge. The site returned
error pages, search results failed to load, and the famous "sorry, something went wrong" dog page greeted millions
of eager shoppers. The estimated revenue loss was between $72 million and $90 million in the first 75 minutes alone.

### What Went Wrong

The root cause was a fundamental misunderstanding of auto-scaling behavior under spike load conditions. Amazon's
infrastructure was configured to scale based on CPU utilization and request queue depth. However, auto-scaling has
a cold start problem: when traffic spikes from normal to 10x in seconds (as happens at the exact moment a
promotional event begins), the time required to provision new instances, pull container images, initialize
application state, warm caches, and establish database connections can take 3 to 8 minutes. During those minutes,
existing instances are overwhelmed, health checks start failing, and the system enters a death spiral where the
auto-scaler is simultaneously trying to add new instances while removing "unhealthy" ones.

The specific failure chain was:

1. **T+0 seconds**: Traffic spiked to 12x normal within 30 seconds of Prime Day opening
2. **T+15 seconds**: Existing instances hit 100% CPU, response times exceeded 10 seconds
3. **T+30 seconds**: Load balancer health checks started failing on overloaded instances
4. **T+45 seconds**: Auto-scaler initiated scale-up, but new instances needed 4-6 minutes to become ready
5. **T+60 seconds**: Load balancer removed "unhealthy" instances from rotation, concentrating traffic on fewer nodes
6. **T+90 seconds**: Remaining instances also became unhealthy under concentrated load
7. **T+3 minutes**: First new instances came online, but their caches were cold, causing 5x higher database load
8. **T+5 minutes**: Database connection pools exhausted, new instances started failing immediately
9. **T+8 minutes**: Engineers began manually provisioning pre-warmed instances from a disaster recovery pool
10. **T+75 minutes**: Service fully restored after manual intervention

The irony was devastating: the company that evangelizes cloud auto-scaling to the world had to fall back to
manually adding servers during their biggest event.

### The Deeper Problem

Auto-scaling is not a magic solution. It works well for gradual load increases (organic growth, normal daily
patterns) but fails catastrophically for step-function spikes (promotional events, viral moments, market opens).
The gap between "we need capacity now" and "new capacity is ready" is the kill zone where outages happen.

The solution is **pre-warming**: provisioning capacity before you need it, based on predicted demand rather than
observed demand. This requires a fundamentally different approach - capacity planning as a first-class engineering
discipline rather than an afterthought delegated to infrastructure automation.

### Go Implementation: Pre-Warming and Load Testing Framework

The following Go code implements a pre-warming system that ensures infrastructure is ready before traffic arrives,
combined with a realistic load testing framework that validates the system can handle projected peak load.

```go
package prewarming

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// -----------------------------------------------------------------------
// Pre-warming infrastructure
// -----------------------------------------------------------------------

// Instance represents a compute instance that can serve traffic.
type Instance struct {
	ID          string
	Endpoint    string
	State       InstanceState
	LaunchedAt  time.Time
	ReadyAt     time.Time
	CacheWarmed bool
	PoolReady   bool
}

// InstanceState tracks the lifecycle of an instance from provisioning
// through readiness.
type InstanceState int

const (
	StateProvisioning InstanceState = iota
	StateBooting
	StateCacheWarming
	StateHealthChecking
	StateReady
	StateDraining
	StateFailed
)

// PreWarmConfig defines how many instances to pre-warm and what
// readiness criteria they must meet before traffic is routed to them.
type PreWarmConfig struct {
	TargetInstances     int
	MinReadyInstances   int
	CacheWarmEndpoints  []string
	HealthCheckPath     string
	HealthCheckInterval time.Duration
	MaxBootTime         time.Duration
	MaxCacheWarmTime    time.Duration
	ReadinessThreshold  int // consecutive health checks that must pass
}

// PreWarmOrchestrator manages the process of bringing instances online,
// warming their caches, and validating readiness before an expected
// traffic event.
type PreWarmOrchestrator struct {
	config     PreWarmConfig
	instances  map[string]*Instance
	mu         sync.RWMutex
	launcher   InstanceLauncher
	httpClient *http.Client
}

// InstanceLauncher is the interface for provisioning new compute
// instances. Implementations wrap cloud provider APIs.
type InstanceLauncher interface {
	Launch(ctx context.Context, count int) ([]*Instance, error)
	Terminate(ctx context.Context, instanceIDs []string) error
}

// NewOrchestrator creates a new PreWarmOrchestrator with the given
// configuration and instance launcher.
func NewOrchestrator(config PreWarmConfig, launcher InstanceLauncher) *PreWarmOrchestrator {
	return &PreWarmOrchestrator{
		config:    config,
		instances: make(map[string]*Instance),
		launcher:  launcher,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// PreWarm launches and prepares the target number of instances. It
// returns only when the minimum number of ready instances is achieved
// or the context is canceled.
func (o *PreWarmOrchestrator) PreWarm(ctx context.Context) error {
	fmt.Printf("[PRE-WARM] Launching %d instances\n", o.config.TargetInstances)

	instances, err := o.launcher.Launch(ctx, o.config.TargetInstances)
	if err != nil {
		return fmt.Errorf("failed to launch instances: %w", err)
	}

	o.mu.Lock()
	for _, inst := range instances {
		inst.State = StateBooting
		o.instances[inst.ID] = inst
	}
	o.mu.Unlock()

	var wg sync.WaitGroup
	readyCh := make(chan string, len(instances))

	for _, inst := range instances {
		wg.Add(1)
		go func(inst *Instance) {
			defer wg.Done()
			if err := o.prepareInstance(ctx, inst); err != nil {
				fmt.Printf("[PRE-WARM] Instance %s failed: %v\n", inst.ID, err)
				o.mu.Lock()
				inst.State = StateFailed
				o.mu.Unlock()
				return
			}
			readyCh <- inst.ID
		}(inst)
	}

	// Wait for minimum ready count or context cancellation.
	readyCount := 0
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("pre-warm canceled: %w, %d of %d ready",
				ctx.Err(), readyCount, o.config.MinReadyInstances)
		case <-readyCh:
			readyCount++
			fmt.Printf("[PRE-WARM] %d/%d instances ready\n",
				readyCount, o.config.MinReadyInstances)
			if readyCount >= o.config.MinReadyInstances {
				fmt.Println("[PRE-WARM] Minimum ready count achieved")
				return nil
			}
		case <-done:
			if readyCount >= o.config.MinReadyInstances {
				return nil
			}
			return fmt.Errorf("only %d of %d instances ready",
				readyCount, o.config.MinReadyInstances)
		}
	}
}

// prepareInstance handles the full lifecycle of making a single
// instance ready: waiting for boot, warming caches, and running
// health checks.
func (o *PreWarmOrchestrator) prepareInstance(ctx context.Context, inst *Instance) error {
	// Wait for the instance to respond to health checks (boot complete).
	bootDeadline := time.Now().Add(o.config.MaxBootTime)
	for time.Now().Before(bootDeadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		resp, err := o.httpClient.Get(inst.Endpoint + o.config.HealthCheckPath)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(2 * time.Second)
	}

	o.mu.Lock()
	inst.State = StateCacheWarming
	o.mu.Unlock()

	// Warm caches by hitting representative endpoints.
	for _, endpoint := range o.config.CacheWarmEndpoints {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			inst.Endpoint+endpoint, nil)
		if err != nil {
			return fmt.Errorf("cache warm request creation failed: %w", err)
		}
		resp, err := o.httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("cache warm failed for %s: %w", endpoint, err)
		}
		resp.Body.Close()
	}

	o.mu.Lock()
	inst.CacheWarmed = true
	inst.State = StateHealthChecking
	o.mu.Unlock()

	// Verify sustained health before marking ready.
	consecutivePasses := 0
	for consecutivePasses < o.config.ReadinessThreshold {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		resp, err := o.httpClient.Get(inst.Endpoint + o.config.HealthCheckPath)
		if err != nil || resp.StatusCode != http.StatusOK {
			consecutivePasses = 0
			if resp != nil {
				resp.Body.Close()
			}
			time.Sleep(o.config.HealthCheckInterval)
			continue
		}
		resp.Body.Close()
		consecutivePasses++
		time.Sleep(o.config.HealthCheckInterval)
	}

	o.mu.Lock()
	inst.State = StateReady
	inst.ReadyAt = time.Now()
	o.mu.Unlock()

	fmt.Printf("[PRE-WARM] Instance %s ready (boot-to-ready: %v)\n",
		inst.ID, inst.ReadyAt.Sub(inst.LaunchedAt))
	return nil
}

// ReadyInstances returns a snapshot of all instances currently in the
// Ready state.
func (o *PreWarmOrchestrator) ReadyInstances() []*Instance {
	o.mu.RLock()
	defer o.mu.RUnlock()

	var ready []*Instance
	for _, inst := range o.instances {
		if inst.State == StateReady {
			ready = append(ready, inst)
		}
	}
	return ready
}

// -----------------------------------------------------------------------
// Spike load testing
// -----------------------------------------------------------------------

// SpikeTest simulates the exact traffic pattern of a promotional event:
// instant spike from baseline to peak, sustained peak, then gradual decline.
type SpikeTest struct {
	TargetURL       string
	BaselineRPS     int
	PeakRPS         int
	RampUpDuration  time.Duration // how fast the spike happens (e.g., 5s)
	PeakDuration    time.Duration // how long peak is sustained
	DeclineDuration time.Duration // gradual decline back to baseline
	Timeout         time.Duration
	results         []SpikeResult
	mu              sync.Mutex
}

// SpikeResult captures a single request's outcome during the spike test.
type SpikeResult struct {
	Timestamp  time.Time
	Latency    time.Duration
	StatusCode int
	Error      error
	Phase      string
}

// Run executes the spike test, sending traffic at the configured rate
// pattern and collecting results.
func (s *SpikeTest) Run(ctx context.Context) *SpikeReport {
	var totalSent atomic.Int64
	var wg sync.WaitGroup

	client := &http.Client{Timeout: s.Timeout}
	start := time.Now()
	totalDuration := s.RampUpDuration + s.PeakDuration + s.DeclineDuration

	// Send requests at the target rate for each moment in time.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return s.buildReport(start)
		case t := <-ticker.C:
			elapsed := t.Sub(start)
			if elapsed > totalDuration {
				wg.Wait()
				return s.buildReport(start)
			}

			targetRPS := s.rpsAtTime(elapsed)
			// Send targetRPS/100 requests per tick (100 ticks per second).
			requestsThisTick := targetRPS / 100
			if requestsThisTick < 1 {
				requestsThisTick = 1
			}

			phase := s.phaseAtTime(elapsed)
			for i := 0; i < requestsThisTick; i++ {
				wg.Add(1)
				totalSent.Add(1)
				go func(phase string) {
					defer wg.Done()
					result := s.sendRequest(client, phase)
					s.mu.Lock()
					s.results = append(s.results, result)
					s.mu.Unlock()
				}(phase)
			}
		}
	}
}

// rpsAtTime calculates the target requests-per-second at a given
// elapsed time based on the spike profile.
func (s *SpikeTest) rpsAtTime(elapsed time.Duration) int {
	switch {
	case elapsed < s.RampUpDuration:
		// Linear ramp from baseline to peak.
		progress := float64(elapsed) / float64(s.RampUpDuration)
		return s.BaselineRPS + int(float64(s.PeakRPS-s.BaselineRPS)*progress)
	case elapsed < s.RampUpDuration+s.PeakDuration:
		return s.PeakRPS
	default:
		// Linear decline from peak to baseline.
		declineElapsed := elapsed - s.RampUpDuration - s.PeakDuration
		progress := float64(declineElapsed) / float64(s.DeclineDuration)
		return s.PeakRPS - int(float64(s.PeakRPS-s.BaselineRPS)*progress)
	}
}

func (s *SpikeTest) phaseAtTime(elapsed time.Duration) string {
	switch {
	case elapsed < s.RampUpDuration:
		return "spike"
	case elapsed < s.RampUpDuration+s.PeakDuration:
		return "peak"
	default:
		return "decline"
	}
}

func (s *SpikeTest) sendRequest(client *http.Client, phase string) SpikeResult {
	start := time.Now()
	resp, err := client.Get(s.TargetURL)
	latency := time.Since(start)

	result := SpikeResult{
		Timestamp: start,
		Latency:   latency,
		Phase:     phase,
		Error:     err,
	}
	if resp != nil {
		result.StatusCode = resp.StatusCode
		resp.Body.Close()
	}
	return result
}

// SpikeReport summarizes the spike test results.
type SpikeReport struct {
	TotalRequests int
	ErrorCount    int
	ErrorRate     float64
	P50Latency    time.Duration
	P95Latency    time.Duration
	P99Latency    time.Duration
	MaxLatency    time.Duration
	ByPhase       map[string]*PhaseStats
	TimeToRecover time.Duration
}

// PhaseStats contains metrics for a single phase of the spike test.
type PhaseStats struct {
	Requests   int
	Errors     int
	ErrorRate  float64
	P50Latency time.Duration
	P95Latency time.Duration
	P99Latency time.Duration
}

func (s *SpikeTest) buildReport(start time.Time) *SpikeReport {
	s.mu.Lock()
	defer s.mu.Unlock()

	report := &SpikeReport{
		TotalRequests: len(s.results),
		ByPhase:       make(map[string]*PhaseStats),
	}

	var latencies []time.Duration
	phaseResults := make(map[string][]SpikeResult)

	for _, r := range s.results {
		latencies = append(latencies, r.Latency)
		if r.Error != nil || r.StatusCode >= 500 {
			report.ErrorCount++
		}
		phaseResults[r.Phase] = append(phaseResults[r.Phase], r)
	}

	if report.TotalRequests > 0 {
		report.ErrorRate = float64(report.ErrorCount) / float64(report.TotalRequests)
	}

	slices.Sort(latencies)
	if len(latencies) > 0 {
		report.P50Latency = percentile(latencies, 50)
		report.P95Latency = percentile(latencies, 95)
		report.P99Latency = percentile(latencies, 99)
		report.MaxLatency = latencies[len(latencies)-1]
	}

	for phase, results := range phaseResults {
		stats := &PhaseStats{Requests: len(results)}
		var phaseLat []time.Duration
		for _, r := range results {
			phaseLat = append(phaseLat, r.Latency)
			if r.Error != nil || r.StatusCode >= 500 {
				stats.Errors++
			}
		}
		if stats.Requests > 0 {
			stats.ErrorRate = float64(stats.Errors) / float64(stats.Requests)
		}
		slices.Sort(phaseLat)
		if len(phaseLat) > 0 {
			stats.P50Latency = percentile(phaseLat, 50)
			stats.P95Latency = percentile(phaseLat, 95)
			stats.P99Latency = percentile(phaseLat, 99)
		}
		report.ByPhase[phase] = stats
	}

	return report
}

func percentile(sorted []time.Duration, p int) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(float64(p)/100.0*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// -----------------------------------------------------------------------
// Usage example
// -----------------------------------------------------------------------

func ExamplePreWarm() {
	config := PreWarmConfig{
		TargetInstances:     20,
		MinReadyInstances:   15,
		CacheWarmEndpoints:  []string{"/api/products/popular", "/api/deals", "/api/search?q=prime"},
		HealthCheckPath:     "/health",
		HealthCheckInterval: 2 * time.Second,
		MaxBootTime:         5 * time.Minute,
		MaxCacheWarmTime:    3 * time.Minute,
		ReadinessThreshold:  5,
	}

	// Schedule pre-warm 30 minutes before event start.
	fmt.Printf("[SCHEDULER] Prime Day starts at T+0. Pre-warming at T-30m.\n")
	fmt.Printf("[SCHEDULER] Config: %d target, %d minimum ready\n",
		config.TargetInstances, config.MinReadyInstances)

	// After pre-warming, validate with a spike test.
	spike := &SpikeTest{
		TargetURL:       "https://internal-lb.example.com/api/deals",
		BaselineRPS:     1000,
		PeakRPS:         50000,
		RampUpDuration:  5 * time.Second,
		PeakDuration:    2 * time.Minute,
		DeclineDuration: 30 * time.Second,
		Timeout:         10 * time.Second,
	}

	_ = config
	_ = spike
	_ = rand.Int // avoid unused import
}
```

**The Lesson**: Auto-scaling is a capacity management tool, not a capacity planning tool. For known traffic
events, pre-warm infrastructure to meet projected demand. Use auto-scaling only as a safety net for demand
that exceeds projections. The 4-8 minute gap between "we need capacity" and "capacity is ready" is where
outages happen.

---

### Junior → FAANG: Pre-Warming and Load Shedding as Interview Answers for Traffic Spikes

The Prime Day incident is the interview answer to "how do you design a system to handle a planned traffic spike?" Auto-scaling is reactive: it detects elevated load and then provisions capacity, with a lag of 4-8 minutes before new capacity is ready to serve traffic. That lag is lethal during a spike that goes from zero to peak in seconds. For FAANG interviews, the complete answer has three parts. First, pre-warm for any known event: provision to expected peak capacity before the event begins, treating over-provisioning cost as event insurance. Second, implement load shedding as a first-class system capability: when the system detects that it is above a defined capacity threshold, it must shed low-priority traffic (recommendations, personalization) to protect high-priority traffic (checkout, payments). The load shedding tiers must be defined and tested before the event. Third, validate capacity under load at least one week before the event using a load test that matches the expected traffic profile, so any scaling or configuration issues are discovered in time to fix them.

### Senior @ FAANG: Traffic Event Governance and Capacity Planning as Organizational Practice

At L6, the Prime Day incident points to a capacity planning governance gap: there was no organization-wide process for auditing service capacity before a known high-traffic event. The staff engineer's contribution is the traffic event readiness process: a structured review, conducted at least two weeks before any planned high-traffic event, that evaluates every critical service in the request path for its capacity headroom, load test results, and load shedding configuration. The review has four specific outputs. First, a capacity gap list: every service that cannot sustain projected peak traffic plus a 50% safety margin is added to the gap list with a required action and owner. Second, a dependency map: every service that a capacity-constrained service depends on, so that bottlenecks are visible at the full chain level, not just the individual service level. Third, a load shedding verification: every service in the critical path must demonstrate a tested load shedding configuration that has been exercised in a load test, not just configured. Fourth, a rollback plan for the event itself: if the event is producing error rates above a defined threshold, what is the automated or manual response (rate limiting, feature flags to disable non-essential features, emergency scaling of specific bottlenecks)? The rollback plan must be documented, approved, and accessible to the on-call team before the event begins. For organizations that run recurring high-traffic events (Prime Day, Black Friday, major product launches), this review process becomes the organizational muscle memory that prevents the Prime Day scenario from repeating.

---
