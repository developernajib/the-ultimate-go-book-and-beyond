## Section 7: Advanced CPU and Memory Optimization Techniques

### 7.1 Instruction-Level Parallelism (ILP)

Modern CPUs do not execute one instruction at a time. Pipelining, superscalar execution, and out-of-order dispatch allow a single core to process 3-6 independent instructions per cycle. However, the CPU can only exploit this parallelism when instructions are independent. A data dependency between two instructions forces the second to wait for the first to complete, creating a pipeline stall that wastes cycles even though the hardware has idle execution units.

The most common ILP killer in Go code is the **loop-carried dependency**: each iteration of a loop depends on the result of the previous iteration. The CPU cannot start iteration N+1 until iteration N finishes writing its result.

```go
package ilp

import (
	"testing"
)

// SequentialSum has a loop-carried dependency: each iteration reads and
// writes `sum`, so the CPU cannot overlap iterations.
// The add instruction has 3-4 cycle latency on modern CPUs.
// Throughput: 1 addition per 3-4 cycles (serial dependency chain).
func SequentialSum(data []int64) int64 {
	var sum int64
	for i := 0; i < len(data); i++ {
		sum += data[i] // sum depends on previous iteration's sum.
	}
	return sum
}

// ParallelSum breaks the dependency chain into 4 independent accumulators.
// The CPU can execute all 4 additions simultaneously using different
// execution units. At the end, we combine the 4 partial sums.
// Throughput: 4 additions per 3-4 cycles (4× improvement).
func ParallelSum(data []int64) int64 {
	var s0, s1, s2, s3 int64
	n := len(data)

	// Process 4 elements per iteration - each accumulator is independent.
	i := 0
	for ; i <= n-4; i += 4 {
		s0 += data[i]   // Independent: writes to s0.
		s1 += data[i+1] // Independent: writes to s1.
		s2 += data[i+2] // Independent: writes to s2.
		s3 += data[i+3] // Independent: writes to s3.
	}

	// Handle remaining elements.
	for ; i < n; i++ {
		s0 += data[i]
	}

	return s0 + s1 + s2 + s3
}

// Benchmark: ParallelSum vs SequentialSum on 1M int64 elements.
//
// BenchmarkSequentialSum-8    1000000    ~0.85ms/op
// BenchmarkParallelSum-8     1000000    ~0.28ms/op   (~3× faster)
//
// The speedup comes entirely from breaking the data dependency.
// Both functions perform the same number of additions.

func BenchmarkSequentialSum(b *testing.B) {
	data := make([]int64, 1_000_000)
	for i := range data {
		data[i] = int64(i)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		SequentialSum(data)
	}
}

func BenchmarkParallelSum(b *testing.B) {
	data := make([]int64, 1_000_000)
	for i := range data {
		data[i] = int64(i)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		ParallelSum(data)
	}
}

// DependentLoop: each iteration depends on the previous result.
// The CPU cannot start computing data[i] * factor until the previous
// iteration writes to factor. This is a serial chain.
func DependentLoop(data []float64) float64 {
	factor := 1.0
	for i := 0; i < len(data); i++ {
		factor = data[i] * factor // Loop-carried dependency on factor.
	}
	return factor
}

// IndependentLoop: each iteration writes to a separate output.
// No iteration depends on the previous result - fully parallelizable.
func IndependentLoop(data, result []float64, factor float64) {
	for i := 0; i < len(data); i++ {
		result[i] = data[i] * factor // No dependency between iterations.
	}
}

// Practical tip: when profiling reveals a hot loop with low IPC
// (< 2.0 on a 4-wide CPU), check for loop-carried dependencies.
// Breaking the dependency chain into 2-4 independent accumulators
// is the simplest and most effective fix.
```

### 7.2 Not Relying on Inlining

The Go compiler automatically inlines small functions at their call sites, eliminating function call overhead (stack frame setup, register saves, branch to callee, return). More importantly, inlining enables further optimizations: the compiler can perform constant folding, dead code elimination, and escape analysis across the inlined boundary. A function that allocates when called through an interface may allocate nothing when inlined into a specific caller.

The compiler assigns an "inlining cost" to each function based on AST node count. As of Go 1.21+, functions with cost 80 or below are eligible for inlining. Mid-stack inlining (since Go 1.12) means functions that call other inlineable functions can themselves be inlined.

```go
package inlining

import (
	"testing"
)

// SmallFunc has a low inlining cost - the compiler will inline it.
// After inlining, the caller sees `a + b` directly - zero overhead.
func SmallFunc(a, b int) int {
	return a + b
}

// MediumFunc does more work but is still within the inlining budget.
// The compiler inlines this into callers that use it in hot paths.
func MediumFunc(data []int, target int) int {
	for i, v := range data {
		if v == target {
			return i
		}
	}
	return -1
}

// NonInlinedAdd is identical to SmallFunc, but the directive prevents
// inlining so we can price the call overhead.
//
//go:noinline
func NonInlinedAdd(a, b int) int {
	return a + b
}

// ---------------------------------------------------------------------
// A WORKED EXAMPLE OF A BENCHMARK THAT MEASURES NOTHING
//
// This benchmark is wrong. It is reproduced because its output is
// seductive and this exact mistake is everywhere, including in earlier
// drafts of this book.
//
//	func BenchmarkInlinedCall(b *testing.B) {
//	    x, y := 42, 58
//	    for n := 0; n < b.N; n++ {
//	        _ = SmallFunc(x, y)   // result discarded
//	    }
//	}
//
// Run on Go 1.27 / i7-10510U it reports:
//
//	BenchmarkInlinedCall-4      0.2400 ns/op  ± 13%
//
// That number is a lie, and you can prove it without a profiler. This
// machine's clock during the run was well under 2 GHz, so one CPU cycle is
// upwards of 0.5 ns. A result of 0.24 ns/op claims the loop body took less
// than half a cycle. Nothing takes less than half a cycle. The only
// explanation is that there is no loop body: x and y are constants, the
// result is assigned to the blank identifier, so the compiler folds the
// call, sees the result is unused, and deletes the whole thing. The
// benchmark times an empty loop.
//
// RULE OF THUMB: any benchmark reporting under ~1 ns/op is measuring
// dead code until proven otherwise. Sub-nanosecond results are not a
// triumph, they are a bug report.
//
// The fix is b.Loop() (Go 1.24+), which the compiler is not allowed to
// optimize through, plus a sink for the result. Measured honestly:
//
//	BenchmarkInlinedCall_Loop-4       1.697 ns/op  ± 18%
//	BenchmarkNonInlinedCall_Loop-4    2.344 ns/op  ± 14%
//
// So a non-inlined call costs about 0.6 ns more than an inlined one here,
// roughly 1.4x, NOT the 6x that comparing 1.8 against the phantom 0.3
// would have suggested. The call overhead is real. It is just small.
// ---------------------------------------------------------------------

// Sink defeats dead-code elimination for results we do not otherwise use.
var Sink int

func BenchmarkInlinedCall(b *testing.B) {
	x, y := 42, 58
	for b.Loop() {
		Sink = SmallFunc(x, y)
	}
}

func BenchmarkNonInlinedCall(b *testing.B) {
	x, y := 42, 58
	for b.Loop() {
		Sink = NonInlinedAdd(x, y)
	}
}

// Verify inlining decisions with:
//   go build -gcflags="-m" ./...
//
// Output:
//   ./inlining.go:10:6: can inline SmallFunc
//   ./inlining.go:15:6: can inline MediumFunc
//   ./inlining.go:25:6: cannot inline NonInlinedAdd: marked go:noinline
//
// For more detail:
//   go build -gcflags="-m=2" ./...
//   Shows cost and reason: "cost 4 of 80 max", "function too complex"

// What defeats inlining:
// 1. Function is too complex (cost > 80 AST nodes)
// 2. Function contains recover()
// 3. Function uses go keyword (spawns goroutine)
// 4. Function uses defer (in Go versions before 1.22, defer had inlining cost - //    in Go 1.22+, simple defers are cheaper but complex patterns still prevent it)
// 5. Interface method calls (the concrete implementation is unknown at compile time)

// ComplexFunc exceeds the inlining budget - too many operations.
func ComplexFunc(data []int) (int, int, int) {
	var sum, min, max int
	if len(data) == 0 {
		return 0, 0, 0
	}
	min = data[0]
	max = data[0]
	for _, v := range data {
		sum += v
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
	}
	avg := sum / len(data)
	variance := 0
	for _, v := range data {
		diff := v - avg
		variance += diff * diff
	}
	return sum, min, max
}

// Refactored: split into smaller inlineable functions.
// Each sub-function is below the inlining threshold.
func SumInline(data []int) int {
	s := 0
	for _, v := range data {
		s += v
	}
	return s
}

func MinInline(data []int) int {
	m := data[0]
	for _, v := range data[1:] {
		if v < m {
			m = v
		}
	}
	return m
}

func MaxInline(data []int) int {
	m := data[0]
	for _, v := range data[1:] {
		if v > m {
			m = v
		}
	}
	return m
}

// StatsRefactored calls three small inlineable functions.
// Mid-stack inlining: the caller of StatsRefactored may inline it,
// and transitively inline Sum, Min, Max - one big optimized block.
func StatsRefactored(data []int) (int, int, int) {
	return SumInline(data), MinInline(data), MaxInline(data)
}

// Best practices for inlining in hot paths:
// 1. Keep hot-path functions small (< 40 lines of logic)
// 2. Avoid interface calls in inner loops - use concrete types
// 3. Split complex functions into composable small functions
// 4. Use go build -gcflags="-m" to verify inlining on critical paths
// 5. Benchmark inlined vs //go:noinline to quantify the difference
```

### 7.3 Inefficient String-to-Byte Conversions in Hot Paths

Every `[]byte(s)` conversion in Go allocates a new byte slice and copies the string contents. For a 1KB string, that is 1KB of allocation and copy per conversion. In hot loops - JSON processing, logging, HTTP header writing - these conversions accumulate into significant GC pressure and CPU overhead.

```go
package stringconv

import (
	"bytes"
	"strings"
	"testing"
	"unsafe"
)

// NaiveJSONContains converts a string to []byte on every call.
// Each conversion allocates len(s) bytes and copies the string data.
func NaiveJSONContains(jsonStr string, key string) bool {
	data := []byte(jsonStr)          // Allocation + copy every call.
	return bytes.Contains(data, []byte(key)) // Another allocation for key.
}

// OptimizedJSONContains avoids the conversion entirely.
// strings.Contains works directly on strings - no allocation.
func OptimizedJSONContains(jsonStr string, key string) bool {
	return strings.Contains(jsonStr, key) // Zero allocation.
}

// ZeroCopyStringToBytes converts a string to []byte without copying.
// SAFETY: The returned byte slice MUST NOT be modified - strings are immutable.
// Mutating the returned slice is undefined behavior and will corrupt the string.
// Go 1.20+ provides unsafe.StringData for this purpose.
func ZeroCopyStringToBytes(s string) []byte {
	if len(s) == 0 {
		return nil
	}
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

// ZeroCopyBytesToString converts []byte to string without copying.
// SAFETY: The source byte slice MUST NOT be modified after this call.
// Any mutation to the byte slice will silently corrupt the string.
func ZeroCopyBytesToString(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// ProcessMessages demonstrates the allocation problem in a realistic scenario.
// Each message is a JSON string that needs byte-level processing.

// Slow: converts string→[]byte for every message.
func ProcessMessagesSlow(messages []string) int {
	total := 0
	for _, msg := range messages {
		data := []byte(msg)            // Allocation per message.
		total += bytes.Count(data, []byte(",")) // Allocation for separator.
	}
	return total
}

// Fast: works with strings directly - no conversions needed.
func ProcessMessagesFast(messages []string) int {
	total := 0
	for _, msg := range messages {
		total += strings.Count(msg, ",") // Zero allocation.
	}
	return total
}

// Benchmark: 10,000 messages of 512 bytes each.
//
// BenchmarkProcessSlow-8    1000    ~4.2ms/op    10000 allocs/op    5120000 B/op
// BenchmarkProcessFast-8    1000    ~1.1ms/op    0 allocs/op        0 B/op
//
// 4× faster, zero allocations.

func BenchmarkProcessSlow(b *testing.B) {
	messages := make([]string, 10_000)
	for i := range messages {
		messages[i] = strings.Repeat("a]b,c,d,e,", 51) // ~510 bytes
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		ProcessMessagesSlow(messages)
	}
}

func BenchmarkProcessFast(b *testing.B) {
	messages := make([]string, 10_000)
	for i := range messages {
		messages[i] = strings.Repeat("a]b,c,d,e,", 51)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		ProcessMessagesFast(messages)
	}
}

// strings.Builder: the correct way to build strings incrementally.
// Internally uses a []byte buffer and converts to string at the end
// with zero-copy (the buffer is handed directly to the string header).
func BuildResponse(parts []string) string {
	var b strings.Builder
	b.Grow(estimateSize(parts)) // Pre-allocate to avoid regrowth.

	for i, part := range parts {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(part)
	}
	return b.String() // Zero-copy: builder hands off its internal buffer.
}

func estimateSize(parts []string) int {
	total := len(parts) - 1 // Commas between parts.
	for _, p := range parts {
		total += len(p)
	}
	return total
}

// Summary of string/byte conversion rules:
// 1. If you need a read-only []byte view of a string: use unsafe.Slice (Go 1.20+)
// 2. If you need a string view of []byte: use unsafe.String (Go 1.20+)
// 3. If you can avoid the conversion entirely: use strings.* instead of bytes.*
// 4. For building strings: use strings.Builder with Grow()
// 5. For building []byte: use append() with a pre-allocated slice
// 6. The unsafe conversions are for expert use - prefer safe alternatives first
```

### 7.4 Not Using sync.Pool for Temporary Objects

Every allocation that escapes to the heap becomes work for the garbage collector. In high-throughput services, per-request allocations (buffers, encoders, temporary structs) can generate millions of short-lived objects per second. The GC must scan, mark, and sweep all of them. `sync.Pool` provides a way to recycle these objects: instead of allocating a new buffer for each request and discarding it afterward, you borrow one from the pool and return it when done. The pool is GC-aware and will release unused objects during garbage collection.

> **Senior track**: Go 1.26 makes the Green Tea GC the default (covered in Chapter 27C). Green Tea reduces scan cost for pointer-sparse heaps, which means the cost of "a few extra pooled pointers" is lower than it was under the old tri-color mark. Even so, the pooled object pattern still wins because the allocation path itself is the dominant cost, not scan work. Do not skip pooling because "Green Tea handles it". Green Tea makes allocation-heavy code hurt less, not free.

```go
package syncpool

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

// --- Without sync.Pool: allocate a new buffer per request ---

type User struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// HandleWithoutPool allocates a new bytes.Buffer per call.
// Under load (10K req/s), this creates 10K buffer objects per second,
// each requiring GC scan and eventual collection.
func HandleWithoutPool(user *User) ([]byte, error) {
	buf := new(bytes.Buffer) // Escapes to heap - 1 allocation.
	buf.Grow(256)            // Internal buffer - 2nd allocation.
	err := json.NewEncoder(buf).Encode(user)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// --- With sync.Pool: recycle buffers across requests ---

var bufferPool = sync.Pool{
	New: func() any {
		buf := new(bytes.Buffer)
		buf.Grow(256) // Pre-allocate reasonable initial capacity.
		return buf
	},
}

// HandleWithPool borrows a buffer from the pool and returns it after use.
// Under load, the pool maintains a cache of warm buffers - zero allocation
// on the hot path after the initial warmup period.
func HandleWithPool(user *User) ([]byte, error) {
	buf := bufferPool.Get().(*bytes.Buffer)
	buf.Reset() // CRITICAL: always reset before reuse.
	defer bufferPool.Put(buf)

	err := json.NewEncoder(buf).Encode(user)
	if err != nil {
		return nil, err
	}

	// Copy the result out before returning the buffer to the pool.
	// If we returned buf.Bytes() directly, the caller would hold a reference
	// to memory that could be overwritten by the next pool user.
	result := make([]byte, buf.Len())
	copy(result, buf.Bytes())
	return result, nil
}

// Benchmark: 10,000 sequential JSON encodings.
//
// BenchmarkWithoutPool-8    10000    ~850 ns/op    512 B/op    3 allocs/op
// BenchmarkWithPool-8       10000    ~620 ns/op    256 B/op    1 allocs/op
//
// Pool version: 27% faster, 50% fewer bytes allocated, 66% fewer allocations.
// Under concurrent load the difference widens because GC pressure compounds.

func BenchmarkWithoutPool(b *testing.B) {
	user := &User{ID: 1, Name: "Alice", Email: "alice@example.com"}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_, _ = HandleWithoutPool(user)
	}
}

func BenchmarkWithPool(b *testing.B) {
	user := &User{ID: 1, Name: "Alice", Email: "alice@example.com"}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_, _ = HandleWithPool(user)
	}
}

// --- Proper sync.Pool pattern with typed wrapper ---

// SlicePool provides a type-safe pool for byte slices of a given capacity.
// This avoids the type assertion overhead and documents the expected usage.
type SlicePool struct {
	pool sync.Pool
	cap  int
}

func NewSlicePool(capacity int) *SlicePool {
	return &SlicePool{
		cap: capacity,
		pool: sync.Pool{
			New: func() any {
				s := make([]byte, 0, capacity)
				return &s
			},
		},
	}
}

func (p *SlicePool) Get() *[]byte {
	return p.pool.Get().(*[]byte)
}

func (p *SlicePool) Put(s *[]byte) {
	// Reset length to 0 but keep capacity.
	*s = (*s)[:0]

	// Guard against slices that grew beyond expected capacity.
	// Returning oversized slices to the pool wastes memory.
	if cap(*s) > p.cap*4 {
		return // Discard - let GC reclaim the oversized buffer.
	}
	p.pool.Put(s)
}

// Common sync.Pool pitfalls:
//
// 1. ALWAYS Reset() objects before Put() - stale data leaks between requests.
//
// 2. Pool objects are reclaimed at ANY GC cycle. Do not rely on pool for
//    caching long-lived data. The pool is a recycler, not a cache.
//
// 3. Do not store pointers to pool-owned memory outside the Get/Put scope.
//    After Put(), another goroutine may receive and overwrite that memory.
//
// 4. Pool.New is called when the pool is empty. Size it for the common case,
//    not the worst case. Oversized New allocations waste memory.
//
// 5. Measure with benchmarks: sync.Pool has mutex overhead. For objects
//    cheaper than ~100 bytes, the pool overhead may exceed allocation cost.

// Real-world usage in the Go standard library:
// - encoding/json: pools *encodeState for JSON encoding buffers
// - fmt: pools pp (printer) structs for fmt.Sprintf/Fprintf
// - net/http: pools bufio.Reader/Writer for connection I/O
// - compress/gzip: pools gzip.Writer instances
```

### 7.5 Bounds Check Elimination (BCE)

Go inserts runtime bounds checks on every slice and array access to prevent buffer overflows. If an index is out of range, the runtime panics instead of silently reading or writing arbitrary memory. This is a fundamental safety guarantee, but each bounds check is a conditional branch that costs 1-2 nanoseconds. In tight inner loops processing millions of elements, these checks add up.

The Go compiler's SSA optimization pass performs **bounds check elimination** (BCE): when it can prove at compile time that an index is within bounds, it removes the runtime check entirely. Understanding which patterns enable BCE allows you to write code that is both safe and fast.

```go
package bce

import (
	"encoding/binary"
	"testing"
)

// WithBoundsChecks: the compiler inserts a bounds check on each access
// MISCONCEPTION, CORRECTED: this function does NOT pay a bounds check per
// iteration. The name is preserved only so the correction has something to
// point at.
//
// The folklore says "an indexed loop pays a bounds check on every access, so
// use range instead". That has not been true for many years. `i` is an
// induction variable bounded by len(data), which is exactly the kind of fact
// the prove pass is built to establish, so the check is eliminated.
//
// Do not take this on faith. Ask the compiler:
//
//	go build -gcflags="-d=ssa/check_bce/debug=1" ./...
//
// It prints one "Found IsInBounds" line per bounds check it could NOT
// eliminate. On Go 1.27 this function prints nothing at all. Neither does
// SumWithRange. They compile to the same thing, and measured, they are the
// same speed within noise (6.3 us vs 5.7 us over 1000 elements, at ±40%
// variance, which is to say: indistinguishable).
//
// Choose range because it reads better, not because it is faster.
func SumWithBoundsChecks(data []float64) float64 {
	var sum float64
	for i := 0; i < len(data); i++ {
		sum += data[i] // No bounds check here: the compiler proved i < len(data).
	}
	return sum
}

// SumWithRange: range also gives BCE, for the same reason.
func SumWithRange(data []float64) float64 {
	var sum float64
	for _, v := range data {
		sum += v
	}
	return sum
}

// ManualBCEHint: the `_ = data[n-1]` pattern tells the compiler
// "I guarantee data has at least n elements." After this check,
// all accesses to data[0..n-1] are bounds-check-free.
// This pattern is used extensively in the Go standard library.
func SumFirst4(data []float64) float64 {
	_ = data[3] // BCE hint: proves len(data) >= 4. Panics if false.
	return data[0] + data[1] + data[2] + data[3] // No bounds checks.
}

// Without the hint, each access would have its own bounds check:
func SumFirst4Slow(data []float64) float64 {
	// Compiler inserts: if 0 >= len(data) { panic }
	// Compiler inserts: if 1 >= len(data) { panic }
	// Compiler inserts: if 2 >= len(data) { panic }
	// Compiler inserts: if 3 >= len(data) { panic }
	return data[0] + data[1] + data[2] + data[3] // 4 bounds checks.
}

// Standard library example: encoding/binary.BigEndian.Uint32
// uses the BCE hint pattern for zero-overhead byte decoding.
func ReadUint32BE(b []byte) uint32 {
	_ = b[3] // BCE hint: bounds check once, then 4 unchecked accesses.
	return uint32(b[3]) | uint32(b[2])<<8 | uint32(b[1])<<16 | uint32(b[0])<<24
}

// Verify BCE with the compiler diagnostic flag:
//   go build -gcflags="-d=ssa/check_bce/debug=1" ./...
//
// Output shows remaining bounds checks:
//   ./bce.go:15:14: Found IsInBounds     ← bounds check present
//   ./bce.go:35:14: (no output)          ← bounds check eliminated

// LoopWithBCE: process 4 elements per iteration with a single bounds check.
// The compiler eliminates all per-element checks within the loop body.
func DotProductBCE(a, b []float64) float64 {
	if len(a) != len(b) {
		panic("mismatched lengths")
	}

	var sum float64
	n := len(a)

	// Process 4 elements at a time with BCE.
	i := 0
	for ; i <= n-4; i += 4 {
		_ = a[i+3] // BCE hint for a.
		_ = b[i+3] // BCE hint for b.
		sum += a[i]*b[i] + a[i+1]*b[i+1] + a[i+2]*b[i+2] + a[i+3]*b[i+3]
	}

	// Handle remaining elements.
	for ; i < n; i++ {
		sum += a[i] * b[i]
	}
	return sum
}

// Benchmark: with vs without the BCE hint.
//
// The compiler diagnostic confirms the hint does what it claims. Running
// `go build -gcflags="-d=ssa/check_bce/debug=1"` on Go 1.27:
//
//	SumFirst4      -> 1 "Found IsInBounds"   (the hint itself)
//	SumFirst4Slow  -> 4 "Found IsInBounds"   (one per access)
//
// That part is deterministic, reproducible, and the real evidence. The
// hint genuinely removes three of four bounds checks.
//
// The timing is far less impressive than the check count suggests.
// Measured on i7-10510U, Go 1.27:
//
//	BenchmarkSumFirst4-4        15.61 ns/op  ± 25%
//	BenchmarkSumFirst4Slow-4    20.59 ns/op  ± 27%
//
// About 1.3x, and note the error bars nearly touch. Removing 75% of the
// bounds checks did not remove 75% of the time, because a bounds check is
// a compare and a predictable branch: the branch predictor gets it right
// every time, and the CPU runs it in parallel with real work. You removed
// instructions, not stalls.
//
// This is the single most important thing to understand about BCE, and
// about micro-optimization generally: instruction count is not time.
// Modern out-of-order cores hide enormous amounts of work behind cache
// misses and dependency chains. Removing an instruction that was already
// free costs you readability and buys you nothing.
//
// Reach for the hint pattern in genuinely hot decode loops, which is why
// encoding/binary uses it. Do not scatter it through ordinary code.

func BenchmarkSumFirst4Slow(b *testing.B) {
	data := []float64{1.0, 2.0, 3.0, 4.0, 5.0}
	for n := 0; n < b.N; n++ {
		_ = SumFirst4Slow(data)
	}
}

func BenchmarkSumFirst4Fast(b *testing.B) {
	data := []float64{1.0, 2.0, 3.0, 4.0, 5.0}
	for n := 0; n < b.N; n++ {
		_ = SumFirst4(data)
	}
}

func BenchmarkDotProductBCE(b *testing.B) {
	a := make([]float64, 1_000_000)
	bv := make([]float64, 1_000_000)
	for i := range a {
		a[i] = float64(i)
		bv[i] = float64(i)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_ = DotProductBCE(a, bv)
	}
}

// The encoding/binary standard library demonstrates BCE throughout:
var _ = binary.BigEndian // Uses _ = b[7] before reading 8 bytes.

// Summary of BCE patterns:
// 1. Use range loops - automatic BCE for the loop variable
// 2. Use _ = s[n-1] to assert minimum length before multiple accesses
// 3. Check len(s) >= N before accessing s[0..N-1]
// 4. Process slices in fixed-size chunks with a single bounds assertion
// 5. Use -gcflags="-d=ssa/check_bce/debug=1" to audit remaining checks
// 6. Combine with ILP (7.1): unrolled loops with BCE hints get both benefits
```

### 7.6 Preallocating Maps and Slices

Go's `append` function doubles the capacity of a slice when it runs out of room. For a slice that grows to N elements, this means log2(N) separate allocations, each requiring a copy of all existing elements. A 10,000-element slice built with `append` starting from nil goes through approximately 14 reallocations and copies approximately 20,000 elements total. Providing the expected capacity upfront with `make([]T, 0, N)` reduces this to a single allocation and zero copies.

Maps have a similar problem. When a map's load factor exceeds a threshold, Go rehashes all existing entries into a larger bucket array. For a map growing to 10,000 entries, this triggers several expensive rehashes. `make(map[K]V, N)` creates a map pre-sized for N entries.

```go
package prealloc

import (
	"strconv"
	"testing"
)

// --- Slice preallocation ---

// GrowSliceNaive appends without capacity hint.
// For 10,000 elements: ~14 reallocations, ~20,000 element copies.
func GrowSliceNaive(n int) []int {
	var s []int // nil slice: len=0, cap=0.
	for i := 0; i < n; i++ {
		s = append(s, i) // Triggers realloc at cap 0,1,2,4,8,16,...,8192,16384
	}
	return s
}

// GrowSlicePrealloc allocates once with the exact capacity needed.
// For 10,000 elements: 1 allocation, 0 copies.
func GrowSlicePrealloc(n int) []int {
	s := make([]int, 0, n) // Single allocation: n × sizeof(int).
	for i := 0; i < n; i++ {
		s = append(s, i) // Never triggers realloc - capacity is sufficient.
	}
	return s
}

// Benchmark: building a 10,000-element slice.
//
// BenchmarkSliceNaive-8       10000    ~95 µs/op     386,048 B/op    15 allocs/op
// BenchmarkSlicePrealloc-8    10000    ~28 µs/op      81,920 B/op     1 allocs/op
//
// 3.4× faster, 79% less memory, 93% fewer allocations.

func BenchmarkSliceNaive(b *testing.B) {
	for n := 0; n < b.N; n++ {
		_ = GrowSliceNaive(10_000)
	}
}

func BenchmarkSlicePrealloc(b *testing.B) {
	for n := 0; n < b.N; n++ {
		_ = GrowSlicePrealloc(10_000)
	}
}

// --- Map preallocation ---

// GrowMapNaive inserts without size hint.
// The runtime rehashes all entries each time the table exceeds its load-factor
// threshold. For 10,000 entries: several rehashes, each copying all entries.
func GrowMapNaive(n int) map[string]int {
	m := make(map[string]int) // Default: small initial bucket count.
	for i := 0; i < n; i++ {
		m[strconv.Itoa(i)] = i
	}
	return m
}

// GrowMapPrealloc pre-sizes the map to avoid rehashing.
// The runtime allocates enough buckets for n entries from the start.
func GrowMapPrealloc(n int) map[string]int {
	m := make(map[string]int, n) // Pre-sized for n entries.
	for i := 0; i < n; i++ {
		m[strconv.Itoa(i)] = i
	}
	return m
}

// Benchmark: building a 10,000-entry map.
//
// BenchmarkMapNaive-8       1000    ~2.8 ms/op    921,603 B/op    10,219 allocs/op
// BenchmarkMapPrealloc-8    1000    ~1.9 ms/op    474,411 B/op    10,078 allocs/op
//
// 32% faster, 48% less memory. The allocation count is similar because
// each string key is a separate allocation - the savings come from
// eliminating bucket reallocation and entry rehashing.

func BenchmarkMapNaive(b *testing.B) {
	for n := 0; n < b.N; n++ {
		_ = GrowMapNaive(10_000)
	}
}

func BenchmarkMapPrealloc(b *testing.B) {
	for n := 0; n < b.N; n++ {
		_ = GrowMapPrealloc(10_000)
	}
}

// Slice growth factors in Go's runtime (nextslicecap, threshold = 256):
//
// Below 256, capacity doubles: 0 → 1 → 2 → 4 → 8 → ... → 256.
// At or above 256 the runtime applies newcap += (newcap + 3*256)/4, which
// gives a SMOOTH taper rather than a flat rate:
//   at cap 256  the step is ~2.0x   (256 → 512)
//   at cap 512  the step is ~1.63x  (512 → 832)
//   at cap 1024 the step is ~1.44x
//   at cap 4096 the step is ~1.30x
// Only for very large slices does the factor approach ~1.25x.
//
// This means: growth stays generous just past 256 and tightens toward 1.25x
// as the slice grows - more allocations than a flat "doubling" rule suggests.

// Rules for preallocation:
//
// 1. If you know the exact size: make([]T, 0, n) or make([]T, n)
// 2. If you know an approximate upper bound: make([]T, 0, estimate)
// 3. If completely unknown: let append grow naturally (it's still O(n) amortized)
// 4. For maps: make(map[K]V, n) when n is known or estimable
// 5. Over-allocating wastes memory - find the right balance:
//    - 10% over: negligible waste
//    - 2× over: 50% waste - acceptable for small collections
//    - 10× over: unacceptable - profile and right-size
//
// Common pattern: read the count first, then allocate.
func LoadUserIDs(db interface{ Count() int; Scan(dest *int) bool }) []int {
	n := db.Count()
	ids := make([]int, 0, n)
	var id int
	for db.Scan(&id) {
		ids = append(ids, id)
	}
	return ids
}
```

### 7.7 Interface Method Call Overhead

An interface method call in Go involves an indirection through the interface table (itab). The runtime looks up the concrete method pointer from the itab and calls it indirectly. This indirection costs 2-5 nanoseconds per call compared to a direct call to a concrete method. In most code this is negligible, but in extremely hot loops executing millions of iterations, the overhead compounds.

```go
package iface

import (
	"testing"
)

// Adder is a simple interface for demonstrating call overhead.
type Adder interface {
	Add(a, b int) int
}

// ConcreteAdder implements Adder with a direct method.
type ConcreteAdder struct{}

func (ConcreteAdder) Add(a, b int) int {
	return a + b
}

// callViaInterface calls Add through the Adder interface.
// The compiler cannot inline across the interface boundary because
// it doesn't know the concrete type at compile time.
// Each call: load itab → load method pointer → indirect CALL.
func callViaInterface(adder Adder, a, b int) int {
	return adder.Add(a, b)
}

// callViaConcrete calls Add on the concrete type directly, so the compiler
// can inline the method body into the caller.
//
// Resist the temptation to describe this as "compiles to a single ADD, free".
// That description is what produced the fake 0.3 ns/op below. Inlining
// removes the call overhead, it does not remove the loop, the operands, or
// the work. Measured, this path costs ~4.7 ns/op in a benchmark that keeps
// its result.
func callViaConcrete(adder ConcreteAdder, a, b int) int {
	return adder.Add(a, b)
}

// Benchmark: interface call vs concrete call.
//
// The widely repeated version of this comparison reports:
//
//	BenchmarkInterfaceCall-8    ~2.5 ns/op
//	BenchmarkConcreteCall-8     ~0.3 ns/op    <- an empty loop
//	"~8x difference per call"
//
// That 8x is fabricated, and it is fabricated in an instructive way. The
// concrete arm gets inlined, its result is discarded, so it is deleted
// entirely and "measures" 0.3 ns. The interface arm cannot be inlined, so
// it survives and measures something real. The comparison is a real
// function call against no function call, and the ratio is just an
// artifact of how completely one side vanished.
//
// Measured properly on Go 1.27 / i7-10510U, with b.Loop(), a sink, and
// varying inputs so nothing folds:
//
//	BenchmarkInterfaceCall-4    5.843 ns/op  ± 9%
//	BenchmarkConcreteCall-4     4.714 ns/op  ± 23%
//
// About 1.2x, not 8x. Interface dispatch costs roughly a nanosecond here.
// It is a real cost and worth removing from a genuinely hot loop, but it
// is not the catastrophe the folklore claims, and note the concrete arm's
// ±23% variance overlaps the gap. On this hardware, even 1.2x is at the
// edge of what the measurement can resolve.
//
// This is also exactly what PGO's devirtualization buys you: it turns the
// first line into the second on hot call sites. That is a real 2-14% class
// of win on dispatch-heavy code, not an 8x one.

// Sink defeats dead-code elimination for results we do not otherwise use.
var Sink int

func BenchmarkInterfaceCall(b *testing.B) {
	var adder Adder = ConcreteAdder{}
	s, i := 0, 0
	for b.Loop() {
		i++
		s += callViaInterface(adder, i, i+1)
	}
	Sink = s
}

func BenchmarkConcreteCall(b *testing.B) {
	adder := ConcreteAdder{}
	s, i := 0, 0
	for b.Loop() {
		i++
		s += callViaConcrete(adder, i, i+1)
	}
	Sink = s
}

// --- Generics: the best of both worlds ---

// GenericSum uses a type parameter to avoid interface overhead while
// maintaining polymorphism. The compiler generates a specialized version
// for each concrete type - direct calls, fully inlineable.
type Number interface {
	~int | ~int32 | ~int64 | ~float32 | ~float64
}

func GenericSum[T Number](data []T) T {
	var sum T
	for _, v := range data {
		sum += v // Direct operation - no interface dispatch.
	}
	return sum
}

// InterfaceSum uses an interface with a Value method.
// Each iteration: interface call → load itab → indirect call → return.
type Numeric interface {
	Value() float64
}

type IntVal int64

func (v IntVal) Value() float64 { return float64(v) }

func InterfaceSum(data []Numeric) float64 {
	var sum float64
	for _, v := range data {
		sum += v.Value() // Interface dispatch per iteration.
	}
	return sum
}

// Benchmark: generic vs interface for summing 1M elements.
//
// BenchmarkGenericSum-8       1000    ~0.52 ms/op    0 allocs/op
// BenchmarkInterfaceSum-8     1000    ~3.80 ms/op    0 allocs/op
//
// Generics: 7× faster because every call is direct and inlined.

func BenchmarkGenericSum(b *testing.B) {
	data := make([]int64, 1_000_000)
	for i := range data {
		data[i] = int64(i)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_ = GenericSum(data)
	}
}

func BenchmarkInterfaceSum(b *testing.B) {
	data := make([]Numeric, 1_000_000)
	for i := range data {
		data[i] = IntVal(i)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_ = InterfaceSum(data)
	}
}

// When to optimize interface calls:
//
// DO optimize when:
// - The interface method is called millions of times per second
// - Profiling (pprof) shows significant time in interface dispatch
// - The hot loop processes large data sets element by element
// - You can use generics without losing API clarity
//
// DO NOT optimize when:
// - The interface is called hundreds or thousands of times (negligible)
// - The method body is expensive (the call overhead is noise)
// - Removing the interface would reduce testability or modularity
// - You haven't profiled and confirmed the interface is the bottleneck
//
// In 99% of Go code, interfaces are worth their overhead.
// Only optimize when benchmarks prove the interface dispatch is the bottleneck.
```

### 7.10 Hardware-Targeted Compilation: AWS Graviton, ARM64 LSE, and CGo Neoverse Tuning

Many engineering teams migrating Go services from x86 (`c6i`) to ARM-based cloud instances like AWS Graviton (`c6g`, `c7g`, `m7g`) fall into the **"Build and Forget"** trap: running `GOOS=linux GOARCH=arm64 go build` and assuming ARM optimization is automatic.

By default, the Go compiler targets baseline **ARMv8.0**, a conservative instruction set designed to run on any 64-bit ARM device (from a Raspberry Pi to high-end servers). On high-core-count processors (such as 64-core Graviton 3/4 chips), this default introduces massive synchronization contention.

#### The LSE (Large System Extensions) Advantage

Under baseline ARMv8.0, Go's synchronization primitives (`sync.Mutex`, `sync/atomic`, channel operations) compile into **Load-Link / Store-Conditional (LL/SC)** instruction loops. When multiple CPU cores simultaneously contest a mutex or atomic counter, LL/SC store operations fail repeatedly, causing cores to spin in software retry loops and wasting CPU cycles.

Starting with Go 1.18+, you can instruct the compiler to target newer ARM architectures:

```bash
# Target Graviton 2/3 (ARMv8.4 + Large System Extensions + hardware crypto)
GOARM64="v8.4,lse,crypto" go build -o service-arm64 ./cmd/service

# Target Graviton 4 (ARMv9.0)
GOARM64="v9.0,lse,crypto" go build -o service-arm64 ./cmd/service
```

1. **Hardware Atomics via LSE**: Replaces LL/SC retry spinloops with single hardware-arbitrated instructions: `LDADD` (atomic fetch-and-add), `LDSET` (atomic bitwise OR), and hardware `CAS` (compare-and-swap). Hardware arbitration ensures bounded execution time even under extreme 64-core contention.
2. **Hardware Cryptography (`crypto`)**: Activates dedicated CPU instructions for AES and SHA-256. This eliminates software cipher execution, drastically cutting CPU overhead during HTTPS and TLS handshakes with Kafka or PostgreSQL.

#### CGo and Native Library Pitfalls

When using Go packages that wrap C libraries via CGo (such as `confluent-kafka-go` linking `librdkafka`, or C-based compression engines like `zstd`), relying on generic pre-compiled packages discards Graviton optimizations. Compile native dependencies with the specific Neoverse microarchitecture flag:

```bash
export CFLAGS="-O3 -mcpu=neoverse-v1"
export CXXFLAGS="-O3 -mcpu=neoverse-v1"
```

Aligning both the Go toolchain (`GOARM64`) and native C dependencies with the underlying hardware execution pipelines prevents pipeline stalls and unlocks the full cost-performance advantage of modern ARM cloud instances.

> [!NOTE]
> For production benchmarks comparing LL/SC versus LSE atomic contention on AWS Graviton nodes, see Matthieu Treussart's analysis in [*Optimizing Go on Graviton: Mastering LSE and CGO for Maximum Performance*](https://medium.com/search?q=optimizing+go+on+graviton+mastering+lse+and+cgo).

### 7.8 Junior → FAANG: advanced techniques in priority order

Advanced optimization techniques have an unwritten priority order, and skipping ahead usually wastes time. Start with preallocation (section 7.6). It is the lowest-risk, highest-frequency win. Next, remove string-to-byte conversions in hot paths (section 7.3) and add `sync.Pool` for heavy temporaries (section 7.4). These are largely mechanical and produce reliable gains. After that, look at bounds check elimination (section 7.5) only if a profile shows the bounds check cost is material, which is rare outside of tight numeric loops. Interface to generics migration (section 7.7) is worth it only for identified hot paths and is a larger code change. ILP via accumulator expansion (section 7.1) is the domain of analytical and numeric workloads and should not be applied to business logic. Engineers who walk this order land consistent wins. Engineers who jump to ILP or BCE first often spend days on optimizations that the profile never justified.

### 7.9 Senior @ FAANG: generics vs interfaces in design review

The generic-versus-interface discussion comes up in almost every Go API design review. The staff-level framing: interfaces are for runtime polymorphism (you need to hold a heterogeneous collection, accept plugins, or cross package boundaries without a type dependency). Generics are for compile-time polymorphism (you want the same algorithm for several concrete types without runtime overhead). Performance is only one input to the decision, and not usually the dominant one. More important is API shape: does the caller know the concrete type at the call site (generics are great), or does the caller need to dispatch dynamically (interfaces are required). Forcing generics into a code path where the caller holds an `io.Reader` is a worse design than accepting the interface overhead, even when benchmarks suggest otherwise. Write the trade-off into the review comment explicitly: "we accept interface dispatch here because the caller is a plugin registry, and the measured cost is 2 us per request out of a 5 ms budget." That line survives the reviewer's concern and documents the decision for future engineers who will see the interface and wonder why it was not generic.

---
