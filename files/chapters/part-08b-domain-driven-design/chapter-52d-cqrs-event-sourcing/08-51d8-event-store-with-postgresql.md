## 52D.8 Event Store with PostgreSQL

### Schema Design

The event store schema uses two tables. The `event_store` table holds all domain events with a global `position` sequence for ordered streaming and a per-stream `stream_version` for optimistic concurrency. The `event_store_snapshots` table stores periodic state checkpoints to avoid replaying the full event history on every aggregate load.

```sql
-- migrations/001_create_event_store.sql

-- The core event store table
CREATE TABLE event_store (
    -- Global position for ordered event streaming
    position         BIGSERIAL PRIMARY KEY,
    -- Stream (aggregate) identity
    stream_id        VARCHAR(255) NOT NULL,
    -- Event version within the stream (for optimistic concurrency)
    stream_version   INTEGER NOT NULL,
    -- Event type name for deserialization
    event_name       VARCHAR(255) NOT NULL,
    -- Raw event payload
    payload          JSONB NOT NULL,
    -- Metadata: correlation ID, causation ID, user ID
    metadata         JSONB NOT NULL DEFAULT '{}',
    -- When the event was recorded
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure stream_id + stream_version is unique (optimistic concurrency)
CREATE UNIQUE INDEX idx_event_store_stream_version
    ON event_store (stream_id, stream_version);

-- For efficient stream reads
CREATE INDEX idx_event_store_stream_id
    ON event_store (stream_id, stream_version ASC);

-- Snapshot table for performance optimization
CREATE TABLE event_store_snapshots (
    stream_id        VARCHAR(255) PRIMARY KEY,
    stream_version   INTEGER NOT NULL,
    snapshot_data    JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Event Store Implementation

The PostgreSQL event store uses an `events` table with a composite unique index on `(aggregate_id, version)` to enforce optimistic concurrency: the `Append` method issues an `INSERT` with the expected version and treats a unique-constraint violation as a concurrency conflict, returning a typed error that the command handler can retry. Serializing the payload as `JSONB` preserves schema flexibility while keeping the store queryable for debugging and projection rebuilds.

```go
// internal/infrastructure/eventstore/postgres_event_store.go

package eventstore

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/lib/pq"
    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// ErrConcurrencyViolation is returned when an optimistic concurrency conflict is detected.
var ErrConcurrencyViolation = errors.New("event store: stream version conflict")

// StoredEvent is a persisted event with its stream position and version.
type StoredEvent struct {
    Position      int64
    StreamID      string
    StreamVersion int
    EventName     string
    Payload       json.RawMessage
    RecordedAt    time.Time
}

// EventStore defines the interface for an event store.
// The domain uses this interface - the infrastructure implements it.
type EventStore interface {
    // Append appends new events to a stream.
    // expectedVersion is the stream version the caller expects to be the current version.
    // Returns ErrConcurrencyViolation if the actual version does not match.
    Append(ctx context.Context, streamID string, events []account.DomainEvent, expectedVersion int) error

    // Load loads all events for a stream from a given version.
    Load(ctx context.Context, streamID string, fromVersion int) ([]StoredEvent, error)

    // LoadAll streams all events from a global position (for projections).
    LoadAll(ctx context.Context, afterPosition int64) ([]*StoredEvent, error)
}

// EventSerializer handles serialization and deserialization of domain events.
type EventSerializer interface {
    Serialize(event account.DomainEvent) (string, json.RawMessage, error)
    Deserialize(eventName string, payload json.RawMessage) (account.DomainEvent, error)
}

// PostgresEventStore is a PostgreSQL-backed event store.
type PostgresEventStore struct {
    db         *sql.DB
    serializer EventSerializer
}

// NewPostgresEventStore creates a new PostgreSQL event store.
func NewPostgresEventStore(db *sql.DB, serializer EventSerializer) *PostgresEventStore {
    return &PostgresEventStore{db: db, serializer: serializer}
}

// Append appends events to a stream with optimistic concurrency control.
func (s *PostgresEventStore) Append(
    ctx context.Context,
    streamID string,
    events []account.DomainEvent,
    expectedVersion int,
) error {
    if len(events) == 0 {
        return nil
    }

    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Verify expected version (optimistic concurrency)
    var currentVersion int
    err = tx.QueryRowContext(ctx,
        "SELECT COALESCE(MAX(stream_version), -1) FROM event_store WHERE stream_id = $1",
        streamID,
    ).Scan(&currentVersion)
    if err != nil {
        return fmt.Errorf("read current version: %w", err)
    }

    if currentVersion != expectedVersion {
        return fmt.Errorf("%w: expected %d, got %d", ErrConcurrencyViolation, expectedVersion, currentVersion)
    }

    // Append new events
    nextVersion := currentVersion + 1
    for _, event := range events {
        eventName, payload, err := s.serializer.Serialize(event)
        if err != nil {
            return fmt.Errorf("serialize event %s: %w", event.EventName(), err)
        }

        _, err = tx.ExecContext(ctx, `
            INSERT INTO event_store (stream_id, stream_version, event_name, payload, recorded_at)
            VALUES ($1, $2, $3, $4, $5)
        `, streamID, nextVersion, eventName, payload, event.OccurredAt())
        if err != nil {
            // Check for unique constraint violation (concurrent write)
            if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
                return ErrConcurrencyViolation
            }
            return fmt.Errorf("insert event: %w", err)
        }
        nextVersion++
    }

    return tx.Commit()
}

// Load loads events for a stream from a given version.
func (s *PostgresEventStore) Load(ctx context.Context, streamID string, fromVersion int) ([]StoredEvent, error) {
    rows, err := s.db.QueryContext(ctx, `
        SELECT position, stream_id, stream_version, event_name, payload, recorded_at
        FROM event_store
        WHERE stream_id = $1 AND stream_version >= $2
        ORDER BY stream_version ASC
    `, streamID, fromVersion)
    if err != nil {
        return nil, fmt.Errorf("query events: %w", err)
    }
    defer rows.Close()

    var events []StoredEvent
    for rows.Next() {
        var e StoredEvent
        if err := rows.Scan(&e.Position, &e.StreamID, &e.StreamVersion, &e.EventName, &e.Payload, &e.RecordedAt); err != nil {
            return nil, fmt.Errorf("scan event: %w", err)
        }
        events = append(events, e)
    }
    return events, rows.Err()
}

// LoadAll loads all events from a global position, for projection rebuilding.
func (s *PostgresEventStore) LoadAll(ctx context.Context, afterPosition int64) ([]*StoredEvent, error) {
    rows, err := s.db.QueryContext(ctx, `
        SELECT position, stream_id, stream_version, event_name, payload, recorded_at
        FROM event_store
        WHERE position > $1
        ORDER BY position ASC
    `, afterPosition)
    if err != nil {
        return nil, fmt.Errorf("load all events: %w", err)
    }
    defer rows.Close()

    var events []*StoredEvent
    for rows.Next() {
        e := &StoredEvent{}
        if err := rows.Scan(&e.Position, &e.StreamID, &e.StreamVersion, &e.EventName, &e.Payload, &e.RecordedAt); err != nil {
            return nil, fmt.Errorf("scan event: %w", err)
        }
        events = append(events, e)
    }
    return events, rows.Err()
}
```

### Event Repository Using the Event Store

The `AccountRepository` bridges the domain and infrastructure layers. It loads an aggregate by reading stored events from the event store, deserializing them into domain events, and replaying them through `LoadFromHistory`. When saving, it extracts uncommitted events from the aggregate and appends them with the expected version for concurrency control. If a snapshot exists, the repository loads it first and only replays events recorded after the snapshot version.

```go
// internal/infrastructure/eventstore/account_repository.go

package eventstore

import (
    "context"
    "fmt"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// AccountRepository is an event-sourced repository for the Account aggregate.
type AccountRepository struct {
    store      EventStore
    serializer EventSerializer
}

// NewAccountRepository creates a new event-sourced account repository.
func NewAccountRepository(store EventStore, serializer EventSerializer) *AccountRepository {
    return &AccountRepository{store: store, serializer: serializer}
}

// Save appends uncommitted events from the account to the event store.
func (r *AccountRepository) Save(ctx context.Context, a *account.Account) error {
    events := a.UncommittedEvents()
    if len(events) == 0 {
        return nil // nothing to save
    }

    streamID := string(a.ID())
    // expectedVersion is the version before the new events:
    // current version - number of new events
    expectedVersion := a.Version() - len(events)

    if err := r.store.Append(ctx, streamID, events, expectedVersion); err != nil {
        if err == ErrConcurrencyViolation {
            return account.ErrConcurrencyConflict
        }
        return fmt.Errorf("append events for account %s: %w", a.ID(), err)
    }
    return nil
}

// FindByID loads an account by replaying its event history.
func (r *AccountRepository) FindByID(ctx context.Context, id account.AccountID) (*account.Account, error) {
    // Check for snapshot first
    snapshot, snapshotVersion, err := r.loadSnapshot(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("load snapshot: %w", err)
    }

    fromVersion := 0
    if snapshot != nil {
        fromVersion = snapshotVersion + 1
    }

    storedEvents, err := r.store.Load(ctx, string(id), fromVersion)
    if err != nil {
        return nil, fmt.Errorf("load events for account %s: %w", id, err)
    }

    if snapshot == nil && len(storedEvents) == 0 {
        return nil, account.ErrAccountNotFound
    }

    // Deserialize events
    domainEvents := make([]account.DomainEvent, 0, len(storedEvents))
    for _, se := range storedEvents {
        event, err := r.serializer.Deserialize(se.EventName, se.Payload)
        if err != nil {
            return nil, fmt.Errorf("deserialize event %s: %w", se.EventName, err)
        }
        domainEvents = append(domainEvents, event)
    }

    // If we have a snapshot, start from it, otherwise replay all events
    if snapshot != nil {
        return account.LoadFromSnapshotAndHistory(snapshot, domainEvents)
    }
    return account.LoadFromHistory(domainEvents)
}

func (r *AccountRepository) loadSnapshot(
    ctx context.Context,
    id account.AccountID,
) (*account.Snapshot, int, error) {
    // Implementation reads from event_store_snapshots table
    // Returns nil, 0, nil if no snapshot exists
    return nil, 0, nil
}
```

### Event Serializer

The serializer converts domain events to and from JSON. `Serialize` extracts the event name and marshals the struct to `json.RawMessage`. `Deserialize` uses a switch on the event name to select the correct concrete type, then unmarshals into it. This explicit dispatch avoids reflection and makes it straightforward to add upcasting logic for schema evolution (see Section 52D.14).

```go
// internal/infrastructure/eventstore/json_serializer.go

package eventstore

import (
    "encoding/json"
    "fmt"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// JSONEventSerializer serializes and deserializes domain events as JSON.
type JSONEventSerializer struct{}

func NewJSONEventSerializer() *JSONEventSerializer {
    return &JSONEventSerializer{}
}

func (s *JSONEventSerializer) Serialize(event account.DomainEvent) (string, json.RawMessage, error) {
    payload, err := json.Marshal(event)
    if err != nil {
        return "", nil, fmt.Errorf("marshal event %T: %w", event, err)
    }
    return event.EventName(), payload, nil
}

func (s *JSONEventSerializer) Deserialize(eventName string, payload json.RawMessage) (account.DomainEvent, error) {
    switch eventName {
    case "account.opened":
        var e account.AccountOpened
        return e, json.Unmarshal(payload, &e)
    case "account.money_deposited":
        var e account.MoneyDeposited
        return e, json.Unmarshal(payload, &e)
    case "account.money_withdrawn":
        var e account.MoneyWithdrawn
        return e, json.Unmarshal(payload, &e)
    case "account.frozen":
        var e account.AccountFrozen
        return e, json.Unmarshal(payload, &e)
    case "account.unfrozen":
        var e account.AccountUnfrozen
        return e, json.Unmarshal(payload, &e)
    case "account.closed":
        var e account.AccountClosed
        return e, json.Unmarshal(payload, &e)
    default:
        return nil, fmt.Errorf("unknown event type: %s", eventName)
    }
}
```

### Junior → FAANG: Understanding the Schema and Concurrency Mechanism

Start with the SQL schema before reading any Go code. The `event_store` table has two key design decisions: `BIGSERIAL position` for global ordering across all streams, and the unique index on `(stream_id, stream_version)` for per-stream concurrency control. The global position lets projectors read events in the order they were written. The per-stream version lets the aggregate enforce optimistic concurrency.

The `Append` method is the most important method in the event store. Trace it step by step: (1) begin a transaction, (2) query the current max version for the stream, (3) compare to `expectedVersion`, (4) return `ErrConcurrencyViolation` if they differ, (5) insert each event with incrementing version numbers, (6) commit. Step 3 and 4 are the optimistic concurrency check. Two concurrent requests that both expect version 5 will race: one transaction commits at step 6, the other finds version 6 in step 2 and returns `ErrConcurrencyViolation`. The handler retries by reloading the aggregate and re-applying the command.

The `pq.Error` code check (`"23505"` is PostgreSQL's unique violation code) is a fallback for the race that slips through the version check. This can happen if two transactions read version 5 simultaneously before either commits. The unique constraint on `(stream_id, stream_version)` ensures exactly one of them will succeed.

The `JSONEventSerializer` switch-on-event-name pattern is explicit and debuggable. When a new event type is added, you add a case to the switch. If you forget, the `Deserialize` method returns an error for unknown types. This is visible and testable. A reflection-based approach that automatically finds struct types by name is more magical but harder to debug when something goes wrong in production.

First-job habit: write an integration test for `Append` that verifies the concurrency violation path. Spawn two goroutines that both load version 0, both call `Append` expecting version 0, and assert that exactly one succeeds and exactly one returns `ErrConcurrencyViolation`. This test does not require mocking: run it against a real PostgreSQL instance in your CI pipeline.

### Senior @ FAANG: Event Store Operations, Schema Governance, and Long-Term Maintenance

The schema in this section is the starting point for a production event store, but several concerns emerge at scale.

The `COALESCE(MAX(stream_version), -1)` version check runs inside the same transaction as the inserts. Under high concurrency on a single stream (many deposits to the same account), this creates a hot row in the `event_store` index: each transaction locks the index entry for that `stream_id` while checking the max version. The contention manifests as transaction queue buildup and increased P99 latency. Mitigation strategies: pessimistic locking (SELECT FOR UPDATE on the stream's current version, stored in a separate `stream_versions` table), command queuing per aggregate (all commands for a given account go through a single goroutine), or reducing the frequency of commands on the hottest aggregates. The right choice depends on your workload and latency SLO.

The `metadata JSONB` column is the mechanism for distributed tracing, causal ordering, and compliance. Every event in production should carry at minimum: `correlation_id` (the trace ID that spans all operations in a single business workflow), `causation_id` (the ID of the command that caused this event), and `actor_id` (who performed the action). These fields are not domain fields and do not belong on the domain event struct. They are cross-cutting infrastructure concerns that belong in metadata. The command handler populates them from the request context. The event store writes them alongside the payload. Projectors can copy the correlation ID into read models for end-to-end query tracing.

Event schema governance requires a registry. As the number of event types grows and teams share the event store, you need a central record of: which teams own which stream namespaces, what the current schema version is for each event type, what the upcasting chain is for each event type (version 1 to version 2 to version 3), and what the retention policy is for old event types. In Go, this is often a JSON schema registry or a Proto schema registry (if events are serialized as protobuf instead of JSON). Protobuf has a meaningful advantage here: backward-compatible field additions do not require upcasters, and the generated types are versioned by the protobuf compiler.

The `LoadAll` method is the projection rebuild API. In production, it should support batching (return events in pages of N rather than loading all into memory), cursor-based resumption (restart from a specific position after a crash), and a streaming mode (channel-based rather than slice-based) to avoid holding gigabytes of events in memory. The current implementation loads all events into a slice, which will OOM on a large event store. Refactor this to a channel or a callback-based API before production.

---
