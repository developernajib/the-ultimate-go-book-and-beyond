## Section 3: Shadow Traffic Testing

Shadow traffic (also called **dark-launch traffic** or **mirrored traffic**) is the highest-fidelity production validation short of an actual user-facing rollout: real requests, real shapes, real concurrency, zero user-visible blast radius. Service meshes (Istio `VirtualService.mirror`, Linkerd `HTTPRoute.requestMirrorPolicy`, Envoy `request_mirror_policies`) implement it at L7, and every serious API gateway (Kong, Gloo, AWS App Mesh) exposes it as a first-class knob. The in-process Go implementation below is what you reach for when you need per-request comparison logic, selective sampling by feature flag, or response-diffing, capabilities the mesh does not provide.

**Critical safety rule**: shadow services MUST be side-effect-free or routed to an isolated write path. A shadow that hits the real payment gateway will double-charge users. The standard mitigations are (1) deploy the shadow with a `X-Shadow-Request: true` header and short-circuit all side-effecting calls based on it, (2) point the shadow at a separate database or a read-only replica, or (3) front external dependencies with a recording mock in the shadow environment.

### 3.1 Traffic Mirroring

Traffic mirroring duplicates production requests to a shadow service asynchronously, allowing the shadow service to process real load without its responses affecting the user. The technique is invaluable for validating a new implementation against real traffic before switching over, testing a new database schema under production query patterns, and load-testing a service using production traffic rather than synthetic scenarios. The mirroring middleware below forks the request body into a goroutine, fires the shadow request with a short timeout that doesn't affect the primary response, and records the shadow response code and latency in a metrics counter for comparison.

```go
package shadow

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"time"
)

// ShadowProxy mirrors traffic to a shadow backend without affecting responses.
type ShadowProxy struct {
	primary      http.Handler
	shadow       *httputil.ReverseProxy
	shadowURL    string
	enabled      atomic.Bool
	sampleRate   float64       // 0.0-1.0
	timeout      time.Duration
	differences  atomic.Int64
	comparisons  atomic.Int64
	compareFn    func(primary, shadow *http.Response) bool
}

// NewShadowProxy creates a proxy that mirrors to a shadow backend.
func NewShadowProxy(primary http.Handler, shadowURLStr string, sampleRate float64) (*ShadowProxy, error) {
	shadowURL, err := url.Parse(shadowURLStr)
	if err != nil {
		return nil, fmt.Errorf("parse shadow URL: %w", err)
	}

	sp := &ShadowProxy{
		primary:    primary,
		shadow:     httputil.NewSingleHostReverseProxy(shadowURL),
		shadowURL:  shadowURLStr,
		sampleRate: sampleRate,
		timeout:    5 * time.Second,
	}
	sp.enabled.Store(true)

	// Shadow errors should not affect primary responses
	sp.shadow.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("shadow error for %s %s: %v", r.Method, r.URL.Path, err)
	}

	return sp, nil
}

// ServeHTTP handles the primary request and optionally mirrors to shadow.
func (sp *ShadowProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Capture primary response
	rec := &responseRecorder{ResponseWriter: w}

	// Buffer request body for mirroring
	var bodyBytes []byte
	if r.Body != nil {
		bodyBytes, _ = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	// Serve primary request
	sp.primary.ServeHTTP(rec, r)

	// Mirror to shadow (non-blocking, sampled)
	if sp.enabled.Load() && sp.shouldSample() {
		go sp.mirrorToShadow(r, bodyBytes, rec.statusCode, rec.body.Bytes())
	}
}

// shouldSample decides whether to mirror this request. Sampling is random
// (unlike canary assignment, which must be sticky per user): each request is
// an independent observation, and there is no user-visible state to keep
// consistent because the shadow response is discarded.
//
// The top-level math/rand/v2 functions are safe for concurrent use and need
// no seeding, so there is no shared PRNG to lock on the proxy's hot path.
func (sp *ShadowProxy) shouldSample() bool {
	if sp.sampleRate >= 1.0 {
		return true
	}
	if sp.sampleRate <= 0 {
		return false
	}
	return rand.Float64() < sp.sampleRate
}

func (sp *ShadowProxy) mirrorToShadow(
	original *http.Request,
	bodyBytes []byte,
	primaryStatus int,
	primaryBody []byte,
) {
	ctx, cancel := context.WithTimeout(context.Background(), sp.timeout)
	defer cancel()

	// Clone request for shadow
	shadowReq, err := http.NewRequestWithContext(ctx, original.Method, sp.shadowURL+original.URL.RequestURI(), bytes.NewReader(bodyBytes))
	if err != nil {
		return
	}

	// Copy headers
	for k, v := range original.Header {
		shadowReq.Header[k] = v
	}
	shadowReq.Header.Set("X-Shadow-Request", "true")

	shadowRec := httptest.NewRecorder()
	sp.shadow.ServeHTTP(shadowRec, shadowReq)

	sp.comparisons.Add(1)

	// Compare responses if compareFn is set
	if sp.compareFn != nil {
		primaryResp := &http.Response{
			StatusCode: primaryStatus,
			Body:       io.NopCloser(bytes.NewReader(primaryBody)),
		}
		shadowResp := shadowRec.Result()

		if !sp.compareFn(primaryResp, shadowResp) {
			sp.differences.Add(1)
			log.Printf("shadow diff: %s %s - primary=%d shadow=%d",
				original.Method, original.URL.Path, primaryStatus, shadowRec.Code)
		}
	}
}

// SetCompareFn sets a function to compare primary and shadow responses.
func (sp *ShadowProxy) SetCompareFn(fn func(primary, shadow *http.Response) bool) {
	sp.compareFn = fn
}

// DifferenceRate returns what fraction of mirrored requests had different responses.
func (sp *ShadowProxy) DifferenceRate() float64 {
	comparisons := sp.comparisons.Load()
	if comparisons == 0 {
		return 0
	}
	return float64(sp.differences.Load()) / float64(comparisons)
}

// Stats returns shadow testing statistics.
func (sp *ShadowProxy) Stats() map[string]any {
	return map[string]any{
		"comparisons":     sp.comparisons.Load(),
		"differences":     sp.differences.Load(),
		"difference_rate": fmt.Sprintf("%.4f", sp.DifferenceRate()),
		"sample_rate":     sp.sampleRate,
	}
}

// responseRecorder captures an http.ResponseWriter's output.
type responseRecorder struct {
	http.ResponseWriter
	statusCode int
	body       bytes.Buffer
}

func (rr *responseRecorder) WriteHeader(code int) {
	rr.statusCode = code
	rr.ResponseWriter.WriteHeader(code)
}

func (rr *responseRecorder) Write(b []byte) (int, error) {
	rr.body.Write(b)
	return rr.ResponseWriter.Write(b)
}
```

### 3.2 Side-effect safety is the whole game

The single failure mode that sinks shadow-traffic adoption is a shadow service that accidentally causes real side effects. Double-charging a user, duplicating an email, triggering a webhook, writing to the primary database. Each of these has made the "why we stopped using shadow traffic" slide at more than one conference talk. Three rules prevent it. First, every side-effecting call in the shadow codebase checks an `IsShadow(ctx)` predicate and short-circuits when true. This must be checked in code review for every PR that touches an integration point. Second, point the shadow at a dedicated database or a read-only replica. Production data mutation must be physically impossible, not merely suppressed by a flag that someone might disable. Third, audit all external dependencies (payment processors, email providers, webhook endpoints) and confirm either that they are sandboxed in the shadow environment or that the `IsShadow` short-circuit covers them. The audit is a one-time investment per new shadow deployment and saves the catastrophic incident that ends shadow testing for good.

### 3.3 Junior → FAANG: response diffing as the main signal

A shadow deployment without response diffing is half-useful. It confirms the shadow does not crash but tells you nothing about whether it would have returned the right answer. With response diffing, every shadow request compares the shadow's response to the primary's, and differences surface real behavioral regressions. Practise writing a compare function: compare status codes, compare the structure of JSON responses (ignoring timestamps and IDs), compare ordering of items where order is deterministic. The first time you run response diffing and see that your "refactor" changed behavior in 3 percent of cases, the value becomes obvious. This is the technique that turns shadow traffic from "we ran the new code against real load" into "we proved the new code produces the same answers as the old code." Interviewers love the story: "I shadow-deployed a refactor, saw 3 percent response diff, investigated, and found a bug the unit tests missed."

### 3.4 Senior @ FAANG: the shadow environment as a platform artifact

At scale, shadow environments are a platform investment. The artifacts to maintain: (1) a sandboxed infrastructure that mirrors production topology but has no production side effects. (2) standard middleware that adds `X-Shadow-Request: true` and short-circuits side-effecting calls. (3) a response-diffing tool that aggregates and visualizes diffs across requests. (4) a rollout pattern that combines feature flags, canary, and shadow into a single progressive-delivery ladder. (5) a retention policy for shadow logs and traces that respects PII obligations. Teams that have this platform spin up shadow deployments in a day. Teams that do not take weeks to set up each shadow deployment and often skip it for time reasons. The platform is the force multiplier, and staff engineers who build it buy their organization confidence that scales across dozens of services.

---
