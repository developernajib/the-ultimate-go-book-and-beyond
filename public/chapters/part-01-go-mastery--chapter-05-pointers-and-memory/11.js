export default `## 5.10 Complete Memory Management Application

This section assembles the techniques from the chapter into a working HTTP cache service. The application uses an LRU cache with memory limits, a tiered buffer pool for request I/O, pprof endpoints for live profiling, and graceful shutdown.

### Project Structure

The project follows the standard Go layout with \`cmd/\` for entry points and \`internal/\` for packages that should not be imported by external consumers.

\`\`\`
memservice/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── cache/
│   │   ├── lru.go
│   │   └── lru_test.go
│   ├── pool/
│   │   ├── buffer.go
│   │   └── buffer_test.go
│   └── server/
│       └── server.go
├── go.mod
├── go.sum
├── Dockerfile
├── docker-compose.yml
└── Makefile
\`\`\`

### cmd/server/main.go

The application entry point wires together all components, configures the server, and handles graceful shutdown. This file should remain thin, delegating business logic to internal packages.

\`\`\`go
package main

import (
    "context"
    "flag"
    "log"
    "net/http"
    _ "net/http/pprof"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/memservice/internal/cache"
    "github.com/example/memservice/internal/server"
)

func main() {
    var (
        addr      = flag.String("addr", ":8080", "Server address")
        pprofAddr = flag.String("pprof", ":6060", "Pprof address")
        cacheSize = flag.Int("cache-size", 10000, "LRU cache size")
    )
    flag.Parse()

    // Start pprof server
    go func() {
        log.Printf("pprof listening on %s", *pprofAddr)
        if err := http.ListenAndServe(*pprofAddr, nil); err != nil {
            log.Printf("pprof server error: %v", err)
        }
    }()

    // Create LRU cache with memory limit
    lru := cache.NewLRU(*cacheSize, 100*1024*1024) // 100MB limit

    // Create server
    srv := server.New(*addr, lru)

    // Start server
    go func() {
        log.Printf("Server listening on %s", *addr)
        if err := srv.Start(); err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    // Wait for shutdown signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh

    log.Println("Shutting down...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }

    log.Println("Server stopped")
}
\`\`\`

### internal/cache/lru.go

The LRU cache uses a doubly linked list for O(1) eviction and a hash map for O(1) lookup. The linked list tracks access order with the most recently used item at the front.

\`\`\`go
package cache

import (
    "container/list"
    "sync"
    "unsafe"
)

// entry represents a cache entry
type entry struct {
    key   string
    value []byte
    size  int64
}

// LRU is a thread-safe LRU cache with memory limit
type LRU struct {
    mu          sync.RWMutex
    capacity    int
    maxBytes    int64
    currentSize int64
    items       map[string]*list.Element
    order       *list.List

    // Stats
    hits   uint64
    misses uint64
    evicts uint64
}

// NewLRU creates a new LRU cache
func NewLRU(capacity int, maxBytes int64) *LRU {
    return &LRU{
        capacity: capacity,
        maxBytes: maxBytes,
        items:    make(map[string]*list.Element, capacity),
        order:    list.New(),
    }
}

// Get retrieves a value from the cache
func (c *LRU) Get(key string) ([]byte, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        c.order.MoveToFront(elem)
        c.hits++
        // Return a copy to prevent external modification
        ent := elem.Value.(*entry)
        result := make([]byte, len(ent.value))
        copy(result, ent.value)
        return result, true
    }

    c.misses++
    return nil, false
}

// Set adds or updates a value in the cache
func (c *LRU) Set(key string, value []byte) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Calculate entry size
    entrySize := int64(len(key)) + int64(len(value)) + int64(unsafe.Sizeof(entry{}))

    // Update existing entry
    if elem, ok := c.items[key]; ok {
        c.order.MoveToFront(elem)
        ent := elem.Value.(*entry)
        c.currentSize -= ent.size
        c.currentSize += entrySize
        ent.value = make([]byte, len(value))
        copy(ent.value, value)
        ent.size = entrySize
        c.evictIfNeeded()
        return
    }

    // Create new entry
    ent := &entry{
        key:   key,
        value: make([]byte, len(value)),
        size:  entrySize,
    }
    copy(ent.value, value)

    elem := c.order.PushFront(ent)
    c.items[key] = elem
    c.currentSize += entrySize

    c.evictIfNeeded()
}

// evictIfNeeded removes old entries if over capacity
func (c *LRU) evictIfNeeded() {
    for c.order.Len() > c.capacity || c.currentSize > c.maxBytes {
        c.evictOldest()
    }
}

// evictOldest removes the least recently used entry
func (c *LRU) evictOldest() {
    elem := c.order.Back()
    if elem == nil {
        return
    }

    ent := elem.Value.(*entry)
    c.order.Remove(elem)
    delete(c.items, ent.key)
    c.currentSize -= ent.size
    c.evicts++
}

// Delete removes an entry from the cache
func (c *LRU) Delete(key string) bool {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        ent := elem.Value.(*entry)
        c.order.Remove(elem)
        delete(c.items, key)
        c.currentSize -= ent.size
        return true
    }
    return false
}

// Stats returns cache statistics
type Stats struct {
    Count       int
    CurrentSize int64
    MaxSize     int64
    Hits        uint64
    Misses      uint64
    Evictions   uint64
    HitRate     float64
}

func (c *LRU) Stats() Stats {
    c.mu.RLock()
    defer c.mu.RUnlock()

    total := c.hits + c.misses
    hitRate := float64(0)
    if total > 0 {
        hitRate = float64(c.hits) / float64(total)
    }

    return Stats{
        Count:       c.order.Len(),
        CurrentSize: c.currentSize,
        MaxSize:     c.maxBytes,
        Hits:        c.hits,
        Misses:      c.misses,
        Evictions:   c.evicts,
        HitRate:     hitRate,
    }
}

// Clear removes all entries from the cache
func (c *LRU) Clear() {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.items = make(map[string]*list.Element, c.capacity)
    c.order.Init()
    c.currentSize = 0
}
\`\`\`

### internal/cache/lru_test.go

The LRU cache tests cover correct eviction under capacity pressure, proper promotion of accessed items, thread-safety under concurrent access, and boundary conditions.

\`\`\`go
package cache

import (
    "fmt"
    "sync"
    "testing"
)

func TestLRU_GetSet(t *testing.T) {
    lru := NewLRU(3, 1024)

    // Set values
    lru.Set("a", []byte("value-a"))
    lru.Set("b", []byte("value-b"))
    lru.Set("c", []byte("value-c"))

    // Get values
    if v, ok := lru.Get("a"); !ok || string(v) != "value-a" {
        t.Errorf("expected value-a, got %s", v)
    }

    // Verify stats
    stats := lru.Stats()
    if stats.Hits != 1 {
        t.Errorf("expected 1 hit, got %d", stats.Hits)
    }
}

func TestLRU_Eviction(t *testing.T) {
    lru := NewLRU(2, 1024)

    lru.Set("a", []byte("1"))
    lru.Set("b", []byte("2"))
    lru.Set("c", []byte("3"))  // Should evict "a"

    if _, ok := lru.Get("a"); ok {
        t.Error("expected 'a' to be evicted")
    }

    if _, ok := lru.Get("b"); !ok {
        t.Error("expected 'b' to exist")
    }
}

func TestLRU_LRUOrder(t *testing.T) {
    lru := NewLRU(2, 1024)

    lru.Set("a", []byte("1"))
    lru.Set("b", []byte("2"))
    lru.Get("a")  // Access "a", making it recently used
    lru.Set("c", []byte("3"))  // Should evict "b", not "a"

    if _, ok := lru.Get("a"); !ok {
        t.Error("expected 'a' to exist (was recently used)")
    }

    if _, ok := lru.Get("b"); ok {
        t.Error("expected 'b' to be evicted")
    }
}

func TestLRU_MemoryLimit(t *testing.T) {
    // 100 bytes limit
    lru := NewLRU(1000, 100)

    // Add entries until memory limit
    for i := 0; i < 10; i++ {
        key := fmt.Sprintf("key-%d", i)
        value := make([]byte, 20)
        lru.Set(key, value)
    }

    stats := lru.Stats()
    if stats.CurrentSize > 100 {
        t.Errorf("expected size <= 100, got %d", stats.CurrentSize)
    }
}

func TestLRU_Concurrent(t *testing.T) {
    lru := NewLRU(100, 10240)

    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            key := fmt.Sprintf("key-%d", i%10)
            lru.Set(key, []byte(fmt.Sprintf("value-%d", i)))
            lru.Get(key)
        }(i)
    }

    wg.Wait()
}

func BenchmarkLRU_Set(b *testing.B) {
    lru := NewLRU(10000, 100*1024*1024)
    value := make([]byte, 100)

    b.ResetTimer()
    for b.Loop() {
        key := fmt.Sprintf("key-%d", i)
        lru.Set(key, value)
    }
}

func BenchmarkLRU_Get(b *testing.B) {
    lru := NewLRU(10000, 100*1024*1024)
    value := make([]byte, 100)

    // Pre-populate
    for i := 0; i < 10000; i++ {
        lru.Set(fmt.Sprintf("key-%d", i), value)
    }

    b.ResetTimer()
    for b.Loop() {
        key := fmt.Sprintf("key-%d", i%10000)
        lru.Get(key)
    }
}

func BenchmarkLRU_Concurrent(b *testing.B) {
    lru := NewLRU(10000, 100*1024*1024)
    value := make([]byte, 100)

    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            key := fmt.Sprintf("key-%d", i%10000)
            if i%2 == 0 {
                lru.Set(key, value)
            } else {
                lru.Get(key)
            }
            i++
        }
    })
}
\`\`\`

### internal/pool/buffer.go

The buffer pool manages a tiered set of \`sync.Pool\` instances, one per power-of-two size class. Requests are rounded up to the nearest size class, minimizing both allocation overhead and wasted capacity.

\`\`\`go
package pool

import (
    "sync"
    "sync/atomic"
)

// BufferPool manages reusable byte buffers
type BufferPool struct {
    pools     []*sync.Pool
    sizes     []int
    gets      uint64
    puts      uint64
    allocates uint64
}

var defaultSizes = []int{
    1 << 10,   // 1KB
    4 << 10,   // 4KB
    16 << 10,  // 16KB
    64 << 10,  // 64KB
    256 << 10, // 256KB
    1 << 20,   // 1MB
}

// NewBufferPool creates a new buffer pool
func NewBufferPool() *BufferPool {
    bp := &BufferPool{
        pools: make([]*sync.Pool, len(defaultSizes)),
        sizes: defaultSizes,
    }

    for i, size := range defaultSizes {
        size := size
        bp.pools[i] = &sync.Pool{
            New: func() any {
                return &Buffer{
                    data: make([]byte, size),
                    pool: bp,
                }
            },
        }
    }

    return bp
}

// Buffer wraps a byte slice from the pool
type Buffer struct {
    data []byte
    pool *BufferPool
}

// Bytes returns the buffer data
func (b *Buffer) Bytes() []byte {
    return b.data
}

// Len returns the buffer length
func (b *Buffer) Len() int {
    return len(b.data)
}

// Release returns the buffer to the pool
func (b *Buffer) Release() {
    b.pool.putBuffer(b)
}

// Get returns a buffer of at least the requested size
func (bp *BufferPool) Get(size int) *Buffer {
    atomic.AddUint64(&bp.gets, 1)

    for i, s := range bp.sizes {
        if s >= size {
            buf := bp.pools[i].Get().(*Buffer)
            buf.data = buf.data[:size]
            return buf
        }
    }

    // Larger than any pool size
    atomic.AddUint64(&bp.allocates, 1)
    return &Buffer{
        data: make([]byte, size),
        pool: bp,
    }
}

func (bp *BufferPool) putBuffer(buf *Buffer) {
    atomic.AddUint64(&bp.puts, 1)

    cap := cap(buf.data)
    for i, s := range bp.sizes {
        if s == cap {
            buf.data = buf.data[:cap]
            bp.pools[i].Put(buf)
            return
        }
    }
    // Not from pool - let GC handle it
}

// Stats returns pool statistics
type PoolStats struct {
    Gets      uint64
    Puts      uint64
    Allocates uint64
    Reuse     float64
}

func (bp *BufferPool) Stats() PoolStats {
    gets := atomic.LoadUint64(&bp.gets)
    puts := atomic.LoadUint64(&bp.puts)
    allocates := atomic.LoadUint64(&bp.allocates)

    reuse := float64(0)
    if gets > 0 {
        reuse = float64(gets-allocates) / float64(gets)
    }

    return PoolStats{
        Gets:      gets,
        Puts:      puts,
        Allocates: allocates,
        Reuse:     reuse,
    }
}

// Global pool
var globalPool = NewBufferPool()

// GetBuffer gets a buffer from the global pool
func GetBuffer(size int) *Buffer {
    return globalPool.Get(size)
}

// GlobalStats returns global pool statistics
func GlobalStats() PoolStats {
    return globalPool.Stats()
}
\`\`\`

### internal/server/server.go

The server wires together the cache, buffer pool, and HTTP handler, demonstrating how these components integrate in a real service with graceful shutdown.

\`\`\`go
package server

import (
    "context"
    "encoding/json"
    "io"
    "net/http"
    "runtime"
    "time"

    "github.com/example/memservice/internal/cache"
    "github.com/example/memservice/internal/pool"
)

type Server struct {
    addr   string
    cache  *cache.LRU
    server *http.Server
}

func New(addr string, lru *cache.LRU) *Server {
    s := &Server{
        addr:  addr,
        cache: lru,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/cache/", s.handleCache)
    mux.HandleFunc("/stats", s.handleStats)
    mux.HandleFunc("/health", s.handleHealth)

    s.server = &http.Server{
        Addr:         addr,
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    return s
}

func (s *Server) Start() error {
    return s.server.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
    return s.server.Shutdown(ctx)
}

func (s *Server) handleCache(w http.ResponseWriter, r *http.Request) {
    key := r.URL.Path[len("/cache/"):]
    if key == "" {
        http.Error(w, "key required", http.StatusBadRequest)
        return
    }

    switch r.Method {
    case http.MethodGet:
        if value, ok := s.cache.Get(key); ok {
            w.Header().Set("Content-Type", "application/octet-stream")
            w.Write(value)
        } else {
            http.NotFound(w, r)
        }

    case http.MethodPut:
        // Use pooled buffer for reading
        buf := pool.GetBuffer(int(r.ContentLength + 1))
        defer buf.Release()

        n, err := io.ReadFull(r.Body, buf.Bytes())
        if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }

        s.cache.Set(key, buf.Bytes()[:n])
        w.WriteHeader(http.StatusCreated)

    case http.MethodDelete:
        if s.cache.Delete(key) {
            w.WriteHeader(http.StatusNoContent)
        } else {
            http.NotFound(w, r)
        }

    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
    var mem runtime.MemStats
    runtime.ReadMemStats(&mem)

    cacheStats := s.cache.Stats()
    poolStats := pool.GlobalStats()

    stats := struct {
        Cache struct {
            Count       int     \`json:"count"\`
            SizeBytes   int64   \`json:"size_bytes"\`
            MaxBytes    int64   \`json:"max_bytes"\`
            Hits        uint64  \`json:"hits"\`
            Misses      uint64  \`json:"misses"\`
            Evictions   uint64  \`json:"evictions"\`
            HitRate     float64 \`json:"hit_rate"\`
        } \`json:"cache"\`
        Pool struct {
            Gets      uint64  \`json:"gets"\`
            Puts      uint64  \`json:"puts"\`
            Allocates uint64  \`json:"allocates"\`
            ReuseRate float64 \`json:"reuse_rate"\`
        } \`json:"pool"\`
        Memory struct {
            HeapAllocMB    uint64 \`json:"heap_alloc_mb"\`
            HeapSysMB      uint64 \`json:"heap_sys_mb"\`
            HeapObjects    uint64 \`json:"heap_objects"\`
            GCRuns         uint32 \`json:"gc_runs"\`
            LastGCPauseMs  float64 \`json:"last_gc_pause_ms"\`
            NumGoroutines  int    \`json:"num_goroutines"\`
        } \`json:"memory"\`
    }{}

    stats.Cache.Count = cacheStats.Count
    stats.Cache.SizeBytes = cacheStats.CurrentSize
    stats.Cache.MaxBytes = cacheStats.MaxSize
    stats.Cache.Hits = cacheStats.Hits
    stats.Cache.Misses = cacheStats.Misses
    stats.Cache.Evictions = cacheStats.Evictions
    stats.Cache.HitRate = cacheStats.HitRate

    stats.Pool.Gets = poolStats.Gets
    stats.Pool.Puts = poolStats.Puts
    stats.Pool.Allocates = poolStats.Allocates
    stats.Pool.ReuseRate = poolStats.Reuse

    stats.Memory.HeapAllocMB = mem.HeapAlloc / 1024 / 1024
    stats.Memory.HeapSysMB = mem.HeapSys / 1024 / 1024
    stats.Memory.HeapObjects = mem.HeapObjects
    stats.Memory.GCRuns = mem.NumGC
    stats.Memory.LastGCPauseMs = float64(mem.PauseNs[(mem.NumGC+255)%256]) / 1e6
    stats.Memory.NumGoroutines = runtime.NumGoroutine()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
\`\`\`

### Dockerfile

The Dockerfile uses a multi-stage build to produce a minimal production image. The first stage compiles the binary with full build tooling. The final stage copies only the compiled binary into a scratch or distroless base.

\`\`\`dockerfile
# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build with optimizations
RUN CGO_ENABLED=0 GOOS=linux go build \\
    -ldflags="-w -s" \\
    -o memservice \\
    ./cmd/server

# Runtime stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/memservice .

EXPOSE 8080 6060

ENTRYPOINT ["./memservice"]
CMD ["-addr", ":8080", "-pprof", ":6060"]
\`\`\`

### docker-compose.yml

Docker Compose ties together the application and a load-testing container. The \`GOMEMLIMIT\` environment variable (Go 1.19+) tells the runtime to target a soft memory limit, which tunes GC frequency to stay within the container's resource allocation.

\`\`\`yaml
version: '3.8'

services:
  memservice:
    build: .
    ports:
      - "8080:8080"
      - "6060:6060"
    environment:
      - GOMAXPROCS=4
      - GOMEMLIMIT=512MiB
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Load testing
  vegeta:
    image: peterevans/vegeta
    depends_on:
      - memservice
    profiles:
      - loadtest
    entrypoint: >
      sh -c "echo 'GET http://memservice:8080/cache/test' |
             vegeta attack -rate=1000 -duration=30s |
             vegeta report"
\`\`\`

### Makefile

The Makefile wraps common build, test, and profiling commands. The \`escape\` target is particularly useful during development: it runs escape analysis across all packages and filters the output to show only allocation decisions.

\`\`\`makefile
.PHONY: all build test bench profile clean docker

BINARY=memservice
GOFLAGS=-ldflags="-w -s"

all: build

build:
	go build \$(GOFLAGS) -o \$(BINARY) ./cmd/server

test:
	go test -v -race ./...

bench:
	go test -bench=. -benchmem ./...

# Run escape analysis
escape:
	go build -gcflags="-m -m" ./... 2>&1 | grep -E "(escapes|does not escape)"

# Memory profile
profile:
	go test -bench=BenchmarkLRU -benchmem -memprofile=mem.prof ./internal/cache
	go tool pprof -http=:8081 mem.prof

# Run with memory limit
run:
	GOMEMLIMIT=256MiB ./\$(BINARY)

# Docker
docker-build:
	docker build -t memservice:latest .

docker-run:
	docker run -p 8080:8080 -p 6060:6060 memservice:latest

docker-compose:
	docker-compose up -d

clean:
	rm -f \$(BINARY)
	rm -f *.prof
	docker-compose down
\`\`\`

### Read the Code Like a Reviewer

The application above wires together the patterns from this chapter. A staff reviewer would flag the following before approving for production:

1. **\`GOMEMLIMIT\` is set, which is good.** This is the soft memory limit added in Go 1.19 that lets you bound RSS without setting GOGC manually. Pair it with the runtime's automatic GC tuning. For containerised services, set it to roughly 80% of the container memory limit so the GC reclaims aggressively before the OOM killer fires.
2. **The pool sizing is hard-coded.** A buffer pool with a fixed set of size tiers works well for known workloads. For unknown workloads, instrument the actual sizes requested and adjust. The discipline is "measure the distribution, then tune the tiers".
3. **No metrics on pool hit rate.** A pool with low hit rate is providing little value. Add Prometheus metrics for pool gets, puts, and misses, and alert when the hit rate drops.
4. **No backpressure when memory is tight.** A service that hits the soft memory limit should shed load, not just GC harder. Consider adding a circuit breaker on the request path that reads \`runtime.MemStats.HeapAlloc\` and rejects requests when the heap is near the limit.
5. **The continuous profiling endpoint is on the same port as the main service.** For production, separate the profiling port (typically 6060) from the main service port (typically 8080) and put the profiling port on an internal-only network.

### How to Use This as a Reference Implementation (Senior Track)

For a Go-heavy team, the value of this kind of worked example is as the reference implementation other services emulate. Three ways to deploy it:

1. **Adapt to your team's conventions.** The structured logging, metrics, and configuration shapes will be different in your codebase. Port the patterns, not the code, and make sure the result feels like the team's idiomatic style.
2. **Use it as the baseline for new services.** When someone starts a new service in your team's monorepo, the answer to "where should I start?" is "copy the user-service skeleton". The reference implementation is the answer.
3. **Maintain the reference.** Reference implementations rot when they fall behind the team's evolution. Assign one engineer to refresh it each quarter as conventions change. Without an owner, the reference becomes a liability that points engineers at outdated patterns.

---
`;
