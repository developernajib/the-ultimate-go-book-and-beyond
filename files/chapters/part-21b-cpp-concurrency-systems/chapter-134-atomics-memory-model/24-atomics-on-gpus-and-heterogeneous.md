## Atomics on GPUs and Heterogeneous Systems

GPU and accelerator atomics were once an afterthought (CUDA 1.x: int atomicAdd, no ordering). Modern CUDA, ROCm, and SYCL converge on a subset of the C++ memory model with explicit scope. This file maps C++ memory orders to GPU instructions and explains why scope is the new dimension you must reason about.

### Scope

The big departure from CPU C++: a GPU atomic op specifies not only memory order but also memory scope. Scope says which agents the atomic synchronizes with.

CUDA scopes:

- `cuda::thread_scope_thread`: only the current thread (rarely useful, optimization).
- `cuda::thread_scope_block`: threads in the same CUDA block (CTA).
- `cuda::thread_scope_device`: all threads on the same GPU.
- `cuda::thread_scope_system`: all CPU and GPU threads (system-wide).

Why scope matters: GPU caches are not coherent across the entire device. Different SMs have private L1 caches. A thread on SM 0 modifying memory does not automatically become visible to a thread on SM 1 until the line is written back to L2 (the device-wide cache). A `device` scope atomic forces this writeback. A `block` scope atomic does not, because all threads in a block share the same SM and therefore the same L1.

Smaller scope = cheaper. A `block` scope atomic on a CUDA core is roughly as cheap as a non-atomic on Volta+. A `system` scope atomic forces a flush all the way to host memory and costs hundreds of cycles.

### CUDA Atomic API

`libcu++` (the CUDA standard library) provides `cuda::atomic<T, Scope>` with the same API as `std::atomic<T>`.

```cpp
#include <cuda/atomic>

__global__ void kernel(int* counter) {
    cuda::atomic_ref<int, cuda::thread_scope_device> ref(*counter);
    ref.fetch_add(1, cuda::memory_order_relaxed);
}
```

Memory orders supported are the C++ standard set: relaxed, consume, acquire, release, acq_rel, seq_cst.

CUDA also exposes legacy intrinsics: `atomicAdd`, `atomicCAS`, etc. These default to `device` scope and `relaxed` order. They are equivalent to `cuda::atomic<...>::fetch_add(..., relaxed)` with `device` scope.

Mapping to PTX (Volta and later):

| C++ + Scope | PTX |
|-------------|-----|
| relaxed, block | `atom.relaxed.cta.add` |
| relaxed, device | `atom.relaxed.gpu.add` |
| relaxed, system | `atom.relaxed.sys.add` |
| acq_rel, block | `atom.acq_rel.cta.add` |
| acq_rel, device | `atom.acq_rel.gpu.add` |
| seq_cst, system | `atom.acq_rel.sys.add` + `fence.sc.sys` |

PTX scope qualifiers:
- `.cta` = block scope
- `.gpu` = device scope
- `.sys` = system scope

Volta SM 70 was the first architecture to support fine-grained memory orders and scope. Pre-Volta hardware had only relaxed-equivalent atomics with implicit sync at kernel boundaries.

### The Volta Memory Model

Volta introduced independent thread scheduling within a warp. Before Volta, threads in a warp were lockstep. After Volta, divergent threads can be scheduled independently. This breaks pre-Volta lock-free patterns that assumed warp-implicit synchronization.

The fix: explicit `__syncwarp()` or `cooperative_groups::coalesced_group::sync()`. The C++ memory model is the right abstraction. Code that uses `cuda::atomic` with proper memory orders is portable across Volta and pre-Volta (subject to scope availability).

### Acquire-Release on GPUs

Producer-consumer between blocks requires `device` scope:

```cpp
__device__ cuda::atomic<int, cuda::thread_scope_device> flag{0};
__device__ int data;

__global__ void producer() {
    if (threadIdx.x == 0) {
        data = 42;
        flag.store(1, cuda::memory_order_release);
    }
}

__global__ void consumer() {
    if (threadIdx.x == 0) {
        while (flag.load(cuda::memory_order_acquire) == 0);
        int v = data;     // sees 42
    }
}
```

Generated PTX:
```
producer:
    st.global.u32 [data], 42
    fence.release.gpu              ; release fence
    st.global.u32 [flag], 1
consumer:
loop:
    ld.global.u32 r0, [flag]
    setp.eq.s32 p, r0, 0
    @p bra loop
    fence.acquire.gpu              ; acquire fence
    ld.global.u32 v, [data]
```

The `fence.release.gpu` and `fence.acquire.gpu` are the GPU's L2 sync barriers. They flush dirty L1 cache lines to L2 (release) and invalidate L1 (acquire) so subsequent loads see the L2 state.

If the producer and consumer are in the same block, `block` scope and `__syncthreads()` are cheaper.

### System Scope and Unified Memory

CUDA Unified Memory (managed memory) lets CPU and GPU access the same pointer. System scope atomics synchronize with CPU code:

```cpp
__managed__ cuda::atomic<int, cuda::thread_scope_system> shared_flag{0};

// CPU code
shared_flag.store(1, std::memory_order_release);

// GPU kernel
__global__ void k() {
    if (threadIdx.x == 0 && blockIdx.x == 0) {
        while (shared_flag.load(cuda::memory_order_acquire) == 0);
    }
}
```

System scope on the GPU side requires a `fence.sys` which flushes all GPU caches and triggers the GPU's coherence link to host memory. Cost: hundreds of cycles minimum, often more under contention.

NVLink-attached systems (Grace Hopper, GH200) implement system scope with hardware coherence. Cost is closer to a normal device-scope atomic.

PCIe-attached systems use software coherence. System atomics are page-fault-driven on classic UVM, or use ATS/PRI on newer hardware.

### OpenCL Atomics

OpenCL 2.0 introduced atomics modeled closely on C11. OpenCL 3.0 made atomics optional but most implementations support them.

OpenCL scope:
- `memory_scope_work_item`: this work-item only.
- `memory_scope_work_group`: the work-group (analogous to CUDA block).
- `memory_scope_device`: all work-items on the device.
- `memory_scope_all_svm_devices`: shared virtual memory across host and devices.

API mirrors C11:
```c
atomic_store_explicit(&x, 1, memory_order_release, memory_scope_work_group);
```

OpenCL atomics target a wider range of hardware (CPUs, GPUs, FPGAs, DSPs). Performance varies enormously. Always benchmark.

### ROCm and HIP Atomics

AMD's HIP runtime closely mirrors CUDA. `hip::atomic` is the same as `cuda::atomic` in API.

AMD GPU memory model: GFX9 (Vega) and later are similar to NVIDIA in scope semantics. CDNA chips (MI100, MI200, MI300) support full C++ memory model with explicit scope.

Mapping HIP scopes to AMD instructions:

| HIP scope | AMD ISA |
|-----------|---------|
| `wavefront` | wavefront-local, no special instruction |
| `workgroup` | `s_waitcnt vmcnt(0) lgkmcnt(0)` for sync |
| `device` | `buffer_wbl1; buffer_wbinvl1` for fence |
| `system` | full L2 flush + system coherence |

The MI300 series with infinity fabric provides hardware coherence with EPYC CPUs in the same package, making system scope cheaper than on PCIe-attached GPUs.

### SYCL Atomics

SYCL 2020 includes `sycl::atomic_ref<T, MemoryOrder, MemoryScope, Space>`. Four template parameters:

- T: the type.
- MemoryOrder: default ordering for operations.
- MemoryScope: default scope.
- Space: address space (global, local, generic).

Verbose but explicit. SYCL targets multiple backends (Intel GPU, AMD, NVIDIA via DPC++/oneAPI), so the same code compiles to PTX, GCN, or SPIR-V.

### GPU Lock-Free Pitfalls

**Pitfall 1: assuming warp-lockstep**. Pre-Volta code used `if (lane == 0) atomicAdd(...)` and assumed all other lanes waited. On Volta+, lanes can diverge mid-warp. Use `__syncwarp` or `cuda::atomic` with proper orders.

**Pitfall 2: using device scope when block suffices**. Massive perf loss. Audit every atomic for the smallest sufficient scope.

**Pitfall 3: hot atomics on a single address**. GPU atomics serialize through a coherence point. A million threads doing `atomicAdd(&x, 1)` is a million-cycle serialization. Use shared memory aggregation per block, then one device atomic per block.

**Pitfall 4: cross-stream synchronization**. Stream A produces, stream B consumes. Without `cudaStreamSynchronize` or events, the consumer kernel may run before the producer's writes are visible, even with seq_cst atomics. Stream ordering is a separate dimension from memory ordering.

### Junior at FAANG vs Senior at FAANG

Junior copies `atomicAdd` from a CUDA tutorial, ships GPU code that mostly works. Senior:

- Uses `cuda::atomic<T, Scope>` with explicit scope on every atomic.
- Picks the smallest sufficient scope (block > device > system in cost order).
- Aggregates per-block in shared memory before the device atomic.
- Profiles atomic-heavy kernels with Nsight Compute, looks at `l1tex__t_sectors_pipe_lsu_mem_global_op_atom` to see actual atomic throughput.
- For Hopper and Grace Hopper, uses TMA (Tensor Memory Accelerator) for bulk transfers and cluster atomics for cross-block within a thread block cluster.

The cost of a wrong atomic on a GPU is much larger than on a CPU because of the thread count multiplier. A 100x slowdown per atomic times 10 million threads is the difference between a kernel that takes 10ms and one that takes 1000s.
