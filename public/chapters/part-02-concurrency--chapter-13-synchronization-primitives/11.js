export default `## 13.10 Complete Application: Rate Limiter and Connection Pool

This section builds a production-grade rate limiter and connection pool system using the synchronization primitives covered so far.

### Project Structure

The project is split into three internal packages, \`limiter\`, \`pool\`, and \`metrics\`, each responsible for one production concern, with a thin \`cmd/server\` entry point that composes them into an HTTP service. Keeping the rate limiting algorithms and the connection pool as separate packages makes it straightforward to swap implementations or test them independently without coupling them to the HTTP layer.

\`\`\`
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
\`\`\`

### Rate Limiter Implementation

The \`limiter.go\` file defines the \`Limiter\` interface and the \`TokenBucket\` struct, which refills at a constant \`rate\` tokens per second up to a \`burst\` ceiling. When the bucket is empty, \`WaitN\` calculates the exact time needed to accumulate the required tokens and sleeps for that duration before retrying, giving callers a blocking API that still respects context cancellation. Allowed and denied counts are tracked with \`atomic.Int64\` so the hot path avoids holding the mutex for read-only statistics.

\`\`\`go
// internal/limiter/limiter.go
package limiter

import (
    "context"
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
    tb.mu.Lock()

    now := time.Now()
    tb.refill(now)

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
    defer timer.Stop()

    select {
    case <-ctx.Done():
        tb.denied.Add(1)
        return ctx.Err()
    case <-timer.C:
        return tb.WaitN(ctx, n)
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
\`\`\`

### Sliding Window Rate Limiter

The \`SlidingWindow\` implementation stores the actual timestamps of recent requests and removes any that fall outside the rolling window on every call to \`cleanup\`, avoiding the burst-at-boundary problem that afflicts fixed-window approaches. This makes it more accurate for APIs where uniform distribution of requests matters, at the cost of slightly higher memory usage proportional to the configured \`rate\`.

\`\`\`go
// internal/limiter/sliding_window.go
package limiter

import (
    "context"
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
\`\`\`

### Per-Key Rate Limiter

\`KeyedLimiter\` wraps a map of \`TokenBucket\` instances indexed by an arbitrary string key (typically a client IP or user ID), using a read-lock for lookups and a write-lock only when a new bucket must be created, with a double-check pattern to avoid redundant allocations. A background goroutine ticks every minute to evict buckets that have been idle for longer than \`maxAge\`, preventing unbounded memory growth in deployments with many ephemeral clients.

\`\`\`go
// internal/limiter/keyed.go
package limiter

import (
    "context"
    "sync"
    "time"
)

// KeyedLimiter provides per-key rate limiting
type KeyedLimiter struct {
    mu sync.RWMutex

    limiters map[string]*TokenBucket
    rate     float64
    burst    int

    // Cleanup
    maxAge   time.Duration
    lastUsed map[string]time.Time
}

func NewKeyedLimiter(rate float64, burst int) *KeyedLimiter {
    kl := &KeyedLimiter{
        limiters: make(map[string]*TokenBucket),
        lastUsed: make(map[string]time.Time),
        rate:     rate,
        burst:    burst,
        maxAge:   time.Hour,
    }

    // Start cleanup goroutine
    go kl.cleanupLoop()

    return kl
}

func (kl *KeyedLimiter) getLimiter(key string) *TokenBucket {
    kl.mu.RLock()
    limiter, ok := kl.limiters[key]
    kl.mu.RUnlock()

    if ok {
        kl.mu.Lock()
        kl.lastUsed[key] = time.Now()
        kl.mu.Unlock()
        return limiter
    }

    kl.mu.Lock()
    defer kl.mu.Unlock()

    // Double-check after acquiring write lock
    if limiter, ok := kl.limiters[key]; ok {
        kl.lastUsed[key] = time.Now()
        return limiter
    }

    limiter = NewTokenBucket(kl.rate, kl.burst)
    kl.limiters[key] = limiter
    kl.lastUsed[key] = time.Now()

    return limiter
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

    for range ticker.C {
        kl.cleanup()
    }
}

func (kl *KeyedLimiter) cleanup() {
    kl.mu.Lock()
    defer kl.mu.Unlock()

    now := time.Now()
    for key, lastUsed := range kl.lastUsed {
        if now.Sub(lastUsed) > kl.maxAge {
            delete(kl.limiters, key)
            delete(kl.lastUsed, key)
        }
    }
}

func (kl *KeyedLimiter) Size() int {
    kl.mu.RLock()
    defer kl.mu.RUnlock()
    return len(kl.limiters)
}
\`\`\`

### Connection Pool Implementation

The \`Pool\` manages a LIFO idle list of \`pooledConn\` wrappers, preferring recently-used connections for better OS-level socket cache locality. When the pool is exhausted, callers are queued on per-waiter channels so they block efficiently without busy-polling. A maintenance goroutine periodically validates idle connections against \`MaxLifetime\` and \`MaxIdleTime\` thresholds and recreates any that have been closed to maintain the \`MinSize\` floor.

\`\`\`go
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

    // Waiters queue
    waiters []chan Connection

    // State
    closed atomic.Bool

    // Metrics
    acquired atomic.Int64
    released atomic.Int64
    created  atomic.Int64
    closed_  atomic.Int64
    timeouts atomic.Int64

    // Condition for waiters
    cond *sync.Cond
}

type pooledConn struct {
    conn      Connection
    createdAt time.Time
    lastUsed  time.Time
}

func NewPool(config Config, factory Factory) (*Pool, error) {
    p := &Pool{
        config:  config,
        factory: factory,
        idle:    make([]pooledConn, 0, config.MaxSize),
        waiters: make([]chan Connection, 0),
    }
    p.cond = sync.NewCond(&p.mu)

    // Pre-warm pool
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    for i := 0; i < config.MinSize; i++ {
        conn, err := factory(ctx)
        if err != nil {
            p.Close()
            return nil, err
        }
        p.idle = append(p.idle, pooledConn{
            conn:      conn,
            createdAt: time.Now(),
            lastUsed:  time.Now(),
        })
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
            p.mu.Unlock()
            pc.conn.Close()
            p.closed_.Add(1)
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
    case conn := <-ch:
        p.acquired.Add(1)
        return conn, nil
    case <-ctx.Done():
        p.removeWaiter(ch)
        p.timeouts.Add(1)
        return nil, ctx.Err()
    case <-timer.C:
        p.removeWaiter(ch)
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
        p.mu.Unlock()
        conn.Close()
        p.closed_.Add(1)
        return
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    p.inUse--

    // Give to waiter if any
    for len(p.waiters) > 0 {
        ch := p.waiters[0]
        p.waiters = p.waiters[1:]

        select {
        case ch <- conn:
            p.inUse++
            return
        default:
            // Waiter gone, try next
        }
    }

    // Return to idle pool
    p.idle = append(p.idle, pooledConn{
        conn:      conn,
        createdAt: time.Now(), // Track original creation elsewhere
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

func (p *Pool) removeWaiter(ch chan Connection) {
    p.mu.Lock()
    defer p.mu.Unlock()

    for i, w := range p.waiters {
        if w == ch {
            p.waiters = append(p.waiters[:i], p.waiters[i+1:]...)
            return
        }
    }
}

func (p *Pool) maintenance() {
    ticker := time.NewTicker(p.config.HealthCheckInterval)
    defer ticker.Stop()

    for range ticker.C {
        if p.closed.Load() {
            return
        }

        p.mu.Lock()

        // Remove stale idle connections
        valid := make([]pooledConn, 0, len(p.idle))
        for _, pc := range p.idle {
            if p.isValid(pc) {
                valid = append(valid, pc)
            } else {
                p.total--
                go func(c Connection) {
                    c.Close()
                    p.closed_.Add(1)
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
            p.idle = append(p.idle, pooledConn{
                conn:      conn,
                createdAt: time.Now(),
                lastUsed:  time.Now(),
            })
            p.total++
            p.created.Add(1)
            p.mu.Unlock()
        }
    }
}

func (p *Pool) Close() error {
    if !p.closed.CompareAndSwap(false, true) {
        return nil
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    // Close all idle connections
    for _, pc := range p.idle {
        pc.conn.Close()
    }
    p.idle = nil

    // Wake up waiters
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
        Closed:   p.closed_.Load(),
        Timeouts: p.timeouts.Load(),
    }
}
\`\`\`

### Main Application

The server wires the \`KeyedLimiter\` and the connection \`Pool\` into a standard \`http.ServeMux\`, applying rate limiting as an HTTP middleware that checks the client IP before any handler runs and returns \`429 Too Many Requests\` on violation. Signal-aware graceful shutdown ensures in-flight requests complete within a 30-second window before the process exits, preserving connection pool resources through the \`defer connPool.Close()\` call.

\`\`\`go
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
    // Create rate limiter: 100 requests per second per client
    rl := limiter.NewKeyedLimiter(100, 10)

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

func getClientIP(r *http.Request) string {
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        return xff
    }
    if xri := r.Header.Get("X-Real-IP"); xri != "" {
        return xri
    }
    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host
}
\`\`\`

### Tests

The test suite verifies both correctness and concurrency safety: \`TestTokenBucket_Allow\` confirms burst exhaustion and token refill timing, while \`TestTokenBucket_Concurrent\` fires 1000 simultaneous goroutines and asserts that the allowed count stays within a ±50% tolerance around the burst size, a statistically meaningful bound that avoids false flakiness. The parallel benchmarks for both \`TokenBucket\` and \`SlidingWindow\` let you directly compare the two implementations' throughput characteristics under contention.

\`\`\`go
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
\`\`\`

### Dockerfile

The two-stage Dockerfile compiles the server binary with CGO disabled and stripped debug symbols for a minimal, statically-linked artifact, then copies it into a bare \`alpine\` image that runs as the unprivileged \`nobody\` user. Disabling CGO ensures the binary has no dynamic library dependencies and will run identically across all Alpine-based container environments.

\`\`\`dockerfile
# Dockerfile
FROM golang:1.23-alpine AS builder

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
\`\`\`

### docker-compose.yml

The Compose stack pairs the server with PostgreSQL, Prometheus, and Grafana, giving developers a complete local observability setup out of the box. The server's health check uses \`wget\`, available in Alpine without additional packages, to poll the \`/health\` endpoint before marking the container ready, preventing dependent services from starting before the port is actually accepting requests.

\`\`\`yaml
# docker-compose.yml
version: '3.8'

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
\`\`\`

### Makefile

The Makefile provides a \`benchmark\` target that runs \`go test -bench\` against both the \`limiter\` and \`pool\` packages separately, making it easy to isolate which subsystem is the bottleneck. The \`load-test\` target invokes \`hey\` against the running server, providing a quick way to verify end-to-end rate limiting behavior under realistic concurrent load without extra tooling.

\`\`\`makefile
# Makefile
.PHONY: build test run docker clean benchmark lint

BINARY=server
DOCKER_IMAGE=limiter-server

build:
	go build -o bin/\$(BINARY) ./cmd/server

test:
	go test -v -race -cover ./...

test-coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

benchmark:
	go test -bench=. -benchmem ./internal/limiter/
	go test -bench=. -benchmem ./internal/pool/

run: build
	./bin/\$(BINARY)

docker-build:
	docker build -t \$(DOCKER_IMAGE) .

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
\`\`\`

### Staff Lens: What This Example Teaches

The complete application composes several synchronization primitives: atomic counters for metrics, mutex for the pool's internal state, channels for work distribution, context for cancellation. This is typical of real services. The lesson is recognising which primitive fits each piece: lock-free counters for hot metrics, mutexes for the pool invariants, channels for coordination, context for lifetime.

### Production Gaps to Close

Before running this in production:

1. **Connection health checks.** Pool connections can go stale. Validate before reuse.
2. **Pool size tuning.** Size against downstream capacity, not hope. Monitor utilization.
3. **Graceful shutdown.** Drain in-flight requests before closing the pool.
4. **Metrics instrumentation.** Expose pool size, active connections, wait time for a connection, rate-limit rejections.
5. **Connection timeout handling.** If a connection is checked out and never returned (caller panic), the pool leaks capacity. Use contexts with timeouts or a cleanup goroutine.

### Principal Lens: When to Use a Library Instead

The pool shown is instructive but hand-rolled. Production Go codebases usually use \`github.com/jackc/pgx\` for PostgreSQL, \`database/sql\` with driver-specific tuning, \`net/http\` with \`Transport.MaxIdleConnsPerHost\` for HTTP. Each already solves the connection-pooling problem. Hand-rolling a pool in 2026 is correct only when you have a genuinely special protocol or pooling requirement that existing libraries do not cover. Most teams think they are special. Most are not.

---
`;
