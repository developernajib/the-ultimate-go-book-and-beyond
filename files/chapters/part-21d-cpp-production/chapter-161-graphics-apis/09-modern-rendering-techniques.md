## Modern Rendering Techniques

This section covers the rendering architectures shipped in current AAA titles and the trade-offs between them. A senior graphics engineer is expected to be able to discuss any of them at the level of "why did Doom Eternal pick visibility buffer over deferred?" or "why does Unreal 5 use a software rasterizer for Nanite?"

### Forward Shading

The classical pipeline. Each draw call rasterizes its triangles and the fragment shader computes lighting from all relevant lights at that pixel. Simple. Translates well to MSAA. Cheap on bandwidth (no fat G-buffer). Expensive when you have many lights.

The bottleneck: every pixel iterates every light, even lights that do not affect it. Adding lights scales linearly per pixel.

```hlsl
float4 PSMain(VOut in) : SV_Target {
    float3 albedo = albedo_tex.Sample(s, in.uv).rgb;
    float3 N = normalize(in.normal);
    float3 color = 0;
    for (uint i = 0; i < light_count; ++i) {
        color += shade(in.world_pos, N, albedo, lights[i]);
    }
    return float4(color, 1);
}
```

### Tiled Forward (Forward+)

Split the screen into 16x16 or 32x32 pixel tiles. A compute shader culls lights against each tile's frustum and writes a list of light indices per tile. The forward fragment shader reads only its tile's light list.

```hlsl
// Light culling compute
[numthreads(16, 16, 1)]
void cull(uint3 gid : SV_GroupID, uint flat : SV_GroupIndex) {
    if (flat == 0) tile_light_count = 0;
    GroupMemoryBarrierWithGroupSync();

    Frustum f = compute_tile_frustum(gid.xy);
    for (uint i = flat; i < light_count; i += 256) {
        if (intersects(lights[i], f)) {
            uint slot;
            InterlockedAdd(tile_light_count, 1, slot);
            tile_lights[slot] = i;
        }
    }
}
```

A scene with 1000 lights and a typical tile seeing 20 lights gives a 50x reduction in shading work. Tiled forward is the default for many mobile and desktop AAA renderers because it preserves MSAA, supports many materials, and bounds light cost per pixel.

### Clustered Shading

Tiled forward extended into the depth dimension. Cluster the view frustum into a 3D grid (typical: 64x32x16 = 32K clusters, log-spaced in Z). Cull lights against each cluster volume. Each pixel reads its cluster's light list based on its depth.

Better than tiled forward because lights at the back of a tile do not contaminate pixels at the front. Used in Avalanche's Frostbite forks, Doom 2016, Detroit Become Human, and many others.

### Deferred Shading

Two passes. First pass writes a G-buffer: albedo, normal, roughness, metallic, motion vectors. Second pass loops lights and shades from the G-buffer.

```
G-buffer (typical 80 bytes/pixel at 4K = 660 MB):
  RT0: RGBA8 albedo + occlusion
  RT1: RG16F encoded normal (octahedral)
  RT2: RGBA8 metalness, roughness, AO, material ID
  RT3: RG16F motion vectors
  D24S8 depth/stencil
```

Pros: lighting cost decoupled from geometry. Many lights at low cost. Material complexity handled in the G-buffer pass.

Cons: heavy bandwidth. Hard with MSAA (multiple samples per pixel multiplies G-buffer size). Limited material variation in lighting pass (must fit in G-buffer encoding).

Deferred dominated 2010 to 2018 desktop AAA. Killzone 2, Battlefield 3, GTA V, Witcher 3.

### Visibility Buffer

A modern alternative to deferred. Render geometry into a single 32-bit-per-pixel buffer holding `(triangle_id, instance_id)`. Defer all material work to a screen-space pass that reads the visibility buffer, fetches the triangle's vertex data, computes barycentrics analytically, and shades.

```hlsl
// Geometry pass: 32 bits per pixel
uint PSGeo(VOut in) : SV_Target {
    return (in.instance_id << 24) | in.tri_id;
}

// Shading pass: per pixel, fetch and interpolate
float4 PSShade(uint vis : SV_Target) {
    uint instance = vis >> 24;
    uint tri = vis & 0xFFFFFF;
    // Fetch three vertices, compute barycentrics from screen pos,
    // interpolate UV / normal / etc, sample textures, shade.
}
```

Pros: tiny G-buffer (4 bytes vs 80). Lower bandwidth, lower memory pressure, much better for memory-constrained hardware. Used by Doom Eternal, The Callisto Protocol, Nanite's micro-poly path.

Cons: more shader complexity. Requires bindless to fetch vertex / material data per pixel. Wave divergence on material ID can be high.

### GPU-Driven Rendering

The CPU does not generate per-object draw calls. Instead, the CPU uploads the scene as buffers (transforms, mesh references, material IDs) once. Per frame, a compute shader culls and produces an indirect draw buffer. The render pass is a single `DrawIndexedIndirectCount`.

```hlsl
struct Object { float4x4 xform; uint mesh_id; uint material_id; AABB bounds; };
StructuredBuffer<Object> objects : register(t0);
RWStructuredBuffer<DrawIndirect> draws : register(u0);
RWByteAddressBuffer count : register(u1);

[numthreads(64,1,1)]
void cull(uint id : SV_DispatchThreadID) {
    if (id >= num_objects) return;
    Object o = objects[id];
    if (!frustum_cull(o.bounds, view_frustum)) return;
    if (!occlusion_cull(o.bounds, hi_z)) return;

    uint slot;
    count.InterlockedAdd(0, 1, slot);
    draws[slot] = build_indirect(o);
}
```

GPU-driven scales to 100,000+ objects per frame. The CPU side stays a flat cost regardless of object count. Combined with bindless materials, it is the only sane way to render scenes with millions of mesh instances.

### Hierarchical Z Occlusion Culling

Occlusion culling on the GPU uses a Hi-Z pyramid: a mip chain of the depth buffer where each mip level holds the maximum (or minimum, depending on convention) of the four texels below.

```hlsl
// Build Hi-Z, mip k+1 from mip k
[numthreads(8,8,1)]
void hiz(uint3 tid : SV_DispatchThreadID) {
    float d0 = depth_in.Load(uint3(tid.xy*2 + uint2(0,0), 0));
    float d1 = depth_in.Load(uint3(tid.xy*2 + uint2(1,0), 0));
    float d2 = depth_in.Load(uint3(tid.xy*2 + uint2(0,1), 0));
    float d3 = depth_in.Load(uint3(tid.xy*2 + uint2(1,1), 0));
    depth_out[tid.xy] = max(max(d0,d1), max(d2,d3));  // far is greater
}

// Cull test, project AABB to screen, test against Hi-Z mip
bool occlusion_cull(AABB box, Texture2D<float> hiz) {
    Box screen = project(box);
    int mip = mip_for_size(screen.size);
    float max_depth = hiz.SampleLevel(s, screen.center, mip);
    return box.min_depth > max_depth;  // box behind everything visible
}
```

Two-pass strategy: render objects from previous frame's hi-z, build new hi-z, render newly visible objects. This is the classic GPU-driven culling pipeline used in Assassin's Creed Unity, Frostbite, and most modern engines.

### Compute-Driven Culling

Beyond frustum and occlusion, modern renderers cull at sub-mesh granularity. Meshes are split into meshlets (typically 64 vertices, 124 triangles). Each meshlet has a bounding sphere and a normal cone. Per-meshlet:

- Frustum cull against the sphere.
- Backface cull using the normal cone (if the cone of normals points entirely away from the camera, cull).
- Small-feature cull (cull meshlets that project to less than a pixel).

This typically rejects 60 to 90 percent of meshlets in a typical scene. Combined with mesh shaders (next section), the GPU never rasterizes geometry that will not contribute.

### Temporal Techniques

Modern renderers reuse data across frames. Two key examples.

**TAA (Temporal Anti-Aliasing).** The current frame jitters its sub-pixel sample. The history is reprojected using motion vectors and blended with the current frame. Cheap, smooth, and the foundation of all upscalers (DLSS, FSR, XeSS, MetalFX) which also reuse history but with a learned reconstruction filter.

**Reservoir Resampling (ReSTIR).** For raytracing. Each pixel maintains a reservoir of light samples weighted by their contribution. Reservoirs are reused spatially and temporally. ReSTIR DI provides clean direct lighting at one ray per pixel. ReSTIR GI extends to global illumination. It is the technique behind Cyberpunk's path tracing and Alan Wake 2's ray reconstruction.

### Junior to FAANG

A junior implements forward shading, hits 100 dynamic lights, and the framerate drops to single digits. A senior at Epic implements clustered shading with GPU-driven culling and bindless materials, hits 10,000 lights, supports 5 million instances, and ships at 60 fps on console.

---
