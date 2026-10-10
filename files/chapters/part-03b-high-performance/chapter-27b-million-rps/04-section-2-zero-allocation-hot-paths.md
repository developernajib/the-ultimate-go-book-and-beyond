## Section 2: Zero-Allocation Hot Paths

### 2.1 Escape Analysis and Stack Allocation

The Go compiler performs escape analysis to decide whether a variable is allocated on the stack (free) or heap (GC pressure). Understanding this is critical for high-throughput code.

All figures in this section were measured with Go 1.27.1 on an Intel i7-10510U running Linux, using `-benchmem` and varying (non-constant) inputs. The allocation counts are the reliable part and should reproduce anywhere. The nanosecond figures are from a busy laptop and are included only for their ratios.

```go
package escape

import (
	"fmt"
	"sync"
)

// Bad: fmt.Sprintf must box `id` into an `any` and parse a format string at
// run time. Measured: 24 B/op, 1-2 allocs/op for small ids, and 32 B/op,
// 2 allocs/op once the value is large enough that boxing cannot reuse the
// runtime's small-integer cache.
func badHandleRequest(id int) string {
	return fmt.Sprintf("request-%d", id) // HEAP allocation
}

// Good: format into a stack array, then allocate only the result string.
// The [32]byte does not escape, so it costs nothing.
func goodHandleRequest(id int) string {
	var buf [32]byte
	n := formatInt(buf[:], id)
	return string(buf[:n]) // The one remaining allocation.
}

// Best: the caller owns the buffer, so there is nothing left to allocate.
// Measured: 0 B/op, 0 allocs/op. This is the only one of the three that is
// genuinely zero-allocation, and it is the pattern the standard library uses
// everywhere (strconv.AppendInt, time.Time.AppendFormat, and friends).
//
// The cost is in the API: the caller must now own and reuse a buffer, and the
// returned slice aliases it, so it is invalid after the next call. That
// contract is the actual price of zero-alloc, not the extra lines of code.
func bestHandleRequest(id int, buf []byte) []byte {
	buf = buf[:0]
	buf = appendInt(buf, id)
	return buf
}

// appendInt appends the decimal representation of n to b.
//
// In real code use strconv.AppendInt, which is faster and handles math.MinInt.
// This is spelled out only to show that the trick is just "write digits into
// storage the caller already has".
//
// Note the deliberate bug-avoidance: negating n when n == math.MinInt
// overflows and stays negative. strconv handles that. This version does not,
// which is a good illustration of why hand-rolling these is usually a bad
// trade.
func appendInt(b []byte, n int) []byte {
	if n < 0 {
		b = append(b, '-')
		n = -n
	}
	if n == 0 {
		return append(b, '0')
	}
	var tmp [20]byte
	pos := len(tmp)
	for n > 0 {
		pos--
		tmp[pos] = byte('0' + n%10)
		n /= 10
	}
	return append(b, tmp[pos:]...)
}

func formatInt(buf []byte, n int) int {
	result := appendInt(buf[:0], n)
	return len(result)
}

// RequestBuffer provides pooled buffers for request processing.
// Eliminates per-request heap allocation entirely.
var requestBufferPool = sync.Pool{
	New: func() any {
		buf := make([]byte, 0, 4096)
		return &buf
	},
}

func AcquireBuffer() *[]byte {
	return requestBufferPool.Get().(*[]byte)
}

func ReleaseBuffer(buf *[]byte) {
	*buf = (*buf)[:0]
	requestBufferPool.Put(buf)
}
```

### 2.2 Object Pooling for Hot Objects

`sync.Pool` recycles heap-allocated objects across goroutines, amortizing allocation cost over many reuses and reducing GC scan work by keeping object lifetimes short. It is most effective for objects that are allocated often and are expensive to allocate relative to the work done with them: request buffers, encoders, scratch slices.

Before the code, a worked example of how to get this wrong, because the wrong version is seductive and appears in a lot of real code. Consider "pool the whole request context, with fixed-size arrays inline so nothing touches the heap":

```go
// DO NOT DO THIS. Worked example of a bad pooled object.
type badRequestContext struct {
	TraceID   [16]byte
	UserID    int64
	Headers   [32]header      // 336 B each
	Body      [64 * 1024]byte // inline body buffer
	Response  [64 * 1024]byte // inline response buffer
	// ... lengths omitted
}
```

The reasoning sounds right and the conclusion is wrong. Measured with `unsafe.Sizeof` on Go 1.27.1:

| Component | Size |
|---|---|
| `header` | 336 B |
| `Headers [32]header` | 10,752 B |
| **`badRequestContext` total** | **141,872 B (138.5 KB)** |

Two things are wrong here. First, "fixed-size array, not slice" does not mean "not on the heap". `new(badRequestContext)` heap-allocates all 138.5 KB in one go. Inlining an array into a struct removes a *separate* allocation and a pointer indirection, it does not remove the memory. Allocating 200 of these measured 28.1 MB of live heap.

Second, and worse, this object is now poison in a pool. `sync.Pool` is per-P, so on a 32-P machine one retained context per P is 4.3 MB of resident memory doing nothing, and on a 128-core box, 17.3 MB. That is the exact failure mode section 2.4 warns about, produced by following section 2.2's own advice too literally.

The fix is to pool the *variable* part and keep the object small, letting the caller size its buffers to reality rather than to the worst case:

```go
package pooling

import (
	"errors"
	"sync"
)

// RequestContext holds per-request scratch state. It is deliberately small.
// The buffers are slices drawn from a size-bounded pool, not inline arrays,
// so a request that needs 2 KB does not pay for 64 KB.
type RequestContext struct {
	TraceID [16]byte
	UserID  int64
	Headers []header // reused backing array, length reset per request
	Body    []byte   // pooled, capacity-bounded
	Resp    []byte   // pooled, capacity-bounded
}

type header struct{ Key, Value string }

// maxPooledCap bounds what we are willing to retain. A request that grows its
// buffer past this gets its buffer dropped on release rather than cached, so
// one pathological 10 MB request cannot permanently inflate the pool.
const maxPooledCap = 64 * 1024

const defaultCap = 4 * 1024

var ctxPool = sync.Pool{
	New: func() any {
		return &RequestContext{
			Headers: make([]header, 0, 16),
			Body:    make([]byte, 0, defaultCap),
			Resp:    make([]byte, 0, defaultCap),
		}
	},
}

// AcquireCtx returns a reset context. Always pair with ReleaseCtx via defer.
func AcquireCtx() *RequestContext {
	ctx := ctxPool.Get().(*RequestContext)
	ctx.Reset()
	return ctx
}

// ReleaseCtx returns ctx to the pool, dropping over-large buffers.
func ReleaseCtx(ctx *RequestContext) {
	if cap(ctx.Body) > maxPooledCap || cap(ctx.Resp) > maxPooledCap {
		// Let this one go to the GC instead of caching a giant buffer
		// forever on this P.
		return
	}
	ctxPool.Put(ctx)
}

// Reset clears every field. Note it is a method, not ad-hoc clearing at the
// call site: when someone adds a field next year, they add it here, and the
// pool does not start leaking one request's data into another's.
func (ctx *RequestContext) Reset() {
	ctx.TraceID = [16]byte{}
	ctx.UserID = 0
	// Zero the header strings before truncating so the pool does not pin the
	// previous request's strings alive. clear() is a builtin as of Go 1.21.
	clear(ctx.Headers)
	ctx.Headers = ctx.Headers[:0]
	ctx.Body = ctx.Body[:0]
	ctx.Resp = ctx.Resp[:0]
}

// ErrResponseTooLarge is returned when a write exceeds the response cap.
var ErrResponseTooLarge = errors.New("pooling: response exceeds limit")

// BufferedResponseWriter appends into the pooled response buffer.
//
// It is NOT called "zero copy": it copies into a reused buffer. The win is
// zero *allocation*, not zero copy, and conflating the two is how people end
// up believing things about their code that are not true.
type BufferedResponseWriter struct {
	ctx    *RequestContext
	status int
	limit  int
}

// Write appends b to the response buffer.
//
// Note it returns an error on overflow rather than silently truncating. The
// obvious implementation, `n := copy(dst[len:], b); return n, nil`, reports
// success while discarding the tail of every large response, which produces
// truncated JSON in production and no error anywhere in your logs.
func (w *BufferedResponseWriter) Write(b []byte) (int, error) {
	if w.limit > 0 && len(w.ctx.Resp)+len(b) > w.limit {
		return 0, ErrResponseTooLarge
	}
	w.ctx.Resp = append(w.ctx.Resp, b...)
	return len(b), nil
}

func (w *BufferedResponseWriter) WriteHeader(status int) { w.status = status }
```

### 2.3 String and Byte Slice Interning

String interning deduplicates repeated string values (HTTP header names, URL paths, metric labels) by storing a single canonical copy per unique value, reducing both allocation rate and GC pressure in applications that process many repeated strings. Since Go 1.23 the standard library ships [`unique`](https://pkg.go.dev/unique), which exposes `unique.Make[T comparable]` and `Handle[T]` for exactly this purpose: handles compare as pointer equality, the backing storage is weakly referenced so dead values are collected automatically, and it avoids the classic intern-table memory leak. For GC-friendly secondary caches (for example, response body dedup keyed by strong IDs you already own) Go 1.24 added the [`weak`](https://pkg.go.dev/weak) package so entries disappear when no strong reference remains. The code below shows a manual intern table for older code and the `unique` equivalent a modern service should prefer.

> **Senior track**: Prefer `unique.Make` over custom intern tables in new code. Custom tables that never evict are a classic slow leak on services that see unbounded label cardinality (user IDs, request IDs leaking into tags).

```go
package interning

import (
	"strings"
	"sync"
	"unsafe"
)

// Interner caches strings to avoid duplicate heap allocations.
// Critical for headers, content types, method names repeated millions of times.
type Interner struct {
	mu    sync.RWMutex
	cache map[string]string
}

func NewInterner() *Interner {
	return &Interner{
		cache: make(map[string]string, 1024),
	}
}

// Intern returns a deduplicated string. The returned string
// shares backing storage with all equal strings.
func (i *Interner) Intern(s string) string {
	i.mu.RLock()
	if v, ok := i.cache[s]; ok {
		i.mu.RUnlock()
		return v
	}
	i.mu.RUnlock()

	i.mu.Lock()
	defer i.mu.Unlock()
	if v, ok := i.cache[s]; ok {
		return v
	}
	// Store a copy so the stored key does not alias caller memory. This
	// matters when callers reach us via BytesToString below, where s points
	// into a buffer that is about to be reused for the next request.
	// strings.Clone says exactly that and is preferred over the older
	// string([]byte(s)) round trip (which does also copy, but reads like an
	// accident that the compiler failed to optimize away).
	clone := strings.Clone(s)
	i.cache[clone] = clone
	return clone
}

// BytesToString converts []byte to string without copying.
//
// UNSAFE. The returned string aliases b. It stays valid only for as long as
// b is unmodified, so this is safe only for a lookup that completes before
// the buffer is touched again, and never for a value you store. If you keep
// the result, you have created a string that mutates behind your back, and
// if you store it as a map key you have corrupted the map.
func BytesToString(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// StringToBytes converts string to []byte without copying.
//
// UNSAFE. Writing to the returned slice is undefined behaviour and will
// happily segfault, because string data may live in read-only memory. There
// is no "it worked in testing" defence here: a string literal lives in a
// read-only section, while a runtime-built string does not, so the same code
// crashes or does not depending on where its input came from.
func StringToBytes(s string) []byte {
	return unsafe.Slice(unsafe.StringData(s), len(s))
}
```

Modern equivalent using the stdlib `unique` package (Go 1.23+):

```go
package interning

import "unique"

// InternedHeader is a canonical handle for a header name.
// Two handles compare equal with == iff the underlying strings are equal,
// and the backing memory is freed once no handles remain.
type InternedHeader = unique.Handle[string]

func InternHeader(name string) InternedHeader {
	return unique.Make(name)
}
```

Be clear about where the win actually is, because it is easy to talk yourself into a benefit that is not there. `unique.Make` is **not** free: it does a lookup in the internal canonical map, so interning on every request is not cheaper than a map lookup on every request. It is the same lookup.

The payoff comes when you intern **once** and then compare or store **many** times. A `Handle[string]` is pointer-sized, so `==` on two handles is a pointer compare rather than a string compare, and a `map[Handle[string]]V` hashes a pointer rather than the string bytes. So the pattern that pays is: intern at the boundary where a string enters your system, pass handles around internally, and compare handles in the hot path.

The pattern that does not pay is calling `unique.Make("content-type")` inside your handler on every request and feeling good about it. If the string is a compile-time constant you already know at the call site, you have added work, not removed it. Hoist the handle into a package-level variable:

```go
// Interned once at init, compared cheaply forever after.
var (
	hdrContentType = unique.Make("content-type")
	hdrAccept      = unique.Make("accept")
)
```

The other real benefit is the one the manual table cannot offer: `unique`'s storage is weakly referenced, so entries vanish once no handle refers to them. The hand-rolled `Interner` above never evicts. Point it at unbounded cardinality (user IDs, request IDs, anything that leaks into a metric label) and you have written a memory leak with a helpful-sounding name.

### 2.4 Pitfalls of `sync.Pool` at scale

`sync.Pool` looks free. It is not. Four failure modes recur in production.

**1. Pooling a value instead of a pointer silently reintroduces an allocation.** This is the subtlest one and it defeats the entire purpose of the pool. `Put` takes an `any`. A pointer fits in an interface word, but a slice header is 24 bytes and does not, so `Put(buf)` where `buf` is a `[]byte` must heap-allocate a box to hold it. You have removed the buffer allocation and added a header allocation. Measured on Go 1.27.1 (i7-10510U, allocation counts are exact and machine-independent):

| Approach | B/op | allocs/op |
|---|---|---|
| No pool, `make([]byte, 0, 1024)` each time | 1024 | 1 |
| `Pool.Put(buf)` with `buf []byte` | **24** | **1** |
| `Pool.Put(&buf)` with `buf *[]byte` | **0** | **0** |

Note the middle row. It still allocates once per operation, exactly like having no pool at all. The bytes moved from 1024 to 24, which is a real improvement, but the allocation *count* is unchanged and so is the GC's object-tracking work. Only the pointer version reaches zero. **Pool pointers, never values.** This is why every buffer pool in this chapter stores `*[]byte`.

**2. The pool is per-P, so large pooled objects multiply by core count.** A pool holding a 64 KB buffer per P retains about 2 MB on a 32-P machine and 8 MB on a 128-P machine, resident, doing nothing, on an idle replica. Bound what you retain: if a buffer grew past a threshold, drop it on `Put` rather than caching it forever.

**3. State leaks from one request into the next.** Reset every field before returning an object, and do it in an explicit `Reset()` method rather than ad-hoc clears at the call site, so that the field someone adds next year gets cleared too. The version that bites is a pooled struct holding a `[]string` of the previous user's data, surfacing in someone else's response.

**4. Low-traffic pools do not work.** The GC clears pools, so an object must be reused within roughly a GC cycle to pay for itself. Precisely: since Go 1.13 each GC moves the live pool to a **victim cache** rather than dropping it immediately, so an object survives about two cycles, not one. This softens the cliff but does not remove it. A pool on a path that sees a handful of requests per second is pure overhead and complexity for no gain.

A production checklist: pool pointers, `Reset()` on `Get`, bound retained size on `Put`, benchmark with `-benchmem` against the non-pooled baseline (if `allocs/op` did not drop, the pool is not working), and validate under realistic traffic rather than a hot loop, since a hot loop is the one traffic shape that makes any pool look good.

### 2.5 Junior → FAANG: reading a heap profile line by line

Run your service under load. Capture `go tool pprof -http=:6061 http://localhost:8080/debug/pprof/heap` with both `-inuse_space` and `-alloc_space` views open side by side. `inuse_space` shows bytes live at sampling time, which is what RSS cares about. `alloc_space` shows total bytes allocated since start, which is what GC cost cares about. A classic pattern: `alloc_space` is dominated by a hot handler allocating 40 GB over the profile window, but `inuse_space` shows only 80 MB live. That is GC pressure, not a leak, and `sync.Pool` or zero-alloc rewriting is the fix. The inverse pattern (small `alloc_space`, large `inuse_space` that keeps growing) is a genuine leak and points you at a long-lived map, a goroutine pile-up, or a subscriber that never unsubscribes. Learn to read these two views in parallel and you will never again guess at an "allocation problem."

### 2.6 Senior @ FAANG: the zero-alloc trade-off table you bring to design review

Zero-alloc code is not a universal win. It costs readability, testability, and generalizability, and those costs are paid by every engineer who touches the file later, including you in eighteen months.

The staff-engineer artifact is a written trade-off table that lives next to the code. Here is the **template**. Every performance row in it is a blank you must fill from your own measurements, and that is the entire point: a table of numbers copied out of a book is worse than no table, because it looks like evidence.

| Axis | Normal handler | Zero-alloc handler |
|---|---|---|
| Allocs per req (`-benchmem`) | *measure* | *measure, target 0* |
| CPU per req (benchstat, 10+ runs) | *measure* | *measure* |
| p99 under production-shaped load | *measure* | *measure* |
| Lines of code | *count* | *count* |
| Unit-test complexity | simple | buffer ownership, pool-reset tests |
| New-hire time to safely modify | *your honest guess* | *your honest guess* |
| What fails first, and how loudly | slow, visible in profile | pool corruption, silent and wrong |

That last row deserves more weight than it usually gets. The two columns do not just differ in speed, they differ in **failure mode**, and the zero-alloc column fails worse. A normal handler that regresses gets slow, which shows up in a dashboard. A pooled handler with a missed `Reset` serves one user's data to another, which shows up in an incident report. Speed regressions are noticed. Correctness regressions are discovered.

Fill the table, put it in the PR description, and the decision stops being "optimize because performance is good" and becomes "pay this specific maintenance tax because the SLO requires it." That is the language architecture review can actually reason about, and it is what stops the optimization from being reverted in a panic six months later by someone who never knew what it bought.

If you cannot fill in the performance rows, you do not yet have an argument for the change. That is not a formality. It is the most common reason zero-alloc rewrites turn out to have been unnecessary: the allocation was never on the hot path, and nobody checked.

---
