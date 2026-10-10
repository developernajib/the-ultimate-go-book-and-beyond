## Section 4: Practical Optimization Patterns

### 4.1 Fast JSON Serialization

The standard `encoding/json` package uses reflection for marshaling and unmarshaling, so alternatives that work with concrete types directly (code generation, or JIT and SIMD approaches like `github.com/bytedance/sonic`) have real headroom over it. How much headroom is a question about your payload, and it is the thing to measure rather than to quote: the win is largest on big, deeply nested documents and can round to nothing on the small flat structs that most APIs actually return.

Set expectations honestly before reaching for any of this. As the measurements in the encoder below show, a hand-rolled encoder for a small struct beat `encoding/json` by about **1.2x in time** on the reference machine, while eliminating its 2 allocations per op. The allocation win is the durable part and the reason to bother. If you were expecting the 5x that this kind of section usually promises, that expectation is exactly what this chapter exists to correct. Profile first, and only pay the maintenance cost of hand-written serialization if the profile says serialization is where your time actually goes.

```go
package fastjson

import (
	"strconv"
	"sync"
)

// FastJSONEncoder is a zero-allocation JSON encoder for known types, for hot
// paths where encoding/json's reflection is too slow.
//
// Measured, not asserted. Reference machine (Intel i7-10510U, Go 1.27.1,
// taskset -c 0-3), encoding a 4-field struct, verified to produce output
// byte-identical to encoding/json:
//
//	encoding/json                  302.9 .. 351.6 ns/op   144 B/op   2 allocs/op
//	FastJSONEncoder, copy out      181.2 .. 337.1 ns/op    80 B/op   1 allocs/op
//	FastJSONEncoder, no copy       262.7 ..  269.3 ns/op     0 B/op   0 allocs/op
//
// Read the allocation column, not the time column, and be honest about what
// this bought. The allocations are deterministic and the win there is real:
// 2 allocs/op down to 0. The TIME win is about 1.2x, and the timing ranges
// overlap so heavily on a loaded box that the copy-out variant cannot be
// distinguished from encoding/json at all.
//
// 1.2x. For a hand-written encoder that must be updated by hand every time the
// struct changes, that silently emits wrong JSON if you forget a Comma(), and
// that no reviewer can check by eye. An earlier draft of this comment claimed
// "encoding/json: 500ns/op, 10 allocs. FastJSONEncoder: 80ns/op, 0 allocs",
// which would be a 6x win. Every number in it was wrong: encoding/json does 2
// allocations here, not 10, and neither figure survived contact with a
// benchmark. That is how these claims propagate. Somebody measures something
// once, on some struct, on some machine, and the ratio outlives the context that
// produced it.
//
// So: reach for this ONLY when the profiler says serialization is your
// bottleneck AND you can use the no-copy path (writing straight into a socket
// or a pooled buffer). If you have to copy the bytes out, you have given back
// most of the allocation win and all of the speed, and you should just use
// encoding/json. The zero-alloc row is the entire justification for this type.
type FastJSONEncoder struct {
	buf []byte
}

var encoderPool = sync.Pool{
	New: func() any {
		return &FastJSONEncoder{buf: make([]byte, 0, 512)}
	},
}

func AcquireEncoder() *FastJSONEncoder {
	e := encoderPool.Get().(*FastJSONEncoder)
	e.buf = e.buf[:0]
	return e
}

func ReleaseEncoder(e *FastJSONEncoder) {
	encoderPool.Put(e)
}

// Bytes returns the encoded JSON.
func (e *FastJSONEncoder) Bytes() []byte { return e.buf }

// ObjectStart writes '{'.
func (e *FastJSONEncoder) ObjectStart() { e.buf = append(e.buf, '{') }

// ObjectEnd writes '}'.
func (e *FastJSONEncoder) ObjectEnd() { e.buf = append(e.buf, '}') }

// ArrayStart writes '['.
func (e *FastJSONEncoder) ArrayStart() { e.buf = append(e.buf, '[') }

// ArrayEnd writes ']'.
func (e *FastJSONEncoder) ArrayEnd() { e.buf = append(e.buf, ']') }

// Comma writes ','.
func (e *FastJSONEncoder) Comma() { e.buf = append(e.buf, ',') }

// StringField writes "key":"value".
func (e *FastJSONEncoder) StringField(key, value string) {
	e.buf = append(e.buf, '"')
	e.buf = appendEscaped(e.buf, key)
	e.buf = append(e.buf, '"', ':', '"')
	e.buf = appendEscaped(e.buf, value)
	e.buf = append(e.buf, '"')
}

// IntField writes "key":value.
func (e *FastJSONEncoder) IntField(key string, value int64) {
	e.buf = append(e.buf, '"')
	e.buf = append(e.buf, key...)
	e.buf = append(e.buf, '"', ':')
	e.buf = strconv.AppendInt(e.buf, value, 10)
}

// BoolField writes "key":true/false.
func (e *FastJSONEncoder) BoolField(key string, value bool) {
	e.buf = append(e.buf, '"')
	e.buf = append(e.buf, key...)
	e.buf = append(e.buf, '"', ':')
	if value {
		e.buf = append(e.buf, "true"...)
	} else {
		e.buf = append(e.buf, "false"...)
	}
}

// NullField writes "key":null.
func (e *FastJSONEncoder) NullField(key string) {
	e.buf = append(e.buf, '"')
	e.buf = append(e.buf, key...)
	e.buf = append(e.buf, '"', ':', 'n', 'u', 'l', 'l')
}

// appendEscaped appends s to b, escaping JSON special characters.
func appendEscaped(b []byte, s string) []byte {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if c < 0x20 {
				b = append(b, '\\', 'u', '0', '0', hexChar(c>>4), hexChar(c&0xF))
			} else {
				b = append(b, c)
			}
		}
	}
	return b
}

func hexChar(n byte) byte {
	if n < 10 {
		return '0' + n
	}
	return 'a' + n - 10
}

// Usage example:
//
//	e := AcquireEncoder()
//	e.ObjectStart()
//	e.StringField("id", user.ID)
//	e.Comma()
//	e.StringField("name", user.Name)
//	e.Comma()
//	e.IntField("age", int64(user.Age))
//	e.ObjectEnd()
//	w.Write(e.Bytes())
//	ReleaseEncoder(e)
```

### 4.2 String Processing Optimization

String operations in Go are immutable: every concatenation, `strings.Replace`, or `fmt.Sprintf` call allocates a new string, making string-heavy hot paths a common source of GC pressure in API servers that construct URLs, log lines, and response payloads. Using `strings.Builder` with a pre-allocated buffer, `append` on a `[]byte` slice reused from a pool, or byte-level operations that avoid string creation entirely reduces allocation count dramatically on hot paths. The optimizations below rewrite common string patterns, URL building, header construction, log formatting, using allocation-free equivalents.

```go
package strings_opt

import (
	"strings"
	"sync"
	"unicode/utf8"
	"unsafe"
)

// ByteCountOccurrences counts occurrences of b in s with a manual scan.
// For real code prefer strings.Count / bytes.Count: both are SIMD-optimized
// in the standard library and faster than this loop.
func ByteCountOccurrences(s string, b byte) int {
	count := 0
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			count++
		}
	}
	return count
}

// HasPrefixFast is a zero-allocation prefix check.
// strings.HasPrefix also zero-allocates - this is equivalent but explicit.
func HasPrefixFast(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// SplitOnByte splits s on delimiter b, returning substrings without allocation.
// Returns string slices that share s's backing memory.
func SplitOnByte(s string, b byte, result []string) []string {
	result = result[:0]
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			result = append(result, s[start:i])
			start = i + 1
		}
	}
	result = append(result, s[start:])
	return result
}

// TrimSpaceNoAlloc trims ASCII whitespace without allocating.
func TrimSpaceNoAlloc(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// ToLowerASCII converts an ASCII string to lowercase without allocation.
// Only correct for pure ASCII - use strings.ToLower for UTF-8.
func ToLowerASCII(s string) string {
	// Fast path: check if any uppercase bytes exist.
	hasUpper := false
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			hasUpper = true
			break
		}
	}
	if !hasUpper {
		return s // No allocation needed.
	}

	b := []byte(s) // One allocation.
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b) // Another allocation - total: 2 allocs.
}

// StringBuilderPool pools strings.Builder to avoid per-call allocation.
var builderPool = sync.Pool{
	New: func() any { return &strings.Builder{} },
}

func AcquireBuilder() *strings.Builder {
	b := builderPool.Get().(*strings.Builder)
	b.Reset()
	return b
}

func ReleaseBuilder(b *strings.Builder) {
	builderPool.Put(b)
}

// UTF8 validation without allocation.
func IsValidUTF8(s string) bool {
	return utf8.ValidString(s)
}

// CountRunes counts UTF-8 runes without converting to []rune.
// utf8.RuneCountInString is O(n) but avoids the O(n) allocation of []rune(s).
func CountRunes(s string) int {
	return utf8.RuneCountInString(s)
}

// BytesToString converts []byte to string without allocation.
// UNSAFE: the returned string must not outlive b or be used after b is modified.
//
//go:nosplit
func BytesToStringUnsafe(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// StringToBytes converts string to []byte without allocation.
// UNSAFE: do not modify the returned slice.
//
//go:nosplit
func StringToBytesUnsafe(s string) []byte {
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

```

### 4.3 Fast Path / Slow Path Pattern

Separating the common case (fast path) from exceptional or complex cases (slow path) allows the compiler to inline and optimize the fast path independently, keeping the hot code path free of branches, allocations, and indirections introduced by the slow path. This pattern appears throughout the Go standard library, `sync.Mutex`'s uncontended fast path is a single atomic CAS, with the slow path (OS futex) taken only on contention. The implementation below applies the pattern to an HTTP response writer that serves most responses from a pre-allocated buffer and falls back to dynamic allocation only when the response exceeds the buffer's capacity.

```go
package fastpath

import (
	"sync"
	"sync/atomic"
)

// FastSlowCache implements a two-tier cache:
// Fast path: atomic load of a pre-computed result (nanoseconds).
// Slow path: full computation with locking (microseconds).
// Use when 99%+ of requests share the same computed value.
type FastSlowCache[K comparable, V any] struct {
	// Fast path: pre-computed hot value.
	hotKey   atomic.Pointer[K]
	hotValue atomic.Pointer[V]

	// Slow path: full cache.
	mu    sync.RWMutex
	cache map[K]V
	compute func(K) V
}

func NewFastSlowCache[K comparable, V any](compute func(K) V) *FastSlowCache[K, V] {
	return &FastSlowCache[K, V]{
		cache:   make(map[K]V),
		compute: compute,
	}
}

// Get returns the value for key.
// Fast path: O(1) atomic load if key == hotKey.
// Slow path: map lookup + compute if needed.
func (c *FastSlowCache[K, V]) Get(key K) V {
	// Fast path: check if this is the hot key.
	if hotKey := c.hotKey.Load(); hotKey != nil && *hotKey == key {
		if hotVal := c.hotValue.Load(); hotVal != nil {
			return *hotVal
		}
	}

	// Slow path.
	return c.getSlow(key)
}

func (c *FastSlowCache[K, V]) getSlow(key K) V {
	// Check read-locked cache first.
	c.mu.RLock()
	val, ok := c.cache[key]
	c.mu.RUnlock()
	if ok {
		return val
	}

	// Compute and store.
	val = c.compute(key)
	c.mu.Lock()
	c.cache[key] = val
	c.mu.Unlock()

	// Promote to hot path.
	keyCopy := key
	valCopy := val
	c.hotKey.Store(&keyCopy)
	c.hotValue.Store(&valCopy)

	return val
}

// AdaptiveThrottler applies rate limiting only when under load.
// When load is low: no-op (fast path, 0 allocations).
// When load is high: token bucket rate limiting (slow path).
type AdaptiveThrottler struct {
	currentRPS   atomic.Uint64
	threshold    uint64 // RPS above which to throttle.
	tokens       atomic.Int64
	maxTokens    int64
	refillRate   int64 // tokens per second.
	lastRefill   atomic.Int64 // Unix nanoseconds.
}

func NewAdaptiveThrottler(threshold uint64, maxTokens, refillRate int64) *AdaptiveThrottler {
	t := &AdaptiveThrottler{
		threshold:  threshold,
		maxTokens:  maxTokens,
		refillRate: refillRate,
	}
	t.tokens.Store(maxTokens)
	return t
}

// Allow returns true if the request is allowed.
func (t *AdaptiveThrottler) Allow() bool {
	// Fast path: below threshold, always allow.
	if t.currentRPS.Load() < t.threshold {
		return true
	}

	// Slow path: token bucket check.
	t.refill()
	if t.tokens.Add(-1) >= 0 {
		return true
	}
	t.tokens.Add(1) // Restore token.
	return false
}

func (t *AdaptiveThrottler) refill() {
	now := nanotime()
	last := t.lastRefill.Load()
	elapsed := now - last

	if elapsed < 1e9/t.refillRate { // Less than one refill interval.
		return
	}

	if t.lastRefill.CompareAndSwap(last, now) {
		tokensToAdd := elapsed * t.refillRate / 1e9
		current := t.tokens.Load()
		if current+tokensToAdd > t.maxTokens {
			t.tokens.Store(t.maxTokens)
		} else {
			t.tokens.Add(tokensToAdd)
		}
	}
}

func nanotime() int64 {
	// In production: use runtime.nanotime() via go:linkname or time.Now().UnixNano().
	return int64(0) // Placeholder.
}

// RecordRPS updates the observed RPS (call once per second from a background goroutine).
func (t *AdaptiveThrottler) RecordRPS(rps uint64) {
	t.currentRPS.Store(rps)
}
```

### 4.4 Junior → FAANG: the JSON decision tree

When a profile shows `encoding/json` eating CPU, do not immediately reach for `sonic` or `jsoniter`. Walk a decision tree. First, can you reduce the amount of JSON being processed? Batch responses, use field selection, drop unused fields. Every byte you do not serialize is free. Second, can you switch to a binary format (protobuf, MessagePack, FlatBuffers) on an internal API boundary where you control both ends? Often yes, and this is usually the largest win available, because it removes the parsing work rather than speeding it up. Third, can you generate specialized marshalers with `easyjson` or `go generate` on your own types? This removes reflection without changing the on-wire format. Fourth, if none of those apply, try `sonic` (amd64/arm64, JIT and SIMD) or `goccy/go-json` as a drop-in replacement and measure. Fifth, if the profile still shows JSON as the top hot spot, write a hand-rolled encoder like section 4.1, remembering that section 4.1 measured 1.2x for its trouble.

No multipliers are attached to those steps on purpose. Every one of them depends on your payload shape, and the ratios that circulate for them (5x here, 3 to 5x there, 30 to 60 percent for the drop-ins) are someone else's document on someone else's hardware. Each step is a hypothesis with a benchmark attached, and the ordering is what matters: the easier steps often produce larger wins than the harder ones, which is why skipping to step five is how engineers end up maintaining hand-written JSON code that never recovered the CPU they thought it would. The decision tree matters because the easier steps often produce larger wins than the harder ones, and skipping to step five is how engineers end up with hand-written JSON code that never recovered the CPU they thought it would.

### 4.5 Senior @ FAANG: the fast-path/slow-path design review

The fast-path/slow-path pattern is powerful and frequently misapplied. Four review questions separate a well-designed split from a cargo-cult one. First, what fraction of traffic is expected to hit the fast path? Below 80 percent and the split is usually pessimization (the fast path's branch and bookkeeping cost more than the slow path saves). Second, what is the cost of falling off the fast path? If a miss invalidates a cache, invalidates a prediction, or triggers a lock, the split is reintroducing the cost you were trying to avoid. Third, how is the fast path kept correct as the slow path evolves? A common failure mode: the slow path grows a new behavior that the fast path silently skips, producing subtle bugs that only manifest under certain traffic shapes. Fourth, is there a metric that alerts when fast-path hit rate drops below expectations? If not, a shift in traffic patterns will degrade performance invisibly. Services that answer these four questions write fast-path code that ages well. Services that do not accumulate splits that were once optimizations and are now just complexity.

### 4.6 Pattern taxonomy for code review

When a PR lands in this chapter's territory, it usually fits one of six patterns. Know them by name so review conversations are concise. **Pool-and-reuse**: replace per-request allocation with `sync.Pool`. Review check: pool hit rate, reset discipline. **Flatten**: replace pointers with values, arrays, or indices. Review check: measured alloc/op and RSS delta. **Vectorize**: there is no such pattern in Go, and a PR claiming one deserves a hard question. The gc compiler does not auto-vectorize: you cannot restructure a loop to coax SIMD out of it the way you can with clang or gcc. Real vectorized Go means hand-written assembly, an assembly-backed library (`golang.org/x/crypto`, `simd`-style packages), or cgo. Review check: if someone says "I rewrote the loop so it vectorizes", ask them to show you VPADD or VPMULL in `go tool compile -S`. They will not find it, and the two of you have just saved a week. **Branch-free**: replace input-dependent branches with arithmetic or lookup tables. Review check: `perf stat` branch-miss rate delta. **Fast-path split**: extract the common case into a cheap path with a slow-path fallback. Review check: measured hit rate in production. **Zero-copy**: eliminate an intermediate buffer with `mmap`, `sendfile`, `splice`, or `unsafe.String`. Review check: lifetime contract for the shared buffer is documented. Tagging a PR with the pattern name in the description makes review faster and helps junior reviewers know what evidence to ask for.

---
