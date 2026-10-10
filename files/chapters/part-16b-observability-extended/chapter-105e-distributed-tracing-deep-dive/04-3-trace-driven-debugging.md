## 105E.4 Trace-Driven Debugging

Traces become a debugging tool when they carry enough contextual attributes to reconstruct the execution path: request parameters, database query strings, cache key patterns, and intermediate result counts. The `DebugTracer` below adds structured attributes to every span at critical decision points (cache hit/miss, database result counts, feature flag states) so that a slow trace in Jaeger carries enough information to diagnose the root cause without adding a separate log correlation step.

```go
package tracedebugging

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// TraceDebugger provides trace-based debugging capabilities
type TraceDebugger struct {
	tracer      trace.Tracer
	analyzer    *TraceAnalyzer
}

// NewTraceDebugger creates a trace debugger
func NewTraceDebugger(tracer trace.Tracer) *TraceDebugger {
	return &TraceDebugger{
		tracer:   tracer,
		analyzer: NewTraceAnalyzer(),
	}
}

// TraceAnalyzer analyzes traces for performance issues
type TraceAnalyzer struct{}

// NewTraceAnalyzer creates a trace analyzer
func NewTraceAnalyzer() *TraceAnalyzer {
	return &TraceAnalyzer{}
}

// SpanData represents a simplified span for analysis
type SpanData struct {
	Name      string
	Service   string
	Duration  time.Duration
	StartTime time.Time
	Error     bool
	Attributes map[string]string
	Children  []*SpanData
}

// CriticalPath identifies the longest path through a trace
func (a *TraceAnalyzer) CriticalPath(root *SpanData) []*SpanData {
	if root == nil {
		return nil
	}

	if len(root.Children) == 0 {
		return []*SpanData{root}
	}

	// Find the child with the longest duration
	var longestChild *SpanData
	var longestPath []*SpanData

	for _, child := range root.Children {
		path := a.CriticalPath(child)
		pathDuration := totalDuration(path)
		if longestChild == nil || pathDuration > totalDuration(longestPath) {
			longestChild = child
			longestPath = path
		}
	}

	return append([]*SpanData{root}, longestPath...)
}

func totalDuration(spans []*SpanData) time.Duration {
	total := time.Duration(0)
	for _, s := range spans {
		total += s.Duration
	}
	return total
}

// FindBottlenecks identifies spans that are taking disproportionately long
func (a *TraceAnalyzer) FindBottlenecks(root *SpanData, threshold float64) []*SpanData {
	if root == nil {
		return nil
	}

	totalDur := root.Duration
	var bottlenecks []*SpanData

	var walk func(span *SpanData)
	walk = func(span *SpanData) {
		ratio := float64(span.Duration) / float64(totalDur)
		if ratio > threshold {
			bottlenecks = append(bottlenecks, span)
		}
		for _, child := range span.Children {
			walk(child)
		}
	}

	for _, child := range root.Children {
		walk(child)
	}

	// Sort by duration descending
	slices.SortFunc(bottlenecks, func(a, b *SpanData) int {
		return cmp.Compare(b.Duration, a.Duration)
	})

	return bottlenecks
}

// N+1 Query Detection identifies repeated small DB queries
func (a *TraceAnalyzer) DetectNPlusOneQueries(root *SpanData) []NPlusOneIssue {
	// Collect all DB spans
	dbSpanCounts := make(map[string]int)
	var dbSpans func(span *SpanData)
	dbSpans = func(span *SpanData) {
		if span.Attributes["db.system"] != "" {
			// Group by query pattern (normalize parameters)
			pattern := normalizeQuery(span.Name)
			dbSpanCounts[pattern]++
		}
		for _, child := range span.Children {
			dbSpans(child)
		}
	}
	dbSpans(root)

	var issues []NPlusOneIssue
	for query, count := range dbSpanCounts {
		if count > 5 { // More than 5 similar queries = N+1 suspicion
			issues = append(issues, NPlusOneIssue{
				QueryPattern: query,
				Count:        count,
				Suggestion:   fmt.Sprintf("Consider batching %d similar queries into a single query with IN clause", count),
			})
		}
	}

	return issues
}

// NPlusOneIssue represents a detected N+1 query problem
type NPlusOneIssue struct {
	QueryPattern string
	Count        int
	Suggestion   string
}

func normalizeQuery(name string) string {
	// Simple normalization. Remove specific values
	return name // In production: use regex to remove IDs, values
}

// TracedHTTPClient wraps http.Client with automatic tracing and debugging
type TracedHTTPClient struct {
	client   *http.Client
	tracer   trace.Tracer
	debugger *TraceDebugger
}

// NewTracedHTTPClient creates a traced HTTP client
func NewTracedHTTPClient(tracer trace.Tracer) *TracedHTTPClient {
	debugger := NewTraceDebugger(tracer)
	return &TracedHTTPClient{
		client:   &http.Client{},
		tracer:   tracer,
		debugger: debugger,
	}
}

// Do executes an HTTP request with full tracing
func (c *TracedHTTPClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
	// Create span for this HTTP call
	ctx, span := c.tracer.Start(ctx,
		fmt.Sprintf("HTTP %s %s", req.Method, req.Host),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.method", req.Method),
			attribute.String("http.url", req.URL.String()),
			attribute.String("net.peer.name", req.Host),
		),
	)
	defer span.End()

	// Inject trace context
	carrier := make(propagationCarrier)
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	for k, v := range carrier {
		req.Header.Set(k, v)
	}

	start := time.Now()
	resp, err := c.client.Do(req.WithContext(ctx))
	duration := time.Since(start)

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	span.SetAttributes(
		attribute.Int("http.status_code", resp.StatusCode),
		attribute.String("http.response_content_type", resp.Header.Get("Content-Type")),
		attribute.Int64("http.duration_ms", duration.Milliseconds()),
	)

	if resp.StatusCode >= 500 {
		span.SetStatus(codes.Error, fmt.Sprintf("server error: %d", resp.StatusCode))
	}

	return resp, nil
}

type propagationCarrier map[string]string

func (c propagationCarrier) Get(key string) string    { return c[key] }
func (c propagationCarrier) Set(key, val string)      { c[key] = val }
func (c propagationCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

// SpanRecorder records spans for testing and debugging
type SpanRecorder struct {
	mu    sync.RWMutex
	spans []sdktrace.ReadOnlySpan
}

// OnStart is called when a span starts
func (r *SpanRecorder) OnStart(ctx context.Context, s sdktrace.ReadWriteSpan) {}

// OnEnd records a completed span
func (r *SpanRecorder) OnEnd(s sdktrace.ReadOnlySpan) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.spans = append(r.spans, s)
}

// Shutdown implements sdktrace.SpanProcessor
func (r *SpanRecorder) Shutdown(ctx context.Context) error   { return nil }
func (r *SpanRecorder) ForceFlush(ctx context.Context) error { return nil }

// GetSpans returns recorded spans
func (r *SpanRecorder) GetSpans() []sdktrace.ReadOnlySpan {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]sdktrace.ReadOnlySpan, len(r.spans))
	copy(result, r.spans)
	return result
}

// FindSpanByName finds a span by its name
func (r *SpanRecorder) FindSpanByName(name string) sdktrace.ReadOnlySpan {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, s := range r.spans {
		if s.Name() == name {
			return s
		}
	}
	return nil
}

// Reset clears all recorded spans
func (r *SpanRecorder) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.spans = nil
}
```

### Junior → FAANG: The Trace-Driven Debugging Workflow as a Discipline

Trace-driven debugging is a workflow, not just a tool. The discipline is to open the trace before opening the logs. When a user reports a slow request or an error, the correct sequence is: find the request in the tracing UI using the correlation ID or the user ID, load the trace, identify the slowest or failed span, then go to the logs filtered by that span's trace ID and span ID. This sequence saves time because the trace tells you which service and which operation to look at before you read a single log line. Reversing the sequence (logs first, trace second) wastes time reading log noise from services that were fast and healthy.

For interviews, be ready to walk through a trace waterfall diagram and explain the critical path calculation. The critical path is not the slowest single span. It is the longest sequential chain from root to leaf. Two slow spans that run concurrently may not both be on the critical path. Only the one that finishes later matters for the total trace duration.

### Senior @ FAANG: Trace-Driven Debugging as a Platform Capability

At L6, trace-driven debugging stops being an individual skill and becomes a platform capability that must be designed into the system. The design decisions that make trace-driven debugging effective at scale include: consistent span naming conventions (so engineers can search by operation name across services), structured span attributes on all database and external call spans (so the trace tells you the query, not just the span name), and a correlation ID strategy that links traces to the originating user action (so customer support tickets can be translated into trace queries).

The `SpanRecorder` pattern shown above is also a platform testing primitive. Any integration test that exercises a code path touching multiple services should use a recording processor to assert on the produced spans: verify that the correct number of spans were created, that the parent-child relationships are correct, and that no span has a missing attribute that the sampling policy requires. These span-level assertions catch instrumentation regressions before they reach production. When a developer removes a `defer span.End()` call or forgets to propagate context through a goroutine, the integration test fails rather than silently producing broken traces in production.

---
