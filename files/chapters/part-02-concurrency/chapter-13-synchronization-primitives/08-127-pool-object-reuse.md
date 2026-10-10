## 13.7 Pool: Object Reuse

`sync.Pool` provides a cache of temporary objects to reduce allocation pressure.

### Basic Buffer Pool

The most common use of `sync.Pool` is caching `bytes.Buffer` instances that would otherwise be allocated and immediately discarded on every request. The pattern is straightforward: `Get` retrieves an existing buffer from the pool (or calls `New` to allocate one), the deferred reset-and-`Put` returns a clean buffer at the end of the call, and the garbage collector handles any buffers that were never retrieved.

Straightforward, and easy to get catastrophically wrong. Start with the broken version, because it is the version people write:

```go
var bufferPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

// BROKEN: returns memory it just gave away.
func ProcessRequest(data []byte) []byte {
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufferPool.Put(buf)
    }()

    buf.Write(data)
    // Process...

    return buf.Bytes() // aliases buf's backing array!
}
```

`buf.Bytes()` does not copy. It returns a slice pointing into the buffer's backing array. The deferred `Put` then hands that exact array to the next caller of `Get`, who writes their data straight through the slice the previous caller is still holding. The result is not a crash, which would at least be honest. It is silent mutation:

```
caller A holds: "SECRET-USER-A-TOKEN"
caller A now holds: "attacker-req-BBBBBN"  <-- silently corrupted
```

In an HTTP server, "the previous caller" and "the next caller" are two different users' requests. This is how a pooled buffer turns into a cross-request data leak. The race detector will not flag it, because there is no race: the accesses are properly ordered, the program is simply wrong. Tests pass, because a test that calls the function once never observes the reuse.

The fix is to copy anything that outlives the `Put`:

```go
// Correct: the caller owns the returned bytes.
func ProcessRequest(data []byte) []byte {
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufferPool.Put(buf)
    }()

    buf.Write(data)
    // Process...

    return bytes.Clone(buf.Bytes()) // copy, then release the buffer
}
```

`bytes.Clone` (Go 1.20) is the clearest way to say "this is a copy". If copying defeats the purpose, which it often does, then the buffer is not a temporary and does not belong in a pool. Restructure so the pooled buffer never escapes the function: write into an `io.Writer` the caller supplies, or pass the buffer to the code that consumes it and `Put` only after that code returns.

The rule that prevents this entire class of bug: **nothing derived from a pooled object may outlive the `Put`.** Not a slice of it, not a pointer into it, not a struct field referencing it.

### Type-Safe Pool with Generics (Go 1.18+)

The raw `sync.Pool` API uses `any`, requiring a type assertion on every `Get` call, a source of both boilerplate and potential panics if the wrong type is stored. Wrapping it in a generic `Pool[T]` struct moves the assertion inside the implementation once, giving callers a fully typed `Get() T` method and eliminating the risk of a mismatched assertion elsewhere in the codebase.

```go
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
```

### Slice Pool with Size Classes

A single pool with a fixed capacity wastes memory when callers need widely varying buffer sizes. By maintaining one pool per size class (64, 256, 1024 bytes and so on) and selecting the smallest class that satisfies a request, `SlicePool` avoids over-allocation while still reusing memory across goroutines, a technique borrowed directly from the Go runtime's own memory allocator.

```go
// SlicePool manages pools for different size classes.
// Note the *[]byte, not []byte. See the explanation below.
type SlicePool struct {
    pools []*sync.Pool
    sizes []int
}

func NewSlicePool() *SlicePool {
    sizes := []int{64, 256, 1024, 4096, 16384, 65536}
    pools := make([]*sync.Pool, len(sizes))

    for i, size := range sizes {
        pools[i] = &sync.Pool{
            New: func() any {
                b := make([]byte, 0, size)
                return &b
            },
        }
    }

    return &SlicePool{pools: pools, sizes: sizes}
}

func (sp *SlicePool) Get(size int) []byte {
    for i, s := range sp.sizes {
        if size <= s {
            bp := sp.pools[i].Get().(*[]byte)
            return (*bp)[:0]
        }
    }
    // Size too large for pool
    return make([]byte, 0, size)
}

func (sp *SlicePool) Put(buf []byte) {
    c := cap(buf)
    for i, s := range sp.sizes {
        if c == s {
            buf = buf[:0]
            sp.pools[i].Put(&buf)
            return
        }
    }
    // Size not from pool, let GC handle it
}
```

Two things here are easy to miss.

The pools hold `*[]byte`, not `[]byte`, and that is not pedantry. `sync.Pool.Put` takes an `any`. A slice is a three-word header, so boxing it into an interface allocates, on every single `Put`. A pool whose job is to eliminate allocations that allocates each time you return something to it is a bad joke. Measured:

```
BenchmarkPutSlice-8      200000    43.23 ns/op    24 B/op    1 allocs/op
BenchmarkPutSlicePtr-8   200000    13.14 ns/op     0 B/op    0 allocs/op
```

A pointer is one word and fits in the interface directly, so it boxes for free. This is exactly what staticcheck's SA6002 warns about, and it is why `Get` returns `(*bp)[:0]` rather than the pointer itself: callers want a slice, the pointer is an implementation detail of the pool.

The `size := size` line that used to appear in the loop is gone. Since Go 1.22, loop variables are per-iteration, so each closure already captures its own `size`. In older code that line was load-bearing, and without it every pool in the slice would have allocated 65536-byte buffers. Today it is noise.

Finally, note that `Get` returns a slice whose capacity is the *size class*, not the requested size, and `Put` matches on capacity to find the right class. A buffer that was resliced in a way that changed its capacity will not match any class and will be dropped on the floor rather than corrupting a pool.

### Connection Pool (Not sync.Pool!)

`sync.Pool` items are dropped by the garbage collector. The documented contract is deliberately weak: "Any item stored in the Pool may be removed automatically at any time without notification." In practice the runtime clears pools during GC, keeping one generation in a victim cache so an object typically survives about two GC cycles before it is really gone, but that is an implementation detail you must not build on.

For a `*bytes.Buffer` this is fine, because dropping one costs an allocation. For a network connection it is not fine at all. The connection is not just memory: it is a file descriptor, a TCP session, and a server-side resource. Dropping it silently leaks the descriptor until the finalizer runs, and every drop forces `factory` to pay the dial-and-handshake cost again. Worse, `sync.Pool` cannot cap anything. It has no notion of a maximum, no way to validate an object before handing it out, and no way to close what it evicts.

A connection pool needs the opposite of what `sync.Pool` provides: stable lifetime, liveness validation on retrieval, deterministic close on eviction, and a hard ceiling on total open connections. That is a different data structure, and the `ConnPool` below is the shape it takes: a buffered channel of idle connections plus an explicit count guarded by a mutex.

```go
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
    for {
        // Fast path: take an idle connection if one is ready.
        select {
        case conn := <-p.conns:
            if conn.IsAlive() {
                return conn, nil
            }
            conn.Close()
            p.release() // the slot is free again, try for another
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        // No idle connection. Open one if we are under the cap.
        p.mu.Lock()
        if p.size < p.maxSize {
            p.size++ // reserve the slot before releasing the lock
            p.mu.Unlock()

            conn, err := p.factory()
            if err != nil {
                p.release() // give the slot back, or the pool shrinks forever
                return nil, err
            }
            return conn, nil
        }
        p.mu.Unlock()

        // At capacity. Wait for a returned connection, honoring ctx.
        select {
        case conn := <-p.conns:
            if conn.IsAlive() {
                return conn, nil
            }
            conn.Close()
            p.release()
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }
}

func (p *ConnPool) release() {
    p.mu.Lock()
    p.size--
    p.mu.Unlock()
}

func (p *ConnPool) Put(conn *Connection) {
    if !conn.IsAlive() {
        conn.Close()
        p.release()
        return
    }

    select {
    case p.conns <- conn:
        // Returned to pool
    default:
        // Pool full, close connection
        conn.Close()
        p.release()
    }
}
```

Three details in `Get` are load-bearing, and the naive version of this code gets all three wrong.

**The context is honored on every blocking path.** A `Get` that takes a `ctx` and then blocks on a bare `<-p.conns` is worse than one that never took a `ctx` at all, because it advertises a cancellation it does not implement. When the pool is exhausted and every connection is checked out by requests that are themselves stuck, callers pile up on that receive with no deadline, and the pool becomes the thing that turns a slow dependency into a total outage.

**The slot is reserved before the lock is released, and returned if `factory` fails.** `p.size++` happens under the same lock that tested `p.size < p.maxSize`. Splitting the test from the increment is a check-then-act race: two goroutines both read `size == maxSize-1`, both decide they may dial, and the pool quietly runs one connection over its cap. The failure path matters just as much. An early `return nil, err` that forgets `p.release()` permanently burns a slot, so a dependency that is briefly refusing connections leaves the pool smaller than it started. Enough failures and `maxSize` effectively drops to zero, at which point the pool wedges forever with no connections and no ability to create any.

**Dead connections loop rather than recurse.** Pulling a dead connection means trying again, and `for` expresses that without the stack growth an unbounded retry recursion would cause.

### Pool Best Practices

The guidelines below distill the most common pitfalls into a concise reference: pool only short-lived temporary objects, always reset state before returning an object, and confirm with benchmarks that pooling actually reduces allocations in your specific hot path. The contrasting encoder and connection examples make the rule concrete, a JSON encoder buffer is a perfect candidate, while a TCP connection is not.

```go
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

// Good: pool the buffer, build the encoder around it per call.
// The encoder is cheap - the buffer's backing array is what's worth reusing.
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}

func Marshal(v any) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    if err := json.NewEncoder(buf).Encode(v); err != nil {
        return nil, err
    }
    return bytes.Clone(buf.Bytes()), nil // copy: buf goes back to the pool
}

// Bad: pooling the encoder itself.
// Each encoder is welded to the buffer it was created with, and that
// buffer is unreachable from the caller. You can Encode into it and
// never read the result back out.
var badEncoderPool = sync.Pool{
    New: func() any {
        return json.NewEncoder(new(bytes.Buffer)) // useless
    },
}

// Bad: Connection pool with sync.Pool
var badConnPool = sync.Pool{
    New: func() any {
        conn, _ := net.Dial("tcp", "server:8080")
        return conn  // BAD: GC may drop this, leaking the descriptor!
    },
}
```

### The sync.Pool Reset Discipline

Every object retrieved from a pool must be reset before use, or its previous state leaks into the new use. The review checklist:

```go
func Get() *Buffer {
    buf := bufferPool.Get().(*Buffer)
    buf.Reset() // MANDATORY before returning
    return buf
}

func Put(buf *Buffer) {
    if buf.Cap() > maxPoolSize { return } // don't pool huge buffers
    bufferPool.Put(buf)
}
```

Three common bugs:

1. **Forgetting the reset.** The next caller sees the previous caller's data. Silent data leakage. Worst case: security-sensitive data crossing request boundaries.
2. **Pooling oversized objects.** A buffer that grew very large to serve one unusual request should not re-enter the pool. Every subsequent request that pulls it out pays that memory cost whether it needs it or not, and because pooled objects are shared across goroutines, one outlier request can permanently inflate the steady-state footprint of the whole process. Cap the capacity before returning, as the `Put` above does.
3. **Letting a reference escape the `Put`.** The `ProcessRequest` bug from the start of this section. Reset protects the *next* caller from the previous one. It does nothing for the previous caller, who may still be holding a slice into the buffer you just recycled. Resetting and escaping are independent bugs, and the reset discipline does not save you from the second.

### When sync.Pool Is Actually Worth It

`sync.Pool` reduces GC pressure for objects that are allocated and released frequently in a concurrent workload. It is worth it when:

- Allocation rate is high (thousands per second).
- Object size is non-trivial (kilobytes).
- GC pauses are a measured problem.

For infrequent allocations or tiny objects, `sync.Pool` adds complexity for no benefit. The review question: "show me the benchmark that proves `sync.Pool` helps here". Without evidence, prefer plain allocation.

### Staff Lens: sync.Pool Hides Memory Behavior

A codebase that uses `sync.Pool` everywhere has hard-to-reason-about memory behavior. Objects live longer than their logical lifetime, and the GC's visible allocation rate no longer reflects the actual workload. This makes memory-related diagnosis harder. The staff-level discipline: use `sync.Pool` for specific, justified hot paths. Document why each pool exists. Do not pool "because it might help". The added complexity rarely pays for itself outside the handful of truly hot paths.

---
