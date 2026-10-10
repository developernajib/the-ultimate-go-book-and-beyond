## 7. Event-Driven Workflow Triggers

Domain events from Kafka, webhooks, or database change-data-capture (CDC) streams can trigger Temporal workflows through an event router. The router maps event types to workflow starts or signals: a `user.signed_up` event starts an onboarding workflow, while a `subscription.canceled` event signals an already-running onboarding workflow to stop its drip campaign.

The onboarding workflow below demonstrates a long-running event-driven pattern. It performs immediate parallel actions (welcome email, account provisioning), applies conditional logic (referral bonuses, enterprise onboarding calls), then runs a multi-week email drip campaign with engagement checks. At each drip step, it listens for a cancellation signal alongside the wait timer, allowing the user to opt out at any point. The `WorkflowIDReusePolicy` on the start options ensures that duplicate events for the same user do not create duplicate workflows.

```go
package eventdriven

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// DomainEvent represents an event from the business domain
type DomainEvent struct {
	EventID   string          `json:"eventId"`
	EventType string          `json:"eventType"`
	AggregateID string        `json:"aggregateId"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
	Version   int             `json:"version"`
}

// UserSignedUp event payload
type UserSignedUpPayload struct {
	UserID    string `json:"userId"`
	Email     string `json:"email"`
	Plan      string `json:"plan"`
	ReferralCode string `json:"referralCode,omitempty"`
}

// OnboardingActivities handles user onboarding
type OnboardingActivities struct{}

// SendWelcomeEmail sends the initial welcome email
func (a *OnboardingActivities) SendWelcomeEmail(ctx context.Context, userID, email string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending welcome email", "userID", userID, "email", email)
	return nil
}

// ProvisionUserAccount creates the user account resources
func (a *OnboardingActivities) ProvisionUserAccount(ctx context.Context, userID, plan string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Provisioning user account", "userID", userID, "plan", plan)
	return nil
}

// ScheduleOnboardingCall schedules a call with customer success
func (a *OnboardingActivities) ScheduleOnboardingCall(ctx context.Context, userID, email string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Scheduling onboarding call", "userID", userID)
	return nil
}

// ApplyReferralBonus applies referral bonus to both users
func (a *OnboardingActivities) ApplyReferralBonus(ctx context.Context, newUserID, referralCode string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Applying referral bonus",
		"newUserID", newUserID,
		"referralCode", referralCode)
	return nil
}

// SendOnboardingSequenceActivity sends a series of onboarding emails
func (a *OnboardingActivities) SendOnboardingSequence(ctx context.Context, userID string, dayNumber int) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending onboarding sequence email",
		"userID", userID,
		"day", dayNumber)
	return nil
}

// CheckUserEngagement checks if user has been active
func (a *OnboardingActivities) CheckUserEngagement(ctx context.Context, userID string) (bool, error) {
	// Check if user has logged in, used features, etc.
	return true, nil
}

// UserOnboardingWorkflow manages the full user onboarding experience
func UserOnboardingWorkflow(ctx workflow.Context, event DomainEvent) error {
	logger := workflow.GetLogger(ctx)

	var payload UserSignedUpPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	logger.Info("Starting user onboarding",
		"userID", payload.UserID,
		"plan", payload.Plan)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 1 * time.Second,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// Immediate actions (in parallel)
	welcomeFuture := workflow.ExecuteActivity(ctx,
		(*OnboardingActivities)(nil).SendWelcomeEmail, payload.UserID, payload.Email)
	provisionFuture := workflow.ExecuteActivity(ctx,
		(*OnboardingActivities)(nil).ProvisionUserAccount, payload.UserID, payload.Plan)

	if err := welcomeFuture.Get(ctx, nil); err != nil {
		logger.Warn("Welcome email failed", "error", err)
	}
	if err := provisionFuture.Get(ctx, nil); err != nil {
		return fmt.Errorf("account provisioning failed: %w", err)
	}

	// Apply referral bonus if applicable
	if payload.ReferralCode != "" {
		if err := workflow.ExecuteActivity(ctx,
			(*OnboardingActivities)(nil).ApplyReferralBonus,
			payload.UserID, payload.ReferralCode).Get(ctx, nil); err != nil {
			logger.Warn("Referral bonus failed", "error", err)
		}
	}

	// Enterprise plans get onboarding calls
	if payload.Plan == "enterprise" {
		if err := workflow.ExecuteActivity(ctx,
			(*OnboardingActivities)(nil).ScheduleOnboardingCall,
			payload.UserID, payload.Email).Get(ctx, nil); err != nil {
			logger.Warn("Onboarding call scheduling failed", "error", err)
		}
	}

	// Email drip campaign: Day 1, 3, 7, 14
	drip := []struct {
		day    int
		waitFor time.Duration
	}{
		{1, 24 * time.Hour},
		{3, 48 * time.Hour},
		{7, 96 * time.Hour},
		{14, 168 * time.Hour},
	}

	for _, d := range drip {
		// Check if user canceled or unsubscribed
		cancelCh := workflow.GetSignalChannel(ctx, "onboarding-cancel")
		var canceled bool

		timer := workflow.NewTimer(ctx, d.waitFor)
		selector := workflow.NewSelector(ctx)

		selector.AddFuture(timer, func(f workflow.Future) {})
		selector.AddReceive(cancelCh, func(c workflow.ReceiveChannel, more bool) {
			c.Receive(ctx, nil)
			canceled = true
		})

		selector.Select(ctx)

		if canceled {
			logger.Info("Onboarding canceled by user", "userID", payload.UserID)
			return nil
		}

		// Check engagement before sending
		var engaged bool
		if err := workflow.ExecuteActivity(ctx,
			(*OnboardingActivities)(nil).CheckUserEngagement,
			payload.UserID).Get(ctx, &engaged); err != nil {
			logger.Warn("Engagement check failed", "error", err)
			engaged = true // Default to sending
		}

		if engaged {
			if err := workflow.ExecuteActivity(ctx,
				(*OnboardingActivities)(nil).SendOnboardingSequence,
				payload.UserID, d.day).Get(ctx, nil); err != nil {
				logger.Warn("Onboarding email failed",
					"day", d.day, "error", err)
			}
		}
	}

	logger.Info("User onboarding completed", "userID", payload.UserID)
	return nil
}

// EventRouterWorkflow routes domain events to appropriate workflows
type EventRouter struct {
	temporalClient client.Client
}

// RouteEvent determines which workflow to start for an event
func (r *EventRouter) RouteEvent(ctx context.Context, event DomainEvent) error {
	switch event.EventType {
	case "user.signed_up":
		_, err := r.temporalClient.ExecuteWorkflow(ctx,
			client.StartWorkflowOptions{
				ID:        fmt.Sprintf("onboarding-%s", event.AggregateID),
				TaskQueue: "onboarding-queue",
				// Idempotency: if workflow already exists, reject duplicate
				WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
			},
			UserOnboardingWorkflow,
			event,
		)
		return err

	case "payment.failed":
		_, err := r.temporalClient.ExecuteWorkflow(ctx,
			client.StartWorkflowOptions{
				ID:        fmt.Sprintf("payment-recovery-%s", event.AggregateID),
				TaskQueue: "payments-queue",
			},
			PaymentRecoveryWorkflow,
			event,
		)
		return err

	case "subscription.canceled":
		// Signal existing workflow if running
		return r.temporalClient.SignalWorkflow(ctx,
			fmt.Sprintf("onboarding-%s", event.AggregateID),
			"",
			"onboarding-cancel",
			nil,
		)
	}

	return fmt.Errorf("unknown event type: %s", event.EventType)
}

// PaymentRecoveryWorkflow placeholder
func PaymentRecoveryWorkflow(ctx workflow.Context, event DomainEvent) error {
	return nil
}
```

### Junior → FAANG: Event Routing and Idempotent Workflow Starts

Event-driven triggers are how the external world connects to your Temporal workflows. The connection point is the event router, and the router has correctness requirements that are easy to miss.

**`WorkflowIDReusePolicy` is the deduplication mechanism.** When an event arrives twice (Kafka's at-least-once delivery guarantees this will happen), the router calls `ExecuteWorkflow` twice with the same workflow ID. Without `RejectDuplicate`, a second workflow starts, producing duplicate side effects (two welcome emails, two account provisions). `RejectDuplicate` means the second call returns an error indicating the workflow already exists, and the router ignores that error. This is idempotent event processing.

**Signals versus workflow starts for event routing.** `user.signed_up` starts a new workflow because no workflow exists yet for that user. `subscription.canceled` signals an existing workflow because the onboarding workflow for that user is already running and needs to react to the cancellation. The decision rule is: if the event starts a new lifecycle, use `ExecuteWorkflow`. If the event modifies an in-progress lifecycle, use `SignalWorkflow`. Getting this wrong produces either duplicate workflows or missed signal deliveries.

**`SignalWithStart` handles the race condition.** If `subscription.canceled` arrives before `user.signed_up` is processed (possible in async event streams), `SignalWorkflow` fails because the target workflow does not yet exist. The `SignalWithStart` client API atomically starts the workflow if it does not exist and sends the signal. Use it whenever the ordering of `start` and `signal` events cannot be guaranteed.

**The event envelope contains a version field for a reason.** The `DomainEvent` struct has a `Version` field. Event schema evolution (adding a field, changing a type) is handled by versioning the event. The consumer checks the version and uses the appropriate deserialization logic. This is exactly the same problem as workflow versioning, applied to the message boundary. Always include a version field in event schemas from the start. Retrofitting it later requires a migration.

### Senior @ FAANG: Event-Driven Platform Architecture and Delivery Guarantees

At staff level, event-driven workflow triggers are part of a broader platform architecture that must address delivery guarantees, ordering semantics, and failure handling in the event router itself.

**The event router is a critical path component.** If the router fails (it crashes between receiving the event and calling Temporal), the event is lost and the workflow never starts. The correct architecture makes the router fault-tolerant: consume from Kafka with manual offset commit, call Temporal, commit the offset only on success. If the Temporal call fails (transient), do not commit the offset and let Kafka redeliver. If the Temporal call returns "workflow already exists," treat it as success and commit the offset. This at-least-once-to-Temporal pattern, combined with `RejectDuplicate` on the workflow side, produces exactly-once workflow starts.

**Ordering guarantees within a workflow versus across workflows.** Within a single workflow, signals are delivered in the order they are sent (FIFO per channel). Across different workflow instances (different user IDs), no ordering guarantee exists. If the business logic requires "process all events for a user in order," route all events for the same user to the same workflow ID and use a single signal channel. If events for different users can be processed in any order, the current event routing design is correct.

**Backpressure from Temporal to the event router.** Temporal's task queue has a maximum throughput based on the number of workers and their polling rate. If events arrive faster than Temporal can process them, the event router's Temporal calls start experiencing increased latency. Without backpressure, the router's goroutine pool grows unbounded and the router itself becomes a memory leak. The correct design adds a semaphore or rate limiter to the router that bounds the number of in-flight Temporal calls, and a Kafka consumer lag alert that pages when the router cannot keep up with the event stream.

**Schema registry integration for event deserialization.** The `json.Unmarshal(event.Payload, &payload)` call in the onboarding workflow assumes the payload schema matches the `UserSignedUpPayload` struct. In a multi-team organization, event schema governance requires a schema registry (Confluent Schema Registry, AWS Glue, or equivalent). The event router validates incoming events against the registered schema before routing them. Invalid events go to a dead-letter topic, not to a workflow. Workflows never see malformed payloads because validation happens at the router boundary.

**Long-running event-driven workflows and `ContinueAsNew`.** The onboarding workflow runs for up to 14 days (the last drip email at day 14). Its history accumulates one entry per timer, per activity, and per signal over that period. For a workflow that runs indefinitely (an event-processing loop that never terminates), history would grow without bound. Use `ContinueAsNew` at logical checkpoints (e.g., after processing each batch of events) to start a fresh history while preserving state. Pass the current state (which events have been processed, what the drip schedule is) as the argument to the new run.

**ADR: event sourcing versus event routing.** Some teams conflate event sourcing (using an event log as the system of record) with event-driven workflow triggers (using events to start workflows). These are different patterns. Event sourcing means the workflow state is derived entirely from the event log, which is what Temporal's workflow history already provides. Event routing means external domain events trigger workflow lifecycle transitions. The ADR should clearly separate these concerns: "We use Temporal for durable execution. We use Kafka for inter-service event routing. Domain events on Kafka trigger workflow starts and signals via the event router. Workflow state is maintained in Temporal history, not in the Kafka event log."

---
