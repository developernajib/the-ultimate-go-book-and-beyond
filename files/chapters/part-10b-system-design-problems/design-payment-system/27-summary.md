## Summary

The table below maps each major component of the payment system to its technology choice and primary responsibility. This gives you a quick reference for how the pieces fit together and which infrastructure backs each concern. In an interview, being able to articulate this mapping shows that you understand both the "what" and the "why" behind each architectural decision.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Payment orchestration | Go service | Coordinate payment flow |
| Idempotency | Redis cache + lock, DB `UNIQUE` | Exactly-once semantics (the constraint is the guarantee, Redis is the fast path) |
| Card processing | Stripe/Adyen API | Actual charge |
| Fraud detection | Rules + ML model | Real-time risk scoring |
| Ledger | PostgreSQL partitioned | Double-entry bookkeeping |
| Transaction storage | PostgreSQL | Source of truth |
| Velocity tracking | Redis sorted sets | Fraud velocity features |
| Reconciliation | Batch job | Processor vs ledger match |
| Notifications | Kafka → email/webhook | Payment events |


---
