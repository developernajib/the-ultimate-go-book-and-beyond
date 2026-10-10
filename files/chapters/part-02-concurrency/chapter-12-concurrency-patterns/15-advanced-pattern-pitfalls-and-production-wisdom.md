## Advanced Pattern Pitfalls and Production Wisdom

These patterns look simple but have subtle issues that cause production problems. This section covers real-world failures and their solutions.

### Pipeline Stage Failure Propagation

Pipelines fail silently when stages don't propagate errors correctly:

```go
// WRONG: Error in stage 2 is lost, stage 3 processes invalid data
func pipelineBad() {
    stage1 := func(in <-chan Data) <-chan Data {
        out := make(chan Data)
        go func() {
            defer close(out)
            for d := range in {
                // Process and send
                out <- process1(d)
            }
        }()
        return out
    }

    stage2 := func(in <-chan Data) <-chan Data {
        out := make(chan Data)
        go func() {
            defer close(out)
            for d := range in {
                result, err := process2(d)
                if err != nil {
                    continue  // ERROR LOST! Stage 3 never knows
                }
                out <- result
            }
        }()
        return out
    }

    // If stage 2 has errors, stage 3 processes incomplete data
}

// CORRECT: Use errgroup with shared context
func pipelineGood(ctx context.Context, input <-chan Data) ([]Result, error) {
    g, ctx := errgroup.WithContext(ctx)

    // Stage 1
    stage1Out := make(chan Data, 100)
    g.Go(func() error {
        defer close(stage1Out)
        for {
            select {
            case d, ok := <-input:
                if !ok {
                    return nil
                }
                result, err := process1(d)
                if err != nil {
                    return fmt.Errorf("stage1: %w", err)  // Stops all stages
                }
                select {
                case stage1Out <- result:
                case <-ctx.Done():
                    return ctx.Err()
                }
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    })

    // Stage 2 - collects results
    var results []Result
    var mu sync.Mutex
    g.Go(func() error {
        for {
            select {
            case d, ok := <-stage1Out:
                if !ok {
                    return nil
                }
                result, err := process2(d)
                if err != nil {
                    return fmt.Errorf("stage2: %w", err)
                }
                mu.Lock()
                results = append(results, result)
                mu.Unlock()
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    })

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

### Fan-Out Worker Starvation

When all workers read from a single shared channel, Go's runtime scheduler decides which goroutine receives the next value. If one worker picks up a job that takes 10 minutes while the others finish their fast jobs, those idle workers still compete for new items normally, there is no "starvation" in the scheduler sense. The real problem is *head-of-line blocking*: that one slow job ties up a worker slot for its entire duration. A work-stealing design mitigates this by giving each worker its own queue and allowing idle workers to pull from other workers' queues.

```go
// PROBLEM: Work stealing doesn't happen automatically
func workerPoolBad(jobs <-chan Job, numWorkers int) {
    for i := 0; i < numWorkers; i++ {
        go func() {
            for job := range jobs {
                process(job)  // If one job is slow, that worker is stuck
            }
        }()
    }
}

// With 10 workers and 1 slow job:
// - 1 worker processes the slow job for 10 minutes
// - 9 workers process 100 fast jobs each
// - Slow job blocks one worker entirely

// CORRECT: Work-stealing with per-worker queues
type WorkStealingPool struct {
    queues   []chan Job
    workers  int
    next     atomic.Uint64 // Round-robin cursor for Submit.
    ctx      context.Context
    cancel   context.CancelFunc
    wg       sync.WaitGroup
}

func NewWorkStealingPool(workers, queueSize int) *WorkStealingPool {
    ctx, cancel := context.WithCancel(context.Background())
    p := &WorkStealingPool{
        queues:  make([]chan Job, workers),
        workers: workers,
        ctx:     ctx,
        cancel:  cancel,
    }

    for i := 0; i < workers; i++ {
        p.queues[i] = make(chan Job, queueSize)
        p.wg.Add(1)
        go p.worker(i)
    }

    return p
}

func (p *WorkStealingPool) worker(id int) {
    defer p.wg.Done()

    for {
        select {
        case <-p.ctx.Done():
            return

        case job, ok := <-p.queues[id]:
            if !ok {
                return
            }
            p.processJob(job)

        default:
            // Own queue empty, try to steal from others
            stolen := false
            for i := 0; i < p.workers && !stolen; i++ {
                if i == id {
                    continue
                }
                select {
                case job, ok := <-p.queues[i]:
                    if ok {
                        p.processJob(job)
                        stolen = true
                    }
                default:
                }
            }

            if !stolen {
                // Nothing anywhere. Park briefly rather than blocking
                // on our own queue alone: a worker blocked solely on
                // p.queues[id] stops stealing entirely and stays idle
                // while another worker's queue backs up, which defeats
                // the point of the design. The short sleep bounds the
                // busy-spin while keeping the worker in the steal loop.
                select {
                case <-p.ctx.Done():
                    return
                case job, ok := <-p.queues[id]:
                    if !ok {
                        return
                    }
                    p.processJob(job)
                case <-time.After(time.Millisecond):
                }
            }
        }
    }
}

func (p *WorkStealingPool) Submit(job Job) {
    // Round-robin submission. Reduce in unsigned space: converting the
    // counter to int first would go negative once it passes MaxInt64,
    // and a negative index panics.
    workerID := int(p.next.Add(1) % uint64(p.workers))
    select {
    case p.queues[workerID] <- job:
    case <-p.ctx.Done():
    }
}
```

### Circuit Breaker State Machine Bugs

Circuit breakers attract a specific bad idea: replace the mutex with atomics and call it lock-free. It is worth working through why that is wrong, because the reasoning that leads there sounds like performance engineering and produces a breaker that silently fails to break.

Start with what is *not* a bug. The shape below drops the lock before calling `fn` and reacquires it afterwards. That is mandatory, not a race. Holding a mutex across an arbitrary function call, which here means a network round trip, would serialize every request through the breaker and turn a resilience mechanism into the bottleneck. Never hold a lock across I/O.

```go
type SimpleCircuitBreaker struct {
    mu       sync.Mutex
    state    string // "closed", "open", "half-open"
    failures int
}

func (cb *SimpleCircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    if cb.state == "open" {
        cb.mu.Unlock()
        return ErrCircuitOpen
    }
    cb.mu.Unlock()

    // Correct: the lock is NOT held across fn. Doing so would serialize
    // every call through the breaker.
    err := fn()

    cb.mu.Lock()
    defer cb.mu.Unlock()
    if err != nil {
        cb.failures++
        if cb.failures >= 5 {
            cb.state = "open"
        }
    } else {
        cb.failures = 0 // Do not forget this. See below.
    }
    return err
}
```

The real bugs in that sketch are ordinary logic bugs, not exotic races. It never resets `failures` on success unless you add the `else` branch, so five failures spread across an hour of healthy traffic eventually trip the breaker for no reason. It has no half-open state at all, so once open it stays open forever. And its threshold is an absolute count rather than a rate, which means the trip condition depends on traffic volume. Section 12.7's breaker fixes all three, and it uses a mutex, because a mutex is the right tool here.

#### Why the atomic version does not work

The tempting rewrite loads the state atomically and switches on it:

```go
// BROKEN, despite using atomics throughout.
func (cb *CircuitBreaker) Execute(fn func() error) error {
    state := cb.state.Load() // <- the TOCTOU is right here

    switch state {
    case stateClosed:
        err := fn()
        if err != nil {
            if cb.failures.Add(1) >= cb.threshold {
                cb.state.Store(stateOpen) // Store, not CAS: clobbers.
            }
        }
        return err
    // ...
    }
}
```

Atomics did not remove the time-of-check-to-time-of-use problem, they relocated it. `state.Load()` returns a value that is already stale by the next line, and nothing prevents a hundred goroutines from all reading `stateClosed` and all calling `fn` into a downstream that just died. `Store` is worse than useless for a transition: it unconditionally overwrites, so a goroutine finishing a slow closed-state call can stamp `stateOpen` over a half-open probe that another goroutine legitimately started, silently discarding the recovery attempt.

The deeper issue is that a circuit breaker's state and its counters must change **together**. "Increment failures, and if that crosses the threshold, open" is one indivisible decision. Atomics make each individual variable indivisible, and give you nothing across two of them. That is exactly what a mutex is for. The multi-variable invariant is the whole problem, and it is why every production breaker, `sony/gobreaker` included, uses a lock.

Use the mutex breaker from section 12.7. It is correct, and the lock is not the bottleneck in anything that also makes a network call: an uncontended mutex costs tens of nanoseconds against a round trip measured in milliseconds. Optimizing that is optimizing the wrong five orders of magnitude.

### Backpressure Implementation Mistakes

Backpressure failures come in two flavors: silent data loss (dropping items with no record) and unbounded blocking (parking forever because no consumer is reading and nothing can cancel the wait). Both look correct under light load and break badly under production traffic.

Read the first example carefully, because blocking is not the mistake. Blocking is backpressure working as designed, and section 12.2 recommends it. The mistake is blocking with no way out. The examples below build from that to two workable shapes: one that drops but records the drop so it can be alerted on, and one that uses a semaphore to cap in-flight work with no loss at all.

```go
// NOT WRONG, but incomplete: blocking IS backpressure.
// The unbuffered send correctly slows the producer to the consumer's
// pace, which section 12.2 recommends as the default. The defect is the
// missing escape hatch: with no ctx case, a consumer that goes away
// leaves this goroutine parked on the send forever. Backpressure that
// cannot be cancelled is a goroutine leak.
func processorBad(in <-chan Data) <-chan Result {
    out := make(chan Result)
    go func() {
        defer close(out)
        for d := range in {
            result := heavyProcess(d)
            out <- result  // Blocks forever if the consumer is gone.
        }
    }()
    return out
}

// WRONG: Dropping data silently
func processorDropping(in <-chan Data) <-chan Result {
    out := make(chan Result, 100)
    go func() {
        defer close(out)
        for d := range in {
            result := heavyProcess(d)
            select {
            case out <- result:
            default:
                // Silently dropped! Data loss without notification
            }
        }
    }()
    return out
}

// CORRECT: Explicit backpressure with metrics
type BackpressureProcessor struct {
    input      <-chan Data
    output     chan Result
    dropped    atomic.Int64
    processed  atomic.Int64
    maxBuffer  int
    ctx        context.Context
}

func (p *BackpressureProcessor) Run() {
    defer close(p.output)

    for {
        select {
        case <-p.ctx.Done():
            return

        case d, ok := <-p.input:
            if !ok {
                return
            }

            result := heavyProcess(d)

            select {
            case p.output <- result:
                p.processed.Add(1)

            default:
                // Buffer full. Wait a bounded time before giving up.
                //
                // Count the drop only in the branch that actually drops.
                // Incrementing before the retry, as is easy to do here,
                // double-counts every item that then succeeds: it lands
                // in both `dropped` and `processed`, and the dashboard
                // reports loss that never happened.
                select {
                case p.output <- result:
                    p.processed.Add(1)
                case <-time.After(100 * time.Millisecond):
                    p.dropped.Add(1)
                    log.Printf("backpressure: dropped item, buffer full")
                case <-p.ctx.Done():
                    return
                }
            }
        }
    }
}

func (p *BackpressureProcessor) Stats() (processed, dropped int64) {
    return p.processed.Load(), p.dropped.Load()
}

// CORRECT: Semaphore-based rate limiting
type RateLimitedProcessor struct {
    sem        chan struct{}
    maxInFlight int
}

func NewRateLimitedProcessor(maxInFlight int) *RateLimitedProcessor {
    return &RateLimitedProcessor{
        sem:         make(chan struct{}, maxInFlight),
        maxInFlight: maxInFlight,
    }
}

func (p *RateLimitedProcessor) Process(ctx context.Context, d Data) (Result, error) {
    // Acquire semaphore - blocks if maxInFlight reached
    select {
    case p.sem <- struct{}{}:
        defer func() { <-p.sem }()  // Release on exit
    case <-ctx.Done():
        return Result{}, ctx.Err()
    }

    return heavyProcess(d), nil
}
```

### Pub/Sub Memory Leaks

The most insidious pub/sub bug is forgetting to close a subscriber's channel when it unsubscribes. The subscriber's goroutine blocks on a channel receive that will never complete, leaking both the goroutine and any resources it holds. Under steady subscriber churn, leaked goroutines accumulate until the process runs out of memory or file descriptors. The fix is straightforward: always close the channel when removing a subscriber, and write subscriber loops that exit cleanly on channel close via `range`.

```go
// WRONG: Subscriber channels never closed on unsubscribe
type LeakyPubSub struct {
    mu          sync.RWMutex
    subscribers map[string]chan Event
}

func (ps *LeakyPubSub) Unsubscribe(id string) {
    ps.mu.Lock()
    delete(ps.subscribers, id)  // Channel not closed!
    ps.mu.Unlock()
}

// The subscriber goroutine reading from that channel
// will block forever since channel is never closed

// CORRECT: Close channel on unsubscribe
type SafePubSub struct {
    mu          sync.RWMutex
    subscribers map[string]chan Event
    closed      bool
}

func (ps *SafePubSub) Subscribe(id string, bufSize int) <-chan Event {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        ch := make(chan Event)
        close(ch)
        return ch
    }

    ch := make(chan Event, bufSize)
    ps.subscribers[id] = ch
    return ch
}

func (ps *SafePubSub) Unsubscribe(id string) {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ch, ok := ps.subscribers[id]; ok {
        close(ch)  // Signal subscriber to exit
        delete(ps.subscribers, id)
    }
}

func (ps *SafePubSub) Close() {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        return
    }
    ps.closed = true

    for id, ch := range ps.subscribers {
        close(ch)
        delete(ps.subscribers, id)
    }
}

// Subscriber pattern - handles channel close
func subscriber(events <-chan Event) {
    for event := range events {  // Loop exits when channel closed
        process(event)
    }
    // Cleanup after channel closed
}
```

### The "Channel-First" Fallacy: Selecting the Right Concurrency Tool

Go programmers frequently memorize Rob Pike's proverb: *"Do not communicate by sharing memory; instead, share memory by communicating."* While foundational, treating this proverb as a mandate to use channels for every concurrency problem leads to complex, fragile, and slower systems.

#### The State Serializer Anti-Pattern

A recurring mistake is attempting to guard shared state (like a cache map or counter) using a dedicated goroutine and channels rather than a standard mutex:

```go
// ANTI-PATTERN: Channel-based state serializer (60+ lines of plumbing, channel allocations, leak risk)
type StateRequest struct {
    key      string
    response chan string
}

func stateSerializer(requests <-chan StateRequest) {
    state := make(map[string]string)
    for req := range requests {
        req.response <- state[req.key] // Allocates response channel per read!
    }
}
```

This pattern trades a simple, cache-friendly `sync.RWMutex` for channel allocation overhead, goroutine scheduling latency, and lifecycle leaks when callers exit early.

#### The Three-Question Decision Framework

Before choosing channels, evaluate these three architectural criteria:

1. **Coordination vs. Competition**: Are goroutines passing discrete ownership of data along a pipeline (coordination), or are multiple goroutines reading and mutating shared memory (competition)? If competing, reach for `sync.Mutex`, `sync.RWMutex`, or `sync/atomic`.
2. **Concurrency Boundaries**: Is the concurrency bounded? Sizing channel buffers is error-prone: too small causes producer stalls; too large masks downstream latency spikes. For fan-out tasks with known inputs, pre-allocated slices with index ownership avoid channels completely.
3. **Failure Ownership**: When a task errors or panics, who closes the channels and drains remaining items? Goroutines waiting on unbuffered channels leak when receivers abandon execution.

#### Structured Parallelism Without Channel Overhead

When executing parallel tasks and collecting results, using `golang.org/x/sync/errgroup` with pre-allocated result slices eliminates channel contention, buffer sizing, and goroutine leak risks:

```go
func fetchAll(ctx context.Context, urls []string) ([][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10) // Bounded concurrency (no manual semaphore channel needed)

    results := make([][]byte, len(urls)) // Pre-allocated indexed slots
    for i, url := range urls {
        i, url := i, url // Lexical capture
        g.Go(func() error {
            data, err := fetch(ctx, url)
            if err != nil {
                return fmt.Errorf("fetching %s: %w", url, err)
            }
            results[i] = data // Safe without locks: goroutine owns index i
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

> [!TIP]
> **When Channels Truly Excel**:
> 1. **Signal Broadcast & Cancellation**: Coordinating shutdown with `close(done)` or `ctx.Done()`.
> 2. **Multi-source Event Multiplexing**: Combining heterogeneous async events with `select`.
> 3. **Pipeline Stages**: Streaming data ownership between distinct producer and consumer stages.
>
> For state mutation, structured fan-out, and single-value updates, standard library primitives (`sync.Mutex`, `atomic.Int64`, `errgroup.Group`) deliver superior throughput, lower memory footprints, and zero leak hazards. For an in-depth operational analysis, see Yaninyz witty's retrospective [*Go channels aren't always the right tool*](https://medium.com/@yaninyzwitty/go-channels-aren-t-always-the-right-tool-90409fe69b56).

### Quick Reference: Pattern Selection Guide

| Scenario | Pattern | Watch Out For |
|----------|---------|---------------|
| Transform sequence | Pipeline | Error propagation |
| Parallel work | Fan-Out/Fan-In | Worker starvation |
| Bounded processing | Worker Pool | Queue depth |
| Event distribution | Pub/Sub | Memory leaks |
| External service | Circuit Breaker | State race conditions |
| Rate control | Token Bucket | Burst handling |
| Load shedding | Backpressure | Silent drops |
| Resource cleanup | Context cancellation | Goroutine leaks |

### Staff Lens: The Compound Pitfall

Individual pitfalls in this chapter are dangerous. Compound pitfalls are worse. A retry policy without jitter plus a circuit breaker that closes too aggressively creates a thundering herd on recovery. A fan-out without bounded concurrency plus a slow downstream creates a goroutine leak. A worker pool without a queue cap plus a fast producer creates unbounded memory growth. Every pattern interacts with every other pattern in the service. The staff-level discipline is reviewing pattern combinations as a whole, not individually. Most production concurrency incidents are compound pitfalls, not single-pattern bugs.

### Principal Lens: Pattern-Aware Postmortems

When a concurrency incident happens, the postmortem asks not just "what broke?" but "which pattern failed, and why?". This framing extracts the reusable lesson. "Retry without jitter amplified the downstream failure" is more useful than "service X had an outage because of retries". The principal-level investment is building the team's vocabulary so every postmortem identifies the pattern involved. Over time, the org accumulates a library of "pattern X failed in way Y" case studies, each one preventing future incidents of the same shape. This is one of the highest-value investments a principal engineer can make for a Go team operating at scale.

---
