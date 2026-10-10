## Exercises

1. **Structured Logging with slog**: Replace all `log.Printf` calls in a small HTTP service with Go's `log/slog` package. Configure the handler to emit JSON-formatted output in production (using `slog.NewJSONHandler`) and human-readable text in development (using `slog.NewTextHandler`), switching based on a `LOG_FORMAT` environment variable. Add at least five structured attributes - including `method`, `path`, `status_code`, `duration_ms`, and `request_id` - on every HTTP request log entry. Verify the JSON output is valid and parseable by `jq`.

2. **Adding Trace IDs to Logs via Context**: Implement a middleware that generates a UUID trace ID per request and stores it in the request `context.Context` using a typed context key. Write a `LoggerFromCtx(ctx context.Context) *slog.Logger` helper that extracts the trace ID and returns a child logger pre-seeded with the `trace_id` attribute. Use this helper in at least three handler functions so that every log line they emit automatically carries the correct trace ID. Write a test that asserts the `trace_id` field is present and consistent across all log lines for a single request.

3. **Log Level Configuration per Environment**: Build a dynamic log-level system where the active `slog.Level` is read from a `LOG_LEVEL` environment variable at startup and can be changed at runtime without restarting the process. Expose a `PUT /admin/log-level` HTTP endpoint that accepts a JSON body `{"level": "debug"}` and atomically updates the level using `slog.LevelVar`. Demonstrate that changing the level to `debug` causes verbose logs to appear and changing it to `warn` suppresses them. Include a test using `httptest` that cycles through all four standard levels and verifies the logger responds correctly.

4. **Implementing a Log Sampling Strategy**: Write a `SamplingHandler` that wraps any `slog.Handler` and applies head-based sampling: log 100% of `ERROR`-level records, 10% of `INFO`-level records, and 1% of `DEBUG`-level records. Use an injectable random source for sampling decisions so tests can make them deterministic. Benchmark the handler under high-throughput conditions (1M log calls) and confirm that the sampled output volume matches the expected percentages within a 5% tolerance. Include a test that mocks the random source to produce deterministic results.

5. **Integrating OpenTelemetry Traces with Logs**: Instrument an HTTP service with `go.opentelemetry.io/otel` to create spans for each request. Extract the `trace_id` and `span_id` from `trace.SpanFromContext(ctx).SpanContext()` and inject both as structured fields into every `slog` log entry produced within that request's context. Configure a Jaeger exporter (or OTLP exporter pointing to a local collector) and verify in the Jaeger UI that clicking on a trace surfaces the corresponding log lines via the shared `trace_id`. Document the correlation query you used.

6. **Building a Request Correlation Middleware**: Create a production-grade `CorrelationMiddleware` for a `net/http` server that: (a) reads an incoming `X-Request-ID` header or generates a new UUID if absent, (b) stores the ID in context and echoes it back in the `X-Request-ID` response header, (c) injects the ID into a child `slog.Logger` bound to the context, and (d) logs a structured summary line containing `method`, `path`, `status`, `duration_ms`, and `request_id` when the handler returns. Wrap a `http.ResponseWriter` to capture the status code. Write integration tests using `httptest` that verify the header propagation, the log output fields, and that a pre-existing client-supplied request ID is preserved rather than overwritten.

### Senior at FAANG Track

7. **Observability gap audit.** For one service, assess conformance to the org's standard. Document gaps. Close the top three.

8. **RED dashboard.** Build a Grafana dashboard for one service showing Rate, Errors, Duration. Standardize across all services you own.

9. **SLO rollout.** Define SLOs for one user-facing service. Configure burn-rate alerts. Run for a month. Refine.

### Staff / Principal Track

10. **Observability library.** Ship the shared Go library with slog setup, Prometheus registration, OpenTelemetry initialization, correlation middleware, health checks. Drive adoption.

11. **MTTR reduction project.** Measure current MTTR for incidents. Identify observability gaps contributing. Close them. Re-measure in six months.

12. **Observability cost audit.** Assess current observability spend. Identify waste. Reduce by 30% while preserving signal quality.

13. **On-call training.** Deliver a workshop on using the observability stack effectively during incidents. Measure comprehension via tabletop exercises.

14. **Cross-service tracing.** Ensure every service participates in distributed tracing. Audit coverage. Close gaps. Verify cross-service traces are usable.
