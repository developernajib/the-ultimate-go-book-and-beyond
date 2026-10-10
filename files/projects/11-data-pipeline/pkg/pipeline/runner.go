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
