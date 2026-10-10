## Interview Questions

Fifteen questions, each at the level of a senior or staff graphics engineer interview at NVIDIA, AMD, Apple, Microsoft, Epic, Unity, Pixar, or any AAA studio. The expected answer is given in enough depth to actually pass the interview.

### 1. Explain warp divergence and how to mitigate it.

A warp on NVIDIA is 32 threads that execute in lockstep. When threads within a warp follow different control-flow paths, the hardware masks off inactive lanes and executes both paths serially. A 32-way divergence produces a 32x slowdown for that section.

Mitigations: align divergence boundaries to warp size (group similar work into the same warp), use predication for short branches (compute both paths and select), sort work by classification before dispatch, use wave intrinsics (`WaveActiveBallot`, `WavePrefixCountBits`) to compact divergent work, and avoid loops with data-dependent iteration counts where the longest case dominates.

### 2. What is occupancy, and is higher always better?

Occupancy is the ratio of active warps on a streaming multiprocessor to the maximum it can host. Limited by registers per thread, shared memory per block, and threads per block.

Higher is not always better. High occupancy hides memory latency by switching warps when one stalls. But beyond a certain point, additional occupancy gives no benefit, and the register pressure to achieve it costs throughput. Volkov's "Better Performance at Lower Occupancy" shows compute-bound kernels often hit peak at 25 to 50 percent occupancy. Profile and measure, do not assume.

### 3. Walk through a Vulkan frame from `vkAcquireNextImageKHR` to `vkQueuePresentKHR`.

Wait on the per-frame fence to ensure the previous use of frame resources is done. Acquire a swapchain image, signaling `image_acquired` semaphore. Reset the per-frame command pool. Record command buffers (across worker threads), beginning render passes (or dynamic rendering), drawing, ending render passes, transitioning the swapchain image to `PRESENT_SRC_KHR`. Submit to the graphics queue, waiting on `image_acquired` at `COLOR_ATTACHMENT_OUTPUT` stage, signaling `render_finished` semaphore and the per-frame fence. Present, waiting on `render_finished`.

### 4. What is a timeline semaphore and why prefer it over binary semaphores?

A timeline semaphore holds a monotonically increasing 64-bit counter. You signal a value, you wait for >= a value. It supports CPU and GPU on both signal and wait. Binary semaphores are single-use and cannot synchronize complex multi-queue dependency graphs without proliferating objects.

A modern Vulkan engine uses one timeline per queue. Frame N signals N. Cross-queue and CPU waits become "wait for timeline >= N - 2", uniformly. Replaces the legacy fence + binary semaphore tangle.

### 5. Explain bindless rendering, why it matters at scale, and how it differs in Vulkan, D3D12, and Metal.

Bindless lets a draw access any of a million resources via integer ID rather than per-draw binding. At 50,000 draws per frame, per-draw binding costs significant CPU and GPU state churn. Bindless reduces it to one bind per frame.

Vulkan: `VK_EXT_descriptor_indexing` with unbounded arrays in descriptor sets, `nonuniformEXT` qualifier in shader. D3D12: SM 6.6 `ResourceDescriptorHeap[idx]` plus a single CBV/SRV/UAV heap holding all resources. Metal: tier 2 argument buffers (Apple7+) that are arrays of textures and buffers, plus `MTL::ResidencySet` for residency.

### 6. What is the visibility buffer rendering technique, and why does it beat deferred shading on memory-constrained hardware?

Visibility buffer renders geometry into a single 32-bit buffer holding `(triangle_id, instance_id)` per pixel. A shading pass reads this, fetches the actual triangle data via bindless, computes barycentrics analytically, and shades.

It beats deferred because the G-buffer is 4 bytes per pixel instead of 80. Bandwidth is the dominant cost in modern rasterization, and a quarter G-buffer means quarter bandwidth on the geometry pass. Used by Doom Eternal and Nanite's micro-poly path.

### 7. Describe the difference between BLAS and TLAS in raytracing, and how you would update them efficiently for a scene with deformable objects.

BLAS is a per-mesh bounding volume hierarchy over triangles. TLAS is a hierarchy over instances, each pointing at a BLAS and carrying a transform.

For deformable meshes (skinned characters, simulated cloth), full BLAS rebuild per frame is too slow. Use `MODE_UPDATE` to refit the existing BLAS with new vertex positions, which preserves the topology of the BVH and updates leaf bounds in milliseconds. After a few frames the tree quality degrades, periodically issue a full rebuild on a budget. The TLAS rebuilds every frame because it tracks instance transforms, but it is small and cheap.

### 8. Explain mesh shaders and what problem they solve.

Mesh shaders replace the fixed vertex / hull / domain / geometry / tessellation pipeline with a programmable two-stage pipeline (amplification / mesh) plus the fragment shader. The application authors meshes split into meshlets (typically 64 vertices, 124 triangles each).

The problem: legacy pipeline forced one vertex shader invocation per vertex, no early culling, poor wave packing on indexed geometry. Mesh shaders enable per-meshlet frustum, backface, and small-feature culling in the amplification stage, rejecting 70 to 90 percent of geometry before any vertex work. They give explicit thread counts for tuning to wave width.

### 9. Compare CUDA and Vulkan compute. When would you pick each?

CUDA: NVIDIA only, best ML / HPC ecosystem (cuBLAS, cuDNN, NCCL), best tooling (Nsight Compute, Nsight Systems), direct access to tensor cores via `wmma`, supports modern C++ in device code.

Vulkan compute: cross-vendor (NVIDIA, AMD, Intel, ARM, Apple via MoltenVK, Adreno), tight integration with graphics (same memory, same descriptors), single source via SPIR-V.

Pick CUDA for dedicated ML / HPC on NVIDIA. Pick Vulkan compute for graphics-integrated compute (light culling, particles, GPU-driven rendering) and for cross-vendor portability where you cannot rely on CUDA.

### 10. What is the FrameGraph pattern, and what does it solve?

FrameGraph is a render-graph architecture from Frostbite (Yuriy O'Donnell, GDC 2017). The renderer declares passes and their input/output resources as virtual handles. The graph compiles: topological sort, liveness analysis, resource aliasing for non-overlapping lifetimes, automatic barrier emission, async compute scheduling.

It solves three problems: manual barrier management is error-prone and over-conservative, transient memory grows linearly with passes without aliasing, cross-queue scheduling is opaque without dependency analysis. Most modern engines (Unreal's RDG, Frostbite, RE Engine, Decima, id Tech) follow this pattern.

### 11. Why is async compute a performance win, and what work types are good candidates?

Modern GPUs schedule graphics and compute on different hardware schedulers. While the graphics queue is serializing through serial passes (shadow maps, geometry, post-process), compute queue work can run concurrently, hiding behind the graphics queue's natural pipeline gaps.

Good candidates: light culling for the next frame (independent of current geometry), GPU skinning for shadow maps (independent of main view), particle simulation (independent of current frame's render targets), BVH refit for raytracing, SSAO downsample chains. Bad candidates: anything reading current-frame's color or depth, anything that must complete before its dependent graphics pass.

### 12. Why is the move to tiled / clustered shading necessary at high light counts?

Naive forward shading iterates every light per pixel. With 1000 lights and 8 million pixels at 1080p, that is 8 billion light evaluations per frame, infeasible. Tiled forward (Forward+) splits the screen into 16x16 tiles, culls lights against each tile's frustum, and the fragment shader iterates only its tile's lights, typically 10 to 50 instead of 1000. Clustered extends to 3D (depth slices), reducing further by avoiding lights culled by depth.

The result is sub-linear scaling in light count, allowing thousands of dynamic lights at 60 fps.

### 13. Explain DRED and breadcrumbs, and why they are required for shipping D3D12.

When the GPU hangs, Windows TDRs (timeout detection and recovery) the device. Without DRED, you get "device removed" with no further information. With DRED enabled, the driver logs auto-breadcrumbs (a value written before each operation) and page-fault context (the GPU virtual address that caused the crash).

After a TDR, you query the breadcrumb data and find the exact `Draw` or `Dispatch` that hung. Combined with shader names and command list labels, you have a stack-trace-equivalent for GPU crashes. Required for shipping any D3D12 application because GPU hangs in customer environments are otherwise undebuggable.

### 14. Describe the correct color pipeline for an SDR renderer with sRGB textures.

Author textures in sRGB space. Sample with `_SRGB` formats so the hardware automatically converts to linear on read. Compute lighting in linear space (math is physically meaningful). Tonemap the linear HDR result to displayable range with ACES or Hable. Output to a `_SRGB` swapchain so the hardware encodes back to sRGB on write.

The most common bug is using non-`_SRGB` formats for color textures, which causes lighting math to operate in gamma space and produces incorrect results. Normal maps and data textures stay in linear (UNORM, not SRGB) because they encode data, not color.

### 15. You have a 16ms frame budget and a 25ms frame. How do you diagnose where the time went?

Start with a frame capture in the appropriate vendor profiler (Nsight Graphics, Radeon GPU Profiler, Xcode capture, PIX). Get the per-pass GPU timing first.

If one pass dominates: drill into per-draw timing within it. If it is shader-bound, check occupancy and instruction throughput. If it is bandwidth-bound, check L2 hit rate and reduce sample count, format size, or use compression. If it is geometry-bound, check vertex shader time and consider mesh shaders with culling.

If no one pass dominates: look for serial pipeline bubbles. Are barriers over-broad? Is the GPU idle waiting on the CPU? Use Nsight Systems / RGP to visualize CPU-GPU sync. Check async compute opportunity for parallel work.

If the CPU is the bottleneck (GPU is idle waiting on submits): check command buffer recording threading, descriptor set updates per draw, dynamic state changes, and pipeline state cache misses. Modern explicit APIs make CPU-bound graphics rare, but it happens with poorly-architected renderers.

---
