# Chapter 105C: Log Aggregation & Application Performance Monitoring

> *"Logs are the only witness to events that happened in the past. Treat them accordingly."*

Logs have been the most fundamental observability primitive since the first program wrote output to a terminal. Yet in modern distributed systems, raw log files scattered across hundreds of pods are nearly useless without a pipeline that collects, enriches, indexes, and makes them searchable in seconds. The gap between `fmt.Println("request received")` and a production-grade logging strategy is enormous, and the consequences of getting it wrong range from debug sessions that take hours because logs lack context, to Elasticsearch clusters crippled by cardinality explosions from uncontrolled dynamic fields, to monthly logging bills that exceed compute costs.

Structured logging transforms logs from human-readable strings into machine-parseable JSON events that carry consistent fields: timestamp, severity, service name, trace ID, span ID, request ID, user ID, and the specific error or event data. Go's ecosystem has two excellent structured logging libraries: the lightning-fast `zerolog` for high-throughput services and the standard library's `log/slog` (introduced in Go 1.21) for codebases that prefer zero external dependencies. The critical discipline is connecting log records to distributed traces via trace and span IDs, enabling engineers to pivot instantly from a Grafana alert to the exact log lines emitted during the offending trace in Jaeger, without manually correlating timestamps across systems.

Application Performance Monitoring (APM) extends beyond logs to provide a complete view of application health: transaction traces, database query performance, external API latency, error rates with stack traces, and continuous profiling. Tools like the OpenTelemetry APM integration, Elastic APM, and Datadog APM instrument Go applications at the transport and runtime layers to capture this data automatically. Understanding how log aggregation and APM fit together, and how to build the pipeline that connects Fluent Bit to OpenSearch or Elasticsearch with proper index lifecycle management, enables teams to debug production incidents in minutes rather than hours.

**What you'll learn in this chapter:**
- Structured logging in Go with `zerolog` and `log/slog`: field conventions, context-aware loggers, and performance characteristics
- Building correlation ID middleware that propagates request IDs and trace IDs through the full call stack
- Log aggregation pipelines: Fluent Bit collection, parsing, enrichment, and forwarding to Elasticsearch/OpenSearch
- Index lifecycle management (ILM) for cost-effective log retention: hot, warm, cold, and frozen tiers
- APM integration with OpenTelemetry: automatic transaction capture, database span enrichment, and error reporting
- Log sampling strategies for high-volume services: head-based, tail-based, and error-priority sampling
- Error deduplication and grouping: fingerprinting techniques to avoid alert storms from repeated identical errors
- Building unified search dashboards in Kibana/Grafana that correlate logs, traces, and metrics for a single request

**Why this matters at scale:**
LinkedIn processes over 1 trillion log events per day through its Kafka-based log aggregation infrastructure, enabling near-real-time debugging of issues affecting over 1 billion members. Twitter (now X) relies on distributed log correlation to trace failures across its microservices architecture during high-traffic events like major announcements or live sports. Large e-commerce platforms have standardized structured logging across hundreds of microservices with a shared logging library, cutting mean time to resolve (MTTR) for production incidents dramatically because every service emits the same correlation fields. Without reliable log aggregation and APM, debugging distributed systems at scale becomes a stochastic exercise in intuition rather than evidence-based engineering.

**Prerequisites:** Chapters 103--106 (OpenTelemetry, Prometheus, SRE Practices, On-Call & Incident Management, and Cost-Aware Engineering), basic familiarity with Docker Compose for running an ELK or Grafana Loki stack locally, and Go 1.27.1 for idiomatic `log/slog` examples.

### Junior → FAANG: Why Logs, Traces, and Metrics Must Work Together

Many engineers treat logging, tracing, and metrics as independent concerns. In production, they are complementary: metrics tell you something is wrong (error rate spike), traces tell you where in the call graph it happened (span with error status in the payment service), and logs tell you what specifically happened (the error message and stack trace for the failing transaction). Without all three, you are missing one dimension of the investigation.

For a first job, the most important habit is log-trace correlation: every log line emitted within a request handler must include the `trace_id` and `span_id` from the active span context. This single practice reduces incident investigation time from "search logs for hours, then separately search traces" to "find the error in logs, click trace ID, see the full distributed trace."

### Senior @ FAANG: Log Aggregation as Platform Infrastructure

At L6, log aggregation is platform infrastructure with its own SLO. If logs are delayed by more than 5 minutes or lost during an Elasticsearch rolling restart, the on-call engineer's investigation capability is degraded during the window when it is most needed (immediately after an incident starts). An L6 engineer designs log aggregation with the same reliability requirements as the services it observes: redundant ingestion pipeline, buffering to handle backend slowdowns, and an availability SLO with its own alert.

**Backend selection and trade-offs.** Elasticsearch (ELK) is the most feature-rich choice for full-text log search and complex aggregations, but it is expensive to operate at scale (index management, shard sizing, rolling upgrades). Grafana Loki is optimized for low-cost log storage by indexing only labels (not full log content), making it ideal for high-volume services where full-text search is not required. Splunk provides enterprise features (compliance, auditing, DLP) at a premium cost. An L6 engineer evaluates these trade-offs against the organization's log volume, search requirements, retention policy, and budget.

---
