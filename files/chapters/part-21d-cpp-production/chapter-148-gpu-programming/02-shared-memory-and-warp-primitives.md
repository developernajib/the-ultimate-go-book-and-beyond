## Shared Memory and Warp-Level Primitives

Global memory on an A100 delivers around 2 TB/s, an impressive number until you compare it to the 19 TB/s peak bandwidth of on-chip shared memory. Shared memory is the fast SRAM attached to each Streaming Multiprocessor. It is 50-100× faster than DRAM and is the single most impactful optimization knob available to CUDA programmers. The catch: it must be managed manually, and it is only 48KB per SM (configurable between 0 and 164KB on Hopper, splitting with L1).

### What Shared Memory Is

The memory hierarchy diagram shows that shared memory / L1 cache sits on-chip within each SM and delivers ~19 TB/s bandwidth, versus global (device) memory at ~2 TB/s with ~100-cycle latency. Tiling algorithms load a block's worth of global memory into shared memory once, then have all threads in the block read from shared memory repeatedly, converting multiple slow global reads into one global read plus many fast on-chip reads.
```
  Streaming Multiprocessor (SM)
  ┌─────────────────────────────────────────────┐
  │  Registers (65,536 × 32-bit per SM)         │
  │  Shared Memory / L1 Cache (48-164 KB)       │ ← on-chip, ~19 TB/s
  │  L2 Cache (shared, ~40MB on A100)           │  ← on-chip, ~5 TB/s
  │                                             │
  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
  │  │Warp 0│ │Warp 1│ │Warp 2│ │...   │        │
  │  └──────┘ └──────┘ └──────┘ └──────┘        │
  └─────────────────────────────────────────────┘
            │ accesses │
  ┌─────────────────────────────────────────────┐
  │           HBM2e (Global Memory, 80GB)       │  ← off-chip, ~2 TB/s
  └─────────────────────────────────────────────┘
```

Shared memory is declared with the `__shared__` qualifier. All threads within a block see the same shared memory region. It persists for the lifetime of the block, then is released for reuse.

```cpp
__global__ void example() {
    // Static shared memory, size known at compile time
    __shared__ float smem[256];

    // Dynamic shared memory, size specified at launch time
    extern __shared__ float dyn_smem[];  // launched with <<<grid, block, bytes>>>

    smem[threadIdx.x] = threadIdx.x * 2.0f;
    __syncthreads();  // All threads must reach this before any can proceed
    float val = smem[(threadIdx.x + 1) % 256];  // Read neighbor's value
}
```

`__syncthreads()` is a block-wide barrier. Every thread in the block must reach it before any thread can proceed past it. Missing a `__syncthreads()` where one is needed produces race conditions. Inserting one inside a divergent branch produces deadlock.

### Tiled Matrix Multiplication

Matrix multiplication is the canonical shared memory example. Naïve GEMM reads each element of A and B O(N) times from slow global memory. Tiled GEMM loads a tile into shared memory once and reuses it O(TILE_SIZE) times.

```cpp
#include <cuda_runtime.h>
#include <cstdio>

constexpr int TILE = 32;  // 32×32 = 1024 threads per block, fits one warp grid

// C = A × B  (M×K @ K×N → M×N)
__global__ void tiled_gemm(const float* __restrict__ A,
                           const float* __restrict__ B,
                           float* __restrict__ C,
                           int M, int N, int K) {
    // Shared memory tiles for A and B
    __shared__ float tileA[TILE][TILE];
    __shared__ float tileB[TILE][TILE];

    int row = blockIdx.y * TILE + threadIdx.y;
    int col = blockIdx.x * TILE + threadIdx.x;

    float acc = 0.0f;

    // Step through tiles along the K dimension
    int num_tiles = (K + TILE - 1) / TILE;

    for (int t = 0; t < num_tiles; ++t) {
        // Each thread loads one element of tileA and one element of tileB
        int a_col = t * TILE + threadIdx.x;
        int b_row = t * TILE + threadIdx.y;

        tileA[threadIdx.y][threadIdx.x] = (row < M && a_col < K)
            ? A[row * K + a_col] : 0.0f;

        tileB[threadIdx.y][threadIdx.x] = (b_row < K && col < N)
            ? B[b_row * N + col] : 0.0f;

        // Wait for all threads to finish loading the tile
        __syncthreads();

        // Multiply this tile
        #pragma unroll
        for (int k = 0; k < TILE; ++k) {
            acc += tileA[threadIdx.y][k] * tileB[k][threadIdx.x];
        }

        // Wait before loading the next tile (don't let fast threads overwrite
        // shared memory while slow threads are still reading it)
        __syncthreads();
    }

    if (row < M && col < N) {
        C[row * N + col] = acc;
    }
}

// Launch: dim3 block(TILE, TILE); dim3 grid((N+TILE-1)/TILE, (M+TILE-1)/TILE);
// tiled_gemm<<<grid, block>>>(d_A, d_B, d_C, M, N, K);
```

For a 4096×4096 matrix multiply, each element of A is loaded TILE=32 times instead of 4096 times, a 128× reduction in global memory traffic. This is what takes a kernel from memory-bound to compute-bound.

### Bank Conflicts

Shared memory is organized into **32 banks** (one per warp lane), each 4 bytes wide. Bank number for a float at address `addr` is `(addr / 4) % 32`. When two threads in the same warp access the same bank simultaneously, the accesses **serialize**, a bank conflict.

```cpp
// BAD: column-major access of a row-major array
// Thread 0 accesses smem[0][0], thread 1 accesses smem[1][0], etc.
// smem[0][0] is bank 0, smem[1][0] is bank 32%32=0 → BANK CONFLICT
__shared__ float smem[32][32];
float val = smem[threadIdx.x][0];  // All threads hit bank 0: 32-way conflict!

// GOOD: row-major access, consecutive banks
float val2 = smem[0][threadIdx.x]; // Thread i hits bank i: no conflict

// BEST PRACTICE: pad the shared array by 1 to rotate bank assignments
__shared__ float smem_padded[32][33];  // Note: 33 not 32
// smem_padded[r][c] is at offset r*33 + c
// smem_padded[0][c]: bank = (0*33 + c) % 32 = c % 32  → bank c
// smem_padded[1][c]: bank = (1*33 + c) % 32 = (33+c) % 32 = (1+c) % 32
// Rows are offset by 1 bank, eliminating column-access conflicts
```

Bank conflicts show up clearly in Nsight Compute as "shared memory bank conflicts per access". Even a 2-way conflict halves shared memory bandwidth. In the tiled GEMM above, accessing `tileB[k][threadIdx.x]` is safe (consecutive threads hit consecutive banks), but `tileA[threadIdx.y][k]` is also safe because k is a loop variable, not a thread index.

### Warp-Level Primitives

Starting with Volta (sm_70), CUDA provides **warp-level intrinsics** that allow threads within a warp to exchange data directly through registers, no shared memory needed, no `__syncthreads()` required. These are faster than shared memory for warp-scoped operations.

All warp primitives take a **mask** parameter specifying which threads participate. Always pass `0xffffffff` for a full warp.

```cpp
// __shfl_down_sync: each thread gets the value from the thread `delta` lanes ahead
// Used to implement warp-wide reduction without shared memory
__device__ float warp_reduce_sum(float val) {
    // Butterfly reduction: combine pairs at distance 16, 8, 4, 2, 1
    val += __shfl_down_sync(0xffffffff, val, 16);
    val += __shfl_down_sync(0xffffffff, val, 8);
    val += __shfl_down_sync(0xffffffff, val, 4);
    val += __shfl_down_sync(0xffffffff, val, 2);
    val += __shfl_down_sync(0xffffffff, val, 1);
    // Thread 0 now holds the sum of all 32 lanes
    return val;
}

// __shfl_sync: broadcast lane 0's value to all threads
__device__ float broadcast_from_lane0(float val) {
    return __shfl_sync(0xffffffff, val, 0);
}

// __shfl_xor_sync: exchange with XOR partner, useful for parallel prefix
__device__ float warp_prefix_sum(float val) {
    for (int offset = 1; offset < 32; offset <<= 1) {
        float n = __shfl_xor_sync(0xffffffff, val, offset);
        if ((threadIdx.x & offset) != 0) val += n;
    }
    return val;
}
```

**Vote functions** let you query predicates across the warp:

```cpp
__global__ void vote_demo(const int* data, int* results, int n) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    int val = data[idx];

    // Is any thread in this warp processing a negative value?
    bool any_neg = __any_sync(0xffffffff, val < 0);

    // Are ALL threads processing positive values?
    bool all_pos = __all_sync(0xffffffff, val > 0);

    // Which threads have even values? Returns a 32-bit mask.
    unsigned int even_mask = __ballot_sync(0xffffffff, val % 2 == 0);

    if (threadIdx.x == 0) {
        results[blockIdx.x] = any_neg ? -1 : (all_pos ? 1 : 0);
    }
}
```

### Full Block Reduction Using Warp Shuffles

Combining warp reductions with shared memory gives an efficient block-wide reduction:

```cpp
// Reduces all values in a block to a single sum, returned in thread 0
__device__ float block_reduce_sum(float val) {
    static __shared__ float warp_sums[32];  // One slot per warp (max 32 warps/block)

    int lane   = threadIdx.x % 32;   // Position within warp
    int warp_id = threadIdx.x / 32;  // Which warp

    // Step 1: reduce within each warp using shuffles (no shared memory needed)
    val = warp_reduce_sum(val);

    // Step 2: lane 0 of each warp writes its partial sum to shared memory
    if (lane == 0) warp_sums[warp_id] = val;
    __syncthreads();

    // Step 3: first warp reduces the partial sums
    int num_warps = blockDim.x / 32;
    val = (threadIdx.x < num_warps) ? warp_sums[threadIdx.x] : 0.0f;
    if (warp_id == 0) val = warp_reduce_sum(val);

    return val;  // Thread 0 holds the block sum
}

__global__ void sum_reduction(const float* input, float* output, int n) {
    float val = 0.0f;
    // Grid-stride loop: each thread handles multiple elements
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        val += input[i];
    }

    float block_sum = block_reduce_sum(val);

    if (threadIdx.x == 0) {
        atomicAdd(output, block_sum);
    }
}
```

The grid-stride loop pattern (rather than one-element-per-thread) is important: it handles arrays of any size without launching excessive blocks, improves L2 reuse, and keeps occupancy high.

### Go Comparison

Go's `sync` package provides goroutine-level synchronization: `WaitGroup`, `Mutex`, `atomic` operations. These are CPU-side primitives operating on OS threads. There is nothing analogous to warp shuffles in Go, the concept of 32 threads running in lockstep and exchanging register values in a single cycle has no CPU equivalent. The closest CPU analogy is SIMD intrinsics (`__m256` reduction with `_mm256_hadd_ps`), but even those are per-core, not cross-core. Warp shuffles are a uniquely GPU capability.

---
