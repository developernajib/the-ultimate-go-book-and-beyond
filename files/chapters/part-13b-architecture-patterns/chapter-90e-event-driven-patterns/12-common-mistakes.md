## 90E.11 Common Mistakes in Event-Driven Architecture

| Mistake | Problem | Fix |
|---------|---------|-----|
| Not designing for idempotency | Duplicate processing on retry | Use event ID deduplication store |
| Event notification without state | Consumers must query back | Use Event-Carried State Transfer |
| Missing DLQ | Poison pills block partition | Always configure a dead-letter queue |
| Committing offset before processing | Message lost on crash | Commit only after successful processing |
| No schema versioning strategy | Breaking changes break consumers | Use registry + upcasters |
| Synchronous event chains | High latency cascades | Make consumer reactions async |
| Single partition per topic | No parallelism | Partition by entity ID for ordering + parallelism |
| Event ordering assumptions | Partitions give ordering, not across topics | Don't assume cross-partition ordering |

---
