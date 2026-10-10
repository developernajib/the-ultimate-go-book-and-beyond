## 27.3 Outbox Pattern

> **Senior track**: Two relay variants exist in production. **Polling-based** (shown below) is simple but adds query load and latency (poll interval = p99 floor). **Log-based CDC** via Debezium, Flink CDC, or AWS DMS tails the database WAL/binlog and streams changes to Kafka with sub-second latency and zero polling overhead, this is the Netflix/Uber default. The tradeoff is operational complexity (Kafka Connect cluster, schema registry, replication slot management on Postgres). For new services, start with polling, graduate to CDC when the relay becomes a bottleneck or you need sub-second fanout. Temporal.io is an increasingly common third option: its durable-execution model subsumes both outbox and saga orchestration, removing the outbox table entirely.

### Transactional Outbox

The transactional outbox pattern solves the dual-write problem: writing to a database and publishing to a message broker as two separate operations can result in one succeeding and the other failing. By storing outbox messages in the same database transaction as the business operation, you guarantee that messages are durably recorded if and only if the business operation commits. A separate relay process then publishes them to the broker and marks them processed, achieving at-least-once delivery without distributed transactions.

Be precise about what this buys you, because the pattern is routinely oversold. The outbox eliminates exactly one failure: an event that is lost because the database committed and the broker publish did not, or an event published for a business write that then rolled back. It does **not** deliver each message once. The relay can publish and then crash before recording that it published, and on restart it will publish again. That window cannot be closed, because publishing to Kafka and updating a Postgres row are two systems and there is no atomic commit across them. The outbox converts "lost or phantom events" into "duplicate events", which is an excellent trade because duplicates are solvable at the consumer with a dedup key and lost events are not solvable at all.

```go
package outbox

import (
    "context"
    "database/sql"
    "time"
)

type OutboxMessage struct {
    ID          string
    AggregateID string
    EventType   string
    Payload     []byte
    CreatedAt   time.Time
    ProcessedAt *time.Time
}

type OutboxRepository struct {
    db *sql.DB
}

func NewOutboxRepository(db *sql.DB) *OutboxRepository {
    return &OutboxRepository{db: db}
}

// Store message in same transaction as business operation
func (r *OutboxRepository) StoreInTx(ctx context.Context, tx *sql.Tx, msg *OutboxMessage) error {
    query := `
        INSERT INTO outbox (id, aggregate_id, event_type, payload, created_at)
        VALUES ($1, $2, $3, $4, $5)
    `
    _, err := tx.ExecContext(ctx, query, msg.ID, msg.AggregateID, msg.EventType, msg.Payload, msg.CreatedAt)
    return err
}

// ClaimUnprocessed retrieves messages not yet published and LOCKS them for the
// life of tx. The caller MUST pass an open transaction and MUST hold it until
// the messages are published and marked. Passing *sql.DB here instead of
// *sql.Tx silently disables the locking entirely: see the note below.
func (r *OutboxRepository) ClaimUnprocessed(ctx context.Context, tx *sql.Tx, limit int) ([]*OutboxMessage, error) {
    query := `
        SELECT id, aggregate_id, event_type, payload, created_at
        FROM outbox
        WHERE processed_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    `

    rows, err := tx.QueryContext(ctx, query, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var messages []*OutboxMessage
    for rows.Next() {
        var msg OutboxMessage
        if err := rows.Scan(&msg.ID, &msg.AggregateID, &msg.EventType, &msg.Payload, &msg.CreatedAt); err != nil {
            return nil, err
        }
        messages = append(messages, &msg)
    }

    return messages, rows.Err()
}

// MarkProcessedInTx marks a message published, in the same tx that claimed it.
func (r *OutboxRepository) MarkProcessedInTx(ctx context.Context, tx *sql.Tx, id string) error {
    query := `UPDATE outbox SET processed_at = $1 WHERE id = $2`
    _, err := tx.ExecContext(ctx, query, time.Now(), id)
    return err
}

// Cleanup removes old processed messages
func (r *OutboxRepository) Cleanup(ctx context.Context, olderThan time.Duration) (int64, error) {
    query := `DELETE FROM outbox WHERE processed_at < $1`
    result, err := r.db.ExecContext(ctx, query, time.Now().Add(-olderThan))
    if err != nil {
        return 0, err
    }
    return result.RowsAffected()
}
```

### Outbox Publisher

The publisher is a background worker that polls for unprocessed rows using `FOR UPDATE SKIP LOCKED`. Read the transaction boundaries carefully, because they are the entire mechanism: one transaction spans claim, publish, mark, and commit. Holding the transaction open across the broker call is what stops a second replica from claiming the same rows. If the broker call fails the transaction rolls back, the row stays unprocessed, and it is retried on the next poll, giving at-least-once delivery.

```go
package outbox

import (
    "context"
    "log/slog"
    "time"
)

type MessagePublisher interface {
    Publish(ctx context.Context, topic string, key string, payload []byte) error
}

type OutboxPublisher struct {
    repo        *OutboxRepository
    publisher   MessagePublisher
    logger      *slog.Logger
    batchSize   int
    pollInterval time.Duration
}

func NewOutboxPublisher(repo *OutboxRepository, publisher MessagePublisher, logger *slog.Logger) *OutboxPublisher {
    return &OutboxPublisher{
        repo:         repo,
        publisher:    publisher,
        logger:       logger,
        batchSize:    100,
        pollInterval: time.Second,
    }
}

func (p *OutboxPublisher) Start(ctx context.Context) {
    ticker := time.NewTicker(p.pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := p.processBatch(ctx); err != nil {
                p.logger.Error("failed to process outbox batch", "error", err)
            }
        }
    }
}

func (p *OutboxPublisher) processBatch(ctx context.Context) error {
    // ONE transaction spans claim -> publish -> mark -> commit. The row locks
    // taken by ClaimUnprocessed live exactly as long as this tx, so a second
    // replica's SKIP LOCKED skips these rows for the whole publish window.
    tx, err := p.repo.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback() // no-op after a successful Commit

    messages, err := p.repo.ClaimUnprocessed(ctx, tx, p.batchSize)
    if err != nil {
        return err
    }
    if len(messages) == 0 {
        return nil
    }

    for _, msg := range messages {
        if err := p.publisher.Publish(ctx, msg.EventType, msg.AggregateID, msg.Payload); err != nil {
            // Roll the whole batch back. These rows stay unprocessed and are
            // retried next tick, by this replica or another one.
            p.logger.Error("failed to publish message",
                "id", msg.ID,
                "event_type", msg.EventType,
                "error", err,
            )
            return err
        }

        if err := p.repo.MarkProcessedInTx(ctx, tx, msg.ID); err != nil {
            return err
        }
    }

    // If we crash HERE, after publishing but before commit, the rows stay
    // unprocessed and get published again. That is at-least-once, and it is
    // why consumers must dedup. There is no way to remove this window.
    return tx.Commit()
}
```

> **`FOR UPDATE SKIP LOCKED` outside a transaction does nothing at all.** This is the single most dangerous line in the pattern, because the SQL is correct, the intent is correct, and the code is silently a no-op. The original wrote:
>
> ```go
> rows, err := r.db.QueryContext(ctx, `... FOR UPDATE SKIP LOCKED`, limit) // r.db, not a tx
> ```
>
> Row locks in PostgreSQL are held **until the end of the transaction**. Issue that query on a `*sql.DB` and there is no explicit transaction, so PostgreSQL runs it in implicit autocommit: the transaction begins and ends with the statement itself. The locks are acquired and released before `QueryContext` even returns. By the time your Go code iterates `rows`, nothing is locked. `SKIP LOCKED` then has nothing to skip, because no other replica's locks outlive their own SELECT either.
>
> Measured against PostgreSQL 18.4, five publisher replicas polling 100 unprocessed messages simultaneously with the original code:
>
> ```
> replica 0 claimed 100 messages
> replica 1 claimed 100 messages
> replica 4 claimed 100 messages
> messages claimed by MORE THAN ONE replica: 100
> => total broker publishes for 100 messages: 300
> ```
>
> Every message published three times. The claim that this "prevents two publisher instances from picking up the same message concurrently" is exactly false, and the `FOR UPDATE SKIP LOCKED` in the query is doing nothing but reassuring the reader. With the transaction added, the same test yields 100 publishes, zero duplicates, and the batches cleanly partitioned across replicas.
>
> This failure mode is nasty in a specific way: **it works perfectly with one replica.** You will not see it in development, in tests, or in staging with a single pod. It appears the day you scale the deployment to two, as a mysterious tripling of downstream events, and the code you would stare at contains the exact SQL incantation that is supposed to prevent it. Whenever you see `FOR UPDATE`, `SKIP LOCKED`, or `SELECT ... FOR SHARE`, the first question is always: *which transaction holds this lock, and when does it end?* If you cannot point at the `BeginTx`, the lock is not doing anything.
>
> A related trap is the opposite fix. Marking rows processed *before* publishing, or in a separate autocommit statement, converts the pattern from at-least-once to at-most-once: crash between mark and publish and the message is gone forever, with the row cheerfully claiming it was processed. The outbox exists to guarantee no event is lost. Duplicates are the price, and consumer-side dedup is how you pay it.

### Using Outbox in Business Logic

The key discipline here is that `s.outbox.StoreInTx` receives the active `*sql.Tx`, not the bare `*sql.DB`. This means the outbox row is written inside the same ACID transaction as the `orders` insert: either both rows commit together or both are rolled back. If the process crashes between commit and broker publish, the relay picks up the unprocessed outbox row on restart, no event is ever silently dropped.

```go
package order

import (
    "context"
    "database/sql"
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

type OrderService struct {
    db     *sql.DB
    outbox *outbox.OutboxRepository
}

func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Insert order
    query := `INSERT INTO orders (id, user_id, total_cents, status) VALUES ($1, $2, $3, $4)`
    _, err = tx.ExecContext(ctx, query, order.ID, order.UserID, order.TotalCents, "pending")
    if err != nil {
        return err
    }

    // Create outbox message in same transaction
    event := OrderCreatedEvent{
        OrderID:    order.ID,
        UserID:     order.UserID,
        TotalCents: order.TotalCents,
    }
    eventData, _ := json.Marshal(event)

    outboxMsg := &outbox.OutboxMessage{
        ID:          uuid.New().String(),
        AggregateID: order.ID,
        EventType:   "order.created",
        Payload:     eventData,
        CreatedAt:   time.Now(),
    }

    if err := s.outbox.StoreInTx(ctx, tx, outboxMsg); err != nil {
        return err
    }

    return tx.Commit()
}
```

### Staff Lens: Outbox for Guaranteed Publishing

The outbox pattern guarantees that if the database commit succeeds, the event is eventually published at least once, and that no event is ever published for a write that did not commit. Essential for event-driven architectures where "database written but event lost" is unacceptable.

State the guarantee in exactly those words in a design review. "The outbox gives us exactly-once" is wrong and will mislead every consumer team that hears it into skipping their dedup logic, which is where the real incident comes from. The honest sentence is: *no event is lost, no phantom events, duplicates are possible, so every consumer must be idempotent.* The outbox is one half of a contract, and the consumer's dedup key is the other half. Ship them together or you have shipped neither.

---
