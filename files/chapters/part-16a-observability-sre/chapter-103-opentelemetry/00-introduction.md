# Chapter 103: OpenTelemetry Complete Guide

> *"You can't manage what you can't measure, and in distributed systems, you can't measure what you can't instrument."*

Modern software is no longer a monolith running on a single server. Today's production systems are constellations of microservices, serverless functions, message queues, and managed databases, each processing requests that flow across dozens of boundaries before a user sees a response. When something goes wrong (and it will), engineers need answers fast: which service introduced the latency spike? Where did that error originate? Which downstream dependency is degrading? Without consistent, vendor-neutral instrumentation woven throughout every component, answering these questions means hours of log archaeology, frantic Slack threads, and guesswork under pressure.

OpenTelemetry (OTel) is the CNCF's answer to this problem. It defines a single, open standard for the three pillars of observability (traces, metrics, and logs) and provides SDKs for virtually every major language, including a mature and actively maintained Go SDK. By adopting OpenTelemetry, teams break free from vendor lock-in: the same instrumentation code exports data to Jaeger, Grafana Tempo, Datadog, Honeycomb, or any OTLP-compatible backend by changing a single configuration line. The OpenTelemetry Collector acts as a vendor-agnostic pipeline that receives, processes, filters, and routes telemetry data at scale, giving platform teams full control over data flow without touching application code.

For Go services specifically, OpenTelemetry integrates naturally with the language's context propagation model. Spans attach to `context.Context` and flow automatically through goroutines and HTTP clients when you use the provided middleware and transport wrappers. Auto-instrumentation libraries cover gRPC, HTTP, database drivers, Redis, Kafka, and more, so rich traces require minimal manual effort. In this chapter you will move from OTel concepts to production-grade implementation: initializing providers, creating spans, recording metrics, correlating logs with trace IDs, and deploying a Collector pipeline that ships data to Jaeger and Grafana.

**What you'll learn in this chapter:**
- The OpenTelemetry data model: traces, spans, metrics instruments, log records, and the resource concept
- Bootstrapping the Go OTel SDK with TracerProvider, MeterProvider, and LoggerProvider
- Manual and automatic instrumentation for HTTP servers, gRPC services, and database clients
- Context propagation across service boundaries using W3C TraceContext and Baggage headers
- Configuring OTLP exporters (gRPC and HTTP) to send data to the OTel Collector
- Building a Collector pipeline with receivers, processors (batch, filter, attribute), and exporters
- Tail-based and head-based sampling strategies to control cost without losing signal
- Correlating structured logs with active trace and span IDs for unified debugging

**Why this matters at scale:**
Companies operating thousands of microservices depend on standardized tracing to follow a single request across encoding, CDN, payment, and licensing boundaries, turning incident diagnosis from log archaeology into a targeted query. Shopify has spoken publicly about adopting OpenTelemetry to unify observability across its Ruby and Go services. Uber, which created Jaeger and M3, processes billions of spans per day, and Jaeger's v2 architecture is now built directly on the OpenTelemetry Collector framework, a measure of how thoroughly OTel has become the industry substrate. At any company running more than a handful of services, standardized telemetry is not a nice-to-have: it is the foundation on which SRE and on-call workflows are built.

**Prerequisites:** Chapters 100-101 (observability fundamentals and metrics basics), familiarity with Go's `context` package, and a working Docker environment for running the OTel Collector, Jaeger, and Grafana locally.

### Junior → FAANG: Why OpenTelemetry Is the Baseline, Not the Bonus

Most engineers encounter observability as an afterthought: add some `log.Println` calls, wire up a basic `/metrics` endpoint, and call it done. FAANG interviews expose that gap immediately. Interviewers expect you to understand why vendor-neutral instrumentation matters, what the three pillars are and how they relate, and how context propagation actually works across service boundaries.

Start by understanding the problem OTel solves. Before it existed, every backend (Datadog, Jaeger, Zipkin) required its own SDK. Switching tools meant rewriting instrumentation across every service. OTel decouples instrumentation from the backend, so you instrument once and route data anywhere via the Collector. That architectural separation is what makes it a platform-level standard, not just a library choice.

For a first job, focus on three habits: always propagate `context.Context` through every function call (do not drop it), add span attributes that would help a future on-call engineer diagnose a problem, and treat telemetry code as production code subject to review. Engineers who skip those habits generate noisy, unactionable traces that nobody trusts.

Common interview entry point: "Explain the difference between a trace and a metric and when you would use each." A trace answers "what happened to this specific request." A metric answers "what is the aggregate behavior of many requests over time." Both are necessary. Neither replaces the other.

### Senior @ FAANG: Governing OpenTelemetry as Platform Infrastructure

At senior and staff level, the question is not "how do I add a span" but "how do we make instrumentation consistent, cost-controlled, and operationally safe across hundreds of services owned by dozens of teams."

**Architecture Decision Record framing.** When proposing OTel adoption, the ADR must address: SDK version pinning strategy across a monorepo versus polyrepo, Collector deployment topology (sidecar vs. per-node DaemonSet vs. centralized gateway), sampling policy ownership (who sets tail-based sampling rules and how are they changed without redeploying services), and data residency requirements that affect which exporters are permissible.

**Platform thinking: the Collector as a control plane.** A naive OTel deployment has every service exporting directly to a backend. A platform deployment routes everything through a tiered Collector fleet. The first tier (per-node or sidecar) handles buffering, retries, and head-based sampling. The second tier (regional gateway) handles tail-based sampling, PII scrubbing via attribute processors, and fan-out to multiple backends. This topology means no service ever needs a code change when a backend is swapped or when a new compliance requirement arrives, because the Collector pipeline handles the transformation.

**Maturity model signals.** An L5 (senior) engineer ships working OTel instrumentation. An L6 engineer defines the instrumentation standards document that all teams follow: mandatory span attributes (service.name, service.version, deployment.environment), cardinality budgets for metric label sets, required health-check and readiness endpoints, and the Collector processor chain every team must pass through. An L7 (staff) engineer owns the observability platform roadmap, negotiates sampling budgets with finance, and sets the bar for what "production-ready" means org-wide.

**Bar-raiser interview signals.** When interviewing L5 and above, a bar-raiser looks for: Can the candidate reason about cardinality explosions from unbounded span attributes? Do they understand the performance cost of synchronous exporters on the hot path? Can they explain why head-based sampling loses rare events and why tail-based sampling requires stateful infrastructure? Do they know how to propagate baggage for feature-flag context without leaking PII? These are the signals that separate engineers who have used OTel from engineers who can own it.

**Cost and governance.** At scale, telemetry data is a significant cost center. A senior engineer designs sampling strategies that preserve SLO-relevant signal (errors, high-latency outliers) while aggressively discarding healthy, low-value traces. This requires instrumenting the Collector itself to expose `otelcol_processor_dropped_spans` and `otelcol_exporter_sent_metric_points` metrics so the platform team can detect policy drift before it appears on the cloud bill.

---
