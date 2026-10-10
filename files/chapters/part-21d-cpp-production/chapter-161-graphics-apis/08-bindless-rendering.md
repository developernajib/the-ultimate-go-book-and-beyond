## Bindless Rendering

The single largest architectural shift in real-time rendering between 2015 and 2025 is the move from per-draw resource binding to bindless. Every modern AAA renderer (Unreal 5, Frostbite, id Tech 7, Decima, RE Engine) uses bindless. Every modern API supports it. If you are designing a renderer in 2026 and not using bindless, you have made the wrong choice.

### The Problem Bindless Solves

In the old model, each draw call binds the textures, buffers, and samplers it needs through descriptor sets (Vulkan), descriptor tables (D3D12), or argument buffers per draw (Metal). With 50,000 draws per frame, this is 50,000 binding operations on the CPU, each touching the driver's descriptor cache, each potentially invalidating the GPU's resource resident state.

The cost is twofold. CPU side, descriptor set allocation and update churn through the driver's bookkeeping. GPU side, every binding change invalidates instruction caches and descriptor caches in the SM.

Modern renderers want one binding per frame, not one per draw. The shader receives a draw index and looks up everything it needs (textures, vertex buffers, materials) from globally-resident tables. This is bindless.

### Bindless in Vulkan

Vulkan exposes bindless via `VK_EXT_descriptor_indexing` (core in 1.2). The descriptor set layout declares an unbounded array of descriptors with two flags:

- `VARIABLE_DESCRIPTOR_COUNT`: the array size is given at allocation time, not at layout time.
- `PARTIALLY_BOUND`: not all elements need valid descriptors. The shader must not access unbound elements.
- `UPDATE_AFTER_BIND`: descriptors can be updated after the set is bound to a command buffer (until the GPU consumes them).

```cpp
VkDescriptorSetLayoutBinding binding{
    .binding = 0,
    .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE,
    .descriptorCount = 100000,  // upper bound
    .stageFlags = VK_SHADER_STAGE_ALL,
};

VkDescriptorBindingFlags flags =
    VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT |
    VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT |
    VK_DESCRIPTOR_BINDING_VARIABLE_DESCRIPTOR_COUNT_BIT;

VkDescriptorSetLayoutBindingFlagsCreateInfo flag_info{
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO,
    .bindingCount = 1,
    .pBindingFlags = &flags,
};

VkDescriptorSetLayoutCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
    .pNext = &flag_info,
    .flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT,
    .bindingCount = 1,
    .pBindings = &binding,
};
```

In GLSL, the shader sees:

```glsl
#extension GL_EXT_nonuniform_qualifier : enable
layout(set = 0, binding = 0) uniform texture2D textures[];

layout(push_constant) uniform Push { uint texture_id; } push;

void main() {
    vec4 color = texture(sampler2D(textures[nonuniformEXT(push.texture_id)],
                                    s), uv);
}
```

`nonuniformEXT` tells the compiler that the index may differ across lanes in the warp. Without it, the compiler assumes the index is uniform and may generate code that produces wrong results for divergent indices.

### Bindless in D3D12

D3D12 has bindless via `SM6.6` direct heap indexing (`ResourceDescriptorHeap[idx]`) plus the descriptor heap model.

```hlsl
// SM 6.6 dynamic resources
struct PushConstants { uint texture_id; };
ConstantBuffer<PushConstants> push : register(b0);

float4 PSMain(float2 uv : TEXCOORD) : SV_Target {
    Texture2D tex = ResourceDescriptorHeap[push.texture_id];
    SamplerState s = SamplerDescriptorHeap[0];
    return tex.Sample(s, uv);
}
```

The application maintains one large CBV/SRV/UAV descriptor heap and assigns IDs to resources. Adding a new texture writes a descriptor at the next free slot and remembers the slot ID. The slot ID is what the shader receives.

```cpp
class BindlessHeap {
public:
    UINT add_texture(ID3D12Resource* res, const D3D12_SHADER_RESOURCE_VIEW_DESC& d) {
        UINT slot = next_slot_++;
        D3D12_CPU_DESCRIPTOR_HANDLE h = cpu_start_;
        h.ptr += slot * inc_;
        device_->CreateShaderResourceView(res, &d, h);
        return slot;
    }
private:
    ID3D12Device* device_;
    D3D12_CPU_DESCRIPTOR_HANDLE cpu_start_;
    UINT inc_;
    std::atomic<UINT> next_slot_{0};
};
```

The root signature has a single descriptor table covering the heap, plus root constants for the per-draw IDs. Per-draw cost is one root constant write, near-zero CPU.

### Bindless in Metal

Metal achieves bindless via tier 2 argument buffers (Apple7+, all current Apple Silicon). An argument buffer encodes pointers to thousands of textures and buffers. The shader sees one buffer parameter and indexes in.

```msl
struct Bindless {
    array<texture2d<float>, 100000> textures;
    array<sampler, 16> samplers;
    device const Material* materials;
};

fragment float4 fs(VOut in [[stage_in]],
                   constant Bindless& b [[buffer(0)]],
                   constant uint& tex_id [[buffer(1)]]) {
    return b.textures[tex_id].sample(b.samplers[0], in.uv);
}
```

Apple's `MTL::ResidencySet` is the matching CPU-side API: one set holds all bindless resources, the queue is told to keep them resident, the per-frame cost is constant regardless of how many resources are referenced.

### Bindless Vertex Pulling

The same idea extends to vertex buffers. Instead of using fixed-function vertex input layouts, the vertex shader receives a vertex ID and pulls vertex attributes from a buffer indexed by ID.

```hlsl
struct Vertex { float3 pos; float3 normal; float2 uv; };
StructuredBuffer<Vertex> vertices[] : register(t0, space1);

struct DrawInfo { uint vbuf_id; uint ibuf_id; uint material_id; };
ConstantBuffer<DrawInfo> draw : register(b0);

VOut VSMain(uint vid : SV_VertexID) {
    StructuredBuffer<Vertex> vb = vertices[draw.vbuf_id];
    Vertex v = vb[vid];
    // ... transform ...
}
```

This eliminates input layout state entirely. Switching meshes is one root constant change. Combined with bindless textures and bindless materials, the entire pipeline state for a draw is encoded in a few DWORDs of root constants.

### GPU-Driven Rendering with Bindless

Bindless is the foundation for GPU-driven rendering. A compute shader reads a draw list, performs frustum and occlusion culling, writes a compacted indirect draw buffer, and a single `DrawIndexedIndirectCount` draws everything that survived. Each draw indexes into bindless tables for its mesh and material. The CPU never touches per-draw bindings.

```cpp
// CPU side, once per frame
cmd->BindPipeline(culling_pso);
cmd->BindDescriptorSets(/* one bindless set */);
cmd->Dispatch(num_objects / 64, 1, 1);  // GPU culling

// barrier on the indirect buffer
// ...

cmd->BindPipeline(render_pso);
cmd->BindDescriptorSets(/* same set */);
cmd->DrawIndexedIndirectCount(indirect_buf, 0, count_buf, 0,
                              max_draws, sizeof(DrawIndirect));
```

This is the architecture of Nanite's software rasterizer, of Unreal's Lumen surface cache, of every modern GPU-driven renderer.

### Pitfalls

**Hardware divergence.** When the descriptor index varies across lanes in a wave, the hardware must serialize loads. On NVIDIA this is fast (warp-level lookup). On older AMD GCN it can be slow. Sort draws by texture or material to reduce divergence.

**Validation overhead.** With 100,000 textures in one set, validation layers slow to a crawl. Use `VK_EXT_descriptor_buffer` or D3D12's GPU-based validation with a bindless heap and accept the slowdown only for bringup.

**Driver heap limits.** Some drivers cap shader-visible descriptor heap size. AMD historically limits to 1 million descriptors per heap. Above that you split heaps and switch between them, which costs.

**Resource residency.** The driver does not know which descriptors will actually be sampled. On D3D12 with PIX, all descriptors in the bound heap are considered referenced, which can pressure VRAM. Use `MakeResident` / `Evict` to manage this, or rely on residency sets in Metal.

### Junior to FAANG

A junior reads a tutorial that binds a descriptor set per draw and ships a renderer with 30 percent CPU spent in driver descriptor management. A senior at NVIDIA or Epic builds a bindless renderer with one descriptor set bound per frame, draws are encoded by writing root constants only, GPU culling produces the indirect buffer, and CPU-side render time drops from 4ms to 0.4ms while supporting 5x more objects.

---
