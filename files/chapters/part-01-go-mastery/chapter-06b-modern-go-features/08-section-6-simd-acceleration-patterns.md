## Section 6: SIMD Acceleration Patterns

Go's stable surface does not expose SIMD intrinsics (an experimental `simd` package landed behind a GOEXPERIMENT in 1.26), but you can access SIMD today through assembly stubs, standard library functions with hand-tuned vector implementations, and `golang.org/x/sys/cpu` feature detection. One fact frames this whole section: the gc compiler does not auto-vectorize loops. Every SIMD instruction in a Go binary was hand-written by someone, either in the runtime, the standard library, or your own assembly.

### 6.1 SIMD via Assembly

Go supports SIMD acceleration through architecture-specific assembly stubs. The assembly file implements the hot path using vector instructions. A pure-Go fallback handles unsupported architectures.

```go
package simd

import (
	"bytes"

	"golang.org/x/sys/cpu"
)

// simd_amd64.s: assembly file (conceptual)
// TEXT ·SumFloat32s(SB),NOSPLIT,$0
//     // Load 8 floats at once using AVX2
//     VMOVUPS (SI), Y0    // Load 8 float32s
//     VADDPS Y0, Y1, Y1  // Add to accumulator
//     // ... loop

// Go wrapper for assembly function
// func SumFloat32s(data []float32) float32

// Pure Go fallback (scalar: the gc compiler does not auto-vectorize)
func SumFloat32sFallback(data []float32) float32 {
	var sum float32
	for _, v := range data {
		sum += v
	}
	return sum
}

// Batch string comparison: string equality compiles down to the
// runtime's memequal, which uses vectorized comparisons internally
func BatchContains(haystack []string, needle string) []int {
	var matches []int
	for i, s := range haystack {
		if s == needle {
			matches = append(matches, i)
		}
	}
	return matches
}

// XOR: this scalar loop is the portable reference. For production,
// crypto/subtle.XORBytes ships hand-written vector assembly.
func XORBytes(dst, src, key []byte) {
	keyLen := len(key)
	for i := range src {
		dst[i] = src[i] ^ key[i%keyLen]
	}
}

// Count specific bytes: prefer bytes.Count, whose assembly
// implementation processes many bytes per instruction
func CountByte(data []byte, target byte) int {
	return bytes.Count(data, []byte{target})
}

// Using golang.org/x/sys/cpu for CPU feature detection

type SIMDCapabilities struct {
	AVX2    bool
	AVX512  bool
	SSE42   bool
	NEON    bool // ARM
}

func DetectSIMD() SIMDCapabilities {
	return SIMDCapabilities{
		AVX2:   cpu.X86.HasAVX2,
		AVX512: cpu.X86.HasAVX512F,
		SSE42:  cpu.X86.HasSSE42,
		NEON:   cpu.ARM64.HasASIMD,
	}
}

// Dispatch to optimal implementation
type ByteProcessor struct {
	caps SIMDCapabilities
}

func NewByteProcessor() *ByteProcessor {
	return &ByteProcessor{caps: DetectSIMD()}
}

func (bp *ByteProcessor) Sum(data []byte) uint64 {
	// In real code: dispatch to assembly based on caps.
	// This scalar loop is the portable fallback.
	var sum uint64
	for _, b := range data {
		sum += uint64(b)
	}
	return sum
}

// String joining: the bulk copies inside bytes.Buffer go through the
// runtime's vectorized memmove. In real code, use strings.Join.
func JoinStrings(parts []string, sep string) string {
	var buf bytes.Buffer
	for i, p := range parts {
		if i > 0 {
			buf.WriteString(sep)
		}
		buf.WriteString(p)
	}
	return buf.String()
}
```

### 6.2 Go 1.27: Native arm64 NEON and the Portable simd Package

While Go 1.26 introduced the experimental `simd/archsimd` package strictly for amd64, **Go 1.27** expands direct native vector intrinsics to **arm64** (Apple Silicon M-series, AWS Graviton) and wasm, while introducing a top-level, vector-width-agnostic portable `simd` package.

#### Native arm64 NEON Vector Search Pattern

In search-heavy engines, binary search (`slices.BinarySearch`) causes erratic pointer jumping across cache lines. By structuring data into blocked 16-element nodes, Go 1.27's `archsimd.Int32x4` evaluates 16 comparisons in just 12 CPU instructions without register spills:

```go
// Go 1.27 native arm64 NEON ranking function
func rankNeon(node []int32, vx archsimd.Int32x4) int {
    n := (*[16]int32)(node)
    var acc archsimd.Int32x4

    // Less() emits a vector mask; ToInt32x4() converts true to -1.
    // Subtracting the mask adds 1 per lane without branches.
    acc = acc.Sub(archsimd.LoadInt32x4Array((*[4]int32)(n[0:4])).Less(vx).ToInt32x4())
    acc = acc.Sub(archsimd.LoadInt32x4Array((*[4]int32)(n[4:8])).Less(vx).ToInt32x4())
    acc = acc.Sub(archsimd.LoadInt32x4Array((*[4]int32)(n[8:12])).Less(vx).ToInt32x4())
    acc = acc.Sub(archsimd.LoadInt32x4Array((*[4]int32)(n[12:16])).Less(vx).ToInt32x4())

    // VADDV folds 4 vector lanes into a single scalar in one instruction
    return int(acc.ReduceSum())
}
```

#### Empirical Benchmark: 10 Million int32 Lower-Bound Lookups

Benchmarked on Apple M5 (10-core, 16 GB RAM, 40 MB dataset exceeding last-level cache):

| Implementation | Latency (ns/op) | Speedup vs `slices.BinarySearch` | Notes |
|---|---|---|---|
| `slices.BinarySearch` | 76.10 ns | 1.00x | 23 memory hops, 4 bytes used per 128B cache line |
| Branchless scalar (CSEL) | 49.77 ns | 1.53x | Eliminates branch mispredictions |
| Blocked layout + scalar loop | 88.69 ns | 0.86x | Slower than binary search without vector ops |
| Blocked layout + portable `simd` | 33.12 ns | 2.30x | Vector width abstracted at runtime |
| **Blocked layout + arm64 Neon** | **14.55 ns** | **5.23x** | Inlines fully; uses hardware `VADDV` horizontal fold |

#### What SIMD Actually Buys: Cache Bandwidth, Not Just Math

A standard binary search over 40 MB of integers hops across memory 23 times. Each hop hauls a full cache line from main RAM into L1/L2, reads a single 4-byte integer, and discards the rest. The blocked SIMD layout reduces the chain to 6 steps, and **every single byte of the 64-byte loaded cache line takes part in the parallel vector comparison**. The primary gain is cache efficiency and memory bandwidth preservation.

#### The 2.3x Portable Abstraction Tax

Notice the gap between portable `simd` (33.12 ns) and native `archsimd` (14.55 ns). The portable abstraction cannot emit architecture-specific horizontal reduction instructions like arm64's `VADDV`, requiring software fold loops. For maximum throughput on known server hardware (e.g. AWS Graviton4), target `simd/archsimd` directly.

> [!NOTE]
> For a full benchmark analysis and assembly disassembly of Go 1.27 vector lookups, see huizhou92's investigation [*Go 1.27 SIMD Benchmarked - Lookup Drops From 76 ns to 14.5 ns, and the Portable Package Costs 2.3x*](https://medium.com/@huizhou92/go-1-27-simd-benchmarked-lookup-drops-from-76-ns-to-14-5-ns-and-the-portable-package-costs-2-3x-7ec67ba27a69).

### Adoption Story

SIMD acceleration is the highest-effort, narrowest-applicability feature in this chapter. It is worth the cost only when:

1. **The workload is dominated by a single tight loop that processes bytes or numbers.** Examples: checksum calculation, compression, parsing wire-format binary data, cryptographic primitives, image processing.
2. **The standard library does not already cover it.** The free SIMD in a Go program lives in hand-tuned runtime and stdlib assembly (`bytes.IndexByte`, `bytes.Equal`, `bytes.Count`, memmove, the `crypto` packages), not in the compiler. Before reaching for your own assembly, check whether a stdlib call covers the hot path, and inspect what is actually emitted with `-gcflags="-S"`.
3. **Portability concerns are manageable.** Hand-written assembly is per-architecture. You write it for amd64, arm64, and sometimes specific micro-architectures. The maintenance cost compounds.

For the vast majority of services, the right answer is "use `bytes.Equal`, `bytes.IndexByte`, and similar standard library functions that already use SIMD internally, and move on". The exception is performance-critical libraries (Go's own `crypto` packages, `bytes`, `strings`, some third-party codec libraries) where hand-written SIMD assembly justifies the cost.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **Hand-written assembly for a hot path that has not been profiled.** Assembly is the last resort. Require pprof evidence that the Go version is the bottleneck.
2. **Missing CPU feature detection.** Assembly that assumes AVX2 without checking crashes on CPUs that do not support it. Always gate via `golang.org/x/sys/cpu`.
3. **Assembly that has diverged from the reference Go implementation.** Assembly and the fallback Go implementation must stay behaviorally identical. Test both, or the team silently ships two codepaths that produce different results.

### Migration Lens

Coming from C/C++, hand-written SIMD assembly is familiar territory, with the Go-specific note that Go's assembly dialect (Plan 9 syntax) is different from AT&T or Intel syntax. Coming from Rust, the portable SIMD API (`std::simd` or the `packed_simd` crate) is closer to what Go's experimental SIMD package is trying to build. Coming from higher-level languages, reaching for SIMD is almost never the right first move. Profile, and consider alternative algorithms before considering assembly.

---
