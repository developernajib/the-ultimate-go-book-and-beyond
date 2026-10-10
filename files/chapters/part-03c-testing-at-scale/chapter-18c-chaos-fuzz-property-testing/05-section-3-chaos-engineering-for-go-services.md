## Section 3: Chaos Engineering for Go Services

### 3.1 Fault Injection Middleware

Fault injection middleware intercepts outgoing service calls and selectively introduces delays, errors, and connection resets based on configurable rules, simulating the failure modes that downstream services exhibit in production without requiring a real failing service. Implementing fault injection as HTTP middleware means it can be activated at runtime via a control API, enabling failure scenarios in a running staging environment without redeploying. The middleware below supports latency injection with a configurable distribution, error injection at a specified rate, and a circuit-breaker bypass mode that lets through a percentage of requests even during an injected outage.

Before hand-rolling middleware, consider the two standard tools in the Go chaos toolbox:

- **Toxiproxy** (Shopify) sits as a TCP proxy between your service and each dependency. You declare toxics (latency, bandwidth cap, slow_close, timeout, reset_peer) via its HTTP API, and tests can enable or disable them mid-run. It is the right pick for integration tests that hit real databases, caches, or message brokers over the network, because it exercises the same kernel socket path production traffic takes.
- **`github.com/pingcap/failpoint`** (used heavily by TiDB) injects named failure points into Go source via comments. A build tag swaps the comments for real `if` branches that trigger panics, sleeps, or custom errors. It is the right pick for injecting faults deep inside a binary, for example inside a storage engine, where middleware cannot reach.

Use HTTP middleware when you control the service and want runtime toggles, Toxiproxy when you want to shape the network between processes, and `failpoint` when you need to inject faults inside critical internal code paths.

```go
package chaos

import (
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync/atomic"
	"time"
)

// FaultConfig defines fault injection parameters.
type FaultConfig struct {
	LatencyP    float64       // probability of injecting latency
	LatencyMin  time.Duration
	LatencyMax  time.Duration
	ErrorP      float64       // probability of returning HTTP error
	ErrorStatus int           // status to return on error
	PanicP      float64       // probability of panicking (test recovery)
	AbortP      float64       // probability of closing connection without response
	Enabled     atomic.Bool   // hot-switch: enable/disable at runtime
}

// DefaultChaosConfig has low fault rates for gradual testing.
func DefaultChaosConfig() *FaultConfig {
	cfg := &FaultConfig{
		LatencyP:    0.01, // 1% of requests get extra latency
		LatencyMin:  50 * time.Millisecond,
		LatencyMax:  500 * time.Millisecond,
		ErrorP:      0.005, // 0.5% get errors
		ErrorStatus: http.StatusServiceUnavailable,
		PanicP:      0.0,
		AbortP:      0.0,
	}
	return cfg
}

// randLatency picks a delay in [min, max]. Int64N panics on a non-positive
// argument, so a config with LatencyMin == LatencyMax (a perfectly reasonable
// "always add exactly 100ms" setting) would take the whole server down. Guard
// the degenerate range rather than trusting callers.
func randLatency(min, max time.Duration) time.Duration {
	spread := int64(max - min)
	if spread <= 0 {
		return min
	}
	return min + time.Duration(rand.Int64N(spread))
}

// ChaosMiddleware injects faults into HTTP handlers.
func ChaosMiddleware(cfg *FaultConfig, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !cfg.Enabled.Load() {
			next.ServeHTTP(w, r)
			return
		}

		// Use the top-level math/rand/v2 functions. They are safe for
		// concurrent use and already seeded randomly. Building a fresh PCG
		// per request from time.Now().UnixNano() would be both wasteful and
		// wrong: two requests served in the same clock tick would draw an
		// identical sequence, correlating the faults you meant to be
		// independent.

		// Inject panic
		if cfg.PanicP > 0 && rand.Float64() < cfg.PanicP {
			panic("chaos: injected panic")
		}

		// Abort connection
		if cfg.AbortP > 0 && rand.Float64() < cfg.AbortP {
			// Hijack and close without response
			if hj, ok := w.(http.Hijacker); ok {
				conn, _, _ := hj.Hijack()
				conn.Close()
				return
			}
		}

		// Inject latency
		if cfg.LatencyP > 0 && rand.Float64() < cfg.LatencyP {
			select {
			case <-time.After(randLatency(cfg.LatencyMin, cfg.LatencyMax)):
			case <-r.Context().Done():
				http.Error(w, "request canceled", http.StatusServiceUnavailable)
				return
			}
		}

		// Inject error
		if cfg.ErrorP > 0 && rand.Float64() < cfg.ErrorP {
			http.Error(w, "chaos: injected error", cfg.ErrorStatus)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// FaultInjector injects faults into an http.RoundTripper.
type FaultInjector struct {
	base        http.RoundTripper
	cfg         *FaultConfig
	injected    atomic.Int64
	passthrough atomic.Int64
}

func NewFaultInjector(base http.RoundTripper, cfg *FaultConfig) *FaultInjector {
	return &FaultInjector{base: base, cfg: cfg}
}

func (f *FaultInjector) RoundTrip(req *http.Request) (*http.Response, error) {
	if !f.cfg.Enabled.Load() {
		f.passthrough.Add(1)
		return f.base.RoundTrip(req)
	}

	// Inject timeout error
	if f.cfg.ErrorP > 0 && rand.Float64() < f.cfg.ErrorP {
		f.injected.Add(1)
		return nil, fmt.Errorf("chaos: injected network error")
	}

	// Inject latency
	if f.cfg.LatencyP > 0 && rand.Float64() < f.cfg.LatencyP {
		select {
		case <-time.After(randLatency(f.cfg.LatencyMin, f.cfg.LatencyMax)):
		case <-req.Context().Done():
			f.injected.Add(1)
			return nil, req.Context().Err()
		}
		f.injected.Add(1)
	}

	f.passthrough.Add(1)
	return f.base.RoundTrip(req)
}

func (f *FaultInjector) Stats() (injected, passthrough int64) {
	return f.injected.Load(), f.passthrough.Load()
}
```

### 3.2 Chaos Experiment Framework

A chaos experiment framework encodes chaos scenarios as structured test cases with a hypothesis, an action (fault injection), a method (metrics collection), and a rollback procedure that restores the system to a known good state if the hypothesis is violated. Formalizing experiments this way makes them repeatable, auditable, and automatable as part of a game day or CI pipeline, rather than ad-hoc manual interventions that are difficult to compare across runs. The framework below defines the experiment interface and a runner that executes the action, monitors the metrics, evaluates the hypothesis, and calls rollback unconditionally before reporting results.

```go
package chaos

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Hypothesis describes what we expect to observe.
type Hypothesis struct {
	Name        string
	Description string
	// SteadyState returns true if the system is in acceptable state.
	SteadyState func(ctx context.Context) (bool, string)
}

// Turbulence injects faults during an experiment.
type Turbulence struct {
	Name    string
	Inject  func(ctx context.Context)
	Cleanup func(ctx context.Context)
}

// ChaosExperiment runs a hypothesis under turbulence.
type ChaosExperiment struct {
	Name        string
	Hypothesis  Hypothesis
	Turbulence  Turbulence
	Duration    time.Duration
	Concurrency int
}

// ExperimentResult holds the outcome.
type ExperimentResult struct {
	Name            string
	Passed          bool
	SteadyStatePre  bool
	SteadyStatePost bool
	Observations    []Observation
	Duration        time.Duration
	Error           error
}

// Observation is a single data point during the experiment.
type Observation struct {
	Timestamp time.Time
	Healthy   bool
	Detail    string
}

// Run executes the chaos experiment.
func (e *ChaosExperiment) Run(ctx context.Context) ExperimentResult {
	result := ExperimentResult{Name: e.Name}
	start := time.Now()

	// Step 1: Verify steady state before turbulence
	ok, detail := e.Hypothesis.SteadyState(ctx)
	result.SteadyStatePre = ok
	if !ok {
		result.Error = fmt.Errorf("pre-experiment steady state failed: %s", detail)
		return result
	}

	// Step 2: Inject turbulence
	turbCtx, turbCancel := context.WithTimeout(ctx, e.Duration)
	defer turbCancel()

	go e.Turbulence.Inject(turbCtx)
	defer func() {
		turbCancel()
		e.Turbulence.Cleanup(ctx)
	}()

	// Step 3: Observe the system under turbulence
	var (
		observations []Observation
		mu           sync.Mutex
	)

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	observeUntil := time.Now().Add(e.Duration)
	for time.Now().Before(observeUntil) {
		select {
		case <-ticker.C:
			ok, detail := e.Hypothesis.SteadyState(ctx)
			mu.Lock()
			observations = append(observations, Observation{
				Timestamp: time.Now(),
				Healthy:   ok,
				Detail:    detail,
			})
			mu.Unlock()
		case <-ctx.Done():
			result.Error = ctx.Err()
			return result
		}
	}

	// Step 4: Verify steady state after turbulence
	time.Sleep(2 * time.Second) // recovery window
	ok, detail = e.Hypothesis.SteadyState(ctx)
	result.SteadyStatePost = ok

	result.Observations = observations
	result.Duration = time.Since(start)

	// Pass if system remained healthy during at least 95% of observations
	healthy := 0
	for _, obs := range observations {
		if obs.Healthy {
			healthy++
		}
	}
	if len(observations) > 0 {
		availabilityPct := float64(healthy) / float64(len(observations)) * 100
		result.Passed = availabilityPct >= 95.0 && result.SteadyStatePost
	} else {
		result.Passed = result.SteadyStatePost
	}

	return result
}

// HTTPSteadyState checks that an HTTP endpoint returns 200.
func HTTPSteadyState(client *http.Client, url string) func(context.Context) (bool, string) {
	return func(ctx context.Context) (bool, string) {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return false, err.Error()
		}
		req = req.WithContext(ctx)
		resp, err := client.Do(req)
		if err != nil {
			return false, fmt.Sprintf("request failed: %v", err)
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			return false, fmt.Sprintf("status %d", resp.StatusCode)
		}
		return true, "OK"
	}
}

// TestChaosCircuitBreaker verifies a service with circuit breaker survives dependency failure.
func TestChaosCircuitBreaker(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping chaos test")
	}

	// Start a dependency service
	dependencyFailing := atomic.Bool{}
	dependency := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if dependencyFailing.Load() {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(200)
		fmt.Fprint(w, `{"status":"ok"}`)
	}))
	defer dependency.Close()

	// Start main service that calls dependency
	mainSvc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp, err := dependency.Client().Get(dependency.URL + "/health")
		if err != nil || resp.StatusCode != 200 {
			// With a circuit breaker, we'd return cached/degraded response
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		w.WriteHeader(200)
		fmt.Fprint(w, `{"status":"ok"}`)
	}))
	defer mainSvc.Close()

	experiment := &ChaosExperiment{
		Name:     "Dependency Failure",
		Duration: 5 * time.Second,
		Hypothesis: Hypothesis{
			Name:        "Main service stays available during dependency failure",
			Description: "With circuit breaker, main service returns 5xx gracefully, not hanging",
			// In this basic test, we just verify no hang (timeout)
			SteadyState: func(ctx context.Context) (bool, string) {
				ctx2, cancel := context.WithTimeout(ctx, 2*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx2, "GET", mainSvc.URL+"/health", nil)
				resp, err := mainSvc.Client().Do(req)
				if err != nil {
					// A timeout/error is NOT OK - we want a fast failure response
					return false, fmt.Sprintf("request hung or failed: %v", err)
				}
				defer resp.Body.Close()
				io.Copy(io.Discard, resp.Body)
				// 200 or 503 are both OK - what matters is a fast response
				return true, fmt.Sprintf("got %d quickly", resp.StatusCode)
			},
		},
		Turbulence: Turbulence{
			Name: "Kill dependency",
			Inject: func(ctx context.Context) {
				dependencyFailing.Store(true)
				<-ctx.Done()
			},
			Cleanup: func(ctx context.Context) {
				dependencyFailing.Store(false)
			},
		},
	}

	result := experiment.Run(context.Background())

	if !result.Passed {
		t.Errorf("chaos experiment %q failed: steady_pre=%v steady_post=%v",
			result.Name, result.SteadyStatePre, result.SteadyStatePost)
		for _, obs := range result.Observations {
			if !obs.Healthy {
				t.Logf("  unhealthy at %v: %s", obs.Timestamp.Format(time.RFC3339), obs.Detail)
			}
		}
	}
}
```

### 3.3 Network Partition Simulation

Network partition simulation blocks traffic between specific service pairs to verify that the system degrades gracefully, continuing to serve requests that don't require the partitioned service while correctly reporting errors for those that do, rather than hanging indefinitely or silently serving stale data. Using Linux network namespaces and `tc` (traffic control) rules inside testcontainer networks allows fine-grained partition simulation without affecting the host machine's networking. The simulation below implements a `NetworkPartition` type that blocks traffic between two testcontainer services for the duration of a test and restores it in a cleanup hook.

```go
package chaos

import (
	"net"
	"sync/atomic"
	"time"
)

// PartitionableListener simulates network partitions by selectively
// accepting or dropping connections.
type PartitionableListener struct {
	net.Listener
	partitioned atomic.Bool
	blocked     atomic.Int64
}

// NewPartitionableListener wraps a real listener.
func NewPartitionableListener(addr string) (*PartitionableListener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	return &PartitionableListener{Listener: ln}, nil
}

// Accept drops connections during a partition and returns them normally
// otherwise.
//
// Note the loop. The tempting alternative is to close the connection and
// return a custom error, but an error from Accept is a message to the
// caller's accept loop, not to the client. http.Server treats a non-temporary
// error as fatal and shuts the whole listener down, and even a temporary one
// costs it a backoff sleep before it tries again. Neither models a partition,
// where the listener is healthy and it is the individual connection that dies.
// Closing and continuing gives the client the connection reset it would really
// see, and leaves the server none the wiser.
func (l *PartitionableListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if !l.partitioned.Load() {
			return conn, nil
		}
		l.blocked.Add(1)
		conn.Close() // drop the connection, keep listening
	}
}

// Partition enables the network partition.
func (l *PartitionableListener) Partition()   { l.partitioned.Store(true) }
func (l *PartitionableListener) Heal()        { l.partitioned.Store(false) }
func (l *PartitionableListener) Dropped() int64 { return l.blocked.Load() }

// SlowConn wraps a net.Conn to inject per-byte latency.
type SlowConn struct {
	net.Conn
	readDelay  time.Duration
	writeDelay time.Duration
}

func NewSlowConn(conn net.Conn, readDelay, writeDelay time.Duration) *SlowConn {
	return &SlowConn{Conn: conn, readDelay: readDelay, writeDelay: writeDelay}
}

func (c *SlowConn) Read(b []byte) (int, error) {
	if c.readDelay > 0 {
		time.Sleep(c.readDelay)
	}
	return c.Conn.Read(b)
}

func (c *SlowConn) Write(b []byte) (int, error) {
	if c.writeDelay > 0 {
		time.Sleep(c.writeDelay)
	}
	return c.Conn.Write(b)
}
```

### 3.4 Deterministic Time in Chaos Tests with testing/synctest

Chaos tests for timeouts, circuit breakers, retries, and rate limiters are notoriously flaky because they lean on real wall clock time. Sleeping for 500ms to observe a 400ms timeout firing is both slow and brittle under CI contention. `testing/synctest`, stable as of Go 1.25, runs your test inside a fake-time goroutine bubble where `time.Sleep`, `time.After`, `time.NewTimer`, and `context.WithTimeout` advance virtual time instantly once all goroutines in the bubble are blocked on a timer. Tests that used to take seconds and flake on a slow runner become millisecond-deterministic. The test below sleeps through 61 seconds of virtual time and three one-second upstream calls, and completes in well under a millisecond of real time.

`NewBreaker`, `BreakerConfig`, and the `State` constants below stand in for whatever circuit breaker your service uses. The point is the time control around them, not the breaker itself.

```go
package chaos

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

// TestCircuitBreakerOpensOnTimeouts verifies the breaker opens after
// repeated upstream timeouts, using virtual time for determinism.
func TestCircuitBreakerOpensOnTimeouts(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		br := NewBreaker(BreakerConfig{
			Threshold:   3,
			Window:      30 * time.Second,
			ResetAfter:  60 * time.Second,
			CallTimeout: 200 * time.Millisecond,
		})

		slowUpstream := func(ctx context.Context) error {
			// Upstream that always exceeds the breaker's call timeout.
			select {
			case <-time.After(1 * time.Second):
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		for i := 0; i < 3; i++ {
			_ = br.Call(context.Background(), slowUpstream)
		}

		if br.State() != StateOpen {
			t.Fatalf("expected breaker open after 3 timeouts, got %v", br.State())
		}

		// Advance 60s of virtual time to trigger half-open probe.
		time.Sleep(61 * time.Second)
		if br.State() != StateHalfOpen {
			t.Fatalf("expected half-open after reset window, got %v", br.State())
		}
	})
}
```

> **Senior track**: get the bubble rule exactly right, because the failure mode is confusing. Goroutines started *inside* the bubble are part of it and share its fake clock, so spawning workers in the test is fine and expected. The rule that bites is this: virtual time only advances when every goroutine in the bubble is *durably blocked*, meaning blocked on something only another bubble goroutine can unblock. A goroutine waiting on anything outside the bubble (a shared HTTP server started in `TestMain`, a real network read, an external process) is not durably blocked, so the clock stops advancing and `Test` fails the test as deadlocked rather than hanging forever. Keep the test self-contained: start what you need inside the callback and use a fake network rather than a real socket. Also note `T.Run`, `T.Parallel`, and `T.Deadline` must not be called on the bubble's `*testing.T`, and the clock in every bubble starts at midnight UTC on 2000-01-01, so do not assert on absolute wall-clock dates.

### 3.5 The chaos experiment design document

Every chaos experiment that runs outside a single engineer's local machine deserves a written design doc. Five sections, none skippable. **Hypothesis**: what do we expect to happen under the fault injection, expressed as a concrete testable claim. **Steady state**: what metrics prove the system is healthy, and what thresholds define "degraded" vs "broken." **Blast radius**: which services, users, or regions are affected, and how is the blast radius bounded. **Rollback plan**: how to stop the experiment, what the rollback takes in seconds, who has the authority to call it. **Escalation**: who is paged if the experiment goes wrong, who is on standby, what is the communication channel. Experiments without these five sections are what cause "chaos engineering caused an incident" blog posts. Experiments with them are what let companies run GameDays in production with confidence. The document is the discipline that separates chaos engineering from recklessness.

### 3.6 Junior → FAANG: your first local chaos test

Pick a Go HTTP service with at least one downstream call. Wrap the downstream HTTP client in the fault-injection middleware from section 3.1. Run the service locally. Hit it with load (one request every 500ms is enough). Toggle the fault injection on and off, and watch what happens. Does your service timeout correctly? Does it retry? Does it degrade gracefully or cascade? The first time you see your own service fail in a way you did not expect, chaos engineering becomes viscerally concrete. Then fix the failure mode, rerun, and confirm the new behavior. This local exercise is the gateway to comfortable chaos engineering at larger scale, and it builds intuition that no textbook can teach.

### 3.7 Senior @ FAANG: the GameDay playbook

A GameDay is a scheduled chaos exercise where the team deliberately injects failures in a controlled window and observes how the system and the team respond. The staff-engineer artifact is the GameDay playbook: (1) a list of candidate failure scenarios with blast radius and recovery procedures. (2) a schedule (quarterly, usually) that runs one scenario per session. (3) a debrief template that captures what was observed, what the team learned, and what the action items are. (4) an invitation list covering on-call engineers, SRE, and product. (5) a communication plan so stakeholders know the exercise is happening and is not a real incident. GameDays are the single most useful form of chaos engineering because they train the team, not just the system. A team that has practiced responding to a Redis outage handles the real one calmly. A team that has not panics. Running GameDays quarterly is what turns chaos engineering from a technical practice into an organizational capability.

---
