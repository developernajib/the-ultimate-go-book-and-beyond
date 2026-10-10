## 37C.4 Data Modeling for Microservices

### Database Per Service

Database-per-service is the ideal. Real-world systems often compromise. At small scale, many teams start with a single physical PostgreSQL cluster partitioned into separate *logical schemas* per service (`orders.*`, `inventory.*`, `users.*`) with per-service credentials that deny cross-schema access. This gets you the enforcement boundary without the operational cost of N database clusters. The migration to separate physical databases happens when a specific service's scaling, latency, or compliance requirements justify it. What is *never* acceptable is a shared mutable schema where multiple services write to the same tables - that pattern guarantees tight coupling, breaking deploys, and incidents that span service boundaries.

Each microservice owns its data. No service can directly query another service's database:

```
OrderService    → orders_db    (PostgreSQL)
InventoryService → inventory_db (PostgreSQL)
SearchService   → search_db    (Elasticsearch)
AnalyticsService → analytics_db (ClickHouse)
```

Why: Services can evolve their schemas independently. One service's slow migration doesn't affect others. Services can choose the right database type for their access patterns.

The enforcement mechanism: each service has its own database credentials. No other service can connect. API or message queue is the only interface.

### Shared Database Anti-Pattern

The shared database anti-pattern arises when multiple microservices directly access the same database schema, creating hidden coupling through shared table structures. The following example illustrates the problem. Subsequent sections demonstrate how to decouple services through dedicated schemas or separate databases.

```
# Anti-pattern: all services share one database
OrderService   ──┐
InventoryService ──┼──→ shared_db
UserService    ──┘

Consequences:
- Schema change in OrderService requires coordinating with InventoryService
- One service's slow query affects all services
- Cannot scale databases independently
- Cannot use different database types per service
- Cross-service JOINs seem tempting but create coupling
```

Even more insidious: **shared schema ownership**. Service A creates a table, Service B starts reading from it directly. Now you have an invisible coupling that will cause production incidents when Service A changes the schema.

The rule: if two services share a table, they are not truly separate services.

### Data Duplication Across Services

When Service B needs data owned by Service A:

```
Option 1: Synchronous API call
OrderService calls UserService.GetUser(userID) for every order display

Pros: Always fresh data
Cons: Tight coupling, latency, availability dependency (UserService down = OrderService down)

Option 2: Local cache with TTL
OrderService caches user data for 5 minutes

Pros: Low latency, resilient to UserService downtime
Cons: Stale data, cache invalidation complexity

Option 3: Event-driven replication (recommended)
UserService publishes UserUpdated events
OrderService subscribes and maintains a local read-only copy

Pros: Loose coupling, fast local reads, resilient
Cons: Eventual consistency, operational complexity
```

The key insight: in a microservices architecture, **you will have copies of data**. The question is not whether to duplicate, but how to keep copies sufficiently consistent.

### Event-Driven Data Synchronization

In event-driven sync, the source service publishes a domain event whenever its data changes. Downstream services subscribe to these events and maintain local read-only projections. A version field on each event prevents out-of-order updates from overwriting newer data with stale values.

```go
// UserService: publish event on user update
type UserUpdatedEvent struct {
    UserID    string    `json:"user_id"`
    Email     string    `json:"email"`
    Name      string    `json:"name"`
    UpdatedAt time.Time `json:"updated_at"`
    Version   int       `json:"version"`  // optimistic concurrency
}

func (s *UserService) UpdateUser(ctx context.Context, userID string, update UserUpdate) (*User, error) {
    user, err := s.repo.Update(ctx, userID, update)
    if err != nil {
        return nil, err
    }

    // Publish event after successful update
    event := UserUpdatedEvent{
        UserID:    user.ID,
        Email:     user.Email,
        Name:      user.Name,
        UpdatedAt: user.UpdatedAt,
        Version:   user.Version,
    }
    if err := s.publisher.Publish(ctx, "user.updated", event); err != nil {
        // Log but don't fail - event can be replayed via outbox pattern
        s.logger.Error("failed to publish user.updated event", "error", err)
    }

    return user, nil
}

// OrderService: subscribe and maintain local copy
type UserProjection struct {
    UserID    string    `db:"user_id"`
    Email     string    `db:"email"`
    Name      string    `db:"name"`
    UpdatedAt time.Time `db:"updated_at"`
    Version   int       `db:"version"`
}

func (s *OrderService) HandleUserUpdated(ctx context.Context, event UserUpdatedEvent) error {
    return s.db.Exec(ctx, `
        INSERT INTO user_projections (user_id, email, name, updated_at, version)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE
        SET email = EXCLUDED.email,
            name = EXCLUDED.name,
            updated_at = EXCLUDED.updated_at,
            version = EXCLUDED.version
        WHERE user_projections.version < EXCLUDED.version  -- prevent out-of-order updates
    `, event.UserID, event.Email, event.Name, event.UpdatedAt, event.Version)
}
```

### Reporting Across Microservice Databases

Reporting often requires joining data across service boundaries. Options:

1. **API composition**: Reporting service calls each service's API, assembles the data. Works for small datasets. N+1 problem at scale.

2. **Read model / CQRS**: Each service publishes events to a shared read store (Kafka, Kinesis). Reporting service consumes events and builds a denormalized read model optimized for reports.

3. **Data warehouse**: Services sync to a data warehouse (BigQuery, Snowflake, Redshift) via CDC (Change Data Capture). Reports run against the warehouse.

```go
// CDC with pglogical or Debezium (conceptual)
// Each service's database publishes WAL changes to Kafka
// Reporting service consumes and writes to read model

type ReportingOrderRecord struct {
    OrderID       string    `db:"order_id"`
    UserEmail     string    `db:"user_email"`   // from UserService
    UserName      string    `db:"user_name"`    // from UserService
    ProductName   string    `db:"product_name"` // from ProductService
    Amount        int64     `db:"amount"`       // from OrderService
    Status        string    `db:"status"`       // from OrderService
    CreatedAt     time.Time `db:"created_at"`
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

If you arrived here from a monolith background, the mental shift is that a "table" is no longer a neutral shared asset. In a monolith, any module can `JOIN orders ON users.id = orders.user_id` and the database guarantees consistency. In microservices, that JOIN is illegal. The user record lives in `users_db` owned by UserService, and OrderService cannot see it. This is not a performance rule, it is an *ownership* rule. The table is an implementation detail of one service, and exposing it to another service creates the shared database anti-pattern described above.

Worked example for a first job. You are on OrderService and the product manager asks you to show the customer email on the order confirmation page. Three wrong answers: (1) add a cross-database query, (2) read directly from the user table, (3) hardcode a database link. The right answer at a junior level is a synchronous API call to `UserService.GetUser(userID)` with a timeout and a circuit breaker. This is acceptable at low scale. When traffic grows and UserService latency starts cascading into OrderService P99, you graduate to the event-driven replication pattern in the code above, where OrderService keeps a local `user_projections` table updated from `user.updated` events.

Interview entry-point question and how to answer it. "Two microservices need the same user data. How do you share it?" A junior answer names one option. A FAANG-ready answer walks the trade-off: synchronous call (fresh, coupled, latency-additive), cached API call (faster, stale window), event-driven projection (loose coupling, eventual consistency, operational cost of a message bus and a consumer that handles replays and out-of-order delivery). Then you name the failure mode each pattern introduces and which you would pick given the read-to-write ratio. If the interviewer presses on consistency, mention the version field on events and the `WHERE version < EXCLUDED.version` guard in the upsert, which is the difference between "I have used events" and "I have debugged events in production."

One more prerequisite. Understand that "eventual consistency" is a contract, not a bug. If a user updates their email and the order page shows the old email for 800ms, that is the system working as designed. If the business cannot tolerate that window for a specific field, that field belongs to a different service or needs a synchronous read path. Do not try to force strong consistency across service boundaries with distributed locks. That path leads to a distributed monolith with worse availability than the original.

### Senior @ FAANG: Staff and Principal Material

Data ownership at staff level is a political problem as much as a technical one. The shared database anti-pattern almost never appears because someone wrote it down. It appears because Team A needed a field from Team B, Team B was slow to ship an API, and a "temporary" direct read went in behind a feature flag and stayed for four years. The staff engineer's job is to make the right path cheaper than the wrong path. That means a service scaffold that ships with an outbox table, a Debezium connector config, an event schema registry entry, and a consumer library all preconfigured, so that publishing a domain event is a three-line change rather than a two-week project. If event-driven replication costs more than a direct database read, teams will choose the read.

The outbox pattern is the non-negotiable foundation. The bug you avoid is the dual-write problem: a service updates its local database and then publishes to Kafka, and the publish fails after the commit. Now the database says the order is placed and the event bus says nothing happened. Inventory never decrements. The fix is to write the event into an `outbox` table in the same transaction as the business state change, and have a separate relay process (or Debezium reading the WAL) ship outbox rows to Kafka with at-least-once delivery. Consumers must be idempotent, keyed on event ID, typically with a `processed_events` table or a Redis set with TTL. At scale, Debezium with Postgres logical replication slots is the default. Watch your replication slot lag like you watch disk. A stuck consumer holding a slot open will fill your WAL and take down the primary. Alerts on `pg_replication_slots.confirmed_flush_lsn` lag are load-bearing.

Saga for cross-service transactions. Two-phase commit across microservices is a career-limiting move. The alternative is a saga, which is a sequence of local transactions where each step has a compensating action. Orchestration-based sagas use a central coordinator (Temporal, Cadence, AWS Step Functions) that owns the state machine and calls each service. Choreography-based sagas have each service react to events from the previous step. Orchestration is easier to reason about, easier to debug, and scales fine until your coordinator becomes a distributed monolith of its own. Choreography is loosely coupled but the overall business flow is implicit in the event graph and nobody can draw it on a whiteboard. The staff-level recommendation is orchestration for flows that cross more than three services or have non-trivial compensation logic, choreography for simple two-step flows with obvious rollback. Compensations are not rollbacks. A refund is not "uncharge the card," it is a new transaction with its own ledger entry. Model it that way from day one.

API-first data contracts and schema evolution. Every inter-service event needs a registered schema (Protobuf, Avro, or JSON Schema in Confluent Schema Registry, Buf Schema Registry, or an internal registry). Breaking changes are enforced at CI time. The rule is additive-only for published events: add optional fields, never remove or retype. When you must break, you version the topic (`user.updated.v2`) and run both in parallel until all consumers migrate. Consumers should ignore unknown fields. Producers should never rely on consumer behavior. At FAANG scale, you will have hundreds of consumers of a popular event, and you do not know who they all are. The registry and the additive-only rule are what let you sleep.

DDD bounded contexts to database schemas. The mapping is: bounded context = service = database. Inside a context you have aggregates, and the aggregate root is the only entity allowed to be loaded and mutated through the repository. Child entities are loaded and saved through the root. This is what prevents the "everything is a foreign key to everything" schema that kills monoliths. Aggregate boundaries are also your transaction boundaries. If updating Order and Inventory needs to be atomic, either they are the same aggregate (and the same service) or you need a saga. The common staff-level mistake is drawing bounded contexts along team lines rather than along invariants. If two teams cannot change their schemas independently without coordinating a deploy, they are one bounded context with two owners, which is worse than one team owning both.

Strangler-fig migration from a shared monolithic database. You rarely get to start clean. The realistic path from a 400-table shared Postgres to service-per-database takes 18 to 36 months. Phase 1: inventory every table and assign a single owning service. Phase 2: enforce ownership at the connection level using per-service database roles with `REVOKE ALL` on non-owned tables. This surfaces every cross-service read as a permission error in staging. Phase 3: replace cross-service reads with API calls or event-driven projections, one table at a time. Phase 4: move owned tables to a separate schema, then to a separate database, then to a separate cluster. Never skip phases. The projection step is what breaks the coupling. The physical move is the easy part. Instrument everything with query logs tagged by service, and publish a monthly dashboard of remaining cross-service queries. What gets measured gets migrated.

CDC at scale and pitfalls. Debezium on Postgres is the default in 2026 for most shops. Watch for these failure modes. Logical decoding does not replicate DDL, so schema changes on the source need coordination. Large transactions (bulk updates) emit a flood of CDC events and can saturate the consumer. TOAST columns in Postgres are not included in CDC unless the column was updated, so downstream projections see null for unchanged large text fields unless you set `REPLICA IDENTITY FULL` (which doubles WAL volume, a real cost). Snapshot-then-stream initialization is fine for small tables and a disaster for billion-row tables. Use incremental snapshots (Debezium 2.x) or a parallel bulk export plus LSN pinning. Postgres 16 added logical decoding from standbys, and Postgres 17 added built-in synchronization of logical replication slots to a standby (failover slots), which removed one of the biggest operational footguns of earlier years.

Read model and CQRS at scale. For reporting that spans services, do not build a second transactional database. Build an analytical store. ClickHouse or Snowflake or BigQuery for warehouse, Elasticsearch or OpenSearch for search, materialized Kafka topics (ksqlDB, Flink) for real-time read models. The transactional services own their OLTP data. The analytical store is denormalized, wide, and rebuildable from the event log. If you can rebuild it in under 24 hours from replay, schema changes become cheap. If you cannot, every schema change is a migration project. Design for rebuildability from day one. Event retention in Kafka of 7 to 30 days plus a compacted topic for the latest state is a common pattern. For longer retention, tier to S3 with Kafka tiered storage or periodic dumps to Iceberg.

What to push back on. If a product manager asks for "a single source of truth across all services with strong consistency and sub-100ms reads," the correct answer is "that is a monolith, and we sold the monolith for independent deploys, so pick one." If a tech lead proposes Kafka as the primary database, push back. Kafka is a log, not a database. Its query model is "read from offset X," not "find by key efficiently." Use Kafka to move events, use Postgres or DynamoDB or Spanner to store state, and use a projection to bridge them. The bridge is where the bugs live, and it is where your most senior engineers should be spending their time.

---
