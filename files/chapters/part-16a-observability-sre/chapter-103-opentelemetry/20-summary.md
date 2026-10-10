## Summary

- **Three pillars of observability**: Traces, metrics, and logs are the three signal types, and OpenTelemetry provides a unified SDK and wire format for all three, replacing fragmented vendor agents.
- **Tracer provider initialization**: Configure the tracer provider once at startup with a resource (service name, version, environment) and an OTLP exporter pointing at the Collector or backend.
- **Context propagation**: Pass `context.Context` through every function call. Use W3C Trace Context headers to propagate trace/span IDs across HTTP and gRPC service boundaries.
- **Auto-instrumentation libraries**: Use `otelhttp` for HTTP servers/clients and `otelgrpc` for gRPC: they create spans, extract/inject headers, and record errors automatically.
- **Custom spans**: Wrap significant business operations (database queries, external calls, complex computations) in child spans with meaningful attributes to make traces actionable.
- **Metrics API**: Define counters, histograms, and gauges via the OTel Metrics SDK, export to Prometheus or OTLP, and use consistent naming (system, service, method) for discoverability.
- **Sampling strategies**: Use head-based probabilistic sampling for high-volume services and tail-based sampling in the Collector for capturing 100% of error or slow traces selectively.
- **Log-trace correlation**: Inject `trace_id` and `span_id` into structured log fields so log queries can jump directly to the corresponding distributed trace.
- **OpenTelemetry Collector**: Deploy the Collector as a sidecar or DaemonSet to buffer, batch, filter, and fan-out telemetry to multiple backends without changing application code.
- **Semantic conventions**: Follow OTel semantic conventions for attribute names (e.g., `http.request.method`, `db.system`) to ensure dashboards and alerts work across services and teams.

### Junior → FAANG: Your OTel Checklist Before an Interview

Use this summary as a self-assessment before an observability interview. Can you explain each bullet point without notes? Can you write the initialization sequence from memory? Can you describe what happens if context propagation is missing? Can you name three semantic convention attributes for an HTTP span and three for a database span?

If any bullet point is unclear, go back to the corresponding section, run the code examples locally, and verify the behavior in Jaeger or Prometheus.

### Senior @ FAANG: Summary as a Governance Baseline

Each bullet point in this summary corresponds to a governance requirement at the platform level. "Tracer provider initialization" maps to: the shared `go-observability` library initializes the provider correctly, with a resource that includes the required attributes, and no service is permitted to initialize its own provider with non-standard settings. "Sampling strategies" maps to: the tail-sampling policy is documented in an ADR, reviewed quarterly, and enforced by the Collector configuration with no per-service overrides.

The summary is the contract between the platform team and service teams. Platform provides a library that makes these bullet points work by default. Service teams provide correct resource attributes and use the library's context-aware logger. Everything else is automated, governed, and invisible to service developers.

---

### Navigation

- **Previous Part**: [Part XV-C: Networking & Protocols Deep Dive](../../part-15c-networking-protocols/00-part-intro.md)
- **Previous Chapter**: [Chapter 102P - Real-Time Systems & WebRTC with Go](../../part-15c-networking-protocols/chapter-102p-realtime-webrtc/00-introduction.md)
- **Next Chapter**: [Chapter 104 - Prometheus & Grafana Mastery](../chapter-104-prometheus-grafana/00-introduction.md)

