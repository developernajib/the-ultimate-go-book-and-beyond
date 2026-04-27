export default `## 12.13 Exercises with Solutions

### Exercise 1: Build a Pipeline with Error Recovery

**Problem:** Create a pipeline that continues processing even when individual items fail, collecting errors separately.

**Solution:**

\`\`\`go
func ResilientPipeline[T any](
    ctx context.Context,
    input <-chan T,
    stages []func(T) (T, error),
    onError func(T, error),
) <-chan T {

    output := make(chan T)

    go func() {
        defer close(output)

        for item := range input {
            current := item
            failed := false

            for _, stage := range stages {
                select {
                case <-ctx.Done():
                    return
                default:
                }

                result, err := stage(current)
                if err != nil {
                    if onError != nil {
                        onError(item, err)
                    }
                    failed = true
                    break
                }
                current = result
            }

            if !failed {
                select {
                case <-ctx.Done():
                    return
                case output <- current:
                }
            }
        }
    }()

    return output
}
\`\`\`

### Exercise 2: Dynamic Worker Pool

**Problem:** Create a worker pool that scales between min and max workers based on queue depth.

**Solution:**

\`\`\`go
type AutoScalingPool struct {
    minWorkers   int
    maxWorkers   int
    queueSize    int

    jobs         chan func()
    activeWorkers atomic.Int32

    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup
}

func NewAutoScalingPool(min, max, queueSize int) *AutoScalingPool {
    ctx, cancel := context.WithCancel(context.Background())

    pool := &AutoScalingPool{
        minWorkers: min,
        maxWorkers: max,
        queueSize:  queueSize,
        jobs:       make(chan func(), queueSize),
        ctx:        ctx,
        cancel:     cancel,
    }

    // Start minimum workers
    for i := 0; i < min; i++ {
        pool.startWorker()
    }

    // Start autoscaler
    go pool.autoscale()

    return pool
}

func (p *AutoScalingPool) startWorker() {
    p.activeWorkers.Add(1)
    p.wg.Add(1)

    go func() {
        defer p.wg.Done()
        defer p.activeWorkers.Add(-1)

        idleTimeout := time.NewTimer(30 * time.Second)
        defer idleTimeout.Stop()

        for {
            select {
            case <-p.ctx.Done():
                return
            case job, ok := <-p.jobs:
                if !ok {
                    return
                }
                idleTimeout.Reset(30 * time.Second)
                job()
            case <-idleTimeout.C:
                if int(p.activeWorkers.Load()) > p.minWorkers {
                    return
                }
                idleTimeout.Reset(30 * time.Second)
            }
        }
    }()
}

func (p *AutoScalingPool) autoscale() {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            queueLen := len(p.jobs)
            workers := int(p.activeWorkers.Load())

            // Scale up if queue is building
            if queueLen > workers && workers < p.maxWorkers {
                p.startWorker()
            }
        }
    }
}

func (p *AutoScalingPool) Submit(job func()) {
    select {
    case <-p.ctx.Done():
        return
    case p.jobs <- job:
    }
}

func (p *AutoScalingPool) Close() {
    p.cancel()
    close(p.jobs)
    p.wg.Wait()
}
\`\`\`

### Exercise 3: Pub/Sub with Replay

**Problem:** Implement pub/sub that can replay the last N messages to new subscribers.

**Solution:**

\`\`\`go
type ReplayPubSub[T any] struct {
    mu           sync.RWMutex
    subscribers  map[int]chan T
    nextID       int
    replayBuffer []T
    maxReplay    int
    closed       bool
}

func NewReplayPubSub[T any](maxReplay int) *ReplayPubSub[T] {
    return &ReplayPubSub[T]{
        subscribers:  make(map[int]chan T),
        replayBuffer: make([]T, 0, maxReplay),
        maxReplay:    maxReplay,
    }
}

func (ps *ReplayPubSub[T]) Subscribe(bufferSize int) (<-chan T, func()) {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        ch := make(chan T)
        close(ch)
        return ch, func() {}
    }

    ch := make(chan T, bufferSize)
    id := ps.nextID
    ps.nextID++
    ps.subscribers[id] = ch

    // Replay historical messages
    for _, msg := range ps.replayBuffer {
        select {
        case ch <- msg:
        default:
            // Buffer full, skip replay
        }
    }

    return ch, func() {
        ps.mu.Lock()
        defer ps.mu.Unlock()
        delete(ps.subscribers, id)
        close(ch)
    }
}

func (ps *ReplayPubSub[T]) Publish(msg T) {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    if ps.closed {
        return
    }

    // Add to replay buffer
    if len(ps.replayBuffer) >= ps.maxReplay {
        ps.replayBuffer = ps.replayBuffer[1:]
    }
    ps.replayBuffer = append(ps.replayBuffer, msg)

    // Send to all subscribers
    for _, ch := range ps.subscribers {
        select {
        case ch <- msg:
        default:
            // Subscriber too slow
        }
    }
}

func (ps *ReplayPubSub[T]) Close() {
    ps.mu.Lock()
    defer ps.mu.Unlock()

    ps.closed = true
    for _, ch := range ps.subscribers {
        close(ch)
    }
    ps.subscribers = nil
}
\`\`\`

### Senior at FAANG Track

5. **Pattern-library audit.** For one production service in your ownership, inventory every concurrent pattern in use. Note which are from stdlib or \`x/sync\`, which are hand-rolled, and which hand-rolled ones have production-library equivalents you could migrate to. Present findings.

6. **Pattern composition case study.** Pick one production incident from the past year at your org. Trace it back to the concurrent pattern (or missing pattern) involved. Write a one-page case study: what pattern, what went wrong, what the fix was, what prevention applies.

7. **Benchmark the hand-rolled vs library.** For one hand-rolled rate limiter or circuit breaker in your codebase, write benchmarks comparing it to \`golang.org/x/time/rate\` or \`github.com/sony/gobreaker\`. Document the performance delta and the feature gaps. Recommend migration or justify keeping the hand-rolled version.

### Staff / Principal Track

8. **Shared pattern library for the org.** Design and ship a shared internal Go package exposing canonical implementations of the patterns in this chapter: worker pool, pub/sub, rate limiter, circuit breaker, retry, sharded map. Include observability, documentation, and canonical examples. Get three teams to adopt it.

9. **Consolidation plan.** Audit the concurrency patterns across five services in your org. Identify where multiple variants of the same pattern exist (three different circuit breakers, five different rate limiters). Write a consolidation plan: which variant wins, migration strategy, grace period. Drive the rollout.

10. **Scaling-threshold doc.** For one service using in-process patterns (worker pool, pub/sub, sharding), document the scale thresholds at which each pattern needs to transition to a distributed equivalent. Include the triggering signals and the recommended replacement architecture.

11. **Retry-budget rollout.** Propose an org-wide retry budget policy (global cap on retries as fraction of outbound traffic). Pilot on one service. Measure incident reduction. Drive adoption across the service portfolio.

12. **Circuit-breaker review-to-mesh migration.** If your org runs a service mesh, audit whether applications still carry their own circuit breakers. Recommend migration to mesh-level breakers where appropriate. Document the trade-offs (observability, control, operational complexity) to help each team decide.

13. **Pattern teaching clinic.** Run a two-hour workshop for the engineering org covering the chapter's patterns. Include hands-on exercises where engineers diagnose which pattern applies to given scenarios. Measure comprehension via a follow-up quiz one month later.

---
`;
