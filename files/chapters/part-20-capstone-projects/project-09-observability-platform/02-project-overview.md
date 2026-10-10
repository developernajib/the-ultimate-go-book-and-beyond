## Project Overview

This capstone project implements a complete observability platform similar to Grafana + Prometheus + Jaeger + Loki combined into a single system. The platform ingests metrics, logs, and distributed traces from applications, stores them efficiently, provides powerful querying capabilities, enables alerting, and serves dashboards.

**Key Features:**
- **Multi-Protocol Ingestion**: OTLP, Prometheus, StatsD, syslog, file tailing
- **Time-Series Metrics**: High-cardinality metrics with efficient storage
- **Structured Logs**: Log parsing, indexing, and full-text search
- **Distributed Tracing**: Span collection, trace assembly, service maps
- **Unified Querying**: Single query language across all signal types
- **Alerting**: Rule-based alerting with multiple notification channels
- **Dashboards**: Rich visualization with variable support
- **Multi-Tenancy**: Data isolation, quota management, authentication
- **High Availability**: Replication, sharding, failure handling

**Technology Stack:**
- ClickHouse for logs and traces storage
- Prometheus TSDB for metrics
- S3 for long-term storage
- gRPC for inter-service communication
- GraphQL for dashboard API
- NATS for event streaming
