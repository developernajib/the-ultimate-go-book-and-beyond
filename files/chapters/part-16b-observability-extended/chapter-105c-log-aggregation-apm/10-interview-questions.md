## 105C.10 Interview Questions

**Q: What is the difference between structured logging and traditional printf-style logging?**

**What FAANG expects:** JSON/key-value vs freeform strings. Queryability is the key win. Go's `log/slog` is the standard in 2026 (stable since Go 1.21). Bonus for citing OpenTelemetry Log Data Model and for naming Grafana Loki (label-based, no full-text index = cheap) vs Elasticsearch (full-text, expensive at scale) as the two dominant aggregation stacks.

A: Structured logging records each log entry as a set of key-value pairs (emitted as JSON or similar format), making logs machine-parseable. Traditional printf-style logging produces freeform strings that are difficult to query and aggregate. With structured logging, you can efficiently filter by `service.name="payments" AND log.level="error" AND http.status_code=500` in Elasticsearch, whereas extracting that information from freeform strings requires fragile regex.

**Q: How do you control log costs in high-volume production systems?**

**What FAANG expects:** Five levers: sampling (keep all errors, downsample info/debug), log levels (no debug in prod), tiered storage (hot → warm → cold/S3 via ILM), drop-at-source filtering (health checks, chatty libs), and converting high-frequency events to metrics. Bonus for naming Vector or Fluent Bit as the preferred agents (both in Go/Rust, outperform Logstash) and for citing that Grafana Loki's label-based indexing cuts storage 10-100x vs Elasticsearch for the same volume.

A: Multiple strategies: (1) **Sampling**: emit only 1 in N debug/info logs while keeping all errors. (2) **Log levels**: don't emit debug logs in production unless dynamically enabled. (3) **ILM tiering**: move old logs from expensive hot storage to cheap cold storage or S3. (4) **Log filtering**: drop health check logs and high-frequency but low-value logs at the collection layer (Fluent Bit). (5) **Aggregation**: instead of logging every cache miss, track a counter and emit aggregate metrics.

**Q: What are the three pillars of observability and why is correlation between them important?**

A: The three pillars are **metrics** (numerical aggregations over time), **logs** (discrete events with details), and **traces** (request flows across services). Correlation via trace IDs and correlation IDs allows you to start with a Prometheus alert (metric anomaly), find the relevant log entries showing what happened, and then view the distributed trace to see which service and span caused the latency. Without correlation, you have three independent data sources that cannot be connected.

**Q: (Google) How would you design a logging pipeline for a service emitting 1M log lines per second without losing errors during backend outages?**

A: Use a local buffered agent (Fluent Bit or Vector) on each node with a persistent disk-backed queue. Apply sampling for `info`/`debug` at the source but keep 100% of `error` and `fatal`. Forward to a regional Kafka cluster as the durable fan-out layer, with Elasticsearch and S3 both consuming independently. Elasticsearch indexes the most recent 7 days for interactive search, S3 stores raw JSON for compliance and replay. If Elasticsearch is down, Kafka retains messages for the configured retention (typically 72 hours), and the indexer catches up on recovery. Health check logs are dropped at Fluent Bit, never reaching the network.

**Q: (Meta) A user reports intermittent 500 errors but your dashboards show healthy p99 latency and a low error rate. How do you find the root cause using observability data?**

A: Low aggregate error rate often hides high per-tenant or per-endpoint error rates. Query logs filtered by the user's ID or tenant ID over the complaint window. Pivot aggregate metrics by a high-cardinality but bounded label like `tenant_id` or `endpoint` to surface outliers hidden by averaging. Use the trace IDs from those error logs to pull full distributed traces and identify the failing span. If no errors are logged, check for latency outliers in the same window: a timeout that converts to a 500 at the gateway will not appear as an error in the upstream service. Always verify the client's clock and retry behavior before blaming the server.

### Junior → FAANG: These Questions Test Investigation Workflow, Not Tool Knowledge

The interview questions in this section test whether you know how to navigate between logs, metrics, and traces, not whether you know the specific PromQL or LogQL syntax. The answer to the "one user complains" question demonstrates this: the investigation workflow (aggregate metrics, per-tenant pivot, trace ID correlation, cross-service check) is more important than the specific query language.

Practice narrating investigation workflows out loud, without tools. "I would first check the aggregate error rate for the last hour. If it looks normal, I would filter by the user's ID in the log search to find error entries. I would then take the trace ID from those log entries and look up the trace in Jaeger to see which service and span failed." This narration is exactly what a FAANG interviewer wants to hear.

### Senior @ FAANG: Observability Design Questions in Staff Interviews

At L7 interview level, observability questions shift from "how do you investigate an incident" to "how do you design an observability system for 200 services." These design questions test platform thinking:

**Scalability decisions.** Which log backend for the expected volume? How is the Collector fleet sized and scaled? What is the retention policy and why? These decisions require quantitative reasoning (volume estimates, cost comparisons, capacity model).

**Governance decisions.** How do you enforce log schemas, metric naming, and span attributes across 200 teams? What is the process for reviewing new metrics? How do you prevent cardinality explosions? These decisions require organizational thinking (tooling, process, incentive design).

**Trade-off articulation.** What do you give up with Loki vs. Elasticsearch? What are the failure modes of the Collector architecture? What happens to observability during a Prometheus restart? The ability to articulate trade-offs demonstrates that you have operated these systems under production conditions, not just read about them.

---
