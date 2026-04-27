export default `## Real Incident Reports: Concurrency Bugs That Took Down Production

These anonymized incident reports from real companies show how each anti-pattern discussed in this chapter manifests in production, what symptoms operators observed, and how the teams fixed them.

### Incident #1: The Goroutine Leak That Crashed Production (Fintech)

**Symptoms**: Memory grew from 2GB to 32GB over 4 hours, then OOM killed.

\`\`\`go
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
// - Each goroutine holds ~8KB stack + request data
// - 1000 timeouts/hour = 80MB/hour of leaked memory
// - After 4 hours: crash

// THE FIX: Make goroutine respect context
func handlePaymentGood(ctx context.Context, payment Payment) error {
    resultCh := make(chan Result, 1)  // Buffered so send doesn't block

    go func() {
        result := callPaymentProvider(payment)
        select {
        case resultCh <- result:
        default:
            // Context was canceled, result discarded
            // But goroutine exits cleanly!
        }
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
\`\`\`

**Lessons**:
- Always provide exit path for goroutines
- Use buffered channels for fire-and-forget sends
- Monitor goroutine count in production

### Incident #2: The Silent Data Race (E-commerce)

**Symptoms**: Intermittent wrong prices shown to users, no errors logged.

\`\`\`go
// THE BUG: Map read during write
type PriceCache struct {
    prices map[string]float64  // No mutex!
}

func (c *PriceCache) Get(sku string) float64 {
    return c.prices[sku]  // Race with Set!
}

func (c *PriceCache) Set(sku string, price float64) {
    c.prices[sku] = price  // Race with Get!
}

// Goroutine A reads map
// Goroutine B writes map
// Map grows, triggers rehash
// Goroutine A reads garbage data
// Shows customer \$0.00 price (or \$999999)

// Race detector: go run -race ./...
// WARNING: DATA RACE at map access

// THE FIX: Proper synchronization
type SafePriceCache struct {
    mu     sync.RWMutex
    prices map[string]float64
}

func (c *SafePriceCache) Get(sku string) float64 {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.prices[sku]
}

func (c *SafePriceCache) Set(sku string, price float64) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.prices[sku] = price
}
\`\`\`

**Lessons**:
- Run \`-race\` in CI for all tests
- Data races don't always cause crashes
- Map operations are NEVER atomic

### Incident #3: The Deadlock Under Load (SaaS Platform)

**Symptoms**: System hung, no CPU usage, no errors, all requests timing out.

\`\`\`go
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
\`\`\`

**Lessons**:
- Document lock ordering in comments
- Deadlocks often only appear under load
- Use \`pprof/goroutine\` to diagnose hung systems

### Incident #4: The Channel Panic (Gaming Platform)

**Symptoms**: Panic: send on closed channel, crashed 20% of game servers.

\`\`\`go
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

// THE FIX: Single owner for close
type SafeGameRoom struct {
    events    chan Event
    closeOnce sync.Once
    closed    atomic.Bool
}

func (r *SafeGameRoom) Close() {
    r.closeOnce.Do(func() {
        r.closed.Store(true)
        close(r.events)
    })
}

func (r *SafeGameRoom) Broadcast(e Event) bool {
    if r.closed.Load() {
        return false
    }

    // Still need select in case of race
    select {
    case r.events <- e:
        return true
    default:
        return false
    }
}
\`\`\`

**Lessons**:
- Only one goroutine should close a channel
- Use sync.Once for safe closing
- Check closed state before sending

### Quick Diagnostic Guide

| Symptom | Likely Cause | Diagnostic Command |
|---------|--------------|-------------------|
| Memory grows forever | Goroutine leak | \`pprof/goroutine\` |
| Intermittent wrong data | Data race | \`go run -race\` |
| System hangs, no CPU | Deadlock | \`SIGQUIT\` for stack dump |
| Panic on send | Channel closed | Code review for close |
| Slow under load | Lock contention | \`pprof/mutex\` |
| Timeout storms | Unbounded goroutines | \`runtime.NumGoroutine()\` |

### Staff Lens: Incidents Are Teaching Material

Every concurrency incident is free teaching material. Write it up clearly. Include: the symptoms, the diagnostic steps, the root cause, the fix, and the systemic prevention. Share internally. Reference in training. The cost of the incident has already been paid; extracting maximum learning from it is the only way to recoup value.

### Principal Lens: Incident Rate as a Systemic Metric

The rate of concurrency incidents per quarter is a leading indicator of engineering maturity. A rate that trends upward signals the team's discipline or tooling is degrading. A rate that trends downward signals the prevention investment is paying off. Principal engineers should track this metric across services and invest where it is getting worse.

---
`;
