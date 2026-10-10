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

        // Connect input transform: producer of this transform's input PCollection
        if inPC := transform.GetInput(); inPC != nil && inPC.producer != nil {
            if producerNode, ok := nodes[inPC.producer]; ok {
                node.inputs = append(node.inputs, producerNode)
                producerNode.outputs = append(producerNode.outputs, node)
            }
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
                emptyCh := make(chan Element)
                close(emptyCh)
                input = emptyCh
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
