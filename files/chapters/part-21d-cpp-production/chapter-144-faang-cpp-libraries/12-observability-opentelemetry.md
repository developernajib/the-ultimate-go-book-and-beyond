## Observability: OpenTelemetry for C++ Services

Production C++ services at FAANG scale are instrumented with OpenTelemetry (OTel). The C++ SDK is the canonical way to emit traces, metrics, and logs with W3C `traceparent` context propagation. Every RPC, every database call, every async boundary should carry a span, otherwise a senior engineer cannot debug a p99.9 regression in an hour.

### Tracer bootstrap

```cpp
#include <opentelemetry/sdk/trace/tracer_provider.h>
#include <opentelemetry/exporters/otlp/otlp_grpc_exporter_factory.h>
#include <opentelemetry/sdk/trace/batch_span_processor_factory.h>
#include <opentelemetry/sdk/resource/resource.h>
#include <opentelemetry/trace/provider.h>

namespace otel = opentelemetry;
namespace sdk  = opentelemetry::sdk::trace;

void InitTracing(std::string_view service, std::string_view version) {
    otel::exporter::otlp::OtlpGrpcExporterOptions opts;
    opts.endpoint = "otel-collector.monitoring.svc:4317";
    auto exporter = otel::exporter::otlp::OtlpGrpcExporterFactory::Create(opts);

    sdk::BatchSpanProcessorOptions bopts;
    bopts.max_queue_size        = 8192;
    bopts.schedule_delay_millis = std::chrono::milliseconds(500);
    bopts.max_export_batch_size = 1024;
    auto processor = sdk::BatchSpanProcessorFactory::Create(std::move(exporter), bopts);

    auto resource = otel::sdk::resource::Resource::Create({
        {"service.name",    std::string(service)},
        {"service.version", std::string(version)},
        {"deployment.environment", std::getenv("ENV") ?: "prod"},
    });

    auto provider = sdk::TracerProviderFactory::Create(std::move(processor), resource);
    otel::trace::Provider::SetTracerProvider(std::move(provider));
}
```

The batch processor is non-negotiable. Synchronous export will serialize every RPC behind the collector, converting a 100us latency budget into 5ms. Tune `max_queue_size` to survive collector outages without dropping spans, but cap it to avoid runaway memory on backpressure.

### Span creation with RAII

```cpp
auto tracer = otel::trace::Provider::GetTracerProvider()->GetTracer("orders");

absl::StatusOr<Order> PlaceOrder(const Request& req) {
    auto span = tracer->StartSpan("PlaceOrder", {
        {"user_id",  req.user_id()},
        {"symbol",   req.symbol()},
        {"quantity", req.quantity()},
    });
    auto scope = tracer->WithActiveSpan(span);  // activates in TLS

    auto user = co_await LookupUser(req.user_id());
    if (!user.ok()) {
        span->SetStatus(otel::trace::StatusCode::kError, user.status().message());
        span->End();
        return user.status();
    }

    auto result = co_await risk_check.Evaluate(*user, req);
    span->SetAttribute("risk.score", result.score);
    span->End();
    return result.order;
}
```

Active-span scoping propagates context through nested calls without explicit threading. Context carries across `co_await` via OTel's coroutine integration (opt-in with `-DOPENTELEMETRY_ABI_VERSION_NO=2`).

### Propagation over gRPC

```cpp
class TraceClientInterceptor : public grpc::experimental::Interceptor {
    void Intercept(grpc::experimental::InterceptorBatchMethods* m) override {
        using Hook = grpc::experimental::InterceptionHookPoints;
        if (m->QueryInterceptionHookPoint(Hook::PRE_SEND_INITIAL_METADATA)) {
            auto carrier = GrpcMetadataCarrier{m->GetSendInitialMetadata()};
            auto ctx = otel::context::RuntimeContext::GetCurrent();
            otel::trace::propagation::HttpTraceContext{}.Inject(carrier, ctx);
        }
        m->Proceed();
    }
};
```

The `traceparent` header format is `00-<trace-id>-<span-id>-<flags>`. The server-side interceptor mirrors this, extracting the header and seeding a child span. End-to-end trace assembly requires every hop, including legacy services, to forward the header unchanged. A single non-propagating hop silently terminates the trace.

### Exemplars linking metrics to traces

Prometheus exemplars (OpenMetrics) attach a trace ID to a histogram bucket observation, so a single click in Grafana jumps from a p99 spike to the offending trace. Emit them when recording latency histograms:

```cpp
histogram->Record(elapsed_ms, {{"method", "PlaceOrder"}},
    {{"trace_id", span->GetContext().trace_id().Id()}});
```

This one line is the difference between "we have a p99.9 spike" and "here is the exact request that caused it."

### Sampling discipline

Head-based sampling at 1-10 percent is the default. For incident debugging add tail-based sampling at the collector, keeping every trace that contains an error span or exceeds a latency threshold. Never sample at 100 percent in prod without a collector-level rate limit, or an incident will synthesize a second incident from instrumentation overhead alone.

### Anti-patterns to reject in code review

- Creating a span per loop iteration inside a hot path. Aggregate at the batch boundary.
- Emitting PII as span attributes. Attributes are indexed and retained, and they leak through exporters.
- Using `GetCurrentSpan()->SetAttribute` outside the originating scope, which mutates the wrong span when coroutines resume on different threads.
- Blocking the main thread on `Shutdown()`. Schedule flush on a dedicated thread with a deadline.
