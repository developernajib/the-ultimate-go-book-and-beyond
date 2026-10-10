## 103.16 Interview Questions: OpenTelemetry and Observability

### Question 1: What are the three pillars of observability, and how do they work together?

**What FAANG expects:** Traces, metrics, logs. Know each pillar's answer (what/how/exactly). The modern framing adds a fourth (profiles) but interviewers mostly ask the classic three. Correlation via W3C Trace Context (`traceparent` header), shared resource attributes (`service.name`), and trace_id in logs. Bonus for naming OTel as the vendor-neutral standard replacing vendor-specific agents: the Jaeger client libraries were retired in favor of OTel SDKs, and vendor agents increasingly just accept OTLP.

**Answer:**

```
The three pillars of observability are:

1. TRACES (Distributed Tracing)
   - Track the path of a request through the system
   - Show causality and timing across services
   - Answer: "What happened to THIS request?"

2. METRICS
   - Aggregate numerical measurements over time
   - Show trends, patterns, and system health
   - Answer: "How is the system behaving overall?"

3. LOGS
   - Discrete events with context
   - Detailed diagnostic information
   - Answer: "What exactly happened at this moment?"

HOW THEY WORK TOGETHER:
┌──────────────────────────────────────────────────────────────┐
│  Alert triggered: High p99 latency (METRIC)                  │
│                        ↓                                     │
│  Find slow traces with matching time window (TRACE)          │
│                        ↓                                     │
│  Use trace_id to find correlated logs (LOG)                  │
│                        ↓                                     │
│  Root cause: Database connection pool exhausted              │
└──────────────────────────────────────────────────────────────┘

In OpenTelemetry, these are unified through:
- Shared context propagation (W3C Trace Context)
- Common resource attributes (service.name, etc.)
- Correlation via trace_id and span_id
```

### Question 2: Explain head-based vs. tail-based sampling. When would you use each?

**What FAANG expects:** Head-based (decide at trace start, simple, cheap, but misses errors you didn't know about). Tail-based (decide after trace completes, requires buffering, catches errors/slow paths). Tail sampling runs in the OTel Collector, not the SDK. Bonus for knowing that adaptive sampling (dynamic rate based on service load) sits between the two, and that Google's Dapper popularized the head-based ratio approach while tools like Honeycomb's Refinery popularized tail-based.

**Answer:**

```go
// HEAD-BASED SAMPLING
// Decision made at trace START, before any spans are collected
// Pros: Low overhead, simple implementation
// Cons: May miss important traces (errors, slow requests)

tp := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.01), // 1% of traces
    )),
)

// TAIL-BASED SAMPLING
// Decision made AFTER trace completes, with full context
// Pros: Can sample all errors, slow traces, specific paths
// Cons: Higher memory/CPU, requires collector buffering

// Collector configuration for tail sampling:
/*
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow
        type: latency
        latency:
          threshold_ms: 2000
      - name: baseline
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
*/

// WHEN TO USE EACH:

// Use HEAD-BASED when:
// - Cost is a primary concern
// - System is simple (few services)
// - Statistical sampling is sufficient
// - Low latency overhead is critical

// Use TAIL-BASED when:
// - You need 100% of errors and slow requests
// - Debug traces for specific paths (payment, auth)
// - System is complex with many failure modes
// - You can afford collector infrastructure
```

### Question 3: How would you debug a performance issue using distributed tracing?

**What FAANG expects:** Top-down approach: start with the SLO breach alert, find example slow traces (tail-sampled by duration > threshold), identify the long-running span, drill into its logs via trace_id. The real skill is reading a flame graph to distinguish wall-clock latency (doing nothing, waiting) from CPU-bound work. Bonus for naming exemplars (histogram buckets carrying trace IDs) as the direct jump from a metric p99 spike to the responsible trace.

**Answer:**

```go
// Step 1: Start with high-level metrics
// Look for p99 latency spikes in metrics dashboards
// Query: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

// Step 2: Find representative slow traces
// In Jaeger/Tempo: service=my-service AND duration>2s

// Step 3: Analyze trace timeline
func analyzeTrace(ctx context.Context, traceID string) {
    // Look for:
    // 1. Large gaps between spans (network latency, queue wait)
    // 2. Long spans (slow operations)
    // 3. Sequential operations that could be parallel
    // 4. Retries (multiple spans for same operation)
    // 5. N+1 query patterns (many small DB spans)

    /*
    Example trace analysis:

    ├── HTTP /api/users [500ms]
    │   ├── Validate [5ms] ✓ OK
    │   ├── GetUser [450ms] ← PROBLEM
    │   │   ├── Cache.Get [10ms] MISS
    │   │   ├── DB.Query [400ms] ← SLOW
    │   │   └── Cache.Set [40ms]
    │   └── Serialize [5ms] ✓ OK

    Root cause: DB query taking 400ms
    */
}

// Step 4: Drill down into problematic span
// Check span attributes for details
func debugSlowSpan(span ReadOnlySpan) {
    // Common attributes to check:
    attrs := span.Attributes()

    // Database: Check query and execution plan
    // attrs["db.statement"] = "SELECT * FROM users WHERE..."
    // attrs["db.rows_affected"] = 1000000  // Too many rows!

    // HTTP: Check response size
    // attrs["http.response_content_length"] = 50000000  // 50MB response!

    // Cache: Check hit rate
    // attrs["cache.hit"] = false  // Always missing cache!
}

// Step 5: Correlate with logs
// Use trace_id to find detailed logs
// grep "trace_id=abc123" /var/log/app.log
```

### Question 4: What is context propagation, and why is it critical in distributed systems?

**What FAANG expects:** W3C Trace Context is the standard (`traceparent`, `tracestate` headers). B3 (Zipkin) is legacy. Context propagation connects the trace-id/span-id/baggage across process boundaries, HTTP, gRPC, message queues. Without it, each hop starts a new disconnected trace. Bonus for explaining that async messaging (Kafka, SQS) requires manually injecting/extracting context into the message headers, and that gRPC already does it automatically via the `otelgrpc` stats handlers.

**Answer:**

```go
// Context propagation passes trace context (trace_id, span_id)
// across service boundaries so spans can be linked into a complete trace.

// WITHOUT CONTEXT PROPAGATION:
// Service A → Service B → Service C
// Each creates separate, unrelated traces
// You see 3 isolated traces, can't follow the request path

// WITH CONTEXT PROPAGATION:
// Service A → Service B → Service C
// All spans share trace_id, linked by parent_span_id
// You see 1 complete trace showing the full request flow

// HOW IT WORKS:

// 1. HTTP Propagation (W3C Trace Context)
func propagateHTTP(ctx context.Context, req *http.Request) {
    // Inject trace context into HTTP headers
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    // Headers added:
    // traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
    // tracestate: vendor1=value1,vendor2=value2
}

// On receiving service
func extractHTTP(r *http.Request) context.Context {
    // Extract trace context from HTTP headers
    ctx := otel.GetTextMapPropagator().Extract(
        context.Background(),
        propagation.HeaderCarrier(r.Header),
    )
    return ctx
}

// 2. gRPC Propagation (via metadata)
// Handled automatically by the otelgrpc stats handlers

// 3. Message Queue Propagation (Kafka, RabbitMQ)
func propagateKafka(ctx context.Context, msg *sarama.ProducerMessage) {
    otel.GetTextMapPropagator().Inject(ctx,
        otelsarama.NewProducerMessageCarrier(msg))
}

// COMMON MISTAKES:
// 1. Using http.DefaultClient instead of instrumented client
// 2. Forgetting to pass context through the call chain
// 3. Using context.Background() instead of request context
// 4. Not setting up propagators at startup
```

### Question 5: How do you handle high-cardinality attributes in observability?

**What FAANG expects:** Cardinality matters differently per pillar. Metrics: hard cap on label combinations (one series per combination, storage explodes). Traces: cardinality is cheap (attributes are per-span, no aggregation). Logs: indexing high-cardinality fields gets expensive but is usually fine. Rule: put high-cardinality context (`user_id`, `order_id`, `request_id`) on **traces and logs**, keep **metrics** dimensions bounded (route template, HTTP status class, region). Bonus for naming Honeycomb's "wide events" philosophy (trace every event with full context) as an alternative to the metrics-first approach.

**Answer:**

```go
// HIGH CARDINALITY = attributes with many unique values
// Examples: user_id, request_id, session_id, IP address

// PROBLEM: High cardinality causes:
// 1. Storage explosion (each unique value = new time series)
// 2. Slow queries (indexes become huge)
// 3. High costs (cloud observability charges per cardinality)

// BAD: Adding high-cardinality as indexed attributes
span.SetAttributes(
    attribute.String("user_id", userID),        // 10M+ values
    attribute.String("request_id", requestID),  // Infinite values
    attribute.String("ip_address", clientIP),   // 4B+ values
)

// GOOD: Use low-cardinality for attributes (indexed)
span.SetAttributes(
    attribute.String("user_tier", "premium"),   // 3 values
    attribute.String("region", "us-east-1"),    // 20 values
    attribute.String("endpoint", "/api/users"), // 50 values
)

// Put high-cardinality in EVENTS (not indexed, for debugging)
span.AddEvent("request_details", trace.WithAttributes(
    attribute.String("user_id", userID),
    attribute.String("request_id", requestID),
    attribute.String("ip_address", clientIP),
))

// STRATEGIES FOR METRICS:
// 1. Use histograms for values, not unique labels
// 2. Aggregate by bounded dimensions (tier, region, status_code)
// 3. Use exemplars to link metrics to traces (get user_id from trace)

// Example: Good metric design
requestDuration.Record(ctx, duration,
    metric.WithAttributes(
        attribute.String("method", "GET"),       // 5 values
        attribute.String("path", "/api/users"),  // 50 values
        attribute.Int("status_code", 200),       // 50 values
        // NOT: attribute.String("user_id", userID)
    ),
)

// To find a specific user's requests:
// 1. Look at exemplars attached to metrics
// 2. Jump to trace using exemplar's trace_id
// 3. Find user_id in trace events/logs
```

### Question 6: Design an observability strategy for a high-traffic e-commerce platform.

**What FAANG expects:** Tiered approach: SLIs per user journey (checkout, search, browse), not per service. 100% metrics/logs, tail-sampled traces (capture all errors, 1% of success). OTel Collector in a gateway + agent topology (agent per pod/host scrubs and batches locally, gateway does tail sampling and routes to backends). Budgets per dimension (ingest cost, storage, query volume). Bonus for explaining why you separate hot path (Prometheus, short retention) from cold path (long-term metrics in Mimir/Thanos, logs in Loki/ELK, traces in Tempo/Jaeger/vendor).

**Answer:**

```
ARCHITECTURE:
┌──────────────────────────────────────────────────────────────────┐
│                     E-COMMERCE PLATFORM                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SERVICES: API Gateway → Order Service → Payment Service         │
│            → Inventory Service → Shipping Service                │
│            → Notification Service → Analytics Service            │
│                                                                  │
│  TRAFFIC: 100,000 requests/second peak                           │
│  REQUIREMENTS: Debug issues fast, keep costs manageable          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

STRATEGY:

1. SAMPLING STRATEGY (cost vs. coverage balance)
   - 1% head-based sampling for normal traffic
   - 100% tail-based sampling for:
     * Errors (status >= 400)
     * Slow requests (> 2s)
     * Payment-related traces
     * Orders > $1000

2. METRICS DESIGN (SLI-focused)
   - Latency: p50, p95, p99 by service/endpoint
   - Availability: Success rate by service
   - Throughput: Requests/sec by service
   - Saturation: Queue depths, connection pools
   - Business: Orders/minute, Revenue/minute, Cart abandonment

3. LOGGING STRATEGY
   - Structured JSON logs with trace_id
   - Log levels: ERROR always, WARN in staging, INFO for debug
   - Sensitive data: NEVER log card numbers, redact PII

4. ALERTING PHILOSOPHY
   - Alert on symptoms, not causes
   - p99 latency > SLO for 5 minutes
   - Error rate > 0.1% for 5 minutes
   - Business: Orders/minute drops 50% from baseline

5. IMPLEMENTATION:

// Unified telemetry setup
func InitTelemetry(serviceName string) func() {
    // Traces with intelligent sampling
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(resource),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.01),
        )),
    )

    // Metrics with business dimensions
    mp := sdkmetric.NewMeterProvider(
        sdkmetric.WithReader(prometheusReader),
        sdkmetric.WithResource(resource),
    )

    // Setup propagators
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func() {
        tp.Shutdown(context.Background())
        mp.Shutdown(context.Background())
    }
}

// Business-aware tracing
func ProcessOrder(ctx context.Context, order *Order) error {
    ctx, span := tracer.Start(ctx, "ProcessOrder",
        trace.WithAttributes(
            attribute.Int64("order.total_cents", order.TotalCents),
            attribute.String("order.region", order.Region),
            // Flag the Collector's tail-sampling policy keys on
            // to retain high-value orders ($1,000+ = 100,000 cents) at 100%
            attribute.Bool("sample.force", order.TotalCents > 100_000),
        ),
    )
    defer span.End()

    // Business metrics
    ordersCreated.Add(ctx, 1, metric.WithAttributes(
        attribute.String("region", order.Region),
        attribute.String("payment_method", order.PaymentMethod),
    ))
    orderValue.Record(ctx, order.TotalCents)

    // ... process order
}
```

### Junior → FAANG: Interview Preparation for OTel Roles

OTel interview questions at FAANG companies test both conceptual understanding and practical debugging ability. Prepare for two categories:

**Conceptual questions.** "Explain the difference between a trace and a metric." "What is the OpenTelemetry Collector and what role does it play?" "How does W3C TraceContext propagation work?" "What is a sampler and why do you need one?" These questions have well-defined answers based on the OTel specification. Study the spec directly rather than relying on blog posts.

**Debugging scenario questions.** "You added OTel instrumentation but traces appear disconnected in Jaeger. What do you check?" "Your service latency is increasing after adding OTel. What could cause this?" "You enabled metrics but Prometheus shows no data. Walk me through your debugging process." These questions test whether you can reason about failure modes, not just happy-path behavior.

For system design questions that involve observability, always mention the four golden signals (latency, traffic, errors, saturation) and explain how you would instrument each one in a Go service.

### Senior @ FAANG: Bar-Raiser Signals in OTel Interviews

A bar-raiser interviewing an L6 or L7 candidate on OTel looks for evidence of platform-level thinking, not just implementation knowledge. The following signals indicate a senior-level candidate:

**ADR reasoning.** Can the candidate articulate why they would choose tail-based over head-based sampling in a specific scenario, including the operational cost (stateful Collector fleet) and the benefit (preserving all error traces)? An L5 candidate knows the difference. An L6 candidate can write the ADR.

**Org-scale problem awareness.** Does the candidate mention cardinality budgets, attribute naming standards, and governance processes without being prompted? These are not implementation details: they are the concerns that separate a working OTel setup from one that scales to 500 services.

**Failure mode reasoning.** When asked "what goes wrong with OTel at scale," does the candidate mention SDK version skew, Collector memory limits, tail-sampling routing, and PII leakage through span attributes? These are the production failure modes that only appear at scale and that bar-raisers use to assess whether a candidate has operated production observability platforms.

**Cross-pillar integration.** Does the candidate explain how traces, metrics, and logs work together (exemplars linking metrics to traces, log-trace correlation, SLO metrics derived from span data) rather than treating each pillar in isolation? Integration thinking is an L6-and-above competency.

---
