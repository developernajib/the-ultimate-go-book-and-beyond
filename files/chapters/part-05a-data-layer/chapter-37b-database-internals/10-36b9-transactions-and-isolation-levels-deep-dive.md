## 37B.9 Transactions and Isolation Levels Deep Dive

### The Four Isolation Levels

The SQL standard defines four isolation levels, each preventing different anomalies:

```
Anomalies:

Dirty Read:         T1 reads uncommitted data written by T2.
                    T2 rolls back -> T1 read data that never existed.

Non-repeatable Read: T1 reads row X. T2 updates and commits row X.
                    T1 reads row X again -> different value.

Phantom Read:       T1 reads rows matching predicate P.
                    T2 inserts a row matching P and commits.
                    T1 re-reads -> sees new "phantom" row.

Serialization Anomaly: Result of concurrent transactions is not achievable
                    by any serial execution of those transactions.
```

| Isolation Level | Dirty Read | Non-repeatable | Phantom | Serialization Anomaly |
|---|---|---|---|---|
| READ UNCOMMITTED | Possible | Possible | Possible | Possible |
| READ COMMITTED | Prevented | Possible | Possible | Possible |
| REPEATABLE READ | Prevented | Prevented | Possible | Possible |
| SERIALIZABLE | Prevented | Prevented | Prevented | Prevented |

### PostgreSQL's Actual Behavior

PostgreSQL does not implement READ UNCOMMITTED - it silently upgrades to READ COMMITTED. Its isolation behavior:

| Requested level | PostgreSQL implements |
|---|---|
| READ UNCOMMITTED | READ COMMITTED (no dirty reads ever) |
| READ COMMITTED | READ COMMITTED (default) |
| REPEATABLE READ | REPEATABLE READ (snapshot-based, also prevents phantoms) |
| SERIALIZABLE | SSI (true serializability) |

PostgreSQL's REPEATABLE READ actually prevents phantom reads too, because it uses snapshot isolation, all reads use the same snapshot taken at transaction start.

> **Senior track**: Snapshot Isolation (SI) is not the same as true Serializable. SI prevents dirty reads, non-repeatable reads, and phantoms, but still allows **write skew** anomalies (two transactions read a shared set, each writes a disjoint row, together they violate an invariant like "at least one doctor on call"). Oracle's SERIALIZABLE is really SI and permits write skew. PostgreSQL 9.1+ uses **Serializable Snapshot Isolation (SSI)**, which layers rw-conflict tracking on top of SI and aborts one transaction in any cycle that would cause a non-serializable schedule. CockroachDB uses a different approach (deterministic serializability via timestamp ordering). Know which flavor your database actually provides. "SERIALIZABLE" is not a portable keyword.

### Practical Isolation Level Examples

These SQL sessions show how each isolation level behaves differently when a concurrent transaction modifies data mid-flight.

```sql
-- READ COMMITTED (default): each statement gets a fresh snapshot
BEGIN; -- Transaction A, isolation = READ COMMITTED
SELECT balance_cents FROM accounts WHERE id = 1; -- sees 100000
-- (Transaction B commits: UPDATE accounts SET balance_cents = 200000 WHERE id = 1)
SELECT balance_cents FROM accounts WHERE id = 1; -- sees 200000 (non-repeatable read!)
COMMIT;

-- REPEATABLE READ: snapshot taken at first statement
BEGIN ISOLATION LEVEL REPEATABLE READ; -- Transaction A
SELECT balance_cents FROM accounts WHERE id = 1; -- sees 100000, snapshot taken
-- (Transaction B commits: UPDATE accounts SET balance_cents = 200000 WHERE id = 1)
SELECT balance_cents FROM accounts WHERE id = 1; -- still sees 100000 (repeatable)
COMMIT;

-- SERIALIZABLE: full serializability via SSI
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- All the above guarantees PLUS serialization anomaly prevention
-- May receive: ERROR: could not serialize access due to concurrent update
COMMIT;
```

### Distributed Transactions: 2PC and Its Problems

For transactions spanning multiple databases (or microservices), PostgreSQL supports **Two-Phase Commit (2PC)**:

```sql
-- Phase 1: PREPARE (durable but not yet committed)
BEGIN;
UPDATE accounts SET balance_cents = balance_cents - 10000 WHERE id = 1; -- on DB1 ($100.00)
PREPARE TRANSACTION 'transfer_12345';

-- (Simultaneously on DB2:)
BEGIN;
UPDATE accounts SET balance_cents = balance_cents + 10000 WHERE id = 2;
PREPARE TRANSACTION 'transfer_12345';

-- Phase 2: COMMIT both (coordinator decides after both prepare succeed)
COMMIT PREPARED 'transfer_12345'; -- on DB1
COMMIT PREPARED 'transfer_12345'; -- on DB2

-- If coordinator fails between phases:
SELECT * FROM pg_prepared_xacts; -- find stuck prepared transactions
ROLLBACK PREPARED 'transfer_12345'; -- manual cleanup
```

**2PC problems**:
1. **Blocking protocol**: If the coordinator crashes after phase 1 but before phase 2, participants are stuck with prepared transactions holding locks
2. **Availability**: Both participants must be available for commit
3. **Performance**: Two round trips instead of one

Modern distributed systems prefer **saga pattern** (sequence of local transactions with compensating actions) over 2PC for resilience.

### Go Code: Explicit Transaction Management

The `WithTx` helper below wraps a function in a transaction at a specified isolation level. For `SERIALIZABLE` transactions, it automatically retries on serialization failures (SQLSTATE 40001) and deadlocks (40P01), which are expected and normal under SSI. The `TransferFunds` example demonstrates consistent lock ordering to prevent deadlocks when updating multiple rows.

```go
package transactions

import (
    "context"
    "errors"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
    "github.com/jackc/pgx/v5/pgxpool"
)

// IsolationLevel wraps pgx isolation levels for cleaner API.
type IsolationLevel = pgx.TxIsoLevel

const (
    ReadCommitted  IsolationLevel = pgx.ReadCommitted
    RepeatableRead IsolationLevel = pgx.RepeatableRead
    Serializable   IsolationLevel = pgx.Serializable
)

// TxFunc is a function to run inside a transaction.
type TxFunc func(ctx context.Context, tx pgx.Tx) error

// WithTx runs fn inside a transaction with the given isolation level.
// Automatically retries on serialization failures for SERIALIZABLE transactions.
func WithTx(ctx context.Context, pool *pgxpool.Pool, iso IsolationLevel, fn TxFunc) error {
    maxRetries := 1
    if iso == Serializable {
        maxRetries = 5
    }

    var lastErr error
    for attempt := 0; attempt < maxRetries; attempt++ {
        tx, err := pool.BeginTx(ctx, pgx.TxOptions{
            IsoLevel:   iso,
            AccessMode: pgx.ReadWrite,
        })
        if err != nil {
            return fmt.Errorf("begin transaction: %w", err)
        }

        if err := fn(ctx, tx); err != nil {
            _ = tx.Rollback(ctx)
            if isRetryable(err) && attempt < maxRetries-1 {
                lastErr = err
                continue
            }
            return err
        }

        if err := tx.Commit(ctx); err != nil {
            if isRetryable(err) && attempt < maxRetries-1 {
                lastErr = err
                continue
            }
            return fmt.Errorf("commit transaction: %w", err)
        }
        return nil
    }
    return fmt.Errorf("transaction failed after %d attempts: %w", maxRetries, lastErr)
}

// isRetryable returns true for transient PostgreSQL errors that should be retried.
func isRetryable(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        switch pgErr.Code {
        case "40001": // serialization_failure
            return true
        case "40P01": // deadlock_detected
            return true
        }
    }
    return false
}

// TransferFunds demonstrates a proper financial transaction with SERIALIZABLE isolation.
func TransferFunds(ctx context.Context, pool *pgxpool.Pool, fromID, toID int64, amountCents int64) error {
    return WithTx(ctx, pool, Serializable, func(ctx context.Context, tx pgx.Tx) error {
        // Always lock in consistent order to prevent deadlocks
        lockOrderFrom, lockOrderTo := fromID, toID
        if fromID > toID {
            lockOrderFrom, lockOrderTo = toID, fromID
        }

        // Lock both rows in consistent order
        var fromBalanceCents, toBalanceCents int64
        err := tx.QueryRow(ctx,
            "SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE",
            lockOrderFrom,
        ).Scan(&fromBalanceCents)
        if err != nil {
            return fmt.Errorf("lock from account: %w", err)
        }

        err = tx.QueryRow(ctx,
            "SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE",
            lockOrderTo,
        ).Scan(&toBalanceCents)
        if err != nil {
            return fmt.Errorf("lock to account: %w", err)
        }

        // Validate
        if lockOrderFrom == fromID && fromBalanceCents < amountCents {
            return fmt.Errorf("insufficient funds: have %d cents, need %d cents", fromBalanceCents, amountCents)
        }

        // Apply transfer
        _, err = tx.Exec(ctx,
            "UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2",
            amountCents, fromID,
        )
        if err != nil {
            return fmt.Errorf("debit account: %w", err)
        }

        _, err = tx.Exec(ctx,
            "UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2",
            amountCents, toID,
        )
        if err != nil {
            return fmt.Errorf("credit account: %w", err)
        }

        return nil
    })
}
```

### Junior to FAANG: Isolation Without Mysticism

The word "isolation" intimidates, but the model is simple. Each transaction sees a version of the database. READ COMMITTED means a new version on every statement. REPEATABLE READ means one version for the whole transaction. SERIALIZABLE means the database also guarantees your transactions could have run one at a time in some order, even when they ran concurrently. Your application decides which guarantee it needs, and then you write code to that guarantee.

Worked example. A booking system counts how many seats are already reserved, and if less than the cap it inserts a new reservation. Under READ COMMITTED two concurrent attempts can both read "9 reservations", both conclude "under the cap of 10", and both insert, resulting in 11. The correct answers are (a) use SERIALIZABLE and retry on 40001, (b) use a single UPDATE counter row with SELECT ... FOR UPDATE, or (c) add a unique constraint that encodes the invariant (e.g. a partial unique index enforcing one reservation per seat number). Pick based on contention: SERIALIZABLE is cleanest, FOR UPDATE is fastest for known hotspots, constraints are safest but sometimes harder to shape.

Interview entry-points:
- What anomaly does REPEATABLE READ prevent that READ COMMITTED does not? Non-repeatable reads and phantoms (in Postgres's snapshot-based implementation).
- What is write skew? Two transactions each read an overlapping set, each write a disjoint row, and their combined effect violates an invariant that would have held under any serial order.
- Why retry on SQLSTATE 40001? Because SERIALIZABLE is implemented by detecting conflicts after the fact and aborting the loser. Retry is part of the contract.

### Senior at FAANG: Isolation Implementation, Predicate Locks, and Replication Semantics

SSI internals. Postgres SERIALIZABLE is Cahill's Serializable Snapshot Isolation. It runs on top of snapshot isolation and additionally tracks rw-antidependencies: a read by T1 of a version written by T0 followed by a later write to the same data by T2. A pivot (T1) with an incoming rw-dep from T0 and an outgoing rw-dep to T2 where T2 commits first forms a dangerous structure. Postgres aborts one of the three to break the cycle. The tracking mechanism is SIREAD locks in shared memory, held across the transaction and beyond commit if the transaction was read-only and a concurrent writer exists. SIREAD locks have tuple, page, and relation granularities. A sequential scan acquires a relation-level SIREAD lock, which causes pessimistic aborts against any writer to that table. An index scan acquires page or tuple SIREAD locks, which are far more precise. The practical implication: for SERIALIZABLE workloads, push queries to use index scans even when a seqscan would be faster in isolation, because the finer-grained lock granularity reduces false-positive aborts.

max_pred_locks_per_transaction, max_pred_locks_per_relation, and max_pred_locks_per_page govern when lock granularity escalates. When tuple locks exceed the per-page threshold, they collapse to a page lock, and when page locks exceed the per-relation threshold, they collapse to a relation lock. This is the SSI analogue of lock escalation, and like its row-to-table cousin it is the root cause of most mysterious serialization failure spikes under load. Monitor pg_locks where mode = 'SIReadLock' and correlate with commit/abort counts from pg_stat_database.

REPEATABLE READ semantics under write conflict. Postgres REPEATABLE READ is snapshot isolation. If your transaction tries to UPDATE a row that was updated after your snapshot by a now-committed transaction, Postgres aborts with 40001 "could not serialize access due to concurrent update". This is first-updater-wins behavior, not second-updater-wins. Applications that use REPEATABLE READ for read consistency but occasionally write must handle 40001 there too, not only under SERIALIZABLE.

Oracle's SERIALIZABLE is snapshot isolation (they mislabel it). It does not detect write skew. If you port an Oracle app that relies on SERIALIZABLE for business invariants, to Postgres REPEATABLE READ you get the same guarantees. To Postgres SERIALIZABLE you get strictly stronger guarantees plus more aborts under concurrency, which means retry logic is now mandatory.

MySQL InnoDB's REPEATABLE READ is snapshot-plus-next-key-locks. Reads see a consistent snapshot (good). Writes acquire next-key locks (record + gap) that prevent phantoms from being inserted into the range you just scanned (better than pure SI for write transactions). It does not prevent write skew because two disjoint writes to disjoint rows with disjoint gap locks do not conflict. SELECT ... FOR UPDATE in InnoDB is strongly consistent because the locks are real row locks, not SIREAD locks.

Replication visibility and read-your-writes. Streaming replication in Postgres is asynchronous by default. A transaction commits on the primary, the WAL flushes, and a standby replays it milliseconds or seconds later. An application that writes to the primary and then reads from a replica can see stale state. synchronous_commit = remote_apply ensures the primary waits for the standby to apply the WAL before returning commit, but this ties primary latency to standby health. The pragmatic staff-level pattern is to track commit LSNs per user session (pg_current_wal_lsn() after write) and route their next read to a replica whose pg_last_wal_replay_lsn() is at least that LSN. Tools like Bitnami's postgres-operator or custom proxies implement this.

FOR UPDATE vs FOR NO KEY UPDATE vs FOR SHARE vs FOR KEY SHARE. Postgres has four row-level lock modes with different compatibility. FOR UPDATE blocks all other writers including referential checks. FOR NO KEY UPDATE (the implicit mode for UPDATE of non-key columns) allows referential-integrity SELECT FOR KEY SHARE to proceed. Most application code should use FOR NO KEY UPDATE when the intent is "read this row and update a non-key column", because it avoids blocking foreign-key verification from other transactions. This distinction is the source of many unexplained lock waits on foreign key checks during high-contention UPDATEs.

Deadlock detection. Postgres runs a deadlock detector after deadlock_timeout (default 1s) of waiting. The detector walks the wait-for graph and aborts the youngest transaction in a cycle. Logs get "ERROR: deadlock detected" with the full victim query and lock graph when log_lock_waits = on. Always enable log_lock_waits in production. Deadlocks are not failures of the database, they are failures of lock ordering in application code. The canonical fix is to sort resources by a stable key before locking, as the TransferFunds example does with lockOrderFrom and lockOrderTo.

2PC reality check. Postgres PREPARE TRANSACTION works but must be managed by an external coordinator. max_prepared_transactions is zero by default. If you turn it on, you accept the blocking-protocol risk that an uncommitted prepared transaction holds locks forever if the coordinator dies. The operational requirement is a resolver process that scans pg_prepared_xacts periodically and drives stuck transactions to COMMIT PREPARED or ROLLBACK PREPARED based on the coordinator's log. Modern architectures largely abandon 2PC for outbox pattern plus eventually-consistent message delivery, Saga with compensation, or single-store designs using CRDBs (CockroachDB, YugabyteDB) that make distributed transactions a native primitive with Raft under the hood.

Logical replication and isolation. Postgres logical replication extracts changes as row-level events and replays them on subscribers in commit order. A subscriber sees serializable history of the publisher's commits even if the publisher allows write skew, because write skew is a concurrency anomaly on the publisher, not a durability property. Conflicts on the subscriber (e.g. two publishers writing the same primary key) require explicit conflict-resolution logic because Postgres does not ship with last-write-wins or CRDB-style merge functions.

---
