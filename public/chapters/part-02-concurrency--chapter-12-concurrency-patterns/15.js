export default `## Advanced Pattern Pitfalls and Production Wisdom

These patterns look simple but have subtle issues that cause production problems. This section covers real-world failures and their solutions.

### Pipeline Stage Failure Propagation

Pipelines fail silently when stages don't propagate errors correctly:

\`\`\`go
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
\`\`\`

### Fan-Out Worker Starvation

When all workers read from a single shared channel, Go's runtime scheduler decides which goroutine receives the next value. If one worker picks up a job that takes 10 minutes while the others finish their fast jobs, those idle workers still compete for new items normally, there is no "starvation" in the scheduler sense. The real problem is *head-of-line blocking*: that one slow job ties up a worker slot for its entire duration. A work-stealing design mitigates this by giving each worker its own queue and allowing idle workers to pull from other workers' queues.

\`\`\`go
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
                // No work to steal, wait on own queue
                select {
                case <-p.ctx.Done():
                    return
                case job, ok := <-p.queues[id]:
                    if !ok {
                        return
                    }
                    p.processJob(job)
                }
            }
        }
    }
}

func (p *WorkStealingPool) Submit(job Job) {
    // Round-robin submission
    workerID := int(atomic.AddUint64(&counter, 1)) % p.workers
    select {
    case p.queues[workerID] <- job:
    case <-p.ctx.Done():
    }
}
\`\`\`

### Circuit Breaker State Machine Bugs

The most common circuit breaker bug is a time-of-check-to-time-of-use (TOCTOU) race: checking the state under a lock, releasing the lock, executing the request, then re-acquiring the lock to update counters. Between the unlock and re-lock, another goroutine can change the state, leading to incorrect transitions. The mutex-based approach shown first illustrates this flaw. The atomic version eliminates it by using \`CompareAndSwap\` for state transitions, guaranteeing that only one goroutine performs the closed-to-open or open-to-half-open transition.

\`\`\`go
// WRONG: Race condition in state transitions
type BadCircuitBreaker struct {
    failures int
    state    string  // "closed", "open", "half-open"
    mu       sync.Mutex
}

func (cb *BadCircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    if cb.state == "open" {
        cb.mu.Unlock()  // RACE: State could change here!
        return ErrCircuitOpen
    }
    cb.mu.Unlock()

    err := fn()  // Execute without lock

    cb.mu.Lock()
    if err != nil {
        cb.failures++  // RACE: Failures could be reset by another goroutine
        if cb.failures >= 5 {
            cb.state = "open"
        }
    }
    cb.mu.Unlock()

    return err
}

// CORRECT: Atomic state machine
type CircuitBreaker struct {
    state         atomic.Uint32
    failures      atomic.Int64
    lastFailure   atomic.Int64
    successCount  atomic.Int64
    threshold     int64
    resetTimeout  time.Duration
    halfOpenMax   int64
}

const (
    stateClosed uint32 = iota
    stateOpen
    stateHalfOpen
)

func (cb *CircuitBreaker) Execute(fn func() error) error {
    state := cb.state.Load()

    switch state {
    case stateOpen:
        // Check if reset timeout has passed
        lastFail := cb.lastFailure.Load()
        if time.Now().UnixNano()-lastFail < int64(cb.resetTimeout) {
            return ErrCircuitOpen
        }
        // Try to transition to half-open
        if !cb.state.CompareAndSwap(stateOpen, stateHalfOpen) {
            return ErrCircuitOpen  // Another goroutine beat us
        }
        cb.successCount.Store(0)
        fallthrough

    case stateHalfOpen:
        err := fn()
        if err != nil {
            // Back to open
            cb.state.Store(stateOpen)
            cb.lastFailure.Store(time.Now().UnixNano())
            return err
        }
        // Track successes
        successes := cb.successCount.Add(1)
        if successes >= cb.halfOpenMax {
            cb.state.Store(stateClosed)
            cb.failures.Store(0)
        }
        return nil

    case stateClosed:
        err := fn()
        if err != nil {
            failures := cb.failures.Add(1)
            cb.lastFailure.Store(time.Now().UnixNano())
            if failures >= cb.threshold {
                cb.state.Store(stateOpen)
            }
            return err
        }
        // Success in closed state - optionally decay failures
        return nil
    }

    return errors.New("invalid circuit breaker state")
}
\`\`\`

### Backpressure Implementation Mistakes

Backpressure failures come in two flavors: silent data loss (dropping items with no record) and silent deadlocks (blocking forever because no consumer is reading). Both appear correct under light load and break catastrophically under production traffic. The examples below show three flawed approaches followed by two correct ones, one that drops items but tracks the count for alerting, and one that uses a semaphore to cap in-flight operations without any data loss.

\`\`\`go
// WRONG: Implicit backpressure through blocking
func processorBad(in <-chan Data) <-chan Result {
    out := make(chan Result)  // Unbuffered - blocks if consumer slow
    go func() {
        defer close(out)
        for d := range in {
            result := heavyProcess(d)
            out <- result  // Blocks forever if no consumer!
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
                // Buffer full - apply backpressure strategy
                p.dropped.Add(1)

                // Option 1: Block with timeout
                select {
                case p.output <- result:
                    p.processed.Add(1)
                case <-time.After(100 * time.Millisecond):
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
\`\`\`

### Pub/Sub Memory Leaks

The most insidious pub/sub bug is forgetting to close a subscriber's channel when it unsubscribes. The subscriber's goroutine blocks on a channel receive that will never complete, leaking both the goroutine and any resources it holds. Under steady subscriber churn, leaked goroutines accumulate until the process runs out of memory or file descriptors. The fix is straightforward: always close the channel when removing a subscriber, and write subscriber loops that exit cleanly on channel close via \`range\`.

\`\`\`go
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
\`\`\`

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

When a concurrency incident happens, the postmortem asks not just "what broke?" but "which pattern failed, and why?". This framing extracts the reusable lesson. "Retry without jitter amplified the downstream failure" is more useful than "service X had an outage because of retries". The principal-level investment is building the team's vocabulary so every postmortem identifies the pattern involved. Over time, the org accumulates a library of "pattern X failed in way Y" case studies, each one preventing future incidents of the same shape. This is one of the highest-leverage investments a principal engineer can make for a Go team operating at scale.

---
`;
