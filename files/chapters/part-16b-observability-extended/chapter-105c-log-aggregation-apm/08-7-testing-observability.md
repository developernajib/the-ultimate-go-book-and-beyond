## 105C.8 Testing Observability

Observability code must itself be tested: a logging middleware that swallows errors silently or a metrics counter that never increments is worse than no observability at all. The tests below use `slog` with an in-memory buffer to assert that specific fields and levels appear in log output, `httptest.NewRecorder` to capture response codes for metric verification, and the OpenTelemetry SDK's in-memory exporter to assert that spans are created with the correct attribute values without requiring a running Jaeger instance.

```go
package observability_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestStructuredLogging verifies structured log output
func TestStructuredLogging(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(LogConfig{
		Level:          slog.LevelDebug,
		Format:         "json",
		Output:         &buf,
		ServiceName:    "test-service",
		ServiceVersion: "1.0.0",
		Environment:    "test",
	})

	// Log a message
	logger.Info("test message", slog.String("key", "value"))

	// Parse and verify JSON output
	var entry map[string]any
	require.NoError(t, json.NewDecoder(&buf).Decode(&entry))

	assert.Equal(t, "test message", entry["message"])
	assert.Equal(t, "info", entry["log.level"])
	assert.Equal(t, "test-service", entry["service.name"])
	assert.Equal(t, "value", entry["key"])
	assert.NotEmpty(t, entry["@timestamp"])
}

// TestCorrelationIDPropagation tests correlation ID through context
func TestCorrelationIDPropagation(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(LogConfig{
		Format:         "json",
		Output:         &buf,
		ServiceName:    "test-service",
		ServiceVersion: "1.0.0",
	})
	ctxLogger := NewContextLogger(logger)

	ctx := WithCorrelationID(context.Background(), "corr-123")
	ctxLogger.WithContext(ctx).Info("test with correlation")

	var entry map[string]any
	require.NoError(t, json.NewDecoder(&buf).Decode(&entry))
	assert.Equal(t, "corr-123", entry["correlation_id"])
}

// TestLoggingMiddleware tests HTTP logging middleware
func TestLoggingMiddleware(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(LogConfig{
		Format:      "json",
		Output:      &buf,
		ServiceName: "test-service",
	})

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	mw := LoggingMiddleware(logger)
	ts := httptest.NewServer(mw(handler))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/test")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// Verify correlation ID in response
	assert.NotEmpty(t, resp.Header.Get("X-Correlation-ID"))

	// Parse logs. Expect two entries (request started + completed)
	entries := strings.Split(strings.TrimSpace(buf.String()), "\n")
	assert.Len(t, entries, 2)

	var completionLog map[string]any
	require.NoError(t, json.Unmarshal([]byte(entries[1]), &completionLog))
	assert.Equal(t, float64(200), completionLog["http.status_code"])
	assert.NotNil(t, completionLog["http.duration"])
}

// TestSampledLogger tests log sampling
func TestSampledLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(LogConfig{
		Format:      "json",
		Output:      &buf,
		ServiceName: "test-service",
	})

	sampled := NewSampledLogger(logger, 10) // 1 in 10

	for range 100 {
		sampled.InfoSampled(context.Background(), "test-key", "test message")
	}

	// Should have ~10 log entries (100 / 10 sample rate)
	entries := strings.Split(strings.TrimSpace(buf.String()), "\n")
	assert.Equal(t, 10, len(entries))
}

// TestErrorTracking tests error deduplication
func TestErrorTracking(t *testing.T) {
	alerts := &mockAlertManager{}
	tracker := NewErrorTracker(alerts, 24*time.Hour, AlertThresholds{
		NewErrorAlert: true,
	})

	err1 := errors.New("connection refused")
	err2 := errors.New("connection refused")

	ctx := context.Background()

	tracker.Track(ctx, err1, nil)
	tracker.Track(ctx, err2, nil)
	tracker.Track(ctx, err2, nil)

	// Same error message = same fingerprint = deduplicated
	topErrors := tracker.GetTopErrors(10)
	assert.Len(t, topErrors, 1)
	assert.Equal(t, 3, topErrors[0].Occurrences)

	// New error alert should have fired once
	assert.Equal(t, 1, alerts.alertCount)
}

// TestLogVolumeSampler tests adaptive sampling
func TestLogVolumeSampler(t *testing.T) {
	sampler := NewLogVolumeSampler(10) // 10 logs/second target

	// Errors should always pass
	assert.True(t, sampler.ShouldLog("test-service", "error"))

	// Low volume should pass
	for range 5 {
		assert.True(t, sampler.ShouldLog("test-service", "info"))
	}
}

// Mock implementations
type mockAlertManager struct {
	alertCount int
	lastAlert  Alert
}

func (m *mockAlertManager) SendAlert(ctx context.Context, alert Alert) error {
	m.alertCount++
	m.lastAlert = alert
	return nil
}
```

### Junior → FAANG: Observability Code Is Production Code

Instrumentation code (span creation, metric recording, log emission) is subject to the same quality standards as business logic code: it should be unit tested, reviewed in code review, and covered by integration tests. An instrumentation bug that produces incorrect metrics or drops spans is a reliability issue: it means alerts may fail to fire when they should, or fire when they should not.

For a first job, write at least one test for every instrumentation addition: use `tracetest.NewSpanRecorder` to verify spans are created with the correct attributes, use a `prometheus.Registry` with `prometheus.Gatherer` to verify metric values after test scenarios, and use a `bytes.Buffer` backed slog handler to verify log output in unit tests.

### Senior @ FAANG: Observability Testing as a Platform Requirement

At L6, observability testing is a requirement for platform library acceptance. Before any version of the shared `go-observability` library is published, the platform team runs a suite of contract tests that verify: the HTTP middleware emits the correct span attributes on success and error, the database wrapper emits the correct semantic convention attributes including sanitized `db.statement`, the log handler injects `trace_id` and `span_id` when an active span is present, and the metric initialization code produces the correct metric names and labels.

These contract tests are the specification for the library. Any change that causes a test to fail represents a breaking change to the observability contract, which requires a deprecation process and communication to all consuming services before the change is released.

---
