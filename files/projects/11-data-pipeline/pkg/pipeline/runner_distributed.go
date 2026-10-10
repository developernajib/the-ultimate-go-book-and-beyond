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
	for i := range numWorkers {
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
