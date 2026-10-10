## Rendering Performance Engineering

Profiling is half the job. Optimization without profiling is guessing, and you will guess wrong. This section covers the production-grade GPU profilers and the optimization techniques they reveal.

### NVIDIA Nsight Graphics and Nsight Systems

Nsight Graphics is the per-frame GPU profiler. It captures a single frame, replays it on the GPU with full instrumentation, and reports per-draw timing, occupancy, memory throughput, cache hit rates, and shader-level metrics.

Nsight Systems is the system-wide profiler. It captures CPU and GPU timelines, shows command buffer submissions, GPU queue scheduling, async compute overlap, and where the CPU is waiting on the GPU.

Typical Nsight Graphics workflow:

1. Capture frame.
2. Open the frame in the GPU Trace activity.
3. Look at the throughput chart: SM use, VRAM bandwidth, L2 cache hit rate.
4. Identify the longest pass.
5. Drill into per-draw metrics: warp occupancy, register pressure, divergence rate, memory stall.
6. Look at the shader profiler: per-instruction cycle costs.

Common findings:

- **Low SM occupancy on a critical pass**. Cause: register pressure. Action: simplify the shader, reduce loop unrolling, lower precision where acceptable.
- **VRAM bandwidth-bound**. Cause: too many texture samples, fat G-buffer, no compression. Action: reduce sample count, use BC1/BC4 for low-frequency channels, packed normals.
- **Pipeline stalls between draws**. Cause: state changes, barrier between every draw. Action: sort by state, batch state changes, reduce barriers via render graph.

### Radeon GPU Profiler (RGP)

AMD's equivalent. Open with the Radeon Developer Panel, capture a frame, open in RGP. Strengths: wave-level timeline showing exactly what waves are running on each compute unit, async queue overlap visualization, barrier dependency analysis.

RGP's "Pipeline State" view shows the assembly (AMDGPU ISA) for each shader, with VGPR / SGPR usage per shader. This tells you exactly why occupancy is what it is.

```
Wavefronts: 4 of 8 max
  Limited by: VGPR usage (84 out of 256 per CU, 4 waves)
  To increase to 6 waves: reduce VGPR to 60
  To increase to 8 waves: reduce VGPR to 48
```

This level of detail is what allows AMD-driver-team engineers to extract the last 10 percent. A Vulkan shader that uses 84 VGPR on RDNA 3 is leaving 30 percent throughput on the table compared to the same shader rewritten to use 60 VGPR.

### Xcode Metal Frame Capture

Apple's Metal frame capture is built into Xcode. Cmd+Shift+M during debugging captures a frame. The viewer shows:

- Per-encoder timing.
- Bandwidth: tile memory traffic vs DRAM traffic.
- Per-shader cost.
- Counter sample buffer support: programmable counters at any point in the encoder.

The Metal Performance HUD (`MTL_HUD_ENABLED=1` in the environment) shows live frame rate, GPU time, memory pressure overlaid on the running app. Cheaper than full capture and good for regression tracking.

Apple's profiler emphasizes tile traffic. On Apple Silicon, the most expensive bandwidth operation is moving data from tile memory to DRAM. The capture shows tile load/store traffic per encoder so you can spot wasteful `StoreAction::Store` on attachments that should be `DontCare`.

### PIX for Windows

Microsoft's D3D12 frame profiler. Captures a frame, replays on the GPU, shows per-draw timing, root signature contents at each draw, descriptor heap usage, resource state transitions, GPU-based validation results.

PIX is essential for D3D12 development. It is free, integrates with Visual Studio, and is the only tool that gives full visibility into root signature spilling and descriptor heap layout issues.

### Common Optimization Targets

#### Draw Call Reduction

Each draw call has CPU overhead (driver work, command buffer encoding) and GPU overhead (state setup, pipeline cache miss). Modern explicit APIs reduced the per-call cost 5x to 10x compared to D3D11, but at 50,000 draws per frame the overhead still matters.

**Instancing**. Render the same mesh many times via `vkCmdDrawIndexed` with `instanceCount > 1`. Per-instance data (transform, material) comes from a per-instance buffer indexed by `gl_InstanceIndex`.

**Indirect rendering**. CPU writes a buffer of `DrawIndirect` records, GPU draws all in one call. Combined with GPU culling (compute writes the indirect buffer), this collapses thousands of CPU draw calls into one.

```cpp
struct DrawIndirect {
    uint32_t indexCount;
    uint32_t instanceCount;
    uint32_t firstIndex;
    int32_t  vertexOffset;
    uint32_t firstInstance;
};

vkCmdDrawIndexedIndirectCount(cmd, indirect_buf, 0, count_buf, 0,
                             max_draws, sizeof(DrawIndirect));
```

**State sorting**. Sort draws by pipeline state, then by descriptor set, then by vertex buffer. Adjacent draws share state, the driver and GPU avoid redundant flushes.

#### Texture Streaming

A 4K game has 30 to 80 GB of texture data. The GPU has 8 to 16 GB of VRAM. Stream textures based on what the player sees.

Mip-level streaming: load only the mip levels currently visible. Each frame, compute the desired mip from screen size of each object. Stream in higher mips when the object grows, stream out when it shrinks. Use `VK_EXT_pageable_device_local_memory` (Vulkan) or `EvictResources` (D3D12) to manage residency.

Sparse textures (virtual textures): a single logical texture is partially resident. Only visible tiles have backing memory. Used by id Tech (megatextures), Far Cry, Trials series.

#### Shader Optimization

Per-instruction cost is what the profiler shows. The big rocks:

**Memory access**. Texture sample is 200 to 800 cycles on a cache miss, 30 to 60 on a hit. Group nearby samples to maximize cache hits. Use linear sampling instead of point sampling (one sample reads four neighbors at near-zero extra cost).

**Branching**. Wave-uniform branches are free (the wave skips one path). Divergent branches serialize. Replace short branches with `lerp(a, b, mask)` where the cost of computing both paths is small.

**Math**. `rsqrt` is 1 cycle. `sqrt` is 4. `sin/cos` is 16. Use `Q_rsqrt` style approximations where 5-bit precision is enough. Avoid `pow(x, 2.2)` in tonemapping, use a piecewise linear approximation.

**Precision**. Use `min16float` (FP16) where the range fits. Two FP16 ops can run in one FP32 slot on some hardware. NVIDIA Ada and AMD RDNA both have packed FP16 throughput.

#### Bandwidth Reduction

VRAM bandwidth is often the limiting factor. 1 TB/s sounds vast but a 4K G-buffer at 80 bytes per pixel is 660 MB, reading it once is 660 ms / 1000 = 0.66 ms.

**Compress everything compressible**. BC1/BC3 for albedo. BC4 for single-channel masks. BC5 for tangent-space normals (two channels, reconstruct Z). BC6H for HDR. BC7 for high-quality normal-map-like data. These compress 4 to 8 times.

**Pack G-buffer aggressively**. Octahedral normals (16 bits instead of 24). YCoCg color (chroma at half resolution). RGBE for HDR (one byte per channel + shared exponent). Material ID into stencil byte (free, already there).

**Use tile memory on tile-based GPUs**. Forward+ on Apple Silicon avoids the G-buffer entirely. Ross's tile shading lets you keep intermediate results on-tile.

#### Async Compute Overlap

Run compute that does not depend on the current frame's graphics in parallel.

```
Graphics queue: shadow maps → G-buffer → shading → post → present
Compute queue:                light cull (next frame)  → particle sim → ssao
```

The compute queue runs at full throughput during the graphics queue's serial passes. RGP and Nsight Systems both visualize this overlap. A well-scheduled frame shows 70 to 90 percent compute queue occupancy.

### Latency vs Throughput

Frame time is what users feel. Throughput is what the average is. They are different.

A renderer at 60 fps average with 99th percentile 33 ms (one stutter per second) feels worse than 50 fps locked. Stutters come from:

- Pipeline compilation. Solved by precompilation.
- Memory reallocation. Solved by stable allocation, no per-frame VMA grow.
- Texture upload spikes. Solved by streaming budget enforcement.
- Garbage collection in scripting. Solved by avoiding GC.

Production engineering monitors 99th percentile, not average. Frame pacing tools (NVIDIA Reflex, AMD Anti-Lag) sync the CPU to the GPU's throughput so the 99th percentile drops.

### Junior to FAANG

A junior optimizes by guessing, halves a shader's instruction count for a pass that is bandwidth-bound, sees no improvement, gives up. A senior at NVIDIA opens Nsight, identifies that the pass is at 22 percent SM use with 14 percent L2 hit rate, restructures texture access to be coalesced, and the same pass drops 40 percent in one change.

---
