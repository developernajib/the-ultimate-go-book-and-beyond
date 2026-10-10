## 105E.8 Common Mistakes and How to Avoid Them

| Mistake | Problem | Solution |
|---------|---------|----------|
| Head-based sampling only | Lose visibility into slow/error traces | Implement tail-based sampling to always capture errors and slow traces |
| Not propagating baggage | Business context (tenant, user) missing from traces | Use W3C Baggage to propagate tenant ID, experiment flags through all hops |
| Sampling too aggressively | Missing production issues | Start at 10% sample rate, use tail sampling to capture all errors |
| Forgetting span.End() | Span never exported, trace has gaps | Use `defer span.End()` immediately after span creation |
| Not recording errors | Errors invisible in traces | Always call `span.RecordError(err)` and `span.SetStatus(codes.Error, ...)` |
| Missing span kind | Tracing backends can't infer service topology | Always set `trace.WithSpanKind()` for server, client, producer, consumer spans |
| High cardinality span names | Too many unique spans, high storage cost | Use operation type in name (e.g., "db.query users") not specific IDs |
| Not instrumenting async work | Goroutine-spawned work invisible | Pass context into goroutines, create child spans from the context |
| Missing database statement | Can't find slow queries in traces | Add `db.statement` attribute (truncated at 1000 chars for safety) |
| Testing without span recorder | No way to verify tracing instrumentation | Use `SpanRecorder` processor in tests to capture and assert on spans |

### Junior → FAANG: The Three Mistakes That Produce Silent Observability Failures

Of the ten mistakes above, three are particularly insidious because they do not produce any runtime error but silently degrade the observability of the system.

Forgetting `span.End()` is the worst because the span is never handed to the processor and therefore never exported: the operation silently vanishes from every trace, and if the span is referenced from a long-lived context its recorded data stays alive as well. The fix is mechanical: always write `defer span.End()` on the line immediately after the span is created, before any other code.

Not recording errors is the second silent failure. A span that returns without `span.SetStatus(codes.Error, ...)` will appear as a successful span even if the function returned an error. Jaeger and Tempo filter by error status, so engineers investigating error traces will not find these spans. The fix is `EndWithError(span, err)` as a wrapper that handles both recording and ending.

High cardinality span names cause storage cost explosions that appear weeks after the bug is introduced, when the trace backend's disk usage trends upward unexpectedly. A span named `"GET /users/12345"` (with a user ID embedded in the name) creates a unique span name for every user. The fix is to use the route template as the span name (`"GET /users/{id}"`) and put the specific ID in a span attribute.

### Senior @ FAANG: Operationalizing Mistake Prevention Across the Organization

At L6, each row in the mistake table above is a candidate for automated enforcement. Missing `span.End()` calls can be detected with a `go vet` analyzer that inspects every `tracer.Start()` call site and verifies the corresponding `defer span.End()` exists in the same function scope. High cardinality span names can be detected with a Collector processor that counts distinct span names per service per hour and fires an alert when a service introduces more than 100 new unique span names in a single deploy. Missing error recording can be detected with a span post-processor that checks whether any span carrying a non-2xx HTTP status code or a non-nil error attribute also carries `otel.status_code=ERROR`, and flags spans that do not.

Not instrumenting async work is the hardest mistake to detect automatically, because the goroutine that runs without a context simply produces no spans at all. The absence of spans for an operation that should produce spans is detectable only if you have a span coverage baseline: a manifest of every code path that should produce a span, verified in integration tests. Platform teams that invest in this baseline catch goroutine context bugs before they reach production. Teams that do not invest in it discover the missing spans during incidents, when the gap in the trace waterfall is the only hint that a goroutine ran context-free.

---
