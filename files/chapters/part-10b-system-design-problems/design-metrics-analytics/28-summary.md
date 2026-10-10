## Summary

This table provides a quick reference for the entire system's technology stack. Each component was chosen for a specific reason: Kafka for its ability to durably buffer 1M writes/sec between an unpredictable ingest rate and the database's write capacity, ClickHouse for columnar compression and fast aggregation queries, and Redis for both alert state deduplication and query result caching. When discussing this design in an interview, justify each technology choice with concrete trade-offs.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Ingestion | HTTP endpoint + Kafka | 1M metrics/sec buffering |
| Stream processing | Custom aggregator / Flink | Pre-aggregation, reduce writes |
| TSDB (raw) | ClickHouse | 10-second data, 7-day TTL |
| TSDB (aggregated) | ClickHouse | 1-minute data, 1-year TTL |
| Alert rules | PostgreSQL | Rule persistence |
| Alert state | Redis | Deduplication |
| Query cache | Redis (result caching) | Dashboard performance |
| Notifications | PagerDuty / Slack / email | Alert delivery |


---
