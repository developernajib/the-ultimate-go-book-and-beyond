## Summary

The table below maps each core component to its technology choice and explains why that technology fits. This is useful both as a quick reference and as a guide for interview discussions where you need to justify your technology decisions. Notice how each component is chosen for a specific strength: Redis for sub-millisecond atomic operations, Kafka for durable high-throughput event streaming, and ClickHouse for analytical queries over billions of rows.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Auction engine | Go + parallel HTTP | RTB in < 100ms |
| Budget pacing | Redis Lua scripts | Atomic budget deduction |
| Ad targeting | Redis sets (inverted index) | Campaign matching |
| CTR prediction | ML model (logistic regression) | Relevance scoring |
| Event logging | Kafka → ClickHouse | Impressions/clicks at scale |
| Fraud detection | Velocity checks + ML | Invalid click filtering |
| Reporting | ClickHouse + materialized views | Advertiser dashboards |
| Frequency cap | Redis INCR + TTL | Per-user impression limits |


---
