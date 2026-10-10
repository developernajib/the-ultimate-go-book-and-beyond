## 52D.11 Complete Application: Banking System

The complete banking system with CQRS + Event Sourcing + DDD covers:

```
banking-service/
├── cmd/server/main.go
└── internal/
    ├── domain/
    │   ├── account/           # Account aggregate (event-sourced)
    │   └── transfer/          # FundTransfer process manager
    ├── application/
    │   ├── account/           # OpenAccount, Deposit, Withdraw command handlers
    │   └── transfer/          # InitiateTransfer command handler
    ├── infrastructure/
    │   ├── eventstore/        # PostgreSQL event store + serializer
    │   └── projection/        # AccountBalanceProjector, TransactionHistoryProjector
    └── interfaces/
        ├── http/              # REST handlers
        └── grpc/              # gRPC server
```

### Account Command Handlers

`DepositHandler` is the application-layer entry point for the `DepositMoneyCommand`. It loads the account aggregate by replaying its event history from the event store, delegates to `account.Deposit` which enforces domain invariants and appends to the uncommitted events slice, then persists the new events via `eventStore.Append` with the current version for optimistic concurrency. The handler never touches the read model directly. The `AccountBalanceProjector` updates the query-side view asynchronously after it consumes the emitted `MoneyDepositedEvent`.

```go
// internal/application/account/deposit_handler.go

package accountapp

import (
    "context"
    "fmt"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// DepositMoneyCommand is the input for depositing money.
type DepositMoneyCommand struct {
    AccountID   string
    AmountCents int64
    Currency    string
    Reference   string
}

func (c DepositMoneyCommand) CommandName() string { return "account.deposit_money" }

// DepositMoneyHandler handles the DepositMoney command.
type DepositMoneyHandler struct {
    accounts account.Repository
}

func NewDepositMoneyHandler(accounts account.Repository) *DepositMoneyHandler {
    return &DepositMoneyHandler{accounts: accounts}
}

func (h *DepositMoneyHandler) Handle(ctx context.Context, cmd DepositMoneyCommand) error {
    // Load account by replaying event history
    a, err := h.accounts.FindByID(ctx, account.AccountID(cmd.AccountID))
    if err != nil {
        return fmt.Errorf("load account: %w", err)
    }

    // Execute domain operation
    if err := a.Deposit(cmd.AmountCents, cmd.Reference); err != nil {
        return err // domain error - bubble up
    }

    // Persist new events
    if err := h.accounts.Save(ctx, a); err != nil {
        return fmt.Errorf("save account after deposit: %w", err)
    }

    return nil
}
```

### Account Balance Projection

The `AccountBalanceProjector` listens to account domain events and maintains a denormalized `account_balance_views` table. Each event type maps to a specific SQL operation: `AccountOpened` inserts a new row, deposit and withdrawal events update the balance, and status-change events update the status column. The `ON CONFLICT DO NOTHING` clause on insert makes the projection idempotent, replaying the same event twice does not corrupt the read model.

```go
// internal/infrastructure/projection/account_balance_projector.go

package projection

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// AccountBalanceProjector maintains the account_balance_views read model.
type AccountBalanceProjector struct {
    db *sql.DB
}

func NewAccountBalanceProjector(db *sql.DB) *AccountBalanceProjector {
    return &AccountBalanceProjector{db: db}
}

// Project applies a domain event to the read model.
func (p *AccountBalanceProjector) Project(ctx context.Context, event account.DomainEvent) error {
    switch e := event.(type) {
    case account.AccountOpened:
        _, err := p.db.ExecContext(ctx, `
            INSERT INTO account_balance_views (id, owner_id, balance_cents, currency, status, updated_at)
            VALUES ($1, $2, 0, $3, 'active', $4)
            ON CONFLICT (id) DO NOTHING
        `, string(e.AccountID), string(e.OwnerID), e.Currency, time.Now())
        return err

    case account.MoneyDeposited:
        _, err := p.db.ExecContext(ctx, `
            UPDATE account_balance_views
            SET balance_cents = $1, updated_at = $2
            WHERE id = $3
        `, e.BalanceAfter, time.Now(), string(e.AccountID))
        return err

    case account.MoneyWithdrawn:
        _, err := p.db.ExecContext(ctx, `
            UPDATE account_balance_views
            SET balance_cents = $1, updated_at = $2
            WHERE id = $3
        `, e.BalanceAfter, time.Now(), string(e.AccountID))
        return err

    case account.AccountFrozen:
        _, err := p.db.ExecContext(ctx, `
            UPDATE account_balance_views
            SET status = 'frozen', updated_at = $1
            WHERE id = $2
        `, time.Now(), string(e.AccountID))
        return err

    case account.AccountClosed:
        _, err := p.db.ExecContext(ctx, `
            UPDATE account_balance_views
            SET status = 'closed', updated_at = $1
            WHERE id = $2
        `, time.Now(), string(e.AccountID))
        return err
    }
    return nil
}
```

### Transaction History Projection

The `TransactionHistoryProjector` builds an append-only ledger view from deposit and withdrawal events. Unlike the balance projector, which updates a single row per account, this projector inserts a new row for every financial event, creating the chronological transaction list that customers see in their banking app. Because each insert uses the event's own timestamp and reference, the projection is naturally idempotent for a given event.

```go
// internal/infrastructure/projection/transaction_history_projector.go

package projection

import (
    "context"
    "database/sql"

    "github.com/yourorg/ecommerce/banking-service/internal/domain/account"
)

// TransactionHistoryProjector builds the transaction history read model.
type TransactionHistoryProjector struct {
    db *sql.DB
}

func NewTransactionHistoryProjector(db *sql.DB) *TransactionHistoryProjector {
    return &TransactionHistoryProjector{db: db}
}

func (p *TransactionHistoryProjector) Project(ctx context.Context, event account.DomainEvent) error {
    switch e := event.(type) {
    case account.MoneyDeposited:
        _, err := p.db.ExecContext(ctx, `
            INSERT INTO transaction_history_views
                (account_id, type, amount_cents, currency, balance_after, reference, occurred_at)
            VALUES ($1, 'deposit', $2, $3, $4, $5, $6)
        `, string(e.AccountID), e.AmountCents, e.Currency, e.BalanceAfter, e.Reference, e.DepositedAt)
        return err

    case account.MoneyWithdrawn:
        _, err := p.db.ExecContext(ctx, `
            INSERT INTO transaction_history_views
                (account_id, type, amount_cents, currency, balance_after, reference, occurred_at)
            VALUES ($1, 'withdrawal', $2, $3, $4, $5, $6)
        `, string(e.AccountID), e.AmountCents, e.Currency, e.BalanceAfter, e.Reference, e.WithdrawnAt)
        return err
    }
    return nil
}
```

### Junior → FAANG: Reading the Complete Application as a Reference Architecture

The directory structure at the top of this section is your mental map. When you are asked to add a new feature (say, interest accrual), walk through the directory and decide which packages are affected. A new command goes in `application/account/`. A new event goes in `domain/account/`. A new read model goes in `infrastructure/projection/`. The HTTP handler goes in `interfaces/http/`. The domain package never imports from infrastructure or interfaces. Infrastructure imports from domain but not from interfaces.

The `DepositMoneyHandler` is the template for every command handler you will ever write in this architecture. It has exactly three steps: load the aggregate, execute the domain operation, save the aggregate. If you find yourself adding a fourth step (calling another service, updating a secondary table, sending a notification), stop. That fourth step belongs in a projector or a saga, not in the command handler.

The `AccountBalanceProjector` and `TransactionHistoryProjector` being separate structs is deliberate. Each projector maintains exactly one read model. If you need three read models from account events, you write three projectors. They can share an event consumer, but each maintains its own state independently. This makes it easy to rebuild just one projector without affecting the others.

The `ON CONFLICT (id) DO NOTHING` on `AccountOpened` is idempotency. Say it out loud every time you write a projection insert: "what happens if this event arrives twice?" For inserts, `ON CONFLICT DO NOTHING` or `DO UPDATE` is the answer. For updates, set the same values both times and the update is naturally idempotent.

### Senior @ FAANG: Production Gaps in the Complete Application

The "complete application" is complete enough for a chapter but has several gaps that a production banking system must address.

The deposit handler does not return the new balance to the HTTP caller. The aggregate computed `a.balanceCents` during `Deposit()`. The handler should return a `DepositResult{NewBalanceCents int64, Currency string}` from the command. This gives the HTTP handler a value to include in the response without reading from the (not yet updated) projection. Not doing this forces the client to poll or accept stale data.

The two projectors have no shared checkpoint store. In production, each projector needs to persist its last processed event position so it can resume after a restart or crash. The balance projector and history projector may be at different positions. If the balance projector processes event 1000 but the history projector crashes at event 500, the read models are in different states. When the history projector restarts, it resumes from its checkpoint (500), not from 0. Without checkpointing, restarts always replay from 0, which is slow and creates prolonged inconsistency windows.

There is no integration event translation layer between domain events and external consumers. The `MoneyDeposited` domain event contains the `AccountID` as a typed `account.AccountID`. If another service (fraud detection, notification service) subscribes to this event, it receives the internal type. When the type changes (you rename the field, change the type, add a field), you have a breaking change for every subscriber. The correct design: define an `AccountMoneyDepositedV1` integration event as a versioned DTO, translate from the domain event inside the outbox relay, and publish the DTO to the external bus. The domain event stays internal.

The gRPC interface is listed in the directory structure but not implemented. At a FAANG-scale service, the gRPC interface is often the primary interface (not HTTP) because it is strictly typed, performant, and supports streaming. The query side of CQRS maps naturally to gRPC server streaming: a client can subscribe to a stream of balance updates and receive projector events in real time, rather than polling. This is the read-side analog of the write-side event stream, and it is a common design in financial services infrastructure.

---
