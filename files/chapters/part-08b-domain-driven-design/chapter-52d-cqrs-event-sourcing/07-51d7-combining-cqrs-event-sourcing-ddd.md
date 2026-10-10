## 52D.7 Combining CQRS + Event Sourcing + DDD

### The Complete Flow

The flow diagram traces a `DepositMoneyCommand` from the HTTP handler through the command bus to the `DepositMoneyHandler`, which loads the account's event history, replays it to rebuild aggregate state, invokes the `Deposit` domain method, and appends uncommitted events to the store with an optimistic version check. This demonstrates how CQRS, event sourcing, and DDD fit together at each layer boundary.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Client  ──── HTTP POST /accounts/{id}/deposit ────────────────►    │
│                                                                     │
│  HTTP Handler                                                       │
│    ├── translates to: DepositMoneyCommand{AccountID, Amount}        │
│    └── dispatches to: CommandBus.Dispatch(cmd)                      │
│                                                                     │
│  DepositMoneyHandler                                                │
│    ├── EventStore.Load(accountID)       ← loads event history       │
│    ├── Account.LoadFromHistory(events)  ← replays events            │
│    ├── account.Deposit(amount, ref)     ← domain operation          │
│    ├── account.UncommittedEvents()      ← gets new events           │
│    └── EventStore.Append(accountID, events, expectedVersion)        │
│         └── publishes events to message bus                         │
│                                                                     │
│  Event Bus / Kafka                                                  │
│    └── MoneyDeposited event published                               │
│                                                                     │
│  AccountBalanceProjector (async consumer)                           │
│    ├── receives MoneyDeposited event                                │
│    └── updates account_balance_views table                          │
│                                                                     │
│  TransactionHistoryProjector (async consumer)                       │
│    ├── receives MoneyDeposited event                                │
│    └── inserts into transaction_history_views table                 │
│                                                                     │
│  Client  ──── HTTP GET /accounts/{id}/balance ─────────────────►    │
│                                                                     │
│  QueryBus.Ask(GetAccountBalanceQuery)                               │
│    └── reads from account_balance_views (read model)                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Notice how each layer has a single responsibility. The HTTP handler translates protocol concerns into a command. The command handler orchestrates the load-mutate-save cycle without knowing how events are stored. The aggregate enforces invariants and produces events without knowing about projections. The projectors consume events independently, each maintaining its own denormalized view. This separation means you can add a new read model (say, a fraud-detection projection) by deploying a new consumer against the existing event stream, no changes to the write side required.

The eventual consistency gap between the write and read sides is visible in the diagram: the deposit command returns success as soon as the events are appended to the store, but the balance view and transaction history are updated asynchronously by their respective projectors. For the depositing user, the API can return the new balance from the command side (the aggregate already computed it), while all other consumers read from the eventually-consistent projections.

### Junior → FAANG: Following the Request Through Every Layer

The flow diagram is a learning tool. For each box, identify the corresponding Go type in this chapter. "Command Bus" is `cqrs.CommandBus`. "DepositMoneyHandler" is in `accountapp`. "Domain Aggregate" is `account.Account`. "Repository.Save()" calls `eventStore.Append`. "Projection Process" is `AccountBalanceProjector` and `TransactionHistoryProjector`. Mapping the abstract diagram to concrete types is the prerequisite for debugging production issues: when something breaks, you need to know which layer to look at.

The "each layer has a single responsibility" observation is worth writing down and taping to your monitor. The HTTP handler does not know about domain rules. The command handler does not know about SQL. The aggregate does not know about projections. The projector does not know about aggregates. When you find code that violates one of these, that is the location of your next refactoring ticket.

The detail about returning the new balance from the command side is a practical API design tip. `POST /accounts/{id}/deposit` can return `{"new_balance_cents": 150000, "currency": "USD"}` because the aggregate computed it during the command. The client does not need to poll the read model to know what happened. This pattern (the command response includes the derived state from uncommitted events) is the simplest read-your-writes mitigation and should be your default.

### Senior @ FAANG: The Seams Where Distributed Systems Problems Hide

The flow diagram looks clean but hides three distributed systems hazards that production systems must address.

The first is the gap between "events appended to store" and "events published to message bus." In the diagram, the event store append and the message bus publish appear to happen atomically. In practice, if the process crashes after the database commit but before the Kafka publish, the projectors never receive those events and the read models fall permanently behind. The fix is the transactional outbox: write events to an `outbox` table inside the same database transaction as the event store append, and have a separate relay process that reads the outbox and publishes to Kafka. The relay can be a Debezium connector reading PostgreSQL WAL, or a polling loop. Either way, the two writes (event store + outbox) are atomic, and the publish is at-least-once with the relay as the reliability boundary.

The second hazard is consumer ordering. The flow shows two projectors consuming from the same event stream independently. If `AccountBalanceProjector` and `TransactionHistoryProjector` both receive `MoneyDeposited` but process them at different rates, the read models will be temporarily inconsistent with each other. For most use cases this is fine. For use cases where a single API response reads from both projectors (e.g., "balance plus recent transactions"), you may see balance and transaction count that do not add up during the lag window. The design choice is: accept the inconsistency window and document it, or read both from a single projection that is updated atomically.

The third hazard is the version check timing. The `Append` call includes an `expectedVersion`. If two concurrent requests load the same aggregate (both see version 5), both apply a command, and both try to append at version 5, one succeeds and one gets a concurrency error. The failing request must reload the aggregate (version 6 now) and retry. This retry loop is correct and is the standard optimistic concurrency pattern. But the retry has a latency cost, and under high contention on the same aggregate (many concurrent deposits to the same account) the retry loop becomes a bottleneck. This is the hot aggregate problem. Mitigations include request coalescing at the HTTP layer, an account-level mutex with timeout, or a per-aggregate command queue. Recognizing this problem and naming the trade-offs is an L6 design skill.

---
