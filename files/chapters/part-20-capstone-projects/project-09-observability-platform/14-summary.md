## Summary

This capstone project demonstrates a production-ready observability platform with:

- **Multi-protocol ingestion** supporting OTLP, Prometheus, StatsD, and logs
- **Efficient storage** using Prometheus TSDB and ClickHouse
- **Powerful querying** with PromQL and LogQL support
- **Alerting** with rule evaluation and multi-channel notifications
- **Production features** including multi-tenancy, authentication, and high availability

Key takeaways:
1. Design for high throughput and low latency
2. Use appropriate storage backends for different data types
3. Implement back-pressure and flow control
4. Build thorough monitoring for the platform itself
5. Plan for operational concerns from day one

---

## FAANG Interview Questions

**Q: How would you design a metrics system ingesting 1B data points per second?**

A: Shard by metric name hash across 1000 ingester nodes. Each ingester batches writes into 10-second chunks and flushes to a time-series database (Prometheus remote write to Thanos, or Cortex/Mimir). Use delta-of-delta and Gorilla compression for 10x storage reduction. For long-term retention, downsample to 1-minute and 1-hour resolutions via background compactors. Queries fan out to relevant shards with a query frontend that caches results. Budget p99 query latency under 1 second for last-hour queries.

**Q: What is the difference between metrics, logs, and traces?**

A: Metrics are numeric aggregates (counter, gauge, histogram) with labels, indexed by time. Cheap to ingest (pre-aggregated), good for alerting and dashboards, lose per-event detail. Logs are discrete events with unstructured or semi-structured text. Expensive to store and search, best for debugging specific incidents. Traces link events across service boundaries via a trace ID, showing a request's full path. Combine all three: alert on metrics, pivot to traces for latency anomalies, grep logs for root cause. OpenTelemetry is the emerging unified standard.

**Q: How would you implement distributed tracing with minimal overhead?**

A: Head-based sampling at 1% by default. Each request gets a trace ID at the edge, propagated via W3C Trace Context headers. Each span records start time, duration, attributes, and parent span ID, batched to a collector (OTel Collector) that forwards to Jaeger or Tempo. Use tail-based sampling for errors: capture 100% of traces where any span errored or latency exceeded p99. Storage: object storage (S3) with a secondary index by trace ID. Avoid sampling by operation alone, it biases your traces.

**Q: How do you design an alerting pipeline that minimizes false positives?**

A: Four techniques. (1) Multi-window, multi-burn-rate alerts from the Google SRE book: alert on a 1-hour burn rate above 14.4x OR a 5-minute burn rate above 36x, reducing both noise and time-to-detect. (2) Deduplicate by fingerprint in Alertmanager, group related alerts into a single notification. (3) Require the condition to hold for a minimum duration (for 5m) to filter transients. (4) Use anomaly detection (Prophet, Gaussian Processes) for metrics with seasonality, not static thresholds. Review alert precision weekly and delete or tune alerts with over 50% false positive rate.

**Q: How would you build a log aggregation system across 10K servers?**

A: Fluentbit or Vector agents on each host ship logs to a Kafka cluster, partitioned by service name. Consumers parse and index to Elasticsearch (hot tier, 7 days) and archive raw logs to S3 (cold tier, 90 days). Use structured logging (JSON with standard fields: timestamp, level, service, trace_id) so you can filter efficiently. Enforce sampling for high-volume services, 10% of INFO, 100% of WARN and above. Compress at the agent (zstd). For search, Elasticsearch with ILM (hot-warm-cold) and frozen tier for queries over archived data.

### Junior → FAANG: Bridging Observability Fundamentals to Interview Readiness

Junior engineers often view observability as merely adding log statements or calling Prometheus client counters. In FAANG+ system design interviews, the evaluation focuses on data plane efficiency, cross-signal correlation, and cardinality management. Understand how context propagation works: how a single W3C `traceparent` header flows across HTTP and gRPC boundaries, allowing an engineer to pivot directly from an anomalous spike in a Grafana dashboard to the exact distributed trace and associated structured log lines.

A critical junior-to-senior transition is understanding cardinality explosion. In technical discussions, explain why high-cardinality attributes (such as user IDs or order UUIDs) must never be added as Prometheus metric labels (which inflate TSDB index memory geometrically), but instead belong in distributed trace spans or columnar log stores like ClickHouse.

### Senior @ FAANG: Governing Observability Platforms at Scale

At staff and principal levels, observability platform engineering is a discipline of cost governance, data lifecycle management, and automated reliability engineering. Key responsibilities include:

1. **Cost & Cardinality Governance**: Enforcing metric cardinality budgets per engineering team. Implementing automated dropping or rollup of unauthorized high-cardinality labels at the ingestion gateway before they reach TSDB storage.
2. **Tiered Storage Architecture**: Designing multi-tiered storage pipelines (e.g., in-memory ingester ring buffers -> local SSD write-ahead logs -> remote columnar blocks in S3/GCS via Thanos or Mimir) that maintain sub-second P95 query latencies while cutting storage expenditure by 70%.
3. **Adaptive Sampling**: Managing tail-based trace sampling proxies that evaluate full distributed trace graphs after completion, retaining 100% of 5xx errors and outlier P99 latency requests while aggressively downsampling repetitive health check spans.
4. **SLO Engineering & Automated Remediation**: Translating service level indicators (SLIs) into multi-window multi-burn-rate alerting policies, and integrating telemetry triggers directly into automated canary analysis pipelines (e.g., Flagger, Argo Rollouts) to roll back degrading deployments before users notice.

---

## Navigation & Cross-References

| [Project 8: Kubernetes Controller](../project-08-kubernetes-controller/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Project 10: API Gateway](../project-10-api-gateway/00-introduction.md) |
| :--- | :---: | ---: |
| ◀ Previous Project | Table of Contents | Next Project ▶ |

