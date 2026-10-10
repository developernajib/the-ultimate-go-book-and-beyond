## 12.3 Fan-Out / Fan-In Pattern

Distribute work across multiple goroutines and merge results.

### Fan-Out: Distributing Work

Fan-out distributes items from a single input channel across multiple worker goroutines so they can be processed in parallel. Distributes, not replicates: each item is delivered to exactly one worker, because a channel hands each value to a single receiver. If you want every worker to see every item, that is the broadcast or tee pattern, and it is a different thing entirely.

The double-select inside each worker handles both context cancellation and input channel closure cleanly, preventing goroutine leaks regardless of which event occurs first.

```go
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
```

### Fan-In: Merging Results

Fan-in is the complementary operation to fan-out: it collects the outputs of multiple worker channels and funnels them into a single output channel. A `sync.WaitGroup` coordinates all the multiplexer goroutines so the output channel is only closed once every input source has been fully drained.

Fan-in destroys ordering, and there is no way around that at the merge step. Once N workers are racing, the order in which their results arrive is a function of how long each item took, which is exactly the thing you parallelized away. No amount of cleverness inside the merge can reconstruct an order the merge never saw.

The fix has to happen at fan-out, not fan-in: tag each item with its input index on the way in, then reassemble by that index on the way out. `ProcessParallelOrdered` below does this, and it is worth noticing that the reassembly step is not a channel pattern at all. It is a slice write to a distinct index per item, which needs no synchronization because no two workers ever touch the same slot.

```go
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

// ProcessParallelOrdered runs process over inputs with the given
// worker count and returns results in INPUT order, regardless of the
// order in which they complete.
//
// The ordering comes from carrying each item's index alongside it, not
// from the merge. Each worker writes to results[job.idx], a slot no
// other worker can touch, so the writes need no lock and the -race
// detector stays quiet.
func ProcessParallelOrdered[In, Out any](
    ctx context.Context,
    inputs []In,
    workers int,
    process func(context.Context, In) Out,
) []Out {

    type job struct {
        idx  int
        item In
    }

    results := make([]Out, len(inputs))
    jobs := make(chan job)

    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range jobs {
                results[j.idx] = process(ctx, j.item)
            }
        }()
    }

    // Feed the workers, honouring cancellation.
    for i, item := range inputs {
        select {
        case <-ctx.Done():
            close(jobs)
            wg.Wait()
            return results
        case jobs <- job{idx: i, item: item}:
        }
    }
    close(jobs)
    wg.Wait()

    return results
}
```

Note what is absent: no fan-in, no merge channel, no `WaitGroup` closing an output. When you need ordered results, the ordered container *is* the collection point, and reaching for a merge channel only to sort afterwards is strictly more machinery for strictly less clarity. `FanIn` earns its place when results are genuinely order-independent and you want them streamed as they arrive rather than collected into a slice.

### Complete Fan-Out/Fan-In Example

This end-to-end example ties together both halves of the pattern into a single reusable `ProcessParallel` helper. It feeds a slice of inputs into a channel, fans those items out to a configurable number of worker goroutines each running a caller-supplied `process` function, and then fans the worker outputs back into one channel before collecting results into a slice. The URL-fetching usage demonstrates a real-world scenario where the bottleneck is I/O latency and parallelism provides a direct throughput gain.

```go
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
        // Build the request with the context so a cancelled ctx aborts
        // the in-flight HTTP call. http.Get would ignore cancellation
        // and keep the worker busy long after the caller gave up.
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return fmt.Sprintf("error: %v", err)
        }
        resp, err := http.DefaultClient.Do(req)
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
```

### Sizing the Fan-Out

The right fan-out width depends on the workload:

- **CPU-bound fan-out:** width equals `runtime.NumCPU()`. Adding more workers just adds context-switch overhead.
- **I/O-bound fan-out:** width is bounded by the slowest of (downstream capacity, local file descriptors, memory per in-flight request). Typically in the tens to low hundreds for HTTP calls, can be more for lightweight requests.
- **Mixed fan-out:** often dominated by I/O. Use an I/O-appropriate width.

The common bug: sizing fan-out by "more seems faster" rather than measurement. Profile with the actual downstream, observe where adding more workers stops helping, pick a width at 70-80% of that saturation point so you have headroom.

### Staff Lens: Fan-Out Into Downstream Services

Fan-out from your service to a downstream is a multiplier. A fan-out of 50 from 100 RPS ingress becomes 5000 RPS on the downstream. If the downstream caps at 2000 RPS, your service burns 60% of the downstream calls into rate-limit errors. The staff-level design rule: know the downstream's capacity, size your fan-out to stay below it, coordinate with the team that owns the downstream when you need more. Fan-out is not a local decision. It is a contract with the downstream operator.

### Principal Lens: Fan-Out Across Process Boundaries

In-process fan-out works until it does not. At some scale, the work you are parallelizing belongs on separate machines (more CPU, independent failure domains, better scaling elasticity). The principal-level instinct is to recognize when the fan-out pattern has outgrown a single process and should become a distributed work queue with multiple worker instances. The signals: one process cannot handle the fan-out width needed, or the workers should survive process restart, or different workers should scale independently. When these signals appear, in-process fan-out is the wrong tool.

---
