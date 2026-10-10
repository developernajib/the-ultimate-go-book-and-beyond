## 50.7 Common Mistakes

### Mistake 1: Not Making Compensations Idempotent

Compensation actions must be idempotent because the orchestrator may retry them on transient failure. A `CancelPayment` that charges a refund fee on every invocation will over-refund customers when the first attempt times out and is retried. The fix records compensation execution in a database table keyed by saga ID and step name. Subsequent calls return immediately if the row already exists. This check-and-set must use a unique constraint rather than a SELECT-then-INSERT to be safe under concurrent retry attempts.

```go
// pkg/saga/mistakes/idempotency.go
package mistakes

import (
	"context"
	"database/sql"
	"fmt"
)

// BAD: Non-idempotent compensation
type BadInventoryService struct {
	db *sql.DB
}

func (s *BadInventoryService) ReleaseInventory(ctx context.Context, reservationID string) error {
	// Problem: If called twice, releases inventory twice
	_, err := s.db.ExecContext(ctx, `
		UPDATE inventory
		SET quantity = quantity + (
			SELECT quantity FROM reservations WHERE id = $1
		)
		WHERE product_id = (
			SELECT product_id FROM reservations WHERE id = $1
		)
	`, reservationID)
	return err
}

// GOOD: Idempotent compensation with status tracking
type GoodInventoryService struct {
	db *sql.DB
}

func (s *GoodInventoryService) ReleaseInventory(ctx context.Context, reservationID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check if already compensated
	var status string
	err = tx.QueryRowContext(ctx, `
		SELECT status FROM reservations WHERE id = $1 FOR UPDATE
	`, reservationID).Scan(&status)
	if err != nil {
		return fmt.Errorf("get reservation status: %w", err)
	}

	// Idempotent: skip if already released
	if status == "released" || status == "compensated" {
		return nil // Already compensated, no-op
	}

	// Release inventory
	_, err = tx.ExecContext(ctx, `
		UPDATE inventory
		SET quantity = quantity + (
			SELECT quantity FROM reservations WHERE id = $1
		)
		WHERE product_id = (
			SELECT product_id FROM reservations WHERE id = $1
		)
	`, reservationID)
	if err != nil {
		return err
	}

	// Mark as released to prevent duplicate compensation
	_, err = tx.ExecContext(ctx, `
		UPDATE reservations SET status = 'released', released_at = NOW() WHERE id = $1
	`, reservationID)
	if err != nil {
		return err
	}

	return tx.Commit()
}
```

### Mistake 2: Ignoring Compensation Failures

When a compensation action itself fails (e.g., the payment service is down during a refund attempt), silently logging and continuing leaves the system in a partially compensated state with no record for manual remediation. The correct response is to persist the failed compensation with its error details to a dedicated `saga_failed_compensations` table, emit an alert, and retry with exponential backoff up to a configured limit. If retries are exhausted, the saga must transition to a `COMPENSATION_FAILED` terminal state that triggers a human-review workflow rather than being silently lost.

```go
// pkg/saga/mistakes/compensation_failure.go
package mistakes

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// BAD: Silently ignoring compensation failures
type BadSagaOrchestrator struct{}

func (o *BadSagaOrchestrator) Compensate(ctx context.Context, steps []CompletedStep) {
	for _, step := range steps {
		// Problem: Just logs and continues, leaving system inconsistent
		if err := step.Compensate(ctx); err != nil {
			slog.Error("compensation failed", "step", step.Name, "error", err)
			// Continues to next step, doesn't handle failure
		}
	}
}

// GOOD: Proper compensation failure handling
type GoodSagaOrchestrator struct {
	deadLetterQueue DeadLetterQueue
	alerter         Alerter
	maxRetries      int
}

type DeadLetterQueue interface {
	Enqueue(ctx context.Context, item FailedCompensation) error
}

type Alerter interface {
	SendAlert(ctx context.Context, severity string, message string) error
}

type FailedCompensation struct {
	SagaID          string
	StepName        string
	CompensationData any
	FailedAt        time.Time
	Attempts        int
	LastError       string
}

type CompletedStep struct {
	Name       string
	Data       any
	Compensate func(ctx context.Context) error
}

func (o *GoodSagaOrchestrator) Compensate(ctx context.Context, sagaID string, steps []CompletedStep) error {
	var compensationErrors []error

	for i := len(steps) - 1; i >= 0; i-- {
		step := steps[i]

		// Retry compensation with backoff
		var lastErr error
		for attempt := 1; attempt <= o.maxRetries; attempt++ {
			if err := step.Compensate(ctx); err != nil {
				lastErr = err
				slog.Warn("compensation attempt failed",
					"saga", sagaID,
					"step", step.Name,
					"attempt", attempt,
					"error", err,
				)

				// Exponential backoff
				time.Sleep(time.Duration(attempt*attempt) * time.Second)
				continue
			}
			lastErr = nil
			break
		}

		if lastErr != nil {
			// All retries failed - enqueue for manual intervention
			compensationErrors = append(compensationErrors, lastErr)

			// Send to dead letter queue for later processing
			if err := o.deadLetterQueue.Enqueue(ctx, FailedCompensation{
				SagaID:          sagaID,
				StepName:        step.Name,
				CompensationData: step.Data,
				FailedAt:        time.Now(),
				Attempts:        o.maxRetries,
				LastError:       lastErr.Error(),
			}); err != nil {
				slog.Error("failed to enqueue compensation", "error", err)
			}

			// Alert operations team
			o.alerter.SendAlert(ctx, "critical",
				fmt.Sprintf("Saga %s compensation failed for step %s after %d attempts",
					sagaID, step.Name, o.maxRetries))
		}
	}

	if len(compensationErrors) > 0 {
		return fmt.Errorf("compensation partially failed: %d steps need manual intervention",
			len(compensationErrors))
	}

	return nil
}
```

### Mistake 3: Missing Saga Timeout

Without a saga-level deadline, a saga waiting for a participant that never responds will remain in a `PENDING` state forever, holding reserved inventory and blocking related customer actions. The implementation stores a `deadline` timestamp alongside saga state and runs a background sweeper that queries for sagas past their deadline and triggers compensation on them. Using a database-backed deadline rather than a Go timer ensures the timeout fires correctly even when the orchestrator process restarts before the timer elapses.

```go
// pkg/saga/mistakes/timeout.go
package mistakes

import (
	"context"
	"fmt"
	"time"
)

// BAD: Saga without timeout can run forever
type BadSaga struct {
	steps []SagaStep
}

type SagaStep struct {
	Name       string
	Execute    func(ctx context.Context) error
	Compensate func(ctx context.Context) error
}

func (s *BadSaga) Execute(ctx context.Context) error {
	// Problem: No timeout - saga can hang indefinitely
	for _, step := range s.steps {
		if err := step.Execute(ctx); err != nil {
			return err
		}
	}
	return nil
}

// GOOD: Saga with proper timeout and step-level timeouts
type GoodSaga struct {
	steps        []TimedSagaStep
	sagaTimeout  time.Duration
	stepTimeout  time.Duration
}

type TimedSagaStep struct {
	Name       string
	Timeout    time.Duration // Step-specific timeout
	Execute    func(ctx context.Context) error
	Compensate func(ctx context.Context) error
}

func (s *GoodSaga) Execute(ctx context.Context) error {
	// Overall saga timeout
	ctx, cancel := context.WithTimeout(ctx, s.sagaTimeout)
	defer cancel()

	completedSteps := make([]TimedSagaStep, 0, len(s.steps))

	for _, step := range s.steps {
		// Check if saga already timed out
		select {
		case <-ctx.Done():
			s.compensate(ctx, completedSteps)
			return fmt.Errorf("saga timeout: %w", ctx.Err())
		default:
		}

		// Step-level timeout (use step-specific or default)
		stepTimeout := step.Timeout
		if stepTimeout == 0 {
			stepTimeout = s.stepTimeout
		}

		stepCtx, stepCancel := context.WithTimeout(ctx, stepTimeout)
		err := step.Execute(stepCtx)
		stepCancel()

		if err != nil {
			s.compensate(ctx, completedSteps)
			return fmt.Errorf("step %s failed: %w", step.Name, err)
		}

		completedSteps = append(completedSteps, step)
	}

	return nil
}

func (s *GoodSaga) compensate(ctx context.Context, steps []TimedSagaStep) {
	// Use fresh context for compensation (original may have timed out)
	compensateCtx, cancel := context.WithTimeout(context.Background(), s.sagaTimeout)
	defer cancel()

	for i := len(steps) - 1; i >= 0; i-- {
		step := steps[i]
		if err := step.Compensate(compensateCtx); err != nil {
			// Log but continue compensation
			fmt.Printf("compensation failed for %s: %v\n", step.Name, err)
		}
	}
}
```

### Mistake 4: Coupling Saga Logic to Business Logic

Embedding saga coordination logic (event publishing, state transitions, compensation registration) directly inside domain service methods couples the business operation to the distributed transaction infrastructure, making both harder to test and evolve independently. The fix extracts saga steps into a separate package that calls business services through interfaces, so the `OrderService` focuses solely on order creation logic while the saga step handles coordination concerns. This separation also makes it possible to unit-test the saga step with a mock business service and the business logic with no saga infrastructure at all.

```go
// pkg/saga/mistakes/coupling.go
package mistakes

import (
	"context"
	"database/sql"
)

// BAD: Saga logic mixed with business logic
type BadOrderService struct {
	db          *sql.DB
	paymentSvc  PaymentService
	inventorySvc InventoryService
}

type PaymentService interface {
	Charge(ctx context.Context, amountCents int64) (string, error)
	Refund(ctx context.Context, paymentID string) error
}

type InventoryService interface {
	Reserve(ctx context.Context, items []Item) (string, error)
	Release(ctx context.Context, reservationID string) error
}

type Item struct {
	ProductID string
	Quantity  int
}

func (s *BadOrderService) CreateOrder(ctx context.Context, req OrderRequest) error {
	// Problem: Order service knows about saga compensation
	// Makes it hard to test, maintain, and reuse

	// Create order
	orderID, err := s.createOrder(ctx, req)
	if err != nil {
		return err
	}

	// Reserve inventory
	reservationID, err := s.inventorySvc.Reserve(ctx, req.Items)
	if err != nil {
		// Saga compensation mixed with business logic
		s.cancelOrder(ctx, orderID)
		return err
	}

	// Charge payment
	paymentID, err := s.paymentSvc.Charge(ctx, req.TotalCents)
	if err != nil {
		// More compensation logic
		s.inventorySvc.Release(ctx, reservationID)
		s.cancelOrder(ctx, orderID)
		return err
	}

	return s.confirmOrder(ctx, orderID, paymentID)
}

type OrderRequest struct {
	Items []Item
	TotalCents int64
}

func (s *BadOrderService) createOrder(ctx context.Context, req OrderRequest) (string, error) {
	return "", nil
}

func (s *BadOrderService) cancelOrder(ctx context.Context, orderID string) error {
	return nil
}

func (s *BadOrderService) confirmOrder(ctx context.Context, orderID, paymentID string) error {
	return nil
}

// GOOD: Saga logic separated from business logic
type GoodOrderService struct {
	db *sql.DB
}

// Pure business logic - no saga awareness
func (s *GoodOrderService) CreateOrder(ctx context.Context, req OrderRequest) (string, error) {
	// Only handles order creation, nothing else
	var orderID string
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO orders (items, total_cents, status) VALUES ($1, $2, 'pending')
		RETURNING id
	`, req.Items, req.TotalCents).Scan(&orderID)
	return orderID, err
}

func (s *GoodOrderService) ConfirmOrder(ctx context.Context, orderID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE orders SET status = 'confirmed' WHERE id = $1`, orderID)
	return err
}

func (s *GoodOrderService) CancelOrder(ctx context.Context, orderID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE orders SET status = 'canceled' WHERE id = $1`, orderID)
	return err
}

// Saga orchestrator - handles coordination
type OrderSagaOrchestrator struct {
	orderSvc     *GoodOrderService
	paymentSvc   PaymentService
	inventorySvc InventoryService
}

func (o *OrderSagaOrchestrator) Execute(ctx context.Context, req OrderRequest) error {
	saga := NewSaga("order_creation")

	var orderID, reservationID, paymentID string

	saga.AddStep(
		"create_order",
		func(ctx context.Context) error {
			var err error
			orderID, err = o.orderSvc.CreateOrder(ctx, req)
			return err
		},
		func(ctx context.Context) error {
			return o.orderSvc.CancelOrder(ctx, orderID)
		},
	)

	saga.AddStep(
		"reserve_inventory",
		func(ctx context.Context) error {
			var err error
			reservationID, err = o.inventorySvc.Reserve(ctx, req.Items)
			return err
		},
		func(ctx context.Context) error {
			return o.inventorySvc.Release(ctx, reservationID)
		},
	)

	saga.AddStep(
		"charge_payment",
		func(ctx context.Context) error {
			var err error
			paymentID, err = o.paymentSvc.Charge(ctx, req.TotalCents)
			return err
		},
		func(ctx context.Context) error {
			return o.paymentSvc.Refund(ctx, paymentID)
		},
	)

	saga.AddStep(
		"confirm_order",
		func(ctx context.Context) error {
			return o.orderSvc.ConfirmOrder(ctx, orderID)
		},
		nil, // No compensation - this is the final step
	)

	return saga.Execute(ctx)
}

// Saga is a simple saga executor
type Saga struct {
	name  string
	steps []SagaStep
}

func NewSaga(name string) *Saga {
	return &Saga{name: name}
}

func (s *Saga) AddStep(name string, execute, compensate func(ctx context.Context) error) {
	s.steps = append(s.steps, SagaStep{
		Name:       name,
		Execute:    execute,
		Compensate: compensate,
	})
}

func (s *Saga) Execute(ctx context.Context) error {
	var completedSteps []SagaStep

	for _, step := range s.steps {
		if err := step.Execute(ctx); err != nil {
			// Compensate in reverse
			for i := len(completedSteps) - 1; i >= 0; i-- {
				if completedSteps[i].Compensate != nil {
					completedSteps[i].Compensate(ctx)
				}
			}
			return err
		}
		completedSteps = append(completedSteps, step)
	}

	return nil
}
```

### Mistake 5: Not Persisting Saga State

Keeping saga state only in memory means every orchestrator restart loses track of all in-progress sagas, leaving participants in inconsistent states with no record of what needs to be compensated. The database-persisted saga state machine serializes the current step index, status, and saga payload to a `sagas` table before executing each step, so a crashed orchestrator can reload all `IN_PROGRESS` rows on startup and resume from the correct step. This persistence also enables the operational dashboard and timeout sweeper shown in earlier sections to work correctly across process boundaries.

```go
// pkg/saga/mistakes/persistence.go
package mistakes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// BAD: In-memory saga state lost on crash
type BadInMemorySaga struct {
	currentStep int
	state       map[string]any
	// Problem: If process crashes, saga state is lost
	// System left in inconsistent state with no way to recover
}

// GOOD: Persisted saga state for crash recovery
type PersistedSaga struct {
	db          *sql.DB
	sagaID      string
	sagaType    string
	state       *SagaState
}

type SagaState struct {
	ID             string                 `json:"id"`
	Type           string                 `json:"type"`
	Status         string                 `json:"status"`
	CurrentStep    int                    `json:"current_step"`
	CompletedSteps []string               `json:"completed_steps"`
	StepData       map[string]any `json:"step_data"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
	Error          string                 `json:"error,omitempty"`
}

// NewPersistedSaga creates a new saga with persisted state
func NewPersistedSaga(db *sql.DB, sagaType string) (*PersistedSaga, error) {
	sagaID := fmt.Sprintf("%s_%d", sagaType, time.Now().UnixNano())
	state := &SagaState{
		ID:             sagaID,
		Type:           sagaType,
		Status:         "started",
		CurrentStep:    0,
		CompletedSteps: []string{},
		StepData:       make(map[string]any),
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	// Persist initial state
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}

	_, err = db.Exec(`
		INSERT INTO sagas (id, type, status, state, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, sagaID, sagaType, "started", stateJSON, state.CreatedAt, state.UpdatedAt)
	if err != nil {
		return nil, err
	}

	return &PersistedSaga{
		db:       db,
		sagaID:   sagaID,
		sagaType: sagaType,
		state:    state,
	}, nil
}

// RecoverSaga recovers a saga from persisted state
func RecoverSaga(db *sql.DB, sagaID string) (*PersistedSaga, error) {
	var stateJSON []byte
	var sagaType string

	err := db.QueryRow(`
		SELECT type, state FROM sagas WHERE id = $1
	`, sagaID).Scan(&sagaType, &stateJSON)
	if err != nil {
		return nil, fmt.Errorf("load saga: %w", err)
	}

	var state SagaState
	if err := json.Unmarshal(stateJSON, &state); err != nil {
		return nil, fmt.Errorf("unmarshal state: %w", err)
	}

	return &PersistedSaga{
		db:       db,
		sagaID:   sagaID,
		sagaType: sagaType,
		state:    &state,
	}, nil
}

// CompleteStep marks a step as complete and persists state
func (s *PersistedSaga) CompleteStep(ctx context.Context, stepName string, data any) error {
	s.state.CompletedSteps = append(s.state.CompletedSteps, stepName)
	s.state.StepData[stepName] = data
	s.state.CurrentStep++
	s.state.UpdatedAt = time.Now()

	return s.persist(ctx)
}

// MarkFailed marks the saga as failed
func (s *PersistedSaga) MarkFailed(ctx context.Context, err error) error {
	s.state.Status = "failed"
	s.state.Error = err.Error()
	s.state.UpdatedAt = time.Now()

	return s.persist(ctx)
}

// MarkCompensating marks saga as compensating
func (s *PersistedSaga) MarkCompensating(ctx context.Context) error {
	s.state.Status = "compensating"
	s.state.UpdatedAt = time.Now()

	return s.persist(ctx)
}

// MarkCompensated marks saga as fully compensated
func (s *PersistedSaga) MarkCompensated(ctx context.Context) error {
	s.state.Status = "compensated"
	s.state.UpdatedAt = time.Now()

	return s.persist(ctx)
}

// persist saves current state to database
func (s *PersistedSaga) persist(ctx context.Context) error {
	stateJSON, err := json.Marshal(s.state)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		UPDATE sagas SET status = $1, state = $2, updated_at = $3 WHERE id = $4
	`, s.state.Status, stateJSON, s.state.UpdatedAt, s.sagaID)

	return err
}

// GetCompletedSteps returns steps that need compensation
func (s *PersistedSaga) GetCompletedSteps() []string {
	return s.state.CompletedSteps
}

// GetStepData retrieves data from a completed step
func (s *PersistedSaga) GetStepData(stepName string) any {
	return s.state.StepData[stepName]
}

// RecoverIncompleteSagas finds and recovers all incomplete sagas
func RecoverIncompleteSagas(db *sql.DB) ([]*PersistedSaga, error) {
	rows, err := db.Query(`
		SELECT id FROM sagas
		WHERE status IN ('started', 'running', 'compensating')
		AND updated_at < NOW() - INTERVAL '5 minutes'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sagas []*PersistedSaga
	for rows.Next() {
		var sagaID string
		if err := rows.Scan(&sagaID); err != nil {
			continue
		}

		saga, err := RecoverSaga(db, sagaID)
		if err != nil {
			continue
		}

		sagas = append(sagas, saga)
	}

	return sagas, nil
}
```

### Junior -> FAANG: The Mistake Pattern to Memorize

Each mistake in this section follows the same pattern: a plausible first attempt that works in unit tests and breaks in production under concurrent load, process failure, or network retry. Memorizing the pattern, not just the fix, lets you apply it to mistakes not listed here.

The pattern is: "I assumed this operation would run exactly once." The non-idempotent compensation (Mistake 1) assumes the compensation runs exactly once. The in-memory saga state (Mistake 5) assumes the process runs without crashing. The missing timeout (Mistake 3) assumes participants always respond within a reasonable time. Every saga design mistake reduces to a violated exactly-once assumption.

The interview question that surfaces this pattern is: "what happens if your saga step is called twice with the same inputs?" Work through the answer for every step in your saga before the interview. "Twice" covers: Kafka at-least-once delivery, orchestrator retry after a timeout, orchestrator recovery after a crash, and a client that retried because it did not receive a response.

For the coupling mistake (Mistake 4), the fix introduces a separation that makes testing dramatically easier. The `GoodOrderService` has zero dependency on any other service and can be tested with just a database. The `OrderSagaOrchestrator` has zero dependency on the database and can be tested with mock implementations of `PaymentService` and `InventoryService`. This separation is what "single responsibility" means in a microservices context: the business service is responsible for business rules, the orchestrator is responsible for coordination, and neither knows about the other's internals.

### Senior @ FAANG: Common Mistakes as Code Review Gates

At FAANG scale, these five mistakes occur in pull requests every week. Staff engineers establish code review practices that catch them before merge rather than after incident.

**Automated idempotency check in CI.** Mistake 1 (non-idempotent compensation) is detectable by static analysis if your compensation functions follow a consistent interface. Define a `Compensator` interface that returns a structured `CompensationResult` with an `AlreadyCompensated bool` field. A custom lint rule can verify that every implementation of `Compensator` checks `AlreadyCompensated` before performing any state-mutating operation. This enforces the pattern at the language level rather than relying on reviewers to catch it.

**Compensation failure as a required test case.** Mistake 2 (ignoring compensation failures) persists because engineers write happy-path tests and one failure test, but not a test for "compensation fails twice then succeeds" or "compensation exhausts all retries." Add this to your team's PR template as a required checkbox for any saga-related change: "I have a test case where the compensation function returns errors for N consecutive attempts before succeeding" and "I have a test case where the compensation function fails all N attempts and I verify the dead-letter behavior."

**Saga timeout as a required configuration field.** Mistake 3 (missing saga timeout) is prevented by making `SagaTimeout time.Duration` a required field in the saga definition struct, with a validation that rejects zero or negative values at saga registration time. This makes it impossible to register a saga without a timeout, which shifts the error from runtime (saga hangs forever) to startup (orchestrator panics on registration with a helpful error message).

**The persistence mistake is the most expensive in production.** Mistake 5 (not persisting saga state) is the one that causes the most severe incidents because its blast radius is proportional to the number of in-flight sagas at the time of the crash. At FAANG throughput, that can be tens of thousands of sagas in inconsistent state with no automated recovery path. The guard against this is an integration test that starts a saga, injects a process crash after a configurable step, restarts the orchestrator, and asserts that all sagas converge to a terminal state. This test is expensive to write and maintain but is the only reliable way to verify the recovery path works correctly, because recovery is exercised infrequently in production and the first time it fails in production is during a major incident.

**Coupling as a scaling bottleneck, not just a style issue.** Mistake 4 (coupling saga logic to business logic) matters at FAANG scale for a reason beyond testability: when the orchestrator and the business service are in the same binary, scaling one requires scaling the other. An e-commerce checkout saga that is CPU-bound in the payment step cannot be scaled independently of the order creation step if they share a binary. Separation of saga coordination into its own binary (whether that is a Temporal worker or a dedicated orchestrator process) allows independent scaling of the coordination layer and the execution layer.

---
