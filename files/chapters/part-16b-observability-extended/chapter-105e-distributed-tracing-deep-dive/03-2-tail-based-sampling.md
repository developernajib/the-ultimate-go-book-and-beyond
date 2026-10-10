## 105E.3 Tail-Based Sampling

Head-based sampling makes the keep/drop decision at the start of a trace before any spans exist, which means errors and slow requests are sampled at the same rate as fast successful ones. Tail-based sampling buffers all spans for a trace and makes the decision only after the trace is complete, keeping 100% of error traces and slow traces while dropping a configurable fraction of healthy fast traces. The `TailSampler` below collects spans by trace ID, evaluates the complete trace against configurable rules after a flush timeout, and forwards kept traces to the underlying span exporter.

```go
package tailsampling

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// TailSamplingDecision represents a sampling decision for a complete trace
type TailSamplingDecision struct {
	Sample  bool
	Reason  string
}

// TailSamplingPolicy defines rules for tail-based sampling
type TailSamplingPolicy struct {
	Name     string
	Priority int
	Evaluate func(trace *TraceData) *TailSamplingDecision
}

// TraceData aggregates all spans for a trace
type TraceData struct {
	TraceID   string
	Spans     []sdktrace.ReadOnlySpan
	StartTime time.Time
	EndTime   time.Time
	Duration  time.Duration
	HasError  bool
	Services  map[string]bool
	MaxLatency time.Duration
}

// TailSampler implements tail-based sampling
// Collects entire traces before making sampling decisions
type TailSampler struct {
	mu           sync.RWMutex
	pendingTraces map[string]*pendingTrace
	policies     []TailSamplingPolicy
	decisionCache map[string]bool
	traceTimeout time.Duration
	exporter     sdktrace.SpanExporter
}

type pendingTrace struct {
	spans     []sdktrace.ReadOnlySpan
	createdAt time.Time
}

// NewTailSampler creates a tail-based sampler
func NewTailSampler(
	traceTimeout time.Duration,
	exporter sdktrace.SpanExporter,
) *TailSampler {
	s := &TailSampler{
		pendingTraces: make(map[string]*pendingTrace),
		decisionCache: make(map[string]bool),
		traceTimeout:  traceTimeout,
		exporter:      exporter,
	}
	return s
}

// AddPolicy adds a sampling policy
func (s *TailSampler) AddPolicy(policy TailSamplingPolicy) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.policies = append(s.policies, policy)

	// Sort by priority (higher priority first)
	slices.SortFunc(s.policies, func(a, b TailSamplingPolicy) int {
		return cmp.Compare(b.Priority, a.Priority)
	})
}

// OnEnd collects spans and makes sampling decisions when trace is complete
func (s *TailSampler) OnEnd(span sdktrace.ReadOnlySpan) {
	traceID := span.SpanContext().TraceID().String()

	s.mu.Lock()
	// Add span to pending trace
	pt, exists := s.pendingTraces[traceID]
	if !exists {
		pt = &pendingTrace{
			createdAt: time.Now(),
		}
		s.pendingTraces[traceID] = pt
	}
	pt.spans = append(pt.spans, span)
	s.mu.Unlock()

	// If this is a root span, evaluate the trace
	if !span.Parent().IsValid() {
		s.evaluateTrace(traceID)
	}
}

func (s *TailSampler) evaluateTrace(traceID string) {
	s.mu.Lock()
	pt, exists := s.pendingTraces[traceID]
	if !exists {
		s.mu.Unlock()
		return
	}
	delete(s.pendingTraces, traceID)
	s.mu.Unlock()

	// Build trace data for policy evaluation
	traceData := s.buildTraceData(traceID, pt.spans)

	// Evaluate policies in priority order
	var decision *TailSamplingDecision
	for _, policy := range s.policies {
		if d := policy.Evaluate(traceData); d != nil {
			decision = d
			break
		}
	}

	// Default: sample if no policy matched
	if decision == nil {
		decision = &TailSamplingDecision{Sample: true, Reason: "default"}
	}

	// Cache decision for future spans with same trace ID
	s.mu.Lock()
	s.decisionCache[traceID] = decision.Sample
	s.mu.Unlock()

	if decision.Sample {
		s.exporter.ExportSpans(context.Background(), pt.spans)
	}
}

func (s *TailSampler) buildTraceData(traceID string, spans []sdktrace.ReadOnlySpan) *TraceData {
	td := &TraceData{
		TraceID:  traceID,
		Spans:    spans,
		Services: make(map[string]bool),
	}

	for _, span := range spans {
		if td.StartTime.IsZero() || span.StartTime().Before(td.StartTime) {
			td.StartTime = span.StartTime()
		}
		if span.EndTime().After(td.EndTime) {
			td.EndTime = span.EndTime()
		}

		if span.Status().Code == codes.Error {
			td.HasError = true
		}

		duration := span.EndTime().Sub(span.StartTime())
		if duration > td.MaxLatency {
			td.MaxLatency = duration
		}

		// Extract service name from resource
		for _, attr := range span.Resource().Attributes() {
			if attr.Key == semconv.ServiceNameKey {
				td.Services[attr.Value.AsString()] = true
			}
		}
	}

	td.Duration = td.EndTime.Sub(td.StartTime)
	return td
}

// GCExpiredTraces removes stale pending traces
func (s *TailSampler) GCExpiredTraces() {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for traceID, pt := range s.pendingTraces {
		if now.Sub(pt.createdAt) > s.traceTimeout {
			// Export with best-effort sampling decision
			delete(s.pendingTraces, traceID)
		}
	}
}

// CommonSamplingPolicies provides pre-built sampling policies
type CommonSamplingPolicies struct{}

// AlwaysSampleErrors samples all traces with errors
func (p *CommonSamplingPolicies) AlwaysSampleErrors() TailSamplingPolicy {
	return TailSamplingPolicy{
		Name:     "always-sample-errors",
		Priority: 100,
		Evaluate: func(td *TraceData) *TailSamplingDecision {
			if td.HasError {
				return &TailSamplingDecision{
					Sample: true,
					Reason: "trace contains errors",
				}
			}
			return nil
		},
	}
}

// AlwaysSampleSlowTraces samples traces exceeding a latency threshold
func (p *CommonSamplingPolicies) AlwaysSampleSlowTraces(threshold time.Duration) TailSamplingPolicy {
	return TailSamplingPolicy{
		Name:     "always-sample-slow",
		Priority: 90,
		Evaluate: func(td *TraceData) *TailSamplingDecision {
			if td.Duration > threshold {
				return &TailSamplingDecision{
					Sample: true,
					Reason: fmt.Sprintf("trace duration %v exceeds threshold %v",
						td.Duration, threshold),
				}
			}
			return nil
		},
	}
}

// RateLimitedSampler samples at most N traces per second
func (p *CommonSamplingPolicies) RateLimitedSampler(ratePerSecond int) TailSamplingPolicy {
	var mu sync.Mutex
	count := 0
	lastReset := time.Now()

	return TailSamplingPolicy{
		Name:     "rate-limited",
		Priority: 10,
		Evaluate: func(td *TraceData) *TailSamplingDecision {
			mu.Lock()
			defer mu.Unlock()

			now := time.Now()
			if now.Sub(lastReset) > time.Second {
				count = 0
				lastReset = now
			}

			if count < ratePerSecond {
				count++
				return &TailSamplingDecision{
					Sample: true,
					Reason: "rate limit not exceeded",
				}
			}

			return &TailSamplingDecision{
				Sample: false,
				Reason: "rate limit exceeded",
			}
		},
	}
}
```

### Junior → FAANG: Why Head-Based Sampling Fails at the Wrong Moment

The core insight to internalize about tail-based sampling is that head-based sampling is statistically sound on average but catastrophically wrong for the cases you care most about. When your service processes 10,000 requests per minute and you sample at 1%, you keep 100 traces per minute. If errors occur at a rate of 5 per minute, you statistically keep 0.05 error traces per minute. That means 99 out of 100 errors are invisible. Tail-based sampling inverts this: keep 100% of errors, keep 100% of traces above the p99 latency threshold, and then sample the remainder down to your storage budget.

For interviews, know that the in-process TailSampler shown above is an illustration of the concept, not a production recommendation. The OTel Collector's tail sampling processor is the production implementation. It accepts spans from multiple service replicas via OTLP, buffers them by trace ID, and evaluates policies after a configurable decision wait time. The tradeoff is network overhead: every span must be forwarded to the Collector before sampling, which adds latency to the export path and requires the Collector to have enough memory to buffer all in-flight traces.

### Senior @ FAANG: Tail Sampling as a Financial and Governance Decision

At L6, tail-based sampling policy is an engineering governance artifact with direct financial consequences. Whether you operate Grafana Tempo yourself or pay a vendor per ingested span, storing 1 million spans per day at full fidelity costs measurably more than storing 50,000 spans per day after dropping most healthy traces. The sampling policy must be documented in an ADR that records the cost model, the retention SLO ("100% of error and slow traces for 30 days, 1% of healthy traces for 7 days"), and the review cadence (quarterly, or whenever traffic doubles).

The decision wait time parameter in the OTel Collector's tail sampler introduces a correctness risk that must be understood at the platform level. If the decision wait is set to 10 seconds and a slow downstream service sometimes takes 15 seconds to report its spans, those spans arrive after the decision was already made. The trace is incomplete: some spans are kept, the late spans are dropped, and the Jaeger UI shows a trace with a visible gap that looks like a missing service. The mitigation is to set the decision wait conservatively (30 seconds is common for systems with large fanout) and to alert on the Collector's `otelcol_processor_tail_sampling_sampling_late_span_age` metric. When late-span counts rise, the decision wait is too short for the actual tail latency of the system, and the policy needs adjustment.

Policy evaluation order matters when multiple policies apply to the same trace. The priority field in `TailSamplingPolicy` must be documented: error policies should take priority over latency policies, which take priority over percentage-based baseline sampling. A trace that is both an error and slow should be kept by the error policy, and the latency policy should not evaluate it (to avoid double-counting in sampling rate calculations). Platform engineers who ignore policy ordering produce sampling configurations where the percentage policy fires first, drops 99% of traces including some errors, and the error policy never sees them.

---
