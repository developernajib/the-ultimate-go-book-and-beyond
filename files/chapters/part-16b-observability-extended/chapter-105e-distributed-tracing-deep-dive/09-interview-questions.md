## 105E.9 Interview Questions

**Q: How does distributed tracing differ from centralized logging?**

**What FAANG expects:** Traces = request-scoped span trees with causal timing. Logs = discrete events. Traces tell you *how long* and *what called what*. Logs tell you *what happened*. They complement via trace_id correlation. Bonus for citing Dapper (Google 2010) as the original paper and naming Tempo, Jaeger, or vendor SaaS (Honeycomb, Lightstep/ServiceNow, Datadog APM) as the storage backends.

A: Logging records discrete events with context. Tracing records the journey of a request across service boundaries as a tree of spans with timing. A trace shows you *how long each part took* and *the causal relationship between operations*. Logs tell you *what happened*. The key advantage of tracing is identifying which specific service call in a chain of 10 microservices is causing latency, something nearly impossible to determine from logs alone. In practice, they complement each other. Trace IDs in logs allow you to find all log entries for a specific request.

**Q: What is the difference between head-based and tail-based sampling?**

A: Head-based sampling decides whether to sample a trace at the start (when the first span is created), before knowing what will happen in the trace. It's simple and low-overhead but may miss important traces (errors, slow requests). Tail-based sampling waits until the trace is complete to make the sampling decision, allowing policies like "always sample if there's an error" or "always sample if duration > 1s". Tail-based sampling requires buffering complete traces before the decision, adding latency and memory overhead but providing much better control over what's captured.

**Q: What is baggage in the W3C context propagation standard and when would you use it?**

**What FAANG expects:** Key-value pairs propagated via `baggage` header alongside `traceparent`. Available to all downstream services. Use for tenant_id, experiment group, feature-flag context. Do NOT use for large payloads (every request carries it) or secrets (often logged). Bonus for knowing that OTel baggage is a distinct concept from span attributes, and for recognizing that some gateways strip unknown headers so baggage can be silently lost at trust boundaries.

A: Baggage is key-value pairs that propagate along with trace context across service boundaries via HTTP headers. Unlike span attributes (which are only visible in the span they're added to), baggage is available to all downstream services. Common use cases include multi-tenant systems where tenant ID needs to be available for routing decisions, A/B testing where the experiment group needs to follow the request through all services, and feature flags where the enabled feature set should be visible everywhere. Avoid putting large or sensitive data in baggage as it's transmitted with every request.

**Q: (Google) A trace shows a 2-second span that contains no child spans. How do you determine whether the time was spent in application code, a downstream call, or GC?**

A: Add events to the span at entry and exit of the suspected code regions using `span.AddEvent("parsing-start")` and measure the delta from the trace, which narrows the location without adding full child spans. Attach `go.memstats.pause_total_ns` or use the runtime trace (`runtime/trace`) correlated by trace ID to detect GC pauses in the window. If the gap persists after instrumenting code regions, the time is in a downstream call that is not instrumented. Add context-propagating HTTP/gRPC client instrumentation (`otelhttp.NewTransport`) so the downstream call becomes a child span. Continuous profiling (Pyroscope) labeled with the trace ID gives the definitive CPU or off-CPU breakdown for that specific request.

**Q: (Uber) How would you design tail-based sampling for a system processing 1M spans per second across 500 services to retain 100% of error traces and stay within a 10% storage budget?**

A: Deploy a two-tier Collector topology. Tier 1 agents run per-node with a `load_balancing` exporter keyed on trace ID, forwarding to Tier 2 sampling Collectors so all spans for one trace arrive on the same instance. Tier 2 runs `tail_sampling` with policies ordered `status_code=ERROR` (100%), `latency > p99` (100%), `probabilistic 7%` (remainder). Set `decision_wait` to 2x the observed p99 trace duration so late spans are not dropped. Size each Tier 2 Collector at `spans/sec × decision_wait × avg_span_size × 1.5` for headroom. Monitor `otelcol_processor_tail_sampling_sampling_trace_dropped_too_early` as the scaling signal. Export kept traces to Tempo with object-storage backend to keep cost predictable at high volume.

### Junior → FAANG: Mapping Question Types to Preparation Depth

The four questions above represent three tiers of interview depth. The first two (tracing vs. logging, head vs. tail sampling) are foundational knowledge questions. Any candidate who has read the chapter can answer them. These questions test whether you understand the concepts, not whether you have operated the system.

The baggage question is mid-tier. The correct answer requires knowing that baggage is a distinct propagation mechanism from span attributes, that it carries overhead on every hop, and that it can be silently lost at trust boundaries like API gateways that strip unknown headers. This is the kind of nuance that separates someone who read the docs from someone who debugged a baggage-loss incident.

The two company-specific questions (Google, Uber) are system design questions where the candidate must reason through trade-offs under constraints. For these, practice narrating your reasoning aloud before giving the answer: state the constraint, name the trade-off, choose the approach, explain the rejection of alternatives.

### Senior @ FAANG: Bar-Raiser Signals in Distributed Tracing Interviews

A bar-raiser at L6 looks for three signals that go beyond correct answers to the questions above.

The first signal is governance awareness. When asked about tail-based sampling, does the candidate mention the ADR, the cost model, and the review cadence, or do they only describe the technical configuration? An L5 answer describes how to configure the OTel Collector's tail sampling processor. An L6 answer describes how to govern the sampling policy across an organization of 500 services, including who owns the policy, how exceptions are handled, and what metrics determine when the policy needs revision.

The second signal is failure mode reasoning. For the Google span-gap question, does the candidate enumerate the failure modes in order (instrumentation gap, GC pause, uninstrumented downstream, off-CPU blocking) and explain how to distinguish between them? An L5 candidate names the tools (pprof, Pyroscope, runtime/trace). An L6 candidate explains the reasoning chain that maps each symptom to the correct tool without guessing.

The third signal is organizational impact quantification. The Uber question asks for a design. An L6 candidate completes the design and then adds: "At these Collector sizing numbers, the memory cost is X GB per Tier 2 instance, and the network cost is Y MB/s per Tier 1 agent. At 500 services, the fully loaded infrastructure cost for this sampling tier is approximately Z USD/month, which is justified by the storage savings of retaining 10% instead of 100% of traces." Quantifying cost alongside the technical design is the staff-level skill that the bar-raiser is looking for.

---
