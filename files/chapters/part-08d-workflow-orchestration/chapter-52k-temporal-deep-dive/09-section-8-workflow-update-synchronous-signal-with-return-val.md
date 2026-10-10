## Section 8: Workflow Update - Synchronous Signal with Return Value

Temporal's **Update** primitive (added in Temporal Server 1.21) combines signal and query semantics: it modifies workflow state and returns a typed response synchronously. The caller blocks until the workflow processes the update. Updates also support a `Validator` function that rejects invalid requests before any state changes occur. The following workflow lets callers add items to an in-flight order via updates, with a 30-minute lock window after which no more changes are accepted.

```go
package orderworkflow

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// UpdateAddItemRequest is sent via workflow.Update to add items to an in-flight order.
type UpdateAddItemRequest struct {
	ProductID string
	Quantity  int
}

// UpdateAddItemResponse is returned synchronously to the caller.
type UpdateAddItemResponse struct {
	NewItemCount int
	NewTotal     int64
}

// FlexibleOrderWorkflow allows items to be added while the order is being processed.
func FlexibleOrderWorkflow(ctx workflow.Context, input OrderInput) (OrderResult, error) {
	var items []OrderItem
	items = append(items, input.Items...)

	// Register the Update handler before any blocking calls.
	// The validator runs synchronously - if it returns an error the update is rejected
	// before the handler executes and before any workflow state changes.
	err := workflow.SetUpdateHandlerWithOptions(ctx, "add-item",
		func(ctx workflow.Context, req UpdateAddItemRequest) (UpdateAddItemResponse, error) {
			items = append(items, OrderItem{
				ProductID: req.ProductID,
				Quantity:  req.Quantity,
			})
			return UpdateAddItemResponse{
				NewItemCount: len(items),
				NewTotal:     calculateTotal(items),
			}, nil
		},
		workflow.UpdateHandlerOptions{
			Validator: func(ctx workflow.Context, req UpdateAddItemRequest) error {
				if req.Quantity <= 0 {
					return temporal.NewApplicationError("quantity must be positive", "ValidationError")
				}
				if len(items) >= 100 {
					return temporal.NewApplicationError("order item limit reached", "LimitError")
				}
				return nil
			},
		},
	)
	if err != nil {
		return OrderResult{}, fmt.Errorf("register update handler: %w", err)
	}

	// Lock the order after 30 minutes - no more updates accepted.
	lockTimer := workflow.NewTimer(ctx, 30*time.Minute)

	// Wait for lock OR for a cancellation signal.
	locked := false
	workflow.NewSelector(ctx).
		AddFuture(lockTimer, func(f workflow.Future) {
			locked = true
			workflow.GetLogger(ctx).Info("Order locked - no more item updates accepted")
		}).
		Select(ctx)

	if locked {
		// Unregister the update handler so further updates are rejected.
		_ = workflow.SetUpdateHandler(ctx, "add-item", nil)
	}

	// Now execute the order with the final item list.
	actOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:        3,
			NonRetryableErrorTypes: []string{"InsufficientFunds", "ProductNotFound"},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOpts)

	var result OrderResult
	if err := workflow.ExecuteActivity(ctx, "ProcessOrder", items).Get(ctx, &result); err != nil {
		return OrderResult{}, err
	}
	return result, nil
}

func calculateTotal(items []OrderItem) int64 {
	var total int64
	for _, item := range items {
		total += int64(item.PriceCents) * int64(item.Quantity)
	}
	return total
}
```

Calling an Update from a Go client:

```go
func addItemToOrder(c client.Client, workflowID, runID string, req UpdateAddItemRequest) (*UpdateAddItemResponse, error) {
	handle, err := c.UpdateWorkflow(context.Background(), client.UpdateWorkflowOptions{
		WorkflowID:   workflowID,
		RunID:        runID,
		UpdateName:   "add-item",
		Args:         []any{req},
		WaitForStage: client.WorkflowUpdateStageCompleted, // block until handler returns
	})
	if err != nil {
		return nil, fmt.Errorf("send update: %w", err)
	}

	var resp UpdateAddItemResponse
	if err := handle.Get(context.Background(), &resp); err != nil {
		return nil, fmt.Errorf("update result: %w", err)
	}
	return &resp, nil
}
```

### Junior -> FAANG: Update vs Signal vs Query

The Update primitive is the most recently added and least understood of the three interaction mechanisms. The prerequisite gap: most engineers reach for a signal when they need to modify workflow state and check the result, then realize signals have no return value, and hack together a signal-plus-polling-query pattern. Update was designed to replace exactly that pattern.

The concrete contract to memorize: a signal is fire-and-forget with no return value. A query is read-only with a return value. An Update modifies state and returns a value, and the caller blocks until the workflow processes it.

The Validator function is the most important feature of Update that beginners skip. It runs before any state changes and rejects invalid requests before the handler executes. Without a validator, the handler must check validity and then attempt to undo partial state changes if the input is invalid. With a validator, no state is touched for invalid requests.

Worked example for the interview: a customer adds an item to an in-flight order. The UI needs to show the updated total immediately. With Signal, you send the add-item signal and then poll the "get-state" query until the new item appears. With Update, you send the update and block until the handler returns the new item count and total. The Update is one RPC instead of N polls.

First-job habit: always use `WaitForStage: client.WorkflowUpdateStageCompleted` when you need the result. If you use `WorkflowUpdateStageAccepted`, you only know the update was accepted, not that it was processed.

### Senior @ FAANG: Update Durability, Admission Control, and Ecosystem Fit

**Update durability guarantees.** An Update that completes (handler returns) is durably recorded in the workflow event history. If the worker crashes after the handler runs but before the completion acknowledgment reaches the client, the client receives a timeout error, but the Update is already in history. On re-query or retry, the client should expect either a "not found" (if the Update was lost before the handler ran) or the original result (if the handler already ran). Design Update clients to be idempotent in their handling of both outcomes.

**Update admission and the validator as an admission control gate.** The Validator runs on the workflow worker before the Update is accepted. It is not a simple argument check but a genuine admission control mechanism: it has access to the full workflow state at the time the Update arrives. This enables patterns like "reject the update if the workflow is in a terminal state" or "reject if the current item count plus the new quantity exceeds the platform limit." The validator must be fast and must not have side effects: it runs synchronously and blocks the workflow from processing other tasks.

**Update latency profile.** An Update round-trip involves the client sending the Update request to the Frontend service, the Frontend routing it to the Matching service, the Matching service finding a worker polling the task queue, the worker executing the workflow task (which processes the Update), and the server returning the result. End-to-end latency depends on whether a workflow task is already in-flight (the Update can be processed by the current task) or whether a new task must be scheduled and polled by a worker. In the worst case, Update latency is schedule-to-start latency plus workflow task execution time. For latency-sensitive use cases, ensure sufficient workers are polling to keep schedule-to-start latency under 100ms.

**Update as a building block for interactive workflow patterns.** The Update primitive enables a class of workflow patterns that were previously impractical: interactive multi-step human workflows where each UI action modifies workflow state and requires immediate confirmation. A checkout flow built on Updates can handle "add item", "remove item", "apply coupon", and "change address" as sequential Updates that each return the current cart state. The workflow is a single durable execution that spans the entire checkout session, with the cart state surviving browser refreshes, server restarts, and network interruptions.

**Governance concern: Update as an API surface.** Every registered Update handler is an implicit API endpoint. Like any API, it must have a versioned contract. Adding a new required field to `UpdateAddItemRequest` breaks callers that do not send that field. The governance rule: treat Update handler input structs as protobuf-style append-only types. Document each Update handler in the service's API registry alongside gRPC and REST endpoints. Changes to Update handler contracts require the same review process as API breaking changes.

---
