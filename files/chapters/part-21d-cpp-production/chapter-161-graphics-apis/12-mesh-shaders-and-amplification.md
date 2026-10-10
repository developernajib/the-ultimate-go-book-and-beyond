## Mesh Shaders and Amplification

Mesh shaders replace the entire vertex / hull / domain / geometry / tessellation chain with a programmable two-stage pipeline: amplification (or task) shader, then mesh shader. They are the geometry pipeline of 2025 and beyond, and they are the foundation of Nanite-style virtualized geometry.

### Why the Old Pipeline Hit a Wall

The fixed-function vertex pipeline assumed one vertex shader invocation per vertex. Tessellation added hull and domain stages. Geometry shaders added a stage that emitted variable triangle counts. None of it was great.

Three problems killed the old pipeline at scale.

**No early culling**. The pipeline rasterized every triangle that survived clip-space culling. A million-triangle mesh that mostly faced away from the camera still paid the full vertex cost.

**No control over wave packing**. The hardware grouped vertices into waves implicitly. Highly indexed geometry produced lots of wasted lanes. Tessellation made it worse.

**No batched amplification**. Geometry shaders emitted per-primitive but the hardware serialized output and lost most of the parallelism gain.

### The Mesh Shader Model

A mesh shader runs in workgroups of (typically) 32, 64, or 128 threads. Each workgroup outputs a **meshlet**: up to 256 vertices and 512 triangles, packed into a small contiguous output buffer. The rasterizer picks up meshlets directly.

The application authors meshes pre-split into meshlets. Each meshlet has:

- A vertex list (up to 256, often 64 or 128).
- A triangle list as 8-bit indices into the local vertex list.
- A bounding sphere for culling.
- A normal cone for backface culling.

```cpp
struct Meshlet {
    uint32_t vertex_offset;
    uint32_t triangle_offset;
    uint8_t  vertex_count;
    uint8_t  triangle_count;
    float    bounds[4];      // sphere xyz radius
    int8_t   cone_axis[3];
    int8_t   cone_cutoff;
};
```

Tools like meshoptimizer (Arseny Kapoulkine's `meshopt_buildMeshlets`) generate these from a regular indexed mesh.

### Amplification (Task) Shader

The amplification shader runs first. It decides, for a workgroup of objects or meshlets, how many mesh shader workgroups to dispatch downstream.

```hlsl
struct Payload { uint meshlet_indices[32]; };
groupshared Payload pay;

[NumThreads(32, 1, 1)]
void ASMain(uint tid : SV_DispatchThreadID, uint gtid : SV_GroupThreadID) {
    Meshlet m = meshlets[tid];
    bool visible = frustum_cull(m.bounds, view_frustum) &&
                   cone_cull(m.cone_axis, m.cone_cutoff, view_pos - m.center);

    uint slot = WavePrefixCountBits(visible);
    uint count = WaveActiveCountBits(visible);
    if (visible) pay.meshlet_indices[slot] = tid;
    if (gtid == 0) DispatchMesh(count, 1, 1, pay);
}
```

`DispatchMesh` launches `count` mesh-shader workgroups, each receiving the payload. Culling happens before the mesh shader runs at all. This is the single largest performance win: rejecting 70 to 90 percent of meshlets means you skip 70 to 90 percent of vertex work.

### Mesh Shader

The mesh shader emits the actual geometry.

```hlsl
struct VOut { float4 pos : SV_Position; float3 normal : NORMAL; };

[NumThreads(64, 1, 1)]
[OutputTopology("triangle")]
void MSMain(
    uint gtid : SV_GroupThreadID,
    in payload Payload pay,
    out vertices VOut verts[64],
    out indices uint3 tris[124])
{
    uint mid = pay.meshlet_indices[/* my workgroup */];
    Meshlet m = meshlets[mid];

    SetMeshOutputCounts(m.vertex_count, m.triangle_count);

    if (gtid < m.vertex_count) {
        Vertex v = vbuf[m.vertex_offset + gtid];
        VOut o;
        o.pos = mul(view_proj, mul(world, float4(v.pos, 1)));
        o.normal = v.normal;
        verts[gtid] = o;
    }
    if (gtid < m.triangle_count) {
        uint3 idx = unpack_triangle(ibuf[m.triangle_offset + gtid]);
        tris[gtid] = idx;
    }
}
```

The fragment shader is unchanged. It receives interpolated `VOut` values from the rasterizer, just like with a vertex shader.

### Nanite-Style Virtualized Geometry

Unreal 5's Nanite is the most ambitious application of mesh shaders so far. It implements virtualized micropolygon geometry: meshes are stored as a hierarchy of LOD clusters, each cluster about 128 triangles. At runtime, the engine picks the right LOD per cluster based on screen-space size, so triangles are roughly one pixel each, regardless of mesh size.

Nanite goes further than DX12 mesh shaders allow. It uses a **software rasterizer** for sub-pixel triangles (a compute shader rasterizes 64-pixel tiles), bypassing the hardware rasterizer entirely. Hardware rasterizer kicks in only for larger triangles. The reason: hardware rasterizers are optimized for 4-pixel quads. A one-pixel triangle wastes 75 percent of the quad. Software rasterization on compute is faster for sub-pixel triangles because it picks one lane per pixel.

```hlsl
// Sketch of software rasterization for tiny triangles
[NumThreads(8, 8, 1)]
void SWRasterize(uint3 tid : SV_DispatchThreadID) {
    uint2 pix = tid.xy;
    Triangle t = read_triangle();  // sub-pixel
    float3 bary = barycentrics(pix, t);
    if (all(bary >= 0)) {
        InterlockedMin(visibility[pix], pack(t.depth, t.cluster_id));
    }
}
```

The rasterizer writes a visibility buffer (cluster ID + triangle ID + depth) atomically. A subsequent pass shades from the visibility buffer.

### Hardware Support

- NVIDIA: Turing (RTX 20) and later.
- AMD: RDNA 2 (RX 6000) and later. Native task / mesh shaders, mapped to NGG primitive shader hardware.
- Intel: Arc Alchemist and later.
- Apple: M3 and later (GPU family Apple9). Older Apple GPUs route through compute emulation.
- Qualcomm Adreno 700+: yes, with Vulkan.
- Mobile: increasingly available.

### Performance Implications

Mesh shaders open three new optimization vectors.

**Per-meshlet culling**. Reject 70+ percent of geometry before the vertex stage. Combined with backface and small-feature culling, this is often the difference between hitting frame budget and missing it.

**Better wave occupancy**. Mesh shader workgroups have explicit thread counts. The shader can be tuned for a specific architecture's wave width. AMD RDNA can prefer 32-wide. NVIDIA prefers 64. Apple prefers 32.

**Compact vertex output**. Output buffers are sized at compile time, the compiler packs them tightly. Less memory thrash than the implicit vertex cache used in the legacy pipeline.

### When Mesh Shaders Lose

Mesh shaders are not always faster than vertex shaders. For simple meshes (skybox, full-screen quad, particles, simple terrain) the legacy pipeline is fine. The win comes from culling-heavy, high-detail geometry where rejection rates are high.

Mesh shaders also have a sharp authoring cost: meshes must be split into meshlets, which existing content pipelines do not produce. meshoptimizer is the standard tool.

### Junior to FAANG

A junior implements a vertex shader pipeline for a 50-million-triangle scene, hits 8 fps, and concludes the GPU is too slow. A senior at Epic implements meshlet-based mesh shaders with task-shader culling, hits 60 fps, and the same hardware feels infinite.

---
