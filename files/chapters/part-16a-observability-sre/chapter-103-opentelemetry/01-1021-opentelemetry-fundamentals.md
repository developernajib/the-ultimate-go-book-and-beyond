## 103.1 OpenTelemetry Fundamentals

### What is OpenTelemetry?

OpenTelemetry solves the vendor lock-in problem that plagued observability for years: every monitoring backend (Datadog, Jaeger, Zipkin, New Relic) required its own SDK, forcing teams to rewrite instrumentation code whenever they switched tools. By providing a single, vendor-neutral API and SDK, OpenTelemetry lets you instrument once and export to any compatible backend. The Collector acts as a pipeline agent that receives telemetry from your application, applies processing (sampling, filtering, enrichment), and fans it out to one or more backends simultaneously.

```
┌──────────────────────────────────────────────────────────────────┐
│                    OPENTELEMETRY OVERVIEW                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DEFINITION:                                                     │
│  OpenTelemetry is a vendor-neutral observability framework       │
│  for instrumenting, generating, collecting, and exporting        │
│  telemetry data (traces, metrics, logs).                         │
│                                                                  │
│  THE THREE PILLARS:                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                 │
│  │   TRACES    │ │   METRICS   │ │    LOGS     │                 │
│  │             │ │             │ │             │                 │
│  │ Request flow│ │ Aggregated  │ │ Discrete    │                 │
│  │ across      │ │ measurements│ │ events      │                 │
│  │ services    │ │ over time   │ │ with context│                 │
│  └─────────────┘ └─────────────┘ └─────────────┘                 │
│                                                                  │
│  ARCHITECTURE:                                                   │
│  ┌─────────┐    ┌───────────┐    ┌──────────────┐                │
│  │   App   │───►│ Collector │───►│   Backend    │                │
│  │ (SDK)   │    │           │    │ (Jaeger,     │                │
│  └─────────┘    └───────────┘    │  Prometheus) │                │
│                                   └──────────────┘               │
│                                                                  │
│  KEY CONCEPTS:                                                   │
│  • Span: Single operation within a trace                         │
│  • Trace: Collection of spans forming a request path             │
│  • Metric: Numerical measurement at a point in time              │
│  • Context: Propagates trace information across boundaries       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Building the Mental Model Before Writing a Single Span

The biggest mistake junior engineers make with OTel is treating it as "just another library to import." Understanding the data model first prevents weeks of debugging malformed traces. Internalize these three relationships:

A **trace** is a directed acyclic graph of **spans**. Each span has a start time, end time, status, and a set of key-value attributes. The root span represents the entry point (an incoming HTTP request, for example). Child spans represent downstream calls: database queries, cache lookups, outbound RPC calls. The parent-child relationship is established through `context.Context`, which carries the active span.

A **metric** is a time-series aggregation. Unlike a span (which represents one specific request), a metric aggregates thousands of requests into a single data point. Counters, gauges, and histograms serve different purposes. Use a counter for "total requests served," a gauge for "current goroutine count," and a histogram for "request latency distribution."

For your first-job habit: always check that you are passing the context returned by `tracer.Start` (which carries the new child span), not the original context. Dropping that distinction produces a flat trace with no parent-child hierarchy, which is nearly useless during an incident.

Interview entry point: "What happens if you call `span.End()` twice in Go OTel?" The second call is a no-op in the SDK implementation, but the fact that you know this signals you have read the SDK source, not just the quickstart.

### Installation

OpenTelemetry's Go support is split across multiple modules to keep binary size minimal: you only pull in the exporters your deployment actually uses. The `otel` and `otel/sdk` packages provide the core API and SDK respectively, while the `contrib` instrumentation packages wrap standard library transports (`net/http`, `google.golang.org/grpc`) so that incoming and outgoing requests are automatically traced without manual span creation in every handler.

```bash
# Core packages
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk
go get go.opentelemetry.io/otel/trace

# Exporters
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
go get go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp
go get go.opentelemetry.io/otel/exporters/prometheus

# Instrumentation
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
```

### Senior @ FAANG: SDK Architecture, Versioning Governance, and Rollout Strategy

**SDK module split as a governance lever.** OTel's Go SDK is intentionally split into many small modules. At a platform team level, this split is an opportunity: you can pin the API module (`go.opentelemetry.io/otel`) independently of the SDK module (`go.opentelemetry.io/otel/sdk`). Application teams depend only on the API. The platform team injects the SDK implementation at binary link time via dependency injection in `main`. This decoupling means a bug fix or a new exporter can be rolled out across all services by updating a shared wrapper package, without requiring every team to upgrade their SDK dependency manually.

**Version skew risk.** When hundreds of services import OTel independently, API and SDK version skew becomes a real operational hazard. A service that uses API v1.20 but the Collector receives spans from SDK v1.15 may encounter attribute encoding differences that silently drop data. The mitigation is a Renovate or Dependabot policy that keeps all OTel modules in sync via a single group update, enforced by a CI lint check that fails if any service's `go.sum` shows mismatched major versions.

**Resource attributes as the identity contract.** The `resource.Resource` attached to a provider is the identity of a service in the observability backend. At L6 and above, you define an org-wide resource attribute standard: `service.name` must match the Kubernetes Deployment name, `service.version` must be a git SHA, and `deployment.environment` must come from a downward API env var. This standard enables backend queries like "show me all traces for payment-service version abc123 in production" to work reliably across every team's data without any post-hoc normalization.

**Exporter selection for production environments.** The OTLP gRPC exporter is preferred over HTTP in high-throughput scenarios because it uses multiplexed HTTP/2 streams and protobuf framing, reducing per-request overhead significantly. However, in environments where the network path to the Collector traverses a load balancer that does not support HTTP/2 streaming, the HTTP exporter with a batch processor is the correct fallback. Documenting this decision in an ADR prevents future engineers from blindly switching exporters and introducing latency regressions.

**Canary rollout of instrumentation changes.** Adding a new span attribute or changing cardinality of an existing one is a production change, not just a code change. A senior engineer treats instrumentation PRs with the same review discipline as schema migrations: review the attribute name against the OTel semantic conventions spec, estimate the cardinality impact on the metrics backend, and validate in a staging environment with production-like traffic volume before merging. At FAANG scale, a single new high-cardinality label can multiply time-series counts and drive substantial storage and query cost in the metrics backend.

---
