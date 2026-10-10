## Section 2: Signals, Queries, and Long-Running Workflows

### 2.1 Workflow with Signals and Queries

Signals allow external code to push events into a running workflow without blocking the sender. Queries let callers read workflow state synchronously without modifying it. The following workflow demonstrates both: it waits for approval signals, accumulates state changes, and exposes current status via a query handler. The `workflow.NewSelector` coordinates multiple signal channels and a timeout timer without deadlocks.

```go
package orderworkflow

import (
	"context"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// Signal channel names
const (
	CancelOrderSignal  = "cancel-order"
	UpdateItemsSignal  = "update-items"
	ApproveOrderSignal = "approve-order"
)

// LongRunningOrderState is queryable workflow state.
type LongRunningOrderState struct {
	Status    string
	Items     []Item
	WaitingFor string
	UpdatedAt time.Time
}

// LongRunningOrderWorkflow handles orders that require human approval
// and can be canceled at any point.
func LongRunningOrderWorkflow(ctx workflow.Context, input OrderInput) (*OrderResult, error) {
	logger := workflow.GetLogger(ctx)

	// Mutable state - must only be modified by workflow goroutine
	state := &LongRunningOrderState{
		Status: "pending_approval",
		Items:  input.Items,
	}

	// Register query handler - clients can query state without blocking workflow
	workflow.SetQueryHandler(ctx, "get-state", func() (*LongRunningOrderState, error) {
		return state, nil
	})

	// Channel for cancel signal
	cancelCh := workflow.GetSignalChannel(ctx, CancelOrderSignal)
	approveCh := workflow.GetSignalChannel(ctx, ApproveOrderSignal)
	updateItemsCh := workflow.GetSignalChannel(ctx, UpdateItemsSignal)

	// ─── Wait for approval (with timeout) ─────────────────────────
	state.WaitingFor = "approval"
	logger.Info("Waiting for approval", "order_id", input.OrderID)

	approvalCtx, cancelApproval := workflow.WithCancel(ctx)
	approvalTimer := workflow.NewTimer(approvalCtx, 48*time.Hour)

	approved := false
	canceled := false

	// Use selector to wait for first of: approval, cancel, or timeout
	selector := workflow.NewSelector(ctx)

	selector.AddFuture(approvalTimer, func(f workflow.Future) {
		cancelApproval()
		state.Status = "timed_out"
		logger.Info("Approval timeout", "order_id", input.OrderID)
	})

	selector.AddReceive(approveCh, func(c workflow.ReceiveChannel, more bool) {
		cancelApproval()
		var approverID string
		c.Receive(ctx, &approverID)
		approved = true
		state.Status = "approved"
		state.UpdatedAt = workflow.Now(ctx)
		logger.Info("Order approved", "order_id", input.OrderID, "approver", approverID)
	})

	selector.AddReceive(cancelCh, func(c workflow.ReceiveChannel, more bool) {
		cancelApproval()
		var reason string
		c.Receive(ctx, &reason)
		canceled = true
		state.Status = "canceled"
		state.UpdatedAt = workflow.Now(ctx)
		logger.Info("Order canceled", "order_id", input.OrderID, "reason", reason)
	})

	selector.AddReceive(updateItemsCh, func(c workflow.ReceiveChannel, more bool) {
		var newItems []Item
		c.Receive(ctx, &newItems)
		state.Items = newItems
		input.Items = newItems
		state.UpdatedAt = workflow.Now(ctx)
		logger.Info("Items updated", "order_id", input.OrderID)
	})

	selector.Select(ctx)

	if canceled || state.Status == "timed_out" {
		return &OrderResult{
			OrderID: input.OrderID,
			Status:  state.Status,
		}, nil
	}

	if !approved {
		return &OrderResult{OrderID: input.OrderID, Status: "timed_out"}, nil
	}

	// ─── Proceed with fulfillment ──────────────────────────────────
	state.WaitingFor = "fulfillment"
	actOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2.0,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOpts)

	// Continue with normal order flow...
	var chargeID string
	if err := workflow.ExecuteActivity(ctx, "ChargeCustomer",
		input.CustomerID, input.OrderID, input.TotalAmountCents).Get(ctx, &chargeID); err != nil {
		state.Status = "payment_failed"
		return &OrderResult{OrderID: input.OrderID, Status: "payment_failed"}, err
	}

	state.Status = "completed"
	state.WaitingFor = ""
	return &OrderResult{
		OrderID:  input.OrderID,
		Status:   "completed",
		ChargeID: chargeID,
	}, nil
}

// SendCancelSignal sends a cancellation signal to a running workflow.
func SendCancelSignal(c client.Client, workflowID, runID, reason string) error {
	return c.SignalWorkflow(context.Background(), workflowID, runID, CancelOrderSignal, reason)
}

// QueryWorkflowState queries the current state of a running workflow.
func QueryWorkflowState(c client.Client, workflowID, runID string) (*LongRunningOrderState, error) {
	response, err := c.QueryWorkflow(context.Background(), workflowID, runID, "get-state")
	if err != nil {
		return nil, err
	}
	var state LongRunningOrderState
	if err := response.Get(&state); err != nil {
		return nil, err
	}
	return &state, nil
}
```

### Junior -> FAANG: Signals and Queries as External Interfaces

Signals and queries are the two ways the outside world interacts with a running workflow. Beginners often try to use REST API calls or database polling to check workflow progress. That breaks the Temporal model because it couples your application logic to an external store the workflow does not own.

The concrete thing to memorize: signals modify workflow state and are fire-and-forget. The caller does not know when the workflow processes the signal. Queries read workflow state synchronously and cannot modify anything. If you need both a state change and a return value in one call, that is what the Update primitive (Section 8) is for.

Worked example for the interview: a reviewer presses "Approve" on a UI that calls your backend. The backend sends an approval signal. The backend immediately queries the workflow to confirm the status changed to "approved" before showing the user a success screen. The query may still return "pending_approval" if the workflow has not yet processed the signal. This is the correct behavior: signals are asynchronous. The UI should poll the query, or the backend should use an Update instead.

First-job habit: always pre-register all signal channel names as constants. Typos in signal channel names cause the workflow to wait forever for a signal that never arrives, with no error from the SDK.

### Senior @ FAANG: Signal Buffering, Selector Fairness, and Observability

**Signal buffering and the ordering guarantee.** Signals sent while the workflow is between tasks are buffered on the server and delivered in the order they arrived. Signals sent during an active task are queued and delivered after the current task completes. Ordering is FIFO within a single signal channel. Across multiple channels, ordering relative to each other is not guaranteed. A selector that waits on two channels will process whichever fires first. If both channels have buffered signals, the selector's `Select` call processes one per invocation, requiring a loop to drain all pending signals before proceeding.

**Selector fairness and priority signals.** The `workflow.NewSelector` does not have built-in priority. If a cancel signal and an update-items signal both arrive simultaneously, which one the selector picks is deterministic across replays but not predictable from the application code's perspective. If you need a cancel signal to take priority over all other signals, drain the cancel channel explicitly before calling the general selector:

```go
// Drain high-priority cancel channel first, before any other selector work.
for cancelCh.ReceiveAsync(&reason) {
    canceled = true
}
if canceled {
    return handleCancellation(ctx)
}
```

This pattern is important for workflows where a cancel must be processed immediately and not interleaved with lower-priority signals.

**Query handler registration and the replay gap.** Query handlers registered after a blocking call cannot answer queries about state that was set before that blocking call if the workflow is mid-replay. Always register query handlers at the very top of the workflow function, before any `workflow.ExecuteActivity` or `workflow.NewTimer` call. Failing to do this causes queries to return stale or zero-value state during the replay window immediately after a worker restart.

**Operational visibility for long-running signal-driven workflows.** A workflow that waits for a signal for 48 hours is invisible unless you use search attributes. Set a search attribute for `WaitingFor` at each blocking point, and update it when the signal arrives. This makes it trivial to list all workflows currently waiting on a specific approval, which is a common operations request: "how many orders are blocked waiting for inventory approval right now?" Without the search attribute, that query requires iterating all running workflows and querying each one individually.

**Load testing signal throughput.** If your system sends signals at high volume (thousands per second), test the Temporal Frontend service's gRPC throughput under that load. Signals go through the Frontend gRPC endpoint and are serialized through the History service. Under sustained high signal rate, the History service can become the bottleneck. The mitigation is to batch external events (send one signal with a list of items rather than one signal per item) or to use Continue-As-New to partition the workflow's history when signal volume is expected to be high over a long execution window.

---
