export default `## 10B.8 SIMD Operations (Go 1.26 Experimental)

### The simd Package

Go 1.26 introduces an experimental \`simd\` package (under \`GOEXPERIMENT=simd\`) providing portable SIMD vector operations. Currently amd64-only. Arm64 and other architectures are planned.

\`\`\`go
// Only available with GOEXPERIMENT=simd
// go build -gcflags="-GOEXPERIMENT=simd" ./...

import (
    "simd"
    "simd/archsimd"
)

// SIMD types (amd64):
// simd.Int8x16   - 16 int8 values in 128-bit register (SSE2)
// simd.Int16x8   - 8 int16 values in 128-bit register
// simd.Int32x4   - 4 int32 values in 128-bit register
// simd.Float32x4 - 4 float32 values in 128-bit register (SSE)
// simd.Float64x8 - 8 float64 values in 512-bit register (AVX-512)

// Example: SIMD-accelerated byte counting
func countByteSIMD(data []byte, target byte) int {
    count := 0
    tVec := simd.SplatInt8x16(int8(target))

    i := 0
    for ; i+16 <= len(data); i += 16 {
        chunk := simd.LoadInt8x16((*[16]int8)(data[i : i+16]))
        // Compare all 16 bytes simultaneously
        mask := simd.EqualInt8x16(chunk, tVec)
        // Count matching positions using popcount
        count += simd.PopCountMask(mask)
    }

    // Handle remaining bytes
    for ; i < len(data); i++ {
        if data[i] == target {
            count++
        }
    }

    return count
}

// Example: SIMD float32 dot product (ML inference)
func dotProductSIMD(a, b []float32) float32 {
    var sum simd.Float32x4

    i := 0
    for ; i+4 <= len(a); i += 4 {
        va := simd.LoadFloat32x4((*[4]float32)(a[i : i+4]))
        vb := simd.LoadFloat32x4((*[4]float32)(b[i : i+4]))
        sum = simd.AddFloat32x4(sum, simd.MulFloat32x4(va, vb))
    }

    // Horizontal sum of SIMD register
    result := simd.HAddFloat32x4(sum) // sum[0]+sum[1]+sum[2]+sum[3]

    // Handle remaining elements
    for ; i < len(a); i++ {
        result += a[i] * b[i]
    }

    return result
}
\`\`\`

### Use Cases for SIMD

SIMD acceleration yields the greatest benefit in throughput-oriented loops over contiguous memory: hashing, checksumming, base64 encoding, string searching, and vector arithmetic are common targets.

\`\`\`go
// 1. Batch string processing
func indexOfAnyBytesSIMD(s []byte, chars []byte) int {
    // Build 16-byte target vector from chars
    // Use SIMD compare to find first match position
    // ~4-8x faster than scalar for long strings
    _ = s
    _ = chars
    return -1 // placeholder
}

// 2. Crypto operations (hash, XOR)
func xorBlocksSIMD(dst, a, b []byte) {
    // XOR 16 bytes at a time using SIMD
    for i := 0; i+16 <= len(dst); i += 16 {
        va := simd.LoadInt8x16((*[16]int8)(a[i : i+16]))
        vb := simd.LoadInt8x16((*[16]int8)(b[i : i+16]))
        result := simd.XorInt8x16(va, vb)
        simd.StoreInt8x16((*[16]int8)(dst[i:i+16]), result)
    }
}

// 3. ML inference (embedding similarity)
func cosineSimilaritySIMD(a, b []float32) float32 {
    // Compute dot product + magnitudes using SIMD
    // Used in vector search for nearest neighbor computation
    dotProduct := dotProductSIMD(a, b)
    magA := magnitudeSIMD(a)
    magB := magnitudeSIMD(b)
    if magA == 0 || magB == 0 {
        return 0
    }
    return dotProduct / (magA * magB)
}
\`\`\`

### Current Limitations

The \`simd\` package is experimental and subject to breaking API changes. It currently targets amd64 only, so any code using it must include a scalar fallback for other architectures via build tags.

\`\`\`go
// GOEXPERIMENT=simd is still experimental in Go 1.26:
// - amd64 only (arm64 and other architectures not yet supported)
// - API may change in future releases
// - Not recommended for production code without careful testing
// - Fallback to scalar for unsupported architectures required

// Build tags for conditional SIMD:
//go:build amd64 && goexperiment.simd

package simdutil

func CountByte(data []byte, target byte) int {
    return countByteSIMD(data, target) // SIMD implementation
}
\`\`\`

The scalar fallback file uses a negated build constraint so the compiler selects it on any platform where the SIMD path does not apply. Both files define the same \`CountByte\` function signature in the same package, and the build system picks exactly one at compile time.

\`\`\`go
//go:build !amd64 || !goexperiment.simd

package simdutil

func CountByte(data []byte, target byte) int {
    count := 0
    for _, b := range data {
        if b == target {
            count++
        }
    }
    return count
}
\`\`\`

---
`;
