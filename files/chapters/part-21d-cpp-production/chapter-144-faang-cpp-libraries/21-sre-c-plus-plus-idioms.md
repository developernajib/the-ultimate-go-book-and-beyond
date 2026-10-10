## SRE C++ Idioms

A C++ service at FAANG scale is not just code. It is a binary that runs on shared infrastructure, must be observable, must shed load gracefully, must restart without dropping requests, and must answer to an SRE on call at 3 a.m. This file covers the patterns that make a C++ binary SRE-friendly.

### SLI Definitions in Code

Service Level Indicators (SLIs) are quantitative measures of service health. The SRE Workbook defines categories: availability, latency, throughput, freshness, correctness. In code, an SLI is a counter or histogram exposed to monitoring.

```cpp
// Availability SLI: ratio of successful requests.
auto* requests_total = prometheus::BuildCounter()
    .Name("rpc_requests_total")
    .Help("Total RPC requests")
    .Register(*registry);
auto& success = requests_total->Add({{"result", "ok"}});
auto& failure = requests_total->Add({{"result", "error"}});

// Latency SLI: histogram of request durations.
auto* latency = prometheus::BuildHistogram()
    .Name("rpc_request_duration_seconds")
    .Help("RPC request duration")
    .Buckets({0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0})
    .Register(*registry);
auto& by_method = latency->Add({{"method", "Get"}});

void HandleGet(const Request& r) {
  auto start = absl::Now();
  auto status = DoGet(r);
  by_method.Observe(absl::ToDoubleSeconds(absl::Now() - start));
  if (status.ok()) success.Increment(); else failure.Increment();
}
```

The bucket boundaries are deliberate. SLO targets at p99 = 100 ms need a bucket boundary near 100 ms. A bucket at 0.1 lets you compute p99 by interpolation. Without that bucket, p99 calculation is wrong.

### prometheus-cpp Client

The de facto C++ Prometheus client is `prometheus-cpp` (jupp0r/prometheus-cpp). It exposes counters, gauges, histograms, summaries. The library serves an HTTP endpoint (`/metrics`) that Prometheus scrapes.

```cpp
#include <prometheus/exposer.h>
#include <prometheus/registry.h>

auto registry = std::make_shared<prometheus::Registry>();
prometheus::Exposer exposer{"0.0.0.0:9100"};
exposer.RegisterCollectable(registry);
```

The Exposer runs an HTTP server on port 9100. Scrape config in Prometheus points at it.

For Google Cloud Monitoring or OpenTelemetry, you swap the Prometheus exporter for the OTel exporter, but the metric definitions stay the same. The OpenTelemetry C++ SDK has stabilized tracing in 2022 and metrics in 2023.

### Structured Logging

Plain text logs are unsearchable at scale. Structured logging emits JSON or protobuf events with named fields:

```cpp
struct LogEvent {
  absl::Time timestamp;
  std::string severity;
  std::string trace_id;
  std::string span_id;
  std::string message;
  absl::flat_hash_map<std::string, std::string> attributes;
};

void EmitLog(const LogEvent& e) {
  std::cout << absl::StrFormat(
      R"({"ts":"%s","sev":"%s","trace":"%s","span":"%s","msg":%s,"attrs":%s})"
      "\n",
      absl::FormatTime(absl::RFC3339_full, e.timestamp, absl::UTCTimeZone()),
      e.severity, e.trace_id, e.span_id,
      JsonEscape(e.message), AttributesAsJson(e.attributes));
}
```

Structured logs are ingested by Stackdriver, Splunk, Loki, or your in-house pipeline. Search becomes "all error logs in the last hour for trace abc123" instead of grep across thousands of files.

The trace and span IDs link the log to distributed traces. When OpenTelemetry instruments the RPC layer, the active trace context is available via `opentelemetry::trace::Tracer::WithActiveSpan` and you stamp every log with it.

### Server Lameduck Mode

When a binary is shutting down (rolling deploy, draining for maintenance), it should:

1. Stop accepting new requests.
2. Finish in-flight requests.
3. Exit cleanly.

This is "lameduck mode". Naive shutdown drops in-flight requests and causes a deploy-driven error spike. The pattern:

```cpp
class Server {
 public:
  void Run() {
    // Listen for SIGTERM.
    signal(SIGTERM, &Server::OnSigTerm);
    // Accept loop.
    while (!draining_.load()) AcceptOne();
    // Drain.
    Drain();
  }

  void Drain() {
    // 1. Update health check to FAIL. Load balancer stops sending traffic.
    health_.Set(grpc::health::v1::HealthCheckResponse::NOT_SERVING);
    // 2. Wait for the LB to notice (typically 5 to 15 s of stale health).
    absl::SleepFor(absl::Seconds(15));
    // 3. Wait for in-flight requests to complete.
    in_flight_.AwaitZero();
    // 4. Shutdown gRPC server with a finite deadline.
    server_->Shutdown(absl::ToChronoTime(absl::Now() + absl::Seconds(30)));
  }

 private:
  std::atomic<bool> draining_{false};
  // ...
};
```

The two-phase drain (mark unhealthy, then sleep, then shutdown) is critical. Without the sleep, the LB still routes to the dying replica.

### Request Deadline Propagation

A user request hitting your edge has a deadline (say 1 s). Every downstream RPC the server makes must inherit a deadline at most as long as the parent's remaining time. Without this, a slow downstream blocks the request long after the user gave up.

In gRPC C++:

```cpp
void Handler::Handle(grpc::ServerContext* ctx, const Request* req, Response* resp) {
  auto deadline = ctx->deadline();
  // Propagate to downstream calls.
  grpc::ClientContext sub_ctx;
  sub_ctx.set_deadline(deadline);
  downstream_stub_->DoWork(&sub_ctx, sub_req, &sub_resp);
}
```

For non-gRPC code, pass `absl::Time` deadlines explicitly through your call stack. Every blocking primitive (Mutex, channel reads, file IO) needs a deadline-aware variant.

A common bug: setting a fixed downstream timeout of, say, 500 ms regardless of parent deadline. If the parent has 200 ms left, you waste 300 ms running a doomed call. If the parent has 5 s left, you fail prematurely on a slow but legitimate downstream.

### Health Checks: Liveness vs Readiness

- Liveness: "is this process alive?" If it answers no, the orchestrator (k8s, Borg) restarts the pod. Liveness should fail only if the process is genuinely dead (deadlock, infinite loop). It must not depend on downstreams.
- Readiness: "should this process receive traffic?" If it answers no, the LB routes around. Readiness can depend on warm-up (config loaded, caches primed, downstreams reachable).

A common bug: making liveness check depend on a downstream service. When the downstream has a brownout, every replica fails liveness, gets restarted, the entire fleet flaps simultaneously, and the brownout becomes an outage.

```cpp
// Liveness: just answer 200 OK if the event loop is responsive.
http_server.AddRoute("/healthz", [](Request*, Response* r) {
  r->SetStatus(200);
});

// Readiness: check warm-up flags.
http_server.AddRoute("/ready", [&](Request*, Response* r) {
  if (!config_loaded_.load() || !cache_warm_.load()) {
    r->SetStatus(503);
    return;
  }
  r->SetStatus(200);
});
```

### Load Shedding

Under overload, drop excess requests fast instead of queuing. A queue grows unbounded, eats memory, and increases latency for every request including those that would have been fast.

Patterns:

- Concurrency cap: a semaphore admits at most N requests. Beyond N, return UNAVAILABLE immediately.
- Queue cap: the same idea on the request queue.
- Adaptive: track the success rate. If errors rise, reject some fraction (Doorman, AIMD).
- CoDel: drop the oldest queued request when latency exceeds a target.

```cpp
class AdmissionControl {
 public:
  bool TryAdmit() {
    int current = in_flight_.fetch_add(1) + 1;
    if (current > limit_) {
      in_flight_.fetch_sub(1);
      shed_.Increment();
      return false;
    }
    return true;
  }
  void Release() { in_flight_.fetch_sub(1); }

 private:
  std::atomic<int> in_flight_{0};
  int limit_ = 1000;
};
```

Surface the shed counter as an SLI. If it is non-zero, capacity planning is wrong.

### Bazel Basics for SRE-Touchable Code

SRE engineers read and modify build files when they on-call diagnose a binary. The basics:

- `bazel build //path:target`: build a target.
- `bazel run //path:binary`: build and run.
- `bazel test //path:test`: build and run a test.
- `bazel query 'deps(//foo:bar)'`: what does foo:bar depend on?
- `bazel cquery 'kind("cc_binary", //...)'`: list all binaries in the workspace.

A `cc_binary` for a server typically:

```python
cc_binary(
    name = "myserver",
    srcs = ["main.cc"],
    deps = [
        ":service_impl",
        "//base:flags",
        "//net/grpc:server",
    ],
    linkstatic = True,           # statically link for portable deploy.
    stamp = 1,                   # embed build timestamp and version.
)
```

`linkstatic = True` produces a single binary with no shared library dependencies (other than libc). Deploy is one file.

`stamp = 1` embeds the source revision and build time into the binary, surfaced via `--version`. Critical for SRE: when paged, the first question is "what version is running?".

### Crash Diagnostics

A crashing C++ binary should emit:

- Stack trace via `absl::FailureSignalHandler` (`absl::InstallFailureSignalHandler`).
- Core dump enabled via the OS limits (`ulimit -c unlimited`, or systemd `LimitCORE=infinity`).
- A symbolized crash log to stderr.
- A health-check transition to NOT_SERVING before the orchestrator notices.

```cpp
int main(int argc, char** argv) {
  absl::InitializeSymbolizer(argv[0]);
  absl::FailureSignalHandlerOptions opts;
  opts.symbolize_stacktrace = true;
  opts.alarm_on_failure_secs = 10;  // Force exit if handler hangs.
  absl::InstallFailureSignalHandler(opts);
  // ...
}
```

For non-crash debugging, ship a heap profiler (`tcmalloc` with `MALLOC_PROFILE_LEAK_CHECK`) and a CPU profiler (gperftools or perf). When a memory leak is suspected, an SRE can dump a heap profile from the live process and analyze with `pprof`.

### Junior to FAANG: Observability Is Code

A junior engineer adds metrics after the fact when an alert is needed. A FAANG-track engineer adds the SLI counters at the same time as the feature. Every public method increments a counter, records a latency histogram, and sets an attribute on the active trace span. Observability is a first-class output of the code, not a thing you bolt on.

### Senior at FAANG: Owning the SLO

Senior engineers own the SLO, not just the code. They:

- Define the SLO with the product team (99.9 percent of requests succeed in under 200 ms over 28 days).
- Wire the SLI in code such that the dashboard renders the right numbers.
- Tune load shedding and retry policies to keep the SLO during partial failures.
- Review every postmortem. Identify the root cause class. Fix the class, not the instance.

The binary that ships with a coherent SLO and no SRE handoff debt is the artifact a senior engineer is judged on.
