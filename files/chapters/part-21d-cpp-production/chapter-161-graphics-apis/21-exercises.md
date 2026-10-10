## Exercises

Six labs at progressive difficulty. Each builds on the previous. Doing all six produces a publishable mini-engine and the portfolio piece for a graphics-engineering interview.

### Lab 1: Triangle in Vulkan and D3D12 (Beginner)

**Goal**: Render a colored triangle on screen using Vulkan on Linux/Windows and D3D12 on Windows. Same triangle, two backends, shared application code.

**Tasks**:

1. Create instance, device, swapchain, render pass (or dynamic rendering for Vulkan), and present a clear color.
2. Write a vertex and fragment shader in HLSL. Cross-compile to SPIR-V via dxc for Vulkan and DXIL for D3D12.
3. Create a vertex buffer with three vertices (position, color), draw, present.
4. Validate that both backends produce pixel-identical output.

**Acceptance**: Both backends render a triangle with the same RGB gradient. Validation layer (Vulkan) and debug layer (D3D12) report no errors. Frame time well under 16ms.

**Stretch**: Add a second pass that downsamples the framebuffer to half-resolution, then upsamples in a third pass. Implement the synchronization correctly.

### Lab 2: GPU-Driven Rendering of 100K Cubes (Intermediate)

**Goal**: Render 100,000 instanced cubes with GPU-side frustum and occlusion culling, dispatching draws via `DrawIndexedIndirectCount`.

**Tasks**:

1. Upload a static buffer of 100,000 cube transforms and per-instance data (color, scale).
2. Compute shader: each thread reads one cube, performs frustum culling against a CPU-uploaded view frustum, writes survivors to a compact indirect draw buffer.
3. Issue one indirect draw with `DrawIndexedIndirectCount`.
4. Add a Hi-Z occlusion pass: build a hierarchical depth pyramid from the previous frame's depth, use it to occlusion-cull cubes that are behind closer cubes.
5. Bindless: bind one descriptor set with the instance buffer, the indirect buffer, and a per-instance texture array. Use SM 6.6 dynamic resources or descriptor indexing.

**Acceptance**: 100,000 cubes at 60 fps on any RTX 30+ or RX 6000+ GPU. Per-frame CPU time under 1 ms. Profiler shows GPU culling rejects 60+ percent of cubes when camera looks at one corner.

**Stretch**: Add LOD selection. Three cube meshes at decreasing detail, the compute shader picks the LOD based on screen-space size.

### Lab 3: Frame Graph (Intermediate)

**Goal**: Build a frame graph in C++ that auto-aliases transient resources and emits Vulkan barriers.

**Tasks**:

1. Define `FrameGraph`, `Pass`, `VirtualResource` types.
2. Implement `add_pass` that takes setup and execute lambdas. Setup declares reads/writes, execute records commands.
3. Implement `compile`: topological sort, liveness analysis, physical memory aliasing for non-overlapping resources, barrier generation.
4. Implement `execute`: walk passes, bind physical resources, call execute lambdas with command buffers.
5. Build a deferred renderer using the frame graph: G-buffer pass, lighting pass, post-process pass, present.

**Acceptance**: Transient memory used by the graph is at least 30 percent less than the naive sum of resource sizes. Sync validation layer reports no errors. The same frame graph works on Vulkan and D3D12 backends behind your RHI.

**Stretch**: Add async compute scheduling. Mark passes as compute-only, the graph submits them on the compute queue with semaphore-based sync.

### Lab 4: Bindless Mesh Shader Renderer (Advanced)

**Goal**: Render a 5-million-triangle scene at 60 fps using mesh shaders, amplification-stage culling, and bindless textures.

**Tasks**:

1. Use meshoptimizer to split test meshes into meshlets. Store meshlet metadata (bounding sphere, normal cone) in a buffer.
2. Write an amplification shader that culls meshlets by frustum and backface (cone of normals), and dispatches mesh-shader workgroups for survivors.
3. Write a mesh shader that emits up to 64 vertices and 124 triangles per workgroup.
4. Bindless: textures live in a 1024-entry array indexed by material ID per meshlet. Material ID comes from a bindless material buffer indexed by instance ID.
5. Profile with Nsight or RGP. Confirm that occupancy is high and culling rejection is 70 percent or better.

**Acceptance**: 5M triangles at 60 fps on RTX 30+ or RX 6000+. CPU side flat regardless of geometry count.

**Stretch**: Add a second LOD chain for distant objects, with the amplification shader picking the LOD per meshlet.

### Lab 5: Path Tracer with VK_KHR_ray_tracing (Advanced)

**Goal**: Implement a Monte Carlo path tracer in Vulkan.

**Tasks**:

1. Build BLASes for several test meshes, build a TLAS over instances.
2. Write a ray-generation shader that casts primary rays through pinhole camera.
3. Write a closest-hit shader that fetches vertex data via bindless, computes shading normal, samples next-event-estimation light from a buffer of point lights.
4. Implement bounce: at each hit, sample a cosine-weighted hemisphere direction, trace a recursive ray, accumulate.
5. Apply ACES tonemap and present.

**Acceptance**: Path-traced output of a Cornell box converges to a recognizable image in 30 seconds at 1080p. With temporal accumulation, real-time at 1 sample per pixel.

**Stretch**: Add ReSTIR DI. Each pixel maintains a reservoir of one chosen light, reused spatially and temporally. Direct lighting becomes nearly noise-free at 1 spp.

### Lab 6: Cross-Backend Renderer (Senior)

**Goal**: Take Lab 4's mesh-shader renderer and add D3D12 and Metal backends behind a common RHI. Same scene, same C++ application code, three native graphics APIs.

**Tasks**:

1. Define `rhi::Device`, `rhi::CommandList`, `rhi::Pipeline`, etc. Match the abstraction sketch in chapter section 14.
2. Implement Vulkan, D3D12, and Metal backends. Bindless paths for each.
3. Cross-compile shaders: HLSL via dxc to DXIL and SPIR-V, for Metal, run through SPIRV-Cross to MSL or write parallel MSL.
4. Implement frame graph compilation per backend.
5. Validate that all three backends produce visually-identical output (within tonemap precision).

**Acceptance**: Same scene at 60 fps on all three backends. Validation clean on each. Switching backend at runtime via a flag.

**Stretch**: Add HDR10 output on D3D12 and Metal (PQ encoding, BT.2020), graceful fallback to sRGB on systems without HDR.

---

These labs together produce a portfolio piece that is competitive for a graphics infrastructure role at any company in the industry. Lab 1 is a one-day starter. Lab 6 is a multi-week project for an experienced engineer.

---
