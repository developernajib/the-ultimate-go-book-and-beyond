export default `## 11.14 Interview Questions

Concurrency questions are the single most common topic in FAANG Go interviews. Interviewers use them to distinguish candidates who can write goroutine code from those who can reason about it in production, including leak detection, cancellation, and the race-free coordination patterns that separate code that passes the race detector from code that merely happens to work.

> **What FAANG actually tests here**: whether you can predict whether a given channel program deadlocks, leaks goroutines, or races. whether you reach for the right synchronization primitive for the job. and whether you have debugged a goroutine leak in a running service.

### Question 1: Explain the Difference Between Concurrency and Parallelism

**What FAANG expects**: the Rob Pike distinction (concurrency is about structure, parallelism is about execution), plus the practical consequence that a concurrent Go program can run correctly on one core but benefits from many.

**Answer:**

Concurrency is about **structure** - designing a program to handle multiple tasks that can make progress independently. A concurrent program is organized to deal with many things, but doesn't necessarily execute them simultaneously.

Parallelism is about **execution** - actually running multiple tasks at the same time on different CPU cores.

Key distinctions:
- A concurrent program can run on a single core (time-slicing)
- Parallelism requires multiple cores
- Concurrency is a property of the program. Parallelism is a property of the execution environment
- You can have concurrency without parallelism (single-core system), but you can't have parallelism without concurrency in Go

Example: A web server handling 1000 connections concurrently on a single core is concurrent but not parallel. The same server on a 4-core machine might execute 4 requests in parallel at any given moment.

**Follow-ups**:
- How does \`GOMAXPROCS\` affect the parallel-vs-concurrent distinction, and what changed in Go 1.25 about container-aware defaults?
- Give an example where adding more cores does not speed up a concurrent Go program.

### Question 2: What Happens When You Send to a Nil Channel?

**What FAANG expects**: the table of nil/closed behaviors, and the idiomatic use of nil channels in select to selectively disable cases. Candidates who do not know the disable-via-nil pattern usually fail the senior bar.

**Answer:**

Sending to a nil channel **blocks forever**. This is defined behavior, not a bug.

\`\`\`go
var ch chan int  // nil channel
ch <- 1          // Blocks forever
\`\`\`

This behavior is useful in select statements to disable a case:

\`\`\`go
func merge(ch1, ch2 <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for ch1 != nil || ch2 != nil {
            select {
            case v, ok := <-ch1:
                if !ok {
                    ch1 = nil  // Disable this case
                    continue
                }
                out <- v
            case v, ok := <-ch2:
                if !ok {
                    ch2 = nil
                    continue
                }
                out <- v
            }
        }
    }()
    return out
}
\`\`\`

| Operation | Nil Channel | Closed Channel |
|-----------|-------------|----------------|
| Send | Blocks forever | Panics |
| Receive | Blocks forever | Returns zero value |
| Close | Panics | Panics |

**Follow-ups**:
- If \`close(ch)\` panics on a nil channel, how do you safely "maybe-close" a channel that may or may not have been initialized?
- Why does Go make sending to a closed channel panic rather than returning an error?

### Question 3: How Would You Implement a Rate Limiter?

**What FAANG expects**: knowledge of token bucket and leaky bucket, plus a pragmatic answer that reaches for \`golang.org/x/time/rate\` before rolling your own. The channel-based version is useful for explaining the model, not for production.

**Answer:**

Rate limiting controls how frequently operations can occur. Two practical approaches in Go use channels as the underlying mechanism.

**Token Bucket with Channel:**

\`\`\`go
type RateLimiter struct {
    tokens chan struct{}
}

func NewRateLimiter(rate int, burst int) *RateLimiter {
    rl := &RateLimiter{
        tokens: make(chan struct{}, burst),
    }

    // Fill initial tokens
    for i := 0; i < burst; i++ {
        rl.tokens <- struct{}{}
    }

    // Refill tokens at rate
    go func() {
        ticker := time.NewTicker(time.Second / time.Duration(rate))
        defer ticker.Stop()

        for range ticker.C {
            select {
            case rl.tokens <- struct{}{}:
            default:  // Bucket full
            }
        }
    }()

    return rl
}

func (rl *RateLimiter) Wait(ctx context.Context) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-rl.tokens:
        return nil
    }
}
\`\`\`

**Using time.Ticker**, a simpler variant that enforces a fixed minimum interval between operations:

\`\`\`go
type RateLimiter struct {
    ticker *time.Ticker
}

func NewRateLimiter(rate int) *RateLimiter {
    return &RateLimiter{
        ticker: time.NewTicker(time.Second / time.Duration(rate)),
    }
}

func (rl *RateLimiter) Wait() {
    <-rl.ticker.C
}
\`\`\`

For production, use \`golang.org/x/time/rate.Limiter\`. It implements token bucket with correct burst semantics, \`Wait(ctx)\`, \`Allow\`, and \`Reserve(n)\` APIs, and is the standard for Go services that need rate limiting.

**Follow-ups**:
- How would you rate-limit per-user rather than globally? (hint: sharded map of limiters)
- What is the difference between token bucket and leaky bucket algorithmically, and when would you pick leaky?

### Question 4: What Are Common Causes of Goroutine Leaks?

**What FAANG expects**: the five canonical leak causes, at least one concrete detection technique (goroutine count, pprof, \`testing/synctest\` in Go 1.25+, or Go 1.26's \`/debug/pprof/goroutineleak\`), and a production-grade prevention pattern using \`context.Context\`.

**Answer:**

1. **Blocked channel operations**: A goroutine waiting on a channel send/receive that never happens.

2. **Infinite loops without exit condition**: No context check or done channel.

3. **Missing done signal**: Producer keeps sending but consumer has stopped.

4. **Forgotten context cancellation**: Not propagating context to spawned goroutines.

5. **Deadlocks**: Circular waiting on channels or locks.

Detection and prevention:

\`\`\`go
// Prevention: Always use context or done channels
func worker(ctx context.Context, jobs <-chan Job) {
    for {
        select {
        case <-ctx.Done():
            return  // Clean exit
        case job, ok := <-jobs:
            if !ok {
                return
            }
            process(job)
        }
    }
}

// Detection: Check goroutine count (basic approach)
func TestNoLeaks(t *testing.T) {
    before := runtime.NumGoroutine()
    doSomething()
    time.Sleep(100 * time.Millisecond)
    after := runtime.NumGoroutine()
    if after > before {
        t.Error("goroutine leak detected")
    }
}

// Modern alternatives:
//   testing/synctest (experiment in 1.24, stable in 1.25, use synctest.Test): deterministic bubble
//   go.uber.org/goleak: mature third-party detector that filters known safe goroutines
//   /debug/pprof/goroutineleak (Go 1.26, opt-in via GOEXPERIMENT=goroutineleakprofile):
//     runtime profile of goroutines blocked on unreachable primitives
\`\`\`

**Follow-ups**:
- Walk me through using \`go.uber.org/goleak\` in a test suite, and why it beats a raw \`runtime.NumGoroutine()\` check.
- How does \`testing/synctest\` in Go 1.25 change the test-for-leaks story?

### Question 5: Design a Worker Pool That Handles Errors and Retries

**What FAANG expects**: a pool with bounded workers, a cancellation-aware job submission path, exponential backoff with jitter, and a clean shutdown. Bonus: you recognize that \`errgroup\` or \`conc\` usually beats a hand-rolled pool for most real cases.

**Answer:**

The pool below uses a fixed set of goroutines pulling from a shared jobs channel. Each worker retries failed jobs with exponential backoff (100ms, 200ms, 300ms...) up to a configurable maximum. Results flow back through a separate channel, and closing the jobs channel triggers graceful shutdown.

\`\`\`go
type WorkerPool struct {
    jobs       chan Job
    results    chan Result
    wg         sync.WaitGroup
    maxRetries int
}

type Job struct {
    ID      string
    Payload any
    Attempt int
}

type Result struct {
    JobID   string
    Success bool
    Error   error
    Output  any
}

func NewWorkerPool(workers, queueSize, maxRetries int) *WorkerPool {
    wp := &WorkerPool{
        jobs:       make(chan Job, queueSize),
        results:    make(chan Result, queueSize),
        maxRetries: maxRetries,
    }

    for i := 0; i < workers; i++ {
        wp.wg.Add(1)
        go wp.worker(i)
    }

    return wp
}

func (wp *WorkerPool) worker(id int) {
    defer wp.wg.Done()

    for job := range wp.jobs {
        result := wp.processWithRetry(job)
        wp.results <- result
    }
}

func (wp *WorkerPool) processWithRetry(job Job) Result {
    for attempt := 0; attempt <= wp.maxRetries; attempt++ {
        job.Attempt = attempt

        output, err := process(job)
        if err == nil {
            return Result{
                JobID:   job.ID,
                Success: true,
                Output:  output,
            }
        }

        if attempt < wp.maxRetries {
            time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
        }
    }

    return Result{
        JobID:   job.ID,
        Success: false,
        Error:   fmt.Errorf("max retries exceeded"),
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

The retry schedule above is linear. For production, use exponential backoff with jitter (e.g. \`cenkalti/backoff\` or \`github.com/avast/retry-go\`) to avoid synchronized retry storms that take down a recovering downstream. For most pool-like workloads, \`golang.org/x/sync/errgroup.Group.SetLimit(n)\` gives you a bounded parallel runner with error propagation in a fraction of the code.

**Follow-ups**:
- How would you add bounded backpressure so that \`Submit\` blocks rather than buffers unbounded jobs?
- What is the retry-storm problem, and why does jitter prevent it?

### Q (Senior track): Walk through diagnosing a goroutine leak in a production service.

**What FAANG expects**: a concrete workflow with specific tools and specific signals, not a vague "check the code".

**Answer**: Five-step workflow.

1. **Confirm the leak in metrics.** \`runtime.NumGoroutine()\` should be graphed as a Prometheus metric. A leak shows as monotonically rising goroutines over hours. Fluctuation is normal; monotonicity is the tell.
2. **Capture two goroutine dumps 60 seconds apart.** \`curl http://service/debug/pprof/goroutine?debug=2 > t0.txt; sleep 60; curl .../goroutine?debug=2 > t1.txt\`. Diff them.
3. **Bucket by stack.** Goroutines leak in families that share a stack. Find the dominant stack in the growing population. Usually 90% of the leak is one stack.
4. **Read the stack to find the blocked line.** The goroutine is parked on some primitive: \`chansend1\`, \`chanrecv1\`, \`semacquire\`, \`runtime.gopark\`. Trace back to the application code one frame deeper.
5. **Fix the lifetime.** Nine times out of ten, the goroutine does not respect context cancellation, or a channel's sender never terminates. Add the context check or fix the sender.

Bonus credit: mention \`go.uber.org/goleak\` in CI as prevention for the next leak, and \`/debug/pprof/goroutineleak\` (Go 1.26 experiment) for runtime detection.

**Follow-ups**:
- What metrics would you add to detect this faster next time?
- How would you test that your fix actually prevents the leak?

### Q (Staff track): A service with 10 microservices starts timing out under load. Goroutine counts are climbing. Walk through how you lead the incident.

**What FAANG expects at staff**: an incident-command style answer that prioritises mitigation, communication, diagnosis, and permanent fix in that order.

**Answer**:

**Phase 1, mitigate (first 15 minutes).** Take steps that stop the bleeding without needing to understand the cause. Roll back the most recent deploy if any. Scale horizontally to add capacity. Apply a temporary rate limit at the edge. The goal is service health, not root cause.

**Phase 2, diagnose (15 to 60 minutes).** While mitigation is in place, capture goroutine dumps from each affected service. Identify the service where goroutines are piling up fastest. That is the primary suspect. From its goroutine dump, identify the dominant stack. That points to the code that needs to change.

**Phase 3, fix (1 to 4 hours).** Write the fix, test it locally with the race detector and goleak, deploy to staging, measure, deploy to one production instance, measure, then gradually roll out.

**Phase 4, postmortem (within a week).** Document the incident. Identify the systemic failure: why did this reach production? What tooling or discipline would have caught it? Write follow-up work items with owners and dates. Examples: add goleak to CI, add goroutine-count alert, add canary instance at every deploy.

The staff-level distinction: every step is documented, every decision is communicated to the incident channel, the on-call engineers are supported rather than blamed, and the postmortem focuses on systemic prevention rather than the specific bug.

**Follow-ups**:
- How do you communicate with the business during the incident?
- What if the rollback also has the same bug (the leak was always there, just masked)?

### Q (Staff track): Your team is building a new service. Walk through your concurrency design checklist.

**What FAANG expects**: a reusable checklist, not a one-off answer. Staff engineers systematise.

**Answer**: Eight items.

1. **What is the workload shape?** CPU-bound, I/O-bound, or mixed? Determines whether concurrency or parallelism dominates.
2. **What are the concurrency boundaries?** Every fan-out, every pool, every goroutine creation point. Each gets a bounded limit.
3. **What cancels what?** Trace the context propagation path from request entry to deepest I/O call. If anything does not take context, fix it.
4. **What goroutines outlive a single request?** These are long-running goroutines with their own lifetime. Name them. Give them metrics. Give them panic recovery.
5. **What errors can occur, and how do they propagate?** Every goroutine has an error path. \`errgroup\` by default.
6. **What happens on shutdown?** Graceful drain plan. SIGTERM handler. Bounded shutdown deadline. Persisted state for in-flight work if applicable.
7. **What metrics expose the concurrency health?** Goroutine count, queue depth, active-worker count, rate-limited request count, timeout count.
8. **What test strategy covers the concurrent paths?** Race detector, \`goleak\`, \`synctest\` for time-dependent code, load test for contention.

This checklist goes into the service design doc. Every service. Review it at design time. The staff-level win is that the team internalises the checklist and self-applies it, eventually without needing you in every design review.

**Follow-ups**:
- Which of these have you seen skipped most often, and what goes wrong?
- How do you roll this out to a team that does not currently use a design checklist?

---
`;
