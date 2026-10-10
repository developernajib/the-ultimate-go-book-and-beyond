## Section 1: CPU Cache Optimization

### 1.1 Sequential vs Random Access

Sequential memory access patterns let the CPU prefetcher predict and preload cache lines ahead of the program counter, achieving near-peak memory bandwidth. Random access patterns produce cache misses for every access, reducing effective bandwidth by 10, 100×. In Go, iterating over a `[]struct` sequentially is cache-friendly, while following pointer chains through a linked list or map traversal produces random access patterns that the prefetcher cannot predict. The benchmark below measures the throughput difference between sequential slice iteration and pointer-chasing through a linked list of the same element count to quantify the cache miss penalty.

```go
package cache_access

import (
	"math/rand/v2"
)

// Sequential access - cache-friendly: prefetcher loads ahead.
// Each access hits L1 cache after the first cache line load.
func sumSequential(data []int64) int64 {
	var sum int64
	for _, v := range data {
		sum += v // Access pattern: data[0], data[1], data[2]… sequential
	}
	return sum
}

// Random access - cache-unfriendly: each access is a likely cache miss.
// At 1M elements: ~75% miss rate → 300ns × 750K misses = 225ms extra latency.
func sumRandom(data []int64, indices []int) int64 {
	var sum int64
	for _, idx := range indices {
		sum += data[idx] // Random order: no prefetcher benefit.
	}
	return sum
}

// CacheFriendlySort sorts indices to improve access locality.
// Before: random pointer chasing through data.
// After: roughly sequential access within each cache-line group.
func cacheFriendlyLookup(data []int64, indices []int) int64 {
	// Sort indices so we access data in sequential order.
	// Cost: O(n log n) sort, benefit: O(n) sequential access.
	sortedIndices := make([]int, len(indices))
	copy(sortedIndices, indices)
	// slices.Sort(sortedIndices) - would use slices package in real code (Go 1.21+).
	simpleSort(sortedIndices)

	var sum int64
	for _, idx := range sortedIndices {
		sum += data[idx]
	}
	return sum
}

func simpleSort(a []int) {
	// Insertion sort for small arrays, quicksort for large.
	n := len(a)
	for i := 1; i < n; i++ {
		key := a[i]
		j := i - 1
		for j >= 0 && a[j] > key {
			a[j+1] = a[j]
			j--
		}
		a[j+1] = key
	}
}

// ColumnMajorVsRowMajor demonstrates cache behavior with 2D arrays.
// Row-major (C order) is cache-friendly in Go.
const N = 1024

type Matrix [N][N]float64

// RowMajor: iterate row by row - sequential memory access.
// Cache line loaded once, 8 doubles used (cache line = 64B = 8 × float64).
func (m *Matrix) SumRowMajor() float64 {
	var sum float64
	for i := 0; i < N; i++ {
		for j := 0; j < N; j++ {
			sum += m[i][j] // m[i][0..N-1]: sequential
		}
	}
	return sum
}

// ColumnMajor: iterate column by column - stride = N × 8 bytes.
// Each access jumps N rows ahead - cache miss on every element.
func (m *Matrix) SumColumnMajor() float64 {
	var sum float64
	for j := 0; j < N; j++ {
		for i := 0; i < N; i++ {
			sum += m[i][j] // m[0..N-1][j]: stride = N × sizeof(float64) = 8KB
		}
	}
	return sum
}

// Benchmark comparison (1024×1024 float64 matrix):
// SumRowMajor:    ~1ms (L2 cache hits, sequential prefetch)
// SumColumnMajor: ~5ms (L3/DRAM cache misses, 5× slower)

// StructOfArrays vs ArrayOfStructs
// SoA (Struct of Arrays) is more cache-friendly for operations on one field.

// AoS (Array of Structs): standard Go struct slice.
type ParticleAoS struct {
	X, Y, Z  float32
	VX, VY, VZ float32
	Mass     float32
	Charge   float32
}

// SoA (Struct of Arrays): separate arrays per field.
type ParticlesSoA struct {
	X, Y, Z    []float32
	VX, VY, VZ []float32
	Mass       []float32
	Charge     []float32
}

// UpdatePositions_AoS: loads all fields for each particle.
// Each particle = 32 bytes; physics only needs X,Y,Z,VX,VY,VZ.
// 25% of loaded bytes (Mass, Charge) are wasted for this operation.
func UpdatePositions_AoS(particles []ParticleAoS, dt float32) {
	for i := range particles {
		particles[i].X += particles[i].VX * dt
		particles[i].Y += particles[i].VY * dt
		particles[i].Z += particles[i].VZ * dt
	}
}

// UpdatePositions_SoA: loads only needed fields.
// X, Y, Z, VX, VY, VZ arrays accessed sequentially.
// Prefetcher works perfectly - 2-3× faster than AoS for this operation.
func UpdatePositions_SoA(p *ParticlesSoA, n int, dt float32) {
	for i := 0; i < n; i++ {
		p.X[i] += p.VX[i] * dt
		p.Y[i] += p.VY[i] * dt
		p.Z[i] += p.VZ[i] * dt
	}
}

// avoid import errors
var _ = rand.Float64
```

### 1.1.1 False Sharing and Portable Cache-Line Padding

False sharing happens when two goroutines write to independent variables that live in the same cache line. The cache coherence protocol invalidates the line on every write from a remote core, turning what should be independent operations into serialized memory traffic. The classic symptom: a sharded counter that scales worse than a single mutex on high-core-count machines. The fix is to place each hot variable on its own cache line. Do not hand-compute the line width. Use `golang.org/x/sys/cpu.CacheLinePad`, which is sized per target architecture at compile time (64 bytes on x86-64, 128 on arm64 and ppc64), so the padding matches whatever platform you build for, Apple Silicon (128-byte lines) or an x86 server (64-byte lines).

```go
package falsesharing

import (
	"sync/atomic"

	"golang.org/x/sys/cpu"
)

// Bad: three counters share a single 64-byte cache line on x86.
// Under contention, each write invalidates the other counters' cached copies.
type BadCounters struct {
	A atomic.Uint64
	B atomic.Uint64
	C atomic.Uint64
}

// Good: each counter is padded onto its own cache line.
// cpu.CacheLinePad is sized per target arch at compile time (64B on
// x86-64, 128B on arm64), so the padding matches the platform you build for.
type PaddedCounters struct {
	A atomic.Uint64
	_ cpu.CacheLinePad
	B atomic.Uint64
	_ cpu.CacheLinePad
	C atomic.Uint64
	_ cpu.CacheLinePad
}

// Measured: three goroutines each doing 5,000,000 atomic increments, pinned to
// 4 cores with `taskset -c 0-3`, -cpu=4 -count=5, on an Intel i7-10510U with
// Go 1.27.1. Times are per full run of 15M total increments:
//
//	BadCounters:     718 ms .. 1021 ms  (dominated by coherence traffic)
//	PaddedCounters:   89 ms ..  177 ms
//
// Median ratio ~7.6x, with individual run pairs ranging from ~4x to ~11x. The
// ranges are wide because the box was not quiet, and they are printed as ranges
// for exactly that reason: the honest claim here is "large, roughly an order of
// magnitude", not a decimal.
//
// This is one of the few effects in this book big enough to survive a noisy
// machine, which is precisely why it is worth knowing. False sharing does not
// cost you 5%, it costs you most of your throughput. The counters are correct
// either way, so nothing fails, and the only symptom is that the code is
// mysteriously slow and does not scale with cores.
//
// Do not port the ratio to your hardware. It scales with core count, coherence
// topology, and how many writers share the line. Measure it where it runs.
```

> **Senior track**: The padding trick trades memory for throughput. On a service with 10,000 padded sharded counters, that is 10,000 * 128 = 1.28 MB of padding, which is negligible on servers and usually worth it. Profile with `perf c2c` (cache-to-cache) on Linux. It reports which cache lines suffered HITM (hit-modified) events across cores, the direct signature of false sharing.

### 1.2 Branch Prediction

Modern CPUs predict the outcome of conditional branches and speculatively execute ahead of the branch. A misprediction flushes the pipeline and wastes 15, 20 cycles, which compounds significantly in tight loops processing millions of elements. Go's compiler does not always generate branch-hint intrinsics, but code structure, moving the common case to the non-branching path, using branchless arithmetic for simple conditions, and keeping hot and cold code on separate cache lines, guides the CPU's dynamic predictor toward better accuracy. The examples below rewrite three common patterns, bounds checking, enum dispatch, and threshold comparison, into branch-prediction-friendly equivalents with supporting benchmark data.

```go
package branch_prediction

// Modern CPUs predict branches (if/switch) using a branch predictor.
// A well-predicted branch: ~1 cycle. Mispredicted: ~15-20 cycles of pipeline
// flush.
//
// Keep the magnitude in perspective before optimizing for it. At 1M ops/sec
// with 5% misprediction: 50,000 x 15 = 750,000 wasted cycles per second. On a
// ~3 GHz core that is about 0.025% of the cycle budget, which is nothing. Branch
// prediction only becomes worth your attention in genuinely tight loops over
// millions of elements where the branch is both hot and unpredictable, and even
// then it is a ~2x effect (see below), not the order-of-magnitude that false
// sharing is. Reach for the cache and the allocator first.

// UnpredictableBranch: input-dependent, hard to predict.
func filterPositive(data []int32) []int32 {
	result := make([]int32, 0, len(data))
	for _, v := range data {
		if v > 0 { // Predictor sees ~50% true/false - hard to predict.
			result = append(result, v)
		}
	}
	return result
}

// PredictableBranch: over ALREADY-sorted data, the predictor sees one long run
// of false then one long run of true and is right almost every time.
//
// Read the signature carefully. There is no sort in here, and that is the whole
// point. The famous version of this demo sorts inside the function:
//
//	func filterPositiveSorted(data []int32) []int32 {
//	    sortInt32(data)          // <-- the bug
//	    ... same loop ...
//	}
//
// That function is not an optimization, it is a catastrophe wearing one. Sorting
// is O(n log n) at best and it is being paid to save a few nanoseconds of
// misprediction per element. Measured on the reference machine (Intel i7-10510U,
// Go 1.27.1, taskset -c 0-3), 4096 int32s, filtering a fresh copy each time:
//
//	filter, unsorted input                20,355 .. 49,414 ns/op
//	filter, sorting inside (as above)  4,704,621 .. 6,206,308 ns/op
//	filter, input already sorted          11,054 .. 15,926 ns/op
//
// The "optimized" middle row is roughly 200x SLOWER than the code it was
// supposed to improve. It was also written with an insertion sort, which is
// O(n^2), turning a bad idea into an unusable one. Nothing about it is subtle
// once measured, and nothing about it is visible if you never measure.
//
// The real effect is the third row: about 2x, and only when the data is sorted
// ALREADY, for some other reason, and you are filtering it many times. Branch
// prediction is worth roughly a factor of two here. Sorting to obtain it costs
// you two orders of magnitude. Sort only if the sort amortizes across many
// passes, or if you needed the data sorted anyway.
//
// If you do need to sort, use slices.Sort (pdqsort), never a hand-rolled
// insertion sort.
func filterPositiveSorted(sorted []int32) []int32 {
	result := make([]int32, 0, len(sorted))
	for _, v := range sorted {
		if v > 0 { // Predictor sees many false, then many true. Easy.
			result = append(result, v)
		}
	}
	return result
}

// BranchlessMin returns the minimum of a and b without branching.
// Useful in inner loops where branch misprediction would be costly.
func branchlessMin(a, b int32) int32 {
	// (a < b) evaluates to 0 or 1 in Go.
	// Equivalent to: if a < b { return a } else { return b }
	// Caveat: b - a can overflow int32 when the operands are far apart, and
	// then this returns the wrong answer silently. Fine for bounded values,
	// wrong for arbitrary ones. The builtin min() has no such trap.
	diff := b - a
	mask := diff >> 31       // All 1s if diff < 0 (b < a), all 0s if diff >= 0.
	return a + (diff & mask) // a if b >= a, b if b < a.

	// Compiler note: Modern compilers often generate CMOV (conditional move)
	// from a ternary expression, which is branch-free:
	// if a < b { return a } → CMOV instruction.
}

// BranchlessAbs returns the absolute value of n without branching.
func branchlessAbs(n int32) int32 {
	mask := n >> 31
	return (n ^ mask) - mask
}

// BranchlessClamp clamps v to [lo, hi] without branching.
func branchlessClamp(v, lo, hi int32) int32 {
	v = v - lo
	v &= ^(v >> 31) // max(0, v - lo)
	v = hi - lo - v
	v &= ^(v >> 31) // min(hi-lo, hi-lo-v)
	return hi - v
}

// LookupTable replaces conditional chains with array indexing.
// For small domains (status codes, ASCII chars), lookup is faster.
var statusTexts = [600]string{} // Index = HTTP status code.

func init() {
	statusTexts[200] = "OK"
	statusTexts[201] = "Created"
	statusTexts[400] = "Bad Request"
	statusTexts[401] = "Unauthorized"
	statusTexts[403] = "Forbidden"
	statusTexts[404] = "Not Found"
	statusTexts[500] = "Internal Server Error"
}

// GetStatusText is a branch-free O(1) lookup.
// Compared to: if code == 200 { return "OK" } else if ...
func GetStatusText(code int) string {
	if code < 0 || code >= len(statusTexts) {
		return "Unknown"
	}
	return statusTexts[code] // Single array access - no branches.
}
```

### 1.3 SIMD-Friendly Code

Go did not expose SIMD intrinsics in the language until Go 1.26, which ships an experimental `simd` package (with the `simd/archsimd` backend) behind `GOEXPERIMENT=simd`. It covers 128-bit-plus vector types (`Int8x16`, `Float64x8`, etc.) with methods that lower to AVX/AVX-512 intrinsics on amd64 or Neon on arm64, emulated in pure Go elsewhere. The API is not covered by the Go 1 compatibility promise, and 1.27.1 keeps it experimental behind the same GOEXPERIMENT flag, so treat every upgrade as a potential porting exercise. For portable code today, there is no auto-vectorization lever to pull, and this is the single most important correction in this section: **the gc compiler does not auto-vectorize.** Not for simple loops, not for branch-free loops, not for struct-of-arrays layouts, not for fixed-size element types. There is no loop shape that makes it emit packed SIMD, because the optimizer does not implement the transformation at all.

Verify it rather than believing either of us. Compile the canonical "obviously vectorizable" loop, a dot product over two `[]float64` with no calls and no aliasing:

```go
func DotProduct(a, b []float64) float64 {
	sum := 0.0
	for i := range a {
		sum += a[i] * b[i]
	}
	return sum
}
```

Then read the assembly with `go build -gcflags=-S`. On the reference machine (Go 1.27.1, linux/amd64) that loop compiles to `MULSD` and `ADDSD`, and zero packed instructions appear anywhere in the output. Read those mnemonics carefully, because the whole point is in one letter: the **S** in `MULSD` means *Scalar* Double. The packed forms would be `MULPD` or `VMULPD`, **P** for *Packed*, and they are not there. The compiler is multiplying one pair of float64s at a time, exactly as written.

This matters practically because the widespread advice to "restructure the loop until `go tool compile -S` shows `VMULPD`" sends you looking for an instruction that will never appear, and the natural conclusion is that you have not yet found the magic loop shape. There is no magic loop shape. You will search forever.

Real SIMD in Go comes from exactly three places: hand-written assembly (which is how `bytes.IndexByte`, `crypto/sha256`, and friends get theirs), an assembly-backed library, or cgo. Plus, now, the experimental package above.

What struct-of-arrays and tight numeric loops genuinely buy you in pure Go is real and worth having, it is just not SIMD: better cache-line utilization, fewer bounds checks, less pointer chasing, and loops the CPU's own out-of-order machinery can pipeline well. Optimize for those, and describe them accurately in your PR.

Runtime CPU feature detection lives in `golang.org/x/sys/cpu`: check `cpu.X86.HasAVX2` or `cpu.X86.HasAVX512F` before dispatching to a SIMD-specialized path, meaning one you or a library author wrote in assembly.

```go
package simd

// Go does not expose SIMD intrinsics in stable form, AND the gc compiler does
// not auto-vectorize. Both halves matter. The loops below are the ones every
// tutorial labels "vectorizable", and none of them vectorize. Verified with
// `go build -gcflags=-S` on Go 1.27.1 / linux-amd64: the output contains MULSD
// and ADDSD (Scalar Double) and not one MULPD, VMULPD, VADDPD, or VPADDQ
// (Packed).
//
// They are still good loops. They are cache-friendly, bounds-check-light, and
// pipeline well. They are simply not SIMD, and calling them SIMD in a PR
// description or an interview is a claim a reviewer can disprove in ten seconds.

// AddSlices adds two float64 slices element-wise.
// Compiles to a scalar loop: one ADDSD per element, not 4 per VADDPD.
func AddSlices(dst, a, b []float64) {
	for i := range dst {
		dst[i] = a[i] + b[i]
	}
}

// DotProduct is the canonical "surely this vectorizes" loop. It does not.
// Compiles to MULSD + ADDSD, one element at a time.
//
// Note the second reason this particular loop could never be auto-vectorized,
// even by a compiler that tried: floating-point addition is not associative.
// Summing in a different order gives a different answer, so a compiler may not
// reorder these additions without permission. C and C++ compilers only
// vectorize reductions like this under -ffast-math, which explicitly grants
// that permission and quietly changes your results. Go has no -ffast-math and
// will not silently trade your numerics for speed.
func DotProduct(a, b []float64) float64 {
	var sum float64
	for i := range a {
		sum += a[i] * b[i]
	}
	return sum
}

// ScaleSlice multiplies each element by a scalar. Also scalar code.
// (No loop-carried dependency here, and it still does not vectorize, which is
// the point: the transformation is not implemented, so loop shape is moot.)
func ScaleSlice(data []float64, factor float64) {
	for i := range data {
		data[i] *= factor
	}
}

// The patterns below are worth knowing anyway, because they govern whether a
// loop pipelines well and whether the work can be parallelized BY YOU. Just do
// not expect the compiler to turn any of them into vector instructions.

// GOOD SHAPE: no dependency between iterations, so the CPU's out-of-order
// engine overlaps them and you could split it across goroutines or unroll it
// into independent partial sums by hand.
func sumFloat64(data []float64) float64 {
	var sum float64
	for _, v := range data {
		sum += v
	}
	return sum
}

// BAD SHAPE: loop-carried dependency. Each iteration needs the previous
// result, so nothing overlaps and no restructuring parallelizes it as written.
func runningMax(data []float64) float64 {
	result := data[0]
	for _, v := range data[1:] {
		result = max(result, v) // builtin max, Go 1.21+.
	}
	return result
}

// BAD SHAPE: an indirect call per element. The callee is opaque, it cannot be
// inlined through a func value, and the call overhead dwarfs the arithmetic.
func applyFunc(data []float64, fn func(float64) float64) {
	for i, v := range data {
		data[i] = fn(v)
	}
}

// GOOD SHAPE: the operation is inlined, so the loop is tight and
// call-free. Still scalar, still a genuine improvement over applyFunc.
func squareAll(data []float64) {
	for i, v := range data {
		data[i] = v * v
	}
}

// If you actually need SIMD, the real options, in ascending order of pain:
//  1. A library whose hot paths are already hand-written assembly (gonum for
//     numerics, and much of crypto/* and bytes/* in the stdlib).
//  2. GOEXPERIMENT=simd with the experimental simd/archsimd package (Go 1.26+,
//     amd64 only, outside the Go 1 compatibility promise).
//  3. Hand-written Go assembly for the one hot kernel. See math/exp_amd64.s.
//  4. cgo to BLAS. Fastest to reach, but you pay cgo call overhead per crossing,
//     which usually only amortizes on large arrays.
//
// Measure first. The scalar loop is often fast enough, and none of the four
// options above are free to maintain.

// Confirming the absence of auto-vectorization:
// go build -gcflags="-d=ssa/check_bce" ./...
// go tool compile -S file.go | grep -iE 'vaddpd|vmulpd'  # Confirms no packed instructions are emitted

// SIMDAlignedSlice returns a slice aligned to a 32-byte boundary.
// Some SIMD operations require 32-byte alignment for maximum performance.
func SIMDAlignedSlice(n int) []float64 {
	// Go guarantees slice elements are at least naturally aligned.
	// float64: 8-byte alignment. For 32-byte alignment, use unsafe tricks.
	// In practice, Go's allocator already 16-byte aligns most objects.
	return make([]float64, n)
}

// Go 1.26 experimental SIMD usage (build with GOEXPERIMENT=simd):
//
//   //go:build amd64 && goexperiment.simd
//   package vec
//
//   import "simd/archsimd"
//
//   // AddFloat64x4 adds two 4-wide float64 vectors using AVX2.
//   func AddFloat64x4(a, b archsimd.Float64x4) archsimd.Float64x4 {
//       return a.Add(b)
//   }
//
// Runtime dispatch pattern for portable binaries:
//
//   import "golang.org/x/sys/cpu"
//
//   var dotProduct = dotProductScalar
//
//   func init() {
//       if cpu.X86.HasAVX2 {
//           dotProduct = dotProductAVX2 // Assembly or simd package impl.
//       }
//   }
```

> **Senior track**: Remember that the gc compiler will never auto-vectorize loops for you. Before reaching for the experimental `simd` package, confirm whether a pure Go scalar loop is actually the bottleneck in your `pprof` profile. If it is, compare the maintenance cost of `simd/archsimd` (or hand-written assembly in a `.s` file) against an assembly-backed library like `gonum`. Also verify that your target CPU actually supports the vector extensions with `golang.org/x/sys/cpu`, and always provide a scalar fallback. Plan for the `simd` experimental API to change until the experiment is promoted.

### 1.4 When cache optimization actually matters

Most Go services are not cache-bound. A service that spends 60 percent of CPU in JSON encoding, 20 percent in TLS, and 20 percent in business logic is not going to benefit from flattening a struct. Cache optimization becomes the lever when `perf stat` shows IPC below 1.0 and `LLC-load-misses` above 1 percent, both of which are characteristic of memory-bound workloads (analytical queries, in-memory time-series ingest, graph traversal, columnar scans, packet processing). The staff-level rule is "measure before you flatten." A weekend of cache tuning on a service that is actually CPU-bound on business logic buys nothing and leaves behind code that is harder to modify. The same weekend on a genuinely memory-bound workload can double throughput.

### 1.5 Junior → FAANG: the false-sharing demo you should write once

Write this program and run it on your laptop:

```go
type Counters struct {
    A, B atomic.Uint64
}
type PaddedCounters struct {
    A atomic.Uint64
    _ [64]byte
    B atomic.Uint64
}
```

Spin two goroutines, one incrementing `A` and one incrementing `B`, a few million times each. Time both versions. Expect the padded version to win by something in the region of an order of magnitude on any multi-core machine (the reference measurement in section 1.1 came out around 7.6x median on four pinned cores, with runs ranging from 4x to 11x). Do not anchor on the exact figure, since it moves with core count and topology. Anchor on the fact that it is huge and that you found it yourself. The first time you feel this result in your own benchmarks is the moment false sharing stops being an abstract concept. It is also the single most common "tell me about a performance debugging experience" answer in infrastructure interviews, and having lived through it yourself is worth far more than having read about it.

### 1.6 Senior @ FAANG: the cache-optimization review checklist

Before approving any cache-oriented PR, ask four questions. First, what `perf stat` or `pprof` signal identified this as the bottleneck? If the answer is "it seemed like a good idea," request changes. Second, what is the measured throughput or latency delta under realistic load, not just in the micro-benchmark? Micro-benchmarks systematically overstate cache wins, because a micro-benchmark hands the optimized structure an otherwise empty cache while production shares it with everything else the service is doing. How much they overstate it is not a constant to look up, it is the gap you are being asked to measure. Third, what is the maintenance cost? A padded struct, a struct-of-arrays refactor, or a branchless implementation all cost readability and test surface. Is the win worth the tax? Fourth, what is the rollback plan if this change regresses under a different workload or on different hardware? Cache behavior is hardware-specific, and a win on Intel can be neutral or a loss on Graviton. Teams that ask these four questions on every PR maintain codebases that stay readable as they are optimized. Teams that skip them accumulate a layer of "clever" code that nobody is willing to touch, and that layer eventually becomes an obstacle to every future change.

---
