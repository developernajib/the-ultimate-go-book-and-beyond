## 37E.5 Lightweight Transactions (LWT)

### Compare-And-Swap Operations

Cassandra's lightweight transactions (LWT) use Paxos consensus to provide compare-and-swap (CAS) semantics within a single partition. An `INSERT ... IF NOT EXISTS` or `UPDATE ... IF condition` statement triggers a four-round-trip Paxos protocol (prepare, promise, propose, accept), making LWT roughly 5x slower than a regular write. Use LWT only where correctness demands it: unique constraints, state machine transitions, and inventory reservations. The examples below show each pattern with `gocql`'s `ScanCAS` method, plus a saga implementation for multi-step workflows that span multiple partitions.

```go
package cassandra

import (
	"context"
	"fmt"

	"github.com/gocql/gocql"
)

// LWTRepository demonstrates Cassandra's LWT (Paxos-based CAS)
// WARNING: LWT has ~5x latency overhead vs regular writes - use sparingly
type LWTRepository struct {
	session *gocql.Session
}

// CreateUserIfNotExists - INSERT ... IF NOT EXISTS
func (r *LWTRepository) CreateUserIfNotExists(ctx context.Context, u User) (bool, error) {
	stmt := `INSERT INTO users (user_id, email, name, created_at)
             VALUES (?, ?, ?, ?)
             IF NOT EXISTS`

	applied, err := r.session.Query(stmt,
		u.UserID, u.Email, u.Name, u.CreatedAt,
	).WithContext(ctx).ScanCAS(nil)

	if err != nil {
		return false, fmt.Errorf("LWT insert: %w", err)
	}
	// applied = true: user was created
	// applied = false: user already existed (email collision handled)
	return applied, nil
}

// ReserveTicket - conditional update for inventory management
func (r *LWTRepository) ReserveTicket(ctx context.Context, eventID gocql.UUID, ticketID gocql.UUID, userID gocql.UUID) (bool, error) {
	stmt := `UPDATE tickets
             SET status = 'reserved', user_id = ?, reserved_at = toTimestamp(now())
             WHERE event_id = ? AND ticket_id = ?
             IF status = 'available'`

	applied, err := r.session.Query(stmt, userID, eventID, ticketID).
		WithContext(ctx).
		ScanCAS(nil)

	return applied, err
}

// AtomicCounter - increment counter only if below limit
// Note: Use Cassandra counter columns for general counting
func (r *LWTRepository) IncrementIfBelow(ctx context.Context, key string, limit int64) (bool, int64, error) {
	// Read current value
	var current int64
	if err := r.session.Query(
		`SELECT counter_val FROM rate_limits WHERE key = ?`, key,
	).WithContext(ctx).Scan(&current); err != nil && err != gocql.ErrNotFound {
		return false, 0, err
	}

	if current >= limit {
		return false, current, nil
	}

	// CAS increment
	var newVal int64
	applied, err := r.session.Query(
		`UPDATE rate_limits SET counter_val = ? WHERE key = ? IF counter_val = ?`,
		current+1, key, current,
	).WithContext(ctx).ScanCAS(&newVal)

	if !applied {
		// Another writer beat us - return current value
		return false, newVal, nil
	}
	return true, current + 1, err
}

// Saga compensating transaction pattern
// Cassandra doesn't have multi-partition transactions
// Use saga pattern with LWT for each step

type SagaStep struct {
	Execute    func(ctx context.Context) error
	Compensate func(ctx context.Context) error
}

// ExecuteSaga runs steps with automatic rollback on failure
func ExecuteSaga(ctx context.Context, steps []SagaStep) error {
	completed := make([]SagaStep, 0, len(steps))

	for _, step := range steps {
		if err := step.Execute(ctx); err != nil {
			// Compensate in reverse order
			for i := len(completed) - 1; i >= 0; i-- {
				if compErr := completed[i].Compensate(ctx); compErr != nil {
					// Log compensation error but continue
					_ = compErr
				}
			}
			return fmt.Errorf("saga step failed: %w", err)
		}
		completed = append(completed, step)
	}
	return nil
}
```

### Junior to FAANG: LWT entry points

If this is your first encounter with Paxos in Cassandra, anchor on two mental models before touching `ScanCAS`. First, a normal Cassandra write is fire and forget at the coordinator level with tunable consistency. A LWT write is a consensus protocol that serializes every concurrent writer on the same partition key through four coordinator round trips (prepare, promise, propose, commit plus an implicit read). Second, `IF NOT EXISTS` and `IF column = value` both use SERIAL consistency for the Paxos ballot and you must also pick a commit consistency (usually LOCAL_QUORUM) for the applied mutation. A worked first-job example is the unique email check. New engineers frequently write `SELECT ... WHERE email = ?` then `INSERT`, and two concurrent signups duplicate the row because the read and write are not atomic. The fix is `INSERT ... IF NOT EXISTS` on a partition keyed by email. In interviews you will be asked why this costs 5x a normal write. Answer with the Paxos round trips and the fact that a failed ballot still reads the current value back, which is why `ScanCAS(dest ...)` returns the existing row when `applied` is false. Practice reading that return shape in `gocql` before the interview.

### Senior at FAANG: LWT cost model, anti-patterns, and Scylla divergence

At staff level the discussion is almost never about the API and almost always about budget and blast radius. Cassandra 5.0 LWT still uses classic Paxos, so the coordinator drives prepare, read, propose, and commit phases against the replica set sized by SERIAL or LOCAL_SERIAL. That is four network hops plus a disk sync on the Paxos table (`system.paxos`) per replica. Published production numbers sit near 5 to 7x the latency of a QUORUM write and 10x the coordinator CPU. This matters for capacity planning because a partition under contention funnels every writer through a single coordinator ballot queue, which collapses throughput to serial. The standard operating rule is that any partition expected to exceed roughly 100 contended LWT writes per second should be redesigned. ScyllaDB 6.0 replaces classic Paxos with Raft-backed LWT on the `raft_topology` infrastructure for metadata and offers faster single-round LWT for data via its Enhanced Paxos implementation, cutting round trips to two in the happy path. If your team is on Scylla, benchmark before assuming Cassandra numbers carry over.

The anti-pattern catalog is where senior review earns its keep. First, do not use LWT as a substitute for idempotent writes. If the mutation is naturally idempotent, write a deterministic primary key (for example `order_id` plus `event_type`) and let last write win. Second, never pair LWT with `ALLOW FILTERING` to enforce uniqueness on a non-key column. That reads the full partition, applies the predicate in memory, then runs Paxos, which is quadratic. The correct structure is a dedicated lookup table keyed by the uniqueness column with LWT on insert, then a second non-LWT write to the canonical table. Third, counter columns are not a drop-in for LWT on increments. Counters skip the commit log path and use their own replication protocol, which makes them cheap but non-idempotent on retry. For billing or inventory, prefer an LWT-guarded balance row or an append-only ledger with periodic materialization rather than a counter column, and document this choice in an ADR.

Saga design with LWT deserves its own section in a design review. Because Cassandra has no multi-partition transaction, the execute and compensate closures shown above must be durable themselves. A naive in-memory saga loses its compensation list on process crash. Production systems persist saga state to a dedicated `saga_log` table with the steps and their status, then drive compensation from a resumable worker. The outbox pattern, covered later in this chapter, is the preferred substrate: write the business mutation and an outbox row in a single partition batch, then let a CDC consumer publish and advance the saga. Pair this with idempotency keys on every step so replays are safe. For interview signal at staff level, be able to draw the Paxos state machine, identify where a partial failure leaks a ballot, and describe the `paxos_grace_seconds` tuning that controls how long stale ballots survive before garbage collection. Also be ready to discuss why LOCAL_SERIAL is almost always the right commit consistency for multi-DC deployments, because EACH_SERIAL serializes through remote DCs and multiplies latency by the cross-region RTT.

---
