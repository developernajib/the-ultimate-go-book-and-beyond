## 103.14 Company Case Studies

### How Google Uses Distributed Tracing (Dapper)

Google's Dapper, the system whose 2010 paper inspired the entire modern tracing ecosystem including OpenTelemetry, kept overhead negligible by sampling 1 in 1024 requests at the root service, propagating the sampling decision downstream in headers so that the entire call tree is either fully traced or fully dropped, eliminating partial traces that waste storage without providing actionable data.

```
┌──────────────────────────────────────────────────────────────────┐
│                 GOOGLE'S DAPPER ARCHITECTURE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  KEY INNOVATIONS:                                                │
│  1. Low-overhead instrumentation (negligible perf impact)        │
│  2. Sampling-based collection (1 in 1024 requests)               │
│  3. Out-of-band trace collection                                 │
│  4. Adaptive sampling based on traffic                           │
│                                                                  │
│  A MODERN POLICY BUILT ON DAPPER'S IDEAS:                        │
│  ┌──────────────────────────────────────────┐                    │
│  │ Production Traffic: 0.1% sampled         │                    │
│  │ Errors: 100% sampled                     │                    │
│  │ High-latency requests: 10% sampled       │                    │
│  │ Debug mode: 100% (short-term only)       │                    │
│  └──────────────────────────────────────────┘                    │
│                                                                  │
│  LESSONS FOR YOUR SYSTEM:                                        │
│  • Instrumentation must be invisible to developers               │
│  • Sample strategically, not uniformly                           │
│  • Traces are for debugging, not monitoring                      │
│  • Keep trace data for 7 days (not forever)                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### How Uber Built Their Observability Platform

Uber's observability platform processes billions of spans and metrics per day across thousands of Go microservices. Their architecture splits collection from storage and query, using M3 for metrics and Jaeger for distributed tracing. The diagram below shows their production pipeline.

```
┌──────────────────────────────────────────────────────────────────┐
│                 UBER'S OBSERVABILITY STACK                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ARCHITECTURE:                                                   │
│  ┌─────────┐    ┌─────────┐    ┌──────────────┐                  │
│  │ Jaeger  │    │   M3    │    │  uMonitor    │                  │
│  │(Tracing)│    │(Metrics)│    │ (Alerting)   │                  │
│  └────┬────┘    └────┬────┘    └──────┬───────┘                  │
│       │              │                 │                         │
│       └──────────────┴─────────────────┘                         │
│                      │                                           │
│              ┌───────┴───────┐                                   │
│              │   M3 Query    │ (Unified query layer)             │
│              └───────────────┘                                   │
│                                                                  │
│  KEY PRACTICES:                                                  │
│  1. Jaeger for distributed tracing (open-sourced by Uber)        │
│  2. M3 for metrics at 500M+ data points per second               │
│  3. Context propagation across 4,000+ microservices              │
│  4. Automatic instrumentation via code generation                │
│                                                                  │
│  SCALE NUMBERS (as published by Uber engineering):               │
│  • 4,000+ microservices                                          │
│  • 500M+ metrics data points per second                          │
│                                                                  │
│  GO-SPECIFIC PATTERNS:                                           │
│  • yarpc: RPC framework with built-in tracing                    │
│  • zap: Structured logging with trace correlation                │
│  • tally: High-performance metrics library                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### How Netflix Implements Observability

Netflix built and open-sourced Atlas, its dimensional time-series metrics platform, to hold the operational state of its streaming fleet in memory for fast queries, and pairs it with percentile-oriented alerting so that on-call engineers see tail degradation, not just averages. The diagram below sketches the approach.

```
┌──────────────────────────────────────────────────────────────────┐
│                NETFLIX OBSERVABILITY APPROACH                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  TRACING PHILOSOPHY:                                             │
│  "Request tracing should be like a flight recorder:              │
│   always on, minimal overhead, invaluable in incidents"          │
│                                                                  │
│  ARCHITECTURE:                                                   │
│  ┌──────────────────────────────────────────────────────┐        │
│  │                     Edgar                            │        │
│  │           (Distributed Tracing System)               │        │
│  └──────────────────────────────────────────────────────┘        │
│                          │                                       │
│           ┌──────────────┼──────────────┐                        │
│           ▼              ▼              ▼                        │
│      ┌─────────┐   ┌─────────┐   ┌─────────────┐                 │
│      │ Mantis  │   │  Atlas  │   │ Telltale    │                 │
│      │(Stream) │   │(Metrics)│   │(Anomaly Det)│                 │
│      └─────────┘   └─────────┘   └─────────────┘                 │
│                                                                  │
│  KEY INNOVATIONS:                                                │
│  1. Edgar: Custom distributed tracing for Netflix scale          │
│  2. Atlas: Time-series metrics (open-sourced)                    │
│  3. Telltale: Automated anomaly detection                        │
│  4. Mantis: Real-time stream processing for events               │
│                                                                  │
│  SAMPLING STRATEGY (representative pattern):                     │
│  • Head-based sampling for most traffic                          │
│  • 100% capture for errors and high-latency                      │
│  • 1% baseline for normal traffic                                │
│  • Dynamic rate adjustment based on system load                  │
│                                                                  │
│  LESSONS FOR GO SERVICES:                                        │
│  • Instrument at the edge (API gateway)                          │
│  • Use consistent trace ID propagation                           │
│  • Correlate traces with deployments                             │
│  • Focus on actionable alerts, not dashboards                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### How Stripe Approaches Observability

Stripe's most influential observability contribution is the canonical log line, documented on their engineering blog: one wide, structured log event per request that carries every dimension an investigator will ever need (trace ID, merchant, payment intent, latency, outcome), emitted at request completion. The pattern below shows what business-aware, correlation-first observability looks like in a Go payment service.

```go
// Business-aware observability in a Go payment service,
// in the style of Stripe's published canonical-log-line pattern.
// Illustrative sketch: the Counter/Histogram helpers are a
// simplified pseudo-API, not the literal OTel metric interfaces.

package observability

import (
    "context"
    "time"
)

// Stripe's key observability principles:
// 1. Every request has a trace
// 2. Metrics are business-aware
// 3. Logs are structured and queryable
// 4. All three are correlated

// RequestContext carries observability context through Stripe's systems
type RequestContext struct {
    TraceID       string
    SpanID        string
    RequestID     string  // Stripe's idempotency key
    MerchantID    string
    PaymentIntent string
    StartTime     time.Time
}

// Stripe's business-aware metrics
type PaymentMetrics struct {
    // Business metrics (what matters to the business)
    PaymentAttempts     Counter
    PaymentSuccesses    Counter
    PaymentFailures     Counter
    GrossPaymentVolume  Histogram  // GPV in cents

    // Technical metrics (what matters to engineers)
    ProcessingLatency   Histogram
    DatabaseLatency     Histogram
    ExternalAPILatency  Histogram

    // Dimensions that Stripe tracks
    // - payment_method: card, bank_transfer, wallet
    // - card_brand: visa, mastercard, amex
    // - region: us, eu, apac
    // - merchant_tier: startup, growth, enterprise
}

// Stripe's approach: traces tell the story, metrics measure health
func (s *PaymentService) ProcessPayment(ctx context.Context, payment *Payment) error {
    // Start span with business context
    ctx, span := tracer.Start(ctx, "ProcessPayment",
        trace.WithAttributes(
            attribute.String("payment.method", payment.Method),
            attribute.String("merchant.tier", payment.MerchantTier),
            // Note: Never log card numbers or sensitive data
        ),
    )
    defer span.End()

    // Business metric: attempt
    s.metrics.PaymentAttempts.Inc(ctx,
        "method", payment.Method,
        "region", payment.Region,
    )

    start := time.Now()

    // Process payment...

    // Business metric: success/failure
    if err != nil {
        s.metrics.PaymentFailures.Inc(ctx,
            "method", payment.Method,
            "error_type", categorizeError(err),
        )
    } else {
        s.metrics.PaymentSuccesses.Inc(ctx,
            "method", payment.Method,
        )
        s.metrics.GrossPaymentVolume.Observe(ctx,
            float64(payment.AmountCents),
            "method", payment.Method,
            "currency", payment.Currency,
        )
    }

    // Technical metric: latency
    s.metrics.ProcessingLatency.Observe(ctx,
        time.Since(start).Seconds(),
        "method", payment.Method,
    )

    return err
}
```

### Junior → FAANG: Learning from Large-Scale OTel Adoptions

Case studies from companies like Shopify, Uber, and Netflix reveal consistent patterns in successful OTel adoptions. The pattern is always the same: start with one service as a proof of concept, demonstrate the value during an incident, then drive adoption org-wide from that foundation.

For a first job, the practical lesson is to instrument a service well enough that the next on-call engineer (including future you) can diagnose the most common failure modes without reading source code. That means spans for every external call, error recording with stack context, and metric coverage for the four golden signals (latency, traffic, errors, saturation).

Interview entry point: "How would you prioritize OTel adoption across 50 services?" Start with the services that have the highest customer impact and the most frequent on-call pages. Instrumentation investment should be proportional to the cost of incidents in that service.

### Senior @ FAANG: Driving Org-Wide OTel Adoption as a Staff-Level Initiative

**The "paved road" pattern.** Successful org-wide OTel adoption at FAANG-scale companies does not mandate OTel: it makes OTel the easiest path. The platform team provides a single `go get` import that initializes all three OTel providers with production-safe defaults, connects to the regional Collector, and automatically instruments the HTTP server and database client. The alternative (manually configuring OTel from scratch) is made intentionally harder by not providing documentation for it. This "paved road" approach achieves near-universal adoption without requiring mandates.

**Measuring adoption and quality.** An L6 engineer defines observability quality metrics that are tracked org-wide: percentage of services that emit `service.name` resource attribute correctly, percentage of services that have at least one histogram metric covering request latency, percentage of traces that have a root span with a route template (not a raw URL). These metrics are published on an internal dashboard and reviewed in engineering leadership meetings, treating observability quality as an engineering health metric alongside code coverage and test reliability.

**Migration from legacy instrumentation.** Many companies have services already instrumented with Zipkin, Datadog APM, or a proprietary tracer. Migration to OTel requires running both systems in parallel during the transition period: OTel and the legacy SDK emit to their respective backends simultaneously, dashboards and alerts are migrated backend by backend, and the legacy SDK is removed only after the OTel-based dashboards have been validated in a production incident. A staff engineer coordinates this migration across multiple teams and manages the timeline to avoid extended parallel-run costs.

---
