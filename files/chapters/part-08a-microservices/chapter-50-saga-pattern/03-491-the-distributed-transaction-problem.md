## 50.1 The Distributed Transaction Problem

### Why Traditional Transactions Don't Work

A database transaction groups multiple statements into an atomic unit of work: either all succeed and commit, or all fail and roll back. In Go, transactions begin with `db.BeginTx`, and a deferred function checks the error to call either `tx.Commit` or `tx.Rollback`. The atomicity guarantee is local to a single database, bound to a single connection or transaction id. The moment a business operation spans two services with their own databases, that guarantee evaporates and you are left with the three bad options of classical distributed transactions: XA/2PC (which blocks on coordinator failure), nested retries (which lose consistency under partition), or ignoring the problem and hoping the mismatch stays small.

The Saga pattern rejects the premise that business consistency must equal ACID atomicity. Instead it models the workflow as a sequence of local transactions, each of which commits independently, and pairs every forward step with a compensating action that semantically reverses it when a later step fails. The system is never globally locked, never blocked on a coordinator vote, and every participant retains autonomy over its own database. The cost is that you must design compensations explicitly, accept a window of eventual consistency, and handle the cases where compensation is imperfect (you cannot unsend an email or unship a package, so you send a cancellation email and issue a return label).

```go
// pkg/saga/problem.go
package saga

/*
The Problem: E-commerce Order Processing

In a monolith with a single database:
1. BEGIN TRANSACTION
2. Create order
3. Reserve inventory
4. Process payment
5. COMMIT (or ROLLBACK if any step fails)

In microservices with separate databases:
- Order Service → Orders DB
- Inventory Service → Inventory DB
- Payment Service → Payment DB

Two-Phase Commit (2PC) Issues:
1. Single point of failure (coordinator)
2. Blocking - resources locked during prepare phase
3. Not supported across different database types
4. Poor availability - CAP theorem implications
5. Network partitions cause indeterminate state

Solution: Saga Pattern
- Break into local transactions
- Each service commits immediately
- Compensating transactions for rollback
*/

import (
	"context"
	"errors"
	"time"
)

// Transaction represents a single step in a saga
type Transaction interface {
	// Execute performs the forward transaction
	Execute(ctx context.Context) error

	// Compensate rolls back the transaction
	Compensate(ctx context.Context) error

	// Name returns the transaction name for logging
	Name() string
}

// SagaStep represents a step in a saga with its compensation
type SagaStep struct {
	Name        string
	Execute     func(ctx context.Context) error
	Compensate  func(ctx context.Context) error
}

// Common saga errors
var (
	ErrSagaFailed      = errors.New("saga execution failed")
	ErrCompensationFailed = errors.New("compensation failed")
	ErrTimeout         = errors.New("saga timeout")
	ErrMaxRetries      = errors.New("max retries exceeded")
)
```

### CAP Theorem and Eventual Consistency

CAP theorem states that a distributed system can guarantee at most two of consistency, availability, and partition tolerance simultaneously, and because network partitions are unavoidable, real systems must choose between CP (sacrifice availability) and AP (sacrifice strong consistency). In practice most microservices choose AP with eventual consistency, accepting that different nodes may briefly serve stale reads.

> **Senior track**: The interesting property of a saga is not eventual consistency itself but *bounded* eventual consistency. Your SLO should name the convergence window (for example, "99.9 percent of order sagas converge within 30 seconds, 100 percent within 5 minutes or page an operator"). Without a named window, "eventually consistent" degenerates into "eventually, maybe, if nobody notices." The Go code here models an eventually consistent inventory view with a `sync.RWMutex`-protected cache and a background reconciliation loop that periodically resynchronizes from the authoritative source.

```go
// pkg/saga/consistency.go
package saga

import (
	"context"
	"sync"
	"time"
)

/*
CAP Theorem:
- Consistency: All nodes see the same data
- Availability: Every request gets a response
- Partition Tolerance: System works despite network partitions

Sagas choose AP (Availability + Partition Tolerance):
- Accept eventual consistency
- System remains available during failures
- Each service has local consistency

ACID vs BASE:
ACID (Traditional):
- Atomicity, Consistency, Isolation, Durability

BASE (Distributed):
- Basically Available
- Soft state
- Eventually consistent
*/

// EventualConsistencyWindow tracks convergence time
type EventualConsistencyWindow struct {
	mu            sync.RWMutex
	pendingSagas  map[string]time.Time
	completedSagas map[string]time.Time
	avgConvergence time.Duration
}

// NewEventualConsistencyWindow creates a consistency tracker
func NewEventualConsistencyWindow() *EventualConsistencyWindow {
	return &EventualConsistencyWindow{
		pendingSagas:   make(map[string]time.Time),
		completedSagas: make(map[string]time.Time),
	}
}

// SagaStarted marks a saga as started
func (e *EventualConsistencyWindow) SagaStarted(sagaID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pendingSagas[sagaID] = time.Now()
}

// SagaCompleted marks a saga as completed
func (e *EventualConsistencyWindow) SagaCompleted(sagaID string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if startTime, exists := e.pendingSagas[sagaID]; exists {
		convergence := time.Since(startTime)
		delete(e.pendingSagas, sagaID)
		e.completedSagas[sagaID] = time.Now()

		// Update rolling average
		if e.avgConvergence == 0 {
			e.avgConvergence = convergence
		} else {
			e.avgConvergence = (e.avgConvergence + convergence) / 2
		}
	}
}

// GetAverageConvergence returns average time to consistency
func (e *EventualConsistencyWindow) GetAverageConvergence() time.Duration {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.avgConvergence
}

// GetPendingCount returns number of in-flight sagas
func (e *EventualConsistencyWindow) GetPendingCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.pendingSagas)
}
```

### Junior -> FAANG: Understanding the Problem Before the Solution

The worst saga bugs come from engineers who implement the pattern without fully understanding the problem it solves. Spend 20 minutes on each of the failure modes below before writing any saga code.

**Two-phase commit failure mode 1: coordinator crash.** The coordinator has sent "PREPARE" to all participants, received "READY" from all of them, and sent "COMMIT" to participant A. Then the coordinator crashes. Participant A has committed. Participants B and C are in the "prepared" state, holding locks, waiting indefinitely. The system is now partially committed with no automatic recovery. A human administrator must inspect transaction logs across all three participants to manually decide whether to commit or abort B and C. This is the operational disaster that saga avoids.

**Two-phase commit failure mode 2: lock contention under load.** During the "PREPARE" phase, each participant holds locks on the rows it modified. If the transaction involves the inventory table and another concurrent transaction also needs the inventory table, that second transaction is blocked until the two-phase commit completes. At 1,000 concurrent orders, this becomes a serialization bottleneck that destroys throughput even when every transaction eventually succeeds.

**Saga trade-off: dirty reads.** In the window between step 1 committing (order created) and step 3 committing (payment confirmed), another query for "pending orders" will see the order even though the saga may eventually cancel it. This is what "eventual consistency" means in practice. Your application code must handle this by modeling order status explicitly (pending, confirmed, canceled) and filtering appropriately rather than assuming every visible record is a committed, stable entity.

The `EventualConsistencyWindow` tracker in the code above turns this from a vague concern into a measurable SLO. If your `GetAverageConvergence` returns 45 seconds for the order saga, you know to add a UI message like "your order is being processed, this typically completes in under a minute" rather than showing a spinner with no context.

### Senior @ FAANG: Bounded Consistency as an Engineering Contract

The senior-track note in this section, about naming the convergence window, is one of the most important practical points in the chapter. At FAANG scale "eventually consistent" without a named bound is an operational anti-pattern.

**Why bounded eventual consistency matters for SLOs.** When you write an SLO that says "99.9% of order sagas converge within 30 seconds, 100% within 5 minutes or the on-call is paged," you have made several concrete commitments: the 30-second bucket is measured and alerted on, the 5-minute bucket is a hard ceiling that triggers an incident, and anything in the dead-letter state after 5 minutes is a customer-impacting incident by definition. Without the named bounds, SREs have no signal to alert on, engineers have no bar to build toward, and "eventually" expands to "whenever the system feels like it."

**Designing the convergence SLO.** The convergence time for a saga is the sum of worst-case step latencies under retry, plus coordination overhead. For an orchestrator-based saga with four steps, each with a 10-second timeout and two retries, the worst-case forward path is 120 seconds (three attempts per step times four steps). The worst-case compensation path adds another 120 seconds. An SLO of 5 minutes for 100% convergence is tight but achievable if you instrument and alert on every step.

**The `EventualConsistencyWindow` pattern in production.** The struct in the code uses a simple rolling average for `avgConvergence`. In production you want histogram quantiles (p50, p95, p99, p999) because the average hides long-tail outliers. A p50 of 2 seconds and a p999 of 30 minutes indicates a small fraction of sagas getting stuck, which the average makes invisible. Export these as Prometheus histogram metrics, not gauges, so you can compute quantiles in Grafana across any time window.

**Cross-service consistency windows.** A single saga's convergence window is only one dimension. At platform scale you also care about the cross-saga consistency window: if 10 sagas all modify the same inventory row, in what order do they converge, and can a customer observe inventory going up before going down (due to a concurrent reservation and release)? This requires either optimistic concurrency control on the inventory row (version numbers checked at compensation time) or a serialization gate (the inventory service processes commands for a given product sequentially via a per-product Kafka partition). Staff engineers make this choice based on measured contention rates, not assumptions.

---
