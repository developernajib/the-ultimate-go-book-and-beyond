## Part 7: Distributed Execution

A pipeline definition describes what to do with data, but a runner decides how to actually execute it. This part introduces two runners: a direct runner that executes everything in a single process (great for development and testing), and a distributed runner that spreads work across multiple workers coordinated by a central scheduler. The runner abstraction lets you develop locally and deploy to a cluster without changing your pipeline code.

### Runner Interface

The `Runner` interface has a single method: take a pipeline and execute it. The `ExecutionContext` bundles together everything the runner needs at runtime, including the pipeline definition, metrics collector, state backend, watermark tracker, and checkpoint coordinator. By keeping the runner as a simple interface, you can swap execution strategies without touching any pipeline logic.

```go
// pkg/pipeline/runner.go
package pipeline

import "context"

// Runner executes a pipeline
type Runner interface {
    Run(ctx context.Context, pipeline *Pipeline) error
}

// ExecutionContext provides runtime context
type ExecutionContext struct {
    Pipeline        *Pipeline
    Metrics         *MetricsCollector
    State           *State
    Watermark       *Watermark
    CheckpointCoord *CheckpointCoordinator
}
```

### Direct Runner (Single Machine)

The `DirectRunner` executes the entire pipeline in a single process using goroutines for parallelism. It builds an execution graph from the pipeline's transforms, connects them with channels, and runs each transform in its own goroutine. This runner is perfect for local development, unit testing, and small datasets. It uses all the same semantics as a distributed runner but without the overhead of network communication between workers.

```go
// pkg/pipeline/runner_direct.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
)

// DirectRunner executes pipelines locally
type DirectRunner struct {
    parallelism int
}

func NewDirectRunner() *DirectRunner {
    return &DirectRunner{
        parallelism: 4,
    }
}

func (r *DirectRunner) WithParallelism(n int) *DirectRunner {
    r.parallelism = n
    return r
}

func (r *DirectRunner) Run(ctx context.Context, pipeline *Pipeline) error {
    // Create execution context
    stateBackend := pipeline.options.StateBackend
    if stateBackend == nil {
        stateBackend = NewMemoryStateBackend()
    }

    execCtx := &ExecutionContext{
        Pipeline:        pipeline,
        Metrics:         NewMetricsCollector(),
        State:           NewState(stateBackend, "pipeline"),
        Watermark:       NewWatermark(),
        CheckpointCoord: NewCheckpointCoordinator(stateBackend),
    }

    // Build execution graph
    graph := r.buildGraph(pipeline)

    // Execute graph
    return r.executeGraph(ctx, graph, execCtx)
}

// executionNode represents a transform in the execution graph
type executionNode struct {
    transform Transform
    inputs    []*executionNode
    outputs   []*executionNode
    channel   chan Element
}

func (r *DirectRunner) buildGraph(pipeline *Pipeline) map[Transform]*executionNode {
    nodes := make(map[Transform]*executionNode)

    // Create nodes
    for _, transform := range pipeline.transforms {
        nodes[transform] = &executionNode{
            transform: transform,
            inputs:    make([]*executionNode, 0),
            outputs:   make([]*executionNode, 0),
            channel:   make(chan Element, 1000),
        }
    }

    // Connect nodes
    for _, transform := range pipeline.transforms {
        node := nodes[transform]

        // Find input transforms
        // This is simplified - a real implementation would track dependencies
        for _, otherTransform := range pipeline.transforms {
            if otherTransform == transform {
                continue
            }

            otherNode := nodes[otherTransform]
            // Connect if other's output is this transform's input
            // (simplified logic)
            node.inputs = append(node.inputs, otherNode)
            otherNode.outputs = append(otherNode.outputs, node)
        }
    }

    return nodes
}

func (r *DirectRunner) executeGraph(ctx context.Context, graph map[Transform]*executionNode, execCtx *ExecutionContext) error {
    var wg sync.WaitGroup
    errChan := make(chan error, len(graph))

    // Start all transforms
    for _, node := range graph {
        wg.Add(1)

        go func(n *executionNode) {
            defer wg.Done()

            // Determine input channel
            var input <-chan Element
            if len(n.inputs) > 0 {
                input = n.inputs[0].channel
            } else {
                // Source - no input
                input = make(chan Element)
                close(input.(chan Element))
            }

            // Execute transform
            if err := n.transform.Process(ctx, input, n.channel); err != nil {
                errChan <- fmt.Errorf("%s: %w", n.transform.Name(), err)
                return
            }

            // Close output channel when done
            close(n.channel)
        }(node)
    }

    // Wait for completion
    go func() {
        wg.Wait()
        close(errChan)
    }()

    // Check for errors
    for err := range errChan {
        if err != nil {
            return err
        }
    }

    return nil
}
```

### Distributed Runner

The `DistributedRunner` splits pipeline work across multiple workers managed by a `Coordinator`. The coordinator breaks the pipeline into tasks (one per transform), then assigns tasks to workers using round-robin scheduling. Each `Worker` registers with the coordinator, receives its assigned tasks, and executes them concurrently using goroutines. This architecture scales horizontally: you can add more workers to handle larger datasets or higher throughput requirements.

```go
// pkg/pipeline/runner_distributed.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
)

// DistributedRunner executes pipelines across multiple workers
type DistributedRunner struct {
    coordinator *Coordinator
    workers     []*Worker
}

func NewDistributedRunner(numWorkers int) *DistributedRunner {
    coordinator := NewCoordinator()

    workers := make([]*Worker, numWorkers)
    for i := 0; i < numWorkers; i++ {
        workers[i] = NewWorker(i, coordinator)
    }

    return &DistributedRunner{
        coordinator: coordinator,
        workers:     workers,
    }
}

func (r *DistributedRunner) Run(ctx context.Context, pipeline *Pipeline) error {
    // Start workers
    var wg sync.WaitGroup
    for _, worker := range r.workers {
        wg.Add(1)
        go func(w *Worker) {
            defer wg.Done()
            w.Start(ctx)
        }(worker)
    }

    // Schedule pipeline on coordinator
    if err := r.coordinator.Schedule(ctx, pipeline); err != nil {
        return err
    }

    // Wait for completion
    wg.Wait()

    return nil
}

// Coordinator manages distributed execution
type Coordinator struct {
    mu          sync.RWMutex
    tasks       []*Task
    workers     map[int]*WorkerInfo
    assignments map[int][]*Task
}

type WorkerInfo struct {
    ID          int
    Available   bool
    CurrentLoad int
}

type Task struct {
    ID        int
    Transform Transform
    Input     chan Element
    Output    chan Element
    WorkerID  int
}

func NewCoordinator() *Coordinator {
    return &Coordinator{
        tasks:       make([]*Task, 0),
        workers:     make(map[int]*WorkerInfo),
        assignments: make(map[int][]*Task),
    }
}

func (c *Coordinator) RegisterWorker(id int) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.workers[id] = &WorkerInfo{
        ID:        id,
        Available: true,
    }
    c.assignments[id] = make([]*Task, 0)
}

func (c *Coordinator) Schedule(ctx context.Context, pipeline *Pipeline) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Create tasks from transforms
    for i, transform := range pipeline.transforms {
        task := &Task{
            ID:        i,
            Transform: transform,
            Input:     make(chan Element, 1000),
            Output:    make(chan Element, 1000),
        }
        c.tasks = append(c.tasks, task)
    }

    // Assign tasks to workers (simple round-robin)
    workerIDs := make([]int, 0, len(c.workers))
    for id := range c.workers {
        workerIDs = append(workerIDs, id)
    }

    for i, task := range c.tasks {
        workerID := workerIDs[i%len(workerIDs)]
        task.WorkerID = workerID
        c.assignments[workerID] = append(c.assignments[workerID], task)
    }

    return nil
}

func (c *Coordinator) GetTasksForWorker(workerID int) []*Task {
    c.mu.RLock()
    defer c.mu.RUnlock()

    return c.assignments[workerID]
}

// Worker executes tasks
type Worker struct {
    id          int
    coordinator *Coordinator
}

func NewWorker(id int, coordinator *Coordinator) *Worker {
    coordinator.RegisterWorker(id)
    return &Worker{
        id:          id,
        coordinator: coordinator,
    }
}

func (w *Worker) Start(ctx context.Context) error {
    tasks := w.coordinator.GetTasksForWorker(w.id)

    var wg sync.WaitGroup
    for _, task := range tasks {
        wg.Add(1)

        go func(t *Task) {
            defer wg.Done()

            if err := t.Transform.Process(ctx, t.Input, t.Output); err != nil {
                // Log error
                fmt.Printf("Worker %d: Task %d error: %v\n", w.id, t.ID, err)
            }
        }(task)
    }

    wg.Wait()
    return nil
}
```
