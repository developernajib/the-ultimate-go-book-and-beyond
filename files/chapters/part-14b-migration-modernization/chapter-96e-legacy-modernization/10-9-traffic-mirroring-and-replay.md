## 9. Traffic Mirroring and Replay

Traffic mirroring captures live production requests and replays them against the new service for regression testing without impacting users. Unlike shadow mode, which runs both services in real time, traffic mirroring records requests first and replays them later. This is useful when you want to test a new service that is not yet deployed alongside production, or when you need to replay a specific time window of traffic repeatedly to debug a particular issue. The mirror captures requests non-blockingly using a buffered channel and a pool of worker goroutines that replay them against the target. Auth headers are stripped to prevent credential leakage into the test environment.

```go
// file: internal/trafficmirror/mirror.go
package trafficmirror

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// CapturedRequest stores a request snapshot for replay.
type CapturedRequest struct {
	Method    string
	URL       string
	Headers   http.Header
	Body      []byte
	CapturedAt time.Time
	RequestID string
}

// ReplayResult records the outcome of replaying a captured request.
type ReplayResult struct {
	RequestID  string
	StatusCode int
	Body       []byte
	Latency    time.Duration
	Error      error
}

// Mirror captures and replays production traffic.
type Mirror struct {
	targetURL  string
	client     *http.Client
	capture    chan *CapturedRequest
	logger     *slog.Logger
	workers    int
	wg         sync.WaitGroup
	resultSink ResultSink
}

// ResultSink receives replay results for analysis.
type ResultSink interface {
	Consume(ctx context.Context, result *ReplayResult) error
}

// Config holds mirror configuration.
type Config struct {
	TargetURL   string
	Workers     int
	QueueSize   int
	Timeout     time.Duration
}

// NewMirror creates a traffic mirror with a bounded worker pool.
func NewMirror(cfg Config, sink ResultSink, logger *slog.Logger) *Mirror {
	if cfg.Workers <= 0 {
		cfg.Workers = 10
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 1000
	}
	m := &Mirror{
		targetURL:  cfg.TargetURL,
		client:     &http.Client{Timeout: cfg.Timeout},
		capture:    make(chan *CapturedRequest, cfg.QueueSize),
		logger:     logger,
		workers:    cfg.Workers,
		resultSink: sink,
	}
	for i := 0; i < cfg.Workers; i++ {
		m.wg.Add(1)
		go m.worker()
	}
	return m
}

// Capture records a request from the production path for later replay.
// It is non-blocking: if the queue is full, the request is dropped.
func (m *Mirror) Capture(r *http.Request, requestID string) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		m.logger.Warn("mirror: failed to read body", "error", err)
		return
	}
	// Restore body for the original handler.
	r.Body = io.NopCloser(bytes.NewReader(body))

	req := &CapturedRequest{
		Method:     r.Method,
		URL:        m.targetURL + r.URL.RequestURI(),
		Headers:    r.Header.Clone(),
		Body:       body,
		CapturedAt: time.Now(),
		RequestID:  requestID,
	}

	select {
	case m.capture <- req:
	default:
		m.logger.Warn("mirror queue full, dropping request", "request_id", requestID)
	}
}

// Shutdown drains the queue and waits for workers to finish.
func (m *Mirror) Shutdown() {
	close(m.capture)
	m.wg.Wait()
}

// worker replays captured requests against the mirror target.
func (m *Mirror) worker() {
	defer m.wg.Done()
	for captured := range m.capture {
		result := m.replay(captured)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := m.resultSink.Consume(ctx, result); err != nil {
			m.logger.Warn("mirror: result sink error", "error", err, "request_id", captured.RequestID)
		}
		cancel()
	}
}

// replay executes a single captured request against the target.
func (m *Mirror) replay(captured *CapturedRequest) *ReplayResult {
	req, err := http.NewRequest(captured.Method, captured.URL, bytes.NewReader(captured.Body))
	if err != nil {
		return &ReplayResult{RequestID: captured.RequestID, Error: fmt.Errorf("build replay request: %w", err)}
	}

	// Copy safe headers only - strip auth to avoid credential replay.
	for _, h := range []string{"Content-Type", "Accept", "X-Request-ID"} {
		if v := captured.Headers.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("X-Traffic-Mirror", "true")
	req.Header.Set("X-Original-Request-ID", captured.RequestID)

	start := time.Now()
	resp, err := m.client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return &ReplayResult{RequestID: captured.RequestID, Latency: latency, Error: err}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	return &ReplayResult{
		RequestID:  captured.RequestID,
		StatusCode: resp.StatusCode,
		Body:       body,
		Latency:    latency,
	}
}

// LoggingResultSink logs replay results using slog.
type LoggingResultSink struct {
	logger *slog.Logger
}

// NewLoggingResultSink creates a sink that logs all results.
func NewLoggingResultSink(logger *slog.Logger) *LoggingResultSink {
	return &LoggingResultSink{logger: logger}
}

func (s *LoggingResultSink) Consume(_ context.Context, r *ReplayResult) error {
	if r.Error != nil {
		s.logger.Error("mirror replay failed",
			"request_id", r.RequestID,
			"error", r.Error,
		)
		return nil
	}
	s.logger.Info("mirror replay result",
		"request_id", r.RequestID,
		"status_code", r.StatusCode,
		"latency_ms", r.Latency.Milliseconds(),
	)
	return nil
}
```

### Junior → FAANG: Traffic Mirroring as Offline Regression Testing

Traffic mirroring is distinct from shadow mode in an important way: shadow mode tests both systems in real time, while traffic mirroring records requests and replays them later. This distinction matters for several use cases that shadow mode cannot address: testing a new service that is not yet deployed to production, replaying a specific time window of traffic to reproduce a reported bug, or running regression tests against a new service version before deploying it.

The buffered channel and worker pool pattern in this implementation is a standard Go concurrency pattern for rate-limited background work. The channel acts as a bounded buffer: if the workers cannot keep up with the incoming request rate, the channel fills and new requests are dropped (via a non-blocking select). This is the correct behavior for a non-blocking observability component: it should never slow down or fail the main request path, even at the cost of losing some mirroring coverage.

The auth header stripping is a security requirement, not a convenience. Replaying requests with production credentials into a staging or test environment would expose production user data to a less-protected system. Always strip authentication headers and any other tokens before replaying to non-production targets.

### Senior @ FAANG: Traffic Replay Governance and the Capture-Replay Safety Model

At senior level, traffic capture and replay is a data governance concern as much as a technical one. Captured requests may contain sensitive user data (PII, payment information, health data) that is subject to privacy regulations. The governance requirements before deploying any traffic capture system: determine what data categories are present in the captured traffic, establish the retention policy for captured requests, determine whether regulatory compliance requires data minimization (stripping sensitive fields before storage), and ensure that captured data is stored in a system with appropriate access controls and audit logging.

The replay worker pool in this implementation has a fixed size, which is appropriate for environments where the new service's capacity is known and controlled. At senior level, the worker pool size should be dynamically configurable, with the ability to increase or decrease replay concurrency based on the new service's current health metrics. A new service that is responding slowly should receive fewer replay requests, not more.

The specific senior-level design question for traffic replay: what is the replay fidelity guarantee. If a request in the captured traffic depends on the state of the database at the time it was captured, replaying it against a different database state will produce a different result that is not a correctness bug. Distinguishing state-dependent divergences from genuine correctness bugs requires either replaying against a snapshot of the database at the capture time, or explicitly scoping replay validation to state-independent operations.

---
