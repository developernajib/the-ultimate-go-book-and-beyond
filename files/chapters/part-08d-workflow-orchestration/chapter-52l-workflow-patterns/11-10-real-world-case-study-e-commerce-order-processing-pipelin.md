## 10. Real-World Case Study: E-Commerce Order Processing Pipeline

This case study combines the patterns from this chapter into a single order processing pipeline. The workflow progresses through six phases: parallel validation (fan-out/fan-in for fraud, inventory, and address checks), payment processing (with signal-based PayPal callback), parallel warehouse fulfillment (saga with per-warehouse compensations), shipment creation, best-effort notifications, and async post-processing via a fire-and-forget child workflow.

The saga compensation tree accumulates rollback actions as each phase succeeds. If warehouse reservation fails after payment has been charged, the tree unwinds by refunding the payment. Non-retryable errors (fraud, invalid payment, out-of-stock) skip retries entirely through Temporal's `NonRetryableErrorTypes` configuration. The post-processing child workflow updates analytics, feeds the recommendation engine, and schedules a review request email 7 days after expected delivery using `workflow.Sleep`.

```go
package ecommerce

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// Order represents an e-commerce order
type Order struct {
	OrderID     string
	CustomerID  string
	Items       []OrderItem
	TotalAmountCents int64
	ShipTo      Address
	PaymentInfo PaymentInfo
}

// OrderItem represents an item in the order
type OrderItem struct {
	SKU        string
	Name       string
	Quantity   int
	PriceCents int64
}

// Address represents a shipping address
type Address struct {
	Street  string
	City    string
	State   string
	Country string
	ZipCode string
}

// PaymentInfo represents payment details
type PaymentInfo struct {
	Method      string // credit_card, paypal, crypto
	Token       string // tokenized payment method
	AmountCents int64
}

// CompensationTree tracks what needs to be compensated
type CompensationTree struct {
	steps []compensationStep
}

type compensationStep struct {
	name     string
	rollback func(ctx workflow.Context) error
}

func (ct *CompensationTree) AddCompensation(name string, rollback func(ctx workflow.Context) error) {
	ct.steps = append(ct.steps, compensationStep{
		name:     name,
		rollback: rollback,
	})
}

func (ct *CompensationTree) Compensate(ctx workflow.Context) error {
	logger := workflow.GetLogger(ctx)
	var errs []error

	for i := len(ct.steps) - 1; i >= 0; i-- {
		step := ct.steps[i]
		logger.Info("Executing compensation", "step", step.name)

		if err := step.rollback(ctx); err != nil {
			logger.Error("Compensation failed", "step", step.name, "error", err)
			errs = append(errs, fmt.Errorf("compensation %s: %w", step.name, err))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("compensation errors: %v", errs)
	}
	return nil
}

// OrderProcessingPipelineWorkflow implements a complete order processing pipeline
func OrderProcessingPipelineWorkflow(ctx workflow.Context, order Order) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting order processing pipeline",
		"orderID", order.OrderID,
		"customerID", order.CustomerID,
		"amount_cents", order.TotalAmountCents)

	// Initialize saga compensations
	compensations := &CompensationTree{}

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    3,
			InitialInterval:    500 * time.Millisecond,
			MaximumInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			NonRetryableErrorTypes: []string{
				"FraudDetectedError",
				"InvalidPaymentError",
				"OutOfStockError",
			},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// === PHASE 1: VALIDATION (Parallel) ===
	logger.Info("Phase 1: Validation")

	fraudFuture := workflow.ExecuteActivity(ctx, CheckFraudActivity, order)
	inventoryFuture := workflow.ExecuteActivity(ctx, CheckInventoryActivity, order.Items)
	addressFuture := workflow.ExecuteActivity(ctx, ValidateAddressActivity, order.ShipTo)

	// Collect validation results
	var fraudRisk float64
	if err := fraudFuture.Get(ctx, &fraudRisk); err != nil {
		return fmt.Errorf("fraud check failed: %w", err)
	}
	if fraudRisk > 0.9 {
		workflow.ExecuteActivity(ctx, FlagFraudActivity, order.OrderID, fraudRisk).Get(ctx, nil)
		return temporal.NewApplicationError("FraudDetectedError", "fraud",
			fmt.Sprintf("fraud risk %.2f exceeds threshold", fraudRisk))
	}

	var inventoryAvailable bool
	if err := inventoryFuture.Get(ctx, &inventoryAvailable); err != nil {
		return fmt.Errorf("inventory check failed: %w", err)
	}
	if !inventoryAvailable {
		return temporal.NewApplicationError("OutOfStockError", "inventory",
			"one or more items are out of stock")
	}

	var validatedAddress Address
	if err := addressFuture.Get(ctx, &validatedAddress); err != nil {
		logger.Warn("Address validation failed, using original", "error", err)
		validatedAddress = order.ShipTo
	}
	order.ShipTo = validatedAddress

	// === PHASE 2: PAYMENT ===
	logger.Info("Phase 2: Payment processing")

	// Route to appropriate payment workflow based on method
	var paymentID string
	switch order.PaymentInfo.Method {
	case "credit_card":
		err := workflow.ExecuteActivity(ctx, ProcessCreditCardActivity, order).Get(ctx, &paymentID)
		if err != nil {
			return fmt.Errorf("credit card payment failed: %w", err)
		}
	case "paypal":
		// PayPal requires redirect - use signal to wait for completion
		var paypalApproved bool
		err := workflow.ExecuteActivity(ctx, InitiatePayPalPaymentActivity, order).Get(ctx, nil)
		if err != nil {
			return fmt.Errorf("PayPal initiation failed: %w", err)
		}

		// Wait for PayPal callback (up to 10 minutes)
		paypalCh := workflow.GetSignalChannel(ctx, "paypal-callback")
		timer := workflow.NewTimer(ctx, 10*time.Minute)
		selector := workflow.NewSelector(ctx)

		selector.AddReceive(paypalCh, func(c workflow.ReceiveChannel, more bool) {
			c.Receive(ctx, &paypalApproved)
		})
		selector.AddFuture(timer, func(f workflow.Future) {
			paypalApproved = false
		})
		selector.Select(ctx)

		if !paypalApproved {
			return temporal.NewApplicationError("InvalidPaymentError", "paypal",
				"PayPal payment not completed within timeout")
		}
		paymentID = fmt.Sprintf("PP-%s", order.OrderID)

	default:
		err := workflow.ExecuteActivity(ctx, ProcessGenericPaymentActivity, order).Get(ctx, &paymentID)
		if err != nil {
			return fmt.Errorf("payment failed: %w", err)
		}
	}

	// Register payment refund compensation
	compensations.AddCompensation("refund-payment", func(ctx workflow.Context) error {
		return workflow.ExecuteActivity(ctx, RefundPaymentActivity, paymentID).Get(ctx, nil)
	})

	// === PHASE 3: FULFILLMENT (Parallel per warehouse) ===
	logger.Info("Phase 3: Fulfillment")

	// Group items by warehouse
	var warehouseGroups map[string][]OrderItem
	if err := workflow.ExecuteActivity(ctx,
		GroupItemsByWarehouseActivity, order.Items).Get(ctx, &warehouseGroups); err != nil {
		compensations.Compensate(ctx)
		return fmt.Errorf("warehouse grouping failed: %w", err)
	}

	// Parallel reservation per warehouse
	type warehouseFuture struct {
		warehouseID string
		future      workflow.Future
	}

	var wFutures []warehouseFuture
	for warehouseID, items := range warehouseGroups {
		capturedWarehouse := warehouseID
		capturedItems := items
		future := workflow.ExecuteActivity(ctx,
			ReserveInventoryActivity, capturedWarehouse, capturedItems, order.OrderID)
		wFutures = append(wFutures, warehouseFuture{
			warehouseID: capturedWarehouse,
			future:      future,
		})
	}

	// Collect warehouse reservations
	var reservationIDs []string
	for _, wf := range wFutures {
		var reservationID string
		if err := wf.future.Get(ctx, &reservationID); err != nil {
			// One warehouse failed - compensate all
			compensations.Compensate(ctx)
			return fmt.Errorf("warehouse %s reservation failed: %w", wf.warehouseID, err)
		}

		reservationIDs = append(reservationIDs, reservationID)
		capturedID := reservationID
		compensations.AddCompensation(
			fmt.Sprintf("release-reservation-%s", reservationID),
			func(ctx workflow.Context) error {
				return workflow.ExecuteActivity(ctx,
					ReleaseReservationActivity, capturedID).Get(ctx, nil)
			})
	}

	// === PHASE 4: SHIPPING ===
	logger.Info("Phase 4: Creating shipment")

	var trackingCode string
	err := workflow.ExecuteActivity(ctx,
		CreateShipmentActivity, order, reservationIDs).Get(ctx, &trackingCode)
	if err != nil {
		compensations.Compensate(ctx)
		return fmt.Errorf("shipment creation failed: %w", err)
	}

	// === PHASE 5: NOTIFICATION (Fire and forget) ===
	logger.Info("Phase 5: Notifications")

	// Send order confirmation and tracking info
	notifyFuture := workflow.ExecuteActivity(ctx,
		SendOrderConfirmationEmailActivity, order, trackingCode)
	loyaltyFuture := workflow.ExecuteActivity(ctx,
		UpdateLoyaltyPointsActivity, order.CustomerID, order.TotalAmountCents)

	// Best-effort notification (don't fail order if notification fails)
	notifyFuture.Get(ctx, nil)
	loyaltyFuture.Get(ctx, nil)

	// === PHASE 6: POST-PROCESSING (Async child workflow) ===
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID: fmt.Sprintf("post-process-%s", order.OrderID),
	})
	workflow.ExecuteChildWorkflow(childCtx, OrderPostProcessingWorkflow, order.OrderID)
	// Don't wait - fire and forget

	logger.Info("Order processing completed successfully",
		"orderID", order.OrderID,
		"trackingCode", trackingCode,
		"paymentID", paymentID)

	return nil
}

// OrderPostProcessingWorkflow handles async post-processing
func OrderPostProcessingWorkflow(ctx workflow.Context, orderID string) error {
	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// Update analytics
	workflow.ExecuteActivity(ctx, RecordOrderAnalyticsActivity, orderID).Get(ctx, nil)

	// Update recommendation engine
	workflow.ExecuteActivity(ctx, UpdateRecommendationsActivity, orderID).Get(ctx, nil)

	// Schedule follow-up communications (review request after delivery)
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID: fmt.Sprintf("review-request-%s", orderID),
	})
	// Schedule review request 7 days after expected delivery
	workflow.ExecuteChildWorkflow(childCtx, ScheduleReviewRequestWorkflow, orderID, 7*24*time.Hour)

	return nil
}

// ScheduleReviewRequestWorkflow waits then requests a review
func ScheduleReviewRequestWorkflow(ctx workflow.Context, orderID string, delay time.Duration) error {
	// Wait for delivery confirmation + delay
	workflow.Sleep(ctx, delay)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	return workflow.ExecuteActivity(ctx, SendReviewRequestActivity, orderID).Get(ctx, nil)
}

// Activity stubs for the e-commerce pipeline
func CheckFraudActivity(ctx context.Context, order Order) (float64, error) {
	activity.GetLogger(ctx).Info("Checking fraud", "orderID", order.OrderID)
	return 0.1, nil // Low fraud risk
}

func CheckInventoryActivity(ctx context.Context, items []OrderItem) (bool, error) {
	return true, nil
}

func ValidateAddressActivity(ctx context.Context, addr Address) (Address, error) {
	return addr, nil
}

func FlagFraudActivity(ctx context.Context, orderID string, risk float64) error {
	return nil
}

func ProcessCreditCardActivity(ctx context.Context, order Order) (string, error) {
	return fmt.Sprintf("CC-PAY-%s", order.OrderID), nil
}

func InitiatePayPalPaymentActivity(ctx context.Context, order Order) error {
	return nil
}

func ProcessGenericPaymentActivity(ctx context.Context, order Order) (string, error) {
	return fmt.Sprintf("GEN-PAY-%s", order.OrderID), nil
}

func RefundPaymentActivity(ctx context.Context, paymentID string) error {
	return nil
}

func GroupItemsByWarehouseActivity(ctx context.Context, items []OrderItem) (map[string][]OrderItem, error) {
	// Group items by warehouse (simplified: all in one warehouse)
	return map[string][]OrderItem{"warehouse-us-west": items}, nil
}

func ReserveInventoryActivity(ctx context.Context, warehouseID string, items []OrderItem, orderID string) (string, error) {
	return fmt.Sprintf("RES-%s-%s", warehouseID, orderID), nil
}

func ReleaseReservationActivity(ctx context.Context, reservationID string) error {
	return nil
}

func CreateShipmentActivity(ctx context.Context, order Order, reservationIDs []string) (string, error) {
	return fmt.Sprintf("TRACK-%s", order.OrderID), nil
}

func SendOrderConfirmationEmailActivity(ctx context.Context, order Order, trackingCode string) error {
	return nil
}

func UpdateLoyaltyPointsActivity(ctx context.Context, customerID string, amountCents int64) error {
	return nil
}

func RecordOrderAnalyticsActivity(ctx context.Context, orderID string) error {
	return nil
}

func UpdateRecommendationsActivity(ctx context.Context, orderID string) error {
	return nil
}

func SendReviewRequestActivity(ctx context.Context, orderID string) error {
	return nil
}
```

### Junior → FAANG: Reading a Composite Workflow and Identifying Patterns

A composite workflow like this one is harder to reason about than any individual pattern because multiple patterns interact. The skill to develop is pattern identification: being able to scan a workflow and name each section's pattern.

**Phase 1 is fan-out/fan-in with short-circuit on failure.** Three activities launch in parallel (fraud, inventory, address). The address check is best-effort (failure falls back to the original address). Fraud and inventory failures are hard stops. This is a partial-failure fan-out where different failure modes have different handling.

**Phase 2 is a signal-wait for asynchronous external callbacks.** The PayPal payment requires a user action (redirect to PayPal, approve, redirect back). The workflow parks at a signal wait while the user completes the external flow. This is the human-in-the-loop pattern applied to a machine actor (the PayPal return callback).

**Phase 3 is a saga with per-warehouse compensation.** Each warehouse reservation registers a compensation immediately after success. If any warehouse fails, all reservations and the payment are compensated in reverse. The compensation closures capture the specific reservation ID from the forward step, which is the correct closure-capture pattern.

**Phase 6 is fire-and-forget child workflow.** The parent starts `OrderPostProcessingWorkflow` and does not call `Get` on the future. This means the parent completes without waiting for post-processing. The child runs independently after the parent exits. Use this pattern for non-critical async work (analytics, recommendations) that should not delay the primary workflow's completion.

**Tracing the failure paths.** For each phase, ask: if this phase fails, what happens? Phase 1: return error immediately (no compensation registered yet). Phase 2: no payment taken, return error. Phase 3: compensations for payment and all successful reservations fire. Phase 4: compensations for payment and all reservations fire. Tracing each failure path is the review exercise that catches missing compensations before production.

### Senior @ FAANG: Production Readiness, Multi-Team Ownership, and Observability

The e-commerce case study is a reasonable reference implementation. Turning it into a production system at FAANG scale requires addressing concerns that the code does not show.

**Multi-team ownership of activities.** The `CheckFraudActivity`, `ProcessCreditCardActivity`, `ReserveInventoryActivity`, and `CreateShipmentActivity` are owned by different teams (risk, payments, inventory, logistics). The pipeline workflow orchestrates them but does not own their implementations. The production architecture requires: each team publishes their activity as a versioned package or a separate task queue endpoint, the pipeline team declares dependencies on specific versions, and each team maintains their activity's SLA and idempotency contract. Activity interface contracts must be versioned and backward-compatible, following the same principles as API versioning.

**Observability requirements for a six-phase pipeline.** A production order pipeline needs phase-level visibility, not just start/end visibility. The approach: each phase boundary records a structured log entry with phase name, duration, and outcome. A correlation ID (the order ID) propagates through all log entries and all activity calls. When an order gets stuck, the support team can query the log for that order ID and see exactly which phase it is in and what the last activity result was. This correlation requires the activities to extract and propagate the order ID from their context, not just log their own internal identifiers.

**Non-retryable error type governance.** `NonRetryableErrorTypes: []string{"FraudDetectedError", "InvalidPaymentError", "OutOfStockError"}` is a critical configuration. If an error type is missing from this list, Temporal retries a business failure (fraud detection, card decline) three times before giving up, charging the customer's bank for three authorization attempts. Adding a new non-retryable error type is a deployment change that must be reviewed by the payments and risk teams, not just the workflow team.

**Post-processing child workflow and orphan detection.** The fire-and-forget `OrderPostProcessingWorkflow` runs independently after the parent completes. If this child fails, no parent is watching it. The production requirement is an alert on failed `OrderPostProcessingWorkflow` executions. This alert is implemented as a Temporal workflow search attribute query (find all `OrderPostProcessingWorkflow` executions with status `FAILED`) on a scheduled job, or as a metric derived from the Temporal metrics pipeline. Orphaned failed child workflows are a silent data quality problem if unmonitored.

**The review request workflow and cancellation.** `ScheduleReviewRequestWorkflow` sleeps for 7 days then sends a review email. If the order is later canceled and refunded, the review request workflow continues sleeping and sends the email anyway. The correct design adds a signal handler to `ScheduleReviewRequestWorkflow` that listens for an order-cancellation event and terminates before the sleep completes. This is the same pattern as the onboarding drip campaign cancellation in the event-driven section.

**End-to-end latency budget.** A six-phase pipeline with parallel activities in phases 1 and 3 has a total latency budget that should be documented. Phase 1 (parallel): max(fraud_latency, inventory_latency, address_latency). Phase 2 (payment): credit_card_latency or paypal_callback_latency (up to 10 minutes). Phase 3 (parallel reservations): max(warehouse_latencies). Phase 4 (shipment): shipment_API_latency. The P99 latency budget for a credit-card order (no PayPal wait) is measurable and must be within the customer-facing SLA (typically "order confirmed within 30 seconds for card payments"). Workflows that exceed this SLA after deployment require profiling to identify which phase is the bottleneck.

---
