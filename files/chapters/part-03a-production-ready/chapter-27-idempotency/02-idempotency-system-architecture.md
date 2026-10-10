## Idempotency System Architecture

An idempotency system must guarantee that a client retrying a failed or timed-out request produces exactly the same observable outcome as the original, no double charges, no duplicate records. The architecture below achieves this through three coordinated layers.

A **response cache** keyed on a composite of the authenticated account, the HTTP method and path, and the client-supplied `Idempotency-Key`. Note what is absent from that key: the request body. The body's hash is stored *beside* the cached response as a fingerprint and compared on replay, so a key reused with different parameters is rejected with a `400` rather than replayed. Folding the body hash into the key instead is the most common way to build this wrong, because it converts key reuse from a detectable error into a silent cache miss that re-executes the operation.

A **distributed lock** that serializes concurrent retries of the same key, so that fifty simultaneous retries produce one execution and forty-nine `409`s.

And a **PostgreSQL outbox table** that records downstream events in the same transaction as the business write, so Kafka messages are never published without a committed database record. The outbox worker's `FOR UPDATE SKIP LOCKED` lets multiple publisher instances drain the table in parallel without stepping on each other, but only because the worker holds those row locks inside an explicit transaction that spans the publish. The locks are released at transaction end, so a claim query issued outside a transaction locks nothing at all.

Every one of those layers reduces duplicates. None of them, alone, is the guarantee. The guarantee is always a unique constraint, an atomic operation, or a conditional write, and the layers above exist to keep you from paying for it on every request.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        IDEMPOTENCY SYSTEM ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Client Request                                                                 │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         API Gateway Layer                               │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │ Idempotency-Key │  │  Request Body   │  │   Rate Limit    │          │    │
│  │  │   Extraction    │  │     Hashing     │  │     Check       │          │    │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │    │
│  │           │                    │                    │                   │    │
│  │           └────────────────────┼────────────────────┘                   │    │
│  │                                │                                        │    │
│  │                                ▼                                        │    │
│  │                    ┌───────────────────────┐                            │    │
│  │                    │   Composite Key Gen   │                            │    │
│  │                    │ key:body_hash:method  │                            │    │
│  │                    └───────────┬───────────┘                            │    │
│  └────────────────────────────────┼────────────────────────────────────────┘    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      Idempotency Middleware                             │    │
│  │                                                                         │    │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │    │
│  │  │                    Phase 1: Lookup                                 │ │    │
│  │  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │ │    │
│  │  │  │ Check Cache  │───►│  Cache Hit?  │───►│ Return Cached│          │ │    │
│  │  │  │   (Redis)    │    │              │Yes │   Response   │          │ │    │
│  │  │  └──────────────┘    └──────┬───────┘    └──────────────┘          │ │    │
│  │  │                             │ No                                   │ │    │
│  │  │                             ▼                                      │ │    │
│  │  │                    ┌──────────────────┐                            │ │    │
│  │  │                    │   Acquire Lock   │                            │ │    │
│  │  │                    │  (Distributed)   │                            │ │    │
│  │  │                    └────────┬─────────┘                            │ │    │
│  │  │                             │                                      │ │    │
│  │  │           ┌─────────────────┼─────────────────┐                    │ │    │
│  │  │           │ Lock Failed     │ Lock Acquired   │                    │ │    │
│  │  │           ▼                 ▼                 │                    │ │    │
│  │  │  ┌──────────────┐  ┌──────────────────────┐  │                     │ │    │
│  │  │  │Return 409    │  │ Double-Check Cache   │  │                     │ │    │
│  │  │  │Conflict      │  │ (Race Condition)     │  │                     │ │    │
│  │  │  └──────────────┘  └──────────┬───────────┘  │                     │ │    │
│  │  │                               │              │                     │ │    │
│  │  └───────────────────────────────┼────────────────────────────────────┘ │    │
│  │                                  │                                      │    │
│  │  ┌───────────────────────────────┼────────────────────────────────────┐ │    │
│  │  │               Phase 2: Execute                                     │ │    │
│  │  │                               ▼                                    │ │    │
│  │  │               ┌───────────────────────────────┐                    │ │    │
│  │  │               │      Business Logic           │                    │ │    │
│  │  │               │   ┌─────────────────────┐     │                    │ │    │
│  │  │               │   │  Database Write     │     │                    │ │    │
│  │  │               │   │  + Outbox Message   │     │                    │ │    │
│  │  │               │   │  (Same Transaction) │     │                    │ │    │
│  │  │               │   └──────────┬──────────┘     │                    │ │    │
│  │  │               └──────────────┼────────────────┘                    │ │    │
│  │  │                              │                                     │ │    │
│  │  └──────────────────────────────┼─────────────────────────────────────┘ │    │
│  │                                 │                                       │    │
│  │  ┌──────────────────────────────┼─────────────────────────────────────┐ │    │
│  │  │               Phase 3: Store & Respond                             │ │    │
│  │  │                              ▼                                     │ │    │
│  │  │               ┌───────────────────────────────┐                    │ │    │
│  │  │               │  Store Response in Cache      │                    │ │    │
│  │  │               │  (with TTL: 24-48 hours)      │                    │ │    │
│  │  │               └──────────────┬────────────────┘                    │ │    │
│  │  │                              │                                     │ │    │
│  │  │                              ▼                                     │ │    │
│  │  │               ┌───────────────────────────────┐                    │ │    │
│  │  │               │     Release Lock              │                    │ │    │
│  │  │               └──────────────┬────────────────┘                    │ │    │
│  │  │                              │                                     │ │    │
│  │  │                              ▼                                     │ │    │
│  │  │               ┌───────────────────────────────┐                    │ │    │
│  │  │               │   Return Response to Client   │                    │ │    │
│  │  │               └───────────────────────────────┘                    │ │    │
│  │  └────────────────────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                              STORAGE LAYER                                      │
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                  │
│  │     Redis       │  │   PostgreSQL    │  │     Kafka       │                  │
│  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │                  │
│  │  │ Response  │  │  │  │  Outbox   │  │  │  │  Events   │  │                  │
│  │  │  Cache    │  │  │  │  Table    │  │  │  │  Topic    │  │                  │
│  │  ├───────────┤  │  │  ├───────────┤  │  │  ├───────────┤  │                  │
│  │  │   Lock    │  │  │  │Processing │  │  │  │Published  │  │                  │
│  │  │  Store    │  │  │  │ Records   │  │  │  │ Messages  │  │                  │
│  │  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │                  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                  │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           OUTBOX PUBLISHER                                      │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      Background Worker                                  │    │
│  │                                                                         │    │
│  │   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │    │
│  │   │ Poll Outbox │───►│ Publish to  │───►│   Mark as   │                 │    │
│  │   │   Table     │    │   Kafka     │    │  Processed  │                 │    │
│  │   │(FOR UPDATE  │    │(With Retry) │    │(Idempotent) │                 │    │
│  │   │SKIP LOCKED) │    └─────────────┘    └─────────────┘                 │    │
│  │   └─────────────┘                                                       │    │
│  │         │                                                               │    │
│  │         ▼                                                               │    │
│  │   ┌─────────────┐    ┌─────────────┐                                    │    │
│  │   │  Cleanup    │───►│   Delete    │                                    │    │
│  │   │  Old Msgs   │    │ Processed   │                                    │    │
│  │   │ (>7 days)   │    │  Messages   │                                    │    │
│  │   └─────────────┘    └─────────────┘                                    │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

                           SAGA ORCHESTRATION

┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DISTRIBUTED SAGA PATTERN                                │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                     Saga Orchestrator                                   │    │
│  │                                                                         │    │
│  │   Start ──► Step 1 ──► Step 2 ──► Step 3 ──► Complete                   │    │
│  │             Reserve    Charge     Create                                │    │
│  │            Inventory  Payment    Shipment                               │    │
│  │                                                                         │    │
│  │   On Failure at any step:                                               │    │
│  │   ◄── Compensate ◄── Compensate ◄── Compensate                          │    │
│  │       Cancel         Refund        Release                              │    │
│  │      Shipment       Payment       Inventory                             │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                         Saga State Machine                                │  │
│  │                                                                           │  │
│  │    STARTED ──► EXECUTING ──► COMPLETED                                    │  │
│  │       │            │                                                      │  │
│  │       │            ▼                                                      │  │
│  │       │      COMPENSATING ──► COMPENSATED                                 │  │
│  │       │            │                                                      │  │
│  │       └────► FAILED ◄────────┘                                            │  │
│  │                                                                           │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Idempotency Architecture Is API Contract

When a service accepts Idempotency-Key header, clients know retries are safe. This becomes part of the API contract. Document it and enforce it.

---
