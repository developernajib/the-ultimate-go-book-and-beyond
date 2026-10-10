## The Asset Pipeline and Streaming

An open-world game ships 100 GB of assets and has 8 GB of usable memory. The asset system's job is to make that gap invisible, and it fails visibly: a hitch when a player turns a corner, or a blurry texture that pops in three seconds late.

### Bake Offline, Load Fast

The first rule is that **runtime never parses an authoring format**. A `.png` needs decompression, a `.fbx` needs parsing and mesh processing, a `.wav` needs decoding. None of that belongs in a shipping build.

The pipeline bakes: an offline tool converts each authoring asset into a platform-specific binary blob whose in-file layout is its in-memory layout. Loading is then read bytes, fix up a few pointers, done. Ideally not even that.

```cpp
// A baked asset is memory-mappable: the file layout IS the memory layout.
// Load = mmap + fix up offsets. No parse, no allocation per element.
struct BakedMesh {
    uint32_t magic;         // 'MESH'
    uint32_t version;       // reject mismatched bakes
    uint32_t vertexCount;
    uint32_t indexCount;
    uint64_t vertexOffset;  // byte offset from the start of this header
    uint64_t indexOffset;
    AABB     bounds;        // precomputed offline, not scanned at load
};

// Offsets, not pointers: the blob is position independent, so it can be
// mapped anywhere and shared between processes without relocation.
const Vertex* vertices(const BakedMesh* m) {
    return reinterpret_cast<const Vertex*>(
        reinterpret_cast<const std::byte*>(m) + m->vertexOffset);
}
```

Offsets rather than pointers is the load-bearing choice. A blob of offsets can be mapped at any address, needs no relocation pass, and can be shared. A blob of pointers must be fixed up on every load, which is a pass over the whole asset and the thing you were trying to avoid.

Baking is also where you do the expensive work once: compute tangents, optimize the vertex cache order, generate mipmaps, compress to a GPU-native format (BCn on desktop, ASTC on mobile), and build the LOD chain. All offline, in CI, on a build farm.

### The Content Addressable Cache

Baking 100 GB takes hours, and nobody can wait for that on every change. The standard structure is a content-addressed cache: hash the source asset plus the baking parameters plus the tool version, and use that hash as a key.

```
key = SHA256(source_bytes || bake_params || tool_version)
```

Change one texture and only that texture rebakes. Everyone on the team shares a cache server, so if CI already baked it, your local build downloads the result instead of computing it. This is the same insight as Go's build cache from Chapter 7B, applied to a 100 GB asset tree, and without it a content team of 200 people cannot function.

The subtle part is `tool_version` in the key. Omit it, and a bug fix in the mesh optimizer does not invalidate anything, so the team keeps shipping the old bad bake and nobody can reproduce it. Every field that affects the output must be in the key or the cache is silently wrong, which is a strictly worse failure than being slow.

### Streaming Without Hitching

Memory holds a fraction of the world, so assets stream in as the player moves. The rules are absolute:

**Never block the frame on I/O.** All loading is asynchronous, on I/O threads, with the frame checking for completion. A synchronous read on the game thread is a guaranteed hitch: an NVMe read is ~100 microseconds, a cold HDD seek is 10 ms, which is most of your frame.

**Predict, do not react.** Loading when the player enters a room is already too late. Engines load based on a predicted position, typically a radius around the player, biased by velocity, and prioritized by distance.

```cpp
// Priority by predicted distance: what will the player need soonest?
// Loading on demand is loading late.
struct StreamRequest {
    AssetId  id;
    float    priority;   // lower = more urgent
    uint64_t frameRequested;
};

void updateStreaming(const Camera& cam, float dt) {
    Vec3 predicted = cam.position + cam.velocity * kLookaheadSeconds;
    for (Cell& cell : world.cellsNear(predicted, kStreamRadius)) {
        if (!cell.loaded && !cell.requested) {
            float d = distance(predicted, cell.center);
            streamer.request({cell.assetId, d, frameIndex});
        }
    }
    // Evict what is now far away, but only if it has not been used
    // recently: thrashing on a boundary is worse than holding memory.
    streamer.evictBeyond(predicted, kEvictRadius);
}
```

Note that `kEvictRadius` exceeds `kStreamRadius`. That hysteresis is not an optimization, it is a correctness requirement: with a single radius, a player standing on the boundary loads and evicts the same cell every frame forever, which is a hitch machine. Every streaming system needs this gap and every one has shipped the bug at least once.

**Degrade rather than stall.** If an asset is not ready, render the low-mip texture, the low LOD mesh, or a proxy. Never wait. This is why textures pop in blurry and then sharpen: that is the system working correctly.

### Junior to FAANG: The Hitch Question

"A player turns a corner and the game hitches for 200 ms. Diagnose it."

The differential is worth memorizing. **Synchronous I/O on the game thread**: someone called a blocking read for an asset that was not ready. **Allocation spike**: the load path allocated on the frame instead of using a pool. **Shader compile**: a new material hit an uncached PSO, which is the classic and the reason engines precompile shader permutations offline. **GPU upload stall**: a texture upload waited for the GPU.

The fix in every case is the same shape: move it off the frame, do it earlier, and degrade if it is not ready. The frame is never allowed to wait.

### Senior at FAANG: The Pipeline Is a Distributed Build System

The staff-level realization is that an asset pipeline is a distributed build system with all of that problem's hazards, and the ones that bite are correctness rather than speed.

Determinism is the foundation. If baking the same source twice produces different bytes, the content cache is useless (nothing ever hits) and worse, it is untrustworthy. Non-determinism creeps in through iteration order of a hash map, timestamps embedded in output, absolute paths, and multithreaded reduction order in float math. Each has shipped as a real cache-invalidation bug in a real engine.

Cache invalidation is the second and it is Hyrum's Law again: everything that affects output must be in the key, including the tool version, the platform, the compression settings, and any environment variable the tool reads. Miss one and the failure is a stale artifact that only reproduces on one machine, which is among the most expensive bug classes a content team can hit because it destroys trust in the build.

The organizational stake is why this matters more than it sounds. A 200-person content team's iteration time is set by the pipeline. If a texture artist waits 20 minutes to see a change in-game, they make fewer changes and the game is worse. The pipeline is a product whose users are your colleagues, and its SLO is measured in seconds from save to seeing it, which is exactly the platform-engineering framing from Chapter 102F.
