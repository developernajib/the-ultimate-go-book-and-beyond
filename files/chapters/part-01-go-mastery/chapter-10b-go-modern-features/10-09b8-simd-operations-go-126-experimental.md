## 10B.8 SIMD Operations (Go 1.26 Experimental)

### The simd Package

Go 1.26 introduces `simd/archsimd`: arch-specific SIMD intrinsics (amd64) under `GOEXPERIMENT=simd`. Go 1.27 adds the portable `simd` package under the same experiment flag: vector-size-agnostic types (`Uint8s`, `Float32s`, ...) that compile to hardware vectors on amd64 and arm64 and emulate in pure Go elsewhere. The vector length is always at least 128 bits and is uniform within one program execution, so portable code sizes its stride from the vector itself, never from a constant.

```go
// Only available with GOEXPERIMENT=simd (an environment variable, not a flag):
// GOEXPERIMENT=simd go build ./...

import "simd"

// Portable vector types (1.27, method-based API):
// simd.Uint8s    : N uint8 lanes, N from v.Len(), at least 16
// simd.Float32s  : N float32 lanes, at least 4
// Constructors: simd.LoadUint8s(s), simd.BroadcastUint8s(x)
// Masks: v.Equal(w) returns simd.Mask8s, counted via ToInt8s plus Store

// Example: SIMD-accelerated byte counting
func countByteSIMD(data []byte, target byte) int {
    tVec := simd.BroadcastUint8s(target)
    n := tVec.Len()
    lanes := make([]int8, n)
    count := 0

    i := 0
    for ; i+n <= len(data); i += n {
        chunk := simd.LoadUint8s(data[i : i+n])
        // Compare all lanes simultaneously, -1 marks a match
        match := chunk.Equal(tVec).ToInt8s()
        match.Store(lanes)
        for _, lane := range lanes {
            if lane != 0 {
                count++
            }
        }
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
    var sum simd.Float32s
    n := sum.Len()
    partial := make([]float32, n)

    i := 0
    for ; i+n <= len(a); i += n {
        va := simd.LoadFloat32s(a[i : i+n])
        vb := simd.LoadFloat32s(b[i : i+n])
        sum = sum.MulAdd(va, vb)
    }

    // Horizontal sum through a scalar store
    sum.Store(partial)
    var result float32
    for _, v := range partial {
        result += v
    }

    // Handle remaining elements
    for ; i < len(a); i++ {
        result += a[i] * b[i]
    }

    return result
}
```

### Use Cases for SIMD

SIMD acceleration yields the greatest benefit in throughput-oriented loops over contiguous memory: hashing, checksumming, base64 encoding, string searching, and vector arithmetic are common targets.

```go
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
    var probe simd.Uint8s
    n := probe.Len()
    // XOR n bytes at a time using SIMD
    for i := 0; i+n <= len(dst); i += n {
        va := simd.LoadUint8s(a[i : i+n])
        vb := simd.LoadUint8s(b[i : i+n])
        va.Xor(vb).Store(dst[i : i+n])
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
```

### Current Limitations

The portable `simd` package is experimental and subject to breaking API changes. It uses hardware vectors where the toolchain supports them and emulates elsewhere, so portable code needs no architecture build tags, only the experiment gate. Keep a scalar path for toolchains without the experiment:

```go
// GOEXPERIMENT=simd gates the portable package:
// - Hardware vectors on amd64 and arm64, emulation elsewhere
// - API may change in future releases
// - Not recommended for production code without careful testing

// Build tags for conditional SIMD:
//go:build goexperiment.simd

package simdutil

func CountByte(data []byte, target byte) int {
    return countByteSIMD(data, target) // SIMD implementation
}
```

The scalar fallback file uses a negated build constraint so the compiler selects it on any toolchain where the experiment is off. Both files define the same `CountByte` function signature in the same package, and the build system picks exactly one at compile time.

```go
//go:build !goexperiment.simd

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
```

---
