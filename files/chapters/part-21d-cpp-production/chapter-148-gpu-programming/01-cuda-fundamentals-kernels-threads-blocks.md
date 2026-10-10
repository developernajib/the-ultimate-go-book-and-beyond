## CUDA Fundamentals: Kernels, Threads, Blocks, and Grids

CUDA is NVIDIA's parallel computing platform and programming model. A CUDA program runs on two processors simultaneously: the **host** (CPU, running standard C++) and the **device** (GPU, running CUDA kernels). The mental model shift from CPU programming is significant: instead of writing a loop, you write a single function that runs once per element, then launch millions of instances of it simultaneously.

### GPU Architecture: Streaming Multiprocessors

A GPU is organized into **Streaming Multiprocessors** (SMs). Each SM is a self-contained parallel processor with:

- 128 CUDA cores (Ampere architecture)
- 4 Tensor Core units for matrix operations
- 256KB combined L1 cache and shared memory
- 65,536 32-bit registers shared across all active threads
- A warp scheduler that switches between thread groups each cycle

An H100 has 132 SMs. An A100 has 108. A consumer RTX 4090 has 128. The total CUDA core count, often cited in marketing, is simply `SM_count × cores_per_SM`. More important than raw core count is understanding how work is organized to keep every SM busy.

### Thread Hierarchy

CUDA organizes threads in a three-level hierarchy:

```
Grid
└── Block (up to 65535 blocks per dimension)
    └── Thread (up to 1024 threads per block)
        └── Warp (32 threads, the actual execution unit)
```

**Thread**: One execution unit. Has private registers and a unique ID (`threadIdx`).

**Block**: Up to 1024 threads running on one SM. All threads in a block share L1/shared memory and can synchronize with `__syncthreads()`. A block never migrates to another SM mid-execution.

**Grid**: The collection of all blocks for a kernel launch. A grid can be 1D, 2D, or 3D.

**Warp**: 32 threads executing in **lockstep**, all 32 run the same instruction simultaneously (SIMT: Single Instruction Multiple Threads). This is the actual hardware execution unit. Divergent branches within a warp serialize, which is the primary cause of warp underutilization.

### Kernel Launch Syntax

The triple-angle-bracket launch syntax `kernel<<<gridDim, blockDim, sharedMemBytes, stream>>>` configures the execution grid at launch time, `gridDim` and `blockDim` are `dim3` structs that allow 1D, 2D, or 3D indexing for spatial problems. Each thread computes its unique global ID from `blockIdx`, `blockDim`, and `threadIdx`, which is the one line of index arithmetic that every CUDA kernel begins with.
```cpp
kernel<<<gridDim, blockDim, sharedMemBytes, stream>>>(args...);
```

- `gridDim`: `dim3` specifying how many blocks (x, y, z)
- `blockDim`: `dim3` specifying threads per block (x, y, z)
- `sharedMemBytes`: dynamic shared memory in bytes (optional, default 0)
- `stream`: CUDA stream for async execution (optional, default stream 0)

Every thread computes its unique global index from the built-in variables:

```cpp
threadIdx.x   // thread's index within its block (0 to blockDim.x-1)
blockIdx.x    // block's index within the grid
blockDim.x    // number of threads per block
gridDim.x     // number of blocks in the grid
```

### Vector Addition: The Hello World of CUDA

The canonical "Hello, World" program verifies that the toolchain is correctly installed and that the build pipeline, from source to executable, functions end-to-end. In C++ this also exercises the standard library's `iostream` header and the link step against `libstdc++` or `libc++`.
```cpp
#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>
#include <chrono>

// __global__ marks a function as a CUDA kernel.
// Runs on device, called from host.
__global__ void vector_add(const float* __restrict__ a,
                           const float* __restrict__ b,
                           float* __restrict__ c,
                           int n) {
    // Each thread handles one element.
    int idx = blockIdx.x * blockDim.x + threadIdx.x;

    // Guard: the last block may extend past the array.
    if (idx < n) {
        c[idx] = a[idx] + b[idx];
    }
}

// Macro for checking CUDA errors. Always do this in production.
#define CUDA_CHECK(call)                                                    \
    do {                                                                    \
        cudaError_t err = (call);                                           \
        if (err != cudaSuccess) {                                           \
            fprintf(stderr, "CUDA error at %s:%d, %s\n",                  \
                    __FILE__, __LINE__, cudaGetErrorString(err));           \
            std::exit(EXIT_FAILURE);                                        \
        }                                                                   \
    } while (0)

int main() {
    constexpr int N = 1 << 24;   // 16M elements
    constexpr int BYTES = N * sizeof(float);

    // Allocate host memory (pageable, ordinary malloc)
    float* h_a = static_cast<float*>(std::malloc(BYTES));
    float* h_b = static_cast<float*>(std::malloc(BYTES));
    float* h_c = static_cast<float*>(std::malloc(BYTES));

    for (int i = 0; i < N; ++i) {
        h_a[i] = static_cast<float>(i);
        h_b[i] = static_cast<float>(i) * 2.0f;
    }

    // Allocate device memory
    float *d_a, *d_b, *d_c;
    CUDA_CHECK(cudaMalloc(&d_a, BYTES));
    CUDA_CHECK(cudaMalloc(&d_b, BYTES));
    CUDA_CHECK(cudaMalloc(&d_c, BYTES));

    // Copy host → device (H2D)
    CUDA_CHECK(cudaMemcpy(d_a, h_a, BYTES, cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(d_b, h_b, BYTES, cudaMemcpyHostToDevice));

    // Launch configuration: 256 threads per block, enough blocks to cover N
    constexpr int BLOCK_SIZE = 256;
    int grid_size = (N + BLOCK_SIZE - 1) / BLOCK_SIZE;

    // Time the kernel
    cudaEvent_t start, stop;
    CUDA_CHECK(cudaEventCreate(&start));
    CUDA_CHECK(cudaEventCreate(&stop));

    CUDA_CHECK(cudaEventRecord(start));
    vector_add<<<grid_size, BLOCK_SIZE>>>(d_a, d_b, d_c, N);
    CUDA_CHECK(cudaEventRecord(stop));

    // Check for kernel launch errors
    CUDA_CHECK(cudaGetLastError());

    // Wait for GPU to finish
    CUDA_CHECK(cudaEventSynchronize(stop));

    float elapsed_ms = 0.0f;
    CUDA_CHECK(cudaEventElapsedTime(&elapsed_ms, start, stop));
    printf("Kernel time: %.3f ms\n", elapsed_ms);

    // Effective bandwidth: read a, b + write c = 3 * N * 4 bytes
    double bandwidth_gb = (3.0 * BYTES) / (elapsed_ms * 1e-3) / 1e9;
    printf("Effective bandwidth: %.1f GB/s\n", bandwidth_gb);

    // Copy device → host (D2H) and verify
    CUDA_CHECK(cudaMemcpy(h_c, d_c, BYTES, cudaMemcpyDeviceToHost));

    for (int i = 0; i < 10; ++i) {
        printf("c[%d] = %.1f (expected %.1f)\n", i, h_c[i], h_a[i] + h_b[i]);
    }

    // Cleanup
    CUDA_CHECK(cudaFree(d_a));
    CUDA_CHECK(cudaFree(d_b));
    CUDA_CHECK(cudaFree(d_c));
    std::free(h_a); std::free(h_b); std::free(h_c);

    CUDA_CHECK(cudaEventDestroy(start));
    CUDA_CHECK(cudaEventDestroy(stop));

    return 0;
}
// Compile: nvcc -O3 -arch=sm_90 vector_add.cu -o vector_add
// (sm_90 = H100 - sm_86 = RTX 3090 - sm_80 = A100)
```

On an A100, this achieves roughly 1.5-1.9 TB/s, close to the A100's peak 2 TB/s HBM2e bandwidth. Vector addition is purely memory-bound. The compute is trivial compared to the time spent moving bytes.

### Memory Types and Transfer Strategies

| Memory Type | Location | Bandwidth | Lifetime | Notes |
|---|---|---|---|---|
| Global | Device DRAM | ~2 TB/s | Explicit alloc/free | Main GPU memory pool |
| Shared | On-chip per SM | ~100 TB/s | Block lifetime | Manually managed L1 |
| L1/L2 cache | On-chip | ~10-20 TB/s | Automatic | Transparent to programmer |
| Registers | On-chip per thread | Fastest | Instruction lifetime | Spill to global if exceeded |
| Pinned (host) | CPU RAM, page-locked | ~30 GB/s H2D | Explicit alloc/free | Required for async transfers |
| Unified | Virtual, physical anywhere | Variable | Explicit alloc/free | Easiest but slowest |

**Pinned memory** is critical for performance: `cudaMemcpy` from pageable host memory first copies into an internal pinned staging buffer, then transfers. Allocating pinned memory directly skips that copy:

```cpp
// Pinned host allocation, page-locked, DMA-accessible by GPU
float* h_pinned;
CUDA_CHECK(cudaMallocHost(&h_pinned, BYTES));

// Now async transfer is possible
CUDA_CHECK(cudaMemcpyAsync(d_a, h_pinned, BYTES, cudaMemcpyHostToDevice, stream));

// Free pinned memory
CUDA_CHECK(cudaFreeHost(h_pinned));
```

**Unified Memory** (`cudaMallocManaged`) lets CPU and GPU share a pointer. The CUDA driver migrates pages on demand. Convenient for prototyping. Avoid in production latency-sensitive paths.

```cpp
float* unified;
CUDA_CHECK(cudaMallocManaged(&unified, BYTES));
// Now accessible on both CPU and GPU, driver handles migration
vector_add<<<grid, block>>>(unified, unified, unified, N);
CUDA_CHECK(cudaDeviceSynchronize());
// unified is now readable on CPU
```

### CUDA Streams: Overlapping Work

A **CUDA stream** is a queue of GPU operations that execute in order. Operations in different streams can overlap. This enables pipelining: while the GPU computes on batch N, you're transferring batch N+1.

```cpp
constexpr int NUM_STREAMS = 4;
constexpr int CHUNK = N / NUM_STREAMS;

cudaStream_t streams[NUM_STREAMS];
for (int i = 0; i < NUM_STREAMS; ++i)
    CUDA_CHECK(cudaStreamCreate(&streams[i]));

for (int i = 0; i < NUM_STREAMS; ++i) {
    int offset = i * CHUNK;
    // H2D transfer in stream i
    CUDA_CHECK(cudaMemcpyAsync(d_a + offset, h_a + offset,
                               CHUNK * sizeof(float),
                               cudaMemcpyHostToDevice, streams[i]));
    CUDA_CHECK(cudaMemcpyAsync(d_b + offset, h_b + offset,
                               CHUNK * sizeof(float),
                               cudaMemcpyHostToDevice, streams[i]));

    // Kernel in the same stream (runs after H2D completes for this chunk)
    int grid = (CHUNK + 255) / 256;
    vector_add<<<grid, 256, 0, streams[i]>>>(d_a + offset, d_b + offset,
                                              d_c + offset, CHUNK);

    // D2H transfer
    CUDA_CHECK(cudaMemcpyAsync(h_c + offset, d_c + offset,
                               CHUNK * sizeof(float),
                               cudaMemcpyDeviceToHost, streams[i]));
}

// Synchronize all streams
for (int i = 0; i < NUM_STREAMS; ++i) {
    CUDA_CHECK(cudaStreamSynchronize(streams[i]));
    CUDA_CHECK(cudaStreamDestroy(streams[i]));
}
```

The GPU's copy engine and compute engine are separate hardware units. On PCIe systems, well-pipelined streams can hide 60-80% of transfer overhead.

### Go Comparison

Go has no native GPU programming model. The closest options are:

- `github.com/barnex/cuda5`: CGo bindings to the CUDA runtime. Usable for simple kernels but requires the CUDA toolkit installed.
- `gorgonia.org/tensor`: Go tensor library. GPU support is limited.
- Subprocess or gRPC: call a Python/C++ process that owns the GPU.

In practice, Go engineers at ML companies write the serving infrastructure, the gRPC server, the request batcher, the load balancer, while C++ or Python owns the GPU kernels. The language boundary is clean: Go sends a request, C++ fills a result buffer, Go sends the response. Chapter 8 covers this integration pattern in depth.

---
