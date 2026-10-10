## Learning Objectives

By the end of this chapter, you will be able to:

1. **Implement structured logging** - Use slog, zap, and zerolog for production logging
2. **Design log aggregation** - Set up centralized logging with ELK, Loki, or similar
3. **Define meaningful metrics** - Create counters, gauges, histograms, and summaries
4. **Implement distributed tracing** - Use OpenTelemetry for cross-service tracing
5. **Correlate requests** - Propagate request IDs across service boundaries
6. **Set up alerting** - Define SLOs, SLIs, and alerting rules
7. **Build health checks** - Implement liveness and readiness probes
8. **Create dashboards** - Design Grafana dashboards for key metrics
9. **Debug production issues** - Use observability data to diagnose problems
10. **Build a complete observability stack** - Integrate logs, metrics, and traces

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    THE THREE PILLARS OF OBSERVABILITY                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                  │
│  │     LOGS        │  │    METRICS      │  │    TRACES       │                  │
│  │                 │  │                 │  │                 │                  │
│  │  What happened  │  │  How much/many  │  │  How things     │                  │
│  │  at a point     │  │  over time      │  │  are connected  │                  │
│  │  in time        │  │                 │  │                 │                  │
│  │                 │  │                 │  │                 │                  │
│  │  • Events       │  │  • Counters     │  │  • Spans        │                  │
│  │  • Errors       │  │  • Gauges       │  │  • Context      │                  │
│  │  • Debug info   │  │  • Histograms   │  │  • Timing       │                  │
│  │  • Audit trail  │  │  • Summaries    │  │  • Dependencies │                  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘                  │
│           │                    │                    │                           │
│           └────────────────────┼────────────────────┘                           │
│                                ▼                                                │
│                    ┌─────────────────────┐                                      │
│                    │    CORRELATION      │                                      │
│                    │    Request ID       │                                      │
│                    │    Trace ID         │                                      │
│                    │    Span ID          │                                      │
│                    └─────────────────────┘                                      │
│                                                                                 │
│  WHEN TO USE EACH:                                                              │
│  ├── Logs: "Why did this specific request fail?"                                │
│  ├── Metrics: "How many requests are failing per second?"                       │
│  └── Traces: "Which service in the chain is slow?"                              │
│                                                                                 │
│  CARDINALITY RULES:                                                             │
│  ├── Logs: High cardinality OK (per-request data)                               │
│  ├── Metrics: Low cardinality required (< 1000 unique label combinations)       │
│  └── Traces: Sample in production (0.1-10% of requests)                         │
└─────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY DATA FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────┐                                                               │
│  │ Application  │                                                               │
│  │              │──┐                                                            │
│  │  • slog      │  │  Logs     ┌──────────────┐   ┌──────────────┐              │
│  │  • zap       │  ├─────────►│ Log Shipper  │──►│ Elasticsearch│               │
│  │  • zerolog   │  │           │ (Filebeat)   │   │ / Loki       │              │
│  │              │  │           └──────────────┘   └───────┬──────┘              │
│  │  • Prometheus│  │  Metrics  ┌──────────────┐          │                      │
│  │    client    │  ├─────────►│ Prometheus   │──────┐    │                      │
│  │              │  │           │ Server       │      │    │                     │
│  │  • OpenTelem │  │           └──────────────┘      │    │                     │
│  │    SDK       │  │  Traces   ┌──────────────┐      │    │                     │
│  │              │  └─────────►│ Jaeger /     │──────┤    │                      │
│  └──────────────┘              │ Tempo        │      │    │                     │
│                                └──────────────┘      │    │                     │
│                                                      ▼    ▼                     │
│                                              ┌──────────────────┐               │
│                                              │     Grafana      │               │
│                                              │  Unified View    │               │
│                                              └────────┬─────────┘               │
│                                                       │                         │
│                                              ┌────────▼─────────┐               │
│                                              │   Alertmanager   │               │
│                                              │   PagerDuty      │               │
│                                              │   Slack          │               │
│                                              └──────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Outcomes

**Mid-level engineer**

- Use `log/slog` for every log, never `fmt.Println`, in production code.
- Expose Prometheus metrics for request rate, errors, latency (RED method).
- Propagate trace context through middleware.
- Add request IDs to every log line.

**Senior engineer**

- Instrument services with OpenTelemetry for traces and metrics.
- Design SLOs and SLI-based alerts that page on user-facing symptoms.
- Review dashboards for clarity and prune noisy metrics.

**Staff or Principal**

- Own the org's observability infrastructure: standard libraries, conventions, vendor selection.
- Drive consistent instrumentation across services.
- Treat observability as a product: measure incident diagnosis time, and invest when it trends wrong.

---
