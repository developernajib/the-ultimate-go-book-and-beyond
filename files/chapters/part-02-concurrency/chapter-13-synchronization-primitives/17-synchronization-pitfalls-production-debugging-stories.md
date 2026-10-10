## Synchronization Pitfalls: Production Debugging Stories

The bugs in this section are drawn from recurring patterns in production Go systems. Each one compiles without error, passes `go build`, and appears correct on a cursory read, yet causes data corruption, deadlocks, or silent failures under concurrent load.

### The Mutex Copy Bug: Silent Corruption

Copying a struct that contains a mutex creates a second, independent lock, the copy and the original now protect different memory regions. Because the copy's mutex starts in its zero (unlocked) state, goroutines acquire it without blocking, and the shared map or slice behind the original pointer receives unprotected concurrent writes.

```go
// CRITICAL BUG: Mutex copied - silent data race
type Config struct {
    mu      sync.Mutex
    values  map[string]string
}

func processConfigs(configs []Config) {
    for _, cfg := range configs {  // cfg is a COPY!
        cfg.mu.Lock()              // Locks the COPY's mutex
        defer cfg.mu.Unlock()      // Unlocks the COPY
        // Original config is unprotected!
        process(cfg.values)
    }
}

// WHY: The for-range copies each Config struct
// Each copy has its own (unlocked) mutex
// Original configs have no protection

// ALSO BROKEN: Passing by value
func updateConfigBad(cfg Config, key, value string) {
    cfg.mu.Lock()                  // Locks copy
    cfg.values[key] = value        // Updates copy (lost after return)
    cfg.mu.Unlock()
}

// CORRECT: Always use pointers with mutex-containing types.
// (Config is declared once, above. Only the signatures change.)
func processConfigsGood(configs []*Config) {
    for _, cfg := range configs { // cfg is a pointer
        cfg.mu.Lock()             // Locks the original's mutex
        process(cfg.values)
        cfg.mu.Unlock() // NOT defer: see below
    }
}

// BETTER: pass the pointer
func updateConfigGood(cfg *Config, key, value string) {
    cfg.mu.Lock()
    defer cfg.mu.Unlock()
    cfg.values[key] = value
}

// PREVENTION: Use go vet
// go vet catches mutex copies statically
// go vet ./...
// ./main.go:10: range var cfg copies lock: example.Config contains sync.Mutex
```

There are **two** bugs in the broken version, and the second one survives even after you fix the copy.

**`defer` inside a loop does not run at the end of the iteration.** It runs when the *function* returns. The original body was:

```go
for _, cfg := range configs {
    cfg.mu.Lock()
    defer cfg.mu.Unlock() // queued until processConfigs returns
    process(cfg.values)
}
```

Change `configs` to `[]*Config` and the copy bug is gone, but now every lock is held from the moment it is acquired until the whole function returns. Process a thousand configs and you hold a thousand locks simultaneously, in a fixed order, for the entire duration. That is both a scalability disaster and a deadlock waiting to meet any goroutine that takes the same locks in a different order. It also grows the defer chain linearly.

The rule: `defer` is scoped to the function, not the block. Inside a loop, either unlock explicitly at the end of the iteration, or move the body into its own function (or a closure invoked per iteration) so `defer` has a scope that matches the lock's lifetime:

```go
for _, cfg := range configs {
    func() {
        cfg.mu.Lock()
        defer cfg.mu.Unlock() // now scoped to this iteration
        process(cfg.values)
    }()
}
```

This is the one case where "always use defer for unlock" needs qualification. The advice is right, the scope has to be right too.

### RWMutex Upgrade Deadlock

Go's `sync.RWMutex` does not support atomic lock upgrade. Calling `Lock()` while still holding `RLock()` on the same goroutine deadlocks immediately: the write lock waits for all readers to release, but the calling goroutine is itself one of those readers and will never release while blocked on `Lock()`.

```go
// DEADLOCK: Trying to upgrade RLock to Lock
type Cache struct {
    mu    sync.RWMutex
    items map[string]Item
}

func (c *Cache) GetOrCreateBad(key string) Item {
    c.mu.RLock()

    if item, ok := c.items[key]; ok {
        c.mu.RUnlock()
        return item
    }

    // Still holding RLock, trying to get Lock
    c.mu.Lock()     // DEADLOCK! Can't upgrade
    defer c.mu.Unlock()
    // ...
}

// WHY: RWMutex doesn't support upgrading
// The Lock() call waits for all readers (including itself) to release
// This goroutine holds RLock and waits for Lock = deadlock

// CORRECT: Release read lock before acquiring write lock
func (c *Cache) GetOrCreateGood(key string) Item {
    // First check with read lock
    c.mu.RLock()
    if item, ok := c.items[key]; ok {
        c.mu.RUnlock()
        return item
    }
    c.mu.RUnlock()  // Release before upgrade

    // Acquire write lock
    c.mu.Lock()
    defer c.mu.Unlock()

    // Double-check after acquiring write lock
    if item, ok := c.items[key]; ok {
        return item  // Another goroutine created it
    }

    item := createItem(key)
    c.items[key] = item
    return item
}
```

### sync.Once Error Handling Bug

`sync.Once` marks the function as "done" regardless of its outcome. If the initializer returns an error or panics-then-recovers, the `Once` is spent, no subsequent call to `Do` will re-execute it, leaving the protected value permanently nil or in a broken state.

```go
// BUG: Once succeeds even if initialization fails
var (
    once   sync.Once
    client *http.Client
    initErr error
)

func GetClientBad() (*http.Client, error) {
    once.Do(func() {
        client, initErr = createClient()  // Might fail!
    })
    return client, initErr  // Returns nil client forever if init failed
}

// The once.Do never runs again, so client stays nil

// BETTER (if a permanent failure is acceptable): sync.OnceValues (Go 1.21+)
// carries the error as a value instead of losing it. Note this still does
// NOT retry: it caches the error forever, but at least every caller sees it.
var getClient = sync.OnceValues(func() (*http.Client, error) {
    return createClient()
})

// Do NOT do this: panicking inside a Once initializer
var getClientBad = sync.OnceValue(func() *http.Client {
    client, err := createClient()
    if err != nil {
        panic(err) // turns a transient dial failure into a process-wide fault
    }
    return client
})

// FAIL-FAST AFTER FIRST FAILURE (not a retry, despite appearances)
type LazyClient struct {
    mu      sync.Mutex
    client  *http.Client
    initErr error
    tried   bool
}

func (l *LazyClient) Get() (*http.Client, error) {
    l.mu.Lock()
    defer l.mu.Unlock()

    if l.client != nil {
        return l.client, nil
    }

    if l.tried {
        // tried is never reset, so this is sync.Once with a better error
        // message. It does not retry.
        return nil, fmt.Errorf("initialization failed previously: %w", l.initErr)
    }

    l.tried = true
    l.client, l.initErr = createClient()
    return l.client, l.initErr
}

// ACTUAL RETRY: with backoff
type RetryingClient struct {
    mu      sync.Mutex
    client  *http.Client
    lastTry time.Time
    backoff time.Duration
}

const (
    initialBackoff = 100 * time.Millisecond
    maxBackoff     = 30 * time.Second
)

func (r *RetryingClient) Get() (*http.Client, error) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.client != nil {
        return r.client, nil
    }

    if !r.lastTry.IsZero() && time.Since(r.lastTry) < r.backoff {
        return nil, fmt.Errorf("too soon to retry, next attempt in %v",
            r.backoff-time.Since(r.lastTry))
    }

    r.lastTry = time.Now()
    client, err := createClient()
    if err != nil {
        // Seed the backoff on first failure. Doubling from the zero value
        // stays at zero forever, which is a real bug and an easy one to miss.
        if r.backoff == 0 {
            r.backoff = initialBackoff
        } else {
            r.backoff = min(r.backoff*2, maxBackoff)
        }
        return nil, err
    }

    r.client = client
    r.backoff = 0 // reset on success
    return r.client, nil
}
```

Three details in `RetryingClient` are worth stating, because the obvious version gets each wrong.

**Doubling from zero stays at zero.** `min(r.backoff*2, maxBackoff)` on a zero-valued `backoff` computes `min(0, 30s)`, which is `0`. The "exponential backoff" never grows, `time.Since(r.lastTry) < 0` is never true, and every caller retries immediately. You have written a tight retry loop against a failing dependency and labelled it backoff. Seed the first value explicitly.

**Reset the backoff on success.** Otherwise the next failure after a long healthy period starts at whatever the backoff had climbed to before.

**A mutex held across `createClient()` serializes every caller behind one dial.** That is intentional here (it is what prevents a thundering herd of connection attempts), but it means `Get` can block for the dial timeout. If that is not acceptable, `singleflight` gives you the same coalescing without holding a lock across the call.

### WaitGroup Add After Wait Race

If `wg.Add` runs on a different goroutine from `wg.Wait`, a race exists: `Wait` may observe a zero counter before all `Add` calls have executed, returning before any work has started. The fix is to call `Add` on the same goroutine that calls `Wait`, before launching the workers.

```go
// RACE CONDITION: Add after Wait starts
func processBad(items []Item) {
    var wg sync.WaitGroup

    go func() {
        for _, item := range items {
            wg.Add(1)  // RACE: What if Wait already called?
            go processItem(&wg, item)
        }
    }()

    wg.Wait()  // Might return before all items processed
}

// Scenario:
// 1. Main goroutine calls Wait() when counter is 0
// 2. Wait() returns immediately
// 3. Items goroutine starts adding work
// 4. Processing continues after Wait() returned!

// CORRECT: Add before starting goroutines
func processGood(items []Item) {
    var wg sync.WaitGroup

    wg.Add(len(items))  // Add all at once, before any goroutines

    for _, item := range items {
        go func(it Item) {
            defer wg.Done()
            processItem(it)
        }(item)
    }

    wg.Wait()  // Guaranteed to wait for all
}

// CORRECT: Add in same goroutine as Wait
func processGood2(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)  // Add in main goroutine
        go func(it Item) {
            defer wg.Done()
            processItem(it)
        }(item)
    }

    wg.Wait()  // Called after all Adds, guaranteed correct
}
```

### Atomic Operations Ordering Trap

Go's atomic operations are sequentially consistent, so an `atomic.Store` in one goroutine happens-before an `atomic.Load` in another goroutine that *observes that store*. Non-atomic writes sequenced before the store are therefore visible to the goroutine that observes the load. The flag-then-read pattern below is genuinely correct.

Be precise about the version, because this is commonly misstated: Go 1.19 did not *change* this behavior, it **documented** it. The memory model page gained an explicit section specifying that `sync/atomic` operations behave as sequentially consistent. The implementation already worked this way. So "safe since 1.19" is wrong, and so is any claim that older code was broken.

Correct is not the same as advisable. This pattern is fragile in a way that has nothing to do with the memory model:

```go
// FRAGILE: Relies on subtle memory model guarantee
var (
    data    []byte
    ready   atomic.Bool
)

func producer() {
    data = generateData()    // Non-atomic write
    ready.Store(true)        // Atomic write
}

func consumer() {
    if ready.Load() {        // Atomic read
        process(data)        // Correct, but fragile. See below.
    }
}

// Atomics are sequentially consistent, so a Load observing true
// happens-after the Store, and therefore after the write to data.
// This is correct. It is also one careless edit away from broken:
//   - Add a second field and forget to write it before ready.Store(true).
//   - Reorder the two lines in producer during a refactor.
//   - Add a writer that mutates data after ready is already true.
// Each is an ordinary-looking change, none is caught by the compiler,
// and only the third is caught by the race detector.

// CORRECT: Use atomic.Value for the data itself
var dataValue atomic.Value

func producerGood() {
    d := generateData()
    dataValue.Store(d)  // Atomic store of entire value
}

func consumerGood() {
    if d := dataValue.Load(); d != nil {
        process(d.([]byte))  // Safe - Load synchronizes
    }
}

// CORRECT: Use channel for synchronization
func withChannel() {
    ch := make(chan []byte, 1)

    go func() {
        d := generateData()
        ch <- d  // Channel send is synchronization point
    }()

    d := <-ch  // Channel receive synchronizes
    process(d)
}

// CORRECT: Use mutex for complex state
type State struct {
    mu   sync.Mutex
    data []byte
    ready bool
}

func (s *State) Set(data []byte) {
    s.mu.Lock()
    s.data = data
    s.ready = true
    s.mu.Unlock()  // Unlock is synchronization point
}

func (s *State) Get() ([]byte, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()
    return s.data, s.ready  // Lock acquire synchronizes
}
```

### sync.Pool Type Safety Trap

Because `sync.Pool.Get` returns `any`, nothing prevents a caller from putting the wrong type back into the pool. The next `Get` performs a type assertion that panics at runtime, often far from the line that stored the wrong value, making the crash difficult to trace.

```go
// BUG: Type confusion in pool
var bufPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func processorA() {
    buf := bufPool.Get().(*bytes.Buffer)
    // ... use buffer ...
    bufPool.Put(buf)
}

func processorB() {
    // Someone accidentally puts wrong type
    bufPool.Put([]byte("oops"))  // Compiles fine!
}

func processorC() {
    buf := bufPool.Get().(*bytes.Buffer)  // PANIC! Got []byte
    // ...
}

// CORRECT: Type-safe pool wrapper
type BufferPool struct {
    pool sync.Pool
}

func NewBufferPool(size int) *BufferPool {
    return &BufferPool{
        pool: sync.Pool{
            New: func() any {
                return bytes.NewBuffer(make([]byte, 0, size))
            },
        },
    }
}

func (p *BufferPool) Get() *bytes.Buffer {
    return p.pool.Get().(*bytes.Buffer)
}

func (p *BufferPool) Put(buf *bytes.Buffer) {
    buf.Reset()      // Always reset before putting back
    p.pool.Put(buf)  // Only accepts *bytes.Buffer
}

// Now type-safe:
// pool.Put([]byte("oops"))  // Compile error!
```

### Quick Reference: Sync Primitive Gotchas

| Primitive | Gotcha | Prevention |
|-----------|--------|------------|
| Mutex | Copying creates a second, independent lock | Use pointers, run `go vet` |
| Mutex | Not reentrant: self-deadlocks on the same-key path | Exported method locks, delegates to unexported helper |
| Mutex | `defer Unlock` in a loop holds every lock until the function returns | Unlock explicitly, or wrap the body in a closure |
| RWMutex | Cannot upgrade R to W lock | Release R before acquiring W, then re-check |
| RWMutex | Recursive `RLock` deadlocks behind a pending writer | Never re-enter a read lock you already hold |
| RWMutex | A read path that takes the write lock makes it a slow Mutex | Audit every `RLock` for a following `Lock` |
| Once | No retry on failure, and a panic still marks it done | `OnceValues` for errors, mutex + flag for retry |
| WaitGroup | `Add` after `Wait` races | `Add` before starting goroutines |
| Atomic | Ordering is fine (seq-cst), but the *pattern* is fragile | Publish the data itself via `atomic.Pointer`/`Value` |
| Pool | Type confusion, and references escaping past `Put` | Type-safe wrapper, plus copy anything that outlives `Put` |
| Cond | Condition may change before the woken waiter reacquires the lock | Always re-check the condition in a `for` loop |
| Cond | `Wait` is uninterruptible: no context, no deadline | Use a channel when waiters need cancellation |

### Staff Lens: The Debugging Story Pattern

Each of the debugging stories in this section follows the same shape: a symptom appears in production, the root cause is subtle synchronization, the fix requires understanding the Go memory model. The staff-level investment is documenting these stories as the team encounters them. A team with ten internal "debugging story" writeups has a living reference that prevents the next engineer from repeating the same mistake. Without the writeups, each incident is independently painful. With them, the team's synchronization competence compounds.

### Principal Lens: Synchronization Incidents Are a Leading Indicator

An org with frequent synchronization incidents is either operating at the edge of Go's synchronization capabilities (rare) or has insufficient review discipline (common). The principal-level diagnostic: track incidents attributable to mutex misuse, race conditions, deadlocks, or memory-ordering bugs. If the number is meaningful, the problem is not the language. It is the team's review and training practices. Fix those, not the individual bugs.

Before concluding it is a people problem, though, check that the cheap tooling is actually on, because it usually is not:

- **Is `-race` in CI, on the tests that exercise concurrency?** A race detector that only runs on serial unit tests finds nothing. It needs tests with real concurrent load.
- **Is `go vet` blocking the merge?** It catches copied locks for free.
- **Do the concurrent paths have tests at all?** Most synchronization bugs in this chapter pass a single-threaded test by construction.

The race detector cannot find deadlocks, and no tool finds "this `RWMutex` takes the write lock on every read". Those need review. But there is no point investing in review discipline for the bugs a tool would have caught first.

---
