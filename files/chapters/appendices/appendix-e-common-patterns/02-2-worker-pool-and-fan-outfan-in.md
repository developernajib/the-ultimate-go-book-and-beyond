## 2. Worker Pool and Fan-out/Fan-in

Worker pools limit concurrency and manage resource usage. Fan-out/Fan-in distributes work across goroutines and collects results.

### Basic Worker Pool

A worker pool starts a fixed number of goroutines that read jobs from a shared channel. This bounds concurrency regardless of how many jobs arrive. The pool shuts down when the jobs channel is closed.

```go
package worker

import (
    "context"
    "fmt"
    "sync"
)

// Job represents a unit of work
type Job struct {
    ID   int
    Data any
}

// Result represents the outcome of a job
type Result struct {
    Job   Job
    Value any
    Err   error
}

// Worker processes jobs from a channel
func Worker(ctx context.Context, id int, jobs <-chan Job, results chan<- Result) {
    for {
        select {
        case <-ctx.Done():
            return
        case job, ok := <-jobs:
            if !ok {
                return
            }

            // Process job
            result := Result{Job: job}
            result.Value, result.Err = processJob(job)

            select {
            case results <- result:
            case <-ctx.Done():
                return
            }
        }
    }
}

// processJob simulates job processing
func processJob(job Job) (any, error) {
    // Actual work goes here
    return fmt.Sprintf("Processed job %d", job.ID), nil
}

// WorkerPool manages a pool of workers
type WorkerPool struct {
    workerCount int
    jobs        chan Job
    results     chan Result
    wg          sync.WaitGroup
}

// NewWorkerPool creates a worker pool
func NewWorkerPool(workerCount, jobBuffer int) *WorkerPool {
    return &WorkerPool{
        workerCount: workerCount,
        jobs:        make(chan Job, jobBuffer),
        results:     make(chan Result, jobBuffer),
    }
}

// Start launches workers
func (wp *WorkerPool) Start(ctx context.Context) {
    for i := 0; i < wp.workerCount; i++ {
        wp.wg.Add(1)
        go func(workerID int) {
            defer wp.wg.Done()
            Worker(ctx, workerID, wp.jobs, wp.results)
        }(i)
    }
}

// Submit adds a job to the pool
func (wp *WorkerPool) Submit(job Job) {
    wp.jobs <- job
}

// Close closes the jobs channel and waits for workers
func (wp *WorkerPool) Close() {
    close(wp.jobs)
    wp.wg.Wait()
    close(wp.results)
}

// Results returns the results channel
func (wp *WorkerPool) Results() <-chan Result {
    return wp.results
}

// Example usage
func ExampleWorkerPool() {
    ctx := context.Background()

    pool := NewWorkerPool(5, 100)
    pool.Start(ctx)

    // Submit jobs
    go func() {
        for i := 0; i < 20; i++ {
            pool.Submit(Job{ID: i, Data: i * 2})
        }
        pool.Close()
    }()

    // Collect results
    for result := range pool.Results() {
        if result.Err != nil {
            fmt.Printf("Job %d failed: %v\n", result.Job.ID, result.Err)
        } else {
            fmt.Printf("Job %d: %v\n", result.Job.ID, result.Value)
        }
    }
}
```

### Fan-out/Fan-in Pattern

```go
package fanout

import (
    "context"
    "sync"
)

// Task represents work to be done
type Task struct {
    ID int
    Input any
}

// TaskResult represents the result of a task
type TaskResult struct {
    TaskID int
    Output any
    Err    error
}

// ProcessTask is the function that processes a single task
type ProcessTask func(context.Context, Task) (any, error)

// FanOut distributes tasks to multiple workers
func FanOut(ctx context.Context, tasks <-chan Task, workerCount int, process ProcessTask) <-chan TaskResult {
    results := make(chan TaskResult)
    var wg sync.WaitGroup

    // Start workers
    for i := 0; i < workerCount; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case <-ctx.Done():
                    return
                case task, ok := <-tasks:
                    if !ok {
                        return
                    }

                    output, err := process(ctx, task)
                    result := TaskResult{
                        TaskID: task.ID,
                        Output: output,
                        Err:    err,
                    }

                    select {
                    case results <- result:
                    case <-ctx.Done():
                        return
                    }
                }
            }
        }()
    }

    // Close results when all workers finish
    go func() {
        wg.Wait()
        close(results)
    }()

    return results
}

// FanIn combines multiple result channels into one
func FanIn(ctx context.Context, channels ...<-chan TaskResult) <-chan TaskResult {
    var wg sync.WaitGroup
    multiplexed := make(chan TaskResult)

    // Function to read from a channel and send to multiplexed
    multiplex := func(c <-chan TaskResult) {
        defer wg.Done()
        for {
            select {
            case <-ctx.Done():
                return
            case result, ok := <-c:
                if !ok {
                    return
                }
                select {
                case multiplexed <- result:
                case <-ctx.Done():
                    return
                }
            }
        }
    }

    // Start multiplexing for each channel
    wg.Add(len(channels))
    for _, c := range channels {
        go multiplex(c)
    }

    // Close multiplexed when all inputs are exhausted
    go func() {
        wg.Wait()
        close(multiplexed)
    }()

    return multiplexed
}

// Pipeline combines fan-out and fan-in
func Pipeline(ctx context.Context, inputs []Task, workerCount int, process ProcessTask) <-chan TaskResult {
    // Create input channel
    tasks := make(chan Task)
    go func() {
        defer close(tasks)
        for _, input := range inputs {
            select {
            case tasks <- input:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Fan-out to workers
    return FanOut(ctx, tasks, workerCount, process)
}
```

---
