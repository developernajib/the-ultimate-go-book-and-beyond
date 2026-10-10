## Summary

Every distributed system will experience network failures, process crashes, and client retries. The patterns in this chapter transform those failure modes from data-corruption risks into routine, safe operations.

**Core patterns covered:**

1. **Idempotency Keys.** Client-provided keys combined with request body hashing and distributed locks form a check-lock-check-execute-store pipeline that makes any mutating endpoint safe to retry.
2. **Transactional Outbox.** Writing business data and outbox events in the same database transaction eliminates the dual-write problem. A background relay publishes events to the broker with at-least-once delivery.
3. **Deduplication.** Redis `SetNX` or Postgres `INSERT ... ON CONFLICT DO NOTHING` provides atomic duplicate detection with TTL-bounded storage growth.
4. **Exactly-Once Processing.** Two-phase processing records in-flight state before executing the handler, enabling crash recovery without duplicate execution.
5. **Saga Orchestration.** Sequential local transactions with reverse-order compensation functions achieve eventual consistency across services without distributed locks.
6. **Concurrent Request Handling.** Optimistic locking (version columns) suits low-contention workloads. Pessimistic locking (`SELECT ... FOR UPDATE`) suits high-contention ones.
7. **Retry-Safe API Design.** Prefer `PUT` for full replacement, require `Idempotency-Key` headers on `POST` endpoints, and use `If-Match` ETags for conditional updates.

**The central point:** true exactly-once delivery is impossible in distributed systems, but idempotent consumers on top of at-least-once infrastructure achieve effectively-exactly-once processing, which is what production systems actually need.

### For the Senior-at-FAANG Track

Idempotency on every mutation endpoint. Outbox pattern for any service that publishes events. Compensations tested as carefully as forward transactions.

### For the Staff and Principal Track

Drive idempotency as org standard. Audit existing endpoints. Build shared middleware. Payment and billing services first, then everything else.

---
