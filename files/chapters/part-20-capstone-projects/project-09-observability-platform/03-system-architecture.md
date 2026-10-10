## System Architecture

The observability platform is split into ingestion, storage, query, and alerting layers. Each layer runs as a separate service with well-defined gRPC interfaces, allowing independent scaling and deployment.
`
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OBSERVABILITY PLATFORM                              │
├─────────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ┌──────────────┐                                                           │
│  │ Applications │                                                           │
│  └──────┬───────┘                                                           │
│         │                                                                   │
│         ├──── OTLP (metrics/traces/logs)                                    │
│         ├──── Prometheus /metrics endpoint                                  │
│         ├──── StatsD UDP                                                    │
│         └──── Syslog/File logs                                              │
│                │                                                            │
│         ┌──────▼───────────────────────────────────────────┐                │
│         │           INGESTION LAYER                         │               │
│         │  ┌─────────────┐  ┌──────────┐  ┌────────────┐  │                 │
│         │  │OTLP Receiver│  │Prometheus│  │Log Collector│ │                 │
│         │  │  (gRPC)     │  │ Scraper  │  │  (syslog)   │  │                │
│         │  └──────┬──────┘  └────┬─────┘  └──────┬─────┘  │                 │
│         └─────────┼──────────────┼───────────────┼────────┘                 │
│                   │              │               │                          │
│         ┌─────────▼──────────────▼───────────────▼────────┐                 │
│         │         PROCESSING PIPELINE                      │                │
│         │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │                  │
│         │  │Validation│→ │Enrichment│→ │Sampling/     │  │                  │
│         │  │          │  │(labels)  │  │Aggregation   │  │                  │
│         │  └──────────┘  └──────────┘  └──────────────┘  │                  │
│         └─────────┬──────────────┬───────────────┬────────┘                 │
│                   │              │               │                          │
│         ┌─────────▼──────────────▼───────────────▼────────┐                 │
│         │            STORAGE LAYER                         │                │
│         │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │                  │
│         │  │Prometheus│  │ClickHouse│  │ClickHouse    │  │                  │
│         │  │  TSDB    │  │  (logs)  │  │  (traces)    │  │                  │
│         │  │(metrics) │  │          │  │              │  │                  │
│         │  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │                  │
│         │       │             │               │           │                 │
│         │       └─────────┬───┴───────────────┘           │                 │
│         │                 │                               │                 │
│         │         ┌───────▼────────┐                      │                 │
│         │         │  S3 (long-term)│                      │                 │
│         │         └────────────────┘                      │                 │
│         └──────────────────┬──────────────────────────────┘                 │
│                            │                                                │
│         ┌──────────────────▼──────────────────────────────┐                 │
│         │           QUERY ENGINE                          │                 │
│         │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │                  │
│         │  │  PromQL  │  │LogQL Query│ │Trace Query   │  │                  │
│         │  │  Engine  │  │  Engine   │  │   Engine     │  │                 │
│         │  └────┬─────┘  └────┬──────┘  └──────┬───────┘  │                 │
│         └───────┼─────────────┼────────────────┼──────────┘                 │
│                 │             │                │                            │
│         ┌───────▼─────────────▼────────────────▼──────────┐                 │
│         │         APPLICATION LAYER                       │                 │
│         │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │                  │
│         │  │Alerting  │  │Dashboard │  │    API       │  │                  │
│         │  │  Engine  │  │ Service  │  │ (REST/GraphQL)│ │                  │
│         │  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │                  │
│         └───────┼─────────────┼────────────────┼──────────┘                 │
│                 │             │                │                            │
│         ┌───────▼─────────────▼────────────────▼──────────┐                 │
│         │        NOTIFICATION LAYER                       │                 │
│         │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │                  │
│         │  │  Email   │  │  Slack   │  │  PagerDuty   │  │                  │
│         │  └──────────┘  └──────────┘  └──────────────┘  │                  │
│         └─────────────────────────────────────────────────┘                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Component Responsibilities:**
1. **Ingestion Layer**: Receives telemetry data from multiple protocols
2. **Processing Pipeline**: Validates, enriches, samples, and aggregates data
3. **Storage Layer**: Persists metrics, logs, and traces efficiently
4. **Query Engine**: Executes queries across different signal types
5. **Application Layer**: Alerting, dashboards, and API services
6. **Notification Layer**: Routes alerts to various channels
```
