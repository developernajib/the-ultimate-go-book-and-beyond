## 27.6 Saga Pattern for Distributed Transactions

> **Senior track**: Two styles exist. **Orchestration** (shown here) has a central coordinator calling each service, easier to reason about, easier to add steps, single point of failure if not durable. **Choreography** has services react to events with no central brain, more decoupled, harder to debug (no single place to see flow). For production Go, hand-rolling orchestrators is rarely the right call, **Temporal.io** (and its predecessor Cadence) provides durable-execution workflows where retries, timeouts, and compensation are declarative and survive crashes without external state. Every compensation must itself be idempotent, networks fail during rollback too. Also: compensations are semantic reversals, not transactional rollbacks, refunding a charge is a new operation, not an undo.

### Saga Orchestrator

A saga is a sequence of local transactions, each with a compensating transaction that undoes its effect. The orchestrator executes steps in order and, on any failure, runs the compensation functions in reverse order to roll back the already-committed steps. This achieves eventual consistency across distributed services without holding distributed locks or requiring two-phase commit.

```go
package saga

import (
    "context"
    "errors"
    "log/slog"
)

type Step struct {
    Name       string
    Execute    func(ctx context.Context, state map[string]any) error
    Compensate func(ctx context.Context, state map[string]any) error
}

type SagaOrchestrator struct {
    steps  []Step
    logger *slog.Logger
}

func NewSagaOrchestrator(logger *slog.Logger) *SagaOrchestrator {
    return &SagaOrchestrator{
        steps:  make([]Step, 0),
        logger: logger,
    }
}

func (s *SagaOrchestrator) AddStep(step Step) {
    s.steps = append(s.steps, step)
}

func (s *SagaOrchestrator) Execute(ctx context.Context) error {
    state := make(map[string]any)
    executedSteps := make([]Step, 0)

    for _, step := range s.steps {
        s.logger.Info("executing saga step", "step", step.Name)

        if err := step.Execute(ctx, state); err != nil {
            s.logger.Error("saga step failed", "step", step.Name, "error", err)

            // Compensate in reverse order
            if compensateErr := s.compensate(ctx, executedSteps, state); compensateErr != nil {
                return errors.Join(err, compensateErr)
            }

            return err
        }

        executedSteps = append(executedSteps, step)
    }

    return nil
}

func (s *SagaOrchestrator) compensate(ctx context.Context, executedSteps []Step, state map[string]any) error {
    var errs []error

    // Compensate in reverse order
    for i := len(executedSteps) - 1; i >= 0; i-- {
        step := executedSteps[i]
        if step.Compensate == nil {
            continue
        }

        s.logger.Info("compensating saga step", "step", step.Name)

        if err := step.Compensate(ctx, state); err != nil {
            s.logger.Error("compensation failed", "step", step.Name, "error", err)
            errs = append(errs, err)
        }
    }

    if len(errs) > 0 {
        return errors.Join(errs...)
    }

    return nil
}
```

### Example: Order Processing Saga

The order processing saga chains three steps, inventory reservation, payment charge, and order confirmation, each paired with its own compensating action. If the payment step fails after inventory has already been reserved, the orchestrator calls `CancelReservation` automatically. This is the key advantage over a two-phase commit, since each service only needs to expose a local rollback operation rather than a distributed lock protocol.

```go
package order

func CreateOrderSaga(orderService *OrderService, paymentService *PaymentService, inventoryService *InventoryService) *saga.SagaOrchestrator {
    orchestrator := saga.NewSagaOrchestrator(slog.Default())

    // Step 1: Reserve inventory
    orchestrator.AddStep(saga.Step{
        Name: "reserve_inventory",
        Execute: func(ctx context.Context, state map[string]any) error {
            orderID := state["order_id"].(string)
            items := state["items"].([]OrderItem)

            reservationID, err := inventoryService.Reserve(ctx, orderID, items)
            if err != nil {
                return err
            }

            state["reservation_id"] = reservationID
            return nil
        },
        Compensate: func(ctx context.Context, state map[string]any) error {
            reservationID := state["reservation_id"].(string)
            return inventoryService.CancelReservation(ctx, reservationID)
        },
    })

    // Step 2: Process payment
    orchestrator.AddStep(saga.Step{
        Name: "process_payment",
        Execute: func(ctx context.Context, state map[string]any) error {
            orderID := state["order_id"].(string)
            amountCents := state["amount_cents"].(int64) // integer cents, never float64
            userID := state["user_id"].(string)

            paymentID, err := paymentService.Charge(ctx, userID, orderID, amountCents)
            if err != nil {
                return err
            }

            state["payment_id"] = paymentID
            return nil
        },
        Compensate: func(ctx context.Context, state map[string]any) error {
            paymentID := state["payment_id"].(string)
            return paymentService.Refund(ctx, paymentID)
        },
    })

    // Step 3: Create order
    orchestrator.AddStep(saga.Step{
        Name: "create_order",
        Execute: func(ctx context.Context, state map[string]any) error {
            orderID := state["order_id"].(string)
            return orderService.ConfirmOrder(ctx, orderID)
        },
        Compensate: func(ctx context.Context, state map[string]any) error {
            orderID := state["order_id"].(string)
            return orderService.CancelOrder(ctx, orderID)
        },
    })

    return orchestrator
}
```

### Staff Lens: Saga Pattern for Cross-Service Workflows

Sagas replace distributed transactions (2PC) with local transactions plus compensations. Simpler to operate, but compensation logic must handle every failure point. Design compensations carefully and test them.

---
