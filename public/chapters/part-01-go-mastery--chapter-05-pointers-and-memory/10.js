export default `## 5.9 Memory Pooling with sync.Pool

When a function allocates an object, uses it briefly, and discards it, repeated thousands of times per second, each allocation adds GC pressure. \`sync.Pool\` addresses this by maintaining a reusable set of objects that goroutines can borrow and return, converting repeated heap allocations into cheap pool operations.

### Basic sync.Pool Usage

\`sync.Pool\` reduces garbage collection pressure by reusing allocated objects. The pool maintains a free list that goroutines can borrow from and return to, avoiding repeated allocations for frequently discarded values.

\`\`\`go
var bufferPool = sync.Pool{
    New: func() any {
        return make([]byte, 1024)
    },
}

func ProcessData(data []byte) {
    buf := bufferPool.Get().([]byte)
    defer bufferPool.Put(buf)

    // Use buf for processing
    copy(buf, data)
    // ...
}
\`\`\`

### Production Buffer Pool

A production buffer pool manages byte buffers for high-throughput I/O, reducing allocator pressure in services that process many concurrent requests. The following implementation handles size tiering for efficiency.

\`\`\`go
package pool

import (
    "sync"
)

// BufferPool manages reusable byte buffers of various sizes
type BufferPool struct {
    pools []*sync.Pool
    sizes []int
}

// Common buffer sizes (powers of 2)
var defaultSizes = []int{
    1 << 10,  // 1KB
    4 << 10,  // 4KB
    16 << 10, // 16KB
    64 << 10, // 64KB
    256 << 10, // 256KB
    1 << 20,  // 1MB
}

func NewBufferPool() *BufferPool {
    bp := &BufferPool{
        pools: make([]*sync.Pool, len(defaultSizes)),
        sizes: defaultSizes,
    }

    for i, size := range defaultSizes {
        size := size // Capture
        bp.pools[i] = &sync.Pool{
            New: func() any {
                return make([]byte, size)
            },
        }
    }

    return bp
}

// Get returns a buffer of at least the requested size
func (bp *BufferPool) Get(size int) []byte {
    for i, s := range bp.sizes {
        if s >= size {
            buf := bp.pools[i].Get().([]byte)
            return buf[:size]  // Return requested size
        }
    }
    // Larger than any pool - allocate directly
    return make([]byte, size)
}

// Put returns a buffer to the pool
func (bp *BufferPool) Put(buf []byte) {
    cap := cap(buf)
    for i, s := range bp.sizes {
        if s == cap {
            bp.pools[i].Put(buf[:cap])
            return
        }
    }
    // Not from pool - let GC handle it
}

// Global pool for convenience
var globalPool = NewBufferPool()

func GetBuffer(size int) []byte {
    return globalPool.Get(size)
}

func PutBuffer(buf []byte) {
    globalPool.Put(buf)
}
\`\`\`

### Cloudflare's Request Pool Pattern

Cloudflare pools entire request context objects, not just byte buffers, across HTTP handlers. The \`AcquireContext\`/\`ReleaseContext\` pattern resets all fields between uses and zeroes sensitive data before returning the object to the pool. This eliminates per-request allocation of headers, body buffers, and trace metadata.

\`\`\`go
package http

import (
    "net/http"
    "sync"
)

// RequestContext holds per-request data
type RequestContext struct {
    TraceID   string
    UserID    string
    StartTime int64
    Headers   http.Header
    Body      []byte
    Response  []byte
}

var contextPool = sync.Pool{
    New: func() any {
        return &RequestContext{
            Headers:  make(http.Header, 8),
            Body:     make([]byte, 0, 4096),
            Response: make([]byte, 0, 8192),
        }
    },
}

// AcquireContext gets a context from the pool
func AcquireContext() *RequestContext {
    ctx := contextPool.Get().(*RequestContext)
    ctx.reset()
    return ctx
}

// ReleaseContext returns a context to the pool
func ReleaseContext(ctx *RequestContext) {
    ctx.clear()  // Clear sensitive data
    contextPool.Put(ctx)
}

func (ctx *RequestContext) reset() {
    ctx.TraceID = ""
    ctx.UserID = ""
    ctx.StartTime = 0
    // Clear headers but keep capacity
    for k := range ctx.Headers {
        delete(ctx.Headers, k)
    }
    // Reset slices but keep capacity
    ctx.Body = ctx.Body[:0]
    ctx.Response = ctx.Response[:0]
}

func (ctx *RequestContext) clear() {
    // Zero sensitive data
    for i := range ctx.Body {
        ctx.Body[i] = 0
    }
    for i := range ctx.Response {
        ctx.Response[i] = 0
    }
    ctx.reset()
}

// Example middleware
func PooledHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := AcquireContext()
        defer ReleaseContext(ctx)

        ctx.StartTime = time.Now().UnixNano()
        ctx.TraceID = r.Header.Get("X-Trace-ID")

        // Store in request context
        r = r.WithContext(context.WithValue(r.Context(), "reqctx", ctx))

        next.ServeHTTP(w, r)
    })
}
\`\`\`

### Beyond sync.Pool: weak Pointers and unique Interning (Go 1.23+)

\`sync.Pool\` is the right tool for amortizing short-lived allocations on hot paths. Two newer standard-library packages solve adjacent problems.

**\`unique\` (Go 1.23)** interns values. Calling \`unique.Make(v)\` returns a handle that compares equal to every other handle created from an equal value, with only one underlying copy stored in a canonical set. This is the idiomatic way to deduplicate large strings or fixed-shape structs that you otherwise have millions of copies of.

\`\`\`go
import "unique"

// Instead of holding 10 million copies of "user-agent: ..." strings:
h := unique.Make(userAgent)
// h is a comparable handle. Two equal strings share storage.
\`\`\`

**\`weak\` (Go 1.24)** adds weak pointers, \`weak.Pointer[T]\`, that do not keep the referent alive. If the GC would otherwise collect the target, it does, and \`p.Value()\` returns the zero value. This is the piece the standard library was missing for building caches and observer patterns that must not hold references past their usefulness.

\`\`\`go
import "weak"

type Cache struct {
    mu   sync.Mutex
    data map[string]weak.Pointer[Entry]
}

// Cache entries can be GC'd under memory pressure even while the
// cache map still holds the weak pointer. A Get call checks for
// collection and refills if needed.
\`\`\`

Both packages are standard-library and stable. They are preferable to third-party interning and weak-reference libraries that predated them.

### When \`sync.Pool\` Is the Wrong Answer

The most common \`sync.Pool\` mistake is reaching for it when the underlying problem is something else. Three anti-patterns:

1. **Pooling cheap allocations.** \`sync.Pool\` has its own overhead (lock-free per-P queues plus occasional CAS contention). Pooling a 16-byte struct probably loses to direct allocation. The break-even point depends on the workload, but for tiny allocations, measure both.
2. **Pooling stateful objects without a reset discipline.** A \`*Buffer\` returned from the pool with leftover bytes from the previous user is a bug magnet, especially for buffers that hold sensitive data (authentication tokens, PII). Always reset on \`Get\` or \`Put\` and write a test that verifies the reset.
3. **Treating the pool as a long-lived cache.** \`sync.Pool\` is opportunistic: items are dropped on every two-cycle GC pass. It is not a cache. If you need durable retention, use a real cache.

### \`sync.Pool\` and the GC Interaction

The \`sync.Pool\` semantics changed across Go versions. In modern Go (1.13+), the pool keeps items across one GC cycle and drops them at the second. This means a service with low traffic that gets a sudden spike will see misses on the spike's first second, then the pool warms up. For services with steady high traffic, the pool stays full and the misses are rare.

The implication for sizing: \`sync.Pool\` cannot be sized explicitly. You can put millions of items and the pool will hold what fits in its per-P queues until the GC sweeps. Do not put items you would not be willing to allocate fresh, because the pool may drop them at the next GC.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in \`sync.Pool\` PRs:

1. **A pool with no reset discipline.** Always a finding. The next user of the pooled object may see stale data.
2. **A pool used for objects allocated rarely.** The pool overhead exceeds the allocation savings. Measure or remove.
3. **A pool that pools pointers to structs that grow over time.** The pool retains the high-water-mark capacity for every pooled object. For a \`*bytes.Buffer\` that grew to 1MB on one request, the pool now holds N copies of 1MB capacity. Add a size cap to the \`Put\` (drop instead of pool if too large).

### Migration Lens

Coming from Java, the closest analogue to \`sync.Pool\` is a custom object pool, since Java has no standard one. The JVM's escape analysis sometimes makes the pool unnecessary. In Go, you make the choice explicitly. Coming from C++, the closest analogue is a custom allocator or arena. Coming from Rust, the closest analogue is the \`bumpalo\` crate or hand-rolled object pools. None of those have the per-P scaling that \`sync.Pool\` provides for free.

---
`;
