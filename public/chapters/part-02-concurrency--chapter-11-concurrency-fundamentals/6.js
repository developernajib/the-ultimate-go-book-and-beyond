export default `## 11.5 Common Concurrency Patterns

These patterns form the vocabulary of concurrent Go programming.

### Pipeline Pattern

A pipeline chains goroutines together through channels: each stage reads from an input channel, transforms the data, and writes to an output channel. The key property is that each stage owns its output channel and closes it when done, which causes the downstream \`range\` loop to terminate naturally. Adding \`ctx.Done()\` checks in every stage ensures the entire pipeline tears down promptly when cancelled, without leaving blocked goroutines behind.

\`\`\`go
// Stage 1: Generate numbers
func generate(ctx context.Context, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case <-ctx.Done():
                return
            case out <- n:
            }
        }
    }()
    return out
}

// Stage 2: Square numbers
func square(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            select {
            case <-ctx.Done():
                return
            case out <- n * n:
            }
        }
    }()
    return out
}

// Stage 3: Filter (keep only even)
func filterEven(ctx context.Context, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            if n%2 == 0 {
                select {
                case <-ctx.Done():
                    return
                case out <- n:
                }
            }
        }
    }()
    return out
}

// Usage
func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Build pipeline: generate -> square -> filter
    nums := generate(ctx, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    squared := square(ctx, nums)
    evens := filterEven(ctx, squared)

    // Consume results
    for n := range evens {
        fmt.Println(n)  // 4, 16, 36, 64, 100
    }
}
\`\`\`

### Fan-Out Pattern

Fan-out distributes items from a single input channel across multiple worker goroutines. Each worker reads from the shared input channel, Go channels are safe for concurrent reads, so work is automatically load-balanced: faster workers pull more items. The function returns a slice of output channels, one per worker, which the caller can merge back together with fan-in.

\`\`\`go
func fanOut(ctx context.Context, input <-chan Task, workers int) []<-chan Result {
    outputs := make([]<-chan Result, workers)

    for i := 0; i < workers; i++ {
        outputs[i] = worker(ctx, input)
    }

    return outputs
}

func worker(ctx context.Context, input <-chan Task) <-chan Result {
    output := make(chan Result)

    go func() {
        defer close(output)
        for task := range input {
            select {
            case <-ctx.Done():
                return
            case output <- processTask(task):
            }
        }
    }()

    return output
}
\`\`\`

### Fan-In Pattern

Fan-in is the inverse of fan-out: it merges multiple input channels into a single output channel. A goroutine is launched for each input channel, forwarding values to the shared output. A \`WaitGroup\` tracks when all input channels have been drained, and a separate goroutine closes the output channel once \`Wait\` returns. This lets the consumer range over a single channel regardless of how many producers feed it.

\`\`\`go
func fanIn(ctx context.Context, channels ...<-chan Result) <-chan Result {
    output := make(chan Result)
    var wg sync.WaitGroup

    // Start a goroutine for each input channel
    for _, ch := range channels {
        wg.Add(1)
        go func(c <-chan Result) {
            defer wg.Done()
            for result := range c {
                select {
                case <-ctx.Done():
                    return
                case output <- result:
                }
            }
        }(ch)
    }

    // Close output when all inputs are done
    go func() {
        wg.Wait()
        close(output)
    }()

    return output
}

// Usage
func processAll(ctx context.Context, tasks <-chan Task) <-chan Result {
    // Fan out to 4 workers
    workerOutputs := fanOut(ctx, tasks, 4)

    // Fan in all results
    return fanIn(ctx, workerOutputs...)
}
\`\`\`

### Worker Pool Pattern

A worker pool fixes the number of goroutines up front and feeds them through a shared jobs channel, giving you bounded concurrency with predictable resource usage. Workers block on the jobs channel when idle and wake up automatically when work arrives. Closing the jobs channel signals all workers to drain remaining items and exit, and the \`WaitGroup\` ensures \`Close\` blocks until every worker has finished.

\`\`\`go
type WorkerPool struct {
    jobs       chan Job
    results    chan Result
    numWorkers int
    wg         sync.WaitGroup
}

func NewWorkerPool(numWorkers, jobQueueSize int) *WorkerPool {
    return &WorkerPool{
        jobs:       make(chan Job, jobQueueSize),
        results:    make(chan Result, jobQueueSize),
        numWorkers: numWorkers,
    }
}

func (wp *WorkerPool) Start(ctx context.Context) {
    for i := 0; i < wp.numWorkers; i++ {
        wp.wg.Add(1)
        go wp.worker(ctx, i)
    }
}

func (wp *WorkerPool) worker(ctx context.Context, id int) {
    defer wp.wg.Done()

    for {
        select {
        case <-ctx.Done():
            return
        case job, ok := <-wp.jobs:
            if !ok {
                return
            }
            result := processJob(job)

            select {
            case <-ctx.Done():
                return
            case wp.results <- result:
            }
        }
    }
}

func (wp *WorkerPool) Submit(job Job) {
    wp.jobs <- job
}

func (wp *WorkerPool) Results() <-chan Result {
    return wp.results
}

func (wp *WorkerPool) Close() {
    close(wp.jobs)
    wp.wg.Wait()
    close(wp.results)
}
\`\`\`

### Semaphore Pattern

A semaphore limits how many goroutines can perform an operation at the same time. In Go, a buffered channel of empty structs is a natural semaphore: acquiring a slot sends into the channel (blocking when the buffer is full), and releasing drains one element. The \`TryAcquire\` variant uses a \`default\` case for non-blocking attempts, returning immediately if no slot is available.

\`\`\`go
type Semaphore struct {
    sem chan struct{}
}

func NewSemaphore(max int) *Semaphore {
    return &Semaphore{
        sem: make(chan struct{}, max),
    }
}

func (s *Semaphore) Acquire(ctx context.Context) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case s.sem <- struct{}{}:
        return nil
    }
}

func (s *Semaphore) Release() {
    <-s.sem
}

func (s *Semaphore) TryAcquire() bool {
    select {
    case s.sem <- struct{}{}:
        return true
    default:
        return false
    }
}

// Usage
func fetchAllURLs(ctx context.Context, urls []string) []Response {
    sem := NewSemaphore(10)  // Max 10 concurrent fetches
    results := make([]Response, len(urls))
    var wg sync.WaitGroup

    for i, url := range urls {
        wg.Add(1)
        go func(idx int, u string) {
            defer wg.Done()

            if err := sem.Acquire(ctx); err != nil {
                return
            }
            defer sem.Release()

            results[idx] = fetch(u)
        }(i, url)
    }

    wg.Wait()
    return results
}
\`\`\`

### Or-Done Channel Pattern

Reading from a channel with \`range\` is convenient, but it ignores context cancellation, if the upstream producer stops sending without closing the channel, the consumer blocks forever. The or-done pattern wraps any input channel so that reads also respect a context's \`Done\` channel, ensuring the consumer exits promptly on cancellation or timeout rather than leaking.

\`\`\`go
func orDone(ctx context.Context, c <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-c:
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

// Usage
func processWithTimeout(in <-chan int) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    for v := range orDone(ctx, in) {
        process(v)
    }
}
\`\`\`

### Tee Channel Pattern

The tee pattern duplicates every value from one input channel to two output channels, similar to the Unix \`tee\` command. Each value must be sent to both outputs before the next value is read, so the implementation uses nil-channel disabling inside a two-iteration inner loop to ensure both sends complete regardless of which output is ready first.

\`\`\`go
func tee(ctx context.Context, in <-chan int) (<-chan int, <-chan int) {
    out1 := make(chan int)
    out2 := make(chan int)

    go func() {
        defer close(out1)
        defer close(out2)

        for v := range orDone(ctx, in) {
            // Send to both (need local copies for select)
            o1, o2 := out1, out2
            for i := 0; i < 2; i++ {
                select {
                case <-ctx.Done():
                    return
                case o1 <- v:
                    o1 = nil  // Disable after send
                case o2 <- v:
                    o2 = nil  // Disable after send
                }
            }
        }
    }()

    return out1, out2
}
\`\`\`

### Prefer the stdlib and \`x/sync\` Over Hand-Rolled Primitives

Several of the patterns above have canonical implementations in \`golang.org/x/sync\`:

- **Semaphore.** \`golang.org/x/sync/semaphore.Weighted\` is the canonical weighted semaphore. Use it instead of the buffered-channel pattern above when weights matter, when the acquire cost matters, or when you want the standard shape that every Go engineer recognises.
- **Errgroup.** \`golang.org/x/sync/errgroup.Group\` wraps the fan-out-with-error-propagation pattern. Use it instead of hand-rolled WaitGroup plus error channel. It also supports context propagation and cancellation on first error.
- **Singleflight.** \`golang.org/x/sync/singleflight.Group\` collapses duplicate concurrent requests for the same key into one. This is the right primitive for cache miss stampedes and thundering herds.

In modern Go, the buffered-channel semaphore is teaching material, not production code. Show the pattern, then point readers at \`x/sync/semaphore\`. Same with hand-rolled errgroup. The stdlib and \`x/sync\` implementations have been battle-tested at scale and include features (weighted acquires, bounded contexts) that the hand-rolled versions lack.

### Bounded Concurrency Is Not Optional

Every fan-out pattern in production Go must have a bound. Unbounded fan-out is a denial-of-service attack on yourself: a slow downstream dependency causes goroutines to pile up until memory is exhausted. The pattern:

\`\`\`go
sem := semaphore.NewWeighted(int64(maxConcurrent))
for _, item := range items {
    if err := sem.Acquire(ctx, 1); err != nil { break }
    go func(item Item) {
        defer sem.Release(1)
        process(item)
    }(item)
}
\`\`\`

The staff-level rule: unbounded \`for _, x := range items { go ... }\` is always a review finding. Always. Either bound the concurrency or document why unbounded is acceptable (the slice is guaranteed to be small, the downstream has no failure modes). In 99% of cases it is the first.

### Pipeline Correctness Checklist

A correct pipeline satisfies these properties. Verify in review:

1. **Every stage closes its output channel.** Always via \`defer close(out)\` at the top of the goroutine.
2. **Every stage respects context cancellation.** Both when reading from input (range-with-select) and when writing to output (select on output send vs. Done).
3. **The pipeline has a defined termination condition.** Usually the input channel closes, which cascades to subsequent stages.
4. **Back-pressure propagates correctly.** A slow stage blocks the upstream via unbuffered channels. If a buffer is introduced, the buffer size is justified.
5. **Errors have a propagation path.** See the error-handling section. Pipelines that cannot propagate errors are incomplete.

### Staff Lens: Patterns as the Team's Concurrent Vocabulary

The patterns in this chapter should not each be reinvented in every service. The staff-level deliverable is a small internal package (often called \`concurrent\` or \`ctl\` or similar) that exposes the team's canonical implementations: worker pool, fan-in, pipeline helpers, or-done. Every service imports it. Every engineer recognises the shape. Review time drops. Concurrency bugs drop with it. Without this, every team rediscovers the same footguns and writes the same boilerplate with slightly different shapes that all need review individually.

### Principal Lens: Patterns for the Workload You Have

The patterns here assume a homogeneous workload. Production workloads are rarely homogeneous. A fan-out that works for one type of request item may be completely wrong for another. Principal-level concurrency design asks: what is the distribution of work per item, what is the failure rate, what are the latency characteristics of downstream dependencies, and how does the pattern degrade under tail-latency events. Sometimes the answer is different patterns per request class (gold-tier requests get dedicated workers, silver-tier share a pool). Sometimes it is adaptive pool sizing based on queue depth. The patterns in this chapter are the starting vocabulary. The real design is the one that matches the specific workload.

---
`;
