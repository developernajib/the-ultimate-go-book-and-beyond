## 4. Shadow Mode Testing

Shadow mode sends every request to both the legacy and new service simultaneously. The legacy response is returned to the client, and the new service response is compared asynchronously to detect divergences. This is the safest way to validate the new service because no real user ever sees the new service's response. The shadow runner copies the incoming request, sends it to the new service in a background goroutine, and then performs a deep field-by-field JSON comparison between the legacy and new responses. Any differences are logged as divergences with the exact fields and values that differ. A semaphore limits the number of concurrent shadow goroutines to prevent the new service from being overwhelmed if it is slower than the legacy system.

```go
// file: internal/shadow/runner.go
package shadow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/example/gobook/internal/metrics"
)

// ComparisonResult records the outcome of a shadow comparison.
type ComparisonResult struct {
	RequestID      string
	Path           string
	Method         string
	LegacyStatus   int
	NewStatus      int
	StatusMatch    bool
	BodyMatch      bool
	LegacyBody     []byte
	NewBody        []byte
	LegacyLatency  time.Duration
	NewLatency     time.Duration
	Diff           []FieldDiff
	Timestamp      time.Time
}

// FieldDiff describes a single field divergence between legacy and new.
type FieldDiff struct {
	Field       string
	LegacyValue any
	NewValue    any
}

// ShadowRunner performs shadow request execution and comparison.
type ShadowRunner struct {
	legacyClient *http.Client
	newClient    *http.Client
	legacyBase   string
	newBase      string
	logger       *slog.Logger
	metrics      *metrics.MigrationMetrics
	resultCh     chan *ComparisonResult
	wg           sync.WaitGroup
	semaphore    chan struct{}
}

// Config configures the shadow runner.
type Config struct {
	LegacyBaseURL  string
	NewBaseURL     string
	MaxConcurrency int
	Timeout        time.Duration
}

// NewShadowRunner creates a shadow runner with bounded concurrency.
func NewShadowRunner(cfg Config, logger *slog.Logger, m *metrics.MigrationMetrics) *ShadowRunner {
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 50
	}
	transport := &http.Transport{
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     30 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   cfg.Timeout,
	}
	sr := &ShadowRunner{
		legacyClient: client,
		newClient:    client,
		legacyBase:   cfg.LegacyBaseURL,
		newBase:      cfg.NewBaseURL,
		logger:       logger,
		metrics:      m,
		resultCh:     make(chan *ComparisonResult, 1000),
		semaphore:    make(chan struct{}, cfg.MaxConcurrency),
	}
	go sr.processResults()
	return sr
}

// Execute sends the request to both services and compares results asynchronously.
// The caller receives the legacy response immediately - comparison runs in background.
func (sr *ShadowRunner) Execute(w http.ResponseWriter, r *http.Request, requestID string) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		sr.logger.Error("shadow: failed to read request body", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Execute legacy synchronously and return its response.
	legacyReq, err := sr.buildRequest(r.Context(), sr.legacyBase, r, body)
	if err != nil {
		sr.logger.Error("shadow: build legacy request", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	legacyStart := time.Now()
	legacyResp, legacyBody, legacyStatus, legacyErr := sr.executeRequest(legacyReq)
	legacyLatency := time.Since(legacyStart)

	if legacyErr != nil {
		sr.logger.Error("shadow: legacy request failed", "error", legacyErr)
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}

	// Copy legacy response headers and body to client.
	for k, vs := range legacyResp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(legacyStatus)
	_, _ = w.Write(legacyBody)

	// Execute new service in background without blocking the client.
	sr.wg.Add(1)
	go func() {
		defer sr.wg.Done()

		// Rate-limit shadow goroutines to prevent cascade overload.
		sr.semaphore <- struct{}{}
		defer func() { <-sr.semaphore }()

		newReq, err := sr.buildRequest(context.Background(), sr.newBase, r, body)
		if err != nil {
			sr.logger.Error("shadow: build new request", "error", err)
			return
		}

		newStart := time.Now()
		_, newBody, newStatus, newErr := sr.executeRequest(newReq)
		newLatency := time.Since(newStart)

		if newErr != nil {
			sr.logger.Warn("shadow: new service request failed",
				"error", newErr,
				"request_id", requestID,
			)
			sr.metrics.RecordShadowError(r.URL.Path)
			return
		}

		result := &ComparisonResult{
			RequestID:     requestID,
			Path:          r.URL.Path,
			Method:        r.Method,
			LegacyStatus:  legacyStatus,
			NewStatus:     newStatus,
			StatusMatch:   legacyStatus == newStatus,
			LegacyBody:    legacyBody,
			NewBody:       newBody,
			LegacyLatency: legacyLatency,
			NewLatency:    newLatency,
			Timestamp:     time.Now(),
		}
		result.BodyMatch, result.Diff = compareJSON(legacyBody, newBody)

		select {
		case sr.resultCh <- result:
		default:
			sr.logger.Warn("shadow: result channel full, dropping comparison", "request_id", requestID)
		}
	}()
}

// Wait blocks until all in-flight shadow goroutines complete. Call on shutdown.
func (sr *ShadowRunner) Wait() {
	sr.wg.Wait()
	close(sr.resultCh)
}

// buildRequest constructs an outbound HTTP request from the original.
func (sr *ShadowRunner) buildRequest(ctx context.Context, base string, orig *http.Request, body []byte) (*http.Request, error) {
	target := base + orig.URL.RequestURI()
	req, err := http.NewRequestWithContext(ctx, orig.Method, target, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	// Copy safe headers only - never forward auth tokens to shadow.
	for _, h := range []string{"Content-Type", "Accept", "X-Request-ID", "X-Correlation-ID"} {
		if v := orig.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	return req, nil
}

// executeRequest performs an HTTP request and reads the response body.
func (sr *ShadowRunner) executeRequest(req *http.Request) (*http.Response, []byte, int, error) {
	client := sr.legacyClient
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, resp.StatusCode, fmt.Errorf("read response body: %w", err)
	}
	return resp, body, resp.StatusCode, nil
}

// processResults drains the result channel and logs divergences.
func (sr *ShadowRunner) processResults() {
	for result := range sr.resultCh {
		sr.metrics.RecordShadowComparison(result.Path, result.StatusMatch && result.BodyMatch)

		if !result.StatusMatch {
			sr.logger.Warn("shadow divergence: status mismatch",
				"request_id", result.RequestID,
				"path", result.Path,
				"legacy_status", result.LegacyStatus,
				"new_status", result.NewStatus,
			)
		}
		if !result.BodyMatch {
			for _, diff := range result.Diff {
				sr.logger.Warn("shadow divergence: field mismatch",
					"request_id", result.RequestID,
					"path", result.Path,
					"field", diff.Field,
					"legacy_value", diff.LegacyValue,
					"new_value", diff.NewValue,
				)
			}
		}
	}
}

// compareJSON performs a deep field-by-field comparison of two JSON blobs.
func compareJSON(a, b []byte) (bool, []FieldDiff) {
	var mapA, mapB map[string]any
	if err := json.Unmarshal(a, &mapA); err != nil {
		return bytes.Equal(a, b), nil
	}
	if err := json.Unmarshal(b, &mapB); err != nil {
		return bytes.Equal(a, b), nil
	}
	var diffs []FieldDiff
	compareMapsDFS("", mapA, mapB, &diffs)
	return len(diffs) == 0, diffs
}

// compareMapsDFS recursively diffs two maps.
func compareMapsDFS(prefix string, a, b map[string]any, diffs *[]FieldDiff) {
	for k, va := range a {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		vb, exists := b[k]
		if !exists {
			*diffs = append(*diffs, FieldDiff{Field: key, LegacyValue: va, NewValue: nil})
			continue
		}
		aMap, aIsMap := va.(map[string]any)
		bMap, bIsMap := vb.(map[string]any)
		if aIsMap && bIsMap {
			compareMapsDFS(key, aMap, bMap, diffs)
		} else if fmt.Sprintf("%v", va) != fmt.Sprintf("%v", vb) {
			*diffs = append(*diffs, FieldDiff{Field: key, LegacyValue: va, NewValue: vb})
		}
	}
	for k, vb := range b {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if _, exists := a[k]; !exists {
			*diffs = append(*diffs, FieldDiff{Field: key, LegacyValue: nil, NewValue: vb})
		}
	}
}
```

### Junior → FAANG: Shadow Mode as Correctness Validation Before Risk

Shadow mode is one of the most powerful techniques in the incremental migration toolkit and one of the least intuitive for engineers who have not used it before. The key insight: you can run your new service against real production traffic, validate its correctness, and discover edge cases that no amount of unit testing or staging environment testing would reveal, all without any user ever seeing the new service's response.

The goroutine lifecycle management in this implementation is worth studying carefully. The shadow request is sent in a background goroutine, but the goroutine is bounded by a semaphore to prevent unbounded concurrency growth. The context for the shadow request has a separate timeout from the main request, and the goroutine is not leaked if the context is canceled. These are exactly the goroutine lifecycle management patterns that Go code review at FAANG companies looks for.

The response comparison logic is where shadow mode produces its most valuable output. Field-by-field comparison is more useful than byte-by-byte comparison because it identifies which specific fields differ, making it much easier to diagnose the root cause of divergences. Building a rich divergence report that includes the entity ID, the differing fields, and both values is the data that the migration team uses to understand whether a divergence is a bug in the new service or an expected behavioral difference.

### Senior @ FAANG: Shadow Mode Governance and the Divergence Analysis Process

At senior level, shadow mode is not just a technical tool: it is a governance mechanism for the migration. The divergence rate and the nature of divergences are the primary signals that determine whether the migration is ready to progress to the next traffic split milestone.

The governance process for shadow mode analysis: establish a baseline divergence rate in the first week of shadow mode (some divergences are expected due to timing differences and non-deterministic behavior). Define a threshold divergence rate below which the migration can proceed. Establish a review process for investigating any new divergence category that appears after the baseline is established. Document the resolution for each divergence category: is it a bug in the new service (must be fixed before proceeding), an expected behavioral difference (requires stakeholder sign-off), or a known limitation (documented and accepted).

The specific senior-level design decision in the shadow mode implementation: what to do when the shadow goroutine cannot complete because the new service is unavailable or slow. The implementation must distinguish between divergences caused by correctness bugs and divergences caused by infrastructure problems. Conflating the two metrics makes the divergence signal noisy and leads to incorrect conclusions about migration readiness.

---
