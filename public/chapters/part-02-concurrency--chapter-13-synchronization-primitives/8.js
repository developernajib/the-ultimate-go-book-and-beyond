export default `## 13.7 Pool: Object Reuse

\`sync.Pool\` provides a cache of temporary objects to reduce allocation pressure.

### Basic Buffer Pool

The most common use of \`sync.Pool\` is caching \`bytes.Buffer\` instances that would otherwise be allocated and immediately discarded on every request. The pattern is straightforward: \`Get\` retrieves an existing buffer from the pool (or calls \`New\` to allocate one), the deferred reset-and-\`Put\` returns a clean buffer at the end of the call, and the garbage collector handles any buffers that were never retrieved.

\`\`\`go
var bufferPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func ProcessRequest(data []byte) []byte {
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufferPool.Put(buf)
    }()

    buf.Write(data)
    // Process...

    return buf.Bytes()
}
\`\`\`

### Type-Safe Pool with Generics (Go 1.18+)

The raw \`sync.Pool\` API uses \`any\`, requiring a type assertion on every \`Get\` call, a source of both boilerplate and potential panics if the wrong type is stored. Wrapping it in a generic \`Pool[T]\` struct moves the assertion inside the implementation once, giving callers a fully typed \`Get() T\` method and eliminating the risk of a mismatched assertion elsewhere in the codebase.

\`\`\`go
type Pool[T any] struct {
    pool sync.Pool
}

func NewPool[T any](create func() T) *Pool[T] {
    return &Pool[T]{
        pool: sync.Pool{
            New: func() any {
                return create()
            },
        },
    }
}

func (p *Pool[T]) Get() T {
    return p.pool.Get().(T)
}

func (p *Pool[T]) Put(x T) {
    p.pool.Put(x)
}

// Usage
type Request struct {
    Headers map[string]string
    Body    []byte
}

var requestPool = NewPool(func() *Request {
    return &Request{
        Headers: make(map[string]string),
    }
})

func HandleRequest(data []byte) {
    req := requestPool.Get()
    defer func() {
        // Reset before returning to pool
        for k := range req.Headers {
            delete(req.Headers, k)
        }
        req.Body = req.Body[:0]
        requestPool.Put(req)
    }()

    parseRequest(data, req)
    processRequest(req)
}
\`\`\`

### Slice Pool with Size Classes

A single pool with a fixed capacity wastes memory when callers need widely varying buffer sizes. By maintaining one pool per size class (64, 256, 1024 bytes and so on) and selecting the smallest class that satisfies a request, \`SlicePool\` avoids over-allocation while still reusing memory across goroutines, a technique borrowed directly from the Go runtime's own memory allocator.

\`\`\`go
// SlicePool manages pools for different size classes
type SlicePool struct {
    pools []*sync.Pool
    sizes []int
}

func NewSlicePool() *SlicePool {
    sizes := []int{64, 256, 1024, 4096, 16384, 65536}
    pools := make([]*sync.Pool, len(sizes))

    for i, size := range sizes {
        size := size  // Capture for closure
        pools[i] = &sync.Pool{
            New: func() any {
                return make([]byte, 0, size)
            },
        }
    }

    return &SlicePool{pools: pools, sizes: sizes}
}

func (sp *SlicePool) Get(size int) []byte {
    for i, s := range sp.sizes {
        if size <= s {
            buf := sp.pools[i].Get().([]byte)
            return buf[:0]
        }
    }
    // Size too large for pool
    return make([]byte, 0, size)
}

func (sp *SlicePool) Put(buf []byte) {
    cap := cap(buf)
    for i, s := range sp.sizes {
        if cap == s {
            sp.pools[i].Put(buf[:0])
            return
        }
    }
    // Size not from pool, let GC handle it
}
\`\`\`

### Connection Pool (Not sync.Pool!)

\`sync.Pool\` is explicitly cleared by the garbage collector between GC cycles, meaning a network connection stored in it may be silently discarded, leaving your code to unexpectedly invoke \`factory\` and pay the connection-setup cost again. A dedicated \`ConnPool\` backed by a buffered channel holds connections with stable lifetime, validates liveness on retrieval, and enforces a hard cap on the total number of open connections.

\`\`\`go
// sync.Pool is NOT suitable for connections!
// Objects can be garbage collected at any time.
// Use a dedicated connection pool instead.

type ConnPool struct {
    mu      sync.Mutex
    conns   chan *Connection
    factory func() (*Connection, error)
    maxSize int
    size    int
}

func NewConnPool(maxSize int, factory func() (*Connection, error)) *ConnPool {
    return &ConnPool{
        conns:   make(chan *Connection, maxSize),
        factory: factory,
        maxSize: maxSize,
    }
}

func (p *ConnPool) Get(ctx context.Context) (*Connection, error) {
    select {
    case conn := <-p.conns:
        if conn.IsAlive() {
            return conn, nil
        }
        // Connection dead, create new one
        conn.Close()
        p.mu.Lock()
        p.size--
        p.mu.Unlock()
        return p.createConnection()

    default:
        // No pooled connections available
        return p.createConnection()
    }
}

func (p *ConnPool) createConnection() (*Connection, error) {
    p.mu.Lock()
    if p.size >= p.maxSize {
        p.mu.Unlock()
        // Wait for available connection
        return <-p.conns, nil
    }
    p.size++
    p.mu.Unlock()

    return p.factory()
}

func (p *ConnPool) Put(conn *Connection) {
    if !conn.IsAlive() {
        conn.Close()
        p.mu.Lock()
        p.size--
        p.mu.Unlock()
        return
    }

    select {
    case p.conns <- conn:
        // Returned to pool
    default:
        // Pool full, close connection
        conn.Close()
        p.mu.Lock()
        p.size--
        p.mu.Unlock()
    }
}
\`\`\`

### Pool Best Practices

The guidelines below distill the most common pitfalls into a concise reference: pool only short-lived temporary objects, always reset state before returning an object, and confirm with benchmarks that pooling actually reduces allocations in your specific hot path. The contrasting encoder and connection examples make the rule concrete, a JSON encoder buffer is a perfect candidate, while a TCP connection is not.

\`\`\`go
/*
DO:
- Use for short-lived temporary objects
- Reset objects before Put
- Use for reducing GC pressure in hot paths
- Measure with benchmarks before using

DON'T:
- Use for connections or file handles
- Rely on objects being in pool (GC can clear)
- Use for objects that aren't frequently allocated
- Forget to reset state before returning
*/

// Good: Encoding buffer pool
var encoderPool = sync.Pool{
    New: func() any {
        return json.NewEncoder(new(bytes.Buffer))
    },
}

// Bad: Connection pool with sync.Pool
var badConnPool = sync.Pool{
    New: func() any {
        conn, _ := net.Dial("tcp", "server:8080")
        return conn  // BAD: GC may close this connection!
    },
}
\`\`\`

### The sync.Pool Reset Discipline

Every object retrieved from a pool must be reset before use, or its previous state leaks into the new use. The review checklist:

\`\`\`go
func Get() *Buffer {
    buf := bufferPool.Get().(*Buffer)
    buf.Reset() // MANDATORY before returning
    return buf
}

func Put(buf *Buffer) {
    if buf.Cap() > maxPoolSize { return } // don't pool huge buffers
    bufferPool.Put(buf)
}
\`\`\`

Two common bugs:

1. **Forgetting the reset.** The next caller sees the previous caller's data. Silent data leakage. Worst case: security-sensitive data crossing request boundaries.
2. **Pooling oversized objects.** A buffer that grew to 100MB during one request should not re-enter the pool. Subsequent requests that pull it out pay the 100MB memory cost whether they need it or not. Cap the size before returning.

### When sync.Pool Is Actually Worth It

\`sync.Pool\` reduces GC pressure for objects that are allocated and released frequently in a concurrent workload. It is worth it when:

- Allocation rate is high (thousands per second).
- Object size is non-trivial (kilobytes).
- GC pauses are a measured problem.

For infrequent allocations or tiny objects, \`sync.Pool\` adds complexity for no benefit. The review question: "show me the benchmark that proves \`sync.Pool\` helps here". Without evidence, prefer plain allocation.

### Staff Lens: sync.Pool Hides Memory Behaviour

A codebase that uses \`sync.Pool\` everywhere has hard-to-reason-about memory behaviour. Objects live longer than their logical lifetime, and the GC's visible allocation rate no longer reflects the actual workload. This makes memory-related diagnosis harder. The staff-level discipline: use \`sync.Pool\` for specific, justified hot paths. Document why each pool exists. Do not pool "because it might help". The added complexity rarely pays for itself outside the handful of truly hot paths.

---
`;
