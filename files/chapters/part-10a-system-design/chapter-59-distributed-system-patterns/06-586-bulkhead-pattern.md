## 59.6 Bulkhead Pattern

The bulkhead pattern isolates different parts of a system to prevent cascading failures, named after the watertight compartments in a ship's hull that prevent a single breach from sinking the vessel. In software, this means limiting the concurrency each downstream dependency can consume so that a slow or failing service cannot exhaust all available threads, connections, or goroutines and starve unrelated functionality. The implementation below uses a buffered channel as a counting semaphore (controlling max concurrency) and a second buffered channel as a bounded wait queue, so callers that cannot run immediately are queued up to a configurable limit before being rejected outright.

```go
// bulkhead/bulkhead.go
package bulkhead

import (
    "context"
    "errors"
    "sync"
    "time"
)

var (
    ErrBulkheadFull    = errors.New("bulkhead is full")
    ErrBulkheadTimeout = errors.New("bulkhead wait timeout")
)

// Bulkhead implements the bulkhead pattern using semaphores
type Bulkhead struct {
    name          string
    maxConcurrent int
    maxWaiting    int
    semaphore     chan struct{}
    waitQueue     chan struct{}
    mu            sync.RWMutex
    stats         BulkheadStats
}

// BulkheadStats tracks bulkhead usage
type BulkheadStats struct {
    Accepted   int64
    Rejected   int64
    Completed  int64
    InProgress int64
    Waiting    int64
}

// NewBulkhead creates a new bulkhead
func NewBulkhead(name string, maxConcurrent, maxWaiting int) *Bulkhead {
    return &Bulkhead{
        name:          name,
        maxConcurrent: maxConcurrent,
        maxWaiting:    maxWaiting,
        semaphore:     make(chan struct{}, maxConcurrent),
        waitQueue:     make(chan struct{}, maxWaiting),
    }
}

// Execute runs a function within the bulkhead
func (b *Bulkhead) Execute(fn func() error) error {
    return b.ExecuteWithTimeout(0, fn)
}

// ExecuteWithTimeout runs a function with a wait timeout
func (b *Bulkhead) ExecuteWithTimeout(timeout time.Duration, fn func() error) error {
    // Try to acquire immediately
    select {
    case b.semaphore <- struct{}{}:
        b.mu.Lock()
        b.stats.Accepted++
        b.stats.InProgress++
        b.mu.Unlock()

        defer func() {
            <-b.semaphore
            b.mu.Lock()
            b.stats.Completed++
            b.stats.InProgress--
            b.mu.Unlock()
        }()

        return fn()

    default:
        // Try to join wait queue
        select {
        case b.waitQueue <- struct{}{}:
            b.mu.Lock()
            b.stats.Waiting++
            b.mu.Unlock()

            defer func() {
                <-b.waitQueue
                b.mu.Lock()
                b.stats.Waiting--
                b.mu.Unlock()
            }()

            // Wait for semaphore
            if timeout > 0 {
                select {
                case b.semaphore <- struct{}{}:
                    b.mu.Lock()
                    b.stats.Accepted++
                    b.stats.InProgress++
                    b.mu.Unlock()

                    defer func() {
                        <-b.semaphore
                        b.mu.Lock()
                        b.stats.Completed++
                        b.stats.InProgress--
                        b.mu.Unlock()
                    }()

                    return fn()

                case <-time.After(timeout):
                    return ErrBulkheadTimeout
                }
            } else {
                b.semaphore <- struct{}{}
                b.mu.Lock()
                b.stats.Accepted++
                b.stats.InProgress++
                b.mu.Unlock()

                defer func() {
                    <-b.semaphore
                    b.mu.Lock()
                    b.stats.Completed++
                    b.stats.InProgress--
                    b.mu.Unlock()
                }()

                return fn()
            }

        default:
            // Wait queue full, reject
            b.mu.Lock()
            b.stats.Rejected++
            b.mu.Unlock()
            return ErrBulkheadFull
        }
    }
}

// ExecuteWithContext runs with context cancellation support
func (b *Bulkhead) ExecuteWithContext(ctx context.Context, fn func(context.Context) error) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case b.semaphore <- struct{}{}:
        b.mu.Lock()
        b.stats.Accepted++
        b.stats.InProgress++
        b.mu.Unlock()

        defer func() {
            <-b.semaphore
            b.mu.Lock()
            b.stats.Completed++
            b.stats.InProgress--
            b.mu.Unlock()
        }()

        return fn(ctx)
    default:
        // Try wait queue
        select {
        case <-ctx.Done():
            return ctx.Err()
        case b.waitQueue <- struct{}{}:
            b.mu.Lock()
            b.stats.Waiting++
            b.mu.Unlock()

            defer func() {
                <-b.waitQueue
                b.mu.Lock()
                b.stats.Waiting--
                b.mu.Unlock()
            }()

            select {
            case <-ctx.Done():
                return ctx.Err()
            case b.semaphore <- struct{}{}:
                b.mu.Lock()
                b.stats.Accepted++
                b.stats.InProgress++
                b.mu.Unlock()

                defer func() {
                    <-b.semaphore
                    b.mu.Lock()
                    b.stats.Completed++
                    b.stats.InProgress--
                    b.mu.Unlock()
                }()

                return fn(ctx)
            }
        default:
            b.mu.Lock()
            b.stats.Rejected++
            b.mu.Unlock()
            return ErrBulkheadFull
        }
    }
}

// Stats returns current statistics
func (b *Bulkhead) Stats() BulkheadStats {
    b.mu.RLock()
    defer b.mu.RUnlock()
    return b.stats
}

// Available returns the number of available permits
func (b *Bulkhead) Available() int {
    return b.maxConcurrent - len(b.semaphore)
}
```

### Thread Pool Bulkhead

The semaphore-based bulkhead above limits concurrency but still executes tasks on the caller's goroutine. A thread pool bulkhead goes further by confining all work to a fixed set of dedicated goroutines, which means a slow or blocking operation can never borrow threads from an unrelated subsystem. The bounded `taskQueue` channel acts as both the work queue and the overflow detector, a full channel causes `Submit` to reject immediately rather than letting goroutine counts grow unbounded and exhaust scheduler resources.

```go
// bulkhead/threadpool.go
package bulkhead

import (
    "context"
    "errors"
    "sync"
)

// ThreadPoolBulkhead provides worker pool isolation
type ThreadPoolBulkhead struct {
    name        string
    workers     int
    queueSize   int
    taskQueue   chan task
    stopCh      chan struct{}
    wg          sync.WaitGroup
    mu          sync.RWMutex
    stats       ThreadPoolStats
}

type task struct {
    fn       func() error
    resultCh chan error
}

// ThreadPoolStats tracks thread pool usage
type ThreadPoolStats struct {
    Submitted    int64
    Completed    int64
    Failed       int64
    Rejected     int64
    QueuedCurrent int
}

// NewThreadPoolBulkhead creates a new thread pool bulkhead
func NewThreadPoolBulkhead(name string, workers, queueSize int) *ThreadPoolBulkhead {
    tp := &ThreadPoolBulkhead{
        name:      name,
        workers:   workers,
        queueSize: queueSize,
        taskQueue: make(chan task, queueSize),
        stopCh:    make(chan struct{}),
    }

    tp.start()
    return tp
}

func (tp *ThreadPoolBulkhead) start() {
    for i := 0; i < tp.workers; i++ {
        tp.wg.Add(1)
        go tp.worker()
    }
}

func (tp *ThreadPoolBulkhead) worker() {
    defer tp.wg.Done()

    for {
        select {
        case <-tp.stopCh:
            return
        case t := <-tp.taskQueue:
            err := t.fn()

            tp.mu.Lock()
            tp.stats.Completed++
            if err != nil {
                tp.stats.Failed++
            }
            tp.mu.Unlock()

            t.resultCh <- err
        }
    }
}

// Submit submits a task to the thread pool
func (tp *ThreadPoolBulkhead) Submit(fn func() error) error {
    resultCh := make(chan error, 1)
    t := task{fn: fn, resultCh: resultCh}

    select {
    case tp.taskQueue <- t:
        tp.mu.Lock()
        tp.stats.Submitted++
        tp.mu.Unlock()
        return <-resultCh

    default:
        tp.mu.Lock()
        tp.stats.Rejected++
        tp.mu.Unlock()
        return errors.New("thread pool queue full")
    }
}

// SubmitAsync submits a task without waiting for result
func (tp *ThreadPoolBulkhead) SubmitAsync(fn func() error) (<-chan error, error) {
    resultCh := make(chan error, 1)
    t := task{fn: fn, resultCh: resultCh}

    select {
    case tp.taskQueue <- t:
        tp.mu.Lock()
        tp.stats.Submitted++
        tp.mu.Unlock()
        return resultCh, nil

    default:
        tp.mu.Lock()
        tp.stats.Rejected++
        tp.mu.Unlock()
        return nil, errors.New("thread pool queue full")
    }
}

// SubmitWithContext submits with context support
func (tp *ThreadPoolBulkhead) SubmitWithContext(ctx context.Context, fn func() error) error {
    resultCh := make(chan error, 1)
    t := task{fn: fn, resultCh: resultCh}

    select {
    case <-ctx.Done():
        return ctx.Err()
    case tp.taskQueue <- t:
        tp.mu.Lock()
        tp.stats.Submitted++
        tp.mu.Unlock()

        select {
        case <-ctx.Done():
            return ctx.Err()
        case err := <-resultCh:
            return err
        }

    default:
        tp.mu.Lock()
        tp.stats.Rejected++
        tp.mu.Unlock()
        return errors.New("thread pool queue full")
    }
}

// Stop gracefully stops the thread pool
func (tp *ThreadPoolBulkhead) Stop() {
    close(tp.stopCh)
    tp.wg.Wait()

    // Fail any tasks still queued. Without this, a caller blocked in
    // a synchronous Submit would wait forever on a result that no
    // worker will ever produce.
    for {
        select {
        case t := <-tp.taskQueue:
            t.resultCh <- errors.New("thread pool stopped")
        default:
            return
        }
    }
}

// Stats returns current statistics
func (tp *ThreadPoolBulkhead) Stats() ThreadPoolStats {
    tp.mu.RLock()
    defer tp.mu.RUnlock()
    stats := tp.stats
    stats.QueuedCurrent = len(tp.taskQueue)
    return stats
}
```

### Junior -> FAANG: Why Bulkheads Exist and How to Size Them

The failure mode that bulkheads prevent is connection pool exhaustion. If your service has one shared pool of 100 goroutines and a single slow downstream consumes all 100, your entire service becomes unresponsive even for requests that do not touch that downstream. This is how a slow recommendation engine can take down your checkout flow.

The mental model is physical ship bulkheads: each compartment can flood independently without sinking the whole vessel. In software: each downstream dependency gets its own concurrency limit so that exhausting one pool does not affect others.

For first-job sizing, use the "three buckets" heuristic: critical services (payment, inventory, auth) get large bulkheads (50+ concurrent), non-critical services (analytics, notifications) get small ones (5-10 concurrent), and the wait queue is typically 2x the concurrent limit. This is a starting point. Production sizing requires measuring the p99 latency of each downstream and working backwards from your target response time SLO.

The `ErrBulkheadFull` error is a first-class signal. Unlike `ErrCircuitOpen` (which means "the downstream is sick"), `ErrBulkheadFull` means "too many callers at once." The correct response to the caller is usually HTTP 503 with a `Retry-After` header, not a 500. Build this into your HTTP handler layer so the distinction is visible to clients.

### Senior @ FAANG: Bulkhead Sizing as a Continuous Practice and Thread Pool Isolation

Bulkhead sizing is not a one-time decision made at service launch. It is a continuous practice driven by load testing and production metrics. The key metrics to track per bulkhead: rejection rate (how often `ErrBulkheadFull` fires), in-progress count (peak vs configured limit), and wait queue depth (how often requests spend time waiting before getting a permit).

If rejection rate is above 1% under normal load, the bulkhead is too small for the current traffic pattern. If in-progress count never exceeds 30% of the configured limit, the bulkhead is oversized and you are wasting the isolation benefit (each goroutine waiting in a bulkhead slot is holding a permit that another request could use). Target 60-80% utilization under expected peak load.

Thread pool bulkheads (the second implementation in this section) are the correct choice when your downstream calls are I/O-bound and you need hard isolation. A semaphore-based bulkhead limits concurrency but executes on the caller's goroutine, which means a goroutine leak in the downstream call (a stuck `io.Reader.Read`, for example) escapes the bulkhead. A thread pool bulkhead's workers are the only goroutines that touch the downstream, so a stuck call only hangs one worker, not the caller.

The practical limitation of thread pool bulkheads is queue depth visibility. Because tasks are submitted to a channel and executed asynchronously, the caller does not know the position of its task in the queue. Adding a priority queue (two channels, one per priority tier, with the worker always draining the high-priority channel first) addresses this for critical vs non-critical requests.

Staff-level governance: bulkhead limits are configuration, not constants. They should be tunable at runtime without a deployment, either via a feature flag system or a configuration service. During an incident, the ability to temporarily increase a bulkhead limit (to handle a traffic spike) or decrease it (to shed load from a degraded downstream) without deploying code is a significant operational advantage. Build the configuration wiring before you need it, not during an outage.

---
