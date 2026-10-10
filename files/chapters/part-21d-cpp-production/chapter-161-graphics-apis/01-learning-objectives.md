## Learning Objectives

By the end of this chapter you will be able to do the following at a level that is defensible in a senior or staff interview at NVIDIA, AMD, Apple, Microsoft, Epic, Unity, or any AAA game studio.

### GPU Architecture

- Explain the SIMT execution model and how it differs from CPU SIMD. Describe a warp on NVIDIA and a wavefront on AMD, the consequences of divergent control flow, and how predication is used to handle small divergences without full serialization.
- Walk through the GPU memory hierarchy: registers per lane, shared memory / LDS / threadgroup memory, L1 / L2 caches, HBM or GDDR. Quote approximate bandwidth and latency numbers for current hardware (Ada Lovelace, RDNA 3, Apple M3 / M4, Hopper, Blackwell).
- Define occupancy as a function of register pressure, shared memory use, and thread count, and explain why higher occupancy is not always better.
- Describe the role of tensor cores (NVIDIA), matrix cores (AMD CDNA / RDNA 3), and AMX / Apple Neural Engine. Identify what operations they accelerate and the data types they support.
- Explain RT cores (NVIDIA), Ray Accelerators (AMD), and the RT hardware in Apple A17 Pro / M3+. Describe BVH traversal acceleration and box / triangle intersection.

### Vulkan

- Build a minimum Vulkan application from instance to swapchain to render pass to presentation, in pure C++.
- Explain the queue family model, the difference between graphics, compute, transfer, and sparse binding queues, and how to discover them on a physical device.
- Describe the descriptor set model, descriptor pools, descriptor set layouts, push constants, and when to use each.
- Implement command buffer recording across multiple threads, primary versus secondary command buffers, and command pool reset strategies.
- Use VkRenderPass and the Vulkan 1.3 dynamic rendering extension. Explain when each is preferable and the tile-based GPU implications.
- Use timeline semaphores (Vulkan 1.2) for cross-queue synchronization and CPU-GPU coordination, replacing the legacy binary semaphore plus fence pattern.

### Vulkan Memory and Synchronization

- Use VkDeviceMemory directly and via VMA. Explain the standard memory types: device-local, host-visible, host-coherent, and lazily-allocated for tile memory.
- Implement a sub-allocator over VkDeviceMemory blocks, including a free-list strategy and a buddy allocator, and explain when to use each.
- Use pipeline barriers, image memory barriers, and buffer memory barriers correctly. Identify the source and destination stage masks and access masks for common transitions.
- Explain VK_KHR_synchronization2 and how it simplifies the legacy stage / access mask split.
- Diagnose common synchronization bugs: missing barriers, over-broad pipeline stages, layout transitions on the wrong queue, write-after-write hazards across frames.

### Metal and D3D12

- Build a minimum Metal renderer using MTLDevice, MTLCommandQueue, MTLRenderPipelineState, and MTLArgumentBuffer.
- Explain Metal 3 features including mesh shaders, MetalRT, MetalFX upscaling, and how heaps and resource aliasing work on Apple Silicon's unified memory.
- Build a minimum D3D12 renderer including device creation, command queue, swap chain, command list recording, root signature, and descriptor heap management.
- Explain D3D12 resource states, the resource state model, split barriers, and enhanced barriers (D3D12 1.7+).
- Use D3D12 work graphs to dispatch GPU-driven work without CPU round trips.
- Use GPU-based validation and DRED breadcrumbs for hang post-mortem.

### Modern Rendering Techniques

- Implement deferred shading, tiled forward shading, and clustered shading, and quantify the trade-offs between them in terms of bandwidth, register pressure, and lighting quality.
- Implement a visibility buffer renderer and explain its bandwidth advantages on memory-constrained hardware.
- Implement GPU-driven rendering with indirect draws, compute-based culling, and a hierarchical Z-buffer for occlusion culling.
- Implement frustum culling, distance culling, occlusion culling, and small-feature culling on the GPU.

### Shaders, Bindless, and Modern Pipeline

- Write shaders in HLSL, GLSL, and MSL. Compile HLSL to SPIR-V via dxc. Compile GLSL to SPIR-V via glslang. Explain the role of slang for cross-API shader authoring.
- Implement bindless rendering using descriptor indexing in Vulkan, descriptor heaps in D3D12, and argument buffers in Metal. Explain why bindless is now standard for AAA renderers.
- Implement a mesh shader / amplification shader pipeline and meshlet generation. Explain the conceptual model of Nanite-style virtualized geometry.
- Build a runtime shader cache with disk persistence, pipeline library serialization, and PSO precompilation strategies.

### Raytracing and Compute

- Implement a complete raytraced renderer using VK_KHR_ray_tracing_pipeline. Build BLAS and TLAS structures, write ray-gen, closest-hit, miss, and any-hit shaders.
- Implement DXR equivalents in D3D12 and MetalRT equivalents on Apple platforms. Identify the API differences and the underlying hardware similarities.
- Compare CUDA, Vulkan compute, OpenCL, SYCL, ROCm HIP. Explain when to choose each based on portability, performance, and ecosystem maturity.

### Production Engineering

- Profile a frame using Nsight Graphics, Radeon GPU Profiler, and Xcode Metal frame capture. Read a wave occupancy chart, a memory bandwidth chart, and a barrier dependency graph.
- Diagnose a GPU hang using DRED on D3D12 and NV device diagnostics on Vulkan. Write breadcrumb code that survives a TDR and points to the failing draw call.
- Build a frame graph that automatically derives transient resource lifetimes and inserts the minimum required barriers, in the style of Yuriy O'Donnell's FrameGraph.
- Manage a color pipeline from sRGB authoring through linear-light shading to HDR10 output, including ACES tonemapping and sRGB-to-BT.2020 conversion.

### Cross-Domain Application

- Explain how Chromium's GPU process uses Vulkan and D3D12 to drive Skia 2D rasterization and the compositor.
- Explain how Blender Cycles uses CUDA, OptiX, HIP, and Metal as parallel rendering backends behind a shared C++ kernel.
- Explain how headless rendering pipelines for ML data generation work, and how Omniverse and Isaac Sim use Vulkan offscreen rendering at scale.

If you can do all of the above, you are ready to interview for any graphics infrastructure role at any company in the industry.

---
