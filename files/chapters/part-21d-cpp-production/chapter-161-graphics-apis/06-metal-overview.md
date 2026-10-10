## Metal Overview

Metal is Apple's graphics and compute API, the only API that ships on iOS, iPadOS, macOS, tvOS, and visionOS. It is the lowest-level GPU access on Apple platforms. There is no OpenGL on modern Apple OSes (deprecated since 2018, removed from Vision Pro entirely). Vulkan runs only via MoltenVK, which is a translation layer onto Metal. If you ship on Apple, you ship Metal.

Metal is a C++ and Objective-C++ API. There is also a pure C++ binding (`metal-cpp`) that Apple maintains and ships in the public SDK, which lets you write Metal applications without ever touching Objective-C.

### metal-cpp Setup

```cpp
#define NS_PRIVATE_IMPLEMENTATION
#define MTL_PRIVATE_IMPLEMENTATION
#define CA_PRIVATE_IMPLEMENTATION
#include <Metal/Metal.hpp>
#include <Foundation/Foundation.hpp>
#include <QuartzCore/QuartzCore.hpp>

int main() {
    NS::AutoreleasePool* pool = NS::AutoreleasePool::alloc()->init();

    MTL::Device* device = MTL::CreateSystemDefaultDevice();
    if (!device) return 1;

    MTL::CommandQueue* queue = device->newCommandQueue();

    // ... rendering ...

    queue->release();
    device->release();
    pool->release();
    return 0;
}
```

The `release()` calls are the C++ equivalent of `[obj release]`. The autorelease pool drains anything created with `alloc()` that you forgot. metal-cpp follows the same retain/release semantics as the Objective-C API.

### MTLDevice

A `MTL::Device` is a GPU. On Apple Silicon there is one integrated GPU and `CreateSystemDefaultDevice()` returns it. On Intel Macs you may have multiple (Intel iGPU + AMD dGPU + external GPU) and you enumerate via `MTLCopyAllDevices`.

The device exposes capabilities through GPU families (`MTL::GPUFamilyApple7`, `MTL::GPUFamilyApple9` for M3+, `MTL::GPUFamilyMac2`). You query support with `device->supportsFamily(MTL::GPUFamilyApple7)`. M3 and later are family Apple9. Iceland-class A17 Pro is also Apple9.

Key feature levels:

- Apple7 (A14, M1): mesh shaders absent, raytracing in software via Metal Performance Shaders.
- Apple8 (A15, M2): MetalFX upscaling, ray tracing accelerated.
- Apple9 (A17 Pro, M3+): hardware mesh shaders, hardware-accelerated BVH traversal, dynamic caching for register pressure spikes.

### Command Queue and Command Buffer

Metal's command model parallels Vulkan's but with slightly different naming. A `MTL::CommandQueue` produces `MTL::CommandBuffer` objects. Each command buffer holds one or more **encoders** (render, compute, blit, accelerator) which write GPU commands.

```cpp
MTL::CommandBuffer* cmd = queue->commandBuffer();

MTL::RenderPassDescriptor* pass = MTL::RenderPassDescriptor::alloc()->init();
auto* color0 = pass->colorAttachments()->object(0);
color0->setTexture(drawable_texture);
color0->setLoadAction(MTL::LoadActionClear);
color0->setStoreAction(MTL::StoreActionStore);
color0->setClearColor(MTL::ClearColor(0.1, 0.2, 0.3, 1.0));

MTL::RenderCommandEncoder* enc = cmd->renderCommandEncoder(pass);
enc->setRenderPipelineState(pso);
enc->setVertexBuffer(vbuf, 0, 0);
enc->drawPrimitives(MTL::PrimitiveTypeTriangle, 0ULL, 3ULL);
enc->endEncoding();

cmd->presentDrawable(drawable);
cmd->commit();
```

Note `setLoadAction(LoadActionClear)` and `setStoreAction(StoreActionStore)`. On the tile-based deferred renderer, `LoadActionClear` is genuinely free (no DRAM read), and `StoreActionDontCare` saves a DRAM write. Always specify both. This is the most important Metal performance principle: tile memory is precious, do not waste it.

### MTLRenderPipelineState

A pipeline state is the compiled object that bundles vertex/fragment shaders, vertex layout, blend state, and color attachment formats. Like a Vulkan pipeline.

```cpp
MTL::Library* lib = device->newDefaultLibrary();
MTL::Function* vs = lib->newFunction(NS::String::string("vs_main",
    NS::UTF8StringEncoding));
MTL::Function* fs = lib->newFunction(NS::String::string("fs_main",
    NS::UTF8StringEncoding));

MTL::RenderPipelineDescriptor* desc =
    MTL::RenderPipelineDescriptor::alloc()->init();
desc->setVertexFunction(vs);
desc->setFragmentFunction(fs);
desc->colorAttachments()->object(0)->setPixelFormat(
    MTL::PixelFormatBGRA8Unorm_sRGB);

NS::Error* err = nullptr;
MTL::RenderPipelineState* pso = device->newRenderPipelineState(desc, &err);
```

Shaders are written in MSL (Metal Shading Language), a C++14-derived language. They compile offline (`xcrun -sdk macosx metal`) into a `.metallib` file or at runtime via `device->newLibraryWithSource`.

```msl
#include <metal_stdlib>
using namespace metal;

struct VOut { float4 position [[position]]; float2 uv; };

vertex VOut vs_main(uint vid [[vertex_id]],
                    constant float4* positions [[buffer(0)]]) {
    VOut o;
    o.position = positions[vid];
    o.uv = positions[vid].xy * 0.5 + 0.5;
    return o;
}

fragment float4 fs_main(VOut in [[stage_in]],
                       texture2d<float> tex [[texture(0)]],
                       sampler s [[sampler(0)]]) {
    return tex.sample(s, in.uv);
}
```

### MTLArgumentBuffer

Argument buffers are Metal's bindless mechanism. An argument buffer is a buffer containing pointers (well, GPU resource handles) to other buffers, textures, and samplers. The shader receives one argument buffer pointer and indexes into it.

This is essential at scale. A frame with 50,000 draws cannot afford to bind individual textures per draw. With argument buffers (and the related `MTL::ResidencySet`), all of the frame's textures sit in one buffer and the draws index by ID.

```cpp
// Tier 2 argument buffers (Apple7+) support bindless via direct GPU pointers
MTL::ArgumentDescriptor* d = MTL::ArgumentDescriptor::alloc()->init();
d->setIndex(0);
d->setDataType(MTL::DataTypeTexture);
d->setTextureType(MTL::TextureType2D);
d->setArrayLength(1024);  // unbounded array of 1024 textures

NS::Array* descs = NS::Array::array(d);
MTL::ArgumentEncoder* enc = device->newArgumentEncoder(descs);
MTL::Buffer* abuf = device->newBuffer(enc->encodedLength(),
                                       MTL::ResourceStorageModeShared);
enc->setArgumentBuffer(abuf, 0);
for (size_t i = 0; i < my_textures.size(); ++i) {
    enc->setTexture(my_textures[i], i);
}
```

In MSL the shader sees:

```msl
struct Bindless { texture2d<float, access::sample> tex[1024]; };
fragment float4 fs(VOut in [[stage_in]],
                   constant Bindless& b [[buffer(0)]],
                   constant uint& tex_id [[buffer(1)]]) {
    return b.tex[tex_id].sample(s, in.uv);
}
```

### Heaps and Resource Aliasing

`MTL::Heap` is a sub-allocatable memory pool. You allocate textures and buffers from a heap and they share its underlying memory. On Apple Silicon's unified memory architecture, heaps support free aliasing: two transient resources can share the same memory if their lifetimes do not overlap.

```cpp
MTL::HeapDescriptor* hd = MTL::HeapDescriptor::alloc()->init();
hd->setSize(64 * 1024 * 1024);  // 64 MB
hd->setStorageMode(MTL::StorageModePrivate);
hd->setHazardTrackingMode(MTL::HazardTrackingModeUntracked);
MTL::Heap* heap = device->newHeap(hd);

MTL::TextureDescriptor* td = /* ... */;
MTL::Texture* a = heap->newTexture(td);
a->makeAliasable();  // memory can be reused

MTL::Texture* b = heap->newTexture(td);  // may overlap a
```

A frame graph implementation builds aliasing automatically: the lifetime analysis identifies non-overlapping transient resources and packs them into the same heap.

### Metal 3 Features

Metal 3 (macOS 13, iOS 16, expanded in macOS 14 / iOS 17 / macOS 15) adds the modern feature set:

**Mesh shaders**: `MTL::ComputePipelineState` for object/mesh stages plus a regular fragment shader. Same model as DX12 mesh shaders. Supported on Apple9.

**Raytracing**: `MTL::AccelerationStructure` (BLAS / TLAS), built via `MTL::AccelerationStructureCommandEncoder`. Shaders use `metal::raytracing::ray` and `metal::raytracing::intersector`. Hardware-accelerated BVH traversal on Apple8+.

**MetalFX upscaling**: `MTLFXTemporalScaler` and `MTLFXSpatialScaler`. Apple's equivalent of DLSS / FSR. Trained for Apple GPU characteristics, runs efficiently on the same SIMD groups as the rest of the frame.

**Function constants and function pointers**: Metal supports indirect function calls in shaders, used for ray tracing's ad-hoc material binding. Vulkan's equivalent is `VK_KHR_ray_tracing_pipeline`'s shader binding tables.

**ResidencySet (Metal 3.1)**: an explicit set of resources that must be GPU-resident during a command buffer's execution. Replaces `useResource` calls per encoder, much cheaper for bindless workloads.

```cpp
MTL::ResidencySetDescriptor* rsd = MTL::ResidencySetDescriptor::alloc()->init();
rsd->setLabel(NS::String::string("frame", NS::UTF8StringEncoding));
rsd->setInitialCapacity(4096);
NS::Error* err = nullptr;
MTL::ResidencySet* set = device->newResidencySet(rsd, &err);
set->addAllocations((const MTL::Allocation* const*)textures.data(),
                    textures.size());
set->commit();
queue->addResidencySet(set);
```

### Synchronization

Metal's hazard tracking is automatic by default. The driver inserts barriers between encoders that touch the same resource. This costs CPU time. For high-performance code you create resources with `MTL::HazardTrackingModeUntracked` and insert barriers manually with `MTL::Fence` (intra-buffer) and `MTL::Event` / `MTL::SharedEvent` (cross-buffer or cross-process).

```cpp
MTL::Event* event = device->newEvent();
cmd1->encodeSignalEvent(event, 1);
cmd2->encodeWait(event, 1);
```

Shared events synchronize across processes, useful for compositing servers and for splitting work between multiple commandQueue instances.

### Tile Shaders

On the tile-based renderer you can run compute work that operates directly on the tile's color and depth values without round-tripping to DRAM. This is the implementation strategy behind on-tile deferred shading and forward+ on Apple GPUs.

```msl
[[tile_function]] kernel void tile_resolve(
    metal::imageblock<float4> blk,
    ushort2 tid [[thread_position_in_threadgroup]]) {
    float4 v = blk.read(tid);
    blk.write(tonemap(v), tid);
}
```

The tile function runs after the main render encoder's fragment work, sees the tile memory directly, writes a transformed result. No barriers, no DRAM round trip. This is unique to tile-based GPUs and is one of the largest performance wins available on Apple Silicon.

### Junior to FAANG

A junior ports a Vulkan renderer to Metal by translating each call one-for-one and ignoring tile semantics. The renderer works and runs at 60 percent of the achievable performance. A senior at Apple's GPU team rewrites the render passes to use tile shading, switches transient targets to `LoadActionClear` and `StoreActionDontCare`, moves history textures into a heap with aliasing, and the same content runs at 1.7x with lower power.

---
