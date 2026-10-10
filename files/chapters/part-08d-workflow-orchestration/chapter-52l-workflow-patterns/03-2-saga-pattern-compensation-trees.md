## 2. Saga Pattern - Compensation Trees

When a business process spans multiple services, any step can fail after previous steps have already committed their results. The saga pattern addresses this by pairing each forward action with a compensating action that semantically undoes it. A `CompensationTree` tracks which steps succeeded and, on failure, executes their compensations in reverse (LIFO) order. This reverse ordering matters: if you booked a flight, then a hotel, then charged payment, the refund must happen before canceling the hotel and flight to avoid leaving the customer charged for canceled services.

The implementation below models a travel booking saga. Each step (flight, hotel, car, payment) registers a compensation closure immediately after succeeding. If a later step fails, `Compensate` walks the tree backward. The car booking is marked non-fatal to demonstrate optional steps that do not trigger full rollback. The nested saga variant shows how inner and outer compensation scopes compose when workflows have hierarchical structure.

Compensating activities must be idempotent. Temporal may retry a compensation if the worker crashes mid-execution, so a `CancelFlight` call that runs twice must not produce errors or double-refunds.

```go
package saga

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// BookingRequest represents a travel booking request
type BookingRequest struct {
	UserID      string
	FlightID    string
	HotelID     string
	CarID       string
	TotalAmountCents int64
}

// BookingResult represents the result of a booking
type BookingResult struct {
	BookingID     string
	FlightBooking string
	HotelBooking  string
	CarBooking    string
	PaymentID     string
	Status        string
}

// TravelActivities contains all travel booking activities
type TravelActivities struct{}

// BookFlight books a flight
func (a *TravelActivities) BookFlight(ctx context.Context, req BookingRequest) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Booking flight", "flightID", req.FlightID)

	// Call flight booking API
	return fmt.Sprintf("FLIGHT-BOOKING-%s", req.FlightID), nil
}

// CancelFlight cancels a flight booking (compensation)
func (a *TravelActivities) CancelFlight(ctx context.Context, bookingID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Canceling flight booking", "bookingID", bookingID)

	// Call cancellation API
	return nil
}

// BookHotel books a hotel
func (a *TravelActivities) BookHotel(ctx context.Context, req BookingRequest) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Booking hotel", "hotelID", req.HotelID)

	return fmt.Sprintf("HOTEL-BOOKING-%s", req.HotelID), nil
}

// CancelHotel cancels a hotel booking (compensation)
func (a *TravelActivities) CancelHotel(ctx context.Context, bookingID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Canceling hotel booking", "bookingID", bookingID)

	return nil
}

// BookCar books a rental car
func (a *TravelActivities) BookCar(ctx context.Context, req BookingRequest) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Booking car", "carID", req.CarID)

	return fmt.Sprintf("CAR-BOOKING-%s", req.CarID), nil
}

// CancelCar cancels a car booking (compensation)
func (a *TravelActivities) CancelCar(ctx context.Context, bookingID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Canceling car booking", "bookingID", bookingID)

	return nil
}

// ChargePayment charges the customer
func (a *TravelActivities) ChargePayment(ctx context.Context, amountCents int64, userID string) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Charging payment", "amountCents", amountCents, "userID", userID)

	return fmt.Sprintf("PAYMENT-%s-%d", userID, amountCents), nil
}

// RefundPayment refunds a payment (compensation)
func (a *TravelActivities) RefundPayment(ctx context.Context, paymentID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Refunding payment", "paymentID", paymentID)

	return nil
}

// SendConfirmation sends a booking confirmation
func (a *TravelActivities) SendConfirmation(ctx context.Context, result BookingResult) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending confirmation", "bookingID", result.BookingID)

	return nil
}

// CompensationTree tracks what needs to be compensated
type CompensationTree struct {
	steps []compensationStep
}

type compensationStep struct {
	name     string
	rollback func(ctx workflow.Context) error
}

// AddCompensation adds a compensation function to the tree
func (ct *CompensationTree) AddCompensation(name string, rollback func(ctx workflow.Context) error) {
	ct.steps = append(ct.steps, compensationStep{
		name:     name,
		rollback: rollback,
	})
}

// Compensate executes all compensations in reverse order
func (ct *CompensationTree) Compensate(ctx workflow.Context) error {
	logger := workflow.GetLogger(ctx)
	var errs []error

	// Execute compensations in reverse order (LIFO)
	for i := len(ct.steps) - 1; i >= 0; i-- {
		step := ct.steps[i]
		logger.Info("Executing compensation", "step", step.name)

		if err := step.rollback(ctx); err != nil {
			logger.Error("Compensation failed",
				"step", step.name, "error", err)
			errs = append(errs, fmt.Errorf("compensation %s: %w", step.name, err))
			// Continue with other compensations even if one fails
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("compensation errors: %v", errs)
	}
	return nil
}

// TravelBookingSagaWorkflow orchestrates travel booking with saga pattern
func TravelBookingSagaWorkflow(ctx workflow.Context, req BookingRequest) (BookingResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting travel booking saga", "userID", req.UserID)

	// Activity options
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:        3,
			InitialInterval:        500 * time.Millisecond,
			MaximumInterval:        10 * time.Second,
			BackoffCoefficient:     2.0,
			NonRetryableErrorTypes: []string{"PaymentDeclinedError", "InventoryUnavailableError"},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Initialize compensation tree
	compensations := &CompensationTree{}
	var result BookingResult
	result.BookingID = workflow.GetInfo(ctx).WorkflowExecution.ID

	// Step 1: Book flight
	var flightBookingID string
	err := workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).BookFlight, req).Get(ctx, &flightBookingID)
	if err != nil {
		logger.Error("Flight booking failed", "error", err)
		return result, temporal.NewApplicationError("FlightBookingFailed", "flight", err)
	}
	result.FlightBooking = flightBookingID

	// Register flight cancellation as compensation
	compensations.AddCompensation("cancel-flight", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).CancelFlight, flightBookingID).Get(ctx, nil)
	})

	// Step 2: Book hotel
	var hotelBookingID string
	err = workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).BookHotel, req).Get(ctx, &hotelBookingID)
	if err != nil {
		logger.Error("Hotel booking failed", "error", err)
		// Compensate: cancel flight
		if compErr := compensations.Compensate(ctx); compErr != nil {
			logger.Error("Compensation failed", "error", compErr)
		}
		return result, temporal.NewApplicationError("HotelBookingFailed", "hotel", err)
	}
	result.HotelBooking = hotelBookingID

	// Register hotel cancellation as compensation
	compensations.AddCompensation("cancel-hotel", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).CancelHotel, hotelBookingID).Get(ctx, nil)
	})

	// Step 3: Book car (optional - non-fatal failure)
	var carBookingID string
	err = workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).BookCar, req).Get(ctx, &carBookingID)
	if err != nil {
		logger.Warn("Car booking failed (non-fatal), continuing", "error", err)
		// Car booking failure is non-fatal, continue without it
	} else {
		result.CarBooking = carBookingID
		compensations.AddCompensation("cancel-car", func(ctx workflow.Context) error {
			return workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).CancelCar, carBookingID).Get(ctx, nil)
		})
	}

	// Step 4: Process payment (critical step)
	var paymentID string
	err = workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).ChargePayment,
		req.TotalAmountCents, req.UserID).Get(ctx, &paymentID)
	if err != nil {
		logger.Error("Payment failed", "error", err)
		// Compensate: cancel car, hotel, flight
		if compErr := compensations.Compensate(ctx); compErr != nil {
			logger.Error("Compensation failed after payment failure", "error", compErr)
		}
		return result, temporal.NewApplicationError("PaymentFailed", "payment", err)
	}
	result.PaymentID = paymentID

	// Register payment refund as compensation
	compensations.AddCompensation("refund-payment", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).RefundPayment, paymentID).Get(ctx, nil)
	})

	// Step 5: Send confirmation (best-effort)
	result.Status = "CONFIRMED"
	workflow.ExecuteActivity(ctx, (*TravelActivities)(nil).SendConfirmation, result).Get(ctx, nil)

	logger.Info("Travel booking completed successfully",
		"bookingID", result.BookingID,
		"paymentID", result.PaymentID)

	return result, nil
}

// NestedSagaWorkflow demonstrates nested compensation trees
func NestedSagaWorkflow(ctx workflow.Context, orderID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting nested saga", "orderID", orderID)

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	outerCompensations := &CompensationTree{}

	// Outer step 1: Reserve resources
	err := workflow.ExecuteActivity(ctx, ReserveResourcesActivity, orderID).Get(ctx, nil)
	if err != nil {
		return err
	}
	outerCompensations.AddCompensation("release-resources", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, ReleaseResourcesActivity, orderID).Get(ctx, nil)
	})

	// Inner saga: sub-workflow with its own compensations
	innerCompensations := &CompensationTree{}

	err = workflow.ExecuteActivity(ctx, AllocateWorkerActivity, orderID).Get(ctx, nil)
	if err != nil {
		outerCompensations.Compensate(ctx)
		return err
	}
	innerCompensations.AddCompensation("deallocate-worker", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, DeallocateWorkerActivity, orderID).Get(ctx, nil)
	})

	err = workflow.ExecuteActivity(ctx, StartJobActivity, orderID).Get(ctx, nil)
	if err != nil {
		innerCompensations.Compensate(ctx)
		outerCompensations.Compensate(ctx)
		return err
	}

	// Job completed successfully - no compensation needed
	logger.Info("Nested saga completed successfully", "orderID", orderID)
	return nil
}

// Placeholder activities for nested saga
func ReserveResourcesActivity(ctx context.Context, orderID string) error  { return nil }
func ReleaseResourcesActivity(ctx context.Context, orderID string) error  { return nil }
func AllocateWorkerActivity(ctx context.Context, orderID string) error    { return nil }
func DeallocateWorkerActivity(ctx context.Context, orderID string) error  { return nil }
func StartJobActivity(ctx context.Context, orderID string) error          { return nil }
```

### Junior → FAANG: Building the Mental Model for Saga

The saga pattern is one of the most commonly tested distributed systems concepts at FAANG. Understanding it conceptually is not enough: you need to be able to describe implementation details, failure modes, and idempotency requirements.

**LIFO compensation ordering is not arbitrary.** Compensations run in reverse because later steps often depend on earlier ones. In the travel booking example, the car reservation depends on the hotel being reserved (same dates, same city). Canceling the hotel before the car creates an inconsistent intermediate state. Reversing in LIFO order preserves the dependency ordering through the teardown. Always ask "does step N depend on anything that step N-1 established?" to verify that reverse order is correct for a specific domain.

**Register compensation immediately after the forward step succeeds.** A common implementation mistake is to register all compensations at the start of the workflow and skip those whose forward steps have not yet run. This creates a bug: if the workflow crashes before reaching step 3, the compensation for step 3 fires even though step 3 never ran. The `CompensationTree.AddCompensation` call immediately after a successful forward step is the correct pattern. No forward success, no compensation registered.

**Idempotency in compensating activities.** Temporal retries activity failures, including during compensation. A compensation that is not idempotent can double-refund a payment or double-cancel a flight, which is worse than the original failure. The standard approaches: use the same booking ID as an idempotency key, check whether the cancellation already exists before calling the cancellation API, or use the external API's own idempotency header.

**Interview: how to draw a saga on a whiteboard.** Draw forward steps left to right with arrows. Below each arrow, draw a compensation arrow pointing right-to-left. When asked "what happens if step 3 fails?" trace the compensation arrows backward from step 2 to step 1. This visual makes the LIFO ordering obvious and demonstrates that you have a concrete model rather than a vague concept.

### Senior @ FAANG: Saga Governance, Compensation Failure, and the Consistency Window

Senior-level saga design goes beyond the happy path and the obvious failure path. The hard problems are compensation failure, consistency windows, and cross-team ownership.

**Compensation failure is not a handled case in most implementations.** The `CompensationTree.Compensate` method continues executing remaining compensations even when one fails. This is necessary (you cannot let one failed compensation block all others), but it leaves the system in a partial compensation state. The correct response to an unresolvable compensation failure is to route the workflow to a human-review signal wait, not to silently swallow the error. Production sagas should define a "compensation failure runbook" that specifies which team is paged, what data is needed, and what manual remediation steps exist.

**The consistency window is observable to external parties.** Between step 2 committing and step 2's compensation completing, external systems can observe intermediate state. A customer can see their credit card charged but no reservation in their account. This window is inherent to sagas. It cannot be eliminated. The question is how long it is and what the system's behavior is during it. Design answers include: displaying a "processing" state to the user during the saga, publishing a domain event only after all steps complete (not after each step), and providing a support workflow that can query the saga's current compensation state for customer service.

**Cross-team compensation ownership is a governance contract.** In the travel booking saga, the orchestrating workflow calls `CancelFlight`. But the flight cancellation logic is owned by the flights team. If that team changes their cancellation API, the saga breaks. The governance contract specifies: every team that exposes a bookable resource must also own and maintain the corresponding compensation activity, versioned alongside the forward action, with the same SLA guarantees. This contract belongs in the service ownership document, not assumed informally.

**Nested saga scoping.** The `NestedSagaWorkflow` shows inner and outer compensation trees. The design principle is that inner compensations scope to inner failures and outer compensations scope to outer failures. When an inner step fails, inner compensations run first before the outer tree is touched. This keeps compensation logic cohesive within its bounded context. A nested saga where inner compensations reach outside their scope (calling outer services directly) is a design smell indicating that the scope boundaries are wrong.

**Bar-raiser signal: defining the saga's failure taxonomy.** At L6/L7, the bar-raiser expects candidates to distinguish between failure categories in a saga:

- Transient failure (network blip): retries handle this, saga continues.
- Business failure (card declined, out of stock): non-retryable, compensation fires.
- Infrastructure failure (worker crash mid-compensation): Temporal retries the compensation activity. This requires compensations to be idempotent, which is the deeper reason idempotency is non-negotiable.
- Compensation failure: workflow transitions to human-review state, on-call is paged.

A candidate who addresses all four categories without prompting is demonstrating L6-level production readiness. A candidate who addresses only the first two is at L4/L5.

**Saga versus two-phase commit: the interview answer at depth.** 2PC blocks all participants and requires a coordinator that is a single point of failure. Sagas commit each step immediately and use compensating transactions for rollback. Sagas tolerate coordinator failure (Temporal is replayed) and partial participant failure (compensation runs for completed steps only). The cost is a consistency window and the requirement that every step is compensatable. This trade-off is the correct answer to "why not just use a distributed transaction?" in a system design interview.

---
