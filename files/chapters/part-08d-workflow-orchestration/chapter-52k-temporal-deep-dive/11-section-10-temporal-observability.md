## Section 10: Temporal Observability

### 10.1 Structured Workflow Logging

Logging inside Temporal workflows requires the SDK's workflow logger rather than a standard logger. During replay, workflow code re-executes but the replay-safe logger suppresses duplicate log lines. The following code uses `workflow.GetLogger` with structured key-value pairs that automatically include workflow ID and run ID.

```go
package orderworkflow

import (
	"go.temporal.io/sdk/workflow"
)

// OrderWorkflowWithLogging demonstrates structured logging inside workflows.
// workflow.GetLogger returns a determinism-safe logger that includes the
// workflow ID, run ID, and current event ID automatically.
func OrderWorkflowWithLogging(ctx workflow.Context, input OrderInput) (OrderResult, error) {
	logger := workflow.GetLogger(ctx)

	// Log at key state transitions.
	logger.Info("Order workflow started",
		"order_id", input.OrderID,
		"customer_id", input.CustomerID,
		"item_count", len(input.Items),
	)

	actCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	})

	var inventoryResult InventoryResult
	if err := workflow.ExecuteActivity(actCtx, "ReserveInventory", input.Items).Get(ctx, &inventoryResult); err != nil {
		logger.Error("Inventory reservation failed",
			"order_id", input.OrderID,
			"error", err,
		)
		return OrderResult{}, err
	}

	logger.Info("Inventory reserved",
		"order_id", input.OrderID,
		"reservation_id", inventoryResult.ReservationID,
	)

	// ... rest of workflow ...

	logger.Info("Order completed successfully", "order_id", input.OrderID)
	return OrderResult{OrderID: input.OrderID, Status: "completed"}, nil
}
```

### 10.2 Temporal Metrics - What to Monitor

Temporal exposes Prometheus metrics for workflow latency, activity failure rates, task queue backlogs, and worker slot utilization. The following table lists the critical metrics to monitor and their alert thresholds.

```
┌───────────────────────────────────────────────────────────────────┐
│                  Key Temporal Metrics to Monitor                  │
│                                                                   │
│  Metric                            Alert Threshold                │
│  ──────────────────────────────    ─────────────────────────      │
│  temporal_workflow_completed_total  Rate drop > 20% from baseline │
│  temporal_workflow_failed_total     Rate > 0.1% of completions    │
│  temporal_activity_error_total      Rate > 1% of executions       │
│  temporal_task_queue_poll_success_  Rate drop → no workers alive  │
│  temporal_task_schedule_to_start_   p99 > 2s → task queue backlog │
│  temporal_workflow_task_schedule_   p99 > 500ms → worker overload │
│  temporal_worker_task_slots_avail   < 20% → add workers           │
│                                                                   │
│  Prometheus scrape config (temporal SDK >= 1.23 auto-exports):    │
│  - Host: <worker-host>:9090/metrics                               │
│  - Labels: namespace, task_queue, worker_type, workflow_type      │
│                                                                   │
│  Temporal Web UI:                                                 │
│  - localhost:8080 (local) / cloud.temporal.io (Temporal Cloud)    │
│  - Shows: running, completed, failed workflows                    │
│  - Event history viewer for debugging stuck workflows             │
│  - Task queue inspection: pending tasks, pollers, backlog         │
└───────────────────────────────────────────────────────────────────┘
```

### 10.3 Debugging a Stuck Workflow

A workflow that stops progressing without returning an error is one of the hardest Temporal problems to diagnose. The history may show all activities completing successfully while the workflow is blocked on an unresolved future or waiting for a signal that never arrives. The following code provides programmatic tools for inspecting workflow history, terminating stuck executions, and resetting workflows to a previous event to replay from a known-good state.

```go
// When a workflow gets stuck - not progressing, no activity running  - 
// you can terminate it, reset it to a previous state, or inspect its history.

package debug

import (
	"context"
	"fmt"

	"go.temporal.io/sdk/client"
	"go.temporal.io/api/enums/v1"
)

// InspectWorkflow prints the last N events of a workflow's history.
// Equivalent of "tctl wf desc" but programmatic.
func InspectWorkflow(c client.Client, workflowID, runID string, lastN int) error {
	iter := c.GetWorkflowHistory(context.Background(), workflowID, runID, false,
		enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)

	var events []string
	for iter.HasNext() {
		event, err := iter.Next()
		if err != nil {
			return err
		}
		events = append(events, fmt.Sprintf("[%d] %s", event.EventId, event.EventType))
	}

	// Print last N events.
	start := 0
	if len(events) > lastN {
		start = len(events) - lastN
	}
	for _, e := range events[start:] {
		fmt.Println(e)
	}
	return nil
}

// TerminateStuckWorkflow forcefully terminates a workflow, bypassing cleanup.
// Use only as a last resort - Reset is usually better.
func TerminateStuckWorkflow(c client.Client, workflowID, reason string) error {
	return c.TerminateWorkflow(context.Background(), workflowID, "", reason)
}

// ResetWorkflow resets a workflow to a specific event ID, re-running from that point.
// Used to recover from bugs without losing the workflow entirely.
func ResetWorkflow(c client.Client, workflowID, runID string, eventID int64) (string, error) {
	resp, err := c.ResetWorkflowExecution(context.Background(),
		&workflowservice.ResetWorkflowExecutionRequest{
			Namespace: "production",
			WorkflowExecution: &commonpb.WorkflowExecution{
				WorkflowId: workflowID,
				RunId:      runID,
			},
			Reason:                    "bug fix in activity implementation",
			WorkflowTaskFinishEventId: eventID,
			RequestId:                 uuid.New().String(),
		},
	)
	if err != nil {
		return "", fmt.Errorf("reset workflow: %w", err)
	}
	return resp.RunId, nil
}
```

### Junior -> FAANG: The Three Observability Questions You Must Answer

Temporal observability is not about collecting metrics for their own sake. It is about being able to answer three operational questions at any time: Is the system processing work? Is it processing work fast enough? Why is a specific workflow stuck?

The first question is answered by `temporal_workflow_completed_total` rate. If that rate drops unexpectedly, something is wrong. The second question is answered by `temporal_task_schedule_to_start_latency`: if p99 rises above 2 seconds, workers are not keeping up with the task queue backlog. The third question is answered by the event history viewer in the Temporal Web UI.

The `InspectWorkflow` function in the code above is the programmatic version of the Web UI event history viewer. It lets you answer "what is this workflow waiting for?" without leaving your terminal. On call engineers who know how to use this function diagnose stuck workflows in minutes rather than hours.

First-job habit: learn the Temporal Web UI before you write your first workflow. The UI shows event history, pending activities, search attribute values, and task queue polling status. It is the primary diagnostic tool for Temporal and it is free and available locally via `docker compose up`.

Interview habit: when asked "how would you debug a workflow that stopped progressing?", the correct sequence is: check the Web UI for the last event in history, check whether any activities are pending (scheduled but not started), check the task queue poller count, and then look at worker logs for the relevant run ID.

### Senior @ FAANG: Metrics, Tracing, and Incident Response Playbooks

**Correlation IDs across workflow and activity boundaries.** Temporal assigns a workflow ID, run ID, and activity ID to every execution. These IDs must flow into every log line emitted by workflow and activity code. The `workflow.GetLogger(ctx)` call automatically injects workflow ID and run ID into structured log fields. For activities, `activity.GetLogger(ctx)` injects activity ID and attempt number. When tracing spans are created inside activities, attach the workflow ID as a span attribute. This enables end-to-end trace reconstruction across a workflow execution spanning multiple activities and multiple workers, with every log line and span linkable by workflow ID.

**Alerting hierarchy for production Temporal.** Tier 1 (page immediately): workflow completed rate drops more than 20% from a 1-hour baseline, or activity error rate exceeds 1% of executions for a critical task queue. Tier 2 (alert but do not page): schedule-to-start latency p99 exceeds 5 seconds (backlog building but not yet critical), worker task slots available below 10% (capacity warning). Tier 3 (dashboard only): heartbeat timeout rate, history size p99, Continue-As-New rate. Each alert should link to a runbook that covers the three most likely causes and the first remediation steps.

**Runbook: task queue backlog.** Step 1: check poller count in the Temporal Web UI. If zero, workers are not running. Step 2: if pollers exist, check `worker_task_slots_available`. If near zero, workers are at capacity. Add workers or raise `MaxConcurrentActivityExecutionSize` if memory allows. Step 3: if workers have available slots, check whether the backlog consists of a specific activity type. If so, that activity type may be slow or blocked on an external service. Check activity latency breakdown. Step 4: if the backlog is uneven across task queues, check whether a task queue naming bug caused activities to be routed to the wrong queue.

**Runbook: stuck workflow.** Step 1: retrieve the last 10 events using `InspectWorkflow`. The last event type reveals what the workflow is waiting for: `ActivityTaskScheduled` means the activity has not been picked up (task queue issue), `ActivityTaskStarted` means the activity is running but has not completed (activity issue or heartbeat timeout), `WorkflowTaskScheduled` means no worker is polling. Step 2: if the workflow is stuck at an activity, check whether the activity is heartbeating. Step 3: if the activity is hung indefinitely, use `TerminateStuckWorkflow` as a last resort only after checking whether compensation is needed. Step 4: if the workflow has a bug (wrong version gate, missing signal handler), use `ResetWorkflow` to a point before the bug and re-run with the fixed code.

**Distributed tracing integration.** Temporal SDK 1.20+ supports OpenTelemetry trace propagation across workflow and activity boundaries. The trace context is embedded in the workflow and activity headers and extracted on the receiving worker. This means a single distributed trace can span the entire lifecycle of a workflow execution, including all activities, even when they run on different worker processes at different times. Configure the OTEL exporter in the Temporal client options and every workflow start and activity execution automatically creates child spans. This is the highest-signal observability investment for complex orchestration systems because it eliminates the gap between "workflow started" and "workflow completed" in the trace view.

---
