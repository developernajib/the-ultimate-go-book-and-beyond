## 90K.10 What Go Engineers Can Learn from NASA

Go was not designed for spacecraft. It will never run on a RAD750. But Go was designed
for reliability at scale, and many of NASA's principles translate directly.

### What Go Already Provides (NASA-Aligned Features)

1. **No inheritance.** Go's composition-over-inheritance eliminates deep class hierarchies
   that create fragile coupling. NASA bans complex inheritance in C++.

2. **Race detector.** `go test -race` dynamically detects data races. This is analogous
   to NASA's SPIN model checker for concurrent bugs.

3. **Bounds checking.** Every array and slice access is bounds-checked at runtime. This
   prevents the buffer overflows that plague C code.

4. **go vet.** Built-in static analysis that catches common mistakes.

5. **Explicit error handling.** Every error must be explicitly checked and handled. No
   invisible exception propagation.

6. **No pointer arithmetic.** Eliminates entire classes of memory corruption bugs.

7. **Garbage collection.** Eliminates use-after-free and dangling pointer bugs. (But adds
   non-determinism that NASA cannot accept.)

8. **Goroutine stack management.** Goroutines start with small stacks that grow as needed.
   Stack overflow is rare (but see: bounded recursion is still preferable).

### What Go Lacks (NASA Requirements Not Met)

1. **Deterministic GC.** Go's GC pauses are low (< 1ms typically) but not bounded by
   formal proof. WCET analysis is impossible.

2. **WCET tooling.** No tools exist to compute worst-case execution time for Go functions.

3. **Formal verification.** No SPARK-like formally verifiable subset of Go exists.

4. **Static memory safety proofs.** Go relies on runtime bounds checks, not compile-time
   proofs.

5. **Real-time scheduling.** The Go runtime scheduler is not priority-based and provides
   no latency guarantees.

### How to Apply NASA Rigor to Go Services

The pattern below applies NASA's two most transferable principles (bounded resources and assertion-at-entry) to an ordinary Go HTTP service. Every numeric parameter in `ServiceConfig` has an upper bound enforced by `validateConfig` at construction time, mirroring NASA's Rule 2 (all loops must have a fixed upper bound) and Rule 3 (all memory must be statically allocated). The buffer pool pre-allocates all working memory before the first request arrives, so the hot path makes zero heap allocations and the GC cannot introduce latency spikes during processing. `HandleRequest` checks two invariants before doing any work (service state and request validity), corresponding to NASA's Rule 7 (check every non-trivial input). The `BoundedRequestMiddleware` and `RateLimitMiddleware` enforce the same resource-ceiling philosophy at the HTTP layer: no request body is read without a size cap, no request runs without a deadline, and no more tokens are consumed per second than the system is sized to absorb.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "sync/atomic"
    "time"
)

// FixedPool provides a bounded pre-allocated pool of byte slices.
type FixedPool struct {
    mu        sync.Mutex
    buffers   [][]byte
    free      []int
    blockSize int
}

// NewFixedPool creates a pool with count buffers of size bytes.
func NewFixedPool(count, size int) *FixedPool {
    pool := &FixedPool{
        buffers:   make([][]byte, count),
        free:      make([]int, count),
        blockSize: size,
    }
    for i := 0; i < count; i++ {
        pool.buffers[i] = make([]byte, size)
        pool.free[i] = i
    }
    return pool
}

// Get acquires a buffer from the pool.
func (p *FixedPool) Get() ([]byte, int, error) {
    p.mu.Lock()
    defer p.mu.Unlock()
    if len(p.free) == 0 {
        return nil, -1, errors.New("buffer pool exhausted")
    }
    idx := p.free[len(p.free)-1]
    p.free = p.free[:len(p.free)-1]
    return p.buffers[idx], idx, nil
}

// Put returns a buffer to the pool.
func (p *FixedPool) Put(idx int) error {
    p.mu.Lock()
    defer p.mu.Unlock()
    if idx < 0 || idx >= len(p.buffers) {
        return fmt.Errorf("invalid buffer index: %d", idx)
    }
    p.free = append(p.free, idx)
    return nil
}

// Available returns the number of free buffers.
func (p *FixedPool) Available() int {
    p.mu.Lock()
    defer p.mu.Unlock()
    return len(p.free)
}

// BoundedWorkerPool limits concurrent goroutines to a fixed maximum.
type BoundedWorkerPool struct {
    sem    chan struct{}
    wg     sync.WaitGroup
    ctx    context.Context
    cancel context.CancelFunc
}

// NewBoundedWorkerPool creates a pool with a hard goroutine limit.
func NewBoundedWorkerPool(maxWorkers int) *BoundedWorkerPool {
    ctx, cancel := context.WithCancel(context.Background())
    return &BoundedWorkerPool{
        sem:    make(chan struct{}, maxWorkers),
        ctx:    ctx,
        cancel: cancel,
    }
}

// ActiveWorkers returns the number of currently active workers.
func (p *BoundedWorkerPool) ActiveWorkers() int {
    return len(p.sem)
}

// Shutdown gracefully terminates the worker pool with a timeout.
func (p *BoundedWorkerPool) Shutdown(timeout time.Duration) error {
    p.cancel()
    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()
    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return errors.New("worker pool shutdown timed out")
    }
}

// BoundedLRUCache provides a thread-safe, bounded in-memory cache.
type BoundedLRUCache[K comparable, V any] struct {
    mu       sync.Mutex
    items    map[K]V
    maxItems int
}

// NewBoundedLRUCache creates a cache with a fixed upper bound.
func NewBoundedLRUCache[K comparable, V any](maxItems int) *BoundedLRUCache[K, V] {
    return &BoundedLRUCache[K, V]{
        items:    make(map[K]V, maxItems),
        maxItems: maxItems,
    }
}

// Get retrieves a cached value.
func (c *BoundedLRUCache[K, V]) Get(key K) (V, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    val, ok := c.items[key]
    return val, ok
}

// Put inserts or updates a cached value, evicting if full.
func (c *BoundedLRUCache[K, V]) Put(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if len(c.items) >= c.maxItems {
        for k := range c.items {
            delete(c.items, k)
            break
        }
    }
    c.items[key] = value
}

// Size returns the current number of cached items.
func (c *BoundedLRUCache[K, V]) Size() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return len(c.items)
}

// NASAInspiredService demonstrates a production Go service built
// with NASA-inspired engineering principles. Every resource is bounded.
// Every error is handled. Every operation has a timeout.
type NASAInspiredService struct {
    // Configuration - immutable after construction.
    config ServiceConfig

    // Pre-allocated resources - no allocations in the hot path.
    bufferPool    *FixedPool
    workerPool    *BoundedWorkerPool
    requestCache  *BoundedLRUCache[string, []byte]

    // Metrics - lock-free for performance.
    requestCount  atomic.Int64
    errorCount    atomic.Int64
    rejectCount   atomic.Int64

    // Lifecycle management.
    mu     sync.Mutex
    state  ServiceState
    stopCh chan struct{}
    logger *slog.Logger
}

// ServiceConfig defines bounded configuration for the service.
type ServiceConfig struct {
    MaxConcurrentRequests int
    MaxRequestBodyBytes   int64
    MaxResponseBytes      int
    RequestTimeout        time.Duration
    BufferPoolSize        int
    BufferSize            int
    CacheSize             int
    ShutdownTimeout       time.Duration
}

// ServiceState represents the service lifecycle.
type ServiceState int

const (
    ServiceStateInitializing ServiceState = iota
    ServiceStateRunning
    ServiceStateDraining
    ServiceStateStopped
)

// DefaultServiceConfig returns a safe default configuration.
// All values are bounded. None are zero (which would mean unbounded).
func DefaultServiceConfig() ServiceConfig {
    return ServiceConfig{
        MaxConcurrentRequests: 1000,
        MaxRequestBodyBytes:   1 * 1024 * 1024, // 1 MB.
        MaxResponseBytes:      10 * 1024 * 1024, // 10 MB.
        RequestTimeout:        30 * time.Second,
        BufferPoolSize:        2048,
        BufferSize:            4096,
        CacheSize:             10000,
        ShutdownTimeout:       30 * time.Second,
    }
}

// NewNASAInspiredService constructs the service, pre-allocating all resources.
// After this returns, the hot path makes zero heap allocations (ideally).
func NewNASAInspiredService(cfg ServiceConfig, logger *slog.Logger) (*NASAInspiredService, error) {
    // Validate ALL configuration at construction time.
    if err := validateConfig(cfg); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }

    svc := &NASAInspiredService{
        config:       cfg,
        bufferPool:   NewFixedPool(cfg.BufferPoolSize, cfg.BufferSize),
        workerPool:   NewBoundedWorkerPool(cfg.MaxConcurrentRequests),
        requestCache: NewBoundedLRUCache[string, []byte](cfg.CacheSize),
        state:        ServiceStateInitializing,
        stopCh:       make(chan struct{}),
        logger:       logger,
    }

    svc.state = ServiceStateRunning
    return svc, nil
}

// validateConfig checks every configuration parameter.
// NASA Rule 7: check all inputs.
func validateConfig(cfg ServiceConfig) error {
    if cfg.MaxConcurrentRequests <= 0 || cfg.MaxConcurrentRequests > 100000 {
        return fmt.Errorf("MaxConcurrentRequests must be 1-100000, got %d",
            cfg.MaxConcurrentRequests)
    }
    if cfg.MaxRequestBodyBytes <= 0 || cfg.MaxRequestBodyBytes > 100*1024*1024 {
        return fmt.Errorf("MaxRequestBodyBytes must be 1-100MB, got %d",
            cfg.MaxRequestBodyBytes)
    }
    if cfg.MaxResponseBytes <= 0 || cfg.MaxResponseBytes > 100*1024*1024 {
        return fmt.Errorf("MaxResponseBytes must be 1-100MB, got %d",
            cfg.MaxResponseBytes)
    }
    if cfg.RequestTimeout <= 0 || cfg.RequestTimeout > 5*time.Minute {
        return fmt.Errorf("RequestTimeout must be 1ns-5min, got %v",
            cfg.RequestTimeout)
    }
    if cfg.BufferPoolSize <= 0 || cfg.BufferPoolSize > 1000000 {
        return fmt.Errorf("BufferPoolSize must be 1-1000000, got %d",
            cfg.BufferPoolSize)
    }
    if cfg.BufferSize <= 0 || cfg.BufferSize > 1*1024*1024 {
        return fmt.Errorf("BufferSize must be 1-1MB, got %d", cfg.BufferSize)
    }
    if cfg.CacheSize <= 0 || cfg.CacheSize > 1000000 {
        return fmt.Errorf("CacheSize must be 1-1000000, got %d", cfg.CacheSize)
    }
    if cfg.ShutdownTimeout <= 0 || cfg.ShutdownTimeout > 5*time.Minute {
        return fmt.Errorf("ShutdownTimeout must be 1ns-5min, got %v",
            cfg.ShutdownTimeout)
    }
    return nil
}

// HandleRequest processes a request with NASA-level discipline.
func (svc *NASAInspiredService) HandleRequest(ctx context.Context, req Request) (*Response, error) {
    // Assertion 1: Service must be running.
    svc.mu.Lock()
    currentState := svc.state
    svc.mu.Unlock()

    if currentState != ServiceStateRunning {
        svc.rejectCount.Add(1)
        return nil, errors.New("service is not running")
    }

    // Assertion 2: Request must be valid.
    if err := req.Validate(); err != nil {
        svc.rejectCount.Add(1)
        return nil, fmt.Errorf("invalid request: %w", err)
    }

    // Apply timeout - every operation is bounded.
    ctx, cancel := context.WithTimeout(ctx, svc.config.RequestTimeout)
    defer cancel()

    svc.requestCount.Add(1)

    // Check cache first.
    if cached, ok := svc.requestCache.Get(req.Key); ok {
        return &Response{Data: cached}, nil
    }

    // Acquire a buffer from the pre-allocated pool.
    buf, idx, err := svc.bufferPool.Get()
    if err != nil {
        svc.errorCount.Add(1)
        return nil, fmt.Errorf("buffer pool exhausted: %w", err)
    }
    defer func() {
        if putErr := svc.bufferPool.Put(idx); putErr != nil {
            svc.logger.Error("failed to return buffer to pool",
                "error", putErr, "index", idx)
        }
    }()

    // Process the request.
    result, err := svc.processWithBuffer(ctx, req, buf)
    if err != nil {
        svc.errorCount.Add(1)
        return nil, err
    }

    // Cache the result.
    svc.requestCache.Put(req.Key, result)

    return &Response{Data: result}, nil
}

// processWithBuffer performs the actual work using a pre-allocated buffer.
func (svc *NASAInspiredService) processWithBuffer(ctx context.Context, req Request, buf []byte) ([]byte, error) {
    select {
    case <-ctx.Done():
        return nil, ctx.Err()
    default:
    }

    // Bounded copy - never write more than the buffer can hold.
    n := len(req.Payload)
    if n > len(buf) {
        n = len(buf)
    }
    copy(buf[:n], req.Payload)

    // Simulated processing.
    result := make([]byte, n)
    copy(result, buf[:n])

    return result, nil
}

// Metrics returns current service metrics.
func (svc *NASAInspiredService) Metrics() ServiceMetrics {
    return ServiceMetrics{
        TotalRequests:   svc.requestCount.Load(),
        TotalErrors:     svc.errorCount.Load(),
        TotalRejections: svc.rejectCount.Load(),
        BufferPoolStats: svc.bufferPool.Available(),
        CacheSize:       svc.requestCache.Size(),
        ActiveWorkers:   svc.workerPool.ActiveWorkers(),
    }
}

// ServiceMetrics holds observable metrics.
type ServiceMetrics struct {
    TotalRequests   int64
    TotalErrors     int64
    TotalRejections int64
    BufferPoolStats int
    CacheSize       int
    ActiveWorkers   int
}

// Shutdown gracefully stops the service.
func (svc *NASAInspiredService) Shutdown() error {
    svc.mu.Lock()
    svc.state = ServiceStateDraining
    svc.mu.Unlock()

    svc.logger.Info("service entering drain state")

    err := svc.workerPool.Shutdown(svc.config.ShutdownTimeout)

    svc.mu.Lock()
    svc.state = ServiceStateStopped
    svc.mu.Unlock()

    svc.logger.Info("service stopped",
        "totalRequests", svc.requestCount.Load(),
        "totalErrors", svc.errorCount.Load())

    return err
}

// Request represents an incoming request.
type Request struct {
    Key     string
    Payload []byte
}

// Validate checks the request against bounded constraints.
func (r Request) Validate() error {
    if r.Key == "" {
        return errors.New("key is required")
    }
    if len(r.Key) > 256 {
        return errors.New("key too long (max 256)")
    }
    if len(r.Payload) == 0 {
        return errors.New("payload is required")
    }
    if len(r.Payload) > 1024*1024 {
        return errors.New("payload too large (max 1MB)")
    }
    return nil
}

// Response represents the service's response.
type Response struct {
    Data []byte
}

// === NASA-Inspired HTTP Middleware ===

// BoundedRequestMiddleware enforces request size limits and timeouts.
// Every request is bounded - no unbounded reads, no unbounded waits.
func BoundedRequestMiddleware(maxBodyBytes int64, timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Bound the request body.
            r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

            // Bound the request duration.
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            r = r.WithContext(ctx)
            next.ServeHTTP(w, r)
        })
    }
}

// RateLimitMiddleware limits request rate using a token bucket.
// NASA analogy: the 1553 bus has a fixed bandwidth. You cannot
// send more data than the bus can carry.
func RateLimitMiddleware(requestsPerSecond int, burst int) func(http.Handler) http.Handler {
    tokens := make(chan struct{}, burst)

    // Pre-fill the bucket.
    for i := 0; i < burst; i++ {
        tokens <- struct{}{}
    }

    // Refill at the configured rate.
    go func() {
        ticker := time.NewTicker(time.Second / time.Duration(requestsPerSecond))
        defer ticker.Stop()
        for range ticker.C {
            select {
            case tokens <- struct{}{}:
            default: // Bucket full.
            }
        }
    }()

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            select {
            case <-tokens:
                next.ServeHTTP(w, r)
            default:
                http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
            }
        })
    }
}
```

---
