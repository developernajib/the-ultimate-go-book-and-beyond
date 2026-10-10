## 52D.6 Implementing Event Sourcing in Go

### The Event-Sourced Aggregate

An event-sourced aggregate works differently from a traditional aggregate:

1. When state changes, the aggregate **produces events** (does not modify state directly)
2. State is modified **only through applying events** - both for new events and replayed history
3. The aggregate can **load its state from a history of events**

```go
// internal/domain/account/account.go

package account

import (
    "errors"
    "fmt"
    "time"
)

// AccountID is the identity of a bank account.
type AccountID string

// AccountStatus represents the lifecycle of an account.
type AccountStatus string

const (
    AccountStatusActive  AccountStatus = "active"
    AccountStatusClosed  AccountStatus = "closed"
    AccountStatusFrozen  AccountStatus = "frozen"
)

var (
    ErrInsufficientFunds   = errors.New("insufficient funds for this transaction")
    ErrAccountClosed       = errors.New("account is closed")
    ErrAccountFrozen       = errors.New("account is frozen and cannot process transactions")
    ErrNegativeAmount      = errors.New("transaction amount must be positive")
    ErrAccountNotFound     = errors.New("account not found")
    ErrConcurrencyConflict = errors.New("account modified concurrently")
)

// Account is an event-sourced aggregate representing a bank account.
type Account struct {
    id              AccountID
    ownerID         CustomerID
    balanceCents    int64
    currency        string
    status          AccountStatus
    version         int        // aggregate version for optimistic concurrency
    uncommitted     []DomainEvent // events not yet persisted
}

// NewAccount creates a new bank account.
// Does NOT set state directly - instead records an AccountOpened event.
func NewAccount(id AccountID, ownerID CustomerID, currency string) (*Account, error) {
    if id == "" {
        return nil, errors.New("account ID is required")
    }
    if ownerID == "" {
        return nil, errors.New("owner ID is required")
    }
    if currency == "" {
        return nil, errors.New("currency is required")
    }

    a := &Account{}
    // Apply the event - this sets the state
    a.apply(AccountOpened{
        AccountID: id,
        OwnerID:   ownerID,
        Currency:  currency,
        OpenedAt:  time.Now(),
    }, true) // true = record as uncommitted
    return a, nil
}

// LoadFromHistory reconstitutes an Account from its event history.
// This is called by the repository when loading from the event store.
func LoadFromHistory(events []DomainEvent) (*Account, error) {
    if len(events) == 0 {
        return nil, errors.New("cannot load account from empty event history")
    }
    a := &Account{}
    for _, event := range events {
        a.apply(event, false) // false = historical event, don't record as uncommitted
        a.version++
    }
    return a, nil
}

// apply routes an event to the correct state mutation method.
// This is the central event application dispatcher.
func (a *Account) apply(event DomainEvent, isNew bool) {
    switch e := event.(type) {
    case AccountOpened:
        a.applyAccountOpened(e)
    case MoneyDeposited:
        a.applyMoneyDeposited(e)
    case MoneyWithdrawn:
        a.applyMoneyWithdrawn(e)
    case AccountFrozen:
        a.applyAccountFrozen(e)
    case AccountUnfrozen:
        a.applyAccountUnfrozen(e)
    case AccountClosed:
        a.applyAccountClosed(e)
    }

    if isNew {
        a.uncommitted = append(a.uncommitted, event)
    }
}

// ── State mutation methods (called only by apply) ──────────────────────

func (a *Account) applyAccountOpened(e AccountOpened) {
    a.id       = e.AccountID
    a.ownerID  = e.OwnerID
    a.currency = e.Currency
    a.status   = AccountStatusActive
    a.balanceCents = 0
}

func (a *Account) applyMoneyDeposited(e MoneyDeposited) {
    a.balanceCents += e.AmountCents
}

func (a *Account) applyMoneyWithdrawn(e MoneyWithdrawn) {
    a.balanceCents -= e.AmountCents
}

func (a *Account) applyAccountFrozen(_ AccountFrozen) {
    a.status = AccountStatusFrozen
}

func (a *Account) applyAccountUnfrozen(_ AccountUnfrozen) {
    a.status = AccountStatusActive
}

func (a *Account) applyAccountClosed(_ AccountClosed) {
    a.status = AccountStatusClosed
}

// ── Domain operations (business logic) ────────────────────────────────

// Deposit deposits money into the account.
func (a *Account) Deposit(amountCents int64, reference string) error {
    if a.status != AccountStatusActive {
        return fmt.Errorf("cannot deposit: %w", a.statusError())
    }
    if amountCents <= 0 {
        return ErrNegativeAmount
    }
    a.apply(MoneyDeposited{
        AccountID:    a.id,
        AmountCents:  amountCents,
        Currency:     a.currency,
        Reference:    reference,
        DepositedAt:  time.Now(),
        BalanceAfter: a.balanceCents + amountCents,
    }, true)
    return nil
}

// Withdraw withdraws money from the account.
func (a *Account) Withdraw(amountCents int64, reference string) error {
    if a.status != AccountStatusActive {
        return fmt.Errorf("cannot withdraw: %w", a.statusError())
    }
    if amountCents <= 0 {
        return ErrNegativeAmount
    }
    if a.balanceCents < amountCents {
        return fmt.Errorf("%w: balance %d, requested %d", ErrInsufficientFunds, a.balanceCents, amountCents)
    }
    a.apply(MoneyWithdrawn{
        AccountID:    a.id,
        AmountCents:  amountCents,
        Currency:     a.currency,
        Reference:    reference,
        WithdrawnAt:  time.Now(),
        BalanceAfter: a.balanceCents - amountCents,
    }, true)
    return nil
}

// Freeze freezes the account, preventing transactions.
func (a *Account) Freeze(reason string) error {
    if a.status == AccountStatusClosed {
        return ErrAccountClosed
    }
    if a.status == AccountStatusFrozen {
        return nil // idempotent
    }
    a.apply(AccountFrozen{
        AccountID: a.id,
        Reason:    reason,
        FrozenAt:  time.Now(),
    }, true)
    return nil
}

// Close closes the account permanently.
func (a *Account) Close(reason string) error {
    if a.status == AccountStatusClosed {
        return nil // idempotent
    }
    if a.balanceCents != 0 {
        return errors.New("cannot close account with non-zero balance")
    }
    a.apply(AccountClosed{
        AccountID: a.id,
        Reason:    reason,
        ClosedAt:  time.Now(),
    }, true)
    return nil
}

// ── Accessors ──────────────────────────────────────────────────────────

func (a *Account) ID() AccountID           { return a.id }
func (a *Account) OwnerID() CustomerID     { return a.ownerID }
func (a *Account) BalanceCents() int64     { return a.balanceCents }
func (a *Account) Currency() string        { return a.currency }
func (a *Account) Status() AccountStatus   { return a.status }
func (a *Account) Version() int            { return a.version }

// UncommittedEvents returns and clears the list of new, unpersisted events.
func (a *Account) UncommittedEvents() []DomainEvent {
    events := make([]DomainEvent, len(a.uncommitted))
    copy(events, a.uncommitted)
    a.uncommitted = nil
    return events
}

func (a *Account) statusError() error {
    switch a.status {
    case AccountStatusClosed:
        return ErrAccountClosed
    case AccountStatusFrozen:
        return ErrAccountFrozen
    default:
        return fmt.Errorf("account in unexpected status: %s", a.status)
    }
}
```

### Domain Events for the Account Aggregate

Each event type implements the `DomainEvent` interface, providing its name for serialization dispatch, its aggregate ID for stream routing, and its timestamp for ordering. The events carry only the data needed to reconstruct state changes, no derived or redundant fields beyond `BalanceAfter`, which is intentionally denormalized to simplify projections.

```go
// internal/domain/account/events.go

package account

import "time"

// DomainEvent is the marker interface for account domain events.
type DomainEvent interface {
    EventName() string
    AggregateID() AccountID
    OccurredAt() time.Time
}

// AccountOpened is raised when a new bank account is opened.
type AccountOpened struct {
    AccountID AccountID
    OwnerID   CustomerID
    Currency  string
    OpenedAt  time.Time
}
func (e AccountOpened) EventName() string      { return "account.opened" }
func (e AccountOpened) AggregateID() AccountID { return e.AccountID }
func (e AccountOpened) OccurredAt() time.Time  { return e.OpenedAt }

// MoneyDeposited is raised when money is deposited into an account.
type MoneyDeposited struct {
    AccountID    AccountID
    AmountCents  int64
    Currency     string
    Reference    string
    DepositedAt  time.Time
    BalanceAfter int64 // denormalized for easy projection
}
func (e MoneyDeposited) EventName() string      { return "account.money_deposited" }
func (e MoneyDeposited) AggregateID() AccountID { return e.AccountID }
func (e MoneyDeposited) OccurredAt() time.Time  { return e.DepositedAt }

// MoneyWithdrawn is raised when money is withdrawn from an account.
type MoneyWithdrawn struct {
    AccountID    AccountID
    AmountCents  int64
    Currency     string
    Reference    string
    WithdrawnAt  time.Time
    BalanceAfter int64
}
func (e MoneyWithdrawn) EventName() string      { return "account.money_withdrawn" }
func (e MoneyWithdrawn) AggregateID() AccountID { return e.AccountID }
func (e MoneyWithdrawn) OccurredAt() time.Time  { return e.WithdrawnAt }

// AccountFrozen is raised when an account is frozen.
type AccountFrozen struct {
    AccountID AccountID
    Reason    string
    FrozenAt  time.Time
}
func (e AccountFrozen) EventName() string      { return "account.frozen" }
func (e AccountFrozen) AggregateID() AccountID { return e.AccountID }
func (e AccountFrozen) OccurredAt() time.Time  { return e.FrozenAt }

// AccountUnfrozen is raised when a frozen account is unfrozen.
type AccountUnfrozen struct {
    AccountID   AccountID
    UnfrozenAt  time.Time
}
func (e AccountUnfrozen) EventName() string      { return "account.unfrozen" }
func (e AccountUnfrozen) AggregateID() AccountID { return e.AccountID }
func (e AccountUnfrozen) OccurredAt() time.Time  { return e.UnfrozenAt }

// AccountClosed is raised when an account is permanently closed.
type AccountClosed struct {
    AccountID AccountID
    Reason    string
    ClosedAt  time.Time
}
func (e AccountClosed) EventName() string      { return "account.closed" }
func (e AccountClosed) AggregateID() AccountID { return e.AccountID }
func (e AccountClosed) OccurredAt() time.Time  { return e.ClosedAt }
```

### Junior → FAANG: Reading the Aggregate as a State Machine

The `Account` aggregate in this section is a state machine expressed as a Go struct. Every public method (`Deposit`, `Withdraw`, `Freeze`, `Close`) is a state transition. Every `apply*` method updates the struct fields to reflect that transition. The key invariant: state is only ever modified by `apply*` methods. Never modify `a.balanceCents` directly in a public method. Only produce an event and let `apply` handle the mutation.

Trace one complete `Deposit` call step by step: (1) check preconditions, (2) call `a.apply(MoneyDeposited{...}, true)`, (3) inside `apply`, call `a.applyMoneyDeposited(e)` which modifies `a.balanceCents`, (4) `isNew=true` so append to `a.uncommitted`. The repository will later call `a.UncommittedEvents()` to get the new events and persist them. Notice that `a.balanceCents` is updated immediately in memory, even before the events are saved. This is correct: the aggregate's in-memory state reflects the new events immediately.

The `isNew bool` parameter on `apply` is the switch between "live command" and "replay" paths. When loading from history, `isNew=false` means events are applied but not added to `uncommitted`. When processing a new command, `isNew=true` adds the event to `uncommitted` for later persistence. This two-path design means you can replay any historical sequence without accidentally marking old events as new.

The `UncommittedEvents()` method clears the slice after returning it. This is a design choice: it assumes the caller will save the events exactly once. Make sure your repository's `Save` method never calls `UncommittedEvents()` twice on the same aggregate instance.

For FAANG interview prep: be ready to implement a simplified version of this aggregate on a whiteboard. The interviewer will ask "what events does a bank account produce?" and then "how does `LoadFromHistory` work?" Have those answers ready without looking at the code.

### Senior @ FAANG: Aggregate Design Boundaries and Testing Strategy

The `Account` aggregate here is a clean example of the pattern, but real aggregates accumulate complexity that requires deliberate design decisions.

The `apply` dispatcher is a switch statement over event types. As the aggregate gains more events, this switch grows. A common refactoring temptation is to use reflection or a map of handler functions. Resist it. The explicit switch is a compiler-checked exhaustiveness guarantee: when you add a new event type and forget to add it to the switch, the compiler does not catch it (unlike a typed interface), but at least the code is readable and grep-able. If you use reflection, you lose both readability and the ability to find all apply sites with a simple search. The switch is the correct trade-off for long-lived, regulated aggregates.

The `BalanceAfter` field in `MoneyDeposited` and `MoneyWithdrawn` is a deliberate denormalization: the event carries the post-transaction balance rather than making the projector compute it from history. This is correct for projections (instant balance lookup) but carries a risk: if the replay code has a bug that computes balance differently from what `BalanceAfter` records, auditors will see inconsistent data. The canonical answer is that `BalanceAfter` is informational for projections, and the true balance is always recomputed by replaying events through `applyMoneyDeposited` and `applyMoneyWithdrawn`. Make this explicit in your domain documentation.

The Given-When-Then test pattern for event-sourced aggregates is the canonical testing approach and the answer interviewers expect. A complete test suite for `Account` covers: loading from history with no events returns an error, deposit on an active account produces `MoneyDeposited` with correct fields, deposit on a frozen account returns `ErrAccountFrozen`, withdraw with insufficient funds returns `ErrInsufficientFunds`, replaying `MoneyWithdrawn` correctly reduces balance, and closing an account with non-zero balance returns an error. Each test is pure Go with no infrastructure dependencies. The aggregate is instantiated from a slice of events and the test asserts on the uncommitted events slice.

For L6/L7 interview loops, the follow-up question is: "how do you test that replay is deterministic across code versions?" The answer requires a snapshot of historical event payloads (a golden file) and a test that replays them through the current `LoadFromHistory` code and asserts the final aggregate state matches expectations. This catches the class of bug where a code change silently changes the semantics of an existing `apply*` method.

Currency handling via integer cents is correct and important. Floating-point arithmetic for financial calculations is not acceptable (IEEE 754 rounding errors accumulate). Integer arithmetic in the smallest currency unit (cents, pence, satoshi) is the standard approach. The `currency` field on events enables multi-currency systems but requires explicit currency matching on operations. An interview question worth being ready for: "what happens if someone calls `Deposit` in USD on an account denominated in EUR?" The correct answer in this codebase is: enforce same-currency in the domain method and return a domain error if they mismatch.

---
