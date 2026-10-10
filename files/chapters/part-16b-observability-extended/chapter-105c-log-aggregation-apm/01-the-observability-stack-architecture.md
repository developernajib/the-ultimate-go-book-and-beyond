## 105C.1 The Observability Stack Architecture

A production observability stack unifies the three pillars (logs, metrics, and traces) through a shared correlation ID that is injected at the request entry point and propagated across every service boundary. Go applications emit structured logs via `slog` or `zerolog`, expose Prometheus-format metrics on `/metrics`, and export OpenTelemetry spans to a collector that fans out to the appropriate backend. The separation between collection (Fluent Bit, OTel Collector) and storage (Elasticsearch, Prometheus, Jaeger) keeps ingestion pipelines decoupled from query engines, allowing each tier to scale independently.

```
┌───────────────────────────────────────────────────────────────────────┐
│                   OBSERVABILITY PIPELINE                              │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Application                 Collection        Storage & Analysis     │
│  ───────────                 ──────────        ──────────────────     │
│  ┌──────────┐  structured    ┌─────────┐       ┌──────────────────┐   │
│  │  Go App  │─── logs ──────>│ Fluent  │──────>│ Elasticsearch /  │   │
│  │  (slog/  │                │  Bit    │       │ OpenSearch       │   │
│  │  zerolog)│─── metrics ───>│         │       └──────────────────┘   │
│  │          │                └─────────┘       ┌──────────────────┐   │
│  │          │─── traces ────>┌─────────┐       │ Prometheus +     │   │
│  └──────────┘                │ OTel    │──────>│ Grafana          │   │
│                              │Collector│       └──────────────────┘   │
│                              └─────────┘       ┌──────────────────┐   │
│                                                 │ Jaeger / Tempo   │  │
│                                                 │ (traces)         │  │
│                                                 └──────────────────┘  │
│                                                                       │
│  Correlation ID threads through all three pillars                     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: The Three-Pillar Architecture Is an Investigation Workflow

The diagram above is not just an architecture diagram: it describes an investigation workflow. When an alert fires, the investigation always starts with metrics (which service, which endpoint, what rate). It narrows with traces (which specific requests failed, at which span). It concludes with logs (what exactly happened, what was the error message, what was the request payload).

Understanding this workflow before an incident is what makes you effective under pressure. Practice it in a staging environment: create a deliberate error, find it first in Prometheus, then in Jaeger, then in Loki or Elasticsearch. Time yourself. The goal is to complete the full investigation without hesitation about which tool to use next.

### Senior @ FAANG: Observability Stack as a Product, Not a Collection of Tools

At L6, the observability stack is owned as a coherent product, not a collection of independently managed tools. This means: the platform team defines the standard data formats (log schema, required span attributes, metric naming conventions), ensures correlation IDs flow consistently across all three pillars, and provides a developer experience that makes correct instrumentation easier than incorrect instrumentation.

The signal that the stack is working as a product is when an on-call engineer can investigate any incident using only the standard dashboards and query tools, without needing to SSH into a server or ask the service's author for help. That standard is the design target, and it requires intentional investment in the developer experience layer (shared libraries, query templates, runbook integration) above the raw tooling.

---
