## 50.10 Saga Pattern Pitfalls: When Distributed Transactions Go Wrong

### Pitfall 1: The Non-Idempotent Compensation Catastrophe

**Incident Report**: An order saga compensated a payment by calling `refundPayment(orderID)`. Due to network retry, the compensation ran twice. The customer received a double refund, costing the company $50,000 before detection.

```go
// WRONG: Non-idempotent compensation
func (s *PaymentService) CompensatePayment(ctx context.Context, orderID string) error {
    payment, err := s.repo.GetPaymentByOrder(orderID)
    if err != nil {
        return err
    }

    // Issue refund - not idempotent!
    refund, err := s.stripe.Refund(payment.ChargeID, payment.AmountCents)
    if err != nil {
        return err
    }

    // If this line fails, retry will create another refund
    return s.repo.RecordRefund(orderID, refund.ID)
}

// CORRECT: Idempotent compensation with state checking
func (s *PaymentService) CompensatePayment(ctx context.Context, orderID string) error {
    payment, err := s.repo.GetPaymentByOrder(ctx, orderID)
    if err != nil {
        return err
    }

    // Check if already compensated
    if payment.RefundID != "" {
        log.Printf("Payment %s already refunded: %s", orderID, payment.RefundID)
        return nil  // Idempotent - safe to retry
    }

    // Generate idempotency key for Stripe
    idempotencyKey := fmt.Sprintf("refund-%s-%s", orderID, payment.ID)

    // Atomic: check-then-act with optimistic locking
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Re-check within transaction
    var refundID sql.NullString
    err = tx.QueryRowContext(ctx, `
        SELECT refund_id FROM payments WHERE order_id = $1 FOR UPDATE
    `, orderID).Scan(&refundID)
    if err != nil {
        return err
    }
    if refundID.Valid {
        return nil  // Already refunded
    }

    // Issue refund with idempotency key
    refund, err := s.stripe.Refund(payment.ChargeID, payment.AmountCents,
        stripe.WithIdempotencyKey(idempotencyKey))
    if err != nil {
        // Check if refund already exists (Stripe idempotency)
        if stripeErr, ok := err.(*stripe.Error); ok {
            if stripeErr.Code == stripe.ErrorCodeIdempotencyKeyInUse {
                // Refund was created, we just didn't record it
                existingRefund, _ := s.stripe.GetRefundByIdempotencyKey(idempotencyKey)
                refund = existingRefund
            } else {
                return err
            }
        } else {
            return err
        }
    }

    // Record refund atomically
    _, err = tx.ExecContext(ctx, `
        UPDATE payments SET refund_id = $1, refunded_at = $2
        WHERE order_id = $3 AND refund_id IS NULL
    `, refund.ID, time.Now(), orderID)
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

### Pitfall 2: The Stuck Saga Graveyard

**Incident Report**: A saga orchestrator had 10,000 sagas stuck in "COMPENSATING" state. The inventory service was down, so compensation couldn't complete. No alerts fired because sagas were technically "in progress." Orders were in limbo for 3 days.

```go
// WRONG: No timeout or monitoring for stuck sagas
type Saga struct {
    ID        string
    Status    string  // STARTED, COMPLETED, COMPENSATING, FAILED
    Steps     []SagaStep
    StartedAt time.Time
    // No deadline, no alerting
}

func (o *Orchestrator) ExecuteSaga(ctx context.Context, saga *Saga) error {
    for _, step := range saga.Steps {
        err := step.Execute(ctx)
        if err != nil {
            return o.compensate(ctx, saga)  // Can hang forever
        }
    }
    return nil
}

// CORRECT: Saga with deadlines, monitoring, and dead letter handling
type Saga struct {
    ID              string
    Status          SagaStatus
    Steps           []SagaStep
    StartedAt       time.Time
    Deadline        time.Time
    LastActivityAt  time.Time
    CompensateCount int
    StuckReason     string
}

type SagaMonitor struct {
    db      *sql.DB
    alerter Alerter
}

func (m *SagaMonitor) CheckStuckSagas(ctx context.Context) error {
    // Find sagas stuck in non-terminal states
    rows, err := m.db.QueryContext(ctx, `
        SELECT id, status, started_at, last_activity_at, compensate_count
        FROM sagas
        WHERE status NOT IN ('COMPLETED', 'FAILED', 'DEAD_LETTER')
        AND last_activity_at < NOW() - INTERVAL '5 minutes'
    `)
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var saga Saga
        rows.Scan(&saga.ID, &saga.Status, &saga.StartedAt, &saga.LastActivityAt, &saga.CompensateCount)

        stuckDuration := time.Since(saga.LastActivityAt)

        // Alert on stuck sagas
        if stuckDuration > 10*time.Minute {
            m.alerter.Alert(AlertSeverityWarning, fmt.Sprintf(
                "Saga %s stuck in %s for %v", saga.ID, saga.Status, stuckDuration))
        }

        // Move to dead letter after excessive time
        if stuckDuration > time.Hour {
            m.moveToDeadLetter(ctx, saga.ID, "stuck_timeout")
        }

        // Move to dead letter after excessive compensation attempts
        if saga.CompensateCount > 10 {
            m.moveToDeadLetter(ctx, saga.ID, "max_compensations_exceeded")
        }
    }

    return nil
}

func (m *SagaMonitor) moveToDeadLetter(ctx context.Context, sagaID, reason string) error {
    _, err := m.db.ExecContext(ctx, `
        UPDATE sagas
        SET status = 'DEAD_LETTER', stuck_reason = $1, dead_lettered_at = NOW()
        WHERE id = $2
    `, reason, sagaID)
    if err != nil {
        return err
    }

    m.alerter.Alert(AlertSeverityCritical, fmt.Sprintf(
        "Saga %s moved to dead letter: %s - requires manual intervention",
        sagaID, reason))

    return nil
}

// Orchestrator respects deadlines
func (o *Orchestrator) ExecuteSaga(ctx context.Context, saga *Saga) error {
    // Set saga deadline
    sagaCtx, cancel := context.WithDeadline(ctx, saga.Deadline)
    defer cancel()

    for i, step := range saga.Steps {
        select {
        case <-sagaCtx.Done():
            o.updateSaga(saga.ID, "DEADLINE_EXCEEDED", i)
            return o.compensateWithDeadline(ctx, saga, i)
        default:
        }

        err := step.Execute(sagaCtx)
        o.updateActivity(saga.ID)

        if err != nil {
            return o.compensateWithDeadline(ctx, saga, i)
        }
    }
    return nil
}
```

### Pitfall 3: The Partial Compensation Data Loss

**Incident Report**: A saga successfully reserved inventory but failed on payment. During compensation, the inventory service returned success but the orchestrator crashed before recording it. On restart, the saga re-ran compensation, but inventory had already been released. The saga completed without actually releasing inventory (it thought it did).

```go
// WRONG: Compensation state not persisted before execution
func (o *Orchestrator) compensate(ctx context.Context, saga *Saga, failedStep int) error {
    for i := failedStep - 1; i >= 0; i-- {
        err := saga.Steps[i].Compensate(ctx)
        if err != nil {
            return err  // Retry will re-run already-completed compensations
        }
        // Compensation success not recorded - lost if we crash here
    }
    return nil
}

// CORRECT: Persist compensation state at each step
func (o *Orchestrator) compensate(ctx context.Context, saga *Saga, failedStep int) error {
    for i := failedStep - 1; i >= 0; i-- {
        step := saga.Steps[i]

        // Check if this step's compensation already completed
        if step.CompensationStatus == "COMPLETED" {
            continue
        }

        // Mark compensation started BEFORE executing
        if err := o.updateStepCompensation(ctx, saga.ID, i, "STARTED"); err != nil {
            return err
        }

        // Execute compensation
        err := step.Compensate(ctx)

        if err != nil {
            // Record failure for retry decision
            o.updateStepCompensation(ctx, saga.ID, i, "FAILED")
            saga.CompensateCount++
            o.recordCompensationError(ctx, saga.ID, i, err)
            return fmt.Errorf("compensate step %d: %w", i, err)
        }

        // Record success AFTER execution
        if err := o.updateStepCompensation(ctx, saga.ID, i, "COMPLETED"); err != nil {
            // Log but don't fail - compensation is done, just state update failed
            log.Printf("Failed to record compensation success for saga %s step %d: %v",
                saga.ID, i, err)
        }
    }

    return o.updateSagaStatus(ctx, saga.ID, "COMPENSATED")
}

// Recovery handles partially compensated sagas
func (o *Orchestrator) recoverSaga(ctx context.Context, sagaID string) error {
    saga, err := o.loadSaga(ctx, sagaID)
    if err != nil {
        return err
    }

    if saga.Status == "COMPENSATING" {
        // Find first non-compensated step
        for i := len(saga.Steps) - 1; i >= 0; i-- {
            step := saga.Steps[i]
            if step.Status == "COMPLETED" && step.CompensationStatus != "COMPLETED" {
                // This step needs compensation
                return o.compensate(ctx, saga, i+1)
            }
        }
    }

    return nil
}
```

### Pitfall 4: The Saga Coordinator Single Point of Failure

**Incident Report**: The saga orchestrator ran as a single pod for "simplicity." When it crashed, 500 in-flight sagas were orphaned. Some had completed payment but not shipping, others had reserved inventory but not charged. Manual cleanup took 2 days.

```go
// WRONG: Single orchestrator, sagas in memory
type Orchestrator struct {
    activeSagas map[string]*Saga  // Lost on crash!
}

func (o *Orchestrator) StartSaga(saga *Saga) {
    o.activeSagas[saga.ID] = saga
    go o.executeSaga(saga)  // Lost if process dies
}

// CORRECT: Persistent saga state with distributed locking
type DistributedOrchestrator struct {
    db     *sql.DB
    locker DistributedLocker
}

func (o *DistributedOrchestrator) StartSaga(ctx context.Context, saga *Saga) error {
    // Persist saga state BEFORE execution
    if err := o.persistSaga(ctx, saga); err != nil {
        return err
    }

    // Try to acquire lock for this saga
    lock, err := o.locker.Acquire(ctx, "saga:"+saga.ID, 30*time.Second)
    if err != nil {
        return err  // Another instance is processing this saga
    }
    defer lock.Release()

    return o.executeSagaWithLock(ctx, saga, lock)
}

func (o *DistributedOrchestrator) executeSagaWithLock(ctx context.Context, saga *Saga, lock Lock) error {
    for i, step := range saga.Steps {
        // Extend lock before each step
        if err := lock.Extend(30 * time.Second); err != nil {
            // Lost lock - another instance might take over
            return ErrLockLost
        }

        // Persist step start
        if err := o.updateStepStatus(ctx, saga.ID, i, "EXECUTING"); err != nil {
            return err
        }

        // Execute step
        err := step.Execute(ctx)

        // Persist result
        if err != nil {
            o.updateStepStatus(ctx, saga.ID, i, "FAILED")
            return o.compensate(ctx, saga, i)
        }
        o.updateStepStatus(ctx, saga.ID, i, "COMPLETED")
    }

    return o.updateSagaStatus(ctx, saga.ID, "COMPLETED")
}

// Background worker recovers orphaned sagas
func (o *DistributedOrchestrator) RecoveryWorker(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            o.recoverOrphanedSagas(ctx)
        }
    }
}

func (o *DistributedOrchestrator) recoverOrphanedSagas(ctx context.Context) {
    // Find sagas that haven't made progress. The distributed lock below is
    // what provides mutual exclusion between orchestrator instances: a
    // FOR UPDATE SKIP LOCKED here would be decorative, because outside a
    // transaction Postgres releases the row locks when the SELECT returns.
    rows, _ := o.db.QueryContext(ctx, `
        SELECT id FROM sagas
        WHERE status IN ('EXECUTING', 'COMPENSATING')
        AND updated_at < NOW() - INTERVAL '1 minute'
        LIMIT 10
    `)
    defer rows.Close()

    for rows.Next() {
        var sagaID string
        rows.Scan(&sagaID)

        // Try to acquire lock and recover
        lock, err := o.locker.Acquire(ctx, "saga:"+sagaID, 30*time.Second)
        if err != nil {
            continue  // Another instance got it
        }

        saga, _ := o.loadSaga(ctx, sagaID)
        o.recoverSaga(ctx, saga, lock)
        lock.Release()
    }
}
```

### Pitfall 5: The Semantic Compensation Impossibility

**Incident Report**: A travel booking saga reserved a flight, then hotel, then car. Flight booking succeeded with a non-refundable fare. When car booking failed, compensation couldn't truly "undo" the flight - only mark it for manual refund request. The system showed "compensated" but the customer was still charged.

```go
// WRONG: Assuming all compensations are equivalent
func (s *FlightStep) Compensate(ctx context.Context) error {
    // This doesn't actually refund money for non-refundable fares!
    return s.flightAPI.CancelBooking(s.bookingID)
}

// CORRECT: Semantic compensation with business logic
type CompensationResult struct {
    Success           bool
    FullyReversed     bool
    PartialRefundCents int64
    RequiresManual    bool
    ManualActionDesc  string
}

func (s *FlightStep) Compensate(ctx context.Context) (*CompensationResult, error) {
    booking, err := s.flightAPI.GetBooking(ctx, s.bookingID)
    if err != nil {
        return nil, err
    }

    result := &CompensationResult{Success: true}

    switch booking.FareType {
    case "REFUNDABLE":
        refund, err := s.flightAPI.RefundBooking(ctx, s.bookingID)
        if err != nil {
            return nil, err
        }
        result.FullyReversed = true
        result.PartialRefundCents = refund.AmountCents

    case "NON_REFUNDABLE":
        // Can only cancel, no refund
        err := s.flightAPI.CancelBooking(ctx, s.bookingID)
        if err != nil {
            return nil, err
        }
        result.FullyReversed = false
        result.PartialRefundCents = 0
        result.RequiresManual = true
        result.ManualActionDesc = fmt.Sprintf(
            "Non-refundable flight %s canceled. Customer paid $%.2f. "+
            "Consider goodwill credit or voucher.",
            s.bookingID, float64(booking.AmountCents)/100.0)

    case "PARTIALLY_REFUNDABLE":
        refund, err := s.flightAPI.RefundBooking(ctx, s.bookingID)
        if err != nil {
            return nil, err
        }
        result.FullyReversed = false
        result.PartialRefundCents = refund.AmountCents
        if refund.AmountCents < booking.AmountCents {
            result.RequiresManual = true
            result.ManualActionDesc = fmt.Sprintf(
                "Partial refund processed: $%.2f of $%.2f. "+
                "Consider additional compensation.",
                float64(refund.AmountCents)/100.0, float64(booking.AmountCents)/100.0)
        }
    }

    return result, nil
}

// Saga tracks compensation quality
type SagaResult struct {
    Status             string
    FullyCompensated   bool
    PartialRefundTotalCents int64
    ManualActionsNeeded []string
}

func (o *Orchestrator) completeSagaCompensation(ctx context.Context, saga *Saga, results []*CompensationResult) (*SagaResult, error) {
    sagaResult := &SagaResult{Status: "COMPENSATED"}
    fullyReversed := true

    for _, r := range results {
        if !r.FullyReversed {
            fullyReversed = false
        }
        sagaResult.PartialRefundTotalCents += r.PartialRefundCents
        if r.RequiresManual {
            sagaResult.ManualActionsNeeded = append(sagaResult.ManualActionsNeeded, r.ManualActionDesc)
        }
    }

    sagaResult.FullyCompensated = fullyReversed

    // Alert if manual intervention needed
    if len(sagaResult.ManualActionsNeeded) > 0 {
        o.alerter.Alert(AlertSeverityWarning, fmt.Sprintf(
            "Saga %s compensated but requires manual actions: %v",
            saga.ID, sagaResult.ManualActionsNeeded))

        // Create ticket for support team
        o.ticketService.Create(ctx, Ticket{
            Type:     "SAGA_MANUAL_COMPENSATION",
            SagaID:   saga.ID,
            Actions:  sagaResult.ManualActionsNeeded,
            Priority: "HIGH",
        })
    }

    return sagaResult, nil
}
```

### Quick Reference: Saga Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Non-idempotent compensation | Double refunds, duplicate reversals | Idempotency keys, state checking before action |
| Stuck saga graveyard | Sagas in limbo, orders never complete | Deadlines, monitoring, dead letter queue |
| Partial compensation data loss | Compensations re-run or skipped | Persist state before and after each step |
| Orchestrator SPOF | Orphaned sagas on crash | Distributed locking, persistent state, recovery workers |
| Semantic compensation impossibility | "Compensated" but money not returned | Compensation result types, manual action tracking |

### Junior -> FAANG: Learning from Incident Reports

The incident reports at the start of each pitfall section are the most valuable part of this chapter for interview preparation. Real incidents at real companies are what FAANG interviewers draw their questions from. "Tell me about a time when a distributed system failed unexpectedly" is a behavioral question that expects you to have internalized stories like these even if you did not personally experience them.

Practice retelling each incident in the "situation, action, result" format used in behavioral interviews. For Pitfall 1: "A payment service was processing refunds as part of saga compensation. A network timeout caused the refund call to be retried after the first call actually succeeded. The customer received two refunds totaling double the original payment. The root cause was that the compensation function did not check whether a refund already existed before calling the payment gateway. The fix was to record a refund ID atomically in the same transaction as the state update, and to pass a stable idempotency key to the payment gateway derived from the saga ID and step name so the gateway could deduplicate duplicate calls."

For Pitfall 2, the key insight for interviews is that "stuck saga graveyard" is fundamentally a monitoring failure before it is a code failure. The sagas got stuck, but no alert fired. The monitoring must treat "saga older than SLO threshold" as an incident, not as background noise. When an interviewer asks "how would you know if your saga system was having problems," this is the example to reach for: not "I would check the error logs" but "I have a Prometheus alert that fires when any saga exceeds its type-specific convergence SLO, which would have caught the inventory service outage within 10 minutes rather than 3 days."

### Senior @ FAANG: Pitfall Patterns as Platform Governance Requirements

Each pitfall in this section maps to a specific governance requirement that a platform team enforces across all saga implementations in the organization.

**Pitfall 1 maps to an idempotency contract.** Every saga step's execute function and compensation function must accept an idempotency key as a required parameter, and every implementation must include a uniqueness constraint or conditional upsert in its database layer keyed on that parameter. The platform team enforces this by providing a `SagaStep` interface whose signature requires an idempotency key parameter. Implementations that do not use the key still compile, but the code review checklist includes an explicit check for idempotency key usage. Temporal enforces this partially through activity IDs, but application-level idempotency at the downstream API (payment gateway, inventory service) requires explicit implementation.

**Pitfall 2 maps to a mandatory SLO configuration field.** The platform's saga registration API requires a `ConvergenceSLO time.Duration` field that is validated as non-zero at registration time. The monitoring platform automatically creates a stuck-saga alert for every registered saga type using the SLO value as the threshold. Teams cannot opt out of this alert without a written exception approved by the platform team. This converts the pitfall from "monitoring failure" to "configuration failure that is caught at deployment time."

**Pitfall 3 maps to a compensation state persistence contract.** The platform's orchestrator library persists compensation state using a `before-execute` checkpoint pattern: the step's compensation status transitions to `COMPENSATING` before the compensation function is called, and to `COMPENSATED` after it returns success. Any gap between these two transitions is recoverable on restart because the orchestrator re-attempts compensations in `COMPENSATING` state. This is implemented once in the platform library and inherited by all saga implementations, rather than requiring each team to implement it correctly.

**Pitfall 4 maps to a high-availability deployment policy.** The platform team's runbook for deploying saga orchestrators requires a minimum of two orchestrator instances, a distributed lock implementation (typically using Postgres advisory locks or Redis with appropriate TTLs), and a recovery worker configured with `SELECT FOR UPDATE SKIP LOCKED` semantics. Any single-instance orchestrator deployment requires a written exception. The rationale is that the blast radius of an orchestrator crash scales with the number of in-flight sagas, which grows over time, making the risk of single-instance deployment worse in the future than it is today.

**Pitfall 5 maps to a compensation result taxonomy.** The platform defines a typed `CompensationResult` struct with fields for `FullyReversed bool`, `PartialRefundAmountCents int64`, `RequiresManualAction bool`, and `ManualActionDescription string`. Every compensation function returns this struct rather than a plain error. The platform's compensation execution layer aggregates results across all steps and automatically creates a support ticket (Jira, PagerDuty, or equivalent) when any step reports `RequiresManualAction: true`. This converts the pitfall from "system reports success when compensation was incomplete" to "system accurately reports partial compensation and escalates to a human."

---
