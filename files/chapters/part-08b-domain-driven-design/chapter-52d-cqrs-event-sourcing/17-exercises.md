## Exercises

**Exercise 1**: Implement the `Account` aggregate test suite. Cover all state transitions, all invariants (e.g., cannot withdraw more than balance), and verify that the correct domain events are emitted for each operation.

**Exercise 2**: Implement a `CheckingAccount` that extends `Account` with overdraft protection: the account can go negative up to a configured limit, and an `OverdraftUsed` event is emitted when the balance goes below zero.

**Exercise 3**: Implement a `MonthlyStatementProjector` that reads from the `account.MoneyDeposited` and `account.MoneyWithdrawn` events and builds a `monthly_statement_views` table with total deposits, total withdrawals, and net change per account per month.

**Exercise 4**: Implement the `InitiateTransfer` saga completely, including the compensating transaction when the credit step fails. Use the event-sourced `FundTransfer` process manager.

**Exercise 5**: Add event upcasting to the `JSONEventSerializer`. Add a new `channel` field to `MoneyDeposited` (e.g., "ATM", "mobile", "wire"). Historical events without this field should default to "unknown". Verify that loading an account from old events (without `channel`) still works correctly.

**Exercise 6**: Benchmark the account loading performance with 0, 50, 100, 500, and 1000 events. Add snapshotting every 50 events and re-benchmark. Plot the results and explain the performance curve.

### Junior → FAANG: How to Approach These Exercises

The six exercises form a progression from domain testing to infrastructure to integration. Work through them in order. Each exercise builds on the types and patterns from the previous one.

Exercise 1 is your most important one. The test suite it asks you to write is the exact style of test a FAANG interview might ask you to code. The Given-When-Then structure (start with historical events, call a method, assert on uncommitted events or the returned error) is the only testing pattern for event-sourced aggregates. Do not write tests that check internal state (`a.balanceCents`). Check only the events produced and the errors returned.

For Exercise 3 (monthly statement projector), design the `monthly_statement_views` table schema before writing any code. The table needs at minimum: `account_id`, `year`, `month`, `total_deposits_cents`, `total_withdrawals_cents`, `net_change_cents`. The primary key is `(account_id, year, month)`. The projection upserts into this table on each event. Make it idempotent using `ON CONFLICT (account_id, year, month) DO UPDATE`.

For Exercise 5 (upcasting), write the upcast function first, then write a test that provides a raw JSON payload without `channel` and asserts that `Deserialize` returns a `MoneyDeposited` event with `Channel = "unknown"`. Then add the upcast call into `Deserialize`. If you write the test after the implementation, you will not be confident the upcaster is actually invoked.

For Exercise 6 (benchmark), run it with `go test -bench=. -benchtime=10s -benchmem`. Record the `ns/op` number at each event count. The performance curve should be roughly linear without snapshots (10x more events, 10x more time) and roughly flat with snapshots (10x more events, same time, because only the tail events are replayed). If your curve looks different, investigate why.

### Senior @ FAANG: Extending the Exercises to Staff-Level Problems

The six exercises cover the standard implementation path. A staff-level engineer extends each exercise with the production concerns that the exercise leaves implicit.

Exercise 1 (test suite): add a property-based test using `pgregory.net/rapid` or a similar library. The property to test: for any sequence of valid commands, the final aggregate state computed by `LoadFromHistory(all_events)` is identical to the final aggregate state computed by `LoadFromSnapshotAndHistory(mid_snapshot, tail_events)`. This property test finds classes of bugs in `TakeSnapshot` and `LoadFromSnapshotAndHistory` that hand-crafted examples miss.

Exercise 4 (complete transfer saga): add the outbox pattern. The handler should write the debit event and the outbox relay record in a single transaction. Write a test that crashes the handler after the debit but before the relay and verifies that a subsequent relay run correctly triggers the credit. Without this test, the saga's durability guarantee is unverified.

Exercise 5 (upcasting): extend the upcaster to a full upcasting chain. Define event schema version 1 (no `channel`), version 2 (adds `channel`), and version 3 (renames `channel` to `transaction_channel`). Write upcasters for v1-to-v2 and v2-to-v3. The deserializer should apply the full chain: a v1 payload goes through both upcasters before being returned. Write a test with v1, v2, and v3 raw payloads and assert all three deserialize to the same `MoneyDeposited` struct with the current field names. This is the correct production model for schema evolution in a long-lived event store.

For an additional staff-level exercise: design and implement the blue/green projection swap procedure. Implement `order_views_v1` and `order_views_v2` as two separate tables. Run two separate projector goroutines against the same event stream. When `v2`'s last processed position catches up to `v1`'s, atomically swap a `active_projection_version` flag (stored in a config table) from `"v1"` to `"v2"`. Write the query handler to read the flag and route to the active table. Test that swapping the flag changes which table queries read from, and that no events are lost during the swap.

---
