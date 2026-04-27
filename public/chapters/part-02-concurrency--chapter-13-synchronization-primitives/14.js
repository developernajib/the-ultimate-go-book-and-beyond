export default `## 13.13 Common Mistakes and Anti-Patterns

### 1. Forgetting to Unlock

Every early return path from a function that holds a mutex requires an explicit \`Unlock\` call. Missing even one leaves the mutex permanently locked, causing all future callers to block indefinitely. Using \`defer mu.Unlock()\` immediately after \`Lock()\` guarantees the unlock fires on every exit path including panics.

\`\`\`go
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
\`\`\`

### 2. Copying Sync Types

All \`sync\` types, \`Mutex\`, \`RWMutex\`, \`WaitGroup\`, \`Cond\`, \`Once\`, must not be copied after first use because their internal state references are not pointer-safe after copying. A value receiver silently copies the mutex with every method call, creating a new lock that is independent of the original, making the method non-thread-safe. \`go vet\` detects this pattern.

\`\`\`go
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
\`\`\`

### 3. Lock Ordering Inconsistency

Deadlocks caused by inconsistent lock ordering are subtle because each goroutine individually follows valid logic, yet together they create a cycle where neither can proceed. The safe rule is to establish a global ordering, in this case by memory address, and always acquire multiple locks in that order so no two goroutines can each hold what the other needs.

\`\`\`go
// Deadlock: Inconsistent lock order
// Goroutine 1: Lock(A) then Lock(B)
// Goroutine 2: Lock(B) then Lock(A)

// Solution: Always lock in consistent order
func transfer(a, b *Account, amount int64) {
    // Order by address
    if uintptr(unsafe.Pointer(a)) > uintptr(unsafe.Pointer(b)) {
        a, b = b, a
    }
    a.mu.Lock()
    b.mu.Lock()
    // Transfer...
    b.mu.Unlock()
    a.mu.Unlock()
}
\`\`\`

### 4. RWMutex Lock Upgrade

\`sync.RWMutex\` does not support upgrading a read lock to a write lock. Attempting to call \`Lock()\` while holding an \`RLock()\` on the same mutex deadlocks because \`Lock\` waits for all existing read locks to be released, including the one held by the calling goroutine. The fix is to release the read lock, then re-acquire as a write lock with a double-check of the condition.

\`\`\`go
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
\`\`\`

### 5. WaitGroup Misuse

Calling \`wg.Add(1)\` inside the goroutine body introduces a race condition: \`wg.Wait()\` may be reached before any goroutine has had a chance to register itself, causing \`Wait\` to return immediately with no work done. The counter must always be incremented in the spawning goroutine, before the \`go\` statement, so that by the time \`Wait\` is called the full count is already committed.

\`\`\`go
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
\`\`\`

### 6. Pool Object Reuse Without Reset

\`sync.Pool\` returns objects from previous uses without clearing them. If the caller writes partial data and returns the object without resetting it, the next caller receives an object with leftover content. Calling \`Reset()\` or zeroing the relevant fields before returning the object to the pool, or immediately after retrieving it, prevents state leakage between callers.

\`\`\`go
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
\`\`\`

### 7. Using sync.Map for Everything

\`sync.Map\` trades memory overhead and write complexity for lock-free reads against a stable key set. Write-heavy workloads that update keys frequently pay a high cost as the internal read-map must be promoted on every write. A plain \`map\` protected by \`sync.Mutex\` is simpler, uses less memory, and performs better when write frequency is comparable to read frequency.

\`\`\`go
// Bad: Using sync.Map for write-heavy workload
var counters sync.Map  // Wrong choice!

func incrementCounter(key string) {
    for {
        val, _ := counters.Load(key)
        newVal := val.(int) + 1
        if counters.CompareAndSwap(key, val, newVal) {
            break
        }
    }
}

// Good: Use map + mutex for write-heavy workloads
type Counters struct {
    mu   sync.Mutex
    data map[string]int
}

func (c *Counters) Increment(key string) {
    c.mu.Lock()
    c.data[key]++
    c.mu.Unlock()
}
\`\`\`

### Additional Mistakes to Flag

1. **Lock held across blocking I/O.** Database query, RPC call, or channel send while holding a mutex. Freezes all waiters on the lock. Always release before blocking.
2. **Recursive locking.** Go's \`sync.Mutex\` is not reentrant. Calling a method that locks from a method that already holds the same lock deadlocks. Refactor to separate locked and unlocked versions.
3. **Forgetting to Unlock on error paths.** Use \`defer mu.Unlock()\` immediately after \`mu.Lock()\`. Exceptions require very careful review.
4. **Mutex zero-value copy.** \`sync.Mutex\` is zero-value usable but must not be copied after first use. \`go vet\` catches most cases; pointer receivers prevent the rest.
5. **Waiting on a WaitGroup with zero Add.** \`Wait()\` returns immediately if the counter is zero. This is correct for empty collections, a bug when the Add was conditional and skipped.

### Staff Lens: The Synchronization Anti-Pattern Catalog

The mistakes above are catchable individually. Systemically, teams repeat the same mistakes because the patterns are not documented. The staff-level deliverable: a one-page catalog of team-observed anti-patterns, reviewed against every concurrent PR. Items from this chapter plus items specific to your codebase. Maintain quarterly. Teams that do this catch 80% of synchronization bugs at review time. Teams that do not rediscover the same bugs repeatedly.

---
`;
