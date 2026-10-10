## 103.10 Advanced Sampling Strategies

### Tail-Based Sampling

Trace sampling controls the fraction of requests that generate full distributed traces, balancing observability coverage against storage and ingestion costs. `TailBasedSampler` buffers complete traces in `pendingTraces` until `decisionWait` elapses, then evaluates them against a priority-ordered slice of `SamplingPolicy` values, such as "always sample 5xx errors" or "sample 1% of healthy requests", before forwarding or dropping each trace to `nextConsumer`.

```go
package sampling

import (
    "context"
    "sync"
    "time"

    "go.opentelemetry.io/collector/consumer"
    "go.opentelemetry.io/collector/pdata/ptrace"
)

// TailBasedSampler implements intelligent sampling based on complete trace data
type TailBasedSampler struct {
    mu               sync.RWMutex
    pendingTraces    map[string]*pendingTrace
    policies         []SamplingPolicy
    decisionWait     time.Duration
    maxTraces        int
    nextConsumer     consumer.Traces
}

type pendingTrace struct {
    spans      []ptrace.Span
    arrivalTime time.Time
    decision   SamplingDecision
    evaluated  bool
}

type SamplingDecision int

const (
    DecisionPending SamplingDecision = iota
    DecisionSampled
    DecisionNotSampled
)

// SamplingPolicy defines a sampling rule
type SamplingPolicy interface {
    Evaluate(spans []ptrace.Span) SamplingDecision
    Name() string
}

// ErrorSamplingPolicy samples traces with errors
type ErrorSamplingPolicy struct {
    sampleRate float64
}

func (p *ErrorSamplingPolicy) Name() string { return "error-sampling" }

func (p *ErrorSamplingPolicy) Evaluate(spans []ptrace.Span) SamplingDecision {
    for _, span := range spans {
        if span.Status().Code() == ptrace.StatusCodeError {
            return DecisionSampled
        }
    }
    return DecisionPending
}

// LatencySamplingPolicy samples slow traces
type LatencySamplingPolicy struct {
    threshold time.Duration
}

func (p *LatencySamplingPolicy) Name() string { return "latency-sampling" }

func (p *LatencySamplingPolicy) Evaluate(spans []ptrace.Span) SamplingDecision {
    var rootSpan ptrace.Span
    var foundRoot bool

    for _, span := range spans {
        if span.ParentSpanID().IsEmpty() {
            rootSpan = span
            foundRoot = true
            break
        }
    }

    if !foundRoot {
        return DecisionPending
    }

    duration := rootSpan.EndTimestamp().AsTime().Sub(rootSpan.StartTimestamp().AsTime())
    if duration > p.threshold {
        return DecisionSampled
    }
    return DecisionNotSampled
}

// StatusCodeSamplingPolicy samples based on HTTP status
type StatusCodeSamplingPolicy struct {
    codes []int
}

func (p *StatusCodeSamplingPolicy) Name() string { return "status-code-sampling" }

func (p *StatusCodeSamplingPolicy) Evaluate(spans []ptrace.Span) SamplingDecision {
    for _, span := range spans {
        attrs := span.Attributes()
        if statusCode, ok := attrs.Get("http.status_code"); ok {
            code := int(statusCode.Int())
            for _, targetCode := range p.codes {
                if code == targetCode {
                    return DecisionSampled
                }
            }
        }
    }
    return DecisionNotSampled
}

// NewTailBasedSampler creates a new tail-based sampler
func NewTailBasedSampler(decisionWait time.Duration, maxTraces int, policies []SamplingPolicy) *TailBasedSampler {
    return &TailBasedSampler{
        pendingTraces: make(map[string]*pendingTrace),
        policies:      policies,
        decisionWait:  decisionWait,
        maxTraces:     maxTraces,
    }
}

// ProcessTraces handles incoming trace data
func (s *TailBasedSampler) ProcessTraces(ctx context.Context, td ptrace.Traces) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    resourceSpans := td.ResourceSpans()
    for i := 0; i < resourceSpans.Len(); i++ {
        rs := resourceSpans.At(i)
        scopeSpans := rs.ScopeSpans()

        for j := 0; j < scopeSpans.Len(); j++ {
            ss := scopeSpans.At(j)
            spans := ss.Spans()

            for k := 0; k < spans.Len(); k++ {
                span := spans.At(k)
                traceID := span.TraceID().String()

                pending, exists := s.pendingTraces[traceID]
                if !exists {
                    pending = &pendingTrace{
                        spans:       make([]ptrace.Span, 0),
                        arrivalTime: time.Now(),
                        decision:    DecisionPending,
                    }
                    s.pendingTraces[traceID] = pending
                }

                pending.spans = append(pending.spans, span)
            }
        }
    }

    // Evaluate pending traces
    s.evaluateTraces()

    return nil
}

func (s *TailBasedSampler) evaluateTraces() {
    now := time.Now()
    toDelete := make([]string, 0)

    for traceID, pending := range s.pendingTraces {
        // Wait for decision window
        if now.Sub(pending.arrivalTime) < s.decisionWait {
            continue
        }

        if !pending.evaluated {
            pending.decision = s.makeDecision(pending.spans)
            pending.evaluated = true
        }

        // Export sampled traces
        if pending.decision == DecisionSampled {
            s.exportTrace(pending.spans)
        }

        toDelete = append(toDelete, traceID)
    }

    // Cleanup
    for _, traceID := range toDelete {
        delete(s.pendingTraces, traceID)
    }

    // Enforce max traces limit
    if len(s.pendingTraces) > s.maxTraces {
        s.enforceLimit()
    }
}

func (s *TailBasedSampler) makeDecision(spans []ptrace.Span) SamplingDecision {
    for _, policy := range s.policies {
        decision := policy.Evaluate(spans)
        if decision == DecisionSampled {
            return DecisionSampled
        }
    }
    return DecisionNotSampled
}

func (s *TailBasedSampler) exportTrace(spans []ptrace.Span) {
    // Export to next consumer
}

func (s *TailBasedSampler) enforceLimit() {
    // Remove oldest traces when limit exceeded
    oldest := ""
    var oldestTime time.Time

    for traceID, pending := range s.pendingTraces {
        if oldest == "" || pending.arrivalTime.Before(oldestTime) {
            oldest = traceID
            oldestTime = pending.arrivalTime
        }
    }

    if oldest != "" {
        delete(s.pendingTraces, oldest)
    }
}
```

### Collector Tail Sampling Configuration

In production you rarely hand-roll a tail sampler: the Collector ships one. The YAML below configures the `tail_sampling` processor with composite policies, latency threshold, status-code filter, and probabilistic rate, so that the Collector buffers spans from all services for the `decision_wait` interval and then applies policies in order, keeping slow or errored traces at 100% while probabilistically dropping healthy fast traces.

```yaml
# otel-collector-tail-sampling.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  # Tail-based sampling processor
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      # Always sample traces with errors
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Sample slow traces (> 2 seconds)
      - name: latency-policy
        type: latency
        latency:
          threshold_ms: 2000

      # Sample traces with 5xx HTTP status codes
      # (http.status_code is an integer attribute, so use numeric_attribute)
      - name: http-errors-policy
        type: numeric_attribute
        numeric_attribute:
          key: http.status_code
          min_value: 500
          max_value: 599

      # Always sample payment-related traces
      - name: payment-policy
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["payment-service"]

      # Probabilistic sampling for everything else
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 10

  # Group spans by trace ID for tail sampling
  groupbytrace:
    wait_duration: 10s
    num_traces: 100000

  batch:
    timeout: 1s
    send_batch_size: 1024

exporters:
  otlp:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [groupbytrace, tail_sampling, batch]
      exporters: [otlp]
```

### Junior → FAANG: Head-Based vs. Tail-Based Sampling, Explained Simply

Sampling is how you make distributed tracing affordable at scale. Without sampling, a service handling 10,000 requests per second would produce 10,000 traces per second, which is far too expensive to store and query.

Head-based sampling decides at the root span (the first service in the call chain) whether to sample the trace. This decision is propagated through the `traceparent` header's sampled bit, so all downstream services follow the same decision. It is simple and has zero latency impact on unhappy paths, but it is blind: it discards error traces at the same rate as healthy ones.

Tail-based sampling collects all spans for a trace and then decides whether to sample after the full trace is available. This lets you keep 100% of error traces and slow traces while discarding healthy fast ones. The trade-off: it requires stateful infrastructure (the Collector must buffer spans until the full trace arrives) and introduces latency in the pipeline.

Interview entry point: "Why would you use tail-based sampling over head-based?" When you need to guarantee that all errors and all traces exceeding a latency threshold are retained, regardless of the overall sampling rate.

### Senior @ FAANG: Sampling Policy Governance and Its Operational Impact

**Sampling as a financial control.** At FAANG scale, storing every trace costs millions of dollars annually. Sampling policy is a financial decision as much as an engineering one. An L6 engineer proposes sampling budgets to the finance team: "We will store 100% of error traces (estimated N per day), 100% of traces exceeding 1 second (estimated M per day), and 1% of healthy fast traces." This budget is reviewed quarterly as traffic grows and trace complexity increases.

**Sampling policy as an ADR.** The choice between head-based and tail-based sampling, and the specific rules for tail sampling (error policy, latency threshold, service-specific overrides), must be documented in an ADR with the following sections: context (traffic volume, storage cost, error rate), decision (tail sampling with specific policy), consequences (Collector fleet size increase, pipeline latency increase, storage cost reduction). This ADR is reviewed during architecture reviews for new services.

**Dynamic sampling rate adjustment.** A static sampling rate set at deployment time becomes wrong as traffic patterns change. A senior engineer implements dynamic sampling via the Collector's `probabilistic_sampler` with a rate that adjusts based on current ingestion cost, or via the `tail_sampling` processor's `rate_limiting` policy that caps the number of traces stored per second. This prevents sudden traffic spikes (product launches, viral events) from causing unexpectedly large cloud bills.

**Sampling consistency across service boundaries.** If service A samples 1% of traces head-based, and service B samples 10% independently, traces that enter B directly are sampled at 10% while traces that come through A are sampled at 1%. The combined dataset is inconsistent and cannot be used for accurate throughput calculations. An L6 engineer enforces that all services use the same head-based sampling rate (set centrally, not per-service) and that only the Collector applies tail-based overrides. This consistency enables accurate aggregate statistics from the sampled dataset.

---
