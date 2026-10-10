## 90D.7 Common Mistakes in Architecture Patterns

| Mistake | Problem | Fix |
|---------|---------|-----|
| Domain logic in HTTP handlers | Can't test without HTTP | Put logic in domain/service layer |
| CQRS without projections | Read model gets stale | Always update read model when events occur |
| Event sourcing every entity | Over-engineering | Use ES only where audit trail and history matter |
| Saga without idempotent steps | Duplicate execution on retry | Make each step idempotent |
| Missing compensation in saga | Partial failure leaves inconsistent state | Every transaction must have a compensation |
| Publishing events outside transaction | Event lost if DB commit fails | Use outbox pattern for reliability |
| Read model in same DB as write | No performance isolation | Separate DB or at least separate schema |
| Reconstituting full history every read | Slow for long-lived aggregates | Use snapshots after N events |

---
