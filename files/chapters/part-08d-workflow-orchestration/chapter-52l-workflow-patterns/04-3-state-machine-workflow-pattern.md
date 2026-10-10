## 3. State Machine Workflow Pattern

Many business processes have a finite set of states with defined transitions between them. Modeling these as explicit state machines makes the logic auditable: you can inspect the current state, the full transition history, and the set of valid next events at any point. Temporal signals drive the transitions, with external systems (a fulfillment service, a delivery driver's scanner, a customer support agent) sending signals that move the workflow from one state to the next.

The order workflow below defines states from `CREATED` through `DELIVERED` or `CANCELED`, with each signal handler validating that the transition is legal from the current state. Invalid signals (such as canceling an already-shipped order) are handled explicitly rather than silently ignored. The `transition` helper records every state change with a timestamp and actor ID, building an audit trail that is queryable through Temporal's query API.

```go
package statemachine

import (
	"context"
	"strconv"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// OrderState represents the current state of an order
type OrderState string

const (
	StateCreated     OrderState = "CREATED"
	StatePending     OrderState = "PENDING"
	StateApproved    OrderState = "APPROVED"
	StateRejected    OrderState = "REJECTED"
	StateFulfilling  OrderState = "FULFILLING"
	StateShipped     OrderState = "SHIPPED"
	StateDelivered   OrderState = "DELIVERED"
	StateCanceled   OrderState = "CANCELED"
	StateRefunded    OrderState = "REFUNDED"
)

// OrderEvent represents events that trigger state transitions
type OrderEvent string

const (
	EventSubmit    OrderEvent = "SUBMIT"
	EventApprove   OrderEvent = "APPROVE"
	EventReject    OrderEvent = "REJECT"
	EventFulfill   OrderEvent = "FULFILL"
	EventShip      OrderEvent = "SHIP"
	EventDeliver   OrderEvent = "DELIVER"
	EventCancel    OrderEvent = "CANCEL"
	EventRefund    OrderEvent = "REFUND"
)

// OrderWorkflowState tracks all workflow state
type OrderWorkflowState struct {
	OrderID           string
	CurrentState      OrderState
	History           []StateTransition
	ApproverID        string
	TrackingCode      string
	CancelReason      string
	RefundAmountCents int64
}

// StateTransition records a state change
type StateTransition struct {
	From      OrderState
	To        OrderState
	Event     OrderEvent
	Timestamp time.Time
	ActorID   string
}

// StateTransitionSignal carries signal data
type StateTransitionSignal struct {
	Event   OrderEvent
	ActorID string
	Data    map[string]string
}

// OrderStateMachineWorkflow implements order processing as a state machine
func OrderStateMachineWorkflow(ctx workflow.Context, orderID string) (OrderWorkflowState, error) {
	logger := workflow.GetLogger(ctx)

	state := OrderWorkflowState{
		OrderID:      orderID,
		CurrentState: StateCreated,
	}

	// Setup signal channel
	transitionCh := workflow.GetSignalChannel(ctx, "state-transition")

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Transition: CREATED -> PENDING (automatic on start)
	transition(&state, EventSubmit, StatePending, workflow.Now(ctx), "system")
	if err := workflow.ExecuteActivity(ctx, SendOrderConfirmationActivity, orderID).Get(ctx, nil); err != nil {
		logger.Warn("Failed to send order confirmation", "error", err)
	}

	// Main state machine loop
	for {
		var sig StateTransitionSignal
		transitionCh.Receive(ctx, &sig)

		logger.Info("Received state transition signal",
			"event", sig.Event,
			"currentState", state.CurrentState)

		switch state.CurrentState {
		case StatePending:
			switch sig.Event {
			case EventApprove:
				transition(&state, EventApprove, StateApproved, workflow.Now(ctx), sig.ActorID)
				state.ApproverID = sig.ActorID

				// Trigger fulfillment
				if err := workflow.ExecuteActivity(ctx, InitiateFulfillmentActivity, orderID).Get(ctx, nil); err != nil {
					logger.Error("Fulfillment initiation failed", "error", err)
					transition(&state, EventCancel, StateCanceled, workflow.Now(ctx), "system")
					return state, err
				}
				transition(&state, EventFulfill, StateFulfilling, workflow.Now(ctx), "system")

			case EventReject:
				reason := sig.Data["reason"]
				state.CancelReason = reason
				transition(&state, EventReject, StateRejected, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, NotifyRejectionActivity, orderID, reason).Get(ctx, nil)
				return state, nil

			case EventCancel:
				state.CancelReason = sig.Data["reason"]
				transition(&state, EventCancel, StateCanceled, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, NotifyCancellationActivity, orderID).Get(ctx, nil)
				return state, nil
			}

		case StateFulfilling:
			switch sig.Event {
			case EventShip:
				state.TrackingCode = sig.Data["trackingCode"]
				transition(&state, EventShip, StateShipped, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, SendShippingNotificationActivity,
					orderID, state.TrackingCode).Get(ctx, nil)

			case EventCancel:
				// Can still cancel if not yet shipped
				state.CancelReason = sig.Data["reason"]
				transition(&state, EventCancel, StateCanceled, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, ReverseReservationActivity, orderID).Get(ctx, nil)
				workflow.ExecuteActivity(ctx, NotifyCancellationActivity, orderID).Get(ctx, nil)
				return state, nil
			}

		case StateShipped:
			switch sig.Event {
			case EventDeliver:
				transition(&state, EventDeliver, StateDelivered, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, SendDeliveryConfirmationActivity, orderID).Get(ctx, nil)
				return state, nil // Terminal state

			case EventCancel:
				// Cannot cancel after shipping
				logger.Warn("Cannot cancel shipped order", "orderID", orderID)
				// Initiate return process instead
				transition(&state, EventRefund, StateRefunded, workflow.Now(ctx), sig.ActorID)
				return state, nil
			}

		case StateDelivered:
			switch sig.Event {
			case EventRefund:
				refundCents, _ := strconv.ParseInt(sig.Data["amount_cents"], 10, 64)
				state.RefundAmountCents = refundCents
				transition(&state, EventRefund, StateRefunded, workflow.Now(ctx), sig.ActorID)
				workflow.ExecuteActivity(ctx, ProcessRefundActivity, orderID, refundCents).Get(ctx, nil)
				return state, nil
			default:
				// Delivered is semi-terminal, return on any other signal
				return state, nil
			}
		}
	}
}

func transition(state *OrderWorkflowState, event OrderEvent, to OrderState, ts time.Time, actor string) {
	state.History = append(state.History, StateTransition{
		From:      state.CurrentState,
		To:        to,
		Event:     event,
		Timestamp: ts,
		ActorID:   actor,
	})
	state.CurrentState = to
}

// Placeholder activities
func SendOrderConfirmationActivity(ctx context.Context, orderID string) error                  { return nil }
func InitiateFulfillmentActivity(ctx context.Context, orderID string) error                    { return nil }
func NotifyRejectionActivity(ctx context.Context, orderID, reason string) error               { return nil }
func NotifyCancellationActivity(ctx context.Context, orderID string) error                     { return nil }
func SendShippingNotificationActivity(ctx context.Context, orderID, trackingCode string) error { return nil }
func ReverseReservationActivity(ctx context.Context, orderID string) error                     { return nil }
func SendDeliveryConfirmationActivity(ctx context.Context, orderID string) error               { return nil }
func ProcessRefundActivity(ctx context.Context, orderID string, amountCents int64) error       { return nil }
```

### Junior → FAANG: Why State Machines and When to Use Them

A state machine is the right model when the set of valid states is finite and the transitions between them are determined by a known set of events. The order workflow above has nine states and eight event types. Without an explicit state machine, this logic would be scattered across multiple services and condition chains, making it impossible to audit "what state is this order in and how did it get there?"

**The key signal that a state machine is needed.** When you find yourself writing "if the order has been shipped, you can no longer cancel it" as a comment instead of an enforced constraint, you need a state machine. The transition table is the specification. Every invalid transition is rejected at the switch statement, producing an auditable record of the rejection rather than silently ignoring the signal.

**Signals drive transitions, not polling.** A junior engineer's first instinct is to poll: "every minute, check if the order has been approved." This wastes resources and introduces latency proportional to the polling interval. The signal model is correct: the workflow parks in a `Receive` call and the external system (a fulfillment service, a delivery scanner, a customer service agent) sends a signal when the event occurs. The workflow resumes immediately on signal delivery.

**The `transition` helper builds the audit trail.** Every state change in the example records the from-state, to-state, event, timestamp, and actor ID. This is queryable through Temporal's query API without requiring a separate audit table. The audit trail is a first-class artifact of the workflow execution, not an afterthought.

**Interview framing.** "Design an order management system where an order can be created, paid, fulfilled, shipped, delivered, or canceled at various stages" is a direct prompt for a state machine. Draw the state transition diagram first. Then map each edge to a signal. Then identify which transitions trigger activities (side effects). The interviewer is checking whether you enumerate invalid transitions, not just valid ones.

### Senior @ FAANG: State Machine Governance, Queryability, and Versioning

At senior level, the state machine pattern raises questions that go beyond the implementation: how do you version state machines safely, how do you make state queryable at scale, and how do you enforce the transition table as a platform contract?

**Versioning a state machine is the hardest versioning problem.** Adding a new state (say, `DISPUTED`) requires a `workflow.GetVersion` gate because the new state may appear in the switch statement before the existing cases, changing the execution path for in-flight workflows. Adding a new transition from an existing state (e.g., allowing `REFUND` from `SHIPPED`) is safer but still requires careful gate placement. The rule: any change to the transition table requires a version gate. The test: replay an in-flight workflow history against the new code and verify no non-determinism error.

**Queryable state at scale.** The Temporal query API allows external systems to query a running workflow's state synchronously. At low volume, this is convenient. At high volume (10,000 order queries per second), direct workflow queries create load on the Temporal frontend service. The production architecture at FAANG scale uses a read model: the workflow publishes state changes to an event stream (Kafka, SNS), and a downstream service maintains a queryable projection of current order states. The workflow remains the authoritative state machine, and the read model is a derived view. This is CQRS applied to workflow state.

**Invalid transition handling policy.** The example logs a warning for `EventCancel` on a shipped order and redirects to a refund. In production, invalid transitions must be handled explicitly, not silently. Options: log and discard, record in the audit trail as a rejected signal, or route to a dead-letter workflow for human review. The choice depends on the business domain. Financial workflows must not silently discard signals. The platform policy should specify which behavior is required for which workflow category.

**State machine as the bounded context boundary.** In DDD terms, the order state machine defines the lifecycle of the Order aggregate within the orders bounded context. External contexts (fulfillment, shipping, payments) communicate with this context via signals, not by directly mutating order state. This is the correct bounded context design: each context owns its aggregate's state machine, and inter-context communication happens through domain events and signals, not shared tables or direct API calls to internal state.

**Bar-raiser signal: the candidate asks about terminal state handling.** A strong candidate recognizes that terminal states (`DELIVERED`, `REFUNDED`, `CANCELED`) require workflow completion, and that workflows must not loop indefinitely waiting for signals after reaching a terminal state. The example returns from the `switch` on terminal states. A candidate who designs an infinite loop that never terminates is revealing a misunderstanding of the execution model. The bar-raiser probes: "what happens to the workflow history after delivery? How does the workflow instance get cleaned up?"

**History-efficient state machines.** For high-throughput domains (10,000 orders per hour), each state machine workflow's history must be bounded. If an order has many sub-states (payment retries, fulfillment attempts per warehouse, delivery reattempts), the history can grow beyond Temporal's limits. The solution is hierarchical: the parent order state machine delegates sub-processes to child workflows. The parent tracks coarse-grained states (PAYING, FULFILLING, SHIPPING). Each child manages fine-grained states within its scope. This keeps each workflow's history bounded regardless of the number of sub-state transitions.

---
