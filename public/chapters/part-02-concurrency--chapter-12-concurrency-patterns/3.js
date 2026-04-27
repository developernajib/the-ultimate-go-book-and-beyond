export default `## 12.2 Pipeline Pattern

Pipelines connect processing stages through channels, enabling composable data transformations.

### Pipeline Architecture

\`\`\`
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Source  │───►│ Stage 1  │───►│ Stage 2  │───►│   Sink   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
  Generate       Transform       Transform        Collect
\`\`\`

### Basic Pipeline

A pipeline threads a channel through a series of stages, where each stage reads from an input channel, transforms the data, and writes to an output channel. The \`Pipeline\` helper below accepts a variadic list of \`Stage\` functions and chains them left to right, so the output of one stage becomes the input of the next. Each stage runs in its own goroutine, meaning all stages execute concurrently, stage 2 processes item N while stage 1 is already working on item N+1.

\`\`\`go
// Stage type for pipeline stages
type Stage[In, Out any] func(context.Context, <-chan In) <-chan Out

// Build a pipeline from stages
func Pipeline[T any](ctx context.Context, source <-chan T, stages ...Stage[T, T]) <-chan T {
    current := source
    for _, stage := range stages {
        current = stage(ctx, current)
    }
    return current
}

// Example stages
func Double(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- v * 2:
                }
            }
        }
    }()
    return out
}

func AddTen(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- v + 10:
                }
            }
        }
    }()
    return out
}

// Usage
func main() {
    ctx := context.Background()
    source := Generator(ctx, 1, 2, 3, 4, 5)

    // Pipeline: source -> double -> addTen
    result := Pipeline(ctx, source, Double, AddTen)

    for v := range result {
        fmt.Println(v)  // 12, 14, 16, 18, 20
    }
}
\`\`\`

### Pipeline with Error Handling

Production pipelines must handle errors gracefully:

\`\`\`go
// Result wraps a value or error
type Result[T any] struct {
    Value T
    Err   error
}

// ErrorPipeline propagates errors through stages
type ErrorStage[In, Out any] func(context.Context, <-chan Result[In]) <-chan Result[Out]

// MapWithError creates an error-aware transformation stage
func MapWithError[In, Out any](fn func(In) (Out, error)) ErrorStage[In, Out] {
    return func(ctx context.Context, in <-chan Result[In]) <-chan Result[Out] {
        out := make(chan Result[Out])
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                case r, ok := <-in:
                    if !ok {
                        return
                    }

                    var result Result[Out]
                    if r.Err != nil {
                        // Propagate existing error
                        result = Result[Out]{Err: r.Err}
                    } else {
                        // Apply transformation
                        value, err := fn(r.Value)
                        result = Result[Out]{Value: value, Err: err}
                    }

                    select {
                    case <-ctx.Done():
                        return
                    case out <- result:
                    }
                }
            }
        }()
        return out
    }
}

// ErrorFilter drops errors and continues processing
func ErrorFilter[T any](ctx context.Context, in <-chan Result[T], errHandler func(error)) <-chan T {
    out := make(chan T)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case r, ok := <-in:
                if !ok {
                    return
                }
                if r.Err != nil {
                    if errHandler != nil {
                        errHandler(r.Err)
                    }
                    continue
                }
                select {
                case <-ctx.Done():
                    return
                case out <- r.Value:
                }
            }
        }
    }()
    return out
}

// CollectErrors gathers all errors from a pipeline
func CollectErrors[T any](ctx context.Context, in <-chan Result[T]) ([]T, []error) {
    var values []T
    var errors []error

    for {
        select {
        case <-ctx.Done():
            return values, append(errors, ctx.Err())
        case r, ok := <-in:
            if !ok {
                return values, errors
            }
            if r.Err != nil {
                errors = append(errors, r.Err)
            } else {
                values = append(values, r.Value)
            }
        }
    }
}
\`\`\`

### Pipeline with Backpressure

When a downstream stage processes items more slowly than the upstream stage produces them, the unbuffered channel between them blocks the producer automatically. This natural backpressure keeps memory usage constant but reduces throughput. The three strategies below give you explicit control: \`BufferedStage\` adds a fixed buffer to absorb short bursts, \`DroppingStage\` sheds load by discarding items when the buffer is full (with a callback for metrics), and \`BlockingStage\` logs when blocking occurs before falling back to the channel's natural backpressure.

\`\`\`go
// BufferedStage adds a buffer between stages
func BufferedStage[T any](size int) Stage[T, T] {
    return func(ctx context.Context, in <-chan T) <-chan T {
        out := make(chan T, size)
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-in:
                    if !ok {
                        return
                    }
                    select {
                    case <-ctx.Done():
                        return
                    case out <- v:
                    }
                }
            }
        }()
        return out
    }
}

// DroppingStage drops values when buffer is full
func DroppingStage[T any](size int, onDrop func(T)) Stage[T, T] {
    return func(ctx context.Context, in <-chan T) <-chan T {
        out := make(chan T, size)
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-in:
                    if !ok {
                        return
                    }
                    select {
                    case out <- v:
                    default:
                        if onDrop != nil {
                            onDrop(v)
                        }
                    }
                }
            }
        }()
        return out
    }
}

// BlockingStage blocks when buffer is full (natural backpressure)
func BlockingStage[T any](size int, onBlock func()) Stage[T, T] {
    return func(ctx context.Context, in <-chan T) <-chan T {
        out := make(chan T, size)
        go func() {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-in:
                    if !ok {
                        return
                    }

                    // Check if we'll block
                    select {
                    case out <- v:
                    default:
                        if onBlock != nil {
                            onBlock()
                        }
                        select {
                        case <-ctx.Done():
                            return
                        case out <- v:
                        }
                    }
                }
            }
        }()
        return out
    }
}
\`\`\`

### Bidirectional Pipeline (Duplex)

Standard pipelines are unidirectional: data flows from source to sink. A duplex pipeline adds a response channel to each request, enabling request-response patterns where the caller submits work and blocks until the result is ready. This is useful for connection-pooled services, ordered task queues, or any scenario where the submitter needs the processed result rather than just fire-and-forget delivery.

\`\`\`go
// Request represents a pipeline request
type Request[Req, Resp any] struct {
    Data     Req
    Response chan<- Resp
}

// DuplexPipeline handles request-response flows
func DuplexPipeline[Req, Resp any](
    ctx context.Context,
    handler func(Req) Resp,
) chan<- Request[Req, Resp] {

    requests := make(chan Request[Req, Resp])

    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case req, ok := <-requests:
                if !ok {
                    return
                }
                response := handler(req.Data)
                select {
                case <-ctx.Done():
                    return
                case req.Response <- response:
                }
            }
        }
    }()

    return requests
}

// Usage
func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Create pipeline that doubles numbers
    pipeline := DuplexPipeline(ctx, func(n int) int {
        return n * 2
    })

    // Send request
    respChan := make(chan int, 1)
    pipeline <- Request[int, int]{Data: 21, Response: respChan}

    result := <-respChan
    fmt.Println(result)  // 42
}
\`\`\`

### Pipeline Back-Pressure and Buffering

A pipeline's behaviour under load is determined by its channel buffer sizes. Three configurations:

- **All unbuffered.** Each stage blocks the upstream stage until a downstream consumer is ready. Strict back-pressure. Slow stage slows the whole pipeline. Simplest to reason about.
- **Small buffers per stage.** Smooths micro-bursts without significant memory. A buffer of 1 or 2 absorbs scheduler jitter. Default for production pipelines.
- **Large buffers.** Masks back-pressure. Fast producer and slow consumer look fine until the buffer is full, then the system either OOMs or stalls dramatically. Almost always wrong.

The staff-level rule: prefer unbuffered channels. When a benchmark shows bufferspeeds up the pipeline meaningfully, use the smallest buffer that captures the benefit. Large buffers are a design smell indicating the stages are mismatched in throughput and the real fix is fan-out on the slow stage, not buffering.

### Staff Lens: Pipelines as a Measurement Problem

Every pipeline in production should have per-stage metrics: items processed per second, p50 and p99 latency per stage, queue depth at each stage output. Without these, diagnosing a slow pipeline is guesswork. With them, the slow stage is the one with the consistently full queue on its input. This is the debugging shape that converts pipeline performance from a black box into an engineering problem. Principal engineers build these metrics into the shared pipeline helpers so every consumer gets them automatically.

---
`;
