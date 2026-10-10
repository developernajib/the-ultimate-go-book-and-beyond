## 4. Human-in-the-Loop Pattern

Approval workflows park execution at a defined point and wait for a human decision delivered via Temporal signal. The workflow remains durable during this wait, which can span hours or days without consuming worker resources. Temporal timers handle the time-based logic: sending periodic reminders, escalating to a senior approver after a deadline, or auto-approving low-value requests that nobody reviewed in time.

The expense approval workflow below demonstrates the full lifecycle. It routes requests to an initial approver based on amount, sends reminder notifications every 8 hours, and escalates after 48 hours if no decision arrives. The multi-level variant chains approval steps sequentially, where rejection at any level short-circuits the remaining levels. Each level runs as a child workflow with its own signal channel and timeout, keeping the approval logic modular and independently testable.

```go
package humanloop

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ApprovalRequest represents a request for human approval
type ApprovalRequest struct {
	RequestID   string
	RequestType string
	AmountCents int64
	Description string
	RequestedBy string
	Priority    string
}

// ApprovalDecision represents a human decision
type ApprovalDecision struct {
	Approved  bool
	ApproverID string
	Comment   string
	Timestamp time.Time
}

// ApprovalWorkflowState tracks the approval workflow
type ApprovalWorkflowState struct {
	Request  ApprovalRequest
	Decision *ApprovalDecision
	Status   string
	Reminders int
}

// ApprovalActivities handles approval-related operations
type ApprovalActivities struct {
	notificationClient interface{ Send(ctx context.Context, to, subject, body string) error }
}

// NotifyApprover sends an approval request notification
func (a *ApprovalActivities) NotifyApprover(ctx context.Context, req ApprovalRequest, approverID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Notifying approver",
		"requestID", req.RequestID,
		"approverID", approverID)

	// Send email/Slack notification with approval link
	subject := fmt.Sprintf("Approval Required: %s (Amount: $%d.%02d)", req.RequestType, req.AmountCents/100, req.AmountCents%100)
	body := fmt.Sprintf(
		"Request ID: %s\nType: %s\nAmount: $%d.%02d\nDescription: %s\nRequested By: %s",
		req.RequestID, req.RequestType, req.AmountCents/100, req.AmountCents%100, req.Description, req.RequestedBy,
	)

	return a.notificationClient.Send(ctx, approverID+"@company.com", subject, body)
}

// EscalateApproval escalates to senior approver
func (a *ApprovalActivities) EscalateApproval(ctx context.Context, req ApprovalRequest) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Escalating approval", "requestID", req.RequestID)

	// Logic to determine senior approver
	return "senior-approver-001", nil
}

// RecordDecision records the approval decision in the database
func (a *ApprovalActivities) RecordDecision(ctx context.Context, req ApprovalRequest, decision ApprovalDecision) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Recording decision",
		"requestID", req.RequestID,
		"approved", decision.Approved)

	return nil
}

// ExpenseApprovalWorkflow handles expense approval with escalation
func ExpenseApprovalWorkflow(ctx workflow.Context, req ApprovalRequest) (ApprovalWorkflowState, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting expense approval workflow",
		"requestID", req.RequestID,
		"amount_cents", req.AmountCents)

	state := ApprovalWorkflowState{
		Request: req,
		Status:  "PENDING",
	}

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Determine initial approver based on amount
	approverID := "manager-001"
	if req.AmountCents > 1000000 { // $10,000.00
		approverID = "director-001"
	}

	// Signal channel for human decision
	approvalCh := workflow.GetSignalChannel(ctx, "approval-decision")

	// Notify approver
	if err := workflow.ExecuteActivity(ctx,
		(*ApprovalActivities)(nil).NotifyApprover, req, approverID).Get(ctx, nil); err != nil {
		logger.Error("Failed to notify approver", "error", err)
		// Continue anyway - workflow will use timer-based reminder
	}

	// Wait for approval with timeout and reminders
	const approvalTimeout = 48 * time.Hour
	const reminderInterval = 8 * time.Hour
	deadline := workflow.Now(ctx).Add(approvalTimeout)

	for {
		// Create timer for next reminder or final deadline
		nextReminder := workflow.Now(ctx).Add(reminderInterval)
		if nextReminder.After(deadline) {
			nextReminder = deadline
		}
		timerFuture := workflow.NewTimer(ctx, nextReminder.Sub(workflow.Now(ctx)))

		selector := workflow.NewSelector(ctx)
		var received bool

		selector.AddReceive(approvalCh, func(c workflow.ReceiveChannel, more bool) {
			received = true
			var dec ApprovalDecision
			c.Receive(ctx, &dec)
			state.Decision = &dec
		})

		selector.AddFuture(timerFuture, func(f workflow.Future) {
			// Timer fired
		})

		selector.Select(ctx)

		if received && state.Decision != nil {
			// Human made a decision
			break
		}

		// Check if we've hit the final deadline
		if !workflow.Now(ctx).Before(deadline) {
			// Auto-escalate or auto-reject based on policy
			if req.AmountCents < 100000 { // $1,000.00
				// Auto-approve small amounts after timeout
				logger.Info("Auto-approving small amount after timeout",
					"requestID", req.RequestID)
				state.Decision = &ApprovalDecision{
					Approved:   true,
					ApproverID: "system",
					Comment:    "Auto-approved: timeout exceeded for small amount",
					Timestamp:  workflow.Now(ctx),
				}
			} else {
				// Escalate
				logger.Info("Escalating due to timeout", "requestID", req.RequestID)

				var escalatedApprover string
				if err := workflow.ExecuteActivity(ctx,
					(*ApprovalActivities)(nil).EscalateApproval, req).Get(ctx, &escalatedApprover); err != nil {
					logger.Error("Escalation failed", "error", err)
					state.Status = "ESCALATION_FAILED"
					return state, fmt.Errorf("escalation failed: %w", err)
				}

				// Reset deadline for escalated approver
				deadline = workflow.Now(ctx).Add(24 * time.Hour)
				state.Reminders = 0

				workflow.ExecuteActivity(ctx,
					(*ApprovalActivities)(nil).NotifyApprover, req, escalatedApprover).Get(ctx, nil)

				continue
			}
			break
		}

		// Send reminder
		state.Reminders++
		logger.Info("Sending reminder", "reminder", state.Reminders)
		workflow.ExecuteActivity(ctx,
			(*ApprovalActivities)(nil).NotifyApprover, req, approverID).Get(ctx, nil)
	}

	// Record decision
	if state.Decision != nil {
		if err := workflow.ExecuteActivity(ctx,
			(*ApprovalActivities)(nil).RecordDecision, req, *state.Decision).Get(ctx, nil); err != nil {
			logger.Warn("Failed to record decision", "error", err)
		}

		if state.Decision.Approved {
			state.Status = "APPROVED"
		} else {
			state.Status = "REJECTED"
		}
	}

	return state, nil
}

// MultiLevelApprovalWorkflow handles multi-level approval chains
func MultiLevelApprovalWorkflow(ctx workflow.Context, req ApprovalRequest) error {
	logger := workflow.GetLogger(ctx)

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	// Determine approval chain based on amount
	type approvalLevel struct {
		approverID string
		thresholdCents int64
	}

	levels := []approvalLevel{
		{"manager-001", 500000},    // $5,000.00
		{"director-001", 5000000},  // $50,000.00
		{"vp-001", 50000000},       // $500,000.00
		{"cfo-001", -1},            // No threshold - always required at top
	}

	for _, level := range levels {
		if level.thresholdCents > 0 && req.AmountCents < level.thresholdCents {
			continue // Skip this level
		}

		// Sub-workflow for each approval level
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID: fmt.Sprintf("%s-level-%s", req.RequestID, level.approverID),
		})

		var levelDecision ApprovalDecision
		err := workflow.ExecuteChildWorkflow(childCtx, SingleLevelApprovalWorkflow,
			req, level.approverID).Get(ctx, &levelDecision)
		if err != nil {
			return fmt.Errorf("approval level %s failed: %w", level.approverID, err)
		}

		if !levelDecision.Approved {
			logger.Info("Request rejected at approval level",
				"approverID", level.approverID,
				"comment", levelDecision.Comment)
			return temporal.NewApplicationError("Rejected", "rejection",
				fmt.Sprintf("rejected by %s: %s", level.approverID, levelDecision.Comment))
		}

		logger.Info("Approved at level",
			"approverID", level.approverID)
	}

	logger.Info("All approval levels passed", "requestID", req.RequestID)
	return nil
}

// SingleLevelApprovalWorkflow handles approval at a single level
func SingleLevelApprovalWorkflow(ctx workflow.Context, req ApprovalRequest, approverID string) (ApprovalDecision, error) {
	approvalCh := workflow.GetSignalChannel(ctx, "approval-decision")

	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	workflow.ExecuteActivity(ctx, (*ApprovalActivities)(nil).NotifyApprover, req, approverID).Get(ctx, nil)

	// Wait up to 24 hours for decision
	timerFuture := workflow.NewTimer(ctx, 24*time.Hour)
	selector := workflow.NewSelector(ctx)

	var decision ApprovalDecision
	var decided bool

	selector.AddReceive(approvalCh, func(c workflow.ReceiveChannel, more bool) {
		c.Receive(ctx, &decision)
		decided = true
	})
	selector.AddFuture(timerFuture, func(f workflow.Future) {})

	selector.Select(ctx)

	if !decided {
		return ApprovalDecision{}, temporal.NewApplicationError(
			"ApprovalTimeout", "timeout",
			fmt.Sprintf("approval timed out for approver %s", approverID))
	}

	return decision, nil
}
```

### Junior → FAANG: Modeling Human Decision Points Correctly

The human-in-the-loop pattern looks simple but contains several correctness requirements that are easy to miss on a first implementation.

**Do not poll for the human decision in an activity.** A junior engineer's instinct is to write a `WaitForApprovalActivity` that polls a database every 30 seconds until a record appears. This approach burns worker threads for the entire wait duration (potentially days), creates heartbeat timeout complexity, and means the approval workflow is coupled to the polling database table's schema. The signal-wait model in the workflow itself is the correct design: the worker thread is released during `Receive`, and the workflow resumes immediately on signal delivery.

**The signal channel must be registered before the notification is sent.** If the notification is sent first (causing the approver to respond instantly), and then the signal channel is created, the response signal arrives before the channel exists and is lost. The implementation above registers `approvalCh` at the top of the function, before any activity executes. This ordering is not accidental.

**Timer and signal race is handled by the selector.** The `workflow.NewSelector` pattern races a timer against the signal channel. Whichever fires first wins. If the timer fires, `decided` remains false and the workflow escalates. If the signal fires, `decided` is true and the workflow records the decision. This is the canonical Go pattern for timeout with value selection, adapted for Temporal's deterministic execution model.

**Auto-approve versus auto-reject as a business policy.** The escalation example auto-approves small amounts after the timeout and escalates larger ones. This is a business policy, not a technical default. In an interview, flag that this policy must be documented in the approval workflow's specification, not inferred from code comments. A policy change (e.g., changing the auto-approve threshold) is a versioned workflow change, not a configuration change.

**Testing time-based behavior.** The `testsuite` package simulates time, so a test can advance the clock by 48 hours to trigger the escalation path. The `RegisterDelayedCallback` method sends the signal at a specified simulated time offset. Write tests for all three paths: human approves before timeout, human rejects before timeout, and timeout triggers escalation. Skipping the timeout test leaves the most important failure mode untested.

### Senior @ FAANG: Approval Workflow Governance, SLA Enforcement, and Scale

Human-in-the-loop workflows introduce operational concerns that pure automation workflows do not have. Staff-level thinking addresses the governance, SLA, and observability requirements, not just the implementation.

**SLA enforcement requires observable metrics.** The approval workflow tracks `state.Reminders`, but production SLA enforcement requires external observability. Specifically: how many approval requests are currently pending (by approver, by amount tier, by age)? What percentage are approved within the SLA window? How many have been escalated? These metrics require the workflow to publish state changes to a metrics sink or an event stream. A Temporal query API call per workflow instance is not scalable for aggregate reporting. The architecture is: workflow signals a side-effected metric event (or executes a short "publish metrics" activity) on each state change, and a downstream aggregation service maintains the SLA dashboard.

**Approver identity management is a platform concern.** The `approverID = "manager-001"` hardcode in the example is a placeholder. In production, approver routing is driven by an organizational hierarchy service: look up the requester's manager, check the manager's current delegation settings (out-of-office, delegation chain), and route accordingly. This lookup belongs in an activity, not in the workflow function, because it involves an external system call. The activity must be idempotent (the same requester always routes to the same approver for the same request ID, even on retry).

**Delegation and out-of-office handling.** Real approval workflows must handle the case where the designated approver is unavailable. Options: pre-emptive routing to a backup approver before sending the notification, auto-escalation on OOO status (via calendar API integration), or allowing the approver to delegate via the approval UI which sends a reassignment signal. Each option has different workflow design implications. The delegation signal pattern (the approver sends a `delegate-to` signal rather than an `approve/reject` signal) is clean but requires the `SingleLevelApprovalWorkflow` to handle a third signal type and restart its timer for the new approver.

**Multi-level approval as an organizational compliance requirement.** The `MultiLevelApprovalWorkflow` is not just a feature. It is often a compliance requirement. SOX, PCI-DSS, and internal audit requirements specify minimum approval levels for financial transactions above defined thresholds. These thresholds and the approval chain must be versioned: changing them requires a workflow version gate so that in-flight requests are not re-routed mid-approval. The compliance team must sign off on the threshold configuration, and changes to it must be logged with the approving ADR.

**Stuck workflow alerting.** An approval workflow that never receives a signal and whose escalation path is also blocked (escalation target out of office, escalation activity fails) will run indefinitely. Production deployments must include a "stuck workflow" alert: any approval workflow in `PENDING` state for more than 3x its SLA window triggers an incident. This alert is implemented outside Temporal (typically a Temporal API poller or a metrics-based alert on workflow age distribution) and is the operational complement to the code-level SLA enforcement.

**Bar-raiser signal: the candidate designs the approval audit trail.** A bar-raiser probes what happens to the approval record after the workflow completes. The workflow history contains every state transition, but workflow histories are not indexed for compliance queries. The correct answer is that the `RecordDecision` activity writes to an append-only audit table (immutable, with created_at but no updated_at) that is queryable by compliance auditors independently of Temporal. The workflow is the execution engine, and the audit table is the compliance record. Conflating these two concerns is an L4 mistake.

---
