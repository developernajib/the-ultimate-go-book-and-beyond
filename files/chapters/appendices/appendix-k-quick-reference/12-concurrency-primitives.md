## Concurrency Primitives

Beyond channels, Go's `sync` package provides low-level concurrency primitives for coordinating goroutines. `Mutex` and `RWMutex` protect shared data from concurrent access, while `WaitGroup` lets you wait for a collection of goroutines to finish. The `context` package is essential for managing cancellation, timeouts, and request-scoped values across goroutine boundaries. For simple atomic operations on integers and pointers, the `sync/atomic` package avoids the overhead of mutexes entirely.

```go
import "sync"

// Mutex (mutual exclusion)
var mu sync.Mutex
mu.Lock()
// Critical section
mu.Unlock()

// Defer unlock pattern
mu.Lock()
defer mu.Unlock()
// Critical section

// RWMutex (read-write lock)
var mu sync.RWMutex

// Read lock (multiple readers OK)
mu.RLock()
// Read data
mu.RUnlock()

// Write lock (exclusive)
mu.Lock()
// Write data
mu.Unlock()

// WaitGroup
var wg sync.WaitGroup

for i := 0; i < 5; i++ {
    wg.Add(1)
    go func(i int) {
        defer wg.Done()
        // Do work
    }(i)
}

wg.Wait()  // Block until all done

// Once (run exactly once)
var once sync.Once

func initialize() {
    once.Do(func() {
        // Expensive initialization
    })
}

// Multiple calls only run once
initialize()
initialize()

// Cond (condition variable)
var mu sync.Mutex
cond := sync.NewCond(&mu)

// Wait for condition
mu.Lock()
for !condition {
    cond.Wait()  // Releases lock, blocks, reacquires
}
// Use resource
mu.Unlock()

// Signal condition
mu.Lock()
condition = true
cond.Signal()    // Wake one waiter
// or
cond.Broadcast() // Wake all waiters
mu.Unlock()

// Pool (object pool)
pool := &sync.Pool{
    New: func() any {
        return new(Object)
    },
}

obj := pool.Get().(*Object)
// Use object
pool.Put(obj)

// Map (concurrent-safe map)
var m sync.Map

m.Store(key, value)
value, ok := m.Load(key)
value, loaded := m.LoadOrStore(key, value)
m.Delete(key)
m.Range(func(key, value any) bool {
    // Process each entry
    return true  // Continue iteration
})

// Atomic operations
import "sync/atomic"

var counter int64
atomic.AddInt64(&counter, 1)
atomic.LoadInt64(&counter)
atomic.StoreInt64(&counter, 0)
atomic.CompareAndSwapInt64(&counter, old, new)

// Atomic value (any type)
var v atomic.Value
v.Store(config)
config := v.Load().(ConfigType)

// Context (cancellation, timeouts, values)
import "context"

// Background context
ctx := context.Background()

// With timeout
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()

// With deadline
ctx, cancel := context.WithDeadline(ctx, time.Now().Add(5*time.Second))
defer cancel()

// With cancel
ctx, cancel := context.WithCancel(ctx)
defer cancel()

// With value
ctx = context.WithValue(ctx, key, value)

// Check cancellation
select {
case <-ctx.Done():
    return ctx.Err()  // context.Canceled or context.DeadlineExceeded
default:
    // Continue
}

// Use in functions
func doWork(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            // Do work
        }
    }
}

// Errgroup (run goroutines, collect errors)
import "golang.org/x/sync/errgroup"

g, ctx := errgroup.WithContext(context.Background())

for i := 0; i < 5; i++ {
    i := i
    g.Go(func() error {
        return doWork(ctx, i)
    })
}

if err := g.Wait(); err != nil {
    // First error from any goroutine
}

// Semaphore (limit concurrency)
import "golang.org/x/sync/semaphore"

sem := semaphore.NewWeighted(maxConcurrent)

for _, item := range items {
    if err := sem.Acquire(ctx, 1); err != nil {
        break
    }
    go func(item Item) {
        defer sem.Release(1)
        process(item)
    }(item)
}
```

---
