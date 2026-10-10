## Memory Coalescing and GPU Optimization

A kernel that correctly computes the wrong answer is obviously broken. A kernel that correctly computes the right answer but runs at 5% of peak throughput is a more insidious problem, and the usual culprit is uncoalesced memory access. Understanding the GPU memory access model is the difference between using a GPU and actually programming one.

### Global Memory Coalescing

A warp executes 32 threads simultaneously. When those 32 threads access global memory, the hardware can consolidate accesses into a minimal number of cache line transactions, but only if the addresses are contiguous and aligned.

The coalescing rule: **if the 32 threads of a warp access 32 consecutive 4-byte words aligned to a 128-byte boundary, they issue a single 128-byte transaction**. Otherwise, the accesses are split into multiple transactions.

```cpp
// COALESCED: thread i accesses element i
// Threads 0-31 access addresses 0,4,8,...,124 → ONE 128-byte transaction
__global__ void coalesced(const float* data, float* out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) out[i] = data[i] * 2.0f;
}

// UNCOALESCED: thread i accesses element i*STRIDE
// Threads 0-31 access addresses 0,128,256,...,3968 → 32 separate transactions
__global__ void strided(const float* data, float* out, int n, int stride) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int src = i * stride;
    if (src < n) out[i] = data[src] * 2.0f;
}
```

The strided kernel with stride=32 runs roughly 32× slower on global memory throughput, not 32× slower overall, but the memory bottleneck increases 32×. On an A100, coalesced access achieves ~1.9 TB/s. Uncoalesced random access can drop to ~60 GB/s.

### AoS vs SoA: The Data Layout Decision

GPU programmers constantly face a fundamental layout choice. Consider a particle simulation:

```cpp
// Array of Structures (AoS), natural for CPU, terrible for GPU
struct Particle {
    float x, y, z;    // position
    float vx, vy, vz; // velocity
    float mass;
    float charge;     // 8 floats = 32 bytes per particle
};
Particle particles[N];  // particles[0].x, particles[0].y, ..., particles[1].x, ...

// When a warp updates only 'x':
// Thread 0 → particles[0].x  (address 0)
// Thread 1 → particles[1].x  (address 32)
// Thread 2 → particles[2].x  (address 64)
// Stride = 32 bytes = 8 floats → 8 transactions per warp access

// Structure of Arrays (SoA), ideal for GPU SIMD
struct ParticlesSoA {
    float* x;      // all x positions contiguous
    float* y;
    float* z;
    float* vx;
    float* vy;
    float* vz;
    float* mass;
    float* charge;
};

// When a warp updates only 'x':
// Thread 0 → x[0]  (address 0)
// Thread 1 → x[1]  (address 4)
// Thread 2 → x[2]  (address 8)
// Stride = 4 bytes → ONE transaction per warp access ✓
```

The SoA layout achieves 8× better memory bandwidth for this workload. For kernels that access all fields per thread (e.g., full physics update), AoS and SoA perform similarly. For kernels that access a subset of fields (common in ML pipelines), SoA wins decisively.

### Occupancy: Keeping the SM Busy

**Occupancy** is the ratio of active warps to the maximum number of warps an SM can hold. High occupancy enables the SM to hide memory latency by switching between warps while one warp waits for data.

Three hardware limits constrain occupancy simultaneously:

1. **Registers**: each SM has 65,536 registers. A kernel using 64 registers per thread allows `65536 / 64 = 1024` threads (32 warps) per SM
2. **Shared memory**: 48KB per SM. A kernel using 12KB of shared memory allows only 4 blocks per SM
3. **Block size**: maximum 1024 threads per block. Maximum 16-32 blocks per SM

```cpp
// Query occupancy at runtime
#include <cuda_runtime.h>

void print_occupancy_info() {
    int block_size, min_grid_size;
    cudaOccupancyMaxPotentialBlockSize(&min_grid_size, &block_size,
                                       tiled_gemm, 0, 0);
    printf("Recommended block size: %d\n", block_size);
    printf("Minimum grid size for full occupancy: %d\n", min_grid_size);

    // For a specific block size, compute achieved occupancy
    int max_blocks_per_sm;
    cudaOccupancyMaxActiveBlocksPerMultiprocessor(&max_blocks_per_sm,
                                                   tiled_gemm, 256, 0);
    int device;
    cudaGetDevice(&device);
    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device);

    float occupancy = (max_blocks_per_sm * 256.0f) /
                      prop.maxThreadsPerMultiProcessor;
    printf("Achieved occupancy: %.1f%%\n", occupancy * 100.0f);
}
```

**Occupancy is not always the bottleneck.** A compute-bound kernel using tensor cores can achieve 100% efficiency at 50% occupancy. Nsight Compute's "Warp State Statistics" shows the real cause of stalls: is it memory latency, compute throughput, or synchronization?

### The Roofline Model

The roofline model gives you a principled answer to "why is my kernel slow?":

```
Peak Performance (TFLOPS)
        │         /
        │       /  compute-bound region
        │     /
        │   /
        │ /
        │/ ─── memory-bound region
        └──────────────────────────
                 Arithmetic Intensity (FLOP/byte)
```

**Arithmetic intensity (AI)** = FLOPs per byte of global memory traffic.

- Vector addition (C = A + B): 1 FLOP, 12 bytes → AI = 0.083 FLOP/byte. Deeply memory-bound.
- Dense matrix multiply (FP32, N×N): 2N³ FLOPs, 3N² × 4 bytes → AI = N/6 FLOP/byte. For N=4096: AI = 682 FLOP/byte. Compute-bound.
- Transformer attention (n_seq, d_model): intermediate between the two.

On an A100: peak FP32 = 19.5 TFLOPS, peak memory bandwidth = 2 TB/s. The ridge point (transition from memory-bound to compute-bound) is at AI = 19,500 / 2,000 = **9.75 FLOP/byte**. Any kernel with AI below ~10 is memory-bound. Optimizing compute won't help.

### L2 Cache Residency (Ampere and Later)

Ampere introduced `cudaAccessPolicyWindow`, allowing you to specify that a region of GPU memory should be preferentially retained in L2 (which is up to 40MB on A100):

```cpp
// Pin a frequently accessed lookup table in L2
cudaStreamAttrValue stream_attr;
stream_attr.accessPolicyWindow.base_ptr  = d_embedding_table;
stream_attr.accessPolicyWindow.num_bytes = embedding_table_bytes;
stream_attr.accessPolicyWindow.hitRatio  = 1.0f;  // Try to keep 100% in L2
stream_attr.accessPolicyWindow.hitProp   = cudaAccessPropertyPersisting;
stream_attr.accessPolicyWindow.missProp  = cudaAccessPropertyStreaming;

cudaStreamSetAttribute(stream, cudaStreamAttributeAccessPolicyWindow,
                       &stream_attr);
// Now kernel launches in this stream will preferentially L2-cache that region
```

For embedding lookups (random access to a table that fits in L2), this can improve effective bandwidth 3-5× by avoiding repeated DRAM fetches.

### Tensor Cores: Mixed-Precision Matrix Multiply

Tensor Cores perform a 16×16×16 mixed-precision matrix multiply in a single warp-level instruction. On A100, tensor cores deliver 312 TFLOPS of FP16 throughput vs 19.5 TFLOPS scalar FP32, a 16× difference.

```cpp
#include <mma.h>  // WMMA API (Warp Matrix Multiply-Accumulate)
using namespace nvcuda::wmma;

// Fragment types
fragment<matrix_a, 16, 16, 16, half, row_major> a_frag;
fragment<matrix_b, 16, 16, 16, half, col_major> b_frag;
fragment<accumulator, 16, 16, 16, float>        c_frag;

__global__ void tensor_core_gemm(const half* A, const half* B,
                                  float* C, int M, int N, int K) {
    // Each warp handles one 16×16 output tile
    int warp_row = (blockIdx.y * blockDim.y + threadIdx.y) / 32 * 16;
    int warp_col =  blockIdx.x * 16;

    fill_fragment(c_frag, 0.0f);

    for (int k = 0; k < K; k += 16) {
        // Load 16×16 tiles into warp-distributed fragments
        load_matrix_sync(a_frag, A + warp_row * K + k, K);
        load_matrix_sync(b_frag, B + k * N + warp_col, N);

        // Tensor core WMMA: c_frag += a_frag × b_frag
        mma_sync(c_frag, a_frag, b_frag, c_frag);
    }

    store_matrix_sync(C + warp_row * N + warp_col, c_frag, N, mem_row_major);
}
// Compile: nvcc -arch=sm_80 --ptxas-options=-v (check register usage)
```

For production tensor core code, use cuBLAS `cublasGemmEx` or cuDNN, they hand-tune tiling, pipelining, and register allocation to approach peak tensor core throughput.

### Optimization Checklist

When a kernel is underperforming, work through this checklist in order:

1. **Coalesce global memory access**, verify stride-1 access pattern for the warp
2. **Check occupancy**, use `cudaOccupancyMaxPotentialBlockSize`, target >50%
3. **Use shared memory for reuse**, if the same data is read >1× per block, tile it
4. **Avoid bank conflicts**, pad shared arrays, check Nsight for conflict counts
5. **Minimize warp divergence**, restructure branches so warps don't split
6. **Use tensor cores**, convert to FP16 inputs if precision allows
7. **Pin hot data in L2**, use `cudaAccessPolicyWindow` for repeated random reads
8. **Overlap compute and transfer**, use multiple streams, async memcpy, pinned memory
9. **Profile, then optimize.** Nsight Compute's "Top Stalls" tells you what actually limits performance

---
