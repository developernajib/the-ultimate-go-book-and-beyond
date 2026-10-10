## Section 3: Saga Pattern with Temporal

### 3.1 Distributed Transaction Saga

The Saga pattern coordinates distributed transactions by executing a sequence of steps and running compensating transactions in reverse order if any step fails. Unlike two-phase commit, sagas do not hold locks across services - each step commits locally and the compensation undoes it if a later step fails. The following implementation provides a reusable `Saga` struct that tracks completed steps and runs their compensations in reverse on failure. The `TravelBookingWorkflow` at the bottom shows how to use it for a multi-service booking scenario.

```go
package saga

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// SagaStep defines one step in a saga with its compensation.
type SagaStep struct {
	Name        string
	Execute     any // activity function
	Compensate  any // rollback activity function
	ExecuteArgs []any
	CompensateArgs []any
}

// Saga executes steps in order and rolls back on failure.
type Saga struct {
	steps       []SagaStep
	compensated []SagaStep // steps that completed and need compensation
}

func (s *Saga) AddStep(step SagaStep) {
	s.steps = append(s.steps, step)
}

// Execute runs all saga steps. On failure, compensates completed steps in reverse.
func (s *Saga) Execute(ctx workflow.Context) error {
	actOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    3,
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOpts)

	for _, step := range s.steps {
		workflow.GetLogger(ctx).Info("Executing saga step", "step", step.Name)

		future := workflow.ExecuteActivity(ctx, step.Execute, step.ExecuteArgs...)
		if err := future.Get(ctx, nil); err != nil {
			workflow.GetLogger(ctx).Error("Saga step failed, compensating", "step", step.Name, "error", err)
			return s.compensate(ctx, err)
		}
		s.compensated = append(s.compensated, step)
	}
	return nil
}

func (s *Saga) compensate(ctx workflow.Context, originalErr error) error {
	// Compensate in reverse order
	compOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 10, // Compensations must succeed
			InitialInterval: time.Second,
			BackoffCoefficient: 2.0,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, compOpts)

	var compErrors []string
	for i := len(s.compensated) - 1; i >= 0; i-- {
		step := s.compensated[i]
		if step.Compensate == nil {
			continue
		}
		workflow.GetLogger(ctx).Info("Compensating", "step", step.Name)
		if err := workflow.ExecuteActivity(ctx, step.Compensate, step.CompensateArgs...).Get(ctx, nil); err != nil {
			compErrors = append(compErrors, fmt.Sprintf("%s: %v", step.Name, err))
		}
	}

	if len(compErrors) > 0 {
		return fmt.Errorf("saga failed (%v) + compensation errors: %v", originalErr, compErrors)
	}
	return fmt.Errorf("saga failed and compensated: %w", originalErr)
}

// TravelBookingWorkflow demonstrates the saga pattern for distributed booking.
func TravelBookingWorkflow(ctx workflow.Context, tripID, customerID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting travel booking saga", "trip_id", tripID)

	saga := &Saga{}

	saga.AddStep(SagaStep{
		Name:           "book-flight",
		Execute:        "BookFlight",
		ExecuteArgs:    []any{tripID, customerID},
		Compensate:     "CancelFlight",
		CompensateArgs: []any{tripID},
	})

	saga.AddStep(SagaStep{
		Name:           "book-hotel",
		Execute:        "BookHotel",
		ExecuteArgs:    []any{tripID, customerID},
		Compensate:     "CancelHotel",
		CompensateArgs: []any{tripID},
	})

	saga.AddStep(SagaStep{
		Name:           "charge-customer",
		Execute:        "ChargeCustomer",
		ExecuteArgs:    []any{customerID, tripID},
		Compensate:     "RefundCustomer",
		CompensateArgs: []any{tripID},
	})

	saga.AddStep(SagaStep{
		Name:        "send-confirmation",
		Execute:     "SendConfirmation",
		ExecuteArgs: []any{customerID, tripID},
		// No compensation needed - email already sent
	})

	return saga.Execute(ctx)
}
```

Notice that the compensation retry policy uses `MaximumAttempts: 10` - much higher than the forward steps. Compensations must eventually succeed to maintain consistency, so they get more aggressive retries. The last step (send-confirmation) has no `Compensate` function because you cannot unsend an email - this is a common pattern where the final notification step is treated as best-effort.

Temporal's durability guarantees that the `compensated` slice survives worker crashes. If a worker dies mid-compensation, Temporal replays the history and resumes compensation from where it left off. This eliminates the "lost compensation" problem that plagues hand-rolled saga implementations.

### Junior -> FAANG: Understanding Compensation Before You Write It

The saga pattern is one of the most tested distributed systems topics at FAANG interviews. The prerequisite gap for most candidates is understanding why two-phase commit is not the answer for multi-service transactions. 2PC requires a distributed lock coordinator and blocks all participants until the coordinator resolves. That design does not survive coordinator failures gracefully and does not scale across autonomous services. Sagas avoid locks by letting each service commit locally and relying on compensation to undo committed work when later steps fail.

The concrete thing to understand from the code above: the `compensated` slice grows with each successful step. If `ChargeCustomer` succeeds but `CreateShipment` fails, the slice contains `[book-flight, book-hotel, charge-customer]` and compensation runs in reverse: `RefundCustomer`, `CancelHotel`, `CancelFlight`. The order matters because some compensations depend on previous ones having completed first.

Worked example for the interview: the last step (`send-confirmation`) has no compensation. This is intentional. You cannot un-send an email. This is called a "pivot transaction" in saga literature: the last irreversible action that separates the forward path from the backward path. Design sagas so the pivot comes as late as possible, and make everything before it compensatable.

First-job habit: compensation activities need higher retry counts than forward activities. Compensation must eventually succeed to maintain system consistency. If compensation exhausts its retries, the system is in an inconsistent state that requires human intervention. Design for this by having a final fallback that transitions the workflow to a "manual review" signal-wait state.

### Senior @ FAANG: Saga Governance, Partial Failures, and Compensation Reliability

**Compensation as a first-class API contract.** Each compensation activity is an implicit promise to the saga orchestrator that the prior step's effect will be undone. This promise must be honored idempotently. If `CancelFlight` is called twice because the worker crashed mid-compensation, the airline API must return success on the second call rather than an error. External APIs that do not support idempotent cancellation require a wrapper activity that checks cancellation status before calling cancel, implemented as a read-then-write with the flight booking ID as the idempotency key.

**Compensation failure handling beyond retry exhaustion.** The `Saga.compensate` method above aggregates compensation errors and returns them as a combined error. In production, that combined error should trigger a structured alert: which business entity failed to compensate, which compensation step failed, and what manual action is required. A common pattern is to send the failed saga to a "dead letter" workflow that creates a support ticket and waits for a human-confirmation signal before marking the saga as resolved. This keeps the operational responsibility visible and tracked rather than buried in error logs.

**Saga observability.** Each saga step and each compensation call should emit a structured event with the step name, duration, and outcome. These events feed a dashboard that shows the distribution of saga outcomes: what percentage of orders failed at each step, how long compensation takes by step, and how often compensation retries are needed. This data informs decisions about which external services need reliability improvements and which compensation policies are too aggressive or too lenient.

**Choreography vs orchestration as a recurring staff-level conversation.** Temporal sagas are orchestrated: one workflow function owns the end-to-end sequence. Teams building event-driven architectures sometimes push back on orchestration, preferring choreography where each service reacts to events without a central coordinator. The staff-level answer: orchestration is the right choice when the business process has a clear owner and requires auditable end-to-end tracking. Choreography is the right choice when services need to remain fully autonomous and the process has no single owner. Temporal sagas win when auditability and compensation correctness are paramount. Event-driven choreography wins when you cannot afford a central coordinator as a single point of operational dependency.

**Long-running sagas and history growth.** A saga with 20 forward steps and 20 compensations that each retry several times can consume hundreds of history events. At scale with thousands of concurrent sagas, this adds up quickly. Design long sagas (more than 10 steps) with Continue-As-New in mind: if the saga has a natural checkpoint after a set of steps (e.g., "booking phase" vs "payment phase"), consider running each phase as a separate child workflow. This limits each workflow's history size while preserving the overall saga's durability guarantees. The tradeoff is increased complexity in result aggregation across child workflows.

**Testing compensation paths as a non-negotiable requirement.** The most common production saga bug is untested compensation code that silently fails. Every saga in production must have a test that injects a failure at each step and asserts that all prior compensations were called in the correct order. The `testsuite` package makes this straightforward: mock the failing step to return an error, mock each compensation to record whether it was called, and assert the call sequence. This test suite must be maintained alongside the workflow code and run on every pull request.

---
