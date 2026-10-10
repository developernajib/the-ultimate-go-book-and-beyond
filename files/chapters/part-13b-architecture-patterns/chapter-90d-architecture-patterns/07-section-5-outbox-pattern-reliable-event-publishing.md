## 90D.6 Outbox Pattern: Reliable Event Publishing

The Outbox pattern eliminates the dual-write race condition where a service updates its database but then fails before publishing the corresponding event. Instead of writing to the database and the message broker in two separate operations, you write the domain change and the outbox record inside a single database transaction. A separate relay process polls the `outbox_events` table and publishes pending records to the broker, marking each as published only after receiving an acknowledgment. This guarantees at-least-once delivery. If the relay crashes mid-way, it will retry from the last unpublished record. The `FOR UPDATE SKIP LOCKED` clause in the fetch query is critical. It allows multiple relay instances to run concurrently without stepping on each other, which is what makes this approach horizontally scalable.

```go
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"
)

// OutboxEvent is stored atomically with the domain change
type OutboxEvent struct {
	ID          string
	AggregateID string
	Type        string
	Payload     json.RawMessage
	Status      string // "pending", "published", "failed"
	CreatedAt   time.Time
	PublishedAt *time.Time
	Retries     int
}

// OutboxRepository manages outbox events
type OutboxRepository struct {
	db *sql.DB
}

func NewOutboxRepository(db *sql.DB) *OutboxRepository {
	return &OutboxRepository{db: db}
}

// SaveWithinTransaction saves domain entity AND outbox event in one transaction
func (r *OutboxRepository) SaveWithinTransaction(
	ctx context.Context,
	tx *sql.Tx,
	event OutboxEvent,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO outbox_events (id, aggregate_id, type, payload, status, created_at)
		VALUES ($1, $2, $3, $4, 'pending', $5)
	`, event.ID, event.AggregateID, event.Type, event.Payload, event.CreatedAt)
	return err
}

// FetchPending claims unpublished events for relay. It takes the caller's
// transaction because FOR UPDATE SKIP LOCKED holds its row locks only for
// the life of the enclosing transaction. Called on the bare *sql.DB the
// locks vanish when the SELECT returns, and two relay instances would
// claim and double-publish the same rows.
func (r *OutboxRepository) FetchPending(ctx context.Context, tx *sql.Tx, limit int) ([]OutboxEvent, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, aggregate_id, type, payload, status, created_at, retries
		FROM outbox_events
		WHERE status = 'pending'
		ORDER BY created_at
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []OutboxEvent
	for rows.Next() {
		var e OutboxEvent
		rows.Scan(&e.ID, &e.AggregateID, &e.Type, &e.Payload, &e.Status, &e.CreatedAt, &e.Retries)
		events = append(events, e)
	}
	return events, rows.Err()
}

// MarkPublished marks an event as successfully published, inside the same
// transaction that claimed it.
func (r *OutboxRepository) MarkPublished(ctx context.Context, tx *sql.Tx, id string) error {
	now := time.Now()
	_, err := tx.ExecContext(ctx, `
		UPDATE outbox_events SET status = 'published', published_at = $1 WHERE id = $2
	`, now, id)
	return err
}

// MarkFailed increments retry count, marks as failed after max retries
func (r *OutboxRepository) MarkFailed(ctx context.Context, id string, maxRetries int) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE outbox_events
		SET retries = retries + 1,
		    status = CASE WHEN retries + 1 >= $1 THEN 'failed' ELSE 'pending' END
		WHERE id = $2
	`, maxRetries, id)
	return err
}

// OutboxRelay reads pending events and publishes them to the message bus
type OutboxRelay struct {
	repo      *OutboxRepository
	publisher MessagePublisher
	logger    *slog.Logger
	batchSize int
	interval  time.Duration
	maxRetries int
}

type MessagePublisher interface {
	Publish(ctx context.Context, topic string, key string, value []byte) error
}

func NewOutboxRelay(repo *OutboxRepository, publisher MessagePublisher) *OutboxRelay {
	return &OutboxRelay{
		repo:       repo,
		publisher:  publisher,
		logger:     slog.Default(),
		batchSize:  100,
		interval:   1 * time.Second,
		maxRetries: 5,
	}
}

// Run starts the relay loop
func (r *OutboxRelay) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.relay(ctx)
		}
	}
}

func (r *OutboxRelay) relay(ctx context.Context) {
	// One transaction spans claim, publish, and mark so the SKIP LOCKED row
	// locks are held for the whole cycle. A crash after publish but before
	// commit re-delivers, which is why consumers dedupe on the event ID.
	tx, err := r.repo.db.BeginTx(ctx, nil)
	if err != nil {
		r.logger.Error("begin outbox tx", "error", err)
		return
	}
	defer tx.Rollback()

	events, err := r.repo.FetchPending(ctx, tx, r.batchSize)
	if err != nil {
		r.logger.Error("fetch pending events", "error", err)
		return
	}

	for _, event := range events {
		if err := r.publisher.Publish(ctx, event.Type, event.AggregateID, event.Payload); err != nil {
			r.logger.Error("publish event",
				"id", event.ID, "type", event.Type, "error", err)
			r.repo.MarkFailed(ctx, event.ID, r.maxRetries)
			continue
		}

		if err := r.repo.MarkPublished(ctx, tx, event.ID); err != nil {
			r.logger.Error("mark published", "id", event.ID, "error", err)
			return
		}
		r.logger.Info("published outbox event", "id", event.ID, "type", event.Type)
	}

	if err := tx.Commit(); err != nil {
		r.logger.Error("commit outbox tx", "error", err)
	}
}
```

---
