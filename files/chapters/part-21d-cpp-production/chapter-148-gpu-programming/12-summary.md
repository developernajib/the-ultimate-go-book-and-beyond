## Key Takeaways

- **The GPU execution model is fundamentally different from CPU programming.** Warps of 32 threads execute in lockstep. Latency is hidden through massive parallelism, not caching. Writing effective GPU code means expressing problems as thousands of independent, coalesced, warp-coherent operations, not as sequential loops with branch-heavy logic.

- **Memory access patterns dominate GPU performance.** A coalesced warp accesses 128 contiguous bytes in one transaction. An uncoalesced warp can require 32 separate transactions. Structure data in SoA (Structure of Arrays) layout for GPU workloads. The roofline model tells you whether your kernel is memory-bound (fix access patterns) or compute-bound (exploit tensor cores).

- **Shared memory is the key optimization lever.** At ~19 TB/s (vs 2 TB/s global), on-chip shared memory is 10× faster. Tiled algorithms, matrix multiply, convolution, prefix sum, achieve their performance by staging data in shared memory and reusing it many times before going back to global memory. Always pad shared arrays by 1 column to eliminate bank conflicts.

- **Warp-level primitives eliminate shared memory round-trips for warp-scoped operations.** `__shfl_down_sync` implements a warp reduction in 5 shuffle operations without touching shared memory. For operations that fit within a warp, shuffles are faster and require no synchronization.

- **cuBLAS and cuDNN are the production-grade libraries for standard operations.** They implement hand-tuned kernel selection, tensor core use, and algorithm auto-tuning that outperforms any reasonably written custom kernel. Write custom CUDA kernels only for operations these libraries don't cover (novel activations, custom attention variants, fused operations).

- **TensorRT compresses the gap between "model accuracy" and "deployment cost."** Layer fusion, kernel auto-tuning, and INT8 calibration together deliver 10-60× speedup over naive CPU inference. Properly calibrated INT8 loses <0.5% accuracy while running at 4× FP32 throughput on tensor cores. For production ML serving at scale, TensorRT is the standard.

- **CUDA dominates ML compute. SYCL and HIP provide portability.** The CUDA ecosystem (cuDNN, TensorRT, NCCL, Nsight) is the primary reason CUDA remains the default choice despite being NVIDIA-only. SYCL is the credible path for workloads that need to run on Intel data center GPUs or require hardware vendor independence. HIP provides a near-automated migration path from CUDA to AMD.

- **Vulkan compute and Metal serve different use cases than CUDA.** Vulkan provides cross-platform GPU compute with explicit control over every hardware resource, targeting graphics-adjacent workloads and mobile. Metal's unified memory architecture on Apple Silicon eliminates the CPU-GPU transfer bottleneck entirely, the zero-copy model changes what workloads are feasible at what cost.

- **Go and C++ are architecturally complementary in GPU systems.** Go excels at orchestration: request batching, load balancing, gRPC serving, data pipelines. C++ and CUDA excel at computation: kernel execution, GPU memory management, library integration. The boundary between them is a gRPC interface, typically Triton Inference Server. Go engineers who understand the GPU layer are more effective architects of this boundary.

- **FlashAttention demonstrates that algorithm-level GPU optimization can be as impactful as hardware.** By tiling attention computation to avoid materializing the O(n²) attention matrix, FlashAttention reduces memory footprint from O(n²) to O(n) and achieves 2-4× speedup. It is the reason 100K+ context windows are feasible. The lesson: the most impactful GPU optimizations often come from rethinking the algorithm, not from micro-optimizing a given implementation.

---

| [◀ Chapter 147: High-Frequency Trading Systems](../chapter-147-hft-systems/00-introduction.md) | [Chapter 148: GPU Programming (CUDA/Compute)](00-introduction.md) | [Chapter 149: Embedded and Real-Time C++](../chapter-149-embedded-realtime/00-introduction.md) ▶ |
