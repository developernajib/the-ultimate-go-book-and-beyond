## Logging and Structured Errors

An error you cannot trace through your logs is an error you cannot fix. Modern C++ logging is structured (key-value pairs, JSON output, machine-parseable), source-located (file, line, function), and correlated (request IDs flow with the error through every service). This is the difference between "something broke" and "request abc123 failed at port-validation step in config-service v4.27 because port=70000 violated the [1, 65535] range".

### Structured Logging

Plain printf-style logs:

```
[2025-01-09 10:14:22] ERROR: failed to parse port 70000
```

are nearly useless for production. You can grep them, but you cannot aggregate, alert on counts, or join across services. Structured logs:

```json
{"ts":"2025-01-09T10:14:22Z","level":"error","service":"config","msg":"port out of range",
 "request_id":"abc123","port":70000,"min":1,"max":65535,"file":"config.cc","line":47}
```

are queryable. Splunk, Elasticsearch, BigQuery, Datadog, and every modern log aggregator wants this shape.

### absl Logging

```cpp
#include "absl/log/log.h"
#include "absl/log/check.h"

LOG(INFO) << "starting service" << " port=" << port;
LOG(WARNING) << "config reload failed";
LOG(ERROR).WithThreshold(absl::ERROR).AtLocation("config.cc", 47)
    << "port out of range: " << port;

LOG_EVERY_N(WARNING, 1000) << "rate limit hit";
LOG_FIRST_N(ERROR, 10) << "first 10 errors only";
LOG_IF(INFO, debug_) << "debug-only info";
```

absl's logging is the modern replacement for glog. It supports:

- Severity levels (`INFO`, `WARNING`, `ERROR`, `FATAL`).
- Source location capture (automatic, via macros).
- Rate-limiting (`LOG_EVERY_N`, `LOG_FIRST_N`).
- Sinks (file, stderr, custom). Multiple sinks with different filters.
- `LOG(FATAL)` aborts after logging.
- `CHECK` family integrates as fatal logs with assertion semantics.

For structured output, install a sink that formats as JSON:

```cpp
class JsonSink : public absl::LogSink {
public:
    void Send(const absl::LogEntry& e) override {
        // Build JSON from e.text_message_with_prefix(), e.source_filename(),
        // e.source_line(), e.timestamp(), thread, severity.
        std::string j = absl::StrCat(
            R"({"ts":")", FormatTime(e.timestamp()),
            R"(","level":")", LevelStr(e.log_severity()),
            R"(","file":")", e.source_filename(),
            R"(","line":)", e.source_line(),
            R"(,"msg":)", absl::CEscape(e.text_message()),
            "}\n");
        write_to(j);
    }
};

absl::AddLogSink(&json_sink);
```

### spdlog

```cpp
#include "spdlog/spdlog.h"
#include "spdlog/sinks/rotating_file_sink.h"

auto logger = spdlog::rotating_logger_mt("svc", "/var/log/svc.log",
                                          1024*1024*100,  // 100MB
                                          5);             // 5 files
logger->set_pattern("%Y-%m-%d %H:%M:%S.%e [%l] [%t] %v");
SPDLOG_LOGGER_INFO(logger, "starting on port {}", port);
SPDLOG_LOGGER_ERROR(logger, "port out of range: {}", port);
```

spdlog is fast (lock-free queues for async sinks), header-only (or compiled), and supports `fmt`-style formatting. For structured logs, the JSON formatter or a custom formatter producing key-value pairs.

The async sink:

```cpp
auto async_logger = spdlog::create_async<spdlog::sinks::rotating_file_sink_mt>(
    "svc", "/var/log/svc.log", 1024*1024*100, 5);
spdlog::set_default_logger(async_logger);
```

Async logging trades crash-safety for throughput: if the process crashes, the queue is lost. For services where you cannot afford the 1-2 microseconds per log line on the hot path, async is correct. For services where the last log line before crash is the most valuable, sync is correct. Often: async for INFO and below, sync for ERROR and above.

### Source Location

`std::source_location` (C++20) captures file, line, function name at the call site without macros:

```cpp
##include <source_location>

void Log(std::string_view msg,
         std::source_location loc = std::source_location::current()) {
    fmt::print("{}:{} {}: {}\n", loc.file_name(), loc.line(), loc.function_name(), msg);
}

Log("port out of range");
// prints: config.cc:47 ParsePort: port out of range
```

The default argument captures the caller's location because `current()` is called as part of the default argument initialization at the call site. This replaces `__FILE__` / `__LINE__` macros with a real value type.

For errors, attach source location to the error itself:

```cpp
struct LocatedError {
    std::error_code code;
    std::string message;
    std::source_location loc;

    LocatedError(std::error_code c, std::string m,
                 std::source_location l = std::source_location::current())
        : code(c), message(std::move(m)), loc(l) {}
};
```

Now any error knows where it was created, without stack traces.

## Error Chains

A single error often has a chain: low-level cause, mid-level operation, high-level context. Rust's `Error` trait has `source()`. Go uses `fmt.Errorf("...: %w", err)` to wrap. C++ has no standard pattern, but several work:

**`std::nested_exception` (C++11).** A standard mechanism for wrapping:

```cpp
try {
    LowLevelOp();
} catch (...) {
    std::throw_with_nested(std::runtime_error("mid-level operation failed"));
}

// later, walk the chain:
void PrintChain(const std::exception& e, int depth = 0) {
    std::cerr << std::string(depth * 2, ' ') << e.what() << "\n";
    try {
        std::rethrow_if_nested(e);
    } catch (const std::exception& inner) {
        PrintChain(inner, depth + 1);
    } catch (...) {
        std::cerr << std::string((depth + 1) * 2, ' ') << "(non-exception)\n";
    }
}
```

`throw_with_nested` packages the in-flight exception inside a new one. `rethrow_if_nested` walks the chain. The output looks like a chain of "caused by:" entries.

**Custom error type with cause pointer.**

```cpp
struct Error {
    std::string message;
    std::source_location loc;
    std::shared_ptr<Error> cause;       // chain
    std::map<std::string, std::string> fields;  // structured context
};
```

This is the pattern that ports cleanly to logs. Each error carries its message, location, optional cause, and structured key-value context. The logger walks the chain and emits one JSON object per level, with a shared correlation ID.

**`absl::Status` payload.** Attach the cause as a payload:

```cpp
absl::Status s = absl::InvalidArgumentError("port out of range");
s.SetPayload("cause", absl::Cord(inner_status.ToString()));
```

Less ergonomic than a typed chain, but works for cross-RPC propagation.

### Correlation IDs

Every request gets an ID (a UUID, a 64-bit random, a propagated trace ID). Every log line that runs on behalf of that request includes the ID. Every downstream call propagates it.

```cpp
class RequestContext {
public:
    std::string id;
    absl::Time deadline;
    // ...
};

// thread-local for synchronous code
inline thread_local const RequestContext* current_ctx = nullptr;

class CtxGuard {
public:
    explicit CtxGuard(const RequestContext& c) noexcept : prev_(current_ctx) {
        current_ctx = &c;
    }
    ~CtxGuard() noexcept { current_ctx = prev_; }
private:
    const RequestContext* prev_;
};

void Log(std::string_view msg) {
    auto* ctx = current_ctx;
    fmt::print(R"({{"req":"{}","msg":{}}}{})",
        ctx ? ctx->id : "-", absl::CEscape(msg), "\n");
}
```

For async code, the context must be plumbed through awaits. P2300 senders pass it via the `env`. Coroutines store it in the promise type. Folly's `RequestContext` uses thread-local with explicit save/restore around future continuations.

OpenTelemetry's `trace_id` and `span_id` are the cross-language standard for correlation. Use them. The W3C Trace Context header propagates over HTTP and gRPC.

### What to Log

For an error:

- Severity (ERROR, WARNING).
- Timestamp (UTC, sub-second precision).
- Service name and version.
- Source location (file, line, function).
- Correlation ID (request, trace, span).
- Error code (machine-readable).
- Error message (human-readable).
- Structured context (request fields involved, partial state).
- Cause chain.

For a successful operation, almost nothing at INFO level. High-cardinality success logging is the largest single contributor to log spend. Use sampled tracing for performance data, not logs.

### What Not to Log

- **Secrets.** API keys, passwords, OAuth tokens, session cookies, PII. Filter aggressively. A single leaked token in a log file is a breach.
- **Full request bodies.** Truncate or hash. Bodies contain user input, which contains PII.
- **Inside hot loops.** A `LOG(INFO)` per row in a million-row scan blows the log pipeline.
- **Stack traces at INFO.** Logs are not for traces. Use a tracing system.

### FAANG Bar

A senior engineer should:

- Use structured logs (JSON or key-value), not free-form strings.
- Capture source location with `std::source_location` or macro equivalent.
- Implement an error chain with cause pointer and walk it on log.
- Propagate correlation IDs through sync and async code.
- Pick async vs sync logging based on crash-safety vs throughput tradeoffs.
- Filter secrets and PII before they reach the sink.
- Rate-limit high-cardinality log lines.
