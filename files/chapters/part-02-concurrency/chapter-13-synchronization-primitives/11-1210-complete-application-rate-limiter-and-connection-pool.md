## 13.10 Complete Application: Rate Limiter and Connection Pool

This section builds a production-grade rate limiter and connection pool system using the synchronization primitives covered so far.

### Project Structure

The project is split into three internal packages, `limiter`, `pool`, and `metrics`, each responsible for one production concern, with a thin `cmd/server` entry point that composes them into an HTTP service. Keeping the rate limiting algorithms and the connection pool as separate packages makes it straightforward to swap implementations or test them independently without coupling them to the HTTP layer.

```
limiter/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── limiter/
│   │   ├── limiter.go
│   │   ├── token_bucket.go
│   │   ├── sliding_window.go
│   │   └── limiter_test.go
│   ├── pool/
│   │   ├── pool.go
│   │   ├── connection.go
│   │   └── pool_test.go
│   └── metrics/
│       └── metrics.go
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### Rate Limiter Implementation

The `limiter.go` file defines the `Limiter` interface and the `TokenBucket` struct, which refills at a constant `rate` tokens per second up to a `burst` ceiling. When the bucket is empty, `WaitN` calculates the time needed to accumulate the required tokens and sleeps for that duration before retrying, giving callers a blocking API that still respects context cancellation. Allowed and denied counts are tracked with `atomic.Int64` so that `Stats` can be read without taking the mutex and without perturbing the request path.

One implementation detail worth noting: `WaitN` retries in a loop rather than by calling itself. Tail recursion is the natural way to express "sleep, then try again", but Go does not eliminate tail calls, so a caller waiting behind a slow refill grows the stack once per retry. A loop is the same logic with a bounded stack.

```go
// internal/limiter/limiter.go
package limiter

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

// Limiter defines the rate limiter interface
type Limiter interface {
    Allow() bool
    AllowN(n int) bool
    Wait(ctx context.Context) error
    WaitN(ctx context.Context, n int) error
    Limit() float64
    Burst() int
}

// TokenBucket implements token bucket rate limiting
type TokenBucket struct {
    mu sync.Mutex

    // Configuration
    rate     float64       // Tokens per second
    burst    int           // Maximum tokens

    // State
    tokens   float64
    lastTime time.Time

    // Metrics
    allowed  atomic.Int64
    denied   atomic.Int64
}

func NewTokenBucket(rate float64, burst int) *TokenBucket {
    return &TokenBucket{
        rate:     rate,
        burst:    burst,
        tokens:   float64(burst),
        lastTime: time.Now(),
    }
}

func (tb *TokenBucket) Allow() bool {
    return tb.AllowN(1)
}

func (tb *TokenBucket) AllowN(n int) bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    now := time.Now()
    tb.refill(now)

    if tb.tokens >= float64(n) {
        tb.tokens -= float64(n)
        tb.allowed.Add(1)
        return true
    }

    tb.denied.Add(1)
    return false
}

func (tb *TokenBucket) Wait(ctx context.Context) error {
    return tb.WaitN(ctx, 1)
}

func (tb *TokenBucket) WaitN(ctx context.Context, n int) error {
    if n > tb.burst {
        // Impossible to ever satisfy: the bucket never holds this many
        // tokens, so waiting would block forever. Fail fast instead.
        return fmt.Errorf("limiter: requested %d tokens exceeds burst %d", n, tb.burst)
    }

    for {
        // Check cancellation first so an already-cancelled context never
        // consumes tokens.
        if err := ctx.Err(); err != nil {
            tb.denied.Add(1)
            return err
        }

        tb.mu.Lock()
        tb.refill(time.Now())

        if tb.tokens >= float64(n) {
            tb.tokens -= float64(n)
            tb.mu.Unlock()
            tb.allowed.Add(1)
            return nil
        }

        // Calculate wait time
        needed := float64(n) - tb.tokens
        waitTime := time.Duration(needed / tb.rate * float64(time.Second))
        tb.mu.Unlock()

        timer := time.NewTimer(waitTime)
        select {
        case <-ctx.Done():
            timer.Stop()
            tb.denied.Add(1)
            return ctx.Err()
        case <-timer.C:
            // Loop and re-check: other waiters may have taken the tokens.
        }
    }
}

func (tb *TokenBucket) refill(now time.Time) {
    elapsed := now.Sub(tb.lastTime).Seconds()
    tb.tokens += elapsed * tb.rate
    if tb.tokens > float64(tb.burst) {
        tb.tokens = float64(tb.burst)
    }
    tb.lastTime = now
}

func (tb *TokenBucket) Limit() float64 {
    return tb.rate
}

func (tb *TokenBucket) Burst() int {
    return tb.burst
}

func (tb *TokenBucket) Stats() (allowed, denied int64) {
    return tb.allowed.Load(), tb.denied.Load()
}
```

### Sliding Window Rate Limiter

The `SlidingWindow` implementation stores the actual timestamps of recent requests and removes any that fall outside the rolling window on every call to `cleanup`, avoiding the burst-at-boundary problem that afflicts fixed-window approaches. This makes it more accurate for APIs where uniform distribution of requests matters, at the cost of slightly higher memory usage proportional to the configured `rate`.

```go
// internal/limiter/sliding_window.go
package limiter

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

// SlidingWindow implements sliding window rate limiting
type SlidingWindow struct {
    mu sync.Mutex

    // Configuration
    rate   int           // Requests per window
    window time.Duration

    // State: timestamps of recent requests
    requests []time.Time

    // Metrics
    allowed atomic.Int64
    denied  atomic.Int64
}

func NewSlidingWindow(rate int, window time.Duration) *SlidingWindow {
    return &SlidingWindow{
        rate:     rate,
        window:   window,
        requests: make([]time.Time, 0, rate),
    }
}

func (sw *SlidingWindow) Allow() bool {
    return sw.AllowN(1)
}

func (sw *SlidingWindow) AllowN(n int) bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    sw.cleanup(now)

    if len(sw.requests)+n <= sw.rate {
        for i := 0; i < n; i++ {
            sw.requests = append(sw.requests, now)
        }
        sw.allowed.Add(1)
        return true
    }

    sw.denied.Add(1)
    return false
}

func (sw *SlidingWindow) Wait(ctx context.Context) error {
    return sw.WaitN(ctx, 1)
}

func (sw *SlidingWindow) WaitN(ctx context.Context, n int) error {
    if n > sw.rate {
        // Impossible to ever satisfy: at most rate requests fit in the
        // window, so waiting would spin until the context cancels.
        // Fail fast instead, mirroring TokenBucket.WaitN.
        return fmt.Errorf("limiter: requested %d exceeds rate %d", n, sw.rate)
    }

    for {
        if sw.AllowN(n) {
            return nil
        }

        sw.mu.Lock()
        var waitTime time.Duration
        if len(sw.requests) > 0 {
            oldest := sw.requests[0]
            waitTime = sw.window - time.Since(oldest)
            if waitTime < 0 {
                waitTime = time.Millisecond
            }
        } else {
            waitTime = time.Millisecond
        }
        sw.mu.Unlock()

        timer := time.NewTimer(waitTime)
        select {
        case <-ctx.Done():
            timer.Stop()
            return ctx.Err()
        case <-timer.C:
            // Retry
        }
    }
}

func (sw *SlidingWindow) cleanup(now time.Time) {
    cutoff := now.Add(-sw.window)

    // Remove old requests
    i := 0
    for ; i < len(sw.requests); i++ {
        if sw.requests[i].After(cutoff) {
            break
        }
    }

    if i > 0 {
        sw.requests = sw.requests[i:]
    }
}

func (sw *SlidingWindow) Limit() float64 {
    return float64(sw.rate) / sw.window.Seconds()
}

func (sw *SlidingWindow) Burst() int {
    return sw.rate
}

func (sw *SlidingWindow) Stats() (allowed, denied int64) {
    return sw.allowed.Load(), sw.denied.Load()
}
```

### Per-Key Rate Limiter

`KeyedLimiter` wraps a map of `TokenBucket` instances indexed by an arbitrary string key (typically a client IP or user ID), taking a read lock for the common case where the bucket already exists and a write lock only when a new bucket must be created, with a double-check pattern to avoid redundant allocations. A background goroutine ticks every minute to evict buckets that have been idle for longer than `maxAge`, preventing unbounded memory growth in deployments with many ephemeral clients.

The subtlety is the idle-eviction bookkeeping. The obvious implementation stores `lastUsed` in a second map and updates it on every request, which quietly takes a write lock on the hot path and reduces the `RWMutex` to a slower `Mutex`: readers never run concurrently because every reader is a writer. Storing the timestamp as an `atomic.Int64` on the entry itself keeps the hot path on the read lock, where it belongs.

```go
// internal/limiter/keyed.go
package limiter

import (
    "context"
    "sync"
    "sync/atomic"
    "time"
)

// entry pairs a bucket with its last-use time. lastUsed is atomic so that
// touching it does not require the write lock.
type entry struct {
    bucket   *TokenBucket
    lastUsed atomic.Int64 // unix nanos
}

func (e *entry) touch() { e.lastUsed.Store(time.Now().UnixNano()) }

// KeyedLimiter provides per-key rate limiting
type KeyedLimiter struct {
    mu sync.RWMutex

    entries map[string]*entry
    rate    float64
    burst   int

    // Cleanup
    maxAge time.Duration
    stop   chan struct{}
    once   sync.Once
}

func NewKeyedLimiter(rate float64, burst int) *KeyedLimiter {
    kl := &KeyedLimiter{
        entries: make(map[string]*entry),
        rate:    rate,
        burst:   burst,
        maxAge:  time.Hour,
        stop:    make(chan struct{}),
    }

    // Start cleanup goroutine
    go kl.cleanupLoop()

    return kl
}

// Close stops the cleanup goroutine. Without it, NewKeyedLimiter leaks a
// goroutine that holds a reference to kl, so the limiter and every bucket
// it owns can never be collected. Harmless for a process-lifetime limiter
// created once in main, a real leak anywhere a limiter is per-tenant or
// created in a test.
func (kl *KeyedLimiter) Close() {
    kl.once.Do(func() { close(kl.stop) })
}

func (kl *KeyedLimiter) getLimiter(key string) *TokenBucket {
    // Fast path: read lock only. Readers run concurrently.
    kl.mu.RLock()
    e, ok := kl.entries[key]
    kl.mu.RUnlock()

    if ok {
        e.touch() // atomic, no write lock needed
        return e.bucket
    }

    kl.mu.Lock()
    defer kl.mu.Unlock()

    // Double-check after acquiring write lock
    if e, ok := kl.entries[key]; ok {
        e.touch()
        return e.bucket
    }

    e = &entry{bucket: NewTokenBucket(kl.rate, kl.burst)}
    e.touch()
    kl.entries[key] = e

    return e.bucket
}

func (kl *KeyedLimiter) Allow(key string) bool {
    return kl.getLimiter(key).Allow()
}

func (kl *KeyedLimiter) Wait(ctx context.Context, key string) error {
    return kl.getLimiter(key).Wait(ctx)
}

func (kl *KeyedLimiter) cleanupLoop() {
    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-kl.stop:
            return
        case <-ticker.C:
            kl.cleanup()
        }
    }
}

func (kl *KeyedLimiter) cleanup() {
    kl.mu.Lock()
    defer kl.mu.Unlock()

    cutoff := time.Now().Add(-kl.maxAge).UnixNano()
    for key, e := range kl.entries {
        if e.lastUsed.Load() < cutoff {
            delete(kl.entries, key)
        }
    }
}

func (kl *KeyedLimiter) Size() int {
    kl.mu.RLock()
    defer kl.mu.RUnlock()
    return len(kl.entries)
}
```

Collapsing the two maps into one also removes a class of bug that the two-map version invites: `limiters` and `lastUsed` must be inserted into and deleted from in lockstep forever, and any path that updates one without the other either leaks entries or evicts live buckets. One map with one entry type makes the invariant structural instead of a rule someone has to remember.

### Connection Pool Implementation

The `Pool` manages a LIFO idle list of `pooledConn` wrappers, preferring recently-used connections for better OS-level socket cache locality. When the pool is exhausted, callers are queued on per-waiter channels so they block efficiently without busy-polling. A maintenance goroutine periodically validates idle connections against `MaxLifetime` and `MaxIdleTime` thresholds and recreates any that have been closed to maintain the `MinSize` floor.

```go
// internal/pool/pool.go
package pool

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"
)

var (
    ErrPoolClosed   = errors.New("pool is closed")
    ErrPoolExhausted = errors.New("pool exhausted")
    ErrBadConn      = errors.New("bad connection")
)

// Connection represents a pooled connection
type Connection interface {
    Close() error
    IsAlive() bool
    Reset() error
}

// Factory creates new connections
type Factory func(ctx context.Context) (Connection, error)

// Config holds pool configuration
type Config struct {
    MaxSize         int
    MinSize         int
    MaxIdleTime     time.Duration
    MaxLifetime     time.Duration
    AcquireTimeout  time.Duration
    HealthCheckInterval time.Duration
}

// Pool manages a pool of connections
type Pool struct {
    mu sync.Mutex

    config  Config
    factory Factory

    // Connection management
    idle    []pooledConn
    inUse   int
    total   int

    // birth tracks each live connection's original creation time.
    // Release only receives a Connection, so without this the pool has
    // no way to recover the age of a returning connection, and
    // MaxLifetime silently never fires. See Release below.
    birth map[Connection]time.Time

    // Waiters queue. Each channel is buffered(1) and used exactly once,
    // so a hand-off never blocks the releasing goroutine.
    waiters []chan Connection

    // State
    closed atomic.Bool
    stop   chan struct{} // closes to stop the maintenance goroutine

    // Metrics
    acquired    atomic.Int64
    released    atomic.Int64
    created     atomic.Int64
    closedConns atomic.Int64
    timeouts    atomic.Int64
}

type pooledConn struct {
    conn      Connection
    createdAt time.Time
    lastUsed  time.Time
}

func NewPool(config Config, factory Factory) (*Pool, error) {
    if config.MaxSize <= 0 {
        return nil, errors.New("pool: MaxSize must be > 0")
    }
    if config.MinSize < 0 || config.MinSize > config.MaxSize {
        return nil, errors.New("pool: MinSize must be between 0 and MaxSize")
    }
    if config.HealthCheckInterval <= 0 {
        // time.NewTicker panics on a non-positive duration, so a zero-value
        // Config would crash the maintenance goroutine at startup.
        config.HealthCheckInterval = time.Minute
    }

    p := &Pool{
        config:  config,
        factory: factory,
        idle:    make([]pooledConn, 0, config.MaxSize),
        birth:   make(map[Connection]time.Time),
        waiters: make([]chan Connection, 0),
        stop:    make(chan struct{}),
    }

    // Pre-warm pool
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    for i := 0; i < config.MinSize; i++ {
        conn, err := factory(ctx)
        if err != nil {
            p.Close()
            return nil, err
        }
        now := time.Now()
        p.idle = append(p.idle, pooledConn{
            conn:      conn,
            createdAt: now,
            lastUsed:  now,
        })
        p.birth[conn] = now
        p.total++
        p.created.Add(1)
    }

    // Start maintenance goroutine
    go p.maintenance()

    return p, nil
}

func (p *Pool) Acquire(ctx context.Context) (Connection, error) {
    if p.closed.Load() {
        return nil, ErrPoolClosed
    }

    p.mu.Lock()

    // Try to get idle connection
    for len(p.idle) > 0 {
        // Get from end (LIFO for better locality)
        pc := p.idle[len(p.idle)-1]
        p.idle = p.idle[:len(p.idle)-1]

        // Check if connection is still valid
        if !p.isValid(pc) {
            p.total--
            delete(p.birth, pc.conn)
            p.mu.Unlock()
            pc.conn.Close()
            p.closedConns.Add(1)
            p.mu.Lock()
            continue
        }

        p.inUse++
        p.mu.Unlock()
        p.acquired.Add(1)
        return pc.conn, nil
    }

    // Create new connection if below max
    if p.total < p.config.MaxSize {
        p.total++
        p.inUse++
        p.mu.Unlock()

        conn, err := p.factory(ctx)
        if err != nil {
            p.mu.Lock()
            p.total--
            p.inUse--
            p.mu.Unlock()
            return nil, err
        }

        p.mu.Lock()
        p.birth[conn] = time.Now()
        p.mu.Unlock()

        p.created.Add(1)
        p.acquired.Add(1)
        return conn, nil
    }

    // Pool exhausted, wait for release
    ch := make(chan Connection, 1)
    p.waiters = append(p.waiters, ch)
    p.mu.Unlock()

    // Wait with timeout
    timeout := p.config.AcquireTimeout
    if deadline, ok := ctx.Deadline(); ok {
        remaining := time.Until(deadline)
        if remaining < timeout {
            timeout = remaining
        }
    }

    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case conn, ok := <-ch:
        // ok is false when Close closed the channel out from under us.
        // Without this check Acquire returns (nil, nil) and the caller
        // nil-dereferences a connection it believes is valid.
        if !ok {
            return nil, ErrPoolClosed
        }
        p.acquired.Add(1)
        return conn, nil
    case <-ctx.Done():
        p.abandonWaiter(ch)
        p.timeouts.Add(1)
        return nil, ctx.Err()
    case <-timer.C:
        p.abandonWaiter(ch)
        p.timeouts.Add(1)
        return nil, ErrPoolExhausted
    }
}

func (p *Pool) Release(conn Connection) {
    if p.closed.Load() {
        conn.Close()
        return
    }

    p.released.Add(1)

    // Reset connection state
    if err := conn.Reset(); err != nil || !conn.IsAlive() {
        p.mu.Lock()
        p.inUse--
        p.total--
        delete(p.birth, conn)
        p.mu.Unlock()
        conn.Close()
        p.closedConns.Add(1)
        return
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    p.inUse--

    // Give to the longest-waiting caller if any.
    // Each waiter channel is buffered(1) and used exactly once, so this
    // send never blocks and never needs a default branch.
    if len(p.waiters) > 0 {
        ch := p.waiters[0]
        p.waiters = p.waiters[1:]
        ch <- conn
        p.inUse++
        return
    }

    // Return to idle pool, preserving the ORIGINAL creation time.
    // Stamping time.Now() here would reset the connection's age on every
    // round trip, so MaxLifetime would never fire and connections would
    // live forever.
    createdAt, ok := p.birth[conn]
    if !ok {
        createdAt = time.Now()
        p.birth[conn] = createdAt
    }
    p.idle = append(p.idle, pooledConn{
        conn:      conn,
        createdAt: createdAt,
        lastUsed:  time.Now(),
    })
}

func (p *Pool) isValid(pc pooledConn) bool {
    // Check max lifetime
    if p.config.MaxLifetime > 0 && time.Since(pc.createdAt) > p.config.MaxLifetime {
        return false
    }

    // Check max idle time
    if p.config.MaxIdleTime > 0 && time.Since(pc.lastUsed) > p.config.MaxIdleTime {
        return false
    }

    // Check connection health
    return pc.conn.IsAlive()
}

// removeWaiter unqueues ch and reports whether it was still queued.
// A false return means a concurrent Release already popped ch and has
// therefore already handed a connection into it.
func (p *Pool) removeWaiter(ch chan Connection) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    for i, w := range p.waiters {
        if w == ch {
            p.waiters = append(p.waiters[:i], p.waiters[i+1:]...)
            return true
        }
    }
    return false
}

// abandonWaiter gives up on a queued acquire. It exists because "the caller
// timed out" and "a connection was handed to the caller" can happen at the
// same instant, and select picks a winner at random. If ctx.Done wins the
// race but Release already delivered a connection, that connection is sitting
// in ch with nobody to receive it: the pool's inUse count was incremented and
// will never be decremented, so the slot is lost for the lifetime of the
// process. Enough of those and the pool wedges at MaxSize with zero usable
// connections. Recover the in-flight connection instead of dropping it.
func (p *Pool) abandonWaiter(ch chan Connection) {
    if p.removeWaiter(ch) {
        return // still queued: nothing was handed off, nothing to recover
    }
    // Not queued, so a value is already in the buffer (or Close closed it).
    // Neither case blocks.
    if conn, ok := <-ch; ok {
        p.Release(conn)
    }
}

func (p *Pool) maintenance() {
    ticker := time.NewTicker(p.config.HealthCheckInterval)
    defer ticker.Stop()

    for {
        // Select on stop as well as the ticker. Checking p.closed only on
        // each tick would keep this goroutine alive for up to a full
        // HealthCheckInterval after Close returns, which makes tests flaky
        // and shows up as a leak in goroutine profiles.
        select {
        case <-p.stop:
            return
        case <-ticker.C:
        }

        p.mu.Lock()

        // Remove stale idle connections
        valid := make([]pooledConn, 0, len(p.idle))
        for _, pc := range p.idle {
            if p.isValid(pc) {
                valid = append(valid, pc)
            } else {
                p.total--
                delete(p.birth, pc.conn)
                go func(c Connection) {
                    c.Close()
                    p.closedConns.Add(1)
                }(pc.conn)
            }
        }
        p.idle = valid

        // Ensure minimum connections
        toCreate := p.config.MinSize - p.total
        p.mu.Unlock()

        for i := 0; i < toCreate; i++ {
            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            conn, err := p.factory(ctx)
            cancel()

            if err != nil {
                continue
            }

            p.mu.Lock()
            // Re-check under the lock: Close may have run while we dialed,
            // and Acquire may have created connections concurrently.
            if p.closed.Load() || p.total >= p.config.MaxSize {
                p.mu.Unlock()
                conn.Close()
                continue
            }
            now := time.Now()
            p.idle = append(p.idle, pooledConn{
                conn:      conn,
                createdAt: now,
                lastUsed:  now,
            })
            p.birth[conn] = now
            p.total++
            p.created.Add(1)
            p.mu.Unlock()
        }
    }
}

func (p *Pool) Close() error {
    if !p.closed.CompareAndSwap(false, true) {
        return nil // CompareAndSwap, not Store: Close must be idempotent
    }
    close(p.stop)

    p.mu.Lock()
    defer p.mu.Unlock()

    // Close all idle connections
    for _, pc := range p.idle {
        pc.conn.Close()
        delete(p.birth, pc.conn)
    }
    p.idle = nil

    // Wake up waiters. Closing each channel makes their Acquire return
    // ErrPoolClosed rather than blocking until their timeout expires.
    for _, ch := range p.waiters {
        close(ch)
    }
    p.waiters = nil

    return nil
}

// Stats returns pool statistics
type Stats struct {
    Total    int
    InUse    int
    Idle     int
    Waiters  int
    Acquired int64
    Released int64
    Created  int64
    Closed   int64
    Timeouts int64
}

func (p *Pool) Stats() Stats {
    p.mu.Lock()
    defer p.mu.Unlock()

    return Stats{
        Total:    p.total,
        InUse:    p.inUse,
        Idle:     len(p.idle),
        Waiters:  len(p.waiters),
        Acquired: p.acquired.Load(),
        Released: p.released.Load(),
        Created:  p.created.Load(),
        Closed:   p.closedConns.Load(),
        Timeouts: p.timeouts.Load(),
    }
}
```

### Main Application

The server wires the `KeyedLimiter` and the connection `Pool` into a standard `http.ServeMux`, applying rate limiting as an HTTP middleware that checks the client IP before any handler runs and returns `429 Too Many Requests` on violation. Signal-aware graceful shutdown ensures in-flight requests complete within a 30-second window before the process exits, preserving connection pool resources through the `defer connPool.Close()` call.

```go
// cmd/server/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "os/signal"
    "strings"
    "sync/atomic"
    "syscall"
    "time"

    "limiter/internal/limiter"
    "limiter/internal/pool"
)

type Server struct {
    rateLimiter *limiter.KeyedLimiter
    connPool    *pool.Pool
    requestID   atomic.Int64
}

func main() {
    // Create rate limiter: 100 tokens/sec refill, burst 10, per client
    rl := limiter.NewKeyedLimiter(100, 10)
    defer rl.Close()

    // Create connection pool
    poolConfig := pool.Config{
        MaxSize:             50,
        MinSize:             10,
        MaxIdleTime:         5 * time.Minute,
        MaxLifetime:         30 * time.Minute,
        AcquireTimeout:      5 * time.Second,
        HealthCheckInterval: time.Minute,
    }

    connPool, err := pool.NewPool(poolConfig, createConnection)
    if err != nil {
        log.Fatalf("Failed to create pool: %v", err)
    }
    defer connPool.Close()

    server := &Server{
        rateLimiter: rl,
        connPool:    connPool,
    }

    // Setup HTTP server
    mux := http.NewServeMux()
    mux.HandleFunc("/api/data", server.handleData)
    mux.HandleFunc("/api/stats", server.handleStats)
    mux.HandleFunc("/health", server.handleHealth)

    httpServer := &http.Server{
        Addr:         ":8080",
        Handler:      server.rateLimitMiddleware(mux),
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        httpServer.Shutdown(ctx)
    }()

    log.Println("Server starting on :8080")
    if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("Server error: %v", err)
    }
}

func createConnection(ctx context.Context) (pool.Connection, error) {
    // Simulated connection (e.g., database)
    conn, err := net.DialTimeout("tcp", "localhost:5432", 5*time.Second)
    if err != nil {
        return nil, err
    }
    return &tcpConnection{conn: conn}, nil
}

type tcpConnection struct {
    conn net.Conn
}

func (c *tcpConnection) Close() error {
    return c.conn.Close()
}

func (c *tcpConnection) IsAlive() bool {
    c.conn.SetReadDeadline(time.Now().Add(time.Millisecond))
    one := make([]byte, 1)
    if _, err := c.conn.Read(one); err != nil {
        if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
            c.conn.SetReadDeadline(time.Time{})
            return true
        }
        return false
    }
    return true
}

func (c *tcpConnection) Reset() error {
    return nil
}

func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        clientIP := getClientIP(r)

        if !s.rateLimiter.Allow(clientIP) {
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func (s *Server) handleData(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    requestID := s.requestID.Add(1)

    // Acquire connection from pool
    conn, err := s.connPool.Acquire(ctx)
    if err != nil {
        http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
        return
    }
    defer s.connPool.Release(conn)

    // Use connection...
    response := map[string]any{
        "request_id": requestID,
        "status":     "success",
        "timestamp":  time.Now().Unix(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
    stats := s.connPool.Stats()

    response := map[string]any{
        "pool": map[string]any{
            "total":    stats.Total,
            "in_use":   stats.InUse,
            "idle":     stats.Idle,
            "waiters":  stats.Waiters,
            "acquired": stats.Acquired,
            "released": stats.Released,
            "created":  stats.Created,
            "closed":   stats.Closed,
            "timeouts": stats.Timeouts,
        },
        "rate_limiter": map[string]any{
            "active_keys": s.rateLimiter.Size(),
        },
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// getClientIP resolves the rate-limiting key for a request.
//
// SECURITY: X-Forwarded-For and X-Real-IP are attacker-controlled. Any client
// can send whatever it likes in them. Keying a rate limiter off a header that
// the rate-limited party controls means an attacker sends a fresh random value
// per request, gets a brand new bucket every time, and is never limited at all.
// The same forged header also poisons the eviction map with unbounded garbage
// keys, which turns the limiter into a memory-exhaustion vector.
//
// Trust these headers only when the request provably arrived through your own
// proxy, and then trust only the hop your proxy appended. trustedProxy reports
// whether r.RemoteAddr is one of your load balancers.
func getClientIP(r *http.Request) string {
    host, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        host = r.RemoteAddr
    }

    if !trustedProxy(host) {
        // Direct connection: the socket peer is the only trustworthy identity.
        return host
    }

    // Behind our own proxy: take the RIGHTMOST XFF entry, which is the one
    // our proxy appended. The leftmost entries are whatever the client sent
    // and are forgeable.
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        parts := strings.Split(xff, ",")
        candidate := strings.TrimSpace(parts[len(parts)-1])
        if ip := net.ParseIP(candidate); ip != nil {
            return ip.String()
        }
    }
    if xri := r.Header.Get("X-Real-IP"); xri != "" {
        if ip := net.ParseIP(strings.TrimSpace(xri)); ip != nil {
            return ip.String()
        }
    }
    return host
}

// trustedProxy reports whether addr is one of our own load balancers.
// Configure this from your actual infrastructure, never leave it wide open.
func trustedProxy(addr string) bool {
    ip := net.ParseIP(addr)
    if ip == nil {
        return false
    }
    for _, cidr := range trustedProxyCIDRs {
        if cidr.Contains(ip) {
            return true
        }
    }
    return false
}

var trustedProxyCIDRs = func() []*net.IPNet {
    // Replace with your load balancer ranges.
    raw := []string{"10.0.0.0/8"}
    nets := make([]*net.IPNet, 0, len(raw))
    for _, s := range raw {
        if _, n, err := net.ParseCIDR(s); err == nil {
            nets = append(nets, n)
        }
    }
    return nets
}()
```

The original version of this function returned the raw `X-Forwarded-For` header whenever it was present. That single line disables the entire rate limiter. `curl -H "X-Forwarded-For: $RANDOM" ...` in a loop creates a new bucket per request and sails past a limit that looks correct in code review and in every test written against it, because tests do not forge headers. The rule generalizes beyond rate limiting: **any identity you derive from a request header is only as trustworthy as the hop that set it.**

### Tests

The test suite verifies both correctness and concurrency safety: `TestTokenBucket_Allow` confirms burst exhaustion and token refill timing, while `TestTokenBucket_Concurrent` fires 1000 simultaneous goroutines and asserts that the allowed count lands near the burst size.

Be honest about that last assertion. The bound is wide (50 to 150 for a burst of 100) because the bucket refills while the test runs, so the exact number depends on how long the goroutines take to be scheduled. It is a smoke test that catches gross overcounting, not a precise guarantee, and a wide range is the price of asserting against a wall-clock-dependent value. If you want a precise assertion, inject a clock instead of reading `time.Now` directly, or run the test under `testing/synctest` (Go 1.25), where time is virtual and the result is deterministic. Timing tolerances are a symptom of untestable time handling, not a testing best practice.

Run all of it with `-race`. A rate limiter that is correct single-threaded and racy under load is worse than no rate limiter, because it fails silently.

```go
// internal/limiter/limiter_test.go
package limiter

import (
    "context"
    "sync"
    "sync/atomic"
    "testing"
    "time"
)

func TestTokenBucket_Allow(t *testing.T) {
    tb := NewTokenBucket(10, 5) // 10 tokens/sec, burst 5

    // Should allow burst
    for i := 0; i < 5; i++ {
        if !tb.Allow() {
            t.Errorf("Expected allow at request %d", i)
        }
    }

    // Should deny after burst
    if tb.Allow() {
        t.Error("Expected deny after burst exhausted")
    }

    // Wait for refill
    time.Sleep(200 * time.Millisecond) // Should have ~2 tokens

    if !tb.Allow() {
        t.Error("Expected allow after refill")
    }
}

func TestTokenBucket_Concurrent(t *testing.T) {
    tb := NewTokenBucket(1000, 100)

    var allowed atomic.Int64
    var denied atomic.Int64

    var wg sync.WaitGroup
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            if tb.Allow() {
                allowed.Add(1)
            } else {
                denied.Add(1)
            }
        }()
    }

    wg.Wait()

    // Should allow approximately burst amount
    if allowed.Load() < 50 || allowed.Load() > 150 {
        t.Errorf("Expected ~100 allowed, got %d", allowed.Load())
    }
}

func TestSlidingWindow_RateLimit(t *testing.T) {
    sw := NewSlidingWindow(10, time.Second) // 10 requests per second

    // Allow initial burst
    for i := 0; i < 10; i++ {
        if !sw.Allow() {
            t.Errorf("Expected allow at request %d", i)
        }
    }

    // Should deny
    if sw.Allow() {
        t.Error("Expected deny after limit")
    }

    // Wait for window to slide
    time.Sleep(1100 * time.Millisecond)

    if !sw.Allow() {
        t.Error("Expected allow after window slides")
    }
}

func TestKeyedLimiter(t *testing.T) {
    kl := NewKeyedLimiter(10, 5)
    defer kl.Close() // stop the cleanup goroutine, or every test leaks one

    // Different keys have independent limits
    for i := 0; i < 5; i++ {
        if !kl.Allow("user1") {
            t.Errorf("Expected allow for user1 at request %d", i)
        }
        if !kl.Allow("user2") {
            t.Errorf("Expected allow for user2 at request %d", i)
        }
    }

    // Both exhausted
    if kl.Allow("user1") {
        t.Error("Expected deny for user1")
    }
    if kl.Allow("user2") {
        t.Error("Expected deny for user2")
    }
}

func BenchmarkTokenBucket(b *testing.B) {
    tb := NewTokenBucket(1000000, 1000)

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            tb.Allow()
        }
    })
}

func BenchmarkSlidingWindow(b *testing.B) {
    sw := NewSlidingWindow(1000000, time.Second)

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            sw.Allow()
        }
    })
}
```

### Dockerfile

The two-stage Dockerfile compiles the server binary with CGO disabled and stripped debug symbols for a minimal, statically-linked artifact, then copies it into a bare `alpine` image that runs as the unprivileged `nobody` user. Disabling CGO ensures the binary has no dynamic library dependencies and will run identically across all Alpine-based container environments.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server

FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/server .

EXPOSE 8080

USER nobody:nobody

ENTRYPOINT ["./server"]
```

### docker-compose.yml

The Compose stack pairs the server with PostgreSQL, Prometheus, and Grafana, giving developers a complete local observability setup out of the box. The server's health check uses `wget`, available in Alpine without additional packages, to poll the `/health` endpoint before marking the container ready, preventing dependent services from starting before the port is actually accepting requests.

```yaml
# docker-compose.yml
# Note: the top-level "version" key is obsolete in Compose v2 and
# current versions warn about it. Omit it.

services:
  server:
    build: .
    ports:
      - "8080:8080"
    environment:
      - GOMAXPROCS=4
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 128M

  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    volumes:
      - postgres_data:/var/lib/postgresql/data

  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

volumes:
  postgres_data:
```

### Makefile

The Makefile provides a `benchmark` target that runs `go test -bench` against both the `limiter` and `pool` packages separately, making it easy to isolate which subsystem is the bottleneck. The `load-test` target invokes `hey` against the running server, providing a quick way to verify end-to-end rate limiting behavior under realistic concurrent load without extra tooling.

```makefile
# Makefile
.PHONY: build test run docker clean benchmark lint

BINARY=server
DOCKER_IMAGE=limiter-server

build:
	go build -o bin/$(BINARY) ./cmd/server

test:
	go test -v -race -cover ./...

test-coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

benchmark:
	go test -bench=. -benchmem ./internal/limiter/
	go test -bench=. -benchmem ./internal/pool/

run: build
	./bin/$(BINARY)

docker-build:
	docker build -t $(DOCKER_IMAGE) .

docker-run:
	docker-compose up -d

docker-stop:
	docker-compose down

lint:
	golangci-lint run

clean:
	rm -rf bin/
	rm -f coverage.out coverage.html

load-test:
	hey -n 10000 -c 100 http://localhost:8080/api/data
```

### Staff Lens: What This Example Teaches

The complete application composes several synchronization primitives: atomic counters for metrics, mutex for the pool's internal state, channels for work distribution, context for cancellation. This is typical of real services. The lesson is recognizing which primitive fits each piece: lock-free counters for hot metrics, mutexes for the pool invariants, channels for coordination, context for lifetime.

### Production Gaps to Close

Before running this in production:

1. **Pool size tuning.** Size against downstream capacity, not hope. A pool larger than what the database can serve just moves the queue from your process to the database, where it is harder to see. Monitor utilization and saturation, not just averages.
2. **Graceful shutdown.** `httpServer.Shutdown` drains in-flight requests, but nothing here waits for them before `defer connPool.Close()` runs, so a request still holding a connection can race the pool's close. Sequence shutdown explicitly: stop accepting, drain handlers, then close the pool.
3. **Metrics instrumentation.** The `Stats` counters exist but are only exposed on an ad-hoc `/api/stats` endpoint. Export them to your metrics system, and add a histogram of connection wait time, which is the number that predicts an outage before it happens.
4. **Leaked checkouts.** If a caller panics between `Acquire` and `Release`, the deferred `Release` in the handler saves you, but a caller that forgets the `defer` leaks a slot permanently. The pool cannot detect this. Consider a checkout deadline and a reaper for connections held beyond it.
5. **`IsAlive` is a heuristic, and an expensive one.** The `tcpConnection.IsAlive` here does a one-byte read with a 1ms deadline, so every validation costs at least a syscall and mutates the read deadline. Worse, the read *consumes* a byte from the stream: on a real protocol connection that byte belonged to the next message, so validating this way corrupts framing. It also cannot distinguish "healthy and idle" from "peer closed but the FIN has not arrived yet". Real drivers validate lazily and treat the first failed query as the signal instead.
6. **Rate limit keying and placement.** Per-instance limits mean the effective global limit is your limit times your replica count, which is rarely what the requirement said. If the limit is a real contract, it belongs in a shared store or at the edge, not in each process's memory.

### Principal Lens: When to Use a Library Instead

The pool shown is instructive but hand-rolled. Production Go codebases usually use `github.com/jackc/pgx` for PostgreSQL, `database/sql` with driver-specific tuning, `net/http` with `Transport.MaxIdleConnsPerHost` for HTTP. Each already solves the connection-pooling problem. Hand-rolling a pool in 2026 is correct only when you have a genuinely special protocol or pooling requirement that existing libraries do not cover. Most teams think they are special. Most are not.

---
