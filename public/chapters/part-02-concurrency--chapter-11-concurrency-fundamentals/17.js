export default `## Production Concurrency: Real-World Pitfalls and Battle-Tested Patterns

This section consolidates concurrency wisdom from production systems, engineering blogs, open-source projects, and hard-won debugging experiences. These aren't theoretical concerns, they're issues that have caused outages at major companies.

### The Hidden Costs of Goroutine Creation

While goroutines are cheap (~2KB initial stack), they're not free. A 2021 incident at a major fintech company traced a 12-second latency spike to goroutine creation overhead during peak traffic:

\`\`\`go
// ANTI-PATTERN: Unbounded goroutine creation
// This caused a production incident handling 50K requests/second
func handleRequestBad(requests <-chan Request) {
    for req := range requests {
        go processRequest(req)  // Creates goroutine per request
    }
}

// During traffic spikes:
// - 50K goroutines created per second
// - Runtime scheduler overwhelmed
// - GC pauses increased from 1ms to 200ms
// - Stack growth caused memory pressure

// PRODUCTION PATTERN: Worker pool with bounded concurrency
type WorkerPool struct {
    workers    int
    jobQueue   chan Request
    resultChan chan Result
    ctx        context.Context
    cancel     context.CancelFunc
    wg         sync.WaitGroup
}

func NewWorkerPool(workers, queueSize int) *WorkerPool {
    ctx, cancel := context.WithCancel(context.Background())

    pool := &WorkerPool{
        workers:    workers,
        jobQueue:   make(chan Request, queueSize),
        resultChan: make(chan Result, queueSize),
        ctx:        ctx,
        cancel:     cancel,
    }

    pool.start()
    return pool
}

func (p *WorkerPool) start() {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func(workerID int) {
            defer p.wg.Done()
            for {
                select {
                case job, ok := <-p.jobQueue:
                    if !ok {
                        return
                    }
                    result := processRequest(job)
                    select {
                    case p.resultChan <- result:
                    case <-p.ctx.Done():
                        return
                    }
                case <-p.ctx.Done():
                    return
                }
            }
        }(i)
    }
}

// With worker pool:
// - Fixed 100 workers regardless of traffic
// - Predictable memory usage
// - Backpressure via queue depth
// - GC pauses stayed at 1-2ms
\`\`\`

### The sync.WaitGroup Copy Bug

One of the most insidious bugs in Go comes from passing \`sync.WaitGroup\` by value. This bug has made it to production at multiple companies because it compiles without errors:

\`\`\`go
// CRITICAL BUG: WaitGroup copied by value
func processBatchBad(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        go processItem(wg, item)  // BUG: wg copied!
    }

    wg.Wait()  // Returns immediately - Done() called on copies
}

func processItem(wg sync.WaitGroup, item Item) {  // BUG: value receiver
    defer wg.Done()  // Decrements the copy, not the original
    // ... process item
}

// This bug is silent - no error, no race detector warning
// The Wait() returns before goroutines finish
// Subsequent code may access incomplete results

// CORRECT: Always pass WaitGroup by pointer
func processBatchGood(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        go processItem(&wg, item)  // Pointer to original
    }

    wg.Wait()  // Waits correctly
}

func processItem(wg *sync.WaitGroup, item Item) {  // Pointer receiver
    defer wg.Done()  // Decrements the original
    // ... process item
}

// EVEN BETTER: Closure captures the pointer automatically
func processBatchBest(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        go func(it Item) {
            defer wg.Done()  // Captures &wg implicitly
            // ... process it
        }(item)
    }

    wg.Wait()
}
\`\`\`

### Channel Axioms: The Rules That Prevent Panics

Channel operations follow six axioms defined in the Go language specification. Memorize them, violating any one causes a panic or a permanent block:

\`\`\`go
// THE CHANNEL AXIOMS
// 1. A send to a nil channel blocks forever
// 2. A receive from a nil channel blocks forever
// 3. A send to a closed channel panics
// 4. A receive from a closed channel returns the zero value immediately
// 5. Closing a nil channel panics
// 6. Closing an already-closed channel panics

// DANGER: Sending to a closed channel
func badProducer(ch chan<- int) {
    for i := 0; i < 100; i++ {
        ch <- i  // PANIC if channel closed by another goroutine!
    }
}

// PATTERN: Safe channel closing with sync.Once
type SafeChannel struct {
    ch        chan int
    closeOnce sync.Once
    closed    atomic.Bool
}

func NewSafeChannel(size int) *SafeChannel {
    return &SafeChannel{
        ch: make(chan int, size),
    }
}

func (s *SafeChannel) Close() {
    s.closeOnce.Do(func() {
        s.closed.Store(true)
        close(s.ch)
    })
}

func (s *SafeChannel) Send(v int) bool {
    if s.closed.Load() {
        return false  // Channel already closed
    }

    // Still a race here - use recover for production
    defer func() {
        recover()  // Catch panic if channel closed between check and send
    }()

    select {
    case s.ch <- v:
        return true
    default:
        return false
    }
}

// BEST PRACTICE: Single owner pattern
// Only the owner (producer) should close the channel
type Pipeline struct {
    input  <-chan Data   // Read-only, not owned
    output chan<- Result // Write-only, owned - will be closed
}

func (p *Pipeline) Run(ctx context.Context) {
    defer close(p.output)  // Owner closes when done

    for {
        select {
        case data, ok := <-p.input:
            if !ok {
                return  // Input closed by upstream owner
            }
            p.output <- process(data)
        case <-ctx.Done():
            return
        }
    }
}
\`\`\`

### The Loop Variable Capture Bug (Pre-Go 1.22)

Before Go 1.22, this was the #1 concurrency bug in Go. It still appears in legacy code:

\`\`\`go
// BUG (Go < 1.22): Loop variable captured by reference
func processUsersBad(userIDs []string) {
    var wg sync.WaitGroup

    for _, id := range userIDs {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println("Processing:", id)  // BUG: All print the last ID!
        }()
    }

    wg.Wait()
}

// With userIDs = ["alice", "bob", "charlie"]
// Output (Go < 1.22):
//   Processing: charlie
//   Processing: charlie
//   Processing: charlie

// WHY: The closure captures &id, not the value
// By the time goroutines run, the loop has finished
// All goroutines see the final value of id

// FIX 1: Pass as parameter (works in all Go versions)
func processUsersFixed1(userIDs []string) {
    var wg sync.WaitGroup

    for _, id := range userIDs {
        wg.Add(1)
        go func(userID string) {  // Parameter creates new variable
            defer wg.Done()
            fmt.Println("Processing:", userID)
        }(id)  // Pass current value
    }

    wg.Wait()
}

// FIX 2: Create local copy (works in all Go versions)
func processUsersFixed2(userIDs []string) {
    var wg sync.WaitGroup

    for _, id := range userIDs {
        id := id  // Shadow with local copy (Go idiom)
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println("Processing:", id)
        }()
    }

    wg.Wait()
}

// Go 1.22+ FIX: Loop variables are per-iteration by default
// The original "bad" code works correctly in Go 1.22+!
// HOWEVER: Always use the explicit fix for backwards compatibility
// and code clarity
\`\`\`

### Context Cancellation: The Right and Wrong Ways

Context cancellation seems simple but has many gotchas:

\`\`\`go
// WRONG: Ignoring context in long-running operations
func queryDatabaseBad(ctx context.Context, query string) ([]Row, error) {
    // This ignores cancellation entirely!
    rows, err := db.Query(query)  // No ctx passed
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []Row
    for rows.Next() {  // Could run forever if query returns millions of rows
        var r Row
        rows.Scan(&r.ID, &r.Name)
        results = append(results, r)
    }
    return results, nil
}

// CORRECT: Respect context at every blocking operation
func queryDatabaseGood(ctx context.Context, query string) ([]Row, error) {
    rows, err := db.QueryContext(ctx, query)  // Pass context
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var results []Row
    for rows.Next() {
        // Check context periodically for long iterations
        select {
        case <-ctx.Done():
            return results, ctx.Err()  // Return partial results and error
        default:
        }

        var r Row
        if err := rows.Scan(&r.ID, &r.Name); err != nil {
            return results, err
        }
        results = append(results, r)
    }
    return results, rows.Err()
}

// WRONG: Creating context in the wrong place
func handleRequestBad(w http.ResponseWriter, r *http.Request) {
    // Don't create your own context - use the request's context!
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    result := doWork(ctx)  // If client disconnects, we keep working!
    json.NewEncoder(w).Encode(result)
}

// CORRECT: Use request context as parent
func handleRequestGood(w http.ResponseWriter, r *http.Request) {
    // Request context is cancelled when client disconnects
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    result := doWork(ctx)  // Cancels if client disconnects OR timeout
    json.NewEncoder(w).Encode(result)
}

// PRODUCTION PATTERN: Always call cancel, even if context times out
func withTimeout(parent context.Context, timeout time.Duration) (context.Context, func()) {
    ctx, cancel := context.WithTimeout(parent, timeout)

    // IMPORTANT: cancel() releases resources even if timeout fires
    // Memory leak if you don't call cancel()!
    return ctx, cancel
}
\`\`\`

### Race Conditions: Beyond the Race Detector

The race detector catches data races but not all race conditions:

\`\`\`go
// DATA RACE: Detected by -race flag
var counter int

func incrementBad() {
    counter++  // DATA RACE: read-modify-write is not atomic
}

// LOGIC RACE: NOT detected by -race flag
type Cache struct {
    mu    sync.RWMutex
    items map[string]Item
}

func (c *Cache) GetOrCreate(key string) Item {
    c.mu.RLock()
    item, exists := c.items[key]
    c.mu.RUnlock()

    if exists {
        return item
    }

    // LOGIC RACE: Another goroutine might create the same key here!
    // The race detector won't catch this.

    c.mu.Lock()
    defer c.mu.Unlock()

    // WRONG: Don't check again - may overwrite another goroutine's work
    newItem := createExpensiveItem(key)
    c.items[key] = newItem
    return newItem
}

// CORRECT: Double-checked locking pattern
func (c *Cache) GetOrCreateSafe(key string) Item {
    // First check with read lock (fast path)
    c.mu.RLock()
    item, exists := c.items[key]
    c.mu.RUnlock()

    if exists {
        return item
    }

    // Slow path: acquire write lock
    c.mu.Lock()
    defer c.mu.Unlock()

    // CRITICAL: Check again - another goroutine may have created it
    if item, exists := c.items[key]; exists {
        return item  // Someone else created it while we waited
    }

    // Now safe to create
    newItem := createExpensiveItem(key)
    c.items[key] = newItem
    return newItem
}

// ALTERNATIVE: Use sync.Map for this pattern
var cache sync.Map

func getOrCreateSyncMap(key string) Item {
    if item, ok := cache.Load(key); ok {
        return item.(Item)
    }

    // LoadOrStore is atomic - only one goroutine creates
    newItem := createExpensiveItem(key)
    actual, loaded := cache.LoadOrStore(key, newItem)

    if loaded {
        // Another goroutine stored first - use their value
        // Note: we wasted effort creating newItem, but it's correct
        return actual.(Item)
    }

    return newItem
}
\`\`\`

### Deadlock Patterns and Prevention

Understanding deadlock patterns helps you avoid them:

\`\`\`go
// DEADLOCK PATTERN 1: Lock ordering violation
type Account struct {
    mu      sync.Mutex
    balance int
    id      string
}

func transferBad(from, to *Account, amount int) {
    from.mu.Lock()
    defer from.mu.Unlock()

    to.mu.Lock()  // DEADLOCK if another goroutine does transfer(to, from, ...)
    defer to.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}

// Goroutine 1: transfer(A, B, 100)  - locks A, waits for B
// Goroutine 2: transfer(B, A, 50)   - locks B, waits for A
// DEADLOCK!

// FIX: Consistent lock ordering by ID
func transferSafe(from, to *Account, amount int) {
    // Always lock lower ID first
    first, second := from, to
    if from.id > to.id {
        first, second = to, from
    }

    first.mu.Lock()
    defer first.mu.Unlock()

    second.mu.Lock()
    defer second.mu.Unlock()

    from.balance -= amount
    to.balance += amount
}

// DEADLOCK PATTERN 2: Channel inside mutex
type Publisher struct {
    mu          sync.Mutex
    subscribers []chan Event
}

func (p *Publisher) PublishBad(event Event) {
    p.mu.Lock()
    defer p.mu.Unlock()

    for _, ch := range p.subscribers {
        ch <- event  // DEADLOCK: What if subscriber holds p.mu?
    }
}

// A subscriber trying to unsubscribe while receiving:
// 1. Publisher holds mu, tries to send to subscriber channel
// 2. Subscriber receives event, tries to call Unsubscribe (needs mu)
// DEADLOCK!

// FIX: Copy subscribers and send outside lock
func (p *Publisher) PublishSafe(event Event) {
    p.mu.Lock()
    subs := make([]chan Event, len(p.subscribers))
    copy(subs, p.subscribers)
    p.mu.Unlock()

    for _, ch := range subs {
        select {
        case ch <- event:
        default:
            // Subscriber not ready, skip or buffer
        }
    }
}

// DEADLOCK PATTERN 3: Waiting for yourself
func selfDeadlock() {
    ch := make(chan int)
    ch <- 1   // Blocks forever - no receiver exists yet
    <-ch      // Never reached
}

// FIX: Use goroutine or buffered channel
func noDeadlock1() {
    ch := make(chan int)
    go func() {
        ch <- 1  // Runs in background
    }()
    <-ch  // Can receive
}

func noDeadlock2() {
    ch := make(chan int, 1)  // Buffered
    ch <- 1  // Doesn't block
    <-ch     // Can receive
}
\`\`\`

### Memory Ordering and sync/atomic

Go's memory model is often misunderstood. Atomic operations alone don't guarantee ordering:

\`\`\`go
// WRONG: Atomics without proper synchronization
var (
    data  string
    ready atomic.Bool
)

func producerBad() {
    data = "hello"      // Regular write
    ready.Store(true)   // Atomic write
}

func consumerBad() {
    if ready.Load() {   // Atomic read
        fmt.Println(data)  // Regular read - might see old value!
    }
}

// The Go memory model doesn't guarantee that the non-atomic write
// to 'data' is visible to other goroutines before 'ready' is seen

// CORRECT: Use atomic.Value for structured data
var dataValue atomic.Value

func producerGood() {
    dataValue.Store("hello")  // Atomic store
}

func consumerGood() {
    if v := dataValue.Load(); v != nil {
        fmt.Println(v.(string))  // Safe
    }
}

// CORRECT: Use channels for synchronization
func producerChannel(ch chan<- string) {
    data := "hello"
    ch <- data  // Channel send is a synchronization point
}

func consumerChannel(ch <-chan string) {
    data := <-ch  // Channel receive synchronizes
    fmt.Println(data)  // Safe - sees producer's write
}

// UBER PATTERN: Atomic pointer swap for lock-free updates
type Config struct {
    MaxConns    int
    Timeout     time.Duration
    Endpoints   []string
}

type ConfigStore struct {
    config atomic.Pointer[Config]
}

func (s *ConfigStore) Get() *Config {
    return s.config.Load()
}

func (s *ConfigStore) Update(newConfig *Config) {
    s.config.Store(newConfig)  // Atomic pointer swap
    // Old config becomes garbage when no readers reference it
}

// Readers never block, no locks needed
// Writers create new config and swap pointer atomically
\`\`\`

### Goroutine Leak Detection in Production

Production systems need continuous leak detection:

\`\`\`go
// PRODUCTION PATTERN: Continuous goroutine monitoring
type GoroutineMonitor struct {
    baseline      int64
    alertCallback func(current, baseline int64)
    interval      time.Duration
    threshold     float64  // Alert if current > baseline * threshold
}

func NewGoroutineMonitor(alertFn func(int64, int64), interval time.Duration, threshold float64) *GoroutineMonitor {
    return &GoroutineMonitor{
        baseline:      int64(runtime.NumGoroutine()),
        alertCallback: alertFn,
        interval:      interval,
        threshold:     threshold,
    }
}

func (m *GoroutineMonitor) Start(ctx context.Context) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            current := int64(runtime.NumGoroutine())

            // Emit metric for dashboards
            metrics.Gauge("goroutine_count", current)

            // Check for potential leak
            if float64(current) > float64(m.baseline)*m.threshold {
                m.alertCallback(current, m.baseline)

                // Capture stack traces for debugging
                buf := make([]byte, 1<<20)
                n := runtime.Stack(buf, true)
                log.Printf("Goroutine spike detected. Stack traces:\\n%s", buf[:n])
            }

        case <-ctx.Done():
            return
        }
    }
}

// DATADOG-STYLE: Expose goroutine metrics
func init() {
    // Register with your metrics system
    go func() {
        for range time.Tick(10 * time.Second) {
            // These metrics should be on every Go service dashboard
            expvar.Publish("goroutines", expvar.Func(func() any {
                return runtime.NumGoroutine()
            }))

            var m runtime.MemStats
            runtime.ReadMemStats(&m)
            expvar.Publish("heap_alloc_bytes", expvar.Func(func() any {
                return m.HeapAlloc
            }))
        }
    }()
}
\`\`\`

### Testing Concurrent Code

Testing concurrent code requires special techniques:

\`\`\`go
// PATTERN 1: Use -race in tests
// go test -race ./...

// PATTERN 2: Stress testing with -count
// go test -race -count=100 ./...  # Run 100 times to catch races

// PATTERN 3: Use testing.T.Parallel() carefully
func TestConcurrentAccess(t *testing.T) {
    t.Parallel()  // Runs concurrently with other parallel tests

    cache := NewCache()
    var wg sync.WaitGroup

    // Stress test with concurrent access
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            key := fmt.Sprintf("key-%d", n%10)
            cache.Set(key, n)
            _ = cache.Get(key)
        }(i)
    }

    wg.Wait()
}

// PATTERN 4: Test for goroutine leaks
func TestNoLeaks(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run your code
    runConcurrentOperation()

    // Wait for cleanup
    time.Sleep(100 * time.Millisecond)
    runtime.GC()

    after := runtime.NumGoroutine()

    if after > before {
        t.Errorf("goroutine leak: before=%d, after=%d", before, after)
        // Print stack traces for debugging
        buf := make([]byte, 1<<20)
        n := runtime.Stack(buf, true)
        t.Logf("Stack traces:\\n%s", buf[:n])
    }
}

// PATTERN 5: Use goleak in tests
// import "go.uber.org/goleak"
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// PATTERN 6: Deterministic concurrency testing
type deterministicScheduler struct {
    steps []func()
    mu    sync.Mutex
    cond  *sync.Cond
    step  int
}

func (s *deterministicScheduler) runStep(stepNum int, fn func()) {
    s.mu.Lock()
    for s.step != stepNum {
        s.cond.Wait()
    }
    fn()
    s.step++
    s.cond.Broadcast()
    s.mu.Unlock()
}
\`\`\`

### Quick Reference: Concurrency Checklist

| Scenario | Pattern | Pitfall |
|----------|---------|---------|
| Multiple goroutines | Worker pool | Unbounded goroutine creation |
| Shared state | Mutex or channels | Data races |
| WaitGroup | Always pass by pointer | Copy causes early return |
| Channel close | Only owner closes | Panic on send to closed |
| Loop variables | Pass as parameter | Closure captures reference |
| Context | Use request context | Ignoring cancellation |
| Lock ordering | Consistent order by ID | Deadlock |
| Channel in mutex | Send outside lock | Deadlock with callbacks |
| Cache get-or-create | Double-checked locking | Logic race |
| Long operations | Check ctx.Done() | Zombie goroutines |

### Prefer singleflight for Get-or-Create

The double-checked locking shown above is correct, but for get-or-create patterns with expensive computation, \`golang.org/x/sync/singleflight\` is more idiomatic. It coalesces concurrent requests for the same key, guaranteeing only one creation call even under heavy concurrent load, with no hand-rolled locking:

\`\`\`go
var g singleflight.Group
func (c *Cache) GetOrCreate(key string) (Item, error) {
    v, err, _ := g.Do(key, func() (any, error) { return createExpensive(key) })
    return v.(Item), err
}
\`\`\`

\`singleflight\` is the canonical modern Go answer to cache-miss stampedes. Show this alongside double-checked locking as the production shape.

### Staff Lens: What Separates "Works" From "Works in Production"

The patterns in this section are the difference between concurrent code that passes unit tests and concurrent code that runs in production for years. The common thread: every pattern is about surviving unexpected conditions (client disconnect, downstream failure, traffic spike, concurrent modification) that rarely appear in development but always appear at scale. Build the shapes here into the team's muscle memory. A senior Go engineer should be able to spot each pitfall in review on sight. A staff engineer should ensure the tooling catches them before review.

### Principal Lens: Concurrency Maturity Is Cultural

Teams fall on a spectrum of concurrency maturity:

- **Level 1.** Team spawns goroutines liberally. Occasional deadlocks and leaks in production. Response is ad-hoc firefighting.
- **Level 2.** Team uses context.Context, race detector in CI, worker pools. Leaks rare. Response is systematic but reactive.
- **Level 3.** Team has shared helpers, design-review discipline, goleak in CI, goroutine metrics and alerts. Incidents are rare and well-documented.
- **Level 4.** Team treats concurrency as a first-class engineering concern. Every design doc has a concurrency section. Every service has goroutine-count SLOs. Postmortems drive systemic improvements. Culture is self-maintaining.

Most teams plateau at Level 2. Moving to Level 3 requires sustained investment from a staff or principal engineer. The investment is worth it: the incident rate drops by an order of magnitude, the on-call pain drops proportionally, and new engineers ramp up faster because the patterns are documented. This is among the clearest examples of principal-level engineering work paying compound interest over years.

---
`;
