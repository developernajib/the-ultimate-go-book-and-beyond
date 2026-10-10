## 13.13 Common Mistakes and Anti-Patterns

### 1. Forgetting to Unlock

Every early return path from a function that holds a mutex requires an explicit `Unlock` call. Missing even one leaves the mutex permanently locked, causing all future callers to block indefinitely. Using `defer mu.Unlock()` immediately after `Lock()` guarantees the unlock fires on every exit path including panics.

```go
// Bad: Early return without unlock
func bad(mu *sync.Mutex) error {
    mu.Lock()
    if err := validate(); err != nil {
        return err  // Mutex stays locked!
    }
    mu.Unlock()
    return nil
}

// Good: Always use defer
func good(mu *sync.Mutex) error {
    mu.Lock()
    defer mu.Unlock()
    return validate()
}
```

### 2. Copying Sync Types

All `sync` types, `Mutex`, `RWMutex`, `WaitGroup`, `Cond`, `Once`, must not be copied after first use. The reason is simpler than it sounds: the lock *is* the state. A `sync.Mutex` is a small struct holding a lock word and a waiter count, so copying it duplicates that state and produces a second, entirely independent lock. Two goroutines locking two copies exclude nothing. Worse, copying a mutex while it is held produces a copy that is permanently locked with no one able to unlock it.

A value receiver silently copies the mutex on every method call, so each call locks a fresh throwaway lock and the method provides no mutual exclusion at all while looking exactly like it does. `go vet` detects this.

```go
// Bad: Value receiver copies mutex
func (c Counter) Value() int {  // Copies mutex!
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

// Good: Pointer receiver
func (c *Counter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

// Detect with: go vet ./...
```

### 3. Lock Ordering Inconsistency

Deadlocks caused by inconsistent lock ordering are subtle because each goroutine individually follows valid logic, yet together they create a cycle where neither can proceed. The safe rule is to establish a global ordering over the lockable objects and always acquire in that order, so no two goroutines can each hold what the other needs. Order by a stable identity such as an account ID, as in section 13.2, not by `uintptr(unsafe.Pointer(x))`: an address is not a documented stable identifier, and reaching for `unsafe` to solve an ordering problem is a smell.

```go
// Deadlock: Inconsistent lock order
// Goroutine 1: Lock(A) then Lock(B)
// Goroutine 2: Lock(B) then Lock(A)

// Solution: Always lock in a consistent order, keyed on stable IDs
func transfer(a, b *Account, amount int64) {
    if a.id == b.id {
        // Same account: locking twice would self-deadlock.
        // sync.Mutex is not reentrant.
        return
    }
    if a.id > b.id {
        a, b = b, a
    }
    a.mu.Lock()
    defer a.mu.Unlock()
    b.mu.Lock()
    defer b.mu.Unlock()
    // Transfer...
}
```

Note the `a.id == b.id` guard. Ordering logic is where the self-transfer case hides, and every ordering scheme needs it: swapping does not help when the two "different" locks are the same lock.

### 4. RWMutex Lock Upgrade

`sync.RWMutex` does not support upgrading a read lock to a write lock. Attempting to call `Lock()` while holding an `RLock()` on the same mutex deadlocks because `Lock` waits for all existing read locks to be released, including the one held by the calling goroutine. The fix is to release the read lock, then re-acquire as a write lock with a double-check of the condition.

```go
// Deadlock: Cannot upgrade RLock to Lock
func bad(rw *sync.RWMutex) {
    rw.RLock()
    // ...
    rw.Lock()  // DEADLOCK: Waiting for self!
}

// Good: Release read lock first
func good(rw *sync.RWMutex, data map[string]int) {
    rw.RLock()
    _, exists := data["key"]
    rw.RUnlock()

    if !exists {
        rw.Lock()
        // Double-check after acquiring write lock
        if _, exists := data["key"]; !exists {
            data["key"] = 42
        }
        rw.Unlock()
    }
}
```

### 5. WaitGroup Misuse

Calling `wg.Add(1)` inside the goroutine body introduces a race condition: `wg.Wait()` may be reached before any goroutine has had a chance to register itself, causing `Wait` to return immediately with no work done. The counter must always be incremented in the spawning goroutine, before the `go` statement, so that by the time `Wait` is called the full count is already committed.

```go
// Bad: Add inside goroutine
func bad() {
    var wg sync.WaitGroup
    for i := 0; i < 10; i++ {
        go func() {
            wg.Add(1)  // Race with Wait!
            defer wg.Done()
        }()
    }
    wg.Wait()
}

// Good: Add before goroutine
func good() {
    var wg sync.WaitGroup
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
        }()
    }
    wg.Wait()
}
```

### 6. Pool Object Reuse Without Reset

`sync.Pool` returns objects from previous uses without clearing them. If the caller writes partial data and returns the object without resetting it, the next caller receives an object with leftover content. Calling `Reset()` or zeroing the relevant fields before returning the object to the pool, or immediately after retrieving it, prevents state leakage between callers.

```go
// Bad: Returning dirty object to pool
var bufPool = sync.Pool{New: func() any { return &bytes.Buffer{} }}

func bad(data []byte) {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Write(data)
    // Processing...
    bufPool.Put(buf)  // Buffer still has data!
}

// Good: Reset before returning
func good(data []byte) {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()  // Clear any previous data
    buf.Write(data)
    // Processing...
    buf.Reset()  // Clear before returning
    bufPool.Put(buf)
}
```

### 7. Using sync.Map for Everything

`sync.Map` is specialized for two access patterns: keys written once and read many times, and disjoint key sets per goroutine. A read-modify-write counter is neither. It is also `map[any]any`, so you give up compile-time type safety and gain a runtime assertion on every read.

The counter below is the canonical misuse, and it is instructive because it is wrong in three separate ways at once:

```go
// Bad: Using sync.Map for a read-modify-write counter
var counters sync.Map // Wrong choice!

func incrementCounter(key string) {
    for {
        val, _ := counters.Load(key)
        newVal := val.(int) + 1 // PANIC: val is nil when key is absent
        if counters.CompareAndSwap(key, val, newVal) {
            break
        }
        // ...and if the key is absent, CompareAndSwap never succeeds,
        // so this loop spins forever.
    }
}

// Good: Use map + mutex for read-modify-write
type Counters struct {
    mu   sync.Mutex
    data map[string]int
}

func (c *Counters) Increment(key string) {
    c.mu.Lock()
    c.data[key]++
    c.mu.Unlock()
}
```

**It panics on a missing key.** `Load` returns `(nil, false)`, and `nil.(int)` is a runtime panic. The mutex version handles the missing key for free, because `c.data[key]++` on an absent key starts from the zero value.

**It can spin forever.** `CompareAndSwap` returns false when the key does not exist, so on a cold key the loop never terminates. A CAS retry loop is only correct if failure implies someone else made progress, and here failure implies nothing exists to swap.

**It is a CAS loop around exactly the thing a mutex does better.** Even after fixing the two bugs above with `LoadOrStore`, contended increments to a hot key mean the CAS fails repeatedly and each retry is wasted work. The mutex version does one lock, one increment, one unlock, and cannot livelock. A CAS loop is only a win when contention is rare.

Note also what does *not* justify the mutex version: it is not that "`sync.Map` promotes an internal read map on every write". That described the pre-1.24 implementation, which no longer exists. Reach for the mutex here because the operation is a read-modify-write on a shared key and needs type safety, not because of an implementation detail that changed.

### Additional Mistakes to Flag

1. **Lock held across blocking I/O.** Database query, RPC call, or channel send while holding a mutex. Freezes all waiters on the lock. Always release before blocking.
2. **Recursive locking.** Go's `sync.Mutex` is not reentrant. Calling a method that locks from a method that already holds the same lock deadlocks. Refactor to separate locked and unlocked versions.
3. **Forgetting to Unlock on error paths.** Use `defer mu.Unlock()` immediately after `mu.Lock()`. Exceptions require very careful review.
4. **Mutex zero-value copy.** `sync.Mutex` is zero-value usable but must not be copied after first use. `go vet` catches most cases. Pointer receivers prevent the rest.
5. **Waiting on a WaitGroup with zero Add.** `Wait()` returns immediately if the counter is zero. This is correct for empty collections, a bug when the Add was conditional and skipped.

### Staff Lens: The Synchronization Anti-Pattern Catalog

The mistakes above are catchable individually. Systemically, teams repeat the same mistakes because the patterns live in people's heads rather than in a document. The staff-level deliverable: a one-page catalog of team-observed anti-patterns, reviewed against every concurrent PR. Items from this chapter plus items specific to your codebase. Maintain it as new bugs teach you new entries.

The value is not that a checklist is clever. It is that synchronization bugs are exactly the class where individual vigilance fails: they are invisible in review, absent from tests, and only appear under production load. A written catalog converts a bug you already paid for into a check that runs on every future PR. Pair it with mandatory `-race` in CI, which catches a different and overlapping set, and with `go vet`, which catches the copied locks for free.

---
