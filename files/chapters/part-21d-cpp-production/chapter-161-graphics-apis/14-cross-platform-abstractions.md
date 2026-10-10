## Cross-Platform Graphics Abstractions

If you ship on more than one platform, you need a layer that hides Vulkan, D3D12, and Metal behind a common interface. Building this layer is one of the most consequential architectural decisions in a graphics codebase. This section covers the existing libraries, the abstractions they make, and how to design your own.

### Existing Options

**bgfx (Branimir Karadzic)**. C++ rendering library with backends for D3D11, D3D12, Vulkan, Metal, OpenGL, OpenGL ES, WebGPU, GNM (PS4), AGC (PS5). Stateful API, command-buffer-driven internally. Used by Eclipse, Genie, MAME, several indie studios. Permissive license. Mature.

**Diligent Engine**. C++ engine with backends for D3D11, D3D12, Vulkan, OpenGL, OpenGL ES, Metal, WebGPU. More closely models the explicit APIs (so closer to D3D12/Vulkan in feel) than bgfx. Used by Diligent Studio's tools and several research projects.

**Sokol (Andre Weissflog)**. Header-only C library, minimal API, backends for D3D11, Metal, GL, GLES, WebGPU. Aimed at small games and demos. Very limited but readable.

**Dawn (Google)**. The implementation of WebGPU outside the browser. C++ runtime, backends for D3D12, Vulkan, Metal. WebGPU is the standardized portable API itself, so this is one path to portable graphics if you accept WebGPU's feature set (which lags Vulkan/D3D12 by about two years).

**The Forge (Confetti FX)**. Production cross-platform engine used in id Tech, used as middleware in some console ports. D3D12, Vulkan, Metal, plus consoles.

If you can use one of these, you save 6 to 18 person-months. The cases where you build your own are: you need full access to vendor extensions the abstraction does not expose, your engine has a particular threading or memory model that does not fit, or you are a major studio and the abstraction layer is a long-term investment.

### What to Abstract

The level of abstraction matters more than the choice of which API to model on. Two extremes.

**High-level: state machine.** Looks like D3D11. The application calls `SetTexture`, `SetVertexBuffer`, `SetShader`, `Draw`. The library tracks state and translates to whichever backend. Easy to use, hides everything, performance suffers because the abstraction loses information.

**Low-level: command buffer.** Looks like Vulkan / D3D12. The application records commands into a command buffer object that is roughly isomorphic to the backend's. The library is a thin translation. High performance, harder to use, exposes API differences.

Production engines pick low-level. Unreal RHI, Unity SRP's RenderGraph, Frostbite's RHI, id Tech's RHI all model after Vulkan / D3D12 directly because the explicit APIs are how the hardware actually works.

### What Not to Abstract

Some things differ enough between APIs that abstracting them costs more than it saves.

**Synchronization.** Vulkan barriers, D3D12 resource states, Metal automatic hazard tracking are fundamentally different models. A single abstraction either over-synchronizes (slow) or matches one API's model (leaks). Best practice: build a render graph that emits per-backend sync from a high-level dependency declaration.

**Memory types.** Vulkan exposes ten memory types. D3D12 has heap types (DEFAULT/UPLOAD/READBACK). Metal has storage modes (Shared, Managed, Private, Memoryless). Mapping between them is lossy. Most abstractions just expose three (GPU, CPU-write, CPU-read) and let the backend pick.

**Bindless layout.** Vulkan descriptor indexing, D3D12 SM 6.6 dynamic resources, Metal argument buffers all support bindless but differ in the binding model. Abstraction: expose "bindless table of textures by integer ID", let the backend implement.

**Shader source.** HLSL via dxc to DXIL and SPIR-V works for D3D12 + Vulkan. For Metal, cross-compile via SPIRV-Cross or write MSL separately.

### Sketch of a Thin RHI

```cpp
namespace rhi {

enum class Format { RGBA8_UNORM, RGBA16F, RGBA32F, D32F, ... };
enum class ResourceState { Common, RenderTarget, ShaderResource, UnorderedAccess,
                           CopySource, CopyDest, Present };

class Device {
public:
    virtual ~Device() = default;
    virtual std::unique_ptr<CommandList> create_command_list() = 0;
    virtual std::unique_ptr<Buffer> create_buffer(const BufferDesc&) = 0;
    virtual std::unique_ptr<Texture> create_texture(const TextureDesc&) = 0;
    virtual std::unique_ptr<Pipeline> create_graphics_pipeline(
        const GraphicsPipelineDesc&) = 0;
    virtual void submit(std::span<CommandList*> lists, Fence* signal) = 0;
    virtual void wait(Fence* fence) = 0;
};

class CommandList {
public:
    virtual ~CommandList() = default;
    virtual void begin() = 0;
    virtual void end() = 0;
    virtual void barrier(std::span<ResourceBarrier> barriers) = 0;
    virtual void begin_rendering(const RenderingDesc&) = 0;
    virtual void end_rendering() = 0;
    virtual void set_pipeline(Pipeline*) = 0;
    virtual void set_root_constants(uint32_t offset, std::span<const uint32_t>) = 0;
    virtual void draw(uint32_t vertex_count, uint32_t instance_count,
                     uint32_t first_vertex, uint32_t first_instance) = 0;
    virtual void draw_indexed_indirect(Buffer* args, uint32_t offset,
                                      uint32_t count, Buffer* count_buf,
                                      uint32_t count_offset) = 0;
    virtual void dispatch(uint32_t x, uint32_t y, uint32_t z) = 0;
    virtual void copy_buffer(Buffer* dst, uint64_t dst_off,
                            Buffer* src, uint64_t src_off, uint64_t size) = 0;
};

std::unique_ptr<Device> create_vulkan_device();
std::unique_ptr<Device> create_d3d12_device();
std::unique_ptr<Device> create_metal_device();

}
```

Each backend implements these interfaces. The cost of the virtual call per command is negligible at the granularity of a `draw` (the GPU has 100x more work than the dispatch overhead).

### Bindless in the RHI

```cpp
class Device {
public:
    virtual BindlessHandle add_texture_srv(Texture*) = 0;
    virtual BindlessHandle add_buffer_srv(Buffer*) = 0;
    virtual void remove_bindless(BindlessHandle) = 0;
};

// Application
auto h = device->add_texture_srv(my_texture);
// h.index is an integer the shader receives via root constant
cmd->set_root_constants(0, std::span(&h.index, 1));
cmd->draw(3, 1, 0, 0);
```

The Vulkan backend writes to a descriptor indexing pool. The D3D12 backend writes to a CBV/SRV/UAV heap slot. The Metal backend writes to a tier-2 argument buffer. Same calling code.

### Render Graph as the High-Level Layer

Above the RHI, the high-level interface for application code is a render graph. The application declares passes and their inputs and outputs as buffers and textures. The graph computes lifetimes, allocates transient resources via aliasing, emits the sync barriers, and executes.

```cpp
RenderGraph rg;
auto gbuffer = rg.create_texture("gbuffer", { format::RGBA16F, w, h });
auto depth = rg.create_texture("depth", { format::D32F, w, h });
auto shaded = rg.create_texture("shaded", { format::RGBA16F, w, h });

rg.add_pass("geo")
    .write(gbuffer, RenderTarget)
    .write(depth, DepthWrite)
    .execute([&](CommandList* cmd) {
        cmd->set_pipeline(geo_pso);
        cmd->draw_indexed_indirect(/*...*/);
    });

rg.add_pass("shade")
    .read(gbuffer, ShaderResource)
    .read(depth, ShaderResource)
    .write(shaded, UnorderedAccess)
    .execute([&](CommandList* cmd) {
        cmd->set_pipeline(shade_pso);
        cmd->dispatch(w/8, h/8, 1);
    });

rg.compile();
rg.execute(device, cmd);
```

This is the level engines (Frostbite FrameGraph, Unreal RenderGraph, Granite, more) operate at. Section 15 covers it in detail.

### Cross-Platform Pitfalls

**Coordinate systems.** Vulkan has Y-down NDC by default. D3D12 has Y-up. You either negate the projection matrix or use Vulkan's `VK_KHR_maintenance1` to flip. Pick one and stick with it.

**Texture layout origin.** D3D12 stores textures top-down. Vulkan / OpenGL conventions vary. Be explicit about `image.row[0]` representing top or bottom.

**Sample positions.** Default rasterization sample positions differ. For deterministic rendering across platforms (replay, network sync), set explicit sample positions via `VK_EXT_sample_locations` or D3D12's `SetSamplePositions`.

**Depth range.** D3D12 is 0-1, Vulkan is 0-1 by default but can use 0-1 inverse, OpenGL is -1 to 1. Use reverse-Z (close=1, far=0) everywhere for better precision.

**Memory mapping flushes.** Vulkan non-coherent memory needs explicit flushes. D3D12 UPLOAD heap is always coherent. Metal Shared mode is coherent on Apple Silicon. Hide this behind `Buffer::write` with a flush call internally.

### Junior to FAANG

A junior abstracts at the D3D11 level (state machine), ships a renderer that runs on Vulkan but at half the achievable performance because the abstraction inserts redundant state changes. A senior abstracts at the command-list level, builds a render graph for sync, and the same code runs at native performance on every backend.

---
