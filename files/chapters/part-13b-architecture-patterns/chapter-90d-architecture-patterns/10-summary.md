## Exercises

### Exercise 1: Hexagonal Order Fulfillment Service
- **Context:** An e-commerce service processing orders with pluggable persistence and notification adapters.
- **Task:** Implement a hexagonal architecture in Go:
  1. Define domain entities (`Order`, `OrderItem`, `Money` with integer cents) and repository/gateway ports (`OrderRepository`, `PaymentGateway`, `NotificationSender`) as pure interfaces in the domain package.
  2. Implement an in-memory test double adapter for `OrderRepository` that mimics transaction isolation without external dependencies.
  3. Implement an HTTP driving adapter that deserializes JSON requests, invokes the domain service, and formats responses without leaking HTTP concerns into domain entities.
  4. Write a unit test suite validating business rules (e.g. order item quantity limits, credit balance checks) using only mocked secondary ports.

### Exercise 2: CQRS In-Memory Read Projection Engine
- **Context:** Read-heavy product catalog requiring microsecond-level query responses.
- **Task:** Build a typed CQRS engine in Go:
  1. Implement a command pipeline that accepts `CreateProductCommand` and `UpdateStockCommand`, verifies domain invariants, and writes to a normalized write model.
  2. Emit `ProductCreated` and `StockUpdated` domain events upon every successful write mutation.
  3. Build an asynchronous `ProductProjection` worker reading from an event bus that maintains a denormalized read-optimized lookup map protected by `sync.RWMutex`.
  4. Benchmark read query throughput and verify that queries never acquire write-model locks.

### Exercise 3: Event-Sourced Bank Account with Aggregate Snapshots
- **Context:** Financial ledger requiring 100% auditability and temporal state reconstruction.
- **Task:** Implement an event-sourced aggregate in Go:
  1. Define event types (`AccountOpened`, `MoneyDeposited`, `MoneyWithdrawn`) and implement `Apply(event any)` to reconstitute state without side effects.
  2. Enforce optimistic concurrency control using an `expectedVersion` check on append operations to prevent double-spending under concurrent withdrawals.
  3. Implement snapshotting: serialize an aggregate snapshot every 50 events. Reconstitute the account by loading the latest snapshot and replaying only subsequent events.
  4. Verify that replaying 1,000 deposits and withdrawals calculates the exact balance (in integer cents) matching iterative state mutation.

### Exercise 4: Orchestrated Booking Saga with Backward Compensation
- **Context:** Travel booking platform coordinating hotel, flight, and car rental reservations.
- **Task:** Build a step-agnostic saga orchestrator in Go:
  1. Define `SagaStep` containing `Transaction` and `Compensation` closures operating on a thread-safe `SagaState` bag.
  2. Implement sequential step execution: execute steps in forward order, capturing output tokens into `SagaState`.
  3. Simulate a failure at step 3 (car rental unavailable): trigger reverse LIFO execution of compensations for steps 2 (flight) and 1 (hotel).
  4. Ensure all compensation routines are strictly idempotent, handling retry loops without duplicating refunds.

### Exercise 5: Transactional Outbox Polling Relay with Worker Leases
- **Context:** Preventing dual-write drift between PostgreSQL databases and event streaming brokers.
- **Task:** Implement a production-grade transactional outbox worker in Go:
  1. Write a helper `ExecuteWithOutbox(ctx context.Context, db *sql.DB, entityTx func(tx *sql.Tx) error, event OutboxEvent) error` that commits both changes in a single SQL transaction.
  2. Implement a background poller worker that polls pending outbox rows using `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`.
  3. Publish fetched events to a mock broker interface, update row status to `published`, and set `published_at = time.Now().UTC()`.
  4. Verify that killing the relay process mid-flight results in zero lost events and safe retry on next boot.

---

## Summary

Architecture patterns solve specific complexity problems:
- **Hexagonal Architecture** decouples domain from infrastructure - makes business logic testable without databases or HTTP.
- **CQRS** optimizes read and write paths independently - read model can be denormalized and cached without affecting the write model.
- **Event Sourcing** stores events instead of state - provides full audit trail, temporal queries, and event replay capability.
- **Saga** manages distributed transactions with compensations - maintains consistency across service boundaries without 2PC.
- **Outbox** ensures reliable event publishing by co-locating the event with the domain change in the same DB transaction.

*Next: [Chapter 90E: Event-Driven Architecture Patterns](../chapter-90e-event-driven-patterns/00-introduction.md)*
