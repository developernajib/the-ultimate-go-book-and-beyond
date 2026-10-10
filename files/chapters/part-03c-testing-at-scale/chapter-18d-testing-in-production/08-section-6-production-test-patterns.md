## Section 6: Production Test Patterns

### 6.1 Dark Launching

Dark launching runs a new code path in production without returning its results to users, measuring performance and correctness against real traffic before any user-visible switch. The control function always serves the user's request. The candidate function runs in a background goroutine on a sampled subset of requests, and a comparison function checks whether the candidate's output matches the control's. This pattern is particularly useful when replacing an algorithm or migrating to a new data store: you can validate that the new implementation produces identical results under production load without any user-facing risk. If the mismatch rate stays at zero over a sustained period, you can confidently promote the candidate to primary.

```go
package darklaunch

import (
	"context"
	"log"
	"math/rand/v2"
	"sync/atomic"
	"time"
)

// DarkRunner runs a candidate function in the background and compares results.
type DarkRunner[T any] struct {
	control    func(ctx context.Context) (T, error)
	candidate  func(ctx context.Context) (T, error)
	compare    func(control, candidate T) bool
	enabled    atomic.Bool
	sampleRate float64
	mismatches atomic.Int64
	runs       atomic.Int64
}

func NewDarkRunner[T any](
	control func(context.Context) (T, error),
	candidate func(context.Context) (T, error),
	compare func(T, T) bool,
	sampleRate float64,
) *DarkRunner[T] {
	dr := &DarkRunner[T]{
		control:    control,
		candidate:  candidate,
		compare:    compare,
		sampleRate: sampleRate,
	}
	dr.enabled.Store(true)
	return dr
}

// Run executes control (always) and candidate (sampled), returning control result.
func (dr *DarkRunner[T]) Run(ctx context.Context) (T, error) {
	result, err := dr.control(ctx)

	if dr.enabled.Load() && dr.shouldSample() {
		go dr.runCandidate(ctx, result)
	}

	return result, err
}

func (dr *DarkRunner[T]) runCandidate(ctx context.Context, controlResult T) {
	// Use a fresh context with timeout to prevent dark traffic from blocking
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dr.runs.Add(1)
	candidateResult, err := dr.candidate(ctx)
	if err != nil {
		log.Printf("dark launch candidate error: %v", err)
		dr.mismatches.Add(1)
		return
	}

	if !dr.compare(controlResult, candidateResult) {
		dr.mismatches.Add(1)
		log.Printf("dark launch mismatch detected")
	}
}

func (dr *DarkRunner[T]) shouldSample() bool {
	if dr.sampleRate >= 1.0 {
		return true
	}
	if dr.sampleRate <= 0 {
		return false
	}
	// Concurrency-safe and unseeded. The old `rng.next()%1000 < rate*1000`
	// form also quantised the rate to three decimal places for no reason.
	return rand.Float64() < dr.sampleRate
}

// MismatchRate returns fraction of dark runs with differing results.
func (dr *DarkRunner[T]) MismatchRate() float64 {
	runs := dr.runs.Load()
	if runs == 0 {
		return 0
	}
	return float64(dr.mismatches.Load()) / float64(runs)
}
```

### 6.2 Dark launch vs shadow traffic: a fine distinction

Dark launching and shadow traffic are close cousins. The difference: shadow traffic duplicates the entire request (including the network path) to a separate service instance. Dark launch runs the candidate code inside the same process as the control, using the same context and data. Shadow traffic catches integration-level bugs (serialization, network, dependencies). Dark launch catches algorithmic bugs (different answer, different performance, different allocation pattern). Each fits a different use case. Replacing a service? Shadow. Replacing a function within a service? Dark launch. Replacing a database query? Shadow if the new query is implemented as a separate service call, dark launch if it is a new SQL string in the same handler. Knowing which pattern fits lets you reach for the right tool at design time, rather than reinventing one when you realize the other does not fit.

### 6.3 Junior → FAANG: the dark-launch pattern for refactors

Any time you refactor a non-trivial function, consider wrapping the old and new versions in `DarkRunner`. The old version serves the user, the new version runs in the background and compares results. Let it run for a week in production. If mismatch rate is zero, promote the new version and remove the old. If mismatch rate is non-zero, investigate. This pattern turns every refactor from a gamble into a measured change. It is also a concrete answer to the FAANG interview question "how do you safely refactor a function on a critical path?" Candidates who describe dark-launch patterns demonstrate the operational maturity that scales.

### 6.4 Senior @ FAANG: the production-test pattern library

Across feature flags, canaries, shadow traffic, dark launching, synthetic probes, and A/B tests, your team uses a handful of patterns repeatedly. The staff-level artifact is a documented pattern library: for each pattern, when to use it, when to avoid it, the Go code template, the observability it requires, and the rollback path. Publish it in the team wiki. Refresh it annually. New engineers learn the patterns in one session rather than rediscovering them per-service. Code reviews reference the patterns by name. Post-incident reviews say "we should have used pattern X" with a concrete link. This pattern library is the concrete expression of testing-in-production culture at a team level. Without it, each engineer reinvents the wheel, and the wheels they build are subtly different in ways that make troubleshooting harder. With it, the team shares a vocabulary that compounds across hires and years.

---
