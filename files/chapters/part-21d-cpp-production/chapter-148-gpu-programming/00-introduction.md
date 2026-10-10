# Chapter 148: GPU Programming (CUDA/Compute)

> "The GPU is not just a graphics chip anymore, it is the most powerful parallel computer ever built.", Jensen Huang

A modern NVIDIA H100 SXM5 delivers 3,958 teraFLOPS of FP8 throughput. To put that number in perspective: the entire planet's combined computing capacity in the year 2000 was estimated at roughly 1 to 3 petaFLOPS. A single GPU card, fitting in one PCIe slot, now exceeds that. GPU hardware has undergone one of the most dramatic performance trajectories in engineering history, and C++ is the language that unlocks it.

This chapter is about GPU programming from first principles through production ML inference. We start with CUDA kernels, thread hierarchies, and memory management, the foundation every GPU engineer must understand. We then move into shared memory optimization, warp-level primitives, and memory coalescing, which separate naïve GPU code from code that actually saturates hardware. The second half covers cuBLAS and cuDNN (NVIDIA's production compute libraries), TensorRT (the inference optimization stack behind most production ML serving), and cross-platform alternatives including OpenCL, SYCL, Vulkan compute, and Metal.

## Why C++ for GPU Programming

Every major ML framework has a C++ CUDA core. PyTorch's `aten` library is C++ with CUDA extensions. TensorFlow's execution engine is C++. JAX compiles via XLA, which is C++. When researchers write a new attention mechanism or activation function, the production CUDA kernel is C++. When an inference team cuts latency from 5ms to 0.15ms using TensorRT, that workflow is C++. The Python and Go layers orchestrate. C++ executes.

Go engineers working at ML companies will frequently encounter this architecture: Go handles gRPC serving, load balancing, request batching, and data pipelines. C++ owns the GPU computation. Understanding the GPU layer, even if you never write a kernel yourself, makes you dramatically more effective at the system boundary.

## GPU Architecture in One Paragraph

A GPU is a massively parallel processor optimized for throughput rather than latency. Where a CPU has 8-128 high-frequency out-of-order cores designed to minimize latency for a single thread, a GPU has thousands of simpler cores organized into Streaming Multiprocessors (SMs). An NVIDIA H100 has 132 SMs, each with 128 CUDA cores, 4 Tensor Core units, and 256KB of on-chip shared memory/L1. The GPU hides memory latency not through caching (as a CPU does) but through massive thread count: when one warp of 32 threads is waiting for memory, the SM instantly switches to another warp. This requires thousands of threads to be in-flight simultaneously, which means GPU programming is fundamentally about expressing problems as fine-grained parallelism.

## What This Chapter Covers

- **CUDA fundamentals**: thread hierarchy (threads, blocks, grids, warps), kernel launch syntax, memory management (`cudaMalloc`, `cudaMemcpy`, unified memory, pinned memory), and CUDA streams for async execution.

- **Shared memory and warp primitives**: the on-chip SRAM that gives 50x bandwidth over global memory, tiled matrix multiplication, bank conflict avoidance, and warp-level shuffle operations.

- **Memory coalescing and occupancy**: how access patterns determine whether you see 2 TB/s or 60 GB/s of effective bandwidth, AoS vs SoA data layout, the roofline model, and tensor core programming.

- **cuBLAS and cuDNN**: NVIDIA's production libraries for matrix operations and deep learning primitives, the building blocks of every neural network inference engine.

- **TensorRT**: the complete ML inference optimization pipeline from ONNX model through layer fusion, INT8 calibration, engine serialization, and production deployment.

- **OpenCL and SYCL**: cross-platform GPU programming for when you need to target AMD, Intel, or Apple hardware alongside NVIDIA.

- **Vulkan compute and Metal**: compute shaders for graphics-API-adjacent GPU work and Apple Silicon's unified memory architecture.

- **Go integration patterns**: how Go engineers interface with GPU systems in practice, Triton Inference Server, CGo bindings, and the architectural division between Go orchestration and C++ computation.

By the end of this chapter you will be able to write, profile, and optimize real CUDA kernels, understand the performance model of GPU hardware, navigate the cuBLAS/cuDNN/TensorRT production stack, and reason clearly about where GPU code belongs in a system and how to expose it across language boundaries.

---
