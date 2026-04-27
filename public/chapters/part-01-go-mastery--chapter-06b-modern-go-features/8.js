export default `## Section 6: SIMD Acceleration Patterns

Go does not expose SIMD intrinsics directly, but you can access them through assembly stubs, \`bytes\` package internals, and \`golang.org/x/sys\` feature detection.

### 6.1 SIMD via Assembly

Go supports SIMD acceleration through architecture-specific assembly stubs. The assembly file implements the hot path using vector instructions. A pure-Go fallback handles unsupported architectures.

\`\`\`go
package simd

// simd_amd64.s - Assembly file (conceptual)
// TEXT ·SumFloat32s(SB),NOSPLIT,\$0
//     // Load 8 floats at once using AVX2
//     VMOVUPS (SI), Y0    // Load 8 float32s
//     VADDPS Y0, Y1, Y1  // Add to accumulator
//     // ... loop

// Go wrapper for assembly function
// func SumFloat32s(data []float32) float32

// Pure Go fallback (compiler auto-vectorizes with optimization)
func SumFloat32sFallback(data []float32) float32 {
	var sum float32
	for _, v := range data {
		sum += v
	}
	return sum
}

// Batch string comparison - benefits from SIMD via bytes.Equal
func BatchContains(haystack []string, needle string) []int {
	var matches []int
	needleBytes := []byte(needle)
	for i, s := range haystack {
		if bytes.Equal([]byte(s), needleBytes) {
			matches = append(matches, i)
		}
	}
	return matches
}

// XOR encryption - compiler vectorizes this
func XORBytes(dst, src, key []byte) {
	keyLen := len(key)
	for i := range src {
		dst[i] = src[i] ^ key[i%keyLen]
	}
}

// Count specific bytes - highly vectorizable
func CountByte(data []byte, target byte) int {
	count := 0
	for _, b := range data {
		if b == target {
			count++
		}
	}
	return count
}

// Using golang.org/x/sys for CPU feature detection
import (
	"bytes"
	"golang.org/x/sys/cpu"
)

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
	// In real code: dispatch to assembly based on caps
	// For now: Go compiler will auto-vectorize this
	var sum uint64
	for _, b := range data {
		sum += uint64(b)
	}
	return sum
}

// String builder pattern - avoids allocations, SIMD-friendly
func JoinStrings(parts []string, sep string) string {
	// bytes.Buffer is SIMD-optimized internally
	var buf bytes.Buffer
	for i, p := range parts {
		if i > 0 {
			buf.WriteString(sep)
		}
		buf.WriteString(p)
	}
	return buf.String()
}
\`\`\`

### Adoption Story

SIMD acceleration is the highest-effort, narrowest-applicability feature in this chapter. It is worth the cost only when:

1. **The workload is dominated by a single tight loop that processes bytes or numbers.** Examples: checksum calculation, compression, parsing wire-format binary data, cryptographic primitives, image processing.
2. **The Go compiler's auto-vectorisation does not already catch it.** Modern Go emits SIMD instructions for many common patterns. Before reaching for assembly, run the benchmark with \`-gcflags="-S"\` to see what the compiler already emits.
3. **Portability concerns are manageable.** Hand-written assembly is per-architecture. You write it for amd64, arm64, and sometimes specific micro-architectures. The maintenance cost compounds.

For the vast majority of services, the right answer is "let the compiler vectorise, use \`bytes.Equal\`, \`bytes.IndexByte\`, and similar standard library functions that already use SIMD internally, and move on". The exception is performance-critical libraries (Go's own \`crypto\` packages, \`bytes\`, \`strings\`, some third-party codec libraries) where hand-written SIMD assembly justifies the cost.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **Hand-written assembly for a hot path that has not been profiled.** Assembly is the last resort. Require pprof evidence that the Go version is the bottleneck.
2. **Missing CPU feature detection.** Assembly that assumes AVX2 without checking crashes on CPUs that do not support it. Always gate via \`golang.org/x/sys/cpu\`.
3. **Assembly that has diverged from the reference Go implementation.** Assembly and the fallback Go implementation must stay behaviourally identical. Test both, or the team silently ships two codepaths that produce different results.

### Migration Lens

Coming from C/C++, hand-written SIMD assembly is familiar territory, with the Go-specific note that Go's assembly dialect (Plan 9 syntax) is different from AT&T or Intel syntax. Coming from Rust, the portable SIMD API (\`std::simd\` or the \`packed_simd\` crate) is closer to what Go's experimental SIMD package is trying to build. Coming from higher-level languages, reaching for SIMD is almost never the right first move. Profile, and consider alternative algorithms before considering assembly.

---
`;
