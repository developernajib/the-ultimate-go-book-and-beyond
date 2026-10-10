## Section 6: Production Patterns

### 6.1 Activity Heartbeating for Long-Running Tasks

Long-running activities must send periodic heartbeats to the Temporal server to prove they are still making progress. If heartbeats stop, the server assumes the worker died and reschedules the activity on a different worker. The heartbeat payload also carries checkpoint data that survives retries - when the activity restarts on a new worker, it reads the last checkpoint and resumes from that point instead of starting over.

```go
package activities

import (
	"context"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/workflow"
)

// ProcessLargeDataFile processes a large file with heartbeating to prevent timeout.
func (a *Activities) ProcessLargeDataFile(ctx context.Context, fileURL string, totalRows int) error {
	logger := activity.GetLogger(ctx)

	// Get info about this activity execution (for logging)
	info := activity.GetInfo(ctx)
	logger.Info("Processing file",
		"file", fileURL,
		"attempt", info.Attempt,
		"total_rows", totalRows,
	)

	// Check if we're resuming from a previous attempt
	// HeartbeatDetails carries state across retries
	var processedRows int
	if activity.HasHeartbeatDetails(ctx) {
		if err := activity.GetHeartbeatDetails(ctx, &processedRows); err == nil {
			logger.Info("Resuming from checkpoint", "processed_rows", processedRows)
		}
	}

	// Simulate processing row by row
	batchSize := 1000
	for processedRows < totalRows {
		// Process a batch
		end := processedRows + batchSize
		if end > totalRows {
			end = totalRows
		}

		if err := a.processBatch(ctx, fileURL, processedRows, end); err != nil {
			return err
		}
		processedRows = end

		// Heartbeat: (1) proves liveness to Temporal so it doesn't time out,
		// (2) carries checkpoint so retries can resume
		activity.RecordHeartbeat(ctx, processedRows)

		// Check if workflow was canceled
		select {
		case <-ctx.Done():
			logger.Info("Activity canceled, checkpoint saved", "progress", processedRows)
			return ctx.Err()
		default:
		}
	}

	logger.Info("File processing complete", "rows", processedRows)
	return nil
}

func (a *Activities) processBatch(ctx context.Context, fileURL string, from, to int) error {
	// Simulate batch processing
	time.Sleep(10 * time.Millisecond)
	return nil
}

// ScheduleActivities shows scheduled/cron workflows.
func StartDailyReportWorkflow(c client.Client) error {
	opts := client.StartWorkflowOptions{
		ID:           "daily-report",
		TaskQueue:    TaskQueue,
		// CronSchedule: run daily at midnight UTC
		CronSchedule: "0 0 * * *",
		// Each run gets a 4-hour window
		WorkflowExecutionTimeout: 4 * time.Hour,
	}
	_, err := c.ExecuteWorkflow(context.Background(), opts, DailyReportWorkflow)
	return err
}

// DailyReportWorkflow runs on a schedule and generates reports.
func DailyReportWorkflow(ctx workflow.Context) error {
	info := workflow.GetInfo(ctx)
	workflow.GetLogger(ctx).Info("Running daily report",
		"scheduled_time", info.WorkflowStartTime,
	)

	actOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 3 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, actOpts)

	return workflow.ExecuteActivity(ctx, "GenerateDailyReport",
		info.WorkflowStartTime.Format("2006-01-02")).Get(ctx, nil)
}
```

### 6.2 Child Workflows

Child workflows delegate sub-processes to separate workflow executions, each with its own event history, retry policy, and cancellation scope. This limits blast radius: a failing child can be retried independently without replaying the entire parent. The following example starts multiple child workflows in parallel using a fan-out pattern and collects their results.

```go
package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ParentWorkflow orchestrates multiple child workflows in parallel.
func ParentBulkOrderWorkflow(ctx workflow.Context, orders []OrderInput) ([]OrderResult, error) {
	results := make([]OrderResult, len(orders))
	futures := make([]workflow.Future, len(orders))

	// Start all child workflows concurrently
	for i, order := range orders {
		childOpts := workflow.ChildWorkflowOptions{
			WorkflowID:              fmt.Sprintf("order-%s", order.OrderID),
			WorkflowExecutionTimeout: 24 * time.Hour,
			RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 1},
		}
		childCtx := workflow.WithChildOptions(ctx, childOpts)
		futures[i] = workflow.ExecuteChildWorkflow(childCtx, OrderWorkflow, order)
	}

	// Collect results
	var firstErr error
	for i, future := range futures {
		var result OrderResult
		if err := future.Get(ctx, &result); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			results[i] = OrderResult{
				OrderID: orders[i].OrderID,
				Status:  "failed",
				Message: err.Error(),
			}
		} else {
			results[i] = result
		}
	}

	return results, firstErr
}
```

### Junior -> FAANG: Heartbeating and Child Workflows in Practice

Heartbeating is one of the most commonly skipped Temporal features and one of the most important for production reliability. The prerequisite gap: beginners assume that because Temporal retries activities automatically, a long-running activity that gets stuck will eventually time out and retry. That is only true if `StartToCloseTimeout` is set. But if the activity is making slow progress rather than hanging, you want to distinguish "slow but alive" from "dead." Heartbeating makes that distinction: the activity is alive as long as heartbeats arrive before `HeartbeatTimeout`.

The checkpoint pattern in `ProcessLargeDataFile` is the key production technique. The heartbeat payload carries `processedRows`. On the next retry attempt, `activity.GetHeartbeatDetails` reads the last checkpoint and resumes from that row. Without this, a crashed activity restarts from row 0, causing duplicate processing for already-completed rows. Idempotent processing (row writes use upsert semantics) makes duplicates safe, but restarting from the checkpoint is always faster.

Child workflows are the fan-out primitive. Use them when: each unit of work has its own long-running lifecycle, independent retry policy, or failure isolation requirement. If a child workflow fails and you want to let the other children continue, collect errors without returning early (as shown in `ParentBulkOrderWorkflow`).

Interview habit: when asked "how would you process 10,000 orders in parallel with Temporal?", the answer is a parent workflow that starts 10,000 child workflows (or uses a bounded pool of child workflows) rather than a single workflow that runs 10,000 activities. Child workflows each have their own history, so the parent history stays small.

### Senior @ FAANG: Cron Reliability, Child Workflow Blast Radius, and Session Patterns

**Cron workflow reliability in production.** Temporal's `CronSchedule` option starts a new workflow run at each cron interval. If a run fails, the cron schedule continues on the next interval. If a run takes longer than the cron interval, the next run starts while the current one is still running. This is the default behavior and is correct for most batch jobs (idempotent runs that should not block each other). If you need exclusive execution (next run must wait for the current run to finish), implement a lock via a Continue-As-New pattern or use Temporal Schedules (the newer API that replaces `CronSchedule` and supports pause, backfill, and overlap policies).

**Temporal Schedules as the production replacement for CronSchedule.** Temporal Schedules (generally available in Temporal Server 1.22) offer configurable overlap policies: `Skip` (skip the new run if the previous is still running), `BufferOne` (queue one run), `AllowAll` (allow concurrent runs), and `TerminateOther` (terminate the previous run and start fresh). Schedules also support manual triggers, pausing, backfill (run all missed intervals from a past date), and calendar-based schedules. For any new production cron workflow, use Schedules rather than `CronSchedule`.

**Child workflow blast radius and cancellation scope.** When a parent workflow is canceled, Temporal propagates cancellation to all running child workflows. This is the correct default for most orchestrations. If you need a child workflow to survive its parent's cancellation (e.g., a compensation child that must complete regardless of what happens to the parent), start the child with `workflow.ChildWorkflowOptions{ParentClosePolicy: enums.PARENT_CLOSE_POLICY_ABANDON}`. Be explicit about parent close policy in every child workflow start call. The default policy is terminate-on-parent-close, which is surprising when you expect a long-running child to survive a parent cancellation.

**Session workflows for stateful worker affinity.** The session API (`workflow.RequestSession`) pins a set of activity executions to the same worker. This is required for GPU inference workflows (the model is loaded into GPU memory once and must not be re-loaded on a different worker for each activity), large file download workflows (the file is written to a worker-local temp directory), and interactive workflows that require in-process state across multiple activities. The `MaxConcurrentSessionExecutionSize` worker option caps how many sessions can pin to a given worker simultaneously. Set this based on the resource requirement per session (GPU memory, disk space) rather than the CPU-based concurrency limit.

**Fan-out with bounded concurrency.** The `ParentBulkOrderWorkflow` example starts all child workflows simultaneously. At 10,000 orders that would generate 10,000 history events in the parent workflow before any child completes. For large fan-outs, use a semaphore pattern to start children in batches: maintain an active-count variable, use a channel of completion signals, and start new children only when the active count drops below the batch size. This keeps the parent history size manageable and prevents the Matching service from being overwhelmed by a single burst of 10,000 new workflow tasks.

---
