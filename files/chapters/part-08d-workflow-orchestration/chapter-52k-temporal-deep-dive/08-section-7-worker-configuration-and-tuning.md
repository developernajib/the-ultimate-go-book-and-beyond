## Section 7: Worker Configuration and Tuning

Worker configuration has a direct impact on throughput, latency, and resource consumption. A misconfigured worker is the most common cause of Temporal performance problems in production. The key settings are concurrency limits (how many activities and workflow tasks run simultaneously), stop timeout (how long to drain in-flight work on shutdown), and session configuration (for pinning stateful activities to a single worker). The following code shows a production-ready worker setup with metrics integration.

```go
package worker

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.temporal.io/sdk/client"
	temporalworker "go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/prometheus/client_golang/prometheus"
	"go.temporal.io/sdk/contrib/tally"
	"github.com/uber-go/tally/v4"
)

const (
	TaskQueueOrders = "orders"
	TaskQueueReports = "reports" // Separate queue for high-latency report jobs
)

// WorkerOptions configures the worker for production use.
func buildWorkerOptions(maxConcurrency int) temporalworker.Options {
	return temporalworker.Options{
		// MaxConcurrentActivityExecutionSize caps the number of activities running
		// simultaneously on this worker. Set based on available CPU/memory.
		MaxConcurrentActivityExecutionSize: maxConcurrency,

		// MaxConcurrentWorkflowTaskExecutionSize caps concurrent workflow task handlers.
		// Workflow tasks are CPU-light (replay logic), so this can be higher.
		MaxConcurrentWorkflowTaskExecutionSize: maxConcurrency * 4,

		// MaxConcurrentLocalActivityExecutionSize for local activities (run inline, no
		// round-trip to Temporal server). Use sparingly - their failures don't appear
		// in Temporal Web.
		MaxConcurrentLocalActivityExecutionSize: maxConcurrency / 2,

		// WorkerStopTimeout gives in-flight activities time to complete on shutdown.
		WorkerStopTimeout: 30 * time.Second,

		// EnableSessionWorker allows activities in a session to be pinned to the
		// same worker - required for stateful activities (file processing, GPU).
		EnableSessionWorker: true,

		// MaxConcurrentSessionExecutionSize limits pinned sessions per worker.
		MaxConcurrentSessionExecutionSize: 4,
	}
}

// StartWorker starts a production Temporal worker with graceful shutdown.
func StartWorker(c client.Client, activities *Activities) error {
	opts := buildWorkerOptions(50) // 50 concurrent activities

	w := temporalworker.New(c, TaskQueueOrders, opts)

	// Register all workflow and activity implementations.
	w.RegisterWorkflow(OrderWorkflow)
	w.RegisterWorkflow(ParentBulkOrderWorkflow)
	w.RegisterWorkflow(DailyReportWorkflow)
	w.RegisterActivity(activities)

	// Start the worker.
	if err := w.Start(); err != nil {
		return err
	}

	slog.Info("Temporal worker started", "task_queue", TaskQueueOrders)

	// Wait for shutdown signal.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("Shutting down worker gracefully...")
	w.Stop() // drains in-flight tasks up to WorkerStopTimeout
	return nil
}

// SetupMetrics wires Temporal's built-in metrics to a Prometheus registry.
func SetupMetrics(reg prometheus.Registerer) tally.Scope {
	reporter, err := tally.NewPrometheusReporter(
		tally.PrometheusReporterOptions{
			Registerer: reg,
		},
	)
	if err != nil {
		panic(err)
	}

	scope, _ := tally.NewRootScope(tally.ScopeOptions{
		Prefix:   "temporal",
		Tags:     map[string]string{"service": "order-worker"},
		Reporter: reporter,
	}, 1*time.Second)

	return scope
}

// NewClientWithMetrics creates a Temporal client with metrics and tracing.
func NewClientWithMetrics(hostPort string, metricsScope tally.Scope) (client.Client, error) {
	return client.Dial(client.Options{
		HostPort:  hostPort,
		Namespace: "production",
		MetricsHandler: tally.NewMetricsHandler(metricsScope),
	})
}
```

### Junior -> FAANG: Worker Tuning Is Not Guesswork

The most common first-job mistake with worker configuration is leaving all concurrency settings at their defaults or setting them to arbitrarily large numbers. Defaults are conservative and designed for development, not production. Arbitrarily large numbers cause OOM kills that are harder to diagnose than simply setting the correct values from the start.

The mental model for `MaxConcurrentActivityExecutionSize`: how much memory does one activity execution consume at peak? Multiply that by the concurrency limit you want to set. Add the base worker process memory. That total must fit within the container memory limit with room for GC overhead (typically 25% headroom). If a single activity execution loads a 10MB file, 100 concurrent executions hold 1GB of file data in-flight. A container with 1.5GB memory limit will OOM before reaching 100 concurrent activities.

`MaxConcurrentWorkflowTaskExecutionSize` can be set much higher than activity concurrency because workflow tasks are CPU-light. They replay deterministic logic and record decisions. They do not hold large in-memory payloads. A ratio of 4:1 (workflow tasks to activities) is a reasonable starting point.

`WorkerStopTimeout` must be at least as long as your longest expected activity duration. If an activity processes a 10-minute batch job and `WorkerStopTimeout` is 30 seconds, every in-progress batch is abandoned on shutdown, retried on another worker, and the work is duplicated. Set it to the p99 activity duration plus a safety buffer.

Interview habit: when asked about worker tuning, anchor your answer on profiling actual memory and CPU usage rather than intuition. Then describe how you would use Temporal's SDK metrics (`worker_task_slots_available`, `task_schedule_to_start_latency`) to confirm the configuration is correct in production.

### Senior @ FAANG: Worker Fleet Sizing, Auto-scaling, and Task Queue Design

**Task queue design as a first-class architectural decision.** All workers registered on the same task queue compete for the same tasks. Mixing fast activities (sub-second) with slow activities (minutes) on the same task queue means slow activities can starve fast ones if the worker concurrency limit is reached. The production pattern is to use separate task queues by activity latency class: `orders-fast` for sub-second operations, `orders-batch` for multi-minute operations, and `orders-reports` for long-running report generation. Each task queue has its own worker fleet sized for its latency class.

**Auto-scaling workers on Kubernetes.** Worker pods should scale based on task queue backlog, not CPU utilization. Temporal's SDK metrics expose `temporal_task_queue_poll_success_rate` and `temporal_task_schedule_to_start_latency`. When schedule-to-start latency rises above a threshold (typically 2 seconds for fast workflows), it signals that the worker pool is insufficient for the current load. A Kubernetes HPA configured against a custom metric adapter that reads this Prometheus metric scales the worker deployment up before the backlog grows large. Scale-down should be conservative: use a slow scale-down policy (minimum 10-minute cooldown) to avoid thrashing during bursty load patterns.

**Local activities: when and why.** Local activities execute in the workflow worker process without a round-trip to the Temporal server for scheduling. They are useful for very fast operations (under 1 second) where the scheduling round-trip would add more latency than the operation itself. Local activity failures are retried locally without appearing in the event history until they either succeed or exhaust retries. The tradeoff: local activities do not appear in the Temporal Web UI event history during execution, making them harder to debug. They also run in the workflow task goroutine, meaning they block the workflow from processing other tasks while running. Use them sparingly for genuinely latency-sensitive operations (UUID generation, local cache lookups, lightweight transformations).

**Connection pool sizing for the Temporal client.** Each Temporal client uses a gRPC connection pool to communicate with the Frontend service. The default pool size is adequate for development but insufficient for high-throughput production workers that are starting thousands of workflows per second. Configure the gRPC connection pool size via `client.Options.ConnectionOptions` to match the expected throughput. A pool that is too small causes gRPC request queuing inside the client, adding latency that appears as increased schedule-to-start times. Monitor the gRPC connection pool utilization metric alongside Temporal SDK metrics.

**Worker versioning in multi-service deployments.** In a service mesh where multiple services each run their own Temporal workers on different task queues, worker versioning (Build IDs) must be coordinated at the deployment pipeline level. The pipeline deploys new workers, registers the new Build ID as the default, and only then retires old workers. If two services share a task queue (which is an anti-pattern but occurs in practice), their Build ID registrations must be coordinated to prevent routing conflicts. The correct governance rule: one task queue per service, one service owns each task queue, and Build ID registration happens through that service's deployment pipeline.

---
