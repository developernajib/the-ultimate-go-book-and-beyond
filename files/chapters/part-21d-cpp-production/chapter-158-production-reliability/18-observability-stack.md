## Observability Stack

A reliable service is observable. That means three pillars: logs (what happened), metrics (how often, how much), and traces (in what causal order, across what services). A senior C++ engineer wires up all three with the right libraries, the right sampling rates, and the right linkages, and treats the resulting telemetry as a first-class engineering artifact, not an afterthought.

### Structured Logging in C++

Three serious options:

**absl logging** (Abseil's logging library). The modern standard for new Google-ecosystem C++ projects. Supersedes glog. Streaming API, structured fields via `LOG(INFO).WithExtra("user", uid)`. Open source.

**glog** (Google's older logging library). Still everywhere. The streaming API every C++ engineer knows. `LOG(INFO) << "request " << id;`.

**spdlog**. A modern third-party option, popular outside the Google ecosystem. Header-only or compiled. Asynchronous logging by default. Supports structured logs via a formatter.

Pick one and use it consistently. Mixing logging libraries in one binary is a recipe for missed log lines.

For structured logging (machine-parseable), the goal is JSON output (or another structured format) with consistent field names: `timestamp`, `level`, `service`, `request_id`, `message`, `trace_id`, plus per-event fields.

Sketch of a structured-log helper:

```cpp
class StructuredLog {
public:
    StructuredLog(LogSeverity sev, const char* file, int line)
        : sev_(sev), file_(file), line_(line) {}

    StructuredLog& Field(std::string_view key, std::string_view val) {
        fields_[std::string(key)] = std::string(val);
        return *this;
    }

    StructuredLog& Field(std::string_view key, int64_t val) {
        fields_[std::string(key)] = std::to_string(val);
        return *this;
    }

    ~StructuredLog() {
        // emit JSON line on destruction
        EmitJson(sev_, file_, line_, fields_, stream_.str());
    }

    template <typename T>
    StructuredLog& operator<<(const T& v) {
        stream_ << v;
        return *this;
    }

private:
    LogSeverity sev_;
    const char* file_;
    int line_;
    absl::flat_hash_map<std::string, std::string> fields_;
    std::ostringstream stream_;
};

#define SLOG(sev) StructuredLog(sev, __FILE__, __LINE__)
```

Use:

```cpp
SLOG(INFO).Field("request_id", id).Field("user", uid)
    << "processed in " << ms << "ms";
```

The output line:

```json
{"ts":"2026-04-25T...","level":"INFO","file":"server.cc","line":178,
 "request_id":"abc","user":"u123","msg":"processed in 5ms"}
```

Structured logs are the input to log-search systems (Elasticsearch, Splunk, Loki, Datadog Logs). Without structure, log search is regex hell. With structure, you can query "all logs for request_id abc with level WARN."

### Asynchronous Logging

Synchronous logging is a tail-latency catastrophe. A 5ms disk write inside the request path costs you 5ms on every log line.

The standard fix: a logger thread. The request thread serializes the log line and pushes it to a lock-free queue. The logger thread drains the queue in batches and writes to disk.

spdlog's async mode does this by default. absl logging has a flag (`absl::SetSinkFlushLevel`) that controls the synchronous flush level. The convention: synchronous flush only for `FATAL`, asynchronous for everything else.

The trade: a crash can lose the most recent log lines. Mitigate by flushing on signal handlers (`std::atexit`, signal handler that calls `Flush()`) and by accepting that the last few lines might be lost.

### Metrics: prometheus-cpp

prometheus-cpp is the C++ client for the Prometheus monitoring system. It exposes a `/metrics` endpoint over HTTP, and the Prometheus server scrapes it periodically.

```cpp
#include <prometheus/exposer.h>
#include <prometheus/registry.h>

auto registry = std::make_shared<prometheus::Registry>();
auto& family = prometheus::BuildCounter()
    .Name("requests_total")
    .Help("Total requests handled")
    .Register(*registry);

auto& counter = family.Add({{"method", "Get"}});

prometheus::Exposer exposer{"127.0.0.1:8080"};
exposer.RegisterCollectable(registry);

// in request path:
counter.Increment();
```

Histogram for latency:

```cpp
auto& latency_family = prometheus::BuildHistogram()
    .Name("request_duration_seconds")
    .Help("Request duration")
    .Register(*registry);

auto& latency = latency_family.Add({}, prometheus::Histogram::BucketBoundaries{
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0});

auto start = std::chrono::steady_clock::now();
HandleRequest();
auto duration = std::chrono::steady_clock::now() - start;
latency.Observe(std::chrono::duration<double>(duration).count());
```

The bucket boundaries determine the resolution of percentile estimates. For latency-sensitive services, use exponentially-spaced buckets that span the full range from microseconds to seconds.

### Distributed Tracing: OpenTelemetry C++

OpenTelemetry is the CNCF standard, replacing OpenTracing and OpenCensus. The C++ SDK is at version 1.x and is the recommended choice for new projects. It exports to Jaeger, Zipkin, OpenTelemetry Collector, Honeycomb, and other backends via OTLP.

A minimal trace:

```cpp
#include <opentelemetry/sdk/trace/tracer_provider.h>
#include <opentelemetry/exporters/otlp/otlp_grpc_exporter.h>

auto exporter = std::make_unique<opentelemetry::exporter::otlp::OtlpGrpcExporter>();
auto processor = std::make_unique<opentelemetry::sdk::trace::BatchSpanProcessor>(
    std::move(exporter), {});
auto provider = std::make_shared<opentelemetry::sdk::trace::TracerProvider>(
    std::move(processor));
opentelemetry::trace::Provider::SetTracerProvider(provider);

auto tracer = provider->GetTracer("myservice");

void Server::HandleRequest(Request* req) {
    auto span = tracer->StartSpan("HandleRequest");
    auto scope = tracer->WithActiveSpan(span);
    span->SetAttribute("request.id", req->id());

    DoWork();  // inner spans inherit context

    span->End();
}
```

Context propagation: when calling another service, inject the trace context into the outgoing request headers. The receiving service extracts the context and continues the trace.

```cpp
auto carrier = HttpHeadersCarrier(outgoing_headers);
opentelemetry::context::propagation::GlobalTextMapPropagator::GetGlobalPropagator()
    ->Inject(carrier, opentelemetry::context::RuntimeContext::GetCurrent());
```

Sampling: tracing all requests is expensive. The standard pattern is head-based probabilistic sampling (1% of traces) plus tail-based sampling (always sample if the request errored or was slow).

### Exemplars: Linking Metrics and Traces

A high latency on a histogram tells you the percentile. An exemplar links a specific bucket to a specific trace ID, so you can see *which* request was slow.

prometheus-cpp does not yet have first-class exemplar support, but the OpenMetrics format does, and the OpenTelemetry Collector can emit exemplars. The pattern: when recording a latency observation, attach the current trace ID. The metrics scrape includes a few example trace IDs per bucket.

The result: an alert fires on p99 latency. The on-call engineer clicks the metric, sees an exemplar trace ID, jumps to the trace UI, sees the span tree, identifies the slow downstream service. Total time to root cause: minutes instead of hours.

### Log/Trace/Metric Linkage

The single most important convention is consistent identifiers across the three pillars. A request has:

- A `trace_id` (from the trace, propagated across services).
- A `span_id` (the current span).
- A `request_id` (your service's external identifier).

Every log line includes these. Every metric exemplar references them. The on-call engineer can pivot from any pillar to either of the others.

```cpp
SLOG(INFO).Field("trace_id", CurrentTraceId())
          .Field("span_id", CurrentSpanId())
          .Field("request_id", req->id())
          << "processed";
```

### Sampling Rates

A 1M QPS service producing one log line per request, at 200 bytes each, is 200MB/s of log volume. That is 17TB per day. Storing that for a month is half a petabyte.

Sampling matters:

- **Always log errors.** 100%.
- **Sample successes.** 0.1% to 1% is typical.
- **Trace head-sample** at 1% (or less for huge volume).
- **Trace tail-sample** at 100% for slow or errored requests.
- **Metrics**: no sampling, but resolution-aware (per-second counters, per-minute histograms aggregated, etc.).

The trace tail-sampling pattern needs a buffer: every span is held in memory for a few seconds, then either exported (if interesting) or dropped. The OpenTelemetry Collector's tail-sampling processor implements this.

### Cardinality Management

The killer of metric systems is high-cardinality labels. A counter `requests_total{user_id="..."}` with a million distinct user IDs creates a million time series, each consuming memory in the Prometheus server. Avoid:

- User IDs.
- Trace IDs.
- Request paths with embedded variables (use `/users/:id`, not `/users/12345`).

If you need per-user analysis, use logs (cheaper for high cardinality) or traces, not metrics.

### What Goes Wrong

- **Logs are unstructured.** Future you cannot query them. Adopt structured logging from the start.
- **Tracing is not propagated.** A trace stops at a service boundary. The full call graph is opaque. Fix: propagate context everywhere, audit every RPC client.
- **Metrics have high cardinality.** Prometheus runs out of memory. Use sparingly.
- **Logs do not have trace IDs.** You cannot correlate a slow trace with the log lines that explain why. Fix: every log includes the active trace ID.

### Senior at FAANG: The Telemetry Investment

A senior contribution is the telemetry baseline: structured logging library, metrics library, tracing library, conventions for IDs, sampling rates calibrated to volume, dashboards that span all three pillars. The on-call engineer at 3 AM gets a clear picture, not a wall of unstructured text. That picture is what makes the difference between a 10-minute incident and a 2-hour one.

---
