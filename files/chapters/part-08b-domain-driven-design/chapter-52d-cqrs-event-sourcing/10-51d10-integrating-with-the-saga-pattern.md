## 52D.10 Integrating with the Saga Pattern

### What Sagas Are

A saga is a sequence of local transactions, each in a different bounded context, coordinated to achieve a larger distributed business transaction. If any step fails, compensating transactions undo the previous steps.

**Choreography-based saga** (event-driven): Each service reacts to events from other services without a central coordinator.

**Orchestration-based saga** (process manager): A central process manager sends commands to each service and tracks the overall state.

### Process Manager for Fund Transfer

The `FundTransferProcessManager` models a multi-step saga as a state machine: each incoming event (`FundsDebitedEvent`, `FundsCreditedEvent`, `TransferFailedEvent`) triggers a state transition and emits a compensating command (`CreditFundsCommand`, `RefundDebitCommand`) to maintain consistency across the two accounts without a distributed transaction. The process manager is persisted via the event store so it can be reconstituted after a crash without losing intermediate state.

```go
// internal/domain/transfer/process_manager.go

package transfer

import (
    "errors"
    "time"
)

// TransferID is the identity of a fund transfer process.
type TransferID string

// TransferStatus represents the state of the transfer saga.
type TransferStatus string

const (
    TransferStatusInitiated  TransferStatus = "initiated"
    TransferStatusDebited    TransferStatus = "debited"
    TransferStatusCompleted  TransferStatus = "completed"
    TransferStatusFailed     TransferStatus = "failed"
    TransferStatusRolledBack TransferStatus = "rolled_back"
)

var (
    ErrTransferNotFound    = errors.New("transfer not found")
    ErrTransferAlreadyDone = errors.New("transfer has already completed or failed")
)

// FundTransfer is the event-sourced process manager for the transfer saga.
// It tracks the multi-step transfer across two accounts.
type FundTransfer struct {
    id            TransferID
    fromAccountID string
    toAccountID   string
    amountCents   int64
    currency      string
    status        TransferStatus
    failureReason string
    version       int
    uncommitted   []DomainEvent
}

// InitiateFundTransfer starts a new fund transfer saga.
func InitiateFundTransfer(
    id TransferID,
    from, to string,
    amountCents int64,
    currency string,
) (*FundTransfer, error) {
    if amountCents <= 0 {
        return nil, errors.New("transfer amount must be positive")
    }
    if from == to {
        return nil, errors.New("cannot transfer to the same account")
    }

    ft := &FundTransfer{}
    ft.apply(TransferInitiated{
        TransferID:    id,
        FromAccountID: from,
        ToAccountID:   to,
        AmountCents:   amountCents,
        Currency:      currency,
        InitiatedAt:   time.Now(),
    }, true)
    return ft, nil
}

// LoadTransferFromHistory reconstitutes a FundTransfer from its event history.
func LoadTransferFromHistory(events []DomainEvent) (*FundTransfer, error) {
    ft := &FundTransfer{}
    for _, e := range events {
        ft.apply(e, false)
        ft.version++
    }
    return ft, nil
}

func (ft *FundTransfer) apply(event DomainEvent, isNew bool) {
    switch e := event.(type) {
    case TransferInitiated:
        ft.id            = e.TransferID
        ft.fromAccountID = e.FromAccountID
        ft.toAccountID   = e.ToAccountID
        ft.amountCents   = e.AmountCents
        ft.currency      = e.Currency
        ft.status        = TransferStatusInitiated
    case TransferDebited:
        ft.status = TransferStatusDebited
    case TransferCompleted:
        ft.status = TransferStatusCompleted
    case TransferFailed:
        ft.status        = TransferStatusFailed
        ft.failureReason = e.Reason
    case TransferRolledBack:
        ft.status = TransferStatusRolledBack
    }
    if isNew {
        ft.uncommitted = append(ft.uncommitted, event)
    }
}

// MarkDebited is called when the source account has been successfully debited.
func (ft *FundTransfer) MarkDebited() error {
    if ft.status != TransferStatusInitiated {
        return ErrTransferAlreadyDone
    }
    ft.apply(TransferDebited{
        TransferID: ft.id,
        DebitedAt:  time.Now(),
    }, true)
    return nil
}

// Complete is called when the destination account has been successfully credited.
func (ft *FundTransfer) Complete() error {
    if ft.status != TransferStatusDebited {
        return errors.New("transfer must be in debited state to complete")
    }
    ft.apply(TransferCompleted{
        TransferID:  ft.id,
        CompletedAt: time.Now(),
    }, true)
    return nil
}

// Fail marks the transfer as failed (before debit).
func (ft *FundTransfer) Fail(reason string) error {
    if ft.status != TransferStatusInitiated {
        return ErrTransferAlreadyDone
    }
    ft.apply(TransferFailed{
        TransferID: ft.id,
        Reason:     reason,
        FailedAt:   time.Now(),
    }, true)
    return nil
}

// Rollback marks the transfer as rolled back (after debit, before credit).
// This should trigger a compensating credit back to the source account.
func (ft *FundTransfer) Rollback(reason string) error {
    if ft.status != TransferStatusDebited {
        return errors.New("can only rollback a debited transfer")
    }
    ft.apply(TransferRolledBack{
        TransferID:  ft.id,
        Reason:      reason,
        RolledBackAt: time.Now(),
    }, true)
    return nil
}

func (ft *FundTransfer) ID() TransferID        { return ft.id }
func (ft *FundTransfer) Status() TransferStatus { return ft.status }
func (ft *FundTransfer) FromAccountID() string  { return ft.fromAccountID }
func (ft *FundTransfer) ToAccountID() string    { return ft.toAccountID }
func (ft *FundTransfer) AmountCents() int64     { return ft.amountCents }
func (ft *FundTransfer) Version() int           { return ft.version }

func (ft *FundTransfer) UncommittedEvents() []DomainEvent {
    events := make([]DomainEvent, len(ft.uncommitted))
    copy(events, ft.uncommitted)
    ft.uncommitted = nil
    return events
}
```

The transfer saga's application service orchestrates the steps:

```go
// internal/application/transfer/initiate_transfer_handler.go

package transferapp

import (
    "context"
    "fmt"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
    "github.com/yourorg/ecommerce/banking-service/internal/domain/transfer"
)

// InitiateTransferHandler orchestrates the fund transfer saga.
type InitiateTransferHandler struct {
    accounts  account.Repository
    transfers transfer.Repository
}

func NewInitiateTransferHandler(
    accounts account.Repository,
    transfers transfer.Repository,
) *InitiateTransferHandler {
    return &InitiateTransferHandler{
        accounts:  accounts,
        transfers: transfers,
    }
}

// Handle initiates a fund transfer.
// The saga continues asynchronously via domain events.
func (h *InitiateTransferHandler) Handle(ctx context.Context, cmd InitiateTransferCommand) error {
    // Step 1: Load the source account and debit it
    fromAccount, err := h.accounts.FindByID(ctx, account.AccountID(cmd.FromAccountID))
    if err != nil {
        return fmt.Errorf("load source account: %w", err)
    }

    if err := fromAccount.Withdraw(cmd.AmountCents, cmd.Reference); err != nil {
        return fmt.Errorf("debit source account: %w", err)
    }

    // Step 2: Create the transfer saga
    xfer, err := transfer.InitiateFundTransfer(
        transfer.TransferID(cmd.TransferID),
        cmd.FromAccountID,
        cmd.ToAccountID,
        cmd.AmountCents,
        cmd.Currency,
    )
    if err != nil {
        return fmt.Errorf("initiate transfer: %w", err)
    }

    // Step 3: Save both in sequence
    // Note: this is a simplified version - in production, use the outbox pattern
    // to guarantee the debit and transfer initiation are atomic

    if err := h.accounts.Save(ctx, fromAccount); err != nil {
        return fmt.Errorf("save debited account: %w", err)
    }

    xfer.MarkDebited()

    if err := h.transfers.Save(ctx, xfer); err != nil {
        // The debit succeeded but we couldn't save the transfer record.
        // In production: the outbox event from the account would trigger
        // a compensating credit via the event bus.
        return fmt.Errorf("save transfer record: %w", err)
    }

    // The TransferDebited event triggers the credit step asynchronously
    // via an event consumer that calls CreditDestinationAccount
    return nil
}
```

### Junior → FAANG: Sagas as Distributed State Machines

A saga is a state machine that coordinates steps across multiple aggregates or services. The `FundTransfer` process manager is a state machine with five states: `initiated`, `debited`, `completed`, `failed`, and `rolled_back`. Each state transition is an event. The current state determines which transitions are valid.

Trace the happy path by hand: (1) call `InitiateFundTransfer`, which produces `TransferInitiated` and sets status to `initiated`. (2) Debit the source account, call `ft.MarkDebited()`, which produces `TransferDebited` and sets status to `debited`. (3) Credit the destination account, call `ft.Complete()`, which produces `TransferCompleted`. The sad path: if the credit fails, call `ft.Rollback()`, which produces `TransferRolledBack`. A compensating command to re-credit the source account must then be issued.

The comment `// Note: this is a simplified version - in production, use the outbox pattern` is the most important comment in the handler. The two saves (account + transfer) are not atomic. If the process crashes between them, the debit happened but the transfer record was not saved. The outbox pattern (write the side effect as a row in the database, have a relay process publish it) is how you make these two writes appear atomic. Until you understand the outbox pattern, you have not finished learning sagas.

The difference between choreography and orchestration affects testability. Choreography-based sagas react to events: each service handles an event and emits another. The saga's overall state is implicit in which events have been emitted. Orchestration-based sagas have a process manager that explicitly tracks state. The process manager is testable in isolation: given events in, assert state and uncommitted events out. Choreography is harder to test end-to-end because the saga logic is spread across multiple services.

### Senior @ FAANG: Saga Durability, Timeout Handling, and the Outbox

The `InitiateTransferHandler` in this section comments that the outbox pattern is needed but does not implement it. This omission is common in tutorials and dangerous in production. Here is what "use the outbox pattern" means concretely for this saga.

The problem: `h.accounts.Save(ctx, fromAccount)` succeeds (debit committed), then `h.transfers.Save(ctx, xfer)` fails (process crash). The account is debited but there is no transfer record. The money is gone with no trail. The compensating credit is never triggered.

The outbox solution: in the same database transaction as `h.accounts.Save`, write a row to an `outbox` table: `{type: "TransferInitiated", payload: ..., target: "transfer-service"}`. The account save and the outbox row are atomic. A relay process reads the outbox and either saves the transfer record directly (if it shares the database) or publishes to a message bus for the transfer service. The relay deletes the outbox row after successful delivery. This gives at-least-once delivery of the saga step without distributed transactions.

Saga timeouts are the hardest part of saga design. The `FundTransfer` process manager has no timeout. In production, a transfer that sits in `initiated` state because the credit step never happened is a stuck saga. The timeout mechanism requires: (1) a scheduled job that scans for transfers in terminal-incomplete states older than a threshold, (2) a `Timeout()` method on the process manager that transitions to `failed` and triggers the compensating rollback. The scheduled job must be idempotent (calling `Timeout()` twice must be safe) and must handle the race where the saga completes naturally at the same moment the timeout fires. The correct resolution is: try to transition to `failed` with optimistic concurrency, if the version check fails the saga already completed, skip the timeout.

At L6/L7, the design question is whether sagas should live in the same service as the aggregates they coordinate, or in a dedicated orchestration service. Separate service: better isolation, but adds a network hop and a deployment dependency. Same service: simpler, but the process manager mixes concerns with the domain. The pragmatic answer for small teams: same service, with the saga in its own bounded context package. For large organizations: a dedicated workflow service (the temporal.io model) that owns all saga coordination, leaving aggregate services as pure command processors.

---
