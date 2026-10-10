## Section 2: Canary Deployments

### 2.0 Progressive Delivery on Kubernetes: Argo Rollouts and Flagger

Most production Go services running on Kubernetes do not hand-roll traffic splitting. They delegate it to a **progressive delivery controller**. The two mature options:

- **Argo Rollouts** (part of the Argo project, CNCF Graduated). Replaces the standard `Deployment` resource with a `Rollout` CRD that encodes canary stages as first-class steps: `setWeight: 5`, `pause: {duration: 10m}`, `analysis: {templates: [...]}`. Integrates with Istio, Linkerd, AWS ALB, NGINX Ingress, Gateway API, and any SMI-compliant mesh for traffic shaping. Analysis templates query Prometheus, Datadog, New Relic, CloudWatch, or Wavefront and abort the rollout when SLIs breach.
- **Flagger** (Flux ecosystem). Works with unmodified `Deployment` resources, drives canaries via `Canary` CRDs, and leans heavily on the service mesh for traffic shifting. Lighter adoption cost, tighter mesh coupling.

The modern pattern: wire canary analysis to **SLO burn-rate alerts** rather than raw error rates. A multi-window multi-burn-rate alert (the Google SRE workbook formulation: 2% budget burn over 1h *and* 5% over 6h) is far more reliable than a single threshold. An Argo Rollouts `AnalysisTemplate` with a Prometheus provider expresses this declaratively. The application code below still matters for in-process canary patterns (library rollouts, feature-level canaries that do not map to pod-level deployments), for dark launches, and for understanding what the controller is doing underneath you.

```yaml
# Argo Rollouts canary: 5% → 25% → 50% → 100% with automated analysis.
apiVersion: argoproj.io/v1alpha1
kind: Rollout
spec:
  strategy:
    canary:
      steps:
      - setWeight: 5
      - pause: {duration: 10m}
      - analysis:
          templates: [{templateName: slo-burn-rate}]
      - setWeight: 25
      - pause: {duration: 10m}
      - setWeight: 50
      - pause: {duration: 30m}
      - setWeight: 100
```

### 2.1 Traffic Splitting Router

A traffic splitting router directs a configurable percentage of requests to the canary version of a service while sending the remainder to the stable version, based on a consistent hash of the request's user ID to ensure each user always hits the same version during an experiment. Consistency matters because users who flip between versions mid-session experience state divergence that corrupts the experiment's metrics and degrades their experience. The router below implements consistent hash-based traffic splitting as an HTTP reverse proxy. `SetWeight` adjusts the split at runtime with no restart, so a control plane (or the analyzer in section 2.2) can drive the rollout by calling it.

One property worth noticing in the implementation: because assignment is a hash of the user rather than a per-request draw, raising the weight only ever *adds* users to the canary. Nobody is moved back to stable mid-rollout. A random draw gives you neither guarantee.

```go
package canary

import (
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"time"
)

// CanaryRouter splits traffic between stable and canary backends.
//
// Assignment is a consistent hash of the user identity, not a coin flip. This
// is the whole point: a random draw per request would move a user between
// versions mid-session, which corrupts the experiment and, worse, exposes the
// user to state that diverges between versions. Hashing also needs no shared
// PRNG state, so there is no lock on the proxy's hot path.
type CanaryRouter struct {
	stable         *httputil.ReverseProxy
	canary         *httputil.ReverseProxy
	canaryWeight   atomic.Int32 // 0-100: percentage to canary
	stableRequests atomic.Int64
	canaryRequests atomic.Int64
	stableErrors   atomic.Int64
	canaryErrors   atomic.Int64
	salt           string // rotate to reshuffle the population between rollouts
}

// bucketOf maps an identity to a stable bucket in [0,100).
//
// The salt matters. Without it, every rollout that uses this hash picks the
// same unlucky users first, so the same cohort eats every regression. Rotate
// it per rollout and the population reshuffles.
func bucketOf(salt, identity string) int {
	h := fnv.New64a()
	io.WriteString(h, salt)
	io.WriteString(h, identity)
	return int(h.Sum64() % 100)
}

// identify extracts the stickiness key. Prefer a real user or session ID.
// The fallback to RemoteAddr is deliberate but weak: behind a proxy it can
// collapse many users onto one address, so plumb a real identity through in
// production rather than relying on it.
func identify(r *http.Request) string {
	if uid := r.Header.Get("X-User-ID"); uid != "" {
		return uid
	}
	if c, err := r.Cookie("session_id"); err == nil && c.Value != "" {
		return c.Value
	}
	return r.RemoteAddr
}

// NewCanaryRouter creates a router with configurable traffic split.
func NewCanaryRouter(stableURL, canaryURL string, initialWeight int) (*CanaryRouter, error) {
	su, err := url.Parse(stableURL)
	if err != nil {
		return nil, fmt.Errorf("parse stable URL: %w", err)
	}
	cu, err := url.Parse(canaryURL)
	if err != nil {
		return nil, fmt.Errorf("parse canary URL: %w", err)
	}

	cr := &CanaryRouter{
		stable: httputil.NewSingleHostReverseProxy(su),
		canary: httputil.NewSingleHostReverseProxy(cu),
		salt:   fmt.Sprintf("rollout-%d", time.Now().UnixNano()),
	}
	cr.canaryWeight.Store(int32(initialWeight))

	cr.stable.ErrorHandler = cr.stableErrorHandler
	cr.canary.ErrorHandler = cr.canaryErrorHandler

	return cr, nil
}

// SetWeight updates the canary traffic percentage (0-100).
func (cr *CanaryRouter) SetWeight(pct int) {
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	cr.canaryWeight.Store(int32(pct))
}

func (cr *CanaryRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	weight := cr.canaryWeight.Load()

	// Same user, same bucket, every request. Raising the weight only ever
	// adds users to the canary, it never moves anyone back to stable.
	useCanary := bucketOf(cr.salt, identify(r)) < int(weight)

	if useCanary {
		cr.canaryRequests.Add(1)
		r.Header.Set("X-Canary", "true")
		cr.canary.ServeHTTP(w, r)
	} else {
		cr.stableRequests.Add(1)
		cr.stable.ServeHTTP(w, r)
	}
}

func (cr *CanaryRouter) stableErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	cr.stableErrors.Add(1)
	http.Error(w, "stable backend error", http.StatusBadGateway)
}

func (cr *CanaryRouter) canaryErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	cr.canaryErrors.Add(1)
	http.Error(w, "canary backend error", http.StatusBadGateway)
}

// counters is a snapshot of the four request/error counters.
type counters struct {
	stableReqs, canaryReqs, stableErrs, canaryErrs int64
}

// Snapshot reads all four counters. Callers diff two snapshots to get the
// traffic seen during an interval rather than since process start.
func (cr *CanaryRouter) Snapshot() counters {
	return counters{
		stableReqs: cr.stableRequests.Load(),
		canaryReqs: cr.canaryRequests.Load(),
		stableErrs: cr.stableErrors.Load(),
		canaryErrs: cr.canaryErrors.Load(),
	}
}

// ratesSince returns error rates for the traffic that arrived after `base`,
// plus the canary request count in that interval.
//
// Note what the zero-request case returns: ok=false, NOT a rate of 0. A rate
// of zero reads as "perfectly healthy" to every threshold comparison below,
// so a canary receiving no traffic at all would sail through the gate. When
// there is no data, say so, and let the caller decide.
func (cr *CanaryRouter) ratesSince(base counters) (stableRate, canaryRate float64, canaryReqs int64, ok bool) {
	now := cr.Snapshot()
	sReqs := now.stableReqs - base.stableReqs
	cReqs := now.canaryReqs - base.canaryReqs

	if cReqs <= 0 {
		return 0, 0, cReqs, false
	}
	canaryRate = float64(now.canaryErrs-base.canaryErrs) / float64(cReqs)
	if sReqs > 0 {
		stableRate = float64(now.stableErrs-base.stableErrs) / float64(sReqs)
	}
	return stableRate, canaryRate, cReqs, true
}

// ErrorRates returns cumulative error rates since process start. Useful for a
// dashboard, useless for a rollout gate: see ratesSince.
func (cr *CanaryRouter) ErrorRates() (stableRate, canaryRate float64) {
	s := cr.Snapshot()
	if s.stableReqs > 0 {
		stableRate = float64(s.stableErrs) / float64(s.stableReqs)
	}
	if s.canaryReqs > 0 {
		canaryRate = float64(s.canaryErrs) / float64(s.canaryReqs)
	}
	return stableRate, canaryRate
}

// Stats returns current routing statistics.
func (cr *CanaryRouter) Stats() map[string]any {
	stableRate, canaryRate := cr.ErrorRates()
	return map[string]any{
		"canary_weight_pct":  cr.canaryWeight.Load(),
		"stable_requests":    cr.stableRequests.Load(),
		"canary_requests":    cr.canaryRequests.Load(),
		"stable_error_rate":  fmt.Sprintf("%.4f", stableRate),
		"canary_error_rate":  fmt.Sprintf("%.4f", canaryRate),
	}
}
```

### 2.2 Automated Canary Analysis

Automated canary analysis compares the error rate between the canary and baseline populations on a configurable cadence, promoting or rolling back the canary based on pre-defined thresholds. This reduces the time window between a regression landing in the canary and its removal from production. The analyzer below compares the canary's error rate against the stable baseline and rolls back when the canary is either bad in absolute terms or measurably worse than stable. Two details carry most of the safety, and both are easy to omit. First, every rate is computed over the *current stage only*, by diffing counter snapshots taken when the stage began. Second, warmup and soak time are also per stage. Judging a stage on counters accumulated since process start produces a gate that quietly stops working precisely when the blast radius is largest, and a warmup check against a cumulative counter passes once and then never gates again.

```go
package canary

import (
	"context"
	"fmt"
	"log"
	"time"
)

// CanaryAnalyzer monitors canary error rate and auto-rolls back.
type CanaryAnalyzer struct {
	router            *CanaryRouter
	threshold         float64 // max canary error rate above stable
	absoluteThreshold float64 // max canary error rate in absolute terms
	minStageDuration  time.Duration
	checkInterval     time.Duration
	warmupRequests    int64 // min canary requests per stage before analysis
	onRollback        func(reason string)
	onAdvance         func(newWeight int)
	stages            []int // rollout stages: [1, 5, 10, 25, 50, 100]
	currentStage      int

	// Counter snapshot and clock reading from when the current stage began.
	// Every decision is made against traffic since this point.
	//
	// This is the part that is easy to get wrong and hard to notice. Judging a
	// stage on counters accumulated since process start means a long healthy
	// history dilutes a fresh regression: with a million good requests behind
	// it, a canary failing 100% of live traffic needs roughly twenty thousand
	// failures before a 2% cumulative threshold even notices. The gate stays
	// green through the exact incident it exists to catch. Rates must be
	// computed over a bounded, recent window.
	stageBase    counters
	stageStarted time.Time
}

// NewCanaryAnalyzer creates an auto-analyzing canary.
func NewCanaryAnalyzer(
	router *CanaryRouter,
	threshold float64,
	onRollback func(string),
	onAdvance func(int),
) *CanaryAnalyzer {
	return &CanaryAnalyzer{
		router:            router,
		threshold:         threshold,
		absoluteThreshold: 0.05, // 5% errors is bad regardless of stable
		minStageDuration:  5 * time.Minute,
		checkInterval:     30 * time.Second,
		warmupRequests:    100,
		onRollback:        onRollback,
		onAdvance:         onAdvance,
		stages:            []int{1, 5, 10, 25, 50, 100},
		currentStage:      0,
	}
}

// Analyze runs the canary analysis loop.
func (ca *CanaryAnalyzer) Analyze(ctx context.Context) {
	// Start with stage 0 (1%)
	ca.advanceToStage(0)

	ticker := time.NewTicker(ca.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if ca.shouldRollback() {
				reason := ca.rollbackReason()
				log.Printf("canary: rolling back - %s", reason)
				ca.router.SetWeight(0)
				if ca.onRollback != nil {
					ca.onRollback(reason)
				}
				return
			}

			// Only advance once THIS stage has both soaked long enough and
			// seen enough of its own traffic. Both conditions are per stage.
			// Checking a cumulative counter here would satisfy the warmup
			// exactly once and then wave every later stage straight through,
			// taking 1% to 100% in five ticks without ever having measured a
			// single request above 1%.
			_, _, stageReqs, ok := ca.router.ratesSince(ca.stageBase)
			if !ok || stageReqs < ca.warmupRequests {
				log.Printf("canary: stage %d%% warming up (%d/%d requests this stage)",
					ca.stages[ca.currentStage], stageReqs, ca.warmupRequests)
				continue
			}
			if elapsed := time.Since(ca.stageStarted); elapsed < ca.minStageDuration {
				log.Printf("canary: stage %d%% soaking (%s/%s)",
					ca.stages[ca.currentStage], elapsed.Round(time.Second), ca.minStageDuration)
				continue
			}

			ca.currentStage++
			if ca.currentStage < len(ca.stages) {
				ca.advanceToStage(ca.currentStage)
			} else {
				log.Printf("canary: rollout complete at 100%%")
				return
			}

		case <-ctx.Done():
			return
		}
	}
}

// advanceToStage moves to a new weight and resets the measurement window, so
// each stage is judged only on the traffic it actually served.
func (ca *CanaryAnalyzer) advanceToStage(stage int) {
	weight := ca.stages[stage]
	ca.router.SetWeight(weight)
	ca.stageBase = ca.router.Snapshot()
	ca.stageStarted = time.Now()
	log.Printf("canary: advancing to %d%%", weight)
	if ca.onAdvance != nil {
		ca.onAdvance(weight)
	}
}

func (ca *CanaryAnalyzer) shouldRollback() bool {
	stableRate, canaryRate, stageReqs, ok := ca.router.ratesSince(ca.stageBase)

	// No traffic this stage means no evidence, and no evidence is not a pass.
	// Hold position rather than promoting on an empty sample.
	if !ok || stageReqs < ca.warmupRequests {
		return false
	}

	// Two independent gates. The absolute one catches a canary that is simply
	// broken. The comparative one catches a canary that is worse than the
	// stable version it wants to replace, which is the interesting case when
	// stable already carries a baseline error rate.
	excessOverStable := canaryRate - stableRate
	return canaryRate > ca.absoluteThreshold || excessOverStable > ca.threshold
}

func (ca *CanaryAnalyzer) rollbackReason() string {
	stableRate, canaryRate, stageReqs, ok := ca.router.ratesSince(ca.stageBase)
	if !ok {
		return "no canary traffic observed in the current stage"
	}
	return fmt.Sprintf(
		"stage %d%%: canary error rate %.2f%% vs stable %.2f%% over %d requests "+
			"(excess threshold %.2f%%, absolute threshold %.2f%%)",
		ca.stages[ca.currentStage], canaryRate*100, stableRate*100, stageReqs,
		ca.threshold*100, ca.absoluteThreshold*100)
}
```

### 2.3 The metrics that make canary analysis trustworthy

Canary analysis is only as good as the metrics you compare. A naive canary compares overall error rate between stable and canary, which catches obvious regressions but misses subtle ones. A mature canary compares a basket of metrics: error rate, p50 and p99 latency, throughput, goroutine count, allocation rate, CPU usage, and business KPIs (checkouts per minute, search result relevance scores). It also compares distributions, not just means: a canary with the same mean latency but a fatter p99 tail is a regression that mean comparison misses. The best tools for this are Netflix's Kayenta (open source, integrates with Argo Rollouts) or Datadog's and Honeycomb's built-in canary comparison views. Whatever you use, insist on distribution comparison and a metrics basket, not just mean error rate. A canary that passes on error rate but regresses on p99 is still a production incident waiting to happen.

### 2.4 Junior → FAANG: reading a canary dashboard

Open the canary dashboard during a real rollout at your company (or a simulated one locally). Read it like a checklist. Is the canary getting roughly its target traffic percentage? Is error rate delta below threshold? Is latency delta below threshold? Are there differences in status code distribution? Are there differences in log volume or error log rate? If any signal is off, promote or roll back based on which way the signal points. Practise this reading until it takes thirty seconds. The skill transfers to every rollout you will ever do. Interviewers love candidates who can narrate this process from memory, because it demonstrates the operational fluency of an engineer who has actually deployed at scale.

### 2.5 Senior @ FAANG: the canary platform contract

At staff level, canary deployments are a platform service, not a per-team concern. Write the contract. (1) Every service can opt into canary with a declarative config (Argo Rollouts `Rollout` CRD or equivalent). (2) The platform provides a standard AnalysisTemplate that queries Prometheus for SLO burn rate, error rate, and p99 latency. (3) Teams can add custom metrics to their canary analysis but cannot remove the baseline checks. (4) Rollback is automatic when any baseline check fails and is manual-only when a custom check fails (to avoid teams gaming their own gates). (5) Every canary produces a summary report that is auto-filed in a shared dashboard so post-incident reviews and leadership can trace release behavior. Without this contract, canaries are per-team and their quality is inconsistent. With it, every service benefits from the same baseline safety machinery, and staff engineers can improve the baseline once for everyone.

---
