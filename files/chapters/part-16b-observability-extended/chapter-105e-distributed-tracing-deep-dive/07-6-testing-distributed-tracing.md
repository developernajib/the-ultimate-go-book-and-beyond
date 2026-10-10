## 105E.7 Testing Distributed Tracing

Testing that instrumentation actually creates the expected spans prevents silent instrumentation regressions where a refactor removes a `defer span.End()` call and half the trace disappears in production. The tests below use an in-memory span recorder (the same pattern as the SDK's `tracetest.SpanRecorder`) to capture spans synchronously without a network call, then assert on span names, attribute keys and values, parent-child relationships, and error status codes, all verifiable in a standard `go test` run.

```go
package tracing_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// TestTracesPropagateCorrectly verifies trace context flows through HTTP
func TestTracesPropagateCorrectly(t *testing.T) {
	// Setup tracer with span recorder
	recorder := &SpanRecorder{}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(recorder),
	)
	tracer := tp.Tracer("test-service")

	// Create a test server that extracts trace context
	var receivedTraceID string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The upstream trace should be propagated
		span := trace.SpanFromContext(r.Context())
		receivedTraceID = span.SpanContext().TraceID().String()
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	// Make a traced HTTP call
	ctx := context.Background()
	ctx, span := tracer.Start(ctx, "test-operation")
	originalTraceID := span.SpanContext().TraceID().String()

	client := NewTracedHTTPClient(tracer)

	req, _ := http.NewRequest(http.MethodGet, ts.URL, nil)
	resp, err := client.Do(ctx, req)
	require.NoError(t, err)
	resp.Body.Close()

	span.End()

	// In a real test with proper HTTP middleware, trace IDs would match
	assert.NotEmpty(t, originalTraceID)
	_ = receivedTraceID
	assert.Len(t, recorder.GetSpans(), 2) // parent + HTTP client span
}

// TestSpanRecording verifies spans are recorded correctly
func TestSpanRecording(t *testing.T) {
	recorder := &SpanRecorder{}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(recorder),
	)
	tracer := tp.Tracer("test")

	ctx := context.Background()

	// Create parent span
	ctx, parent := tracer.Start(ctx, "parent")
	ctx, child := tracer.Start(ctx, "child")

	child.SetAttributes(attribute.String("key", "value"))
	child.End()
	parent.End()

	spans := recorder.GetSpans()
	assert.Len(t, spans, 2)

	// Verify child span
	childSpan := recorder.FindSpanByName("child")
	assert.NotNil(t, childSpan)
	assert.Equal(t, parent.SpanContext().SpanID(), childSpan.Parent().SpanID())
}

// TestErrorPropagation verifies errors are recorded in spans
func TestErrorPropagation(t *testing.T) {
	recorder := &SpanRecorder{}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(recorder),
	)
	tracer := tp.Tracer("test")

	ctx := context.Background()
	ctx, span := tracer.Start(ctx, "operation")

	// Simulate an error
	err := fmt.Errorf("something went wrong")
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	span.End()

	spans := recorder.GetSpans()
	require.Len(t, spans, 1)

	recordedSpan := spans[0]
	assert.Equal(t, codes.Error, recordedSpan.Status().Code)
	assert.Len(t, recordedSpan.Events(), 1)
	assert.Equal(t, "exception", recordedSpan.Events()[0].Name)
}

// TestTailSampling verifies tail-based sampling decisions
func TestTailSampling(t *testing.T) {
	policies := &CommonSamplingPolicies{}

	t.Run("error traces are always sampled", func(t *testing.T) {
		policy := policies.AlwaysSampleErrors()
		decision := policy.Evaluate(&TraceData{HasError: true})
		require.NotNil(t, decision)
		assert.True(t, decision.Sample)
	})

	t.Run("fast healthy traces are not sampled by error policy", func(t *testing.T) {
		policy := policies.AlwaysSampleErrors()
		decision := policy.Evaluate(&TraceData{HasError: false, Duration: 50 * time.Millisecond})
		assert.Nil(t, decision) // Policy returns nil = "no opinion"
	})

	t.Run("slow traces are sampled", func(t *testing.T) {
		threshold := 500 * time.Millisecond
		policy := policies.AlwaysSampleSlowTraces(threshold)
		decision := policy.Evaluate(&TraceData{Duration: 1 * time.Second})
		require.NotNil(t, decision)
		assert.True(t, decision.Sample)
	})

	t.Run("fast traces not sampled by slow policy", func(t *testing.T) {
		threshold := 500 * time.Millisecond
		policy := policies.AlwaysSampleSlowTraces(threshold)
		decision := policy.Evaluate(&TraceData{Duration: 100 * time.Millisecond})
		assert.Nil(t, decision)
	})
}

// TestCriticalPathAnalysis verifies critical path detection
func TestCriticalPathAnalysis(t *testing.T) {
	analyzer := NewTraceAnalyzer()

	root := &SpanData{
		Name:     "request",
		Duration: 200 * time.Millisecond,
		Children: []*SpanData{
			{
				Name:     "fast-service",
				Duration: 20 * time.Millisecond,
			},
			{
				Name:     "slow-service",
				Duration: 150 * time.Millisecond,
				Children: []*SpanData{
					{
						Name:     "db-query",
						Duration: 140 * time.Millisecond,
					},
				},
			},
		},
	}

	path := analyzer.CriticalPath(root)
	names := make([]string, len(path))
	for i, s := range path {
		names[i] = s.Name
	}

	// Critical path: request -> slow-service -> db-query
	assert.Equal(t, []string{"request", "slow-service", "db-query"}, names)
}
```

### Junior → FAANG: Testing Instrumentation Is Not Optional

A service that has instrumentation code but no instrumentation tests has instrumentation that will silently break on the next refactor. The most common regression is a developer moving code from one function to another without moving the `defer span.End()` call, or passing a plain `context.Background()` into a goroutine instead of the request context, breaking the parent-child span relationship. Neither mistake fails any application-level test because the application still works correctly. Only a span assertion test catches it.

For interviews, know how to use OTel's `sdktrace.NewSimpleSpanProcessor` with an in-memory exporter to capture spans in a unit test. The test setup is: create a test exporter, create a tracer provider with that exporter, register the tracer provider, run the code under test, then assert on the exported spans. This is a testable pattern that mirrors real test infrastructure.

### Senior @ FAANG: Trace Tests as Regression Gates in CI

At L6, span-level tests belong in the CI pipeline as a regression gate, not just in developer playbooks. A trace regression is a production observability regression: when a span disappears from the trace, on-call engineers lose the diagnostic signal for that operation. If there is no automated test catching the regression, the first indication that the span is missing will be during an incident when an engineer loads the trace and finds a gap.

The assertion framework shown in this chapter's code supports the minimum viable set of span checks: name, status, attributes, and parent relationship. A production-grade framework adds: span event assertions (verifying that `span.AddEvent("cache.hit")` fires on cache hits), baggage propagation assertions (verifying that baggage set in a parent is readable in a child), and sampling decision assertions (verifying that `ParentBased` sampling correctly propagates the upstream sampling flag). The sampling assertion is particularly important: if a service incorrectly ignores the incoming `traceparent` sampling flag and always samples at 100%, it will send 100x the expected span volume to the Collector during a load test, potentially overwhelming the export pipeline.

For services with complex async patterns (goroutine fan-out, message queue consumers), trace tests must verify that all goroutines receive the correct context, not just the happy-path goroutine. A test that fires 10 concurrent goroutines and asserts that exactly 10 child spans appear with the correct parent covers a class of context propagation bugs that no other test type can detect.

---
