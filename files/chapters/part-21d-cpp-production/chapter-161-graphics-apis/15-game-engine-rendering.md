## Game Engine Rendering

Modern AAA engines share an architecture even though their codebases are independent. This section describes that architecture, named after the influential 2017 GDC talk by Yuriy O'Donnell, "FrameGraph: Extensible Rendering Architecture in Frostbite", which became the template most major engines now follow.

Chapter 160 covers the CPU side of that engine, the frame loop, the entity storage, the job system, and the memory discipline that produce the draw calls this section consumes. This section starts where it stops.

### Unreal RHI

Unreal's RHI (Render Hardware Interface) is the abstraction layer above D3D12, Vulkan, Metal, and console APIs. It runs on the **rendering thread**, a single dedicated thread separate from the game thread. Game logic enqueues commands, the rendering thread translates them.

Unreal's RHI encodes commands in two passes:

1. **Game thread to rendering thread** through `ENQUEUE_RENDER_COMMAND` macros.
2. **Rendering thread to RHI thread** which actually calls the platform API.

Above the RHI sits the **Render Dependency Graph (RDG)**, Unreal 5's replacement for the older render pipelines. RDG declares passes and resources, computes lifetimes, allocates transient memory from a pool, and emits barriers automatically. This is the FrameGraph pattern applied to Unreal's pipeline.

```cpp
FRDGTextureRef gbuffer_albedo = GraphBuilder.CreateTexture(
    FRDGTextureDesc::Create2D(extent, PF_R8G8B8A8, FClearValueBinding::Black,
                              TexCreate_RenderTargetable),
    TEXT("GBufferAlbedo"));

GraphBuilder.AddPass(
    RDG_EVENT_NAME("BasePass"),
    pass_params,
    ERDGPassFlags::Raster,
    [pass_params](FRHICommandList& cmd) {
        // ...draw calls...
    });
```

### Unity Scriptable Render Pipeline

Unity's SRP is a C++ low-level renderer (the engine's native side) with a C# scripting layer. The two production SRPs are URP (Universal) and HDRP (High Definition). Unity 2023+ ships a render graph similar in spirit to FrameGraph.

The architecture is the same as Unreal: declare passes, declare resources, the graph computes execution order and barriers, the result is recorded on the rendering thread. The C# layer is the part developers see, but underneath, the same low-level command buffer encoding happens in C++.

### Frostbite

DICE's Frostbite engine, used across EA, was the originator of FrameGraph. The 2017 talk described a system where:

- Each pass is a function with declared inputs and outputs.
- Resources are virtual until the graph compiles.
- The graph performs liveness analysis on resources.
- Memory aliasing reuses the same physical memory for non-overlapping resources.
- Barriers are computed automatically from the producer/consumer relationship.

```cpp
// Pseudocode in the Frostbite/Unreal style
struct GBufferData {
    FrameGraphResource albedo;
    FrameGraphResource normal;
    FrameGraphResource depth;
};

GBufferData add_gbuffer_pass(FrameGraph& fg) {
    return fg.add_pass<GBufferData>("gbuffer",
        [&](FrameGraph::Builder& b, GBufferData& data) {
            data.albedo = b.create_texture("albedo", { RGBA8, w, h });
            data.normal = b.create_texture("normal", { RGB10A2, w, h });
            data.depth = b.create_texture("depth", { D32F, w, h });
            b.write(data.albedo);
            b.write(data.normal);
            b.write(data.depth);
        },
        [=](const GBufferData& data, CommandList& cmd) {
            // execute
        });
}
```

The same patterns appear in id Tech 6 / 7, Capcom's RE Engine, Insomniac's engine, Sony's Decima, Sucker Punch's Sucker Punch engine, all built around a frame graph pattern.

### Doom Eternal Renderer

The Doom Eternal renderer, id Tech 7, runs at 60 fps locked on PS4 with 22 million triangles per frame at 1080p. Its architecture:

- Vulkan only (one API, no D3D12 path).
- Custom job scheduler. Render commands are recorded across 8 worker threads, merged at submit time.
- GPU-driven rendering. CPU uploads scene as buffers, GPU compute culls and produces indirect draws.
- Bindless. One descriptor set per frame, root constants per draw.
- Visibility buffer geometry pass, deferred shading using the visibility buffer.
- Async compute for light culling, particle simulation, GPU skinning, all overlapping the graphics queue.
- Custom Vulkan memory allocator, no VMA.
- Render graph for sync.

The result is a frame that hits 16.6 ms with thousands of dynamic lights, dynamic global illumination, hundreds of dynamic shadows, and 22 million triangles. id Software's writeups and GDC talks are required reading for senior graphics engineers.

### Frame Graph: How It Works

The frame graph runs in three phases.

**Setup phase.** The application calls a sequence of `add_pass` functions. Each pass declares the resources it reads and writes. Resources are not yet allocated, they are virtual handles. Setup is single-threaded, fast, and produces a DAG.

**Compile phase.** The graph performs:

1. Topological sort to determine execution order.
2. Liveness analysis: for each virtual resource, find the first pass that reads or writes it (birth) and the last pass that reads it (death).
3. Memory allocation: pack non-overlapping resources into the same physical memory slot. A heap allocator over a single large `VkDeviceMemory` block does this.
4. Barrier generation: between consecutive passes that touch a shared resource, emit the appropriate barrier (transition, queue ownership, layout).
5. Async compute scheduling: passes marked compute-only can run on the async compute queue overlapping graphics.

**Execute phase.** The graph walks the sorted passes, binds the physical resources to the virtual handles, and calls each pass's lambda with a command list. The lambdas record commands. The graph submits the resulting command lists.

```cpp
class FrameGraph {
public:
    template<typename Data, typename Setup, typename Execute>
    PassRef add_pass(const char* name, Setup&& setup, Execute&& execute);

    void compile();
    void execute(Device& device, CommandList& cmd);

private:
    struct VirtualResource {
        ResourceDesc desc;
        uint32_t first_pass;
        uint32_t last_pass;
        uint32_t physical_slot;
    };
    struct Pass {
        std::string name;
        std::function<void(CommandList&)> execute;
        std::vector<ResourceUse> reads;
        std::vector<ResourceUse> writes;
    };

    std::vector<Pass> passes_;
    std::vector<VirtualResource> resources_;
    std::vector<PhysicalResource> physical_;
};
```

### Resource Aliasing

The clever part is aliasing. Two virtual resources whose lifetimes do not overlap can share the same physical memory.

```
Pass A: writes X
Pass B: reads X, writes Y
Pass C: reads Y, writes Z
Pass D: reads Z

Lifetimes:
  X: passes A to B
  Y: passes B to C
  Z: passes C to D

X and Z do not overlap. Same physical memory.
Y overlaps both X and Z. Different physical memory.

Result: 2 physical allocations instead of 3.
```

In a real frame graph for a deferred renderer, aliasing typically reduces transient memory by 40 to 60 percent. The HDR scene buffer can share memory with the bloom downsample which can share memory with the tonemap output, because their lifetimes are sequential.

### Async Compute Scheduling

The frame graph also schedules work across queues. A compute pass with no synchronization dependency on a graphics pass can run concurrently. The scheduler emits a semaphore signal at the producing graphics submit, a wait at the consuming compute submit, and a corresponding pair to merge results back.

Typical async compute uses:

- Light culling. Runs in parallel with the previous frame's geometry pass. Result feeds the current frame's shading.
- GPU skinning. Runs in parallel with shadow maps for static geometry.
- Particle simulation. Runs in parallel with the main render pass.
- BVH refit. Runs in parallel with the rasterization pass.

A well-scheduled engine can hide 30 to 50 percent of compute work on the async queue, getting that work for free.

### Render Thread, RHI Thread, GPU Thread

A modern engine has at least three thread roles in the render path.

1. **Render thread**. Builds the frame graph, issues high-level commands, manages render targets.
2. **RHI thread (or worker pool)**. Translates render commands to platform API calls, records command buffers.
3. **GPU**. Executes the command buffers.

Unreal explicitly names these. Unity has equivalent threads internally. The pipelining means the CPU is one to two frames ahead of the GPU at all times.

### Pipeline State Variants

Every shader has variants for different feature combinations: with shadows / without, with skinning / without, with translucency / without. Combinatorial explosion gives 1000+ variants per material in AAA games. The engine precompiles them at install time using a "PSO precaching" system.

Unreal 5's "PSO precaching" walks the entire content set, identifies needed PSOs, and compiles them in a worker on first launch. Without it, the player hits multi-second hitches on first encounter with each material. With it, gameplay is smooth.

### Junior to FAANG

A junior writes a renderer with manually-allocated render targets, hand-written barriers, and ships an engine that uses 3 GB of transient memory and crashes on 4K HDR. A senior at id, Epic, or DICE builds a frame graph, halves transient memory through aliasing, schedules async compute, and ships an engine that fits in 1 GB transient and hits 60 fps with quality settings the junior's engine cannot enable.

---
