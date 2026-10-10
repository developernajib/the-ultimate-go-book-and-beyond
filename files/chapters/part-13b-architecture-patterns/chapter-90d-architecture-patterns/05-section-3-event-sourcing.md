## 90D.4 Event Sourcing

Event Sourcing stores state as an append-only sequence of immutable events rather than as a mutable current-state record. To load an entity you replay its events from the beginning (or from a snapshot), which means you get a complete audit trail and the ability to time-travel to any past state for free. The aggregate does not expose setters. Instead each business operation records a new event and immediately applies it to update the in-memory state. The event store uses optimistic concurrency (an `expectedVersion` check) to reject concurrent writes that would create conflicts. The `BankAccount` aggregate below illustrates all three concerns: recording events, applying them to update state, and reconstituting an aggregate from a stored event stream.

```go
package eventsourcing

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// ─── Event Store ───

type StoredEvent struct {
	ID          string
	AggregateID string
	Type        string
	Version     int
	Data        json.RawMessage
	Metadata    map[string]string
	OccurredAt  time.Time
}

type EventStore interface {
	Append(ctx context.Context, aggregateID string, expectedVersion int, events []StoredEvent) error
	Load(ctx context.Context, aggregateID string) ([]StoredEvent, error)
	LoadFrom(ctx context.Context, aggregateID string, version int) ([]StoredEvent, error)
}

// ─── Aggregate ───

type AggregateBase struct {
	id      string
	version int
	changes []StoredEvent
}

func (a *AggregateBase) ID() string      { return a.id }
func (a *AggregateBase) Version() int    { return a.version }
func (a *AggregateBase) Changes() []StoredEvent { return a.changes }

func (a *AggregateBase) recordChange(eventType string, data any) {
	raw, _ := json.Marshal(data)
	a.changes = append(a.changes, StoredEvent{
		ID:          fmt.Sprintf("%s-%d", a.id, a.version+len(a.changes)+1),
		AggregateID: a.id,
		Type:        eventType,
		Version:     a.version + len(a.changes) + 1,
		Data:        raw,
		OccurredAt:  time.Now(),
	})
}

// ─── Bank Account Aggregate ───

type BankAccount struct {
	AggregateBase
	OwnerID string
	Balance int64
	Closed  bool
}

// Events
type AccountOpenedEvent struct {
	OwnerID        string
	InitialDeposit int64
}

type MoneyDepositedEvent struct {
	Amount int64
}

type MoneyWithdrawnEvent struct {
	Amount int64
}

type AccountClosedEvent struct{}

// Commands
func OpenAccount(ownerID string, initialDeposit int64) (*BankAccount, error) {
	if initialDeposit < 0 {
		return nil, fmt.Errorf("initial deposit cannot be negative")
	}

	acc := &BankAccount{}
	acc.id = generateAccountID()
	acc.apply(AccountOpenedEvent{OwnerID: ownerID, InitialDeposit: initialDeposit})
	return acc, nil
}

func (a *BankAccount) Deposit(amount int64) error {
	if amount <= 0 {
		return fmt.Errorf("deposit amount must be positive")
	}
	if a.Closed {
		return fmt.Errorf("account is closed")
	}
	a.apply(MoneyDepositedEvent{Amount: amount})
	return nil
}

func (a *BankAccount) Withdraw(amount int64) error {
	if amount <= 0 {
		return fmt.Errorf("withdrawal amount must be positive")
	}
	if a.Closed {
		return fmt.Errorf("account is closed")
	}
	if a.Balance < amount {
		return fmt.Errorf("insufficient funds: balance=%d amount=%d", a.Balance, amount)
	}
	a.apply(MoneyWithdrawnEvent{Amount: amount})
	return nil
}

func (a *BankAccount) Close() error {
	if a.Closed {
		return fmt.Errorf("account already closed")
	}
	a.apply(AccountClosedEvent{})
	return nil
}

// apply records the event AND updates the in-memory state
func (a *BankAccount) apply(event any) {
	// Update state
	switch e := event.(type) {
	case AccountOpenedEvent:
		a.OwnerID = e.OwnerID
		a.Balance = e.InitialDeposit
	case MoneyDepositedEvent:
		a.Balance += e.Amount
	case MoneyWithdrawnEvent:
		a.Balance -= e.Amount
	case AccountClosedEvent:
		a.Closed = true
	}

	// Record for persistence
	a.recordChange(eventTypeName(event), event)
}

// Reconstitute rebuilds aggregate from stored events
func ReconstituteBankAccount(events []StoredEvent) (*BankAccount, error) {
	acc := &BankAccount{}

	for _, stored := range events {
		var event any
		switch stored.Type {
		case "AccountOpened":
			var e AccountOpenedEvent
			json.Unmarshal(stored.Data, &e)
			event = e
		case "MoneyDeposited":
			var e MoneyDepositedEvent
			json.Unmarshal(stored.Data, &e)
			event = e
		case "MoneyWithdrawn":
			var e MoneyWithdrawnEvent
			json.Unmarshal(stored.Data, &e)
			event = e
		case "AccountClosed":
			event = AccountClosedEvent{}
		default:
			return nil, fmt.Errorf("unknown event type: %s", stored.Type)
		}

		// Apply without recording (already persisted)
		switch e := event.(type) {
		case AccountOpenedEvent:
			acc.id = stored.AggregateID
			acc.OwnerID = e.OwnerID
			acc.Balance = e.InitialDeposit
		case MoneyDepositedEvent:
			acc.Balance += e.Amount
		case MoneyWithdrawnEvent:
			acc.Balance -= e.Amount
		case AccountClosedEvent:
			acc.Closed = true
		}
		acc.version = stored.Version
	}

	return acc, nil
}

func eventTypeName(event any) string {
	switch event.(type) {
	case AccountOpenedEvent:
		return "AccountOpened"
	case MoneyDepositedEvent:
		return "MoneyDeposited"
	case MoneyWithdrawnEvent:
		return "MoneyWithdrawn"
	case AccountClosedEvent:
		return "AccountClosed"
	default:
		return "Unknown"
	}
}

func generateAccountID() string {
	return fmt.Sprintf("acc-%d", time.Now().UnixNano())
}

// ─── Repository ───

type BankAccountRepository struct {
	store EventStore
}

func NewBankAccountRepository(store EventStore) *BankAccountRepository {
	return &BankAccountRepository{store: store}
}

func (r *BankAccountRepository) Save(ctx context.Context, acc *BankAccount) error {
	if len(acc.Changes()) == 0 {
		return nil
	}

	if err := r.store.Append(ctx, acc.ID(), acc.Version(), acc.Changes()); err != nil {
		return fmt.Errorf("append events: %w", err)
	}

	// Clear recorded changes
	acc.version += len(acc.changes)
	acc.changes = nil
	return nil
}

func (r *BankAccountRepository) FindByID(ctx context.Context, id string) (*BankAccount, error) {
	events, err := r.store.Load(ctx, id)
	if err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, fmt.Errorf("account not found: %s", id)
	}
	return ReconstituteBankAccount(events)
}

// ─── In-Memory Event Store ───

type InMemoryEventStore struct {
	mu     sync.RWMutex
	events map[string][]StoredEvent
}

func NewInMemoryEventStore() *InMemoryEventStore {
	return &InMemoryEventStore{events: make(map[string][]StoredEvent)}
}

func (s *InMemoryEventStore) Append(ctx context.Context, aggregateID string, expectedVersion int, events []StoredEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing := s.events[aggregateID]

	// Optimistic concurrency check
	if len(existing) != expectedVersion {
		return fmt.Errorf("concurrency conflict: expected version %d, actual %d",
			expectedVersion, len(existing))
	}

	s.events[aggregateID] = append(existing, events...)
	return nil
}

func (s *InMemoryEventStore) Load(ctx context.Context, aggregateID string) ([]StoredEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	events, ok := s.events[aggregateID]
	if !ok {
		return nil, nil
	}

	result := make([]StoredEvent, len(events))
	copy(result, events)
	return result, nil
}

func (s *InMemoryEventStore) LoadFrom(ctx context.Context, aggregateID string, version int) ([]StoredEvent, error) {
	all, err := s.Load(ctx, aggregateID)
	if err != nil {
		return nil, err
	}

	var result []StoredEvent
	for _, e := range all {
		if e.Version > version {
			result = append(result, e)
		}
	}
	return result, nil
}
```

---
