## GPU Architecture Fundamentals

You cannot write good Vulkan code without understanding what the GPU actually is. The API surface area of Vulkan is large, but most of its rules exist because of physical properties of GPU hardware. If you know the hardware, the API stops being arbitrary.

### SIMT Versus SIMD

A CPU SIMD instruction (AVX-512, NEON, SVE) takes one instruction stream and applies it to a vector register. The programmer writes code that explicitly packs eight floats into a `__m256` and calls `_mm256_add_ps`. The vector width is fixed at compile time.

A GPU uses Single Instruction Multiple Threads (SIMT). The programmer writes scalar code as if there were a single thread, and the hardware groups threads into wide execution units that run them in lockstep. On NVIDIA, the unit is a **warp** of 32 threads. On AMD, it is a **wavefront**, historically 64 threads on GCN and 32 on RDNA (with a 64 mode still available). On Intel Arc, it is a **subgroup** of 8, 16, or 32. On Apple GPUs, it is a SIMD-group of 32.

When the threads in a warp follow the same code path, the warp issues one instruction per cycle and executes 32 results. When threads diverge, the warp masks off the inactive threads and executes both paths serially. This is **divergence**, and it is the single largest performance pitfall in GPU programming.

```cpp
// Bad: divergence on every thread
[shader("compute")] void cs(uint3 tid : SV_DispatchThreadID) {
    if (tid.x % 2 == 0) {
        // Half the lanes go here
        do_expensive_work_a();
    } else {
        // The other half go here, executed after lane A finishes
        do_expensive_work_b();
    }
}

// Better: align divergence boundaries to warp size
[shader("compute")] void cs(uint3 tid : SV_DispatchThreadID) {
    uint warp = tid.x / 32;
    if (warp % 2 == 0) {
        do_expensive_work_a();
    } else {
        do_expensive_work_b();
    }
}
```

The CPU equivalent of divergence is a branch mispredict, which costs 15 to 20 cycles. The GPU equivalent is a serialization that costs as many cycles as the longest path multiplied by the number of distinct paths.

### Streaming Multiprocessors and Compute Units

A GPU is composed of many independent execution clusters. NVIDIA calls them **Streaming Multiprocessors (SMs)**. AMD calls them **Compute Units (CUs)** on GCN or **Workgroup Processors (WGPs)** on RDNA. Apple calls them **GPU cores**. Intel calls them **Xe-cores**.

An RTX 4090 has 128 SMs. An RTX 5090 has 170. An RX 7900 XTX has 96 CUs (48 WGPs). An Apple M3 Max has 40 GPU cores.

Each SM has its own register file, shared memory pool, scheduler, and execution units. A compute dispatch is divided into **thread blocks** (CUDA) or **workgroups** (Vulkan / Metal). Each block is assigned to one SM and runs to completion there. Within an SM, multiple blocks can run concurrently if the SM has enough resources.

### Occupancy

Occupancy is the ratio of active warps on an SM to the maximum the SM can support. An SM can host at most 64 warps on Ada Lovelace (NVIDIA's RTX 40 series). If your kernel allows only 16 warps to be resident, your occupancy is 25 percent.

Three resources limit occupancy:

1. **Registers per thread.** Each SM has a fixed register file (65,536 32-bit registers on Ada). If your kernel uses 64 registers per thread, you can have at most 1024 threads (32 warps) resident. If you use 128 registers, you cap out at 16 warps.
2. **Shared memory per block.** Each SM has 100 to 228 KB of shared memory depending on architecture. If your block uses 48 KB, you can fit at most 4 to 5 blocks per SM.
3. **Threads per block and blocks per SM.** Hardware limits cap the absolute number of resident threads.

High occupancy lets the SM hide memory latency by switching warps when one is waiting on a load. Low occupancy is fine if your kernel is compute-bound and you have enough instruction-level parallelism within a single warp. Volkov's "Better Performance at Lower Occupancy" (2010) is the classic reference.

```
NVIDIA Nsight Compute: occupancy report
Theoretical occupancy: 100% (64 warps)
Achieved occupancy: 31% (20 warps)
Limiter: registers (84 per thread)
Recommendation: reduce register pressure or accept low occupancy
```

### Memory Hierarchy

Approximate latency and bandwidth on a modern desktop GPU (numbers are order-of-magnitude, vary by vendor and clock):

| Level | Latency (cycles) | Bandwidth | Scope |
|---|---|---|---|
| Register | 1 | unlimited | per lane |
| Shared / LDS / threadgroup | 20 to 30 | 10+ TB/s aggregate | per workgroup |
| L1 cache | 30 to 50 | 5 TB/s | per SM |
| L2 cache | 200 to 400 | 2 TB/s | global |
| HBM3 / GDDR6X | 400 to 800 | 1 TB/s (4090), 3 TB/s (H100), 8 TB/s (B200) | global |

The crucial point: a HBM access costs 400 to 800 cycles. The SM only hides this if it has many warps to switch between. A kernel that does one global load per warp with low occupancy will spend most of its time idle.

### Coalesced Memory Access

When a warp issues a memory load, the hardware combines the 32 lane addresses into the minimum number of cache lines. If all 32 lanes load consecutive 4-byte values, this is one 128-byte transaction. If the lanes load scattered addresses, this can become 32 separate 32-byte transactions.

```cpp
// Coalesced: lane i loads address base + i*4
float v = data[tid.x];

// Strided, often uncoalesced
float v = data[tid.x * 16];

// Random, worst case
float v = data[indices[tid.x]];
```

This is the GPU analogue of cache-friendly access patterns on CPU, but the cost ratio is much steeper. A coalesced load is 30 cycles. A fully uncoalesced load is over 1000.

### Tensor Cores and Matrix Engines

Modern GPUs include matrix-multiply-accumulate units that perform `D = A * B + C` on small matrices in one instruction. These are the workhorses of ML inference and increasingly of graphics (DLSS, ray reconstruction, neural rendering).

NVIDIA tensor cores (Volta and later) operate on 4x4, 8x8, or 16x16 tiles. Ada Lovelace adds FP8 support. Hopper adds the Tensor Memory Accelerator and asynchronous tensor copy. Blackwell adds FP4 and a second-generation transformer engine.

AMD CDNA includes matrix cores with similar functionality. RDNA 3 adds Wave Matrix Multiply Accumulate (WMMA) instructions exposed in HLSL via `__builtin_amdgcn_wmma_*`. Apple A17 / M3 added matrix multiply units to the GPU as well as the existing AMX coprocessor.

In Vulkan, these are exposed via `VK_KHR_cooperative_matrix`. In HLSL via `WaveMatrix` (preview). In CUDA via `wmma::fragment`.

```cpp
// CUDA WMMA fragment
#include <mma.h>
using namespace nvcuda::wmma;
fragment<matrix_a, 16, 16, 16, half, row_major> a;
fragment<matrix_b, 16, 16, 16, half, col_major> b;
fragment<accumulator, 16, 16, 16, float> c;
load_matrix_sync(a, ptr_a, 16);
load_matrix_sync(b, ptr_b, 16);
mma_sync(c, a, b, c);
store_matrix_sync(ptr_c, c, 16, mem_row_major);
```

### Ray Tracing Hardware

Hardware ray tracing accelerators are physical units inside the SM (NVIDIA RT cores, AMD Ray Accelerators, Apple's RT units). They accelerate two operations:

1. **Bounding volume hierarchy traversal.** Walking an axis-aligned bounding box tree to find the leaves a ray potentially hits.
2. **Ray-triangle intersection.** Testing a ray against an actual triangle.

NVIDIA RT cores in Ada Lovelace add Opacity Micromaps (skip alpha-tested geometry without invoking any-hit shaders) and Displaced Micro-Meshes (compress millions of triangles into a base mesh plus displacement). Blackwell RT cores add Mega Geometry support which scales to billions of triangles.

AMD's Ray Accelerators in RDNA 3 do triangle intersection in hardware but BVH traversal in shader code, which is part of why RDNA RT throughput trails NVIDIA. RDNA 4 (RX 9000 series) moves more of the traversal into hardware.

The application does not see RT cores directly. They are activated by issuing `TraceRay` (DXR / HLSL), `traceRayEXT` (Vulkan / GLSL), or the Metal RT equivalents.

### Tile-Based Deferred Rendering

Apple GPUs and Mali / Adreno mobile GPUs are **tile-based deferred renderers (TBDRs)**, not immediate-mode rasterizers. They split the framebuffer into tiles (typically 32x32 pixels), bin all primitives by tile in a first pass, then shade each tile entirely in on-chip tile memory.

This has major architectural consequences:

- A `loadAction = .clear` for the framebuffer is free. There is no DRAM read.
- A `storeAction = .dontCare` for a depth or stencil attachment skips the DRAM write.
- Multiple subpasses that share tile memory (Vulkan render passes, Metal render command encoders) can run without round-tripping to DRAM.
- Forward shading often beats deferred shading on TBDR because deferred bounces a fat G-buffer through DRAM.

A renderer that ignores TBDR semantics on Apple hardware will work but waste 30 to 60 percent of memory bandwidth. The Metal API surfaces the tile concept directly via `MTLTileRenderPipelineState` and tile shading.

### Junior to FAANG

A junior C++ programmer writes a Vulkan compute shader, runs it, and sees it works. A senior at NVIDIA's driver team opens Nsight Compute, sees that warp occupancy is 25 percent, that L2 hit rate is 40 percent, that the long pole is uncoalesced global loads from a structure-of-arrays-as-array-of-structures conversion that should have been done on the CPU. They rewrite the data layout, occupancy goes to 75 percent, kernel time drops 3.5x. That is the gap.

---
