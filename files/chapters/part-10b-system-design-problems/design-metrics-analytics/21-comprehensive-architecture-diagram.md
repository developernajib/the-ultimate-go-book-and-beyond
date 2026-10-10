## Comprehensive Architecture Diagram

The following diagram shows how the five major layers of the metrics system connect: the agent tier (running on every host), the ingestion tier (Kafka + Flink), the storage tier (ClickHouse for time-series, PostgreSQL for metadata), the query tier (the metrics API), and the alerting tier (the alert engine and notification router). Data flows left-to-right from agents through ingest into storage, while queries and alerts flow back out to operators. Understanding this layered architecture is the foundation for answering scale and failure-mode questions in a system design interview.

```
┌────────────────────────────────────────────────────────────────┐
│                      Agents (100K hosts)                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  MetricsAgent (per host)                                 │  │
│  │  - System metrics (CPU, memory, disk, network)           │  │
│  │  - Application metrics (request rate, latency, errors)   │  │
│  │  - Custom metrics (business KPIs)                        │  │
│  │  - Pre-aggregation: 1s collection, 10s flush             │  │
│  │  - Disk buffer for network partitions                    │  │
│  └────────────────────────────┬─────────────────────────────┘  │
└───────────────────────────────┼────────────────────────────────┘
                                │ HTTP/UDP (batched, compressed)
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                   Ingest Layer (20 servers)                    │
│  - Validation (tag count, name length, cardinality check)      │
│  - Publish to Kafka (partition by metric name hash)            │
│  - 1M metrics/sec aggregate throughput                         │
└───────────────────────────────┬────────────────────────────────┘
                                │
           ┌────────────────────▼────────────────────┐
           │         Kafka (256 partitions)          │
           │         - metrics-raw topic             │
           │         - 24-hour retention             │
           └───┬────────────────┬────────────────┬───┘
               │                │                │
       ┌───────▼───────┐ ┌──────▼──────┐ ┌───────▼───────┐
       │    Stream     │ │    TSDB     │ │     Alert     │
       │  Aggregator   │ │   Writer    │ │   Evaluator   │
       │    (Flink)    │ │             │ │               │
       │  1m windows   │ │             │ │ 10K rules/min │
       │  avg/min/max  │ │             │ │               │
       │  count        │ │             │ │               │
       └───────┬───────┘ └──────┬──────┘ └───────┬───────┘
               │                │                │
               ▼                ▼                ▼
       ┌───────────────────────────────┐ ┌───────────────┐
       │          ClickHouse           │ │     Redis     │
       │  ┌──────────┐  ┌───────────┐  │ │  - Alert      │
       │  │ Raw (7d) │  │1min (1y)  │  │ │    state      │
       │  │ 10s res  │  │aggregated │  │ │  - Query      │
       │  └──────────┘  └───────────┘  │ │    cache      │
       └───────────────┬───────────────┘ └───────┬───────┘
                       │                         │
                       │                         ▼
                       │                 ┌───────────────┐
                       │                 │ Notification  │
                       │                 │ - PagerDuty   │
                       │                 │ - Slack       │
                       │                 │ - Email       │
                       │                 └───────────────┘
                       ▼
              ┌─────────────────┐
              │  Query Service  │
              │  - Auto tier    │
              │    selection    │
              │  - Result cache │
              │  - Dashboard    │
              │    parallel exec│
              └─────────────────┘
```

---
