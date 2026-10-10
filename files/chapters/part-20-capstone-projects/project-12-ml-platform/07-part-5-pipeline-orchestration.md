## Part 5: Pipeline Orchestration

ML workflows involve multiple steps that must execute in a specific order, data ingestion, preprocessing, feature extraction, model training, evaluation, and deployment. A pipeline orchestrator automates this sequence by modeling it as a DAG (directed acyclic graph), where each node is a step and edges represent dependencies. This ensures that steps only run after their dependencies complete successfully, and that independent steps can run in parallel for faster execution.

### 5.1 DAG-Based Pipeline Executor
The executor below takes a pipeline definition with its steps and dependencies, performs a topological sort to determine execution order, and runs steps concurrently wherever the dependency graph allows. It tracks the status of each step, handles timeouts, supports retries for transient failures, and reports the overall pipeline status. If any step fails, dependent steps are automatically skipped. This pattern mirrors how production orchestrators like Airflow and Kubeflow Pipelines work internally.

```go
// internal/service/pipeline/executor.go
package pipeline

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"ml-platform/internal/domain"
	"ml-platform/internal/storage"
)

// Executor executes ML pipelines
type Executor struct {
	store     storage.PipelineStore
	scheduler *Scheduler
	workers   int
}

// NewExecutor creates a new pipeline executor
func NewExecutor(store storage.PipelineStore, workers int) *Executor {
	return &Executor{
		store:     store,
		scheduler: NewScheduler(),
		workers:   workers,
	}
}

// ExecutePipeline executes a pipeline
func (e *Executor) ExecutePipeline(ctx context.Context, pipelineID uuid.UUID, params map[string]any) (*domain.PipelineRun, error) {
	pipeline, err := e.store.GetPipeline(ctx, pipelineID)
	if err != nil {
		return nil, fmt.Errorf("getting pipeline: %w", err)
	}
	if pipeline == nil {
		return nil, fmt.Errorf("pipeline not found")
	}

	run := &domain.PipelineRun{
		ID:          uuid.New(),
		PipelineID:  pipelineID,
		Status:      domain.PipelineStatusRunning,
		StartTime:   time.Now(),
		StepRuns:    make(map[string]*domain.StepRun),
		Params:      params,
		TriggerType: "MANUAL",
	}

	// Create step runs
	for _, step := range pipeline.Steps {
		run.StepRuns[step.ID] = &domain.StepRun{
			StepID:   step.ID,
			Status:   domain.PipelineStatusRunning,
			Attempts: 0,
			Outputs:  make(map[string]any),
		}
	}

	if err := e.store.CreatePipelineRun(ctx, run); err != nil {
		return nil, fmt.Errorf("creating pipeline run: %w", err)
	}

	// Execute pipeline asynchronously
	go e.executePipelineAsync(context.Background(), pipeline, run)

	return run, nil
}

// executePipelineAsync runs the pipeline execution
func (e *Executor) executePipelineAsync(ctx context.Context, pipeline *domain.Pipeline, run *domain.PipelineRun) {
	defer func() {
		if r := recover(); r != nil {
			run.Status = domain.PipelineStatusFailed
			now := time.Now()
			run.EndTime = &now
			e.store.UpdatePipelineRun(ctx, run)
		}
	}()

	// Build DAG
	dag := e.buildDAG(pipeline.Steps)

	// Execute DAG
	if err := e.executeDAG(ctx, dag, run); err != nil {
		run.Status = domain.PipelineStatusFailed
	} else {
		run.Status = domain.PipelineStatusSucceeded
	}

	now := time.Now()
	run.EndTime = &now
	e.store.UpdatePipelineRun(ctx, run)
}

// buildDAG creates a directed acyclic graph from pipeline steps
func (e *Executor) buildDAG(steps []domain.PipelineStep) *DAG {
	dag := NewDAG()

	for _, step := range steps {
		dag.AddNode(step.ID, &step)

		for _, dep := range step.DependsOn {
			dag.AddEdge(dep, step.ID)
		}
	}

	return dag
}

// executeDAG executes steps in topological order
func (e *Executor) executeDAG(ctx context.Context, dag *DAG, run *domain.PipelineRun) error {
	// Get execution order
	order, err := dag.TopologicalSort()
	if err != nil {
		return fmt.Errorf("sorting DAG: %w", err)
	}

	// Execute steps in order, with parallelization where possible
	for level := range order {
		var wg sync.WaitGroup
		errors := make(chan error, len(order[level]))

		for _, stepID := range order[level] {
			wg.Add(1)

			go func(id string) {
				defer wg.Done()

				step := dag.GetNode(id).(*domain.PipelineStep)
				stepRun := run.StepRuns[id]

				if err := e.executeStep(ctx, step, stepRun, run); err != nil {
					errors <- fmt.Errorf("step %s failed: %w", id, err)
					stepRun.Status = domain.PipelineStatusFailed
					stepRun.Error = err.Error()
				} else {
					stepRun.Status = domain.PipelineStatusSucceeded
				}

				now := time.Now()
				stepRun.EndTime = &now

				e.store.UpdatePipelineRun(ctx, run)
			}(stepID)
		}

		wg.Wait()
		close(errors)

		// Check for errors
		for err := range errors {
			if err != nil {
				return err
			}
		}
	}

	return nil
}

// executeStep executes a single pipeline step
func (e *Executor) executeStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	stepRun.StartTime = time.Now()
	stepRun.Attempts++

	// Create step execution context with timeout
	stepCtx := ctx
	if step.Timeout > 0 {
		var cancel context.CancelFunc
		stepCtx, cancel = context.WithTimeout(ctx, step.Timeout)
		defer cancel()
	}

	// Execute based on step type
	var err error
	switch step.Type {
	case domain.StepTypeDataPrep:
		err = e.executeDataPrepStep(stepCtx, step, stepRun, run)
	case domain.StepTypeTraining:
		err = e.executeTrainingStep(stepCtx, step, stepRun, run)
	case domain.StepTypeValidation:
		err = e.executeValidationStep(stepCtx, step, stepRun, run)
	case domain.StepTypeDeployment:
		err = e.executeDeploymentStep(stepCtx, step, stepRun, run)
	case domain.StepTypeCustom:
		err = e.executeCustomStep(stepCtx, step, stepRun, run)
	default:
		err = fmt.Errorf("unknown step type: %s", step.Type)
	}

	// Handle retry logic
	if err != nil && step.RetryPolicy != nil && stepRun.Attempts < step.RetryPolicy.MaxRetries {
		// Check if error is retryable
		if e.isRetryableError(err, step.RetryPolicy) {
			// Wait before retry
			backoffIdx := stepRun.Attempts - 1
			if backoffIdx < len(step.RetryPolicy.BackoffSeconds) {
				time.Sleep(time.Duration(step.RetryPolicy.BackoffSeconds[backoffIdx]) * time.Second)
			}

			// Retry
			return e.executeStep(ctx, step, stepRun, run)
		}
	}

	return err
}

func (e *Executor) executeDataPrepStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	// Data preparation logic
	// This would typically:
	// 1. Load data from source
	// 2. Apply transformations
	// 3. Save processed data
	
	stepRun.Outputs["data_path"] = "/tmp/processed_data.parquet"
	stepRun.Outputs["num_samples"] = 10000

	return nil
}

func (e *Executor) executeTrainingStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	// Model training logic
	// This would typically:
	// 1. Load training data
	// 2. Train model
	// 3. Save model artifacts
	
	stepRun.Outputs["model_path"] = "/tmp/model.onnx"
	stepRun.Outputs["train_loss"] = 0.123
	stepRun.Outputs["train_accuracy"] = 0.95

	return nil
}

func (e *Executor) executeValidationStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	// Model validation logic
	stepRun.Outputs["val_loss"] = 0.156
	stepRun.Outputs["val_accuracy"] = 0.93

	return nil
}

func (e *Executor) executeDeploymentStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	// Model deployment logic
	// This would typically:
	// 1. Register model in model registry
	// 2. Transition to staging/production
	// 3. Update serving infrastructure
	
	stepRun.Outputs["model_version"] = 42
	stepRun.Outputs["endpoint"] = "https://api.example.com/models/my-model/predict"

	return nil
}

func (e *Executor) executeCustomStep(ctx context.Context, step *domain.PipelineStep, stepRun *domain.StepRun, run *domain.PipelineRun) error {
	// Custom step logic defined by user
	return nil
}

func (e *Executor) isRetryableError(err error, policy *domain.RetryPolicy) bool {
	// Check if error type is in retry list
	// Simplified implementation
	return true
}

// DAG represents a directed acyclic graph
type DAG struct {
	nodes map[string]any
	edges map[string][]string
}

func NewDAG() *DAG {
	return &DAG{
		nodes: make(map[string]any),
		edges: make(map[string][]string),
	}
}

func (d *DAG) AddNode(id string, data any) {
	d.nodes[id] = data
}

func (d *DAG) AddEdge(from, to string) {
	d.edges[from] = append(d.edges[from], to)
}

func (d *DAG) GetNode(id string) any {
	return d.nodes[id]
}

// TopologicalSort returns nodes grouped by execution level
func (d *DAG) TopologicalSort() ([][]string, error) {
	inDegree := make(map[string]int)
	
	// Calculate in-degrees
	for node := range d.nodes {
		if _, ok := inDegree[node]; !ok {
			inDegree[node] = 0
		}
	}
	
	for _, targets := range d.edges {
		for _, target := range targets {
			inDegree[target]++
		}
	}

	// Find nodes with no dependencies (in-degree 0)
	levels := make([][]string, 0)
	currentLevel := make([]string, 0)
	
	for node, degree := range inDegree {
		if degree == 0 {
			currentLevel = append(currentLevel, node)
		}
	}

	visited := 0
	for len(currentLevel) > 0 {
		levels = append(levels, currentLevel)
		visited += len(currentLevel)
		
		nextLevel := make([]string, 0)
		
		for _, node := range currentLevel {
			for _, target := range d.edges[node] {
				inDegree[target]--
				if inDegree[target] == 0 {
					nextLevel = append(nextLevel, target)
				}
			}
		}
		
		currentLevel = nextLevel
	}

	if visited != len(d.nodes) {
		return nil, fmt.Errorf("cycle detected in DAG")
	}

	return levels, nil
}

// Scheduler handles scheduled pipeline executions
type Scheduler struct {
	ticker *time.Ticker
}

func NewScheduler() *Scheduler {
	return &Scheduler{
		ticker: time.NewTicker(1 * time.Minute),
	}
}

func (s *Scheduler) Start(ctx context.Context, executor *Executor) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.ticker.C:
				// Check for scheduled pipelines
				// Execute due pipelines
			}
		}
	}()
}
```

---
