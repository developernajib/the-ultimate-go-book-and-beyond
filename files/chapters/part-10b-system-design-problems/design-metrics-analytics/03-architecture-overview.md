## Architecture Overview

This diagram shows the end-to-end data flow from host-level agents all the way to dashboards and alerting. The key insight is that raw metrics never go directly to the database. Instead, they pass through Kafka for buffering and a stream processor for pre-aggregation, which collapses six 10-second points into one 1-minute rollup row and cuts long-term write volume roughly 6x. This separation of concerns means each layer can scale independently: you can add more ingest servers without touching the database, or add more query servers without affecting ingestion.

```
Agents (host-level)
   │  UDP/TCP batched metrics
   ▼
┌──────────────────────────────────────────┐
│         Ingest Service                   │
│  (Kafka for buffering, 1M metrics/sec)   │
└──────────────┬───────────────────────────┘
               │
    ┌──────────┴─────────────────────┐
    ▼                                ▼
Stream Processor               Time-Series DB
(Flink: aggregate, downsample)  (ClickHouse / InfluxDB)
    │                                │
    ▼                                ▼
Alert Engine                   Query Service
(threshold evaluation)         (dashboard queries)
    │
    ▼
Notification Service
(PagerDuty, Slack, email)
```

---
