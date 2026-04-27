export default `## Synchronization Pitfalls: Production Debugging Stories

The bugs in this section are drawn from recurring patterns in production Go systems. Each one compiles without error, passes \`go build\`, and appears correct on a cursory read, yet causes data corruption, deadlocks, or silent failures under concurrent load.

### The Mutex Copy Bug: Silent Corruption

Copying a struct that contains a mutex creates a second, independent lock, the copy and the original now protect different memory regions. Because the copy's mutex starts in its zero (unlocked) state, goroutines acquire it without blocking, and the shared map or slice behind the original pointer receives unprotected concurrent writes.

\`\`\`go
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

// CORRECT: Always use pointers with mutex-containing types
type Config struct {
    mu      sync.Mutex
    values  map[string]string
}

func processConfigs(configs []*Config) {
    for _, cfg := range configs {  // cfg is a pointer
        cfg.mu.Lock()              // Locks original's mutex
        defer cfg.mu.Unlock()
        process(cfg.values)
    }
}

// BETTER: Embed mutex in struct pointer
func updateConfigGood(cfg *Config, key, value string) {
    cfg.mu.Lock()
    defer cfg.mu.Unlock()
    cfg.values[key] = value
}

// PREVENTION: Use go vet
// go vet catches mutex copy at compile time
// go vet ./...
// ./main.go:10: call of processConfigs copies lock value: example.Config
\`\`\`

### RWMutex Upgrade Deadlock

Go's \`sync.RWMutex\` does not support atomic lock upgrade. Calling \`Lock()\` while still holding \`RLock()\` on the same goroutine deadlocks immediately: the write lock waits for all readers to release, but the calling goroutine is itself one of those readers and will never release while blocked on \`Lock()\`.

\`\`\`go
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
\`\`\`

### sync.Once Error Handling Bug

\`sync.Once\` marks the function as "done" regardless of its outcome. If the initializer returns an error or panics-then-recovers, the \`Once\` is spent, no subsequent call to \`Do\` will re-execute it, leaving the protected value permanently nil or in a broken state.

\`\`\`go
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

// CORRECT: Use sync.OnceValue (Go 1.21+)
var getClient = sync.OnceValue(func() *http.Client {
    client, err := createClient()
    if err != nil {
        panic(err)  // Or handle differently
    }
    return client
})

// CORRECT: Manual retry handling (pre-Go 1.21)
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
        return nil, fmt.Errorf("initialization failed previously: %w", l.initErr)
    }

    l.tried = true
    l.client, l.initErr = createClient()
    return l.client, l.initErr
}

// ALTERNATIVE: Retry with backoff
type RetryingClient struct {
    mu      sync.Mutex
    client  *http.Client
    lastTry time.Time
    backoff time.Duration
}

func (r *RetryingClient) Get() (*http.Client, error) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.client != nil {
        return r.client, nil
    }

    if time.Since(r.lastTry) < r.backoff {
        return nil, errors.New("too soon to retry")
    }

    r.lastTry = time.Now()
    client, err := createClient()
    if err != nil {
        r.backoff = min(r.backoff*2, 30*time.Second)  // Exponential backoff
        return nil, err
    }

    r.client = client
    return r.client, nil
}
\`\`\`

### WaitGroup Add After Wait Race

If \`wg.Add\` runs on a different goroutine from \`wg.Wait\`, a race exists: \`Wait\` may observe a zero counter before all \`Add\` calls have executed, returning before any work has started. The fix is to call \`Add\` on the same goroutine that calls \`Wait\`, before launching the workers.

\`\`\`go
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
\`\`\`

### Atomic Operations Ordering Trap

Go's memory model guarantees that atomic operations synchronize access to the atomic variable itself, and since Go 1.19, \`atomic.Store\` in one goroutine happens-before a later \`atomic.Load\` in another, meaning non-atomic writes that precede the store *are* visible to the goroutine that observes the load. However, relying on this requires careful reasoning, and wrapping the data itself in an \`atomic.Value\` or using a channel is far less error-prone:

\`\`\`go
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
        process(data)        // Since Go 1.19 this IS safe, but fragile
    }
}

// Since Go 1.19, atomic operations are sequentially consistent,
// so the Store happens-before a subsequent Load that observes true.
// However, this pattern is brittle and easy to break during refactoring.

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
\`\`\`

### sync.Pool Type Safety Trap

Because \`sync.Pool.Get\` returns \`any\`, nothing prevents a caller from putting the wrong type back into the pool. The next \`Get\` performs a type assertion that panics at runtime, often far from the line that stored the wrong value, making the crash difficult to trace.

\`\`\`go
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
\`\`\`

### Quick Reference: Sync Primitive Gotchas

| Primitive | Gotcha | Prevention |
|-----------|--------|------------|
| Mutex | Copying loses lock state | Use pointers, run \`go vet\` |
| RWMutex | Can't upgrade R to W lock | Release R before acquiring W |
| Once | No retry on failure | Use OnceValue or manual retry |
| WaitGroup | Add after Wait races | Add before starting goroutines |
| Atomic | Doesn't order non-atomics | Use atomic.Value or channels |
| Pool | Type confusion | Create type-safe wrapper |
| Cond | Spurious wakeups | Always use loop for Wait |

### Staff Lens: The Debugging Story Pattern

Each of the debugging stories in this section follows the same shape: a symptom appears in production, the root cause is subtle synchronization, the fix requires understanding the Go memory model. The staff-level investment is documenting these stories as the team encounters them. A team with ten internal "debugging story" writeups has a living reference that prevents the next engineer from repeating the same mistake. Without the writeups, each incident is independently painful. With them, the team's synchronization competence compounds.

### Principal Lens: Synchronization Incidents Are a Leading Indicator

An org with frequent synchronization incidents is either operating at the edge of Go's synchronization capabilities (rare) or has insufficient review discipline (common). The principal-level diagnostic: incidents per quarter attributable to mutex misuse, race conditions, deadlocks, or memory-ordering bugs. If the number is high, the problem is not the language. It is the team's review and training practices. Fix those, not the individual bugs. The investment is in people and process. The payoff is fewer incidents for years.

---
`;
