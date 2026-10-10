## Real Incident Reports: Concurrency Bugs That Took Down Production

These anonymized incident reports from real companies show how each anti-pattern discussed in this chapter manifests in production, what symptoms operators observed, and how the teams fixed them.

### Incident #1: The Goroutine Leak That Crashed Production (Fintech)

**Symptoms**: Memory grew from 2GB to 32GB over 4 hours, then OOM killed.

```go
// THE BUG: Goroutine never exits when request times out
func handlePaymentBad(ctx context.Context, payment Payment) error {
    resultCh := make(chan Result)

    go func() {
        // This goroutine runs to completion regardless of ctx
        result := callPaymentProvider(payment)  // Takes 30-60 seconds
        resultCh <- result  // BLOCKS FOREVER if ctx canceled!
    }()

    select {
    case result := <-resultCh:
        return processResult(result)
    case <-ctx.Done():
        return ctx.Err()  // Returns, but goroutine still running!
    }
}

// Over time:
// - Each timeout creates one leaked goroutine
// - Each goroutine holds its stack (2KB and up) plus the retained request data
// - 1000 timeouts/hour = tens of MB/hour of leaked memory
// - After 4 hours: crash

// THE FIX: one buffer slot, so the send can never block
func handlePaymentGood(ctx context.Context, payment Payment) error {
    resultCh := make(chan Result, 1)  // The entire fix is this `, 1`

    go func() {
        result := callPaymentProvider(payment)

        // A plain send is correct here. One sender, one buffer slot,
        // so the send always succeeds and this goroutine always exits,
        // receiver or not. The unread value is collected with the
        // channel. No select and no default are needed: adding them
        // implies the send might fail, which it cannot.
        resultCh <- result
    }()

    select {
    case result := <-resultCh:
        return processResult(result)
    case <-ctx.Done():
        return ctx.Err()
    }
}

// EVEN BETTER: Pass context to provider
func handlePaymentBest(ctx context.Context, payment Payment) error {
    return callPaymentProviderWithContext(ctx, payment)
}
```

**Lessons**:
- A `select` with a cancellation branch and an **unbuffered** result channel is a goroutine leak. Buffer result channels to the number of senders.
- Buffering guarantees the goroutine *exits*, not that the work *stops*. It still runs `callPaymentProvider` to completion, holding a connection and a stack. Only a context-aware provider call actually stops the work, which is why `handlePaymentBest` is best.
- Monitor goroutine count in production. This leak is invisible until it is an OOM.

### Incident #2: The Silent Data Race (E-commerce)

**Symptoms**: Intermittent wrong prices shown to users, no errors logged.

```go
// THE BUG: Map read during write
type PriceCache struct {
    prices map[string]int64  // No mutex! Price in cents
}

func (c *PriceCache) Get(sku string) int64 {
    return c.prices[sku]  // Race with Set!
}

func (c *PriceCache) Set(sku string, priceCents int64) {
    c.prices[sku] = priceCents  // Race with Get!
}

// Goroutine A reads map
// Goroutine B writes map
// Map grows, triggers rehash
// Goroutine A reads garbage data
// Shows customer 0 cents price (or 99999900)

// Race detector: go run -race ./...
// WARNING: DATA RACE at map access

// THE FIX: Proper synchronization
type SafePriceCache struct {
    mu     sync.RWMutex
    prices map[string]int64
}

func (c *SafePriceCache) Get(sku string) int64 {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.prices[sku]
}

func (c *SafePriceCache) Set(sku string, priceCents int64) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.prices[sku] = priceCents
}
```

**Lessons**:
- Run `-race` in CI for all tests
- Data races don't always cause crashes
- Map operations are NEVER atomic

### Incident #3: The Deadlock Under Load (SaaS Platform)

**Symptoms**: System hung, no CPU usage, no errors, all requests timing out.

```go
// THE BUG: Lock ordering violated under specific conditions
type UserService struct {
    userMu    sync.Mutex
    users     map[string]*User

    sessionMu sync.Mutex
    sessions  map[string]*Session
}

func (s *UserService) LoginBad(userID, sessionID string) {
    s.userMu.Lock()
    user := s.users[userID]
    // ... validate user ...

    s.sessionMu.Lock()  // Lock order: user -> session
    s.sessions[sessionID] = &Session{User: user}
    s.sessionMu.Unlock()

    s.userMu.Unlock()
}

func (s *UserService) LogoutBad(sessionID string) {
    s.sessionMu.Lock()
    session := s.sessions[sessionID]

    s.userMu.Lock()  // Lock order: session -> user (OPPOSITE!)
    // ... update user last seen ...
    s.userMu.Unlock()

    delete(s.sessions, sessionID)
    s.sessionMu.Unlock()
}

// Login: userMu -> sessionMu
// Logout: sessionMu -> userMu
// Under load, they deadlock!

// THE FIX: Consistent lock ordering
func (s *UserService) LoginGood(userID, sessionID string) {
    s.userMu.Lock()
    defer s.userMu.Unlock()

    user := s.users[userID]

    s.sessionMu.Lock()
    defer s.sessionMu.Unlock()

    s.sessions[sessionID] = &Session{User: user}
}

func (s *UserService) LogoutGood(sessionID string) {
    // SAME ORDER: user -> session
    s.userMu.Lock()
    defer s.userMu.Unlock()

    s.sessionMu.Lock()
    session := s.sessions[sessionID]
    delete(s.sessions, sessionID)
    s.sessionMu.Unlock()

    // Update user last seen
    if session != nil && session.User != nil {
        session.User.LastSeen = time.Now()
    }
}
```

**Lessons**:
- Document lock ordering in comments
- Deadlocks often only appear under load
- Use `pprof/goroutine` to diagnose hung systems

### Incident #4: The Channel Panic (Gaming Platform)

**Symptoms**: Panic: send on closed channel, crashed 20% of game servers.

```go
// THE BUG: Multiple closers
type GameRoom struct {
    events chan Event
}

func (r *GameRoom) PlayerQuitBad() {
    // Multiple players might quit simultaneously
    close(r.events)  // PANIC if already closed!
}

func (r *GameRoom) Broadcast(e Event) {
    r.events <- e  // PANIC if closed!
}

// THE "FIX" THAT STILL PANICS. This is what the team shipped next,
// and it kept crashing.
type StillBrokenGameRoom struct {
    events    chan Event
    closeOnce sync.Once
    closed    atomic.Bool
}

func (r *StillBrokenGameRoom) Close() {
    r.closeOnce.Do(func() {
        r.closed.Store(true)
        close(r.events)
    })
}

func (r *StillBrokenGameRoom) Broadcast(e Event) bool {
    if r.closed.Load() {
        return false // Close can land RIGHT HERE
    }

    // "Still need select in case of race" -- this comment is wrong, and
    // the belief behind it is what kept the pages coming. `default`
    // handles a FULL channel, not a CLOSED one. Sending on a closed
    // channel inside a select panics exactly as it would outside one.
    select {
    case r.events <- e:
        return true
    default:
        return false
    }
}
```

Two independent facts make that code panic, and both are worth verifying yourself:

```
select with default, sending on CLOSED channel -> panic: send on closed channel
StillBrokenGameRoom.Broadcast panicked: send on closed channel
```

First, `select` offers no protection at all: a send on a closed channel panics whether or not there is a `default`. Second, `closed.Load()` followed by a send is a check-then-act race, so `Close` can run in the window between them. An atomic flag cannot fix this, because the flag and the send are two separate operations and no amount of atomicity on the first makes the pair atomic.

There is no way to make "send on a channel someone else may close" safe. Stop trying, and remove the closer instead:

```go
// THE ACTUAL FIX: never close the data channel.
// Signal shutdown on a separate channel that has exactly one closer
// and no senders. Send-on-closed becomes unreachable by construction.
type SafeGameRoom struct {
    events    chan Event
    done      chan struct{}
    closeOnce sync.Once
}

func NewGameRoom(buf int) *SafeGameRoom {
    return &SafeGameRoom{
        events: make(chan Event, buf),
        done:   make(chan struct{}),
    }
}

// Close is idempotent and touches only `done`, never `events`.
func (r *SafeGameRoom) Close() {
    r.closeOnce.Do(func() { close(r.done) })
}

// Broadcast cannot panic. `events` is never closed by anyone.
func (r *SafeGameRoom) Broadcast(e Event) bool {
    select {
    case r.events <- e:
        return true
    case <-r.done: // Room is closing: give up cleanly
        return false
    default: // Room is full: drop rather than block the game loop
        return false
    }
}

// Consumers range until done rather than until the channel closes.
func (r *SafeGameRoom) Consume(handle func(Event)) {
    for {
        select {
        case e := <-r.events:
            handle(e)
        case <-r.done:
            return
        }
    }
}
```

**Lessons**:
- `select` with `default` does **not** make a send safe. It handles full, not closed.
- Checking a `closed` flag before sending is a check-then-act race, and no atomic fixes it.
- A channel has exactly one owner, and the owner is the sender. If several goroutines send, nobody may close.
- Signal shutdown with a separate `done` channel: one closer, zero senders, no panic possible.

### Quick Diagnostic Guide

| Symptom | Likely Cause | Diagnostic Command |
|---------|--------------|-------------------|
| Memory grows forever | Goroutine leak | `pprof/goroutine?debug=2`, or `pprof/goroutineleak` on 1.27 |
| Intermittent wrong data | Data race | `go run -race` |
| System hangs, **no CPU** | Deadlock | `pprof/goroutine?debug=2` (keeps the process alive) |
| System hangs, **full CPU** | Livelock or retry storm | CPU profile, plus two goroutine dumps to compare |
| Panic on send | Channel closed while senders remain | Code review for close: who owns it? |
| Slow under load | Lock contention | `pprof/mutex`, **after** `SetMutexProfileFraction` |
| Timeout storms | Unbounded goroutines | `runtime.NumGoroutine()` |

Two notes on that table, since both have cost people hours mid-incident. CPU usage is what separates deadlock from livelock: same symptom, opposite signature, opposite fix. And `pprof/mutex` returns an **empty profile** unless `runtime.SetMutexProfileFraction` was called at startup, so an empty result means "not recording", not "no contention". Prefer the pprof endpoint over `SIGQUIT` for a live process: `SIGQUIT` and `SIGABRT` dump every stack and then **kill** the process, which is fine for something you were going to restart and destructive otherwise.

### Staff Lens: Incidents Are Teaching Material

Every concurrency incident is free teaching material. Write it up clearly. Include: the symptoms, the diagnostic steps, the root cause, the fix, and the systemic prevention. Share internally. Reference in training. The cost of the incident has already been paid. Extracting maximum learning from it is the only way to recoup value.

### Principal Lens: Incident Rate as a Systemic Metric

The rate of concurrency incidents per quarter is a leading indicator of engineering maturity. A rate that trends upward signals the team's discipline or tooling is degrading. A rate that trends downward signals the prevention investment is paying off. Principal engineers should track this metric across services and invest where it is getting worse.

---
