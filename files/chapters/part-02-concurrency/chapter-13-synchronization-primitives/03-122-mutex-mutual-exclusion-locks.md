## 13.2 Mutex: Mutual Exclusion Locks

`sync.Mutex` provides mutual exclusion, only one goroutine can hold the lock at a time.

### Basic Usage and Patterns

The most common mutex pattern embeds a `sync.Mutex` directly in a struct alongside the data it protects. Every method that reads or writes shared state acquires the lock first and releases it with `defer`, ensuring the critical section is always exited even if a panic occurs. The `CompareAndSwap` method below demonstrates how a mutex can guard more complex conditional update logic that atomic operations alone cannot express.

```go
package main

import (
    "fmt"
    "sync"
)

// SafeCounter demonstrates basic mutex usage
type SafeCounter struct {
    mu    sync.Mutex
    value int64
}

func (c *SafeCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value++
}

func (c *SafeCounter) Decrement() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value--
}

func (c *SafeCounter) Value() int64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

func (c *SafeCounter) Add(delta int64) int64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value += delta
    return c.value
}

// CompareAndSwap atomically updates if current value matches expected
func (c *SafeCounter) CompareAndSwap(expected, new int64) bool {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.value == expected {
        c.value = new
        return true
    }
    return false
}
```

### Lock Scope: Minimizing Critical Sections

One of the most important mutex patterns is keeping critical sections short:

```go
// Cache demonstrates proper lock scope.
// group is golang.org/x/sync/singleflight, used by GetBetter below.
type Cache struct {
    mu    sync.Mutex
    items map[string][]byte
    db    *Database
    group singleflight.Group
}

// Bad: Lock held during slow I/O
func (c *Cache) GetBad(key string) ([]byte, error) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if data, ok := c.items[key]; ok {
        return data, nil
    }

    // SLOW: Database access while holding lock
    // All other goroutines blocked!
    data, err := c.db.Fetch(key)
    if err != nil {
        return nil, err
    }

    c.items[key] = data
    return data, nil
}

// Good: Minimize lock scope
func (c *Cache) GetGood(key string) ([]byte, error) {
    // Quick check with lock
    c.mu.Lock()
    data, ok := c.items[key]
    c.mu.Unlock()

    if ok {
        return data, nil
    }

    // Slow I/O without holding lock
    data, err := c.db.Fetch(key)
    if err != nil {
        return nil, err
    }

    // Re-acquire lock for update
    c.mu.Lock()
    // Check again - another goroutine might have populated
    if existing, ok := c.items[key]; ok {
        c.mu.Unlock()
        return existing, nil
    }
    c.items[key] = data
    c.mu.Unlock()

    return data, nil
}

// Better: Use singleflight for deduplication
func (c *Cache) GetBetter(key string) ([]byte, error) {
    c.mu.Lock()
    data, ok := c.items[key]
    c.mu.Unlock()

    if ok {
        return data, nil
    }

    // singleflight deduplicates concurrent requests
    result, err, _ := c.group.Do(key, func() (any, error) {
        data, err := c.db.Fetch(key)
        if err != nil {
            return nil, err
        }

        c.mu.Lock()
        c.items[key] = data
        c.mu.Unlock()

        return data, nil
    })

    if err != nil {
        return nil, err
    }
    return result.([]byte), nil
}
```

### Never Copy a Mutex

Mutexes contain internal state that must not be copied:

```go
type Counter struct {
    mu    sync.Mutex
    value int
}

// Bad: Copies the mutex
func badCopy(c Counter) {
    c.mu.Lock()  // Operating on copy!
    c.value++
    c.mu.Unlock()
}

// Good: Pass pointer
func good(c *Counter) {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

// Detect with go vet
// $ go vet ./...
// counter.go:10: badCopy passes lock by value: Counter contains sync.Mutex
```

### Embedded Mutex Pattern

Go allows a `sync.Mutex` to be embedded directly in a struct, which promotes the `Lock` and `Unlock` methods to the outer type and results in slightly cleaner call sites. While convenient, this approach exposes locking as part of the public API, so callers could acquire the lock externally, a subtle design decision that is often better avoided by keeping the mutex as a private named field instead.

```go
// Embedding mutex for cleaner code
type Registry struct {
    sync.Mutex  // Embedded, promotes Lock/Unlock methods
    services map[string]Service
}

func (r *Registry) Register(name string, svc Service) {
    r.Lock()
    defer r.Unlock()
    r.services[name] = svc
}

func (r *Registry) Get(name string) (Service, bool) {
    r.Lock()
    defer r.Unlock()
    svc, ok := r.services[name]
    return svc, ok
}

// Warning: Embedding exposes Lock/Unlock publicly
// Better to keep mutex private if API doesn't need external locking
type BetterRegistry struct {
    mu       sync.Mutex  // Private
    services map[string]Service
}
```

### Lock Ordering to Prevent Deadlocks

Deadlocks arise when two goroutines each hold a lock the other needs, creating a circular wait. The safest fix is to enforce a consistent global acquisition order so no cycle can form. Give every lockable object a stable, totally ordered identity and always acquire in ascending order of that identity. The three solutions below progress from ID ordering, to a try-lock retry loop with backoff, to a coarser single global lock that trades concurrency for simplicity.

```go
// Deadlock scenario
type Account struct {
    id      uint64 // stable, unique, assigned at creation
    mu      sync.Mutex
    balance int64
}

// Deadlock: Different lock ordering
func TransferDeadlock(from, to *Account, amount int64) {
    from.mu.Lock()
    defer from.mu.Unlock()

    to.mu.Lock() // Deadlock if another goroutine does Transfer(to, from, ...)
    defer to.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}

// Solution 1: Consistent ordering by a stable ID
func TransferOrdered(from, to *Account, amount int64) {
    if from.id == to.id {
        // Same account. Locking twice would self-deadlock:
        // sync.Mutex is not reentrant.
        return
    }

    first, second := from, to
    if first.id > second.id {
        first, second = second, first
    }

    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}

// Solution 2: Try-lock pattern. sync.Mutex.TryLock (Go 1.18) returns
// false instead of blocking, so we can back out and retry rather than
// wait in a cycle. Note that TryLock is a last resort, not a default:
// correct lock ordering is almost always the better answer.
func TransferTryLock(from, to *Account, amount int64) error {
    const maxRetries = 100

    for i := 0; i < maxRetries; i++ {
        if tryTransfer(from, to, amount) {
            return nil
        }
        // Backoff before retrying so the competing goroutine can finish.
        time.Sleep(time.Duration(rand.IntN(100)) * time.Microsecond)
    }
    return errors.New("failed to acquire locks")
}

func tryTransfer(from, to *Account, amount int64) bool {
    if from.id == to.id {
        return true
    }
    if !from.mu.TryLock() {
        return false
    }
    defer from.mu.Unlock()

    if !to.mu.TryLock() {
        // Release from's lock by returning, then retry from scratch.
        return false
    }
    defer to.mu.Unlock()

    from.balance -= amount
    to.balance += amount
    return true
}

// Solution 3: Single global lock (simple but less concurrent)
var transferLock sync.Mutex

func TransferGlobal(from, to *Account, amount int64) {
    transferLock.Lock()
    defer transferLock.Unlock()

    from.balance -= amount
    to.balance += amount
}
```

Ordering by ID rather than by `uintptr(unsafe.Pointer(acct))` matters. Pointer arithmetic for ordering is fragile: the language does not promise that an object's address is stable, and reaching for `unsafe` to solve an ordering problem invites reviewers to stop reading. A monotonic counter, a database primary key, or any other stable total order does the job with no caveats.

### Mutex Contention Profiling

The Go runtime includes a mutex profiler. Enable it and read the output:

```go
runtime.SetMutexProfileFraction(5) // sample 1 in 5 contention events
// ... run workload ...
// then: go tool pprof http://localhost:6060/debug/pprof/mutex
```

The profile tells you which mutexes are the contention hot spots. Optimize these, leave the rest alone. Most mutexes in a Go service have effectively zero contention. Only a handful are hot. Without the profile, you cannot know which.

### Anti-Patterns to Flag in Review

1. **Mutex copied by value.** `go vet` catches most cases. Use pointer receivers for types containing mutexes.
2. **Lock held across channel operations.** The channel send can block indefinitely while holding the mutex, freezing every waiting goroutine.
3. **Lock held across RPC calls or database queries.** The remote call can hang, holding the lock for seconds or minutes. Always release the lock before blocking I/O.
4. **Lock scope too wide.** Locking an entire function when only three lines need protection. Narrow the critical section.
5. **Nested locks without documented order.** Deadlock risk without a lock hierarchy. Document the order or use a single lock.
6. **Assuming the mutex is reentrant.** It is not. An exported method that takes the lock and then calls another exported method that takes the same lock deadlocks the goroutine against itself. The convention that avoids this: exported methods acquire the lock and immediately delegate to an unexported helper that assumes the lock is already held. Name those helpers so the contract is visible, for example `lockedGet` or `getLocked`.

### Staff Lens: Lock Granularity Is a Design Decision

A single coarse lock protecting a whole struct is simple and correct. A fine-grained lock per field is fast but complex and deadlock-prone. The staff-level instinct: start with one lock per logical invariant (not one per field, not one for the whole system). As contention emerges, shard. Do not preemptively split locks. The complexity cost of fine-grained locking is real and often exceeds the contention cost of coarse locking.

### Principal Lens: Mutex as a Scaling Ceiling

Every mutex has a throughput ceiling, and it is lower than most engineers expect. An uncontended `Lock`/`Unlock` pair costs on the order of tens of nanoseconds. Under contention the picture inverts: the lock stops being a cheap instruction sequence and becomes a scheduling event, goroutines park and unpark, and per-operation cost can rise by an order of magnitude or more as cores are added. The signature of hitting the ceiling is a service whose throughput stops improving, or gets worse, when you give it more CPU. Measure it on your own hardware with your own critical section, because the number depends on both. If your service needs higher throughput on shared state than the mutex can deliver, the mutex is the wrong primitive. Options: sharding (reduce contention per lock), lock-free structures (eliminate the lock), or architectural change (eliminate the shared state). Recognize the ceiling before the service hits it. Principal engineers watch the mutex profiler for hot locks and redesign before the lock becomes the system bottleneck.

---
