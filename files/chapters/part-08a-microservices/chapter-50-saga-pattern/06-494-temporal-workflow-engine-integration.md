## 50.4 Temporal Workflow Engine Integration

### Using Temporal for Sagas

Temporal replaces hand-built saga orchestration with a durable workflow engine: the Go workflow function executes as if it were normal sequential code, but Temporal persists every activity result and replays history on worker restart so no step is re-executed after a crash. Compensation is implemented with `defer`. If any activity returns an error the deferred functions run the rollback sequence, which Temporal also persists and retries automatically. This dramatically reduces the amount of saga infrastructure Go developers must maintain compared to the hand-rolled orchestrator shown in the previous section.

As of 2026, Temporal is the canonical durable-execution engine for Go services. The Go SDK is at 1.x-stable with deterministic workflow replay, cron workflows, child workflows, signals, queries, and update handlers. Alternatives exist (Netflix Conductor is declarative JSON DSL, Restate offers a journal-based model, AWS Step Functions is managed but vendor-locked), but Temporal has the deepest Go ergonomics because workflows are plain Go functions rather than DSL or state-machine configuration.

> **Senior track**: Workflow code must be deterministic. That means no `time.Now()`, no `math/rand`, no direct goroutines, no reading files, no network calls. Use `workflow.Now`, `workflow.SideEffect`, `workflow.Go`, and move all I/O into activities. Temporal enforces this at replay time: if the workflow makes a non-deterministic decision, history replay diverges and the worker throws a non-determinism error. This is the single most common Temporal bug for teams coming from hand-rolled orchestrators.

```go
// pkg/saga/temporal/workflow.go
package temporal

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

/*
Temporal provides:
- Durable execution (survives process crashes)
- Automatic retries with configurable policies
- Timeout handling
- Compensation/rollback via compensation workflow
- Visibility and debugging
- Versioning for workflow updates
*/

// OrderWorkflowInput is the input for order workflow
type OrderWorkflowInput struct {
	OrderID     string      `json:"order_id"`
	CustomerID  string      `json:"customer_id"`
	TotalAmountCents int64  `json:"total_amount_cents"`
	Items       []OrderItem `json:"items"`
}

type OrderItem struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// OrderWorkflowResult is the result of order workflow
type OrderWorkflowResult struct {
	OrderID    string `json:"order_id"`
	Status     string `json:"status"`
	PaymentID  string `json:"payment_id,omitempty"`
	Error      string `json:"error,omitempty"`
}

// OrderWorkflow implements the order saga using Temporal
func OrderWorkflow(ctx workflow.Context, input OrderWorkflowInput) (*OrderWorkflowResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting order workflow", "order_id", input.OrderID)

	// Activity options with retry policy
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    3,
			NonRetryableErrorTypes: []string{
				"InsufficientInventory",
				"PaymentDeclined",
			},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Track completed steps for compensation
	var orderCreated, inventoryReserved bool
	var reservationID, paymentID string
	var workflowCompleted bool

	// Defer compensation - runs if the workflow did not complete successfully
	defer func() {
		if !workflowCompleted {
			compensateOrder(ctx, input.OrderID, orderCreated, inventoryReserved, reservationID, paymentID)
		}
	}()

	// Step 1: Create Order
	logger.Info("Creating order", "order_id", input.OrderID)
	var createResult CreateOrderResult
	err := workflow.ExecuteActivity(ctx, CreateOrderActivity, input).Get(ctx, &createResult)
	if err != nil {
		logger.Error("Failed to create order", "error", err)
		return &OrderWorkflowResult{
			OrderID: input.OrderID,
			Status:  "failed",
			Error:   fmt.Sprintf("create order failed: %v", err),
		}, nil
	}
	orderCreated = true

	// Step 2: Reserve Inventory
	logger.Info("Reserving inventory", "order_id", input.OrderID)
	var reserveResult ReserveInventoryResult
	err = workflow.ExecuteActivity(ctx, ReserveInventoryActivity, ReserveInventoryInput{
		OrderID: input.OrderID,
		Items:   input.Items,
	}).Get(ctx, &reserveResult)
	if err != nil {
		logger.Error("Failed to reserve inventory", "error", err)
		return &OrderWorkflowResult{
			OrderID: input.OrderID,
			Status:  "failed",
			Error:   fmt.Sprintf("reserve inventory failed: %v", err),
		}, nil
	}
	inventoryReserved = true
	reservationID = reserveResult.ReservationID

	// Step 3: Process Payment
	logger.Info("Processing payment", "order_id", input.OrderID)
	var paymentResult ProcessPaymentResult
	err = workflow.ExecuteActivity(ctx, ProcessPaymentActivity, ProcessPaymentInput{
		OrderID:    input.OrderID,
		CustomerID: input.CustomerID,
		AmountCents: input.TotalAmountCents,
	}).Get(ctx, &paymentResult)
	if err != nil {
		logger.Error("Failed to process payment", "error", err)
		return &OrderWorkflowResult{
			OrderID: input.OrderID,
			Status:  "failed",
			Error:   fmt.Sprintf("process payment failed: %v", err),
		}, nil
	}
	paymentID = paymentResult.PaymentID

	// Step 4: Confirm Order
	logger.Info("Confirming order", "order_id", input.OrderID)
	var confirmResult ConfirmOrderResult
	err = workflow.ExecuteActivity(ctx, ConfirmOrderActivity, ConfirmOrderInput{
		OrderID:       input.OrderID,
		PaymentID:     paymentID,
		ReservationID: reservationID,
	}).Get(ctx, &confirmResult)
	if err != nil {
		logger.Error("Failed to confirm order", "error", err)
		return &OrderWorkflowResult{
			OrderID:   input.OrderID,
			Status:    "failed",
			PaymentID: paymentID,
			Error:     fmt.Sprintf("confirm order failed: %v", err),
		}, nil
	}

	workflowCompleted = true
	logger.Info("Order workflow completed successfully", "order_id", input.OrderID)

	return &OrderWorkflowResult{
		OrderID:   input.OrderID,
		Status:    "confirmed",
		PaymentID: paymentID,
	}, nil
}

func compensateOrder(ctx workflow.Context, orderID string, orderCreated, inventoryReserved bool, reservationID, paymentID string) {
	logger := workflow.GetLogger(ctx)

	// Use detached context for compensation
	compensationCtx, _ := workflow.NewDisconnectedContext(ctx)

	compensationOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second,
			MaximumAttempts: 5, // More retries for compensation
		},
	}
	compensationCtx = workflow.WithActivityOptions(compensationCtx, compensationOptions)

	// Compensate in reverse order
	if paymentID != "" {
		logger.Info("Compensating: refunding payment", "payment_id", paymentID)
		err := workflow.ExecuteActivity(compensationCtx, RefundPaymentActivity, RefundPaymentInput{
			PaymentID: paymentID,
		}).Get(compensationCtx, nil)
		if err != nil {
			logger.Error("Failed to refund payment", "error", err)
		}
	}

	if inventoryReserved {
		logger.Info("Compensating: releasing inventory", "reservation_id", reservationID)
		err := workflow.ExecuteActivity(compensationCtx, ReleaseInventoryActivity, ReleaseInventoryInput{
			ReservationID: reservationID,
		}).Get(compensationCtx, nil)
		if err != nil {
			logger.Error("Failed to release inventory", "error", err)
		}
	}

	if orderCreated {
		logger.Info("Compensating: cancelling order", "order_id", orderID)
		err := workflow.ExecuteActivity(compensationCtx, CancelOrderActivity, CancelOrderInput{
			OrderID: orderID,
		}).Get(compensationCtx, nil)
		if err != nil {
			logger.Error("Failed to cancel order", "error", err)
		}
	}
}
```

### Temporal Activities

Temporal activities are ordinary Go functions that contain the actual I/O (HTTP calls, database writes, payment API requests), decoupled from the workflow control flow. Each activity is registered with a retry policy specifying maximum attempts and backoff intervals, and Temporal retries failed activities transparently without involving the workflow goroutine, and the workflow only proceeds once the activity returns success. Activities must be idempotent because Temporal may retry them on heartbeat timeout, even if the previous attempt completed successfully on the remote service. The canonical pattern is to pass the Temporal activity id (or a derived idempotency key such as `{workflow_id}:{activity_type}:{attempt}`) into the downstream service so duplicate invocations return the same result instead of double-charging a card or double-reserving stock.

```go
// pkg/saga/temporal/activities.go
package temporal

import (
	"context"
	"fmt"

	"go.temporal.io/sdk/activity"
)

// Activity input/output types

type CreateOrderResult struct {
	OrderID string `json:"order_id"`
	Status  string `json:"status"`
}

type ReserveInventoryInput struct {
	OrderID string      `json:"order_id"`
	Items   []OrderItem `json:"items"`
}

type ReserveInventoryResult struct {
	ReservationID string `json:"reservation_id"`
}

type ProcessPaymentInput struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	AmountCents int64  `json:"amount_cents"`
}

type ProcessPaymentResult struct {
	PaymentID string `json:"payment_id"`
}

type ConfirmOrderInput struct {
	OrderID       string `json:"order_id"`
	PaymentID     string `json:"payment_id"`
	ReservationID string `json:"reservation_id"`
}

type ConfirmOrderResult struct {
	Status string `json:"status"`
}

type CancelOrderInput struct {
	OrderID string `json:"order_id"`
}

type ReleaseInventoryInput struct {
	ReservationID string `json:"reservation_id"`
}

type RefundPaymentInput struct {
	PaymentID string `json:"payment_id"`
}

// Activities implement the saga steps

// CreateOrderActivity creates an order
func CreateOrderActivity(ctx context.Context, input OrderWorkflowInput) (*CreateOrderResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Creating order", "order_id", input.OrderID)

	// In real implementation, call order service
	// For demo, simulate success
	return &CreateOrderResult{
		OrderID: input.OrderID,
		Status:  "created",
	}, nil
}

// ReserveInventoryActivity reserves inventory
func ReserveInventoryActivity(ctx context.Context, input ReserveInventoryInput) (*ReserveInventoryResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Reserving inventory", "order_id", input.OrderID)

	// In real implementation, call inventory service
	// Return non-retryable error for insufficient inventory
	// return nil, temporal.NewNonRetryableApplicationError("insufficient inventory", "InsufficientInventory", nil)

	return &ReserveInventoryResult{
		ReservationID: fmt.Sprintf("res-%s", input.OrderID),
	}, nil
}

// ProcessPaymentActivity processes payment
func ProcessPaymentActivity(ctx context.Context, input ProcessPaymentInput) (*ProcessPaymentResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Processing payment", "order_id", input.OrderID, "amount_cents", input.AmountCents)

	// In real implementation, call payment service
	return &ProcessPaymentResult{
		PaymentID: fmt.Sprintf("pay-%s", input.OrderID),
	}, nil
}

// ConfirmOrderActivity confirms the order
func ConfirmOrderActivity(ctx context.Context, input ConfirmOrderInput) (*ConfirmOrderResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Confirming order", "order_id", input.OrderID)

	return &ConfirmOrderResult{
		Status: "confirmed",
	}, nil
}

// Compensation Activities

// CancelOrderActivity cancels an order
func CancelOrderActivity(ctx context.Context, input CancelOrderInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Cancelling order", "order_id", input.OrderID)

	// In real implementation, call order service
	return nil
}

// ReleaseInventoryActivity releases reserved inventory
func ReleaseInventoryActivity(ctx context.Context, input ReleaseInventoryInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Releasing inventory", "reservation_id", input.ReservationID)

	// In real implementation, call inventory service
	return nil
}

// RefundPaymentActivity refunds a payment
func RefundPaymentActivity(ctx context.Context, input RefundPaymentInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Refunding payment", "payment_id", input.PaymentID)

	// In real implementation, call payment service
	return nil
}
```

### Temporal Worker

The Temporal worker is the Go process that polls the Temporal server for workflow and activity tasks on a named task queue, executes them, and reports results back. Workers are stateless and horizontally scalable. Multiple instances of this binary can run simultaneously and Temporal distributes tasks across them for throughput. Registering both workflow and activity implementations on the same worker is common for smaller deployments, and high-volume systems separate activity workers from workflow workers so CPU-intensive activities do not starve workflow replay goroutines.

```go
// cmd/saga-worker/main.go
package main

import (
	"log"
	"log/slog"
	"os"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"example.com/saga/pkg/saga/temporal"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Create Temporal client
	c, err := client.Dial(client.Options{
		HostPort: os.Getenv("TEMPORAL_HOST"),
	})
	if err != nil {
		log.Fatalf("Failed to create Temporal client: %v", err)
	}
	defer c.Close()

	// Create worker
	w := worker.New(c, "order-saga", worker.Options{})

	// Register workflow
	w.RegisterWorkflow(temporal.OrderWorkflow)

	// Register activities
	w.RegisterActivity(temporal.CreateOrderActivity)
	w.RegisterActivity(temporal.ReserveInventoryActivity)
	w.RegisterActivity(temporal.ProcessPaymentActivity)
	w.RegisterActivity(temporal.ConfirmOrderActivity)
	w.RegisterActivity(temporal.CancelOrderActivity)
	w.RegisterActivity(temporal.ReleaseInventoryActivity)
	w.RegisterActivity(temporal.RefundPaymentActivity)

	logger.Info("Starting Temporal worker")

	// Start worker
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("Failed to start worker: %v", err)
	}
}
```

### Junior -> FAANG: The Two Rules That Prevent Most Temporal Bugs

Temporal's ergonomics feel like regular Go code, which creates a false sense of familiarity. There are two rules that prevent the majority of bugs for engineers new to Temporal.

**Rule 1: No non-determinism in workflow code.** Workflow functions are replayed from history on worker restart. During replay, Temporal re-executes the workflow Go code and compares its decisions against the recorded history. If the workflow code makes a different decision than it did originally, Temporal throws a non-determinism error and the workflow is stuck. The common violations are:

- Calling `time.Now()` directly. Use `workflow.Now(ctx)` instead, which returns the recorded timestamp from history.
- Using `math/rand` directly. Use `workflow.SideEffect` to record the random value in history on first execution and replay it on subsequent executions.
- Spawning a goroutine with `go func()`. Use `workflow.Go(ctx, func(ctx workflow.Context) {...})` instead.
- Making HTTP or gRPC calls directly in workflow code. All I/O must be in activities, not in the workflow function.

**Rule 2: Activities must be idempotent.** Temporal guarantees at-least-once activity execution, not exactly-once. If a worker crashes after the activity function returns but before Temporal records the result, Temporal will re-execute the activity on another worker. Both executions may succeed at the remote service (for example, both may hit the payment API). The payment API must deduplicate using an idempotency key that you include in every request: `activity.GetInfo(ctx).ActivityID` gives you a stable identifier for the current activity execution that you can pass as the idempotency key.

A worked example of activity idempotency: `ProcessPaymentActivity` calls `stripe.Charge(amount, idempotencyKey: activityID)`. If Temporal re-executes this activity, Stripe returns the same charge object it created the first time, rather than creating a second charge. Your activity records the charge ID in the database using an upsert that is a no-op if the charge ID already exists.

### Senior @ FAANG: Operating Temporal at FAANG Scale

Running Temporal correctly at FAANG scale requires understanding its internal architecture well enough to capacity-plan each component and identify the failure mode that will occur under your specific workload.

**History service is the write bottleneck.** Every workflow event (activity scheduled, activity completed, timer fired, signal received) is a write to the history service, which persists to Cassandra (or a relational database in self-hosted deployments). For a four-step order saga, that is approximately 8 to 12 events (scheduled + completed for each activity, plus workflow started and completed). At 10,000 orders per second, that is 80,000 to 120,000 Cassandra writes per second from the history service alone. Capacity-plan Cassandra before deploying Temporal for high-volume workflows. Temporal Cloud abstracts this, but at the cost of per-event pricing that makes high-volume sagas expensive.

**Task queue design for throughput isolation.** All sagas in the worker code above share a single task queue named `order-saga`. At scale, a spike in one saga type can starve others. Use separate task queues for different saga types and for activities versus workflows. Temporal's internal scheduler dispatches work from a task queue to any available worker that has registered the matching workflow or activity type. With separate queues, you can scale activity workers for the payment step independently of activity workers for the inventory step, because payment may be slower and require more concurrent workers.

**Workflow versioning for live deployments.** When you need to change a running workflow definition (add a step, change a retry policy, reorder activities), you cannot simply deploy the new code. In-flight workflows will be replayed against the new code, which may produce different decisions than the original code, triggering non-determinism errors. Temporal's `workflow.GetVersion` API lets you gate new behavior behind a version integer that is recorded in the workflow history on first execution. Old in-flight workflows see the old version, new workflows see the new version, and both sets run correctly against the same deployed code.

```go
// Correct versioning pattern for adding a new activity after deployment
v := workflow.GetVersion(ctx, "add-fraud-check", workflow.DefaultVersion, 1)
if v == 1 {
    // New code path: run fraud check before payment
    err = workflow.ExecuteActivity(ctx, FraudCheckActivity, input).Get(ctx, nil)
    if err != nil {
        return nil, err
    }
}
// Continue with payment as before
```

**Namespace isolation policy.** At FAANG scale, multiple teams share a Temporal cluster. Namespace isolation is the governance boundary: each team gets its own namespace, which has its own task queues, its own workflow and activity registration, its own retention period for workflow history, and its own rate limits. Platform teams enforce this through Terraform or another IaC tool: no team creates namespaces manually, every namespace has an owner tag, and the rate limits are set by the platform team based on the team's contracted throughput budget. Without this, one team's saga storm can exhaust the history service's write capacity for the entire cluster.

**Cost attribution.** Temporal Cloud charges per active workflow and per action (event). Self-hosted Temporal charges infrastructure cost. In either case, staff engineers are responsible for attributing workflow cost to the product teams that own them. Instrument each worker with a metric tag for `saga_type` and export action count per saga type to the billing system. This makes the cost of adding a new saga step visible to the team that owns the saga, creating an economic incentive to keep saga step counts small.

---
