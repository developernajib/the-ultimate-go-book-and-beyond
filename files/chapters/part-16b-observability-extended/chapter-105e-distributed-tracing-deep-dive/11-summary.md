## Summary

Distributed tracing provides visibility into request flows across microservices:

- **OpenTelemetry SDK** is the standard for instrumentation: it's vendor-neutral and supports all major backends
- **Trace propagation** via W3C TraceContext headers ensures traces flow across HTTP, gRPC, and message queues
- **Tail-based sampling** solves the fundamental trade-off: capture all interesting traces (errors, slow requests) while sampling normal traffic
- **Critical path analysis** identifies bottlenecks by finding the longest path through a trace tree
- **N+1 query detection** catches common ORM anti-patterns before they reach production
- **Continuous profiling** with Pyroscope provides always-on CPU and memory profiling with flame graphs
- **Testing tracing** with `SpanRecorder` verifies instrumentation without depending on external systems

The key insight: instrumentation is a first-class concern, not an afterthought. Add spans at service boundaries, record errors, set appropriate span kinds, and propagate context through every async operation.

### Junior → FAANG: The Pre-Interview Checklist for Distributed Tracing

Before any observability-track FAANG interview, verify you can do the following without referencing documentation: set up an OTel TracerProvider with an OTLP exporter and ParentBased sampler from memory, write a middleware that extracts trace context from incoming HTTP headers and creates a server span, write a client wrapper that injects trace context into outgoing HTTP headers and creates a client span, and write a test using an in-memory span recorder that asserts on span name, status, and parent relationship. These four tasks cover the instrumentation knowledge that most FAANG interviewers test in a 45-minute coding session.

### Senior @ FAANG: The Organizational Maturity Model for Distributed Tracing

At L6, the summary bullet points above define not just deployed tooling but how far your organization has progressed on the tracing maturity model. Level 1: services emit spans with correct parent-child relationships. Level 2: all service boundaries are instrumented (HTTP, gRPC, database, cache, queue). Level 3: tail-based sampling is deployed with documented cost and retention SLOs. Level 4: tracing data drives automated regression detection, dependency map generation, and cost attribution. Level 5: trace-driven debugging is the default workflow for all on-call engineers, and tracing coverage is a launch requirement enforced by the production readiness review.

Most organizations are at level 2. The gap between level 2 and level 3 is the tail sampling infrastructure investment. The gap between level 3 and level 4 is the data engineering investment to query trace data at scale. The gap between level 4 and level 5 is the cultural investment in training and tooling that makes trace-driven debugging the path of least resistance. An L6 engineer who maps their organization's current level, identifies the most effective investment to reach the next level, and builds the case for that investment is operating at staff engineer scope.

---

## Navigation

- **Previous Chapter:** [Chapter 105D: Alerting & Metrics Engineering](../chapter-105d-alerting-metrics-engineering/10-summary.md)
- **Part Overview:** [Part XVI-B: Observability Extended](../00-part-intro.md)
- **Next Part:** [Part XVII-A: Security](../../part-17a-security/00-part-intro.md)
- **Next Chapter:** [Chapter 107: Application Security](../../part-17a-security/chapter-107-application-security/00-introduction.md)

