## GPU and Pinned Memory Allocators

GPU programming exposes a memory model where allocation cost dominates many workloads. A naive `cudaMalloc` per kernel launch can take 100 microseconds. Run that 10,000 times per second and you have spent a full CPU core on memory management before any compute happens. Production GPU code (deep-learning frameworks, HPC, real-time graphics) almost always uses pools, arenas, or async allocation APIs.

The same patterns apply on AMD ROCm with `hipMalloc`. The terminology and APIs are nearly identical (HIP is largely a syntactic translation of CUDA), so this chapter focuses on CUDA with parallels noted.

### The CUDA Allocation API Surface

CUDA exposes several allocation primitives, each with different semantics.

| API | Where | Sync? | Notes |
|-----------------------|-----------|---------|----------------------------------------|
| `cudaMalloc` | Device | Sync | Classic. Blocks the host. Slow. |
| `cudaMallocManaged` | Unified | Sync | Unified Virtual Addressing, paged on demand |
| `cudaMallocAsync` | Device | Async | Stream-ordered, uses memory pools |
| `cudaHostAlloc` | Host | Sync | Pinned host memory, DMA-capable |
| `cudaMallocHost` | Host | Sync | Older alias for cudaHostAlloc |

Each maps to different driver paths. `cudaMalloc` calls into the driver, allocates physical device memory, and synchronizes the entire device. `cudaMallocAsync` (CUDA 11.2+) submits the allocation to a stream and returns immediately, deferring the actual driver call.

### cudaMalloc: The Slow Path

```cpp
float* d_data = nullptr;
cudaMalloc(&d_data, n * sizeof(float));
// ... use d_data ...
cudaFree(d_data);
```

`cudaMalloc` is a synchronous, device-wide synchronization point. The driver allocates from a global heap. The call blocks until prior work on the device completes. For workloads with frequent allocation/deallocation, this is the wrong API.

### cudaMallocAsync and Memory Pools

The async API allocates from a per-device memory pool, in stream order.

```cpp
cudaStream_t stream;
cudaStreamCreate(&stream);

float* d_data = nullptr;
cudaMallocAsync(&d_data, n * sizeof(float), stream);
my_kernel<<<grid, block, 0, stream>>>(d_data, n);
cudaFreeAsync(d_data, stream);

cudaStreamSynchronize(stream);
```

Both alloc and free are stream-ordered. The free does not actually return memory to the pool until prior stream work finishes. The next alloc from the same stream can reuse the just-freed block immediately, without any host-device synchronization.

Configure the pool's release threshold so it does not fight you on RSS:

```cpp
cudaMemPool_t pool;
cudaDeviceGetDefaultMemPool(&pool, /*device=*/0);

uint64_t threshold = 2ull << 30;  // 2 GiB held back from driver
cudaMemPoolSetAttribute(pool, cudaMemPoolAttrReleaseThreshold, &threshold);
```

Below the threshold the pool retains memory. Above, it releases on idle. Tuning this is workload-specific. Training jobs that hit a steady-state working set want a high threshold. Inference servers running mixed-batch sizes want a moderate threshold to free memory between request batches.

### Custom Pool Allocator on Top of CUDA

For workloads where even `cudaMallocAsync` is too coarse (small tensors, high frequency), build a custom pool.

```cpp
class CudaPool {
    struct Block {
        void* ptr;
        size_t size;
        Block* next;
    };

    std::mutex mu_;
    std::unordered_map<size_t, Block*> free_lists_;  // by size class
    cudaStream_t stream_;

    static size_t round_up(size_t n) {
        // Round to next multiple of 256 bytes (CUDA alignment).
        return (n + 255) & ~size_t{255};
    }

public:
    explicit CudaPool(cudaStream_t s) : stream_(s) {}

    void* allocate(size_t bytes) {
        bytes = round_up(bytes);
        std::lock_guard g(mu_);
        auto it = free_lists_.find(bytes);
        if (it != free_lists_.end() && it->second) {
            Block* b = it->second;
            it->second = b->next;
            void* p = b->ptr;
            delete b;
            return p;
        }
        void* p = nullptr;
        if (cudaMallocAsync(&p, bytes, stream_) != cudaSuccess) {
            throw std::bad_alloc();
        }
        return p;
    }

    void deallocate(void* p, size_t bytes) {
        bytes = round_up(bytes);
        std::lock_guard g(mu_);
        auto* b = new Block{p, bytes, free_lists_[bytes]};
        free_lists_[bytes] = b;
    }

    ~CudaPool() {
        for (auto& [_, head] : free_lists_) {
            while (head) {
                cudaFreeAsync(head->ptr, stream_);
                Block* next = head->next;
                delete head;
                head = next;
            }
        }
    }
};
```

This is a per-size-class free list with `cudaMallocAsync` as the upstream. Tensor frameworks (PyTorch, TensorFlow, JAX) ship caching allocators that look like this. PyTorch's `c10::cuda::CUDACachingAllocator` is a more sophisticated version with split blocks, expandable segments, and a graph capture path.

### Pinned Host Memory

Regular host memory (from `malloc`) is pageable. The kernel can swap it. DMA engines on the GPU cannot directly read or write pageable memory because the page might be unmapped mid-transfer. So the driver, on `cudaMemcpy`, copies pageable memory into a pinned staging buffer first, then DMAs to the GPU. Two copies, slow.

Pinned host memory bypasses this. `cudaHostAlloc` returns memory that is locked in physical RAM. DMA engines can target it directly.

```cpp
float* h_buf;
cudaHostAlloc(&h_buf, bytes, cudaHostAllocDefault);
cudaMemcpyAsync(d_buf, h_buf, bytes, cudaMemcpyHostToDevice, stream);
// h_buf survives until cudaFreeHost.
```

Trade-offs.

- Pinned memory is non-pageable. Allocate too much and the host runs out of swappable memory.
- Pinned alloc is slow (it touches the kernel mm subsystem). Pool pinned buffers, do not allocate per-transfer.
- Pinned + write-combined (`cudaHostAllocWriteCombined`) is faster for host-to-device but slower for host reads. Use for upload-only buffers.
- Pinned + mapped (`cudaHostAllocMapped`) gives the GPU a device pointer that aliases the host memory. Useful for zero-copy patterns on integrated GPUs (Tegra, integrated AMD).

### Unified Memory and UVA

`cudaMallocManaged` allocates a single virtual address valid on both host and device. The driver pages physical memory between them on access faults.

```cpp
float* data;
cudaMallocManaged(&data, n * sizeof(float));

// Initialize on host.
for (size_t i = 0; i < n; ++i) data[i] = i;

// Use on device.
my_kernel<<<grid, block>>>(data, n);
cudaDeviceSynchronize();

// Read on host. The driver migrates pages back.
printf("%f\n", data[0]);
```

Convenient. Slow on first touch from the wrong side because of the page fault. `cudaMemPrefetchAsync` mitigates by hinting which device should hold the pages.

```cpp
cudaMemPrefetchAsync(data, n * sizeof(float), 0, stream);  // prefetch to GPU 0
my_kernel<<<grid, block, 0, stream>>>(data, n);
cudaMemPrefetchAsync(data, n * sizeof(float), cudaCpuDeviceId, stream);  // back to CPU
```

For production, prefer explicit `cudaMalloc` + `cudaMemcpyAsync` or `cudaMallocAsync` over managed memory. UVA is for prototypes and for mixed-access workloads where neither side dominates.

### ROCm Parallels

AMD's HIP is API-compatible with CUDA at the source level.

| CUDA | HIP |
|--------------------------|---------------------------|
| `cudaMalloc` | `hipMalloc` |
| `cudaMallocAsync` | `hipMallocAsync` |
| `cudaHostAlloc` | `hipHostMalloc` |
| `cudaMallocManaged` | `hipMallocManaged` |
| `cudaMemPool_t` | `hipMemPool_t` |

The semantics match closely. ROCm 5.x and later support stream-ordered async allocation. Memory pool support landed slightly later than on CUDA but is now standard. NVLink and AMD Infinity Fabric expose similar peer-access APIs (`cudaDeviceEnablePeerAccess`, `hipDeviceEnablePeerAccess`).

### Multi-GPU Patterns

For multi-GPU servers (DGX, MI300X), each device has its own pool. Allocation is per-device. Cross-device transfers use `cudaMemcpyPeerAsync`.

```cpp
cudaSetDevice(0);
void* d0 = nullptr;
cudaMallocAsync(&d0, bytes, stream0);

cudaSetDevice(1);
void* d1 = nullptr;
cudaMallocAsync(&d1, bytes, stream1);

cudaMemcpyPeerAsync(d1, /*dstDev=*/1, d0, /*srcDev=*/0, bytes, stream0);
```

If `cudaDeviceCanAccessPeer` reports yes (NVLink between devices, or PCIe with peer access enabled), the copy bypasses host memory entirely.

### Junior to FAANG

A junior engineer calls `cudaMalloc` per kernel launch and complains the GPU is idle. A FAANG-grade engineer maintains per-stream memory pools, pre-allocates pinned host buffers in a free list, prefetches managed memory deliberately, knows that `cudaMallocAsync` is stream-ordered and uses that property to elide synchronization, and benchmarks with `nsys` to see whether allocation calls are appearing on the timeline. They also know that PyTorch's `CUDACachingAllocator` is a reference implementation worth reading even if you never use PyTorch.
