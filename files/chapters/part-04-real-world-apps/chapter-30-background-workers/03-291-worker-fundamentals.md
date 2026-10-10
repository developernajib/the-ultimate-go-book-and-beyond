## 30.1 Worker Fundamentals

### Basic Worker Pattern

A background worker goroutine sits in a loop, pulling jobs from a channel and processing them one at a time. The `Job` interface defines a single `Process` method, so any struct that satisfies it can flow through the same worker pipeline. Context propagation lets the caller cancel in-flight work during shutdown, and a `sync.WaitGroup` tracks when all workers have drained.

```go
package worker

import (
    "context"
    "log/slog"
    "sync"
)

type Job interface {
    Process(ctx context.Context) error
}

type Worker struct {
    id       int
    jobs     <-chan Job
    logger   *slog.Logger
    wg       *sync.WaitGroup
}

func NewWorker(id int, jobs <-chan Job, logger *slog.Logger, wg *sync.WaitGroup) *Worker {
    return &Worker{
        id:     id,
        jobs:   jobs,
        logger: logger,
        wg:     wg,
    }
}

func (w *Worker) Start(ctx context.Context) {
    w.wg.Add(1)
    go func() {
        defer w.wg.Done()
        w.logger.Info("worker started", "worker_id", w.id)

        for {
            select {
            case <-ctx.Done():
                w.logger.Info("worker stopping", "worker_id", w.id)
                return
            case job, ok := <-w.jobs:
                if !ok {
                    w.logger.Info("job channel closed", "worker_id", w.id)
                    return
                }
                w.processJob(ctx, job)
            }
        }
    }()
}

func (w *Worker) processJob(ctx context.Context, job Job) {
    w.logger.Debug("processing job", "worker_id", w.id)

    if err := job.Process(ctx); err != nil {
        w.logger.Error("job failed",
            "worker_id", w.id,
            "error", err,
        )
    } else {
        w.logger.Debug("job completed", "worker_id", w.id)
    }
}
```

### Worker Pool

A worker pool bounds concurrency by pre-allocating a fixed number of goroutines that pull tasks from a shared channel. This prevents unbounded goroutine growth when task submission outpaces completion, which would exhaust memory under load.

```go
package worker

import (
    "context"
    "log/slog"
    "sync"
)

type Pool struct {
    workers  []*Worker
    jobs     chan Job
    logger   *slog.Logger
    wg       sync.WaitGroup
    size     int
    queueLen int
}

type PoolConfig struct {
    Size       int
    QueueSize  int
    Logger     *slog.Logger
}

func NewPool(config PoolConfig) *Pool {
    return &Pool{
        workers:  make([]*Worker, config.Size),
        jobs:     make(chan Job, config.QueueSize),
        logger:   config.Logger,
        size:     config.Size,
        queueLen: config.QueueSize,
    }
}

func (p *Pool) Start(ctx context.Context) {
    for i := 0; i < p.size; i++ {
        worker := NewWorker(i, p.jobs, p.logger, &p.wg)
        p.workers[i] = worker
        worker.Start(ctx)
    }
    p.logger.Info("worker pool started", "size", p.size)
}

func (p *Pool) Submit(job Job) bool {
    select {
    case p.jobs <- job:
        return true
    default:
        return false // Queue full
    }
}

func (p *Pool) SubmitWait(ctx context.Context, job Job) error {
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (p *Pool) Stop() {
    close(p.jobs)
    p.wg.Wait()
    p.logger.Info("worker pool stopped")
}

func (p *Pool) QueueSize() int {
    return len(p.jobs)
}
```

### Junior to FAANG: what the textbook pool gets wrong in production

The pool above is a correct first draft and a wrong last draft. Six issues that you will discover in your first incident.

1. **In-memory channel means jobs die on restart.** The buffered channel holds jobs in process memory. On SIGTERM, the process dies and whatever was in the channel is lost. Production fix is to stop accepting new submissions, close the channel after the queue drains, or (better) make the channel a cache in front of durable storage. Your first move is durable storage (Postgres, Redis, SQS), and the channel becomes a local prefetch buffer.

2. **`Submit` returning a bool silently drops jobs.** `return false // Queue full` means the caller has to remember to handle the failure. They will not. Add a metric `queue_submit_dropped_total` and alert on it above zero. At staff level, prefer `SubmitWait` with a tight deadline so callers experience backpressure as latency rather than silent loss.

3. **No panic recovery.** If `job.Process` panics, the worker goroutine dies and the pool silently shrinks. Wrap `processJob` in a deferred recover that logs the panic, increments a counter, and returns. The worker loop continues.

4. **No per-job timeout.** A runaway job can hold a worker slot forever. Wrap `job.Process(ctx)` with `ctx, cancel := context.WithTimeout(ctx, jobTimeout)` using a per-job-type timeout.

5. **Shutdown is half-graceful.** `close(p.jobs)` followed by `p.wg.Wait()` finishes inflight jobs but ignores ctx. If shutdown takes longer than the orchestrator's grace period, the process is killed mid-job. Add a bounded-wait pattern. `select` on `wg done` versus `time.After(graceDeadline)`.

6. **No observability.** Add `jobs_started_total`, `jobs_completed_total`, `jobs_failed_total`, `jobs_duration_seconds` histogram, and `queue_depth` gauge. Tag by job_type and handler version. Without these, every incident becomes detective work.

Worked example of the shutdown bug. Kubernetes sends SIGTERM. Your process catches it and cancels ctx. Workers in `select` see `ctx.Done()` and exit. The jobs still in the channel are never drained. Those jobs were never persisted. They are lost. Fix is, treat the in-memory channel as a prefetch cache, persist at enqueue, and on SIGTERM push unacked local jobs back to the storage layer before exit.

Interview entry point. "What is wrong with this worker pool". The expected answer covers persistence, panic recovery, backpressure semantics, shutdown determinism, and metrics. A junior who names three of five is hireable. Naming all five suggests prior production experience.

### Senior at FAANG: evolving the pool into a platform SDK

At staff level, this code is not a pool. It is a prototype for a platform SDK that dozens of teams will depend on. The engineering work is almost entirely in the contract and the middleware pipeline.

**Handler contract.** The `Process(ctx) error` signature is too loose. A platform handler signature is:

```go
type Handler[P any] func(ctx context.Context, job *Job[P]) Result

type Result struct {
    Status     Status        // Success, RetryableFailure, PermanentFailure
    Retry      *RetryHint    // override platform policy for this execution
    Observation Observation  // structured metadata to emit
}
```

This encodes three platform requirements. Success and failure are typed (not an untyped error). Handlers can signal "do not retry" for permanent failures (bad input). Handlers can report observation data the platform should emit uniformly.

**Middleware pipeline.** Handlers must run through an ordered chain.

1. Trace extraction (propagate OTel context from enqueue to execution).
2. Tenant extraction and authorization.
3. Rate limiter by tenant and job_type.
4. Idempotency-key check (skip if already processed).
5. Timeout enforcement.
6. Panic recovery with stack capture to error tracking.
7. Metrics and logging.
8. Handler invocation.
9. Outcome recording (success, retry scheduling, DLQ routing).

Every layer is mandatory and non-overridable by handler authors. This is the single biggest lever for platform reliability. At Google, the standard Stubby client and server wrappers enforce this kind of layering, and at Amazon the internal Coral framework plays the same role. Handler authors never touch retry logic directly.

**Prefetch and lease.** A production pool does not pull one job at a time. It prefetches a batch (tuned to handler P99 latency divided by round-trip-to-storage) and holds leases on those jobs. Lease renewal is a background goroutine per worker that heartbeats every `lease_duration / 3`. This reduces storage round-trips by 10x and makes shutdown trivial. On SIGTERM, release leases back to storage atomically, no ack needed.

**Worker capability model.** One worker process should run many job_types with different concurrency limits. The pool needs a concurrency matrix, job_type to max-concurrent. Otherwise a slow job_type (image resize at 30s per job) starves a fast job_type (send email at 100ms per job) that happens to share the pool. asynq implements this as per-queue concurrency. river implements it as worker-function concurrency. Your platform SDK must.

**Graceful drain protocol.** At FAANG scale, the drain protocol is specified precisely.

- On SIGTERM, set `draining = true`. New prefetches are disabled.
- Cancel the prefetch goroutine. It returns leases for unprocessed prefetched jobs to storage.
- Inflight handlers continue with their original ctx (not canceled yet).
- At `graceDeadline - 10s`, cancel the handler ctx. Well-behaved handlers checkpoint and return. Their lease expires naturally.
- At `graceDeadline`, exit. Remaining handlers are killed.

The 10-second slack is the handler's opportunity to checkpoint. Platform contract says handlers must respect ctx cancellation within 10s or they are out of compliance.

**Observability contract.** Every handler execution emits a span with attributes: job_type, job_id, tenant, attempt, handler_version, queue_lag_seconds, handler_duration_seconds, outcome, retry_reason (if applicable). These feed three dashboards auto-generated per job_type. SLO dashboard, error dashboard, throughput dashboard. Alerts are wired via burn-rate (multi-window multi-burn-rate) on the SLO dashboard.

**Multi-tenant fairness.** The naive shared channel is not fair. A tenant dumping 10M jobs fills the prefetch buffer and starves others. Solution is a two-level scheduler. The outer scheduler picks a tenant using weighted fair queueing (tenant weights set by admin via config). The inner scheduler picks a job from that tenant's queue. asynq has no built-in fairness. river has no built-in fairness. Temporal has per-task-queue partitioning which approximates it. At FAANG scale, you build fairness into your platform layer because the open-source options do not provide it.

**Capacity planning.** A staff engineer does capacity math before shipping. Given a pool of N workers with handler P95 of T seconds, steady-state throughput is `N / T` jobs per second per process. To handle burst of B jobs per second with queue SLO of L seconds lag, you need `max(steady_state_N, B * T + queue_absorption_margin)` workers. The margin accounts for handler tail-latency variance, usually sized at 2x the P99/P50 ratio.

**Pool as Kubernetes workload.** The pool process becomes a Deployment, autoscaled by KEDA on oldest-message-age. The tuning is non-trivial. Scale up threshold should be well below the SLO to allow scaling time. Scale down threshold should have a cooldown to avoid flapping. Pod disruption budgets ensure at least N pods during voluntary disruption. Pod anti-affinity spreads across zones. None of this is in the textbook pool but all of it is required in production.

### The Backwards Worker Pool: Pull-Oriented Dispatcher

A standard worker pool has $N$ workers contending on a single shared buffered channel (`<-p.jobs`). Under heterogeneous workloads where execution times vary from 2ms to 5 seconds, this topology introduces head-of-line blocking and channel lock contention, as explored by [Yaninyz witty (August 2026), "Most Go Worker Pools are built backwards"](https://medium.com/@yaninyzwitty/most-go-worker-pools-are-built-backwards-7e9b015e5d32) and [Erwin Hermanto (July 2026), "Writing a Production-Ready Worker Pool in Go"](https://medium.com/@erwinhermanto/writing-a-production-ready-worker-pool-in-go).

In a pull-oriented dispatcher, workers register their readiness by sending their private work channel into a centralized `WorkerPool` queue (`chan chan Job`). The dispatcher routes incoming work exclusively to workers that are already idle:

```go
package worker

import (
	"context"
	"sync"
)

type DispatcherWorker struct {
	id          int
	workChannel chan Job
	workerQueue chan chan Job
	quit        chan struct{}
}

func NewDispatcherWorker(id int, workerQueue chan chan Job) *DispatcherWorker {
	return &DispatcherWorker{
		id:          id,
		workChannel: make(chan Job),
		workerQueue: workerQueue,
		quit:        make(chan struct{}),
	}
}

func (w *DispatcherWorker) Start(ctx context.Context, wg *sync.WaitGroup) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			// Register private work channel as available
			w.workerQueue <- w.workChannel

			select {
			case job := <-w.workChannel:
				_ = job.Process(ctx)
			case <-w.quit:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (w *DispatcherWorker) Stop() {
	close(w.quit)
}

type Dispatcher struct {
	maxWorkers  int
	jobQueue    chan Job
	workerQueue chan chan Job
	workers     []*DispatcherWorker
	wg          sync.WaitGroup
}

func NewDispatcher(maxWorkers, queueSize int) *Dispatcher {
	return &Dispatcher{
		maxWorkers:  maxWorkers,
		jobQueue:    make(chan Job, queueSize),
		workerQueue: make(chan chan Job, maxWorkers),
		workers:     make([]*DispatcherWorker, maxWorkers),
	}
}

func (d *Dispatcher) Run(ctx context.Context) {
	for i := 0; i < d.maxWorkers; i++ {
		worker := NewDispatcherWorker(i, d.workerQueue)
		d.workers[i] = worker
		worker.Start(ctx, &d.wg)
	}

	go d.dispatch(ctx)
}

func (d *Dispatcher) dispatch(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-d.jobQueue:
			select {
			case <-ctx.Done():
				return
			case workerChannel := <-d.workerQueue:
				// Dispatched only to a verified idle worker
				workerChannel <- job
			}
		}
	}
}

func (d *Dispatcher) Submit(job Job) {
	d.jobQueue <- job
}

func (d *Dispatcher) Stop() {
	for _, w := range d.workers {
		w.Stop()
	}
	d.wg.Wait()
}
```

### In-Process Sharded Workers for Per-Entity FIFO Ordering

When background operations modify user balances, order states, or device configurations, operations for the same entity must run sequentially to avoid database lock contention and race conditions. Teams often reach for Redis distributed locks or partitioned Kafka topics to solve this.

An in-process alternative is consistent hash sharding across worker channels, detailed by [Fabrizio Manunta (February 2026), "You Probably Don't Need More Infrastructure: The Case for Sharded Workers in Go"](https://medium.com/@fabriziomanunta/you-probably-dont-need-more-infrastructure-the-case-for-sharded-workers-in-go-54cbfe978c43).

Incoming jobs are routed by entity key (`hash(key) % shardCount`) into a dedicated per-shard channel serviced by a single worker goroutine. This guarantees strict FIFO ordering per entity while retaining high parallel throughput across distinct entities:

```go
package sharded

import (
	"context"
	"hash/fnv"
	"sync"
)

type ShardedJob struct {
	Key     string
	Execute func(ctx context.Context) error
}

type ShardedWorkerPool struct {
	numShards int
	queues    []chan ShardedJob
	wg        sync.WaitGroup
}

func NewShardedWorkerPool(numShards, bufferPerShard int) *ShardedWorkerPool {
	p := &ShardedWorkerPool{
		numShards: numShards,
		queues:    make([]chan ShardedJob, numShards),
	}
	for i := 0; i < numShards; i++ {
		p.queues[i] = make(chan ShardedJob, bufferPerShard)
	}
	return p
}

func (p *ShardedWorkerPool) Start(ctx context.Context) {
	for i := 0; i < p.numShards; i++ {
		p.wg.Add(1)
		shardQueue := p.queues[i]
		go func(q chan ShardedJob) {
			defer p.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-q:
					if !ok {
						return
					}
					_ = job.Execute(ctx)
				}
			}
		}(shardQueue)
	}
}

func (p *ShardedWorkerPool) Submit(ctx context.Context, job ShardedJob) bool {
	h := fnv.New32a()
	_, _ = h.Write([]byte(job.Key))
	shardIndex := h.Sum32() % uint32(p.numShards)

	select {
	case p.queues[shardIndex] <- job:
		return true
	case <-ctx.Done():
		return false
	default:
		return false // Shard buffer saturated
	}
}

func (p *ShardedWorkerPool) Stop() {
	for _, q := range p.queues {
		close(q)
	}
	p.wg.Wait()
}
```

### Memory-Constrained Streaming Ingestion (10GB Data in 512MB RAM)

Processing large datasets without exceeding strict container memory limits requires streaming rather than buffered reading, documented by [Sarveshkhamkar (May 2026), "“I Have a 10GB CSV File and Only 512MB RAM” - The Interview Question That Stumped Me"](https://medium.com/@sarveshkhamkar/i-have-a-10gb-csv-file-and-only-512mb-ram-the-interview-question-that-stumped-me).

A naive call to `csv.NewReader(f).ReadAll()` or reading the entire file into memory causes immediate Out-Of-Memory (OOM) termination. Using `csv.Reader` with `ReuseRecord: true` avoids slice reallocations on every row. Combining this with chunked channel streaming keeps residential memory consumption under 35 MB regardless of file size:

```go
package ingestion

import (
	"context"
	"encoding/csv"
	"io"
	"os"
	"sync"
)

type Batch []Record

type Record struct {
	ID    string
	Value string
}

func StreamIngest(ctx context.Context, filePath string, batchSize int, numWorkers int) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.ReuseRecord = true // Reuses underlying slice buffer

	batchChan := make(chan Batch, numWorkers*2)
	var wg sync.WaitGroup

	// Start worker pool
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for batch := range batchChan {
				_ = processBatch(ctx, batch)
			}
		}()
	}

	// Stream and partition into batches
	currentBatch := make(Batch, 0, batchSize)
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			close(batchChan)
			return err
		}

		currentBatch = append(currentBatch, Record{ID: row[0], Value: row[1]})
		if len(currentBatch) >= batchSize {
			select {
			case batchChan <- currentBatch:
				currentBatch = make(Batch, 0, batchSize)
			case <-ctx.Done():
				close(batchChan)
				return ctx.Err()
			}
		}
	}

	if len(currentBatch) > 0 {
		batchChan <- currentBatch
	}
	close(batchChan)
	wg.Wait()
	return nil
}

func processBatch(ctx context.Context, batch Batch) error {
	// Database batch write via COPY or multi-value INSERT
	return nil
}
```

---
