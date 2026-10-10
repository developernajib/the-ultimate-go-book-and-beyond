## Section 1: Core Workflow Concepts

### 1.1 Basic Workflow and Activity

Temporal workflows are deterministic Go functions that orchestrate activities - the units of work that perform side effects like calling external services, writing to databases, or invoking APIs. Activities have automatic retry built in. The following example defines a workflow and activity pair that illustrates the core contract: workflows express orchestration logic and handle compensation, while activities perform the actual work.

```go
package orderworkflow

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// OrderInput is the workflow input.
type OrderInput struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	Items      []Item  `json:"items"`
	TotalAmountCents int64 `json:"total_amount_cents"`
}

// Item represents one order line item.
type Item struct {
	SKU      string  `json:"sku"`
	Qty      int     `json:"qty"`
	PriceCents int64 `json:"price_cents"`
}

// OrderResult is the workflow output.
type OrderResult struct {
	OrderID   string `json:"order_id"`
	Status    string `json:"status"`
	ChargeID  string `json:"charge_id,omitempty"`
	ShipmentID string `json:"shipment_id,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Activities holds all the activity implementations.
type Activities struct {
	paymentSvc  PaymentService
	inventorySvc InventoryService
	shippingSvc  ShippingService
	notifySvc    NotificationService
}

func NewActivities(ps PaymentService, is InventoryService, ss ShippingService, ns NotificationService) *Activities {
	return &Activities{paymentSvc: ps, inventorySvc: is, shippingSvc: ss, notifySvc: ns}
}

// ReserveInventory reserves items in the inventory system.
func (a *Activities) ReserveInventory(ctx context.Context, orderID string, items []Item) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Reserving inventory", "order_id", orderID, "items", len(items))

	for _, item := range items {
		if err := a.inventorySvc.Reserve(ctx, orderID, item.SKU, item.Qty); err != nil {
			return fmt.Errorf("reserve %s: %w", item.SKU, err)
		}
	}
	return nil
}

// ChargeCustomer processes payment.
func (a *Activities) ChargeCustomer(ctx context.Context, customerID, orderID string, amountCents int64) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Charging customer", "customer_id", customerID, "amount_cents", amountCents)

	chargeID, err := a.paymentSvc.Charge(ctx, customerID, orderID, amountCents)
	if err != nil {
		return "", fmt.Errorf("charge customer: %w", err)
	}
	return chargeID, nil
}

// CreateShipment initiates shipment.
func (a *Activities) CreateShipment(ctx context.Context, orderID string, items []Item) (string, error) {
	shipmentID, err := a.shippingSvc.Create(ctx, orderID, items)
	if err != nil {
		return "", fmt.Errorf("create shipment: %w", err)
	}
	return shipmentID, nil
}

// SendOrderConfirmation sends email/push notification.
func (a *Activities) SendOrderConfirmation(ctx context.Context, customerID, orderID, chargeID string) error {
	return a.notifySvc.SendOrderConfirmation(ctx, customerID, orderID, chargeID)
}

// ReleaseInventory is the compensation activity for inventory reservation.
func (a *Activities) ReleaseInventory(ctx context.Context, orderID string) error {
	return a.inventorySvc.Release(ctx, orderID)
}

// RefundCustomer is the compensation activity for payment.
func (a *Activities) RefundCustomer(ctx context.Context, chargeID string) error {
	return a.paymentSvc.Refund(ctx, chargeID)
}

// OrderWorkflow orchestrates the full order fulfillment process.
// This workflow is DURABLE: if the worker crashes at any step, Temporal
// replays history to restore exactly where it left off.
func OrderWorkflow(ctx workflow.Context, input OrderInput) (*OrderResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting order workflow", "order_id", input.OrderID)

	// Configure activity options with retry policy
	activityOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    3,
			// Don't retry on business logic errors
			NonRetryableErrorTypes: []string{"InvalidOrderError", "CustomerNotFoundError"},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOpts)

	result := &OrderResult{OrderID: input.OrderID}

	// ─── Step 1: Reserve inventory ───────────────────────────────────
	var inventoryErr error
	if err := workflow.ExecuteActivity(ctx, "ReserveInventory", input.OrderID, input.Items).Get(ctx, &inventoryErr); err != nil {
		result.Status = "failed"
		result.Message = "inventory reservation failed: " + err.Error()
		return result, err
	}

	// ─── Step 2: Charge customer (with compensation on failure) ──────
	var chargeID string
	if err := workflow.ExecuteActivity(ctx, "ChargeCustomer", input.CustomerID, input.OrderID, input.TotalAmountCents).Get(ctx, &chargeID); err != nil {
		// Compensate: release inventory
		_ = workflow.ExecuteActivity(ctx, "ReleaseInventory", input.OrderID).Get(ctx, nil)
		result.Status = "failed"
		result.Message = "payment failed: " + err.Error()
		return result, err
	}
	result.ChargeID = chargeID

	// ─── Step 3: Create shipment ─────────────────────────────────────
	var shipmentID string
	if err := workflow.ExecuteActivity(ctx, "CreateShipment", input.OrderID, input.Items).Get(ctx, &shipmentID); err != nil {
		// Compensate: refund payment and release inventory
		_ = workflow.ExecuteActivity(ctx, "RefundCustomer", chargeID).Get(ctx, nil)
		_ = workflow.ExecuteActivity(ctx, "ReleaseInventory", input.OrderID).Get(ctx, nil)
		result.Status = "failed"
		result.Message = "shipping failed: " + err.Error()
		return result, err
	}
	result.ShipmentID = shipmentID

	// ─── Step 4: Send confirmation (best effort) ─────────────────────
	// Don't fail the order if notification fails
	notifyOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 2},
	}
	notifyCtx := workflow.WithActivityOptions(ctx, notifyOpts)
	_ = workflow.ExecuteActivity(notifyCtx, "SendOrderConfirmation", input.CustomerID, input.OrderID, chargeID).Get(ctx, nil)

	result.Status = "completed"
	logger.Info("Order completed", "order_id", input.OrderID, "charge_id", chargeID, "shipment_id", shipmentID)
	return result, nil
}
```

### 1.2 Worker Registration and Startup

A Temporal worker registers the workflow and activity functions it can execute, then long-polls the Temporal server for tasks on a named task queue. The worker process is stateless - it picks up tasks, executes them, and reports results back to the server. The following code configures a worker with a task queue name, registers workflow and activity types, and starts the polling loop.

```go
package worker

import (
	"context"
	"log"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const TaskQueue = "order-processing"

// StartWorker creates and starts a Temporal worker.
func StartWorker(ctx context.Context, temporalAddr string, activities *Activities) error {
	// Create Temporal client
	c, err := client.Dial(client.Options{
		HostPort:  temporalAddr,
		Namespace: "default",
	})
	if err != nil {
		return fmt.Errorf("dial temporal: %w", err)
	}
	defer c.Close()

	// Create worker that polls the task queue
	w := worker.New(c, TaskQueue, worker.Options{
		MaxConcurrentActivityExecutionSize: 100,
		MaxConcurrentWorkflowTaskExecutionSize: 10,
		// Enable sticky execution for better performance
		StickyScheduleToStartTimeout: 5 * time.Second,
	})

	// Register workflows
	w.RegisterWorkflow(OrderWorkflow)
	w.RegisterWorkflow(LongRunningOrderWorkflow) // covered in Section 2

	// Register activities - Temporal uses reflection to find methods
	w.RegisterActivity(activities)

	// Start worker (blocks until context is canceled)
	log.Printf("Starting Temporal worker on queue: %s", TaskQueue)
	return w.Run(worker.InterruptCh())
}

// StartOrderWorkflow submits a new order workflow execution.
func StartOrderWorkflow(c client.Client, input OrderInput) (client.WorkflowRun, error) {
	opts := client.StartWorkflowOptions{
		ID:        "order-" + input.OrderID, // deterministic ID prevents duplicate executions
		TaskQueue: TaskQueue,
		// Set a timeout for the entire workflow
		WorkflowExecutionTimeout: 24 * time.Hour,
		// Retry policy for workflow-level failures
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 1, // don't retry the whole workflow automatically
		},
	}

	run, err := c.ExecuteWorkflow(context.Background(), opts, OrderWorkflow, input)
	if err != nil {
		return nil, fmt.Errorf("start workflow: %w", err)
	}

	log.Printf("Started workflow: %s (run ID: %s)", run.GetID(), run.GetRunID())
	return run, nil
}
```

### Junior -> FAANG: Core Concepts You Must Own Before Your Screen

The workflow-plus-activities pattern is the fundamental Temporal building block. You need to be able to explain it without notes: the workflow function is the orchestrator that never touches external services directly. Every I/O operation is delegated to an activity function. The Temporal server records the result of each activity call in the event history. If the worker crashes after an activity returns but before the workflow moves to the next step, replay re-runs the workflow code but returns the already-recorded result instead of calling the activity again.

The `NonRetryableErrorTypes` field in the retry policy is one of the most important production details beginners skip. Without it, every activity error retries up to `MaximumAttempts` times. For a "card declined" error, retrying three times means charging the customer three times if the charge was actually recorded. Always enumerate the business-logic error types that must not be retried and put them in `NonRetryableErrorTypes`.

Worked example for the interview: walk through what happens when `CreateShipment` fails after `ChargeCustomer` succeeds. In the code above, the workflow calls `RefundCustomer` and `ReleaseInventory` as compensation. If the worker crashes mid-compensation, Temporal replays history, reaches the compensation block, and runs the remaining compensations again. The activities must be idempotent: calling `RefundCustomer` twice for the same `chargeID` must be safe.

First-job habit: always set a deterministic workflow ID (like `"order-" + orderID`). This prevents starting two workflows for the same order if the client retries the start call. Temporal deduplicates workflow starts by ID within the running scope.

### Senior @ FAANG: Activity Contract Design as an API Decision

Activity functions are the public API boundary between durable orchestration state and external services. Senior engineers treat them with the same discipline as gRPC service definitions.

**Idempotency as a first-class requirement.** Temporal guarantees at-least-once activity execution. The workflow records an activity as complete when the server receives the completion event. If the worker sends the completion but the server does not acknowledge it before the worker crashes, the activity runs again on the next worker. Every activity that writes to an external system must be idempotent. The standard pattern is to pass the workflow ID and activity attempt number as an idempotency key to the external API. For payment APIs that do not support idempotency keys natively, wrap the call in a deduplication layer backed by Postgres `INSERT ... ON CONFLICT DO NOTHING`.

**Activity granularity tradeoffs.** Coarse-grained activities (one activity for the entire order) are easier to write but lose retry granularity: a transient failure at step 3 of 10 retries from step 1. Fine-grained activities (one per external call) give precise retry semantics but increase event history growth and inter-activity coordination complexity. The right granularity is: one activity per external system call, plus one activity per idempotent database write. Reads can be inlined if they are cheap and idempotent, but writes should always be activities.

**Timeout budget decomposition.** `StartToCloseTimeout` must be set based on the actual p99 latency of the downstream service, not a round number. Set it to p99 plus a reasonable buffer (typically 2x p99). `ScheduleToCloseTimeout` caps the total retry budget. If `MaximumAttempts` is 3 and `InitialInterval` is 1s with coefficient 2, the retry delays are 1s, 2s, 4s. The `ScheduleToCloseTimeout` must be greater than the sum of those delays plus 3x `StartToCloseTimeout`. Getting these numbers wrong causes activities to be canceled mid-retry by the schedule-to-close budget.

**Input and output serialization as a contract surface.** Temporal serializes activity inputs and outputs using JSON by default. Adding a new required field to an activity input breaks in-flight executions that were scheduled before the deploy if the worker receiving the task cannot deserialize the old payload. Treat activity input/output structs like protobuf messages: only add optional fields with defaults, never remove fields, never rename fields. A governance rule at L6 level: any change to an activity input struct must go through a backward-compatibility review before merge.

**Rate-limiting activities against external systems.** Temporal workers will execute activities at the rate allowed by `MaxConcurrentActivityExecutionSize`. If the downstream system has its own rate limit, you must enforce coordination. The options are: a worker-local rate limiter (limits per-worker but not globally), a distributed rate limiter backed by Redis (limits globally), or Temporal's `worker.RateLimiter` option (limits per worker process). For external APIs with strict global quotas, use a distributed rate limiter and make it part of the activity options configuration injected at worker startup.

---
