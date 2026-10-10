## 6. Dynamic Parallel Child Workflows

When processing large datasets, a single workflow with many parallel activities can hit Temporal's history size limits. Child workflows solve this by giving each unit of work its own execution history. A parent workflow discovers partitions (e.g., segments of a database table or files in an S3 bucket), spawns a child workflow per partition, and aggregates results after all children complete.

Concurrency control is critical here. Launching 1,000 child workflows simultaneously can overwhelm the Temporal cluster. The `ConcurrencyControlledFanOut` function at the end of this section uses a `workflow.Selector` to maintain a sliding window of in-flight work: it starts up to `maxConcurrent` activities, waits for any one to complete, then launches the next item. This keeps cluster load predictable regardless of total item count.

Each child workflow has its own retry policy and timeout, isolating partition failures from each other. If partition 7 out of 10 fails after retries, the parent can report a partial result rather than failing the entire job.

```go
package childworkflows

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// DataPartition represents a partition of data to process
type DataPartition struct {
	PartitionID int
	StartOffset int64
	EndOffset   int64
	Source      string
}

// PartitionResult represents results from processing one partition
type PartitionResult struct {
	PartitionID    int
	RecordsRead    int
	RecordsWritten int
	Errors         int
	Duration       time.Duration
}

// AggregatedResult represents the combined results from all partitions
type AggregatedResult struct {
	TotalRecordsRead    int
	TotalRecordsWritten int
	TotalErrors         int
	PartitionResults    []PartitionResult
	Duration            time.Duration
}

// PartitionActivities handles data partitioning operations
type PartitionActivities struct{}

// DiscoverPartitions analyzes the data source and returns partitions
func (a *PartitionActivities) DiscoverPartitions(ctx context.Context, source string) ([]DataPartition, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Discovering partitions", "source", source)

	// In reality, analyze S3 bucket, Kafka topic, database table etc.
	partitions := make([]DataPartition, 0, 10)
	const totalRecords = 10_000_000
	const partitionSize = 1_000_000

	for i := 0; i < totalRecords/partitionSize; i++ {
		partitions = append(partitions, DataPartition{
			PartitionID: i,
			StartOffset: int64(i * partitionSize),
			EndOffset:   int64((i + 1) * partitionSize),
			Source:      source,
		})
	}

	return partitions, nil
}

// ProcessPartition processes a single data partition
func (a *PartitionActivities) ProcessPartition(ctx context.Context, partition DataPartition) (PartitionResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Processing partition",
		"partitionID", partition.PartitionID,
		"start", partition.StartOffset,
		"end", partition.EndOffset)

	start := time.Now()

	// Simulate processing with heartbeating for long operations
	recordsPerHeartbeat := int64(100_000)
	records := partition.EndOffset - partition.StartOffset

	for processed := int64(0); processed < records; processed += recordsPerHeartbeat {
		// Do actual work here
		time.Sleep(10 * time.Millisecond)

		// Heartbeat with progress
		activity.RecordHeartbeat(ctx, fmt.Sprintf(
			"partition %d: %d/%d records",
			partition.PartitionID, processed, records,
		))
	}

	return PartitionResult{
		PartitionID:    partition.PartitionID,
		RecordsRead:    int(records),
		RecordsWritten: int(records),
		Errors:         0,
		Duration:       time.Since(start),
	}, nil
}

// PartitionWorkflow processes a single partition
func PartitionWorkflow(ctx workflow.Context, partition DataPartition) (PartitionResult, error) {
	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Hour,
		HeartbeatTimeout:    1 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 5 * time.Second,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	var result PartitionResult
	err := workflow.ExecuteActivity(ctx,
		(*PartitionActivities)(nil).ProcessPartition, partition).Get(ctx, &result)
	return result, err
}

// MapReduceWorkflow orchestrates large-scale data processing
func MapReduceWorkflow(ctx workflow.Context, source string) (AggregatedResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting map-reduce workflow", "source", source)

	startTime := workflow.Now(ctx)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// Map phase: discover partitions
	var partitions []DataPartition
	if err := workflow.ExecuteActivity(ctx,
		(*PartitionActivities)(nil).DiscoverPartitions, source).Get(ctx, &partitions); err != nil {
		return AggregatedResult{}, fmt.Errorf("partition discovery failed: %w", err)
	}

	logger.Info("Partitions discovered", "count", len(partitions))

	// Fan-out: spawn child workflows for each partition
	results := make([]PartitionResult, len(partitions))

	// Launch child workflows in parallel
	type childFuture struct {
		idx    int
		future workflow.ChildWorkflowFuture
	}

	futures := make([]childFuture, 0, len(partitions))

	for i, partition := range partitions {
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID:               fmt.Sprintf("%s-partition-%d", workflow.GetInfo(ctx).WorkflowExecution.ID, i),
			WorkflowExecutionTimeout: 3 * time.Hour,
			RetryPolicy: &temporal.RetryPolicy{
				MaximumAttempts: 2,
			},
		})

		future := workflow.ExecuteChildWorkflow(childCtx, PartitionWorkflow, partition)
		futures = append(futures, childFuture{idx: i, future: future})
	}

	// Collect results
	var aggregated AggregatedResult

	for _, cf := range futures {
		var result PartitionResult
		if err := cf.future.Get(ctx, &result); err != nil {
			logger.Error("Partition workflow failed",
				"partitionIdx", cf.idx, "error", err)
			// Continue collecting other results
			aggregated.TotalErrors++
		} else {
			results[cf.idx] = result
			aggregated.TotalRecordsRead += result.RecordsRead
			aggregated.TotalRecordsWritten += result.RecordsWritten
			aggregated.TotalErrors += result.Errors
		}
	}

	aggregated.PartitionResults = results
	aggregated.Duration = workflow.Now(ctx).Sub(startTime)

	logger.Info("Map-reduce completed",
		"totalRead", aggregated.TotalRecordsRead,
		"totalWritten", aggregated.TotalRecordsWritten,
		"duration", aggregated.Duration)

	return aggregated, nil
}

// ConcurrencyControlledFanOut uses selector for proper concurrency control
func ConcurrencyControlledFanOut(ctx workflow.Context, items []string, maxConcurrent int) ([]string, error) {
	logger := workflow.GetLogger(ctx)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	results := make([]string, len(items))
	inFlight := 0
	nextItem := 0

	selector := workflow.NewSelector(ctx)

	type futureItem struct {
		idx    int
		future workflow.Future
	}

	// Launch initial batch
	for nextItem < len(items) && inFlight < maxConcurrent {
		idx := nextItem
		item := items[idx]
		f := workflow.ExecuteActivity(ctx, ProcessItemConcurrentActivity, item)

		finalIdx := idx
		selector.AddFuture(f, func(f workflow.Future) {
			var result string
			if err := f.Get(ctx, &result); err != nil {
				logger.Error("Item processing failed", "idx", finalIdx, "error", err)
			} else {
				results[finalIdx] = result
			}
			inFlight--
		})

		inFlight++
		nextItem++
	}

	// Process remaining items as slots open up
	for inFlight > 0 {
		selector.Select(ctx)

		// Launch next item if available
		for nextItem < len(items) && inFlight < maxConcurrent {
			idx := nextItem
			item := items[idx]
			f := workflow.ExecuteActivity(ctx, ProcessItemConcurrentActivity, item)

			finalIdx := idx
			selector.AddFuture(f, func(f workflow.Future) {
				var result string
				if err := f.Get(ctx, &result); err != nil {
					logger.Error("Item processing failed", "idx", finalIdx, "error", err)
				} else {
					results[finalIdx] = result
				}
				inFlight--
			})

			inFlight++
			nextItem++
		}
	}

	return results, nil
}

func ProcessItemConcurrentActivity(ctx context.Context, item string) (string, error) {
	return fmt.Sprintf("result:%s", item), nil
}
```

### Junior → FAANG: Child Workflows and the History Limit Problem

Child workflows are the answer to a specific problem: a parent workflow needs to parallelize work, but the total amount of work is large enough that putting all of it in one workflow's history would exceed Temporal's limits. If you do not know the history limit is a constraint, you will reach for activity fan-out by default, which works until it does not.

**When to use child workflows instead of activities.** Use child workflows when: the work per item is long-running (more than a few minutes), each item needs its own retry policy, you need to cancel individual items independently, or the total number of items is large enough that all their history events in a single workflow would approach the 50,000-event limit. Use activities when the items are short-lived and you do not need per-item cancellation or independent versioning.

**Child workflow IDs must be deterministic and unique.** The example uses `fmt.Sprintf("%s-partition-%d", parentID, i)` as the child workflow ID. This ensures that if the parent workflow replays, it generates the same child workflow ID and Temporal deduplicates the start request (the child was already started, so no duplicate is created). Using a random UUID as the child ID would cause a new child to be started on every replay, producing a bug that is extremely difficult to debug.

**The concurrency-controlled fan-out is a fundamental pattern.** The selector-based sliding window in `ConcurrencyControlledFanOut` is the correct implementation. Common wrong implementations: using a Go channel as a semaphore (not deterministic in a workflow), launching all items at once with no limit (overwhelming the cluster), or using a fixed-size batch loop (which blocks until each batch finishes rather than maintaining a sliding window of in-flight work).

**Partial failure in map-reduce.** The `MapReduceWorkflow` continues collecting results even when some partition workflows fail, incrementing `TotalErrors` rather than returning an error immediately. This is the correct behavior for batch processing: report the aggregate result including errors, rather than failing the entire job because one partition had a problem. The caller can then decide whether the error rate is acceptable.

### Senior @ FAANG: Child Workflow Architecture, Cluster Impact, and Versioning Independence

Child workflows introduce new dimensions of complexity at scale: they can outlive their parents, they can be versioned independently, and their combined metadata overhead can affect cluster performance. Staff-level design addresses each of these.

**Parent-child lifecycle options.** The default parent close policy terminates child workflows when the parent terminates. Set `ParentClosePolicy` to `ABANDON` when you need fire-and-forget fan-out: the parent starts children and completes, and children run to completion independently. Set it to `REQUEST_CANCEL` when you want graceful cancellation of in-flight children when the parent is canceled. The choice has significant operational implications: abandoned child workflows must be independently monitored for failures, since no parent exists to aggregate their results.

**Independent versioning of child workflows.** A child workflow function can be updated (with its own `GetVersion` gate) without updating the parent. This is the primary architectural advantage of child workflows over activity-based fan-out: the work unit can evolve independently. At the team boundary level, this means the team that owns partition processing can deploy changes to `PartitionWorkflow` without coordinating with the team that owns `MapReduceWorkflow`. Document this independent versioning contract explicitly: which team owns which workflow function, and what is the interface contract between them (input/output types, SLA, error semantics).

**Cluster metadata overhead at scale.** Each child workflow execution has metadata: workflow ID, run ID, search attributes, and associated history storage. At 10,000 child workflows per parent job, this is 10,000 distinct executions in Temporal's visibility store. At 100 parent jobs running simultaneously, this is 1,000,000 execution records. The Temporal visibility store (typically Elasticsearch or Cassandra) must be sized for this query load. This is a capacity planning concern, not a code concern, but staff engineers raising the Temporal adoption proposal must include it in the infrastructure sizing.

**Graceful shutdown of long-running partition workflows.** When a `PartitionWorkflow` runs for hours and a deployment is needed, the worker receiving the partition activity must complete the current heartbeat interval, save progress to the heartbeat payload, and allow Temporal to reschedule the activity on a new worker. If the shutdown is not graceful (the worker process is killed mid-activity), Temporal detects the missing heartbeat after `HeartbeatTimeout` and reschedules. The activity then resumes from the last heartbeat offset. This is correct only if the activity reads and resumes from the heartbeat payload, which requires explicit implementation in the `ProcessPartition` function.

**Hierarchical orchestration for petabyte-scale processing.** The two-level hierarchy (parent discovers partitions, children process partitions) scales to tens of millions of records. For petabyte-scale jobs, a three-level hierarchy is appropriate: a root workflow discovers shards, shard workflows discover partitions within each shard, partition workflows process individual files or table segments. Each level adds independent history bounding, independent retry scoping, and independent failure isolation. The cost is increased metadata overhead and more complex aggregate result collection at the root. Design the hierarchy depth based on the actual data volume and failure isolation requirements, not arbitrarily.

**ADR: maximum child workflow concurrency as a cluster policy.** The `maxConcurrent` parameter in `ConcurrencyControlledFanOut` is a key tuning knob. The correct value is derived from: available worker capacity (number of workers times concurrency slots per worker), cluster throughput limits (task dispatch rate), and the desired latency for the parent workflow. This calculation belongs in a platform capacity document, and the concurrency value should be configurable per environment (lower in staging, higher in production) rather than hardcoded.

---
