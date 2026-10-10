## 103.18 Core Concepts Recap

### OpenTelemetry Checklist

Instrumenting a Go service with OpenTelemetry involves a predictable sequence of decisions spanning SDK initialization, signal configuration, and backend connectivity. The checklist below covers every layer, from bootstrapping the tracer provider with a `resource.Resource` that identifies the service, through wrapping HTTP handlers with `otelhttp`, to deploying a Collector that batches and routes telemetry to your chosen backend. Skipping steps in setup (such as omitting W3C Trace Context propagators) silently breaks distributed trace correlation across service boundaries, so treating this as an ordered checklist rather than a menu of options prevents hard-to-diagnose gaps.

```
┌──────────────────────────────────────────────────────────────────┐
│              OPENTELEMETRY IMPLEMENTATION CHECKLIST              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SETUP:                                                          │
│  □ Initialize tracer provider with resource                      │
│  □ Configure appropriate sampler                                 │
│  □ Set up OTLP or other exporters                                │
│  □ Configure propagators (W3C Trace Context)                     │
│                                                                  │
│  TRACING:                                                        │
│  □ Instrument HTTP handlers (otelhttp)                           │
│  □ Instrument HTTP clients                                       │
│  □ Add custom spans for business logic                           │
│  □ Include relevant attributes                                   │
│  □ Record errors with span.RecordError()                         │
│                                                                  │
│  METRICS:                                                        │
│  □ Define counters, histograms, gauges                           │
│  □ Use appropriate bucket boundaries                             │
│  □ Add labels/attributes for dimensions                          │
│  □ Export to Prometheus or OTLP                                  │
│                                                                  │
│  LOGGING:                                                        │
│  □ Correlate logs with trace context                             │
│  □ Use structured logging (JSON)                                 │
│  □ Include trace_id and span_id                                  │
│                                                                  │
│  COLLECTOR:                                                      │
│  □ Deploy OpenTelemetry Collector                                │
│  □ Configure processors (batching, filtering)                    │
│  □ Set up exporters for backends                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Use context propagation**: pass context through all functions
2. **Sample wisely**: not all traces need to be collected in production
3. **Add meaningful attributes**: include business context in spans
4. **Correlate signals**: link traces, metrics, and logs
5. **Use the Collector**: centralize processing and export

### Junior → FAANG: What to Take Away from This Chapter

The five key skills this chapter builds are: initializing the OTel SDK correctly, propagating context without dropping it, adding spans with meaningful attributes, correlating logs to traces, and deploying a Collector pipeline. If you can do all five in a local environment and explain each decision to an interviewer, you are ready for entry-level SRE and platform engineering roles.

The most important mental model shift: observability is not a feature you add after the service works. It is part of the service. A service without traces, metrics, and correlated logs is not production-ready, regardless of how well the business logic works.

### Senior @ FAANG: Chapter Summary as a Maturity Assessment

This chapter covers the instrumentation layer of the observability maturity model. At L5, a senior engineer can implement everything in this chapter for a new service. At L6, they can define the standards that make all of it consistent across hundreds of services. At L7 (staff), they own the observability platform roadmap, set the sampling budget with finance, and ensure that observability quality is a first-class engineering metric tracked in leadership reviews.

The governance concerns introduced here (cardinality budgets, attribute naming standards, Collector topology, PII scrubbing, sampling policy ADRs) are the distinguishing competencies between engineers who can use OTel and engineers who can own it at org scale. The next chapter applies the same discipline to Prometheus and Grafana, where the governance concerns shift to metric lifecycle management, PromQL query standards, and dashboard-as-code practices.

---

**Next Chapter: Prometheus & Grafana** covers metrics collection, alerting rules, PromQL queries, and dashboard creation.
