## 52H.7 Redis Streams Patterns - Event Sourcing & CQRS

In event sourcing, state is derived by replaying an immutable sequence of events. Redis Streams fit this pattern well: they are append-only, ordered, and replayable from any point via `XRANGE`. CQRS separates the write model (commands that produce events) from the read model (projections that materialize current state from those events).

The example below implements a bank account using event sourcing on Redis Streams. The `AccountEventStore` appends domain events (`deposit`, `withdraw`, `created`) to a per-account stream. The `Reconstitute` function rebuilds current account state by replaying all events in order. On the read side, `AccountProjection` maintains a denormalized view in a Redis Hash, updated incrementally by a `ProjectionWorker` that consumes the event stream through a consumer group. This separation means the write path only appends events (fast, simple), while the read path can be optimized independently and rebuilt at any time by replaying the event log.

```go
// file: internal/redis/eventsourcing/account.go
package eventsourcing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// EventType classifies account domain events.
type EventType string

const (
	EventDeposit    EventType = "account.deposit"
	EventWithdraw   EventType = "account.withdraw"
	EventCreated    EventType = "account.created"
)

// AccountEvent is the domain event written to the stream.
type AccountEvent struct {
	Type      EventType `json:"type"`
	AccountID string    `json:"account_id"`
	Amount    int64     `json:"amount_cents"`
	Currency  string    `json:"currency"`
	Timestamp time.Time `json:"timestamp"`
	Actor     string    `json:"actor"`
}

// AccountState is the current projection of an account.
type AccountState struct {
	AccountID    string
	BalanceCents int64
	Currency     string
	TxCount      int
	LastUpdated  time.Time
}

// ErrInsufficientFunds is returned when a withdrawal exceeds balance.
var ErrInsufficientFunds = errors.New("insufficient funds")

// AccountEventStore is the write-side repository.
type AccountEventStore struct {
	client *redis.Client
	logger *slog.Logger
}

// NewAccountEventStore creates the write-side store.
func NewAccountEventStore(client *redis.Client, logger *slog.Logger) *AccountEventStore {
	return &AccountEventStore{client: client, logger: logger}
}

// streamKey returns the Redis Streams key for an account.
func streamKey(accountID string) string {
	return fmt.Sprintf("events:account:%s", accountID)
}

// Append adds an event to the account's event stream.
func (s *AccountEventStore) Append(ctx context.Context, event AccountEvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", fmt.Errorf("marshaling event: %w", err)
	}

	id, err := s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(event.AccountID),
		ID:     "*",
		Values: map[string]any{
			"type":      string(event.Type),
			"data":      string(data),
			"timestamp": event.Timestamp.UnixMilli(),
		},
	}).Result()

	if err != nil {
		return "", fmt.Errorf("xadd event for account %s: %w", event.AccountID, err)
	}

	s.logger.Debug("event appended",
		slog.String("account_id", event.AccountID),
		slog.String("type", string(event.Type)),
		slog.String("stream_id", id),
	)
	return id, nil
}

// LoadEvents reads all events for an account from the stream.
func (s *AccountEventStore) LoadEvents(ctx context.Context, accountID string) ([]AccountEvent, error) {
	messages, err := s.client.XRange(ctx, streamKey(accountID), "-", "+").Result()
	if err != nil {
		return nil, fmt.Errorf("xrange account %s: %w", accountID, err)
	}

	events := make([]AccountEvent, 0, len(messages))
	for _, msg := range messages {
		dataStr, ok := msg.Values["data"].(string)
		if !ok {
			continue
		}
		var event AccountEvent
		if err := json.Unmarshal([]byte(dataStr), &event); err != nil {
			s.logger.Error("failed to unmarshal event",
				slog.String("id", msg.ID),
				slog.String("error", err.Error()),
			)
			continue
		}
		events = append(events, event)
	}

	return events, nil
}

// Reconstitute rebuilds the current account state by replaying events.
func Reconstitute(events []AccountEvent) (AccountState, error) {
	var state AccountState

	for _, e := range events {
		switch e.Type {
		case EventCreated:
			state.AccountID = e.AccountID
			state.Currency = e.Currency
			state.BalanceCents = 0

		case EventDeposit:
			state.BalanceCents += e.Amount
			state.TxCount++
			state.LastUpdated = e.Timestamp

		case EventWithdraw:
			if state.BalanceCents < e.Amount {
				return state, fmt.Errorf("%w: have %d, need %d", ErrInsufficientFunds, state.BalanceCents, e.Amount)
			}
			state.BalanceCents -= e.Amount
			state.TxCount++
			state.LastUpdated = e.Timestamp
		}
	}

	return state, nil
}

// AccountProjection is the read-side CQRS projection stored in Redis Hash.
type AccountProjection struct {
	client *redis.Client
	logger *slog.Logger
}

// NewAccountProjection creates the read-side projection.
func NewAccountProjection(client *redis.Client, logger *slog.Logger) *AccountProjection {
	return &AccountProjection{client: client, logger: logger}
}

// projectionKey returns the Redis Hash key for an account's projection.
func projectionKey(accountID string) string {
	return fmt.Sprintf("projection:account:%s", accountID)
}

// Update applies a new event to the projection (consumer group handler).
func (p *AccountProjection) Update(ctx context.Context, event AccountEvent) error {
	key := projectionKey(event.AccountID)

	pipe := p.client.TxPipeline()

	switch event.Type {
	case EventCreated:
		pipe.HSet(ctx, key,
			"account_id", event.AccountID,
			"balance_cents", 0,
			"currency", event.Currency,
			"tx_count", 0,
			"last_updated", event.Timestamp.UnixMilli(),
		)

	case EventDeposit:
		pipe.HIncrBy(ctx, key, "balance_cents", event.Amount)
		pipe.HIncrBy(ctx, key, "tx_count", 1)
		pipe.HSet(ctx, key, "last_updated", event.Timestamp.UnixMilli())

	case EventWithdraw:
		pipe.HIncrBy(ctx, key, "balance_cents", -event.Amount)
		pipe.HIncrBy(ctx, key, "tx_count", 1)
		pipe.HSet(ctx, key, "last_updated", event.Timestamp.UnixMilli())
	}

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("updating projection for account %s: %w", event.AccountID, err)
	}

	p.logger.Debug("projection updated",
		slog.String("account_id", event.AccountID),
		slog.String("event_type", string(event.Type)),
	)
	return nil
}

// Get retrieves the current state projection for an account.
func (p *AccountProjection) Get(ctx context.Context, accountID string) (*AccountState, error) {
	fields, err := p.client.HGetAll(ctx, projectionKey(accountID)).Result()
	if err != nil {
		return nil, fmt.Errorf("hgetall projection %s: %w", accountID, err)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("account %s not found", accountID)
	}

	balance, _ := strconv.ParseInt(fields["balance_cents"], 10, 64)
	txCount, _ := strconv.Atoi(fields["tx_count"])
	lastUpdatedMs, _ := strconv.ParseInt(fields["last_updated"], 10, 64)

	return &AccountState{
		AccountID:    fields["account_id"],
		BalanceCents: balance,
		Currency:     fields["currency"],
		TxCount:      txCount,
		LastUpdated:  time.UnixMilli(lastUpdatedMs),
	}, nil
}

// ProjectionWorker consumes the account events stream and updates projections.
type ProjectionWorker struct {
	consumer   *GroupConsumer
	projection *AccountProjection
	eventStore *AccountEventStore
	logger     *slog.Logger
}

// NewProjectionWorker wires up the consumer and projection.
func NewProjectionWorker(
	ctx context.Context,
	client *redis.Client,
	accountID string,
	projection *AccountProjection,
	eventStore *AccountEventStore,
	logger *slog.Logger,
) (*ProjectionWorker, error) {
	stream := streamKey(accountID)
	consumer, err := NewGroupConsumer(
		ctx, client,
		stream, "projection-workers", "worker-1",
		10, 2*time.Second,
		logger,
	)
	if err != nil {
		return nil, err
	}

	return &ProjectionWorker{
		consumer:   consumer,
		projection: projection,
		eventStore: eventStore,
		logger:     logger,
	}, nil
}

// Run starts the projection worker loop.
func (w *ProjectionWorker) Run(ctx context.Context) error {
	return w.consumer.ProcessLoop(ctx, func(ctx context.Context, msg redis.XMessage) error {
		dataStr, ok := msg.Values["data"].(string)
		if !ok {
			return fmt.Errorf("missing data field in message %s", msg.ID)
		}

		var event AccountEvent
		if err := json.Unmarshal([]byte(dataStr), &event); err != nil {
			return fmt.Errorf("unmarshal event %s: %w", msg.ID, err)
		}

		return w.projection.Update(ctx, event)
	})
}
```

### Junior -> FAANG: Understanding Event Sourcing Before Applying It

Event sourcing is a pattern with real advantages and real costs. Before applying it, understand both sides clearly.

The advantage: the event stream is the authoritative source of truth. If your `AccountProjection` has a bug and produces wrong balances, you fix the bug and replay the events to rebuild a correct projection. No data is lost. This is genuinely powerful for financial systems, audit trails, and any domain where historical accuracy matters.

The cost: reading current state requires replaying all events unless you add snapshots. The `Reconstitute` function above reads all events from `XRANGE stream - +` and applies them in order. For an account with 10,000 events, that is 10,000 Redis reads bundled into one `XRANGE` call. This is fast for small event counts but becomes the system's bottleneck as aggregates age.

The snapshot optimization mentioned in the exercises is mandatory for any event-sourced system that goes to production: after N events, write the current state to a separate key (e.g., a Redis Hash) and record the stream ID of the last event included in the snapshot. On load, read the snapshot first, then replay only events with IDs greater than the snapshot's last event ID. Without snapshots, `Reconstitute` becomes O(event-count) and old aggregates become unusably slow to load.

Implement the snapshot and test it before claiming the pattern is production-ready.

### Senior @ FAANG: Event Sourcing Maturity Model and Redis Streams Trade-offs

Event sourcing on Redis Streams is a pragmatic choice for teams that already operate Redis and need a lightweight event log. But the pattern has architectural implications that grow in importance as the system matures, and a staff engineer should evaluate them explicitly before committing the team.

The first implication is projection rebuild time. The `AccountProjection` is rebuilt by replaying `XRANGE stream - +` from the beginning. If the event stream has millions of entries and Redis is at memory capacity, `XRANGE` on the full stream may exceed available memory for the result set. The mitigation is cursor-based pagination via `XRANGEBYID` with a batch size, but that turns a simple projection rebuild into a multi-hour operational procedure. For event stores with long-lived aggregates or high event rates, a dedicated time-series database or an append-only Postgres table with WAL-based streaming is a better projection source than Redis Streams.

The second implication is the `Reconstitute` function's handling of unknown event types. The switch statement silently skips any `EventType` not in the case list. This means a new event type introduced by a newer service version is silently ignored during reconstitution, producing an incorrect state without an error. In a production event-sourced system, unknown event types should either fail loudly (preferred for critical aggregates) or be logged as warnings and preserved in state (for non-critical fields). The handling strategy is an ADR decision that should be made explicitly and encoded in the `Reconstitute` function's contract.

The third implication is optimistic concurrency. The `AccountEventStore.Append` method uses `XADD` with auto-ID, which provides no protection against two writers appending conflicting events simultaneously. For example, two concurrent withdrawal requests can both pass the balance check and both append `EventWithdraw` events, resulting in a negative balance after reconstitution. The correct fix is to use a Lua script that checks the current stream length (or last event ID) before appending, treating the stream length as a version number. This is the Redis Streams equivalent of optimistic concurrency control in Postgres. The exercise at the end of the chapter specifies this as a requirement: implement it before deploying any financial event-sourcing system to production.

For the CQRS read model, the `AccountProjection.Update` method uses `TxPipeline` to make projection updates atomic. This is correct for single-aggregate updates, but if a projection must update multiple aggregates in response to a single event (fan-out projections), the atomic boundary extends across multiple keys and `TxPipeline` does not help unless all keys are on the same Redis node (which is not guaranteed in Redis Cluster). The platform-level solution is either to keep projections single-aggregate or to use Lua scripts for multi-key atomic updates with careful key co-location via hash tags.

---
