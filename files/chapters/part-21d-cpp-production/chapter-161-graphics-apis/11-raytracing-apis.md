## Raytracing APIs

Hardware ray tracing landed in 2018 with NVIDIA Turing. By 2026 every major GPU vendor ships hardware acceleration for BVH traversal and ray-triangle intersection. The APIs are nearly isomorphic across vendors, which makes raytracing one of the cleaner cross-platform graphics features to implement.

### Acceleration Structures

Ray tracing requires two levels of structure.

**BLAS (Bottom-Level Acceleration Structure)**: a BVH over the triangles of one mesh. Built once per mesh, rebuilt on geometry deformation, refit cheaply on small motion.

**TLAS (Top-Level Acceleration Structure)**: a BVH over the instances. Each instance points at one BLAS plus a transform. Rebuilt per frame, fast.

Building a BLAS is expensive (millions of triangles, milliseconds of GPU time). Building a TLAS is cheap (instance count is in the thousands).

### Vulkan: VK_KHR_ray_tracing_pipeline

```cpp
// Build a BLAS for one mesh
VkAccelerationStructureGeometryKHR geo{
    .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR,
    .geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR,
    .geometry = {
        .triangles = {
            .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR,
            .vertexFormat = VK_FORMAT_R32G32B32_SFLOAT,
            .vertexData = { .deviceAddress = vbuf_addr },
            .vertexStride = sizeof(Vertex),
            .maxVertex = num_vertices,
            .indexType = VK_INDEX_TYPE_UINT32,
            .indexData = { .deviceAddress = ibuf_addr },
        },
    },
    .flags = VK_GEOMETRY_OPAQUE_BIT_KHR,
};

VkAccelerationStructureBuildGeometryInfoKHR info{
    .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR,
    .type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR,
    .flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR,
    .mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR,
    .geometryCount = 1,
    .pGeometries = &geo,
};

uint32_t prim_count = num_indices / 3;
VkAccelerationStructureBuildSizesInfoKHR sizes{
    .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR };
vkGetAccelerationStructureBuildSizesKHR(device,
    VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
    &info, &prim_count, &sizes);

// Allocate accelerationStructureSize bytes from VMA, create AS,
// allocate buildScratchSize for scratch, then issue:
// vkCmdBuildAccelerationStructuresKHR
```

The TLAS is built the same way with `VK_GEOMETRY_TYPE_INSTANCES_KHR` pointing at a buffer of `VkAccelerationStructureInstanceKHR` (instance transform plus BLAS reference plus instance ID and mask).

### Ray Tracing Pipeline and Shader Stages

A raytracing pipeline has new shader stage types.

- **Ray generation (rgen)**: launched per pixel. Sets up rays and writes the result.
- **Closest hit (rchit)**: invoked when a ray hits a triangle (the closest one along the ray).
- **Miss (rmiss)**: invoked when a ray hits nothing.
- **Any-hit (rahit)**: invoked at every intersection along the ray, used for transparency.
- **Intersection (rint)**: custom intersection for non-triangle primitives (spheres, voxels).
- **Callable (rcall)**: like a function call, useful for material evaluation.

```hlsl
// Ray generation
[shader("raygeneration")]
void RayGen() {
    uint2 pix = DispatchRaysIndex().xy;
    float2 uv = (pix + 0.5) / DispatchRaysDimensions().xy;
    float3 ro = camera_pos;
    float3 rd = normalize(camera_to_world(uv));

    RayDesc ray = { ro, 0.001, rd, 10000.0 };
    Payload p = { float3(0,0,0), 0 };
    TraceRay(scene, RAY_FLAG_NONE, 0xFF, 0, 0, 0, ray, p);
    output[pix] = float4(p.color, 1);
}

[shader("closesthit")]
void Hit(inout Payload p, in BuiltInTriangleIntersectionAttributes attr) {
    uint inst = InstanceID();
    uint prim = PrimitiveIndex();
    float2 bary = attr.barycentrics;
    // Fetch vertices via bindless, interpolate, sample, shade
    p.color = albedo_at(inst, prim, bary);
}

[shader("miss")]
void Miss(inout Payload p) {
    p.color = sky(WorldRayDirection());
}
```

The pipeline is bound once per frame. `TraceRay` invokes the right shader based on the hit. The shader binding table (SBT) is a buffer the pipeline references, holding per-mesh material handles for closest-hit dispatch.

### DXR (D3D12 Ray Tracing)

DXR is the same model with D3D12-flavored API. `ID3D12StateObject` replaces `VkPipeline`. The shader code is byte-identical (HLSL).

```cpp
// State object subobjects
D3D12_DXIL_LIBRARY_DESC lib{ /* compiled HLSL */ };
D3D12_HIT_GROUP_DESC hit{
    .HitGroupExport = L"HitGroup",
    .Type = D3D12_HIT_GROUP_TYPE_TRIANGLES,
    .ClosestHitShaderImport = L"Hit",
};
D3D12_RAYTRACING_SHADER_CONFIG cfg{
    .MaxPayloadSizeInBytes = 32,
    .MaxAttributeSizeInBytes = 8,
};
D3D12_RAYTRACING_PIPELINE_CONFIG pcfg{ .MaxTraceRecursionDepth = 4 };
// ... CreateStateObject ...
```

DXR 1.1 (SM 6.5) added inline raytracing (`RayQuery`), which lets a regular pixel or compute shader trace rays without a full raytracing pipeline. This is the only path that runs on tier 1.1 hardware (Intel Arc, mobile).

```hlsl
RayQuery<RAY_FLAG_NONE> q;
q.TraceRayInline(scene, RAY_FLAG_NONE, 0xFF, ray);
while (q.Proceed()) {}
if (q.CommittedStatus() == COMMITTED_TRIANGLE_HIT) {
    // shaded
}
```

### MetalRT

Apple's raytracing API on Metal 3+. The model is the same but the API is Objective-C (or metal-cpp) flavored.

```cpp
MTL::AccelerationStructureTriangleGeometryDescriptor* geo =
    MTL::AccelerationStructureTriangleGeometryDescriptor::alloc()->init();
geo->setVertexBuffer(vbuf);
geo->setVertexStride(sizeof(Vertex));
geo->setIndexBuffer(ibuf);
geo->setTriangleCount(num_tris);

MTL::PrimitiveAccelerationStructureDescriptor* pdesc = /* ... */;
NS::Array* descs = NS::Array::array(geo);
pdesc->setGeometryDescriptors(descs);

MTL::AccelerationStructure* blas =
    device->newAccelerationStructure(pdesc->accelerationStructureSizes(/* ... */).accelerationStructureSize);

MTL::AccelerationStructureCommandEncoder* enc = cmd->accelerationStructureCommandEncoder();
enc->buildAccelerationStructure(blas, pdesc, scratch, 0);
enc->endEncoding();
```

Shaders use the `metal::raytracing` namespace, `intersector` and `intersection_result`. The semantics match DXR closely.

### Performance Considerations

**Ray coherence dominates.** Coherent rays (primary, shadow to a single light) are fast. Incoherent rays (diffuse bounces, specular bounces on rough surfaces) cost 5x to 10x more because they thrash the BVH cache.

**BLAS build time.** A typical AAA scene has 10,000 BLASes. Building all from scratch is unaffordable per frame. Strategy: build static BLASes once at load with `PREFER_FAST_TRACE`. Refit dynamic BLASes per frame with `MODE_UPDATE`. Rebuild fully only when topology changes.

**TLAS rebuild.** TLAS rebuild is per-frame and includes all instances. Use `PREFER_FAST_BUILD` for the TLAS (it is rebuilt every frame, so build speed matters more than trace speed) and `PREFER_FAST_TRACE` for BLASes.

**Opacity micromaps (OMM)**. NVIDIA Ada and later. For alpha-tested foliage, an OMM encodes per-microtriangle opacity. The hardware skips the any-hit shader for fully-opaque or fully-transparent micropolygons. 2x to 5x speedup on dense foliage scenes.

**Displaced micro-meshes (DMM)**. NVIDIA Ada. Encodes a million-triangle displacement on top of a thousand-triangle base mesh. The BVH is built over the base mesh, the hardware traverses displacement on the fly. Memory and build time stay low.

### Modern Techniques Built on RT

**ReSTIR DI/GI**. Reservoir resampling for direct and global illumination. One sample per pixel reused spatially and temporally produces near-converged results in a single frame. Used in Cyberpunk 2077 path tracing, Alan Wake 2, Black Myth Wukong.

**Neural radiance caching (NRC)**. NVIDIA's research result. A small MLP learns the irradiance at each surface point, cached and queried per ray. Trains continuously per frame. Provides infinite-bounce GI at a cost lower than two diffuse bounces.

**Ray reconstruction (DLSS 3.5+)**. NVIDIA's ML-based denoiser that replaces traditional denoisers (SVGF, ReLAX, OptiX denoiser) for raytraced images. Better quality at lower ray counts.

**Motion blur**. Rays carry time. Geometry has per-vertex motion data. The intersection shader interpolates between t=0 and t=1 vertex positions. Native motion blur in path tracing without temporal accumulation.

### Junior to FAANG

A junior writes a path tracer that builds all BLASes per frame and ships at 2 fps with 1080p. A senior at NVIDIA's RTX team builds BLASes once, refits dynamic ones, uses ReSTIR for sampling, ray reconstruction for denoising, OMM for foliage, and ships at 4K 60 fps with two diffuse bounces.

---
