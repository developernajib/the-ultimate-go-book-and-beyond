export default `## 12.3 Fan-Out / Fan-In Pattern

Distribute work across multiple goroutines and merge results.

### Fan-Out: Distributing Work

Fan-out replicates items from a single input channel across multiple worker channels so that N goroutines can consume and process them in parallel. The double-select inside each worker goroutine handles both context cancellation and input channel closure cleanly, preventing goroutine leaks regardless of which event occurs first.

\`\`\`go
// FanOut distributes input to multiple workers
func FanOut[T any](ctx context.Context, in <-chan T, workers int) []<-chan T {
    outputs := make([]<-chan T, workers)

    for i := 0; i < workers; i++ {
        out := make(chan T)
        outputs[i] = out

        go func(out chan<- T) {
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
        }(out)
    }

    return outputs
}

// FanOutWithProcess distributes and processes in workers
func FanOutWithProcess[In, Out any](
    ctx context.Context,
    in <-chan In,
    workers int,
    process func(In) Out,
) []<-chan Out {

    outputs := make([]<-chan Out, workers)

    for i := 0; i < workers; i++ {
        out := make(chan Out)
        outputs[i] = out

        go func(out chan<- Out) {
            defer close(out)
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-in:
                    if !ok {
                        return
                    }
                    result := process(v)
                    select {
                    case <-ctx.Done():
                        return
                    case out <- result:
                    }
                }
            }
        }(out)
    }

    return outputs
}
\`\`\`

### Fan-In: Merging Results

Fan-in is the complementary operation to fan-out: it collects the outputs of multiple worker channels and funnels them into a single output channel. A \`sync.WaitGroup\` coordinates all the multiplexer goroutines so the output channel is only closed once every input source has been fully drained. The ordered variant uses per-channel sequence maps and a post-drain emission pass to restore original arrival order when result ordering matters.

\`\`\`go
// FanIn merges multiple channels into one
func FanIn[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    out := make(chan T)
    var wg sync.WaitGroup

    // Multiplexer for each input channel
    multiplex := func(ch <-chan T) {
        defer wg.Done()
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-ch:
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
    }

    wg.Add(len(channels))
    for _, ch := range channels {
        go multiplex(ch)
    }

    // Close output when all inputs done
    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}

// FanInOrdered maintains input order (requires buffering)
func FanInOrdered[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    type indexed struct {
        value T
        index int
        seq   int
    }

    out := make(chan T)

    // Buffer for out-of-order results
    buffer := make(map[int]map[int]T) // channel index -> seq -> value
    for i := range channels {
        buffer[i] = make(map[int]T)
    }

    var mu sync.Mutex
    var wg sync.WaitGroup

    // Collect from each channel with sequence numbers
    for i, ch := range channels {
        wg.Add(1)
        go func(idx int, ch <-chan T) {
            defer wg.Done()
            seq := 0
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-ch:
                    if !ok {
                        return
                    }
                    mu.Lock()
                    buffer[idx][seq] = v
                    seq++
                    mu.Unlock()
                }
            }
        }(i, ch)
    }

    // Emit in order
    go func() {
        defer close(out)
        wg.Wait()

        // Emit all buffered values in order
        for i := range channels {
            for seq := 0; ; seq++ {
                mu.Lock()
                v, exists := buffer[i][seq]
                mu.Unlock()
                if !exists {
                    break
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
\`\`\`

### Complete Fan-Out/Fan-In Example

This end-to-end example ties together both halves of the pattern into a single reusable \`ProcessParallel\` helper. It feeds a slice of inputs into a channel, fans those items out to a configurable number of worker goroutines each running a caller-supplied \`process\` function, and then fans the worker outputs back into one channel before collecting results into a slice. The URL-fetching usage demonstrates a real-world scenario where the bottleneck is I/O latency and parallelism provides a direct throughput gain.

\`\`\`go
// ProcessParallel distributes work and collects results
func ProcessParallel[In, Out any](
    ctx context.Context,
    inputs []In,
    workers int,
    process func(In) Out,
) []Out {

    // Create input channel
    in := make(chan In)
    go func() {
        defer close(in)
        for _, input := range inputs {
            select {
            case <-ctx.Done():
                return
            case in <- input:
            }
        }
    }()

    // Fan out to workers
    workerOutputs := FanOutWithProcess(ctx, in, workers, process)

    // Fan in results
    merged := FanIn(ctx, workerOutputs...)

    // Collect results
    var results []Out
    for result := range merged {
        results = append(results, result)
    }

    return results
}

// Usage
func main() {
    ctx := context.Background()

    urls := []string{
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        // ... many more URLs
    }

    responses := ProcessParallel(ctx, urls, 10, func(url string) string {
        resp, err := http.Get(url)
        if err != nil {
            return fmt.Sprintf("error: %v", err)
        }
        defer resp.Body.Close()
        return resp.Status
    })

    for _, resp := range responses {
        fmt.Println(resp)
    }
}
\`\`\`

### Sizing the Fan-Out

The right fan-out width depends on the workload:

- **CPU-bound fan-out:** width equals \`runtime.NumCPU()\`. Adding more workers just adds context-switch overhead.
- **I/O-bound fan-out:** width is bounded by the slowest of (downstream capacity, local file descriptors, memory per in-flight request). Typically in the tens to low hundreds for HTTP calls, can be more for lightweight requests.
- **Mixed fan-out:** often dominated by I/O. Use an I/O-appropriate width.

The common bug: sizing fan-out by "more seems faster" rather than measurement. Profile with the actual downstream, observe where adding more workers stops helping, pick a width at 70-80% of that saturation point so you have headroom.

### Staff Lens: Fan-Out Into Downstream Services

Fan-out from your service to a downstream is a multiplier. A fan-out of 50 from 100 RPS ingress becomes 5000 RPS on the downstream. If the downstream caps at 2000 RPS, your service burns 60% of the downstream calls into rate-limit errors. The staff-level design rule: know the downstream's capacity, size your fan-out to stay below it, coordinate with the team that owns the downstream when you need more. Fan-out is not a local decision. It is a contract with the downstream operator.

### Principal Lens: Fan-Out Across Process Boundaries

In-process fan-out works until it does not. At some scale, the work you are parallelising belongs on separate machines (more CPU, independent failure domains, better scaling elasticity). The principal-level instinct is to recognise when the fan-out pattern has outgrown a single process and should become a distributed work queue with multiple worker instances. The signals: one process cannot handle the fan-out width needed, or the workers should survive process restart, or different workers should scale independently. When these signals appear, in-process fan-out is the wrong tool.

---
`;
