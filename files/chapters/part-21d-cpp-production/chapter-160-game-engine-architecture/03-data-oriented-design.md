## Data-Oriented Design

Data-oriented design is not a philosophy. It is the observation that a cache miss costs roughly 200 cycles and an add costs one, so the layout of your data matters two orders of magnitude more than the cleverness of your code.

### The Arithmetic

A modern CPU cache line is 64 bytes. An L1 hit is about 4 cycles, L2 about 12, L3 about 40, and main memory about 200 or more. Those ratios are the whole argument.

Take the object-oriented layout a C++ course would teach:

```cpp
// Array of Structs (AoS). Natural OOP, hostile to the cache.
struct Entity {
    Vec3     position;   // 12 bytes  <- the update needs this
    Vec3     velocity;   // 12 bytes  <- and this
    Quat     rotation;   // 16 bytes
    Mesh*    mesh;       //  8 bytes
    Material* material;  //  8 bytes
    char     name[32];   // 32 bytes
    AABB     bounds;     // 24 bytes
    uint32_t flags;      //  4 bytes
    // ~116 bytes, padded to 128
};
std::vector<Entity> entities;  // 100,000 of them

for (auto& e : entities) {
    e.position += e.velocity * dt;   // touches 24 of 128 bytes
}
```

That loop needs 24 bytes per entity and drags in 128. Every cache line fetched carries 104 bytes of data the loop will not read. At 100,000 entities you move 12.8 MB through the cache hierarchy to do 2.4 MB of useful work, and you blow every level of cache doing it.

Now the same data, transposed:

```cpp
// Struct of Arrays (SoA). Ugly to write, kind to the cache.
struct Entities {
    std::vector<Vec3>     position;
    std::vector<Vec3>     velocity;
    std::vector<Quat>     rotation;
    std::vector<Mesh*>    mesh;
    // ...
};

for (size_t i = 0; i < count; ++i) {
    position[i] += velocity[i] * dt;   // both arrays fully consumed
}
```

Now every byte fetched is used. The hardware prefetcher recognizes two linear streams and stays ahead of you. The loop is trivially vectorizable, and the compiler will do it: four positions per AVX register instead of one. Same math, same result, and typically a 5-10x speedup on this kind of pass, entirely from layout.

That multiple is why engines look the way they do. No algorithmic improvement is available here, the loop is already O(n) with the minimum arithmetic. The only lever left is memory.

### AoSoA, the Compromise

Pure SoA is painful when you genuinely need a whole entity at once, which happens. The hybrid used by engines that vectorize aggressively is AoSoA: arrays of small SoA blocks sized to the SIMD width.

```cpp
// 8 entities per block, each block SIMD-shaped.
struct alignas(64) TransformBlock {
    float px[8], py[8], pz[8];
    float vx[8], vy[8], vz[8];
};
std::vector<TransformBlock> blocks;  // count/8 blocks
```

Each block is cache-line aligned, each field within it is a full AVX register, and the whole entity's data lives in a handful of nearby lines. This is what physics engines and particle systems actually use.

### The Habits This Overturns

Data-oriented design is uncomfortable for exactly the reasons OOP is comfortable.

**Virtual calls in hot loops die.** A `virtual void Update()` over 100,000 heterogeneous objects is a pointer chase to the object, a pointer chase to the vtable, an indirect call the branch predictor cannot predict, and no vectorization. The data-oriented answer is not "make the virtual call faster." It is to group entities by type and run a tight loop per group, which turns 100,000 unpredictable indirect calls into a handful of direct ones.

**Encapsulation loses to layout.** A `private: Vec3 position_;` with a getter is fine. A design where each entity owns its data and hides it means the data is scattered, and no amount of inlining fixes the layout.

**`std::shared_ptr` is banned from the hot path.** It is 16 bytes, its control block is a separate allocation somewhere else in memory, and every copy is an atomic increment. An array of `shared_ptr<Entity>` is a pointer chase per element plus a contended cache line per refcount. Engines use handles into dense arrays instead, which section 04 covers.

### When Not to Do This

Data-oriented design costs readability, and it is worth it exactly where the loop count is large. A pass over 100,000 particles: absolutely. The 12 entries in the pause menu: write the obvious code, nobody will ever measure it.

The failure mode of the newly converted is SoA-ing everything, producing an engine that is unreadable and no faster, because the hot loops were three functions and the other four hundred were noise. Profile, find the passes that dominate, transpose those.

### Junior to FAANG: The Interview Framing

Expect "here is a struct and a loop, make it faster." The expected answer is not micro-optimization. It is to notice that the loop touches two fields of a fat struct and that the layout is the problem.

Say the numbers out loud: 64-byte cache line, ~200 cycles for a main-memory miss versus ~4 for L1, the loop uses 24 of 128 bytes fetched so roughly 80 percent of memory bandwidth is wasted. Then propose SoA and note the second-order win, that the transposed loop vectorizes.

The follow-up is "when would you not do this?" Answer: when n is small, because the readability cost is real and the win is proportional to the pass length.

### Senior at FAANG: DOD as an Organizational Force

The staff-level observation is that data-oriented design is a constraint on how teams structure code, not just on how loops read, and that is why it is hard to adopt late.

Once entity data lives in system-owned arrays rather than in the entities themselves, the natural unit of code ownership becomes the system (physics owns the physics arrays) rather than the object (the enemy class owns everything about enemies). That is an organizational change: gameplay programmers no longer add a field to `Enemy`, they add a component to a system, and the system's pass over it is reviewed by whoever owns the frame budget for that system. Engines that adopt ECS get budget accountability almost as a side effect, because every system's cost is a measurable pass.

The migration is the hard part and it is why this shows up in staff interviews. You cannot transpose a 5-million-line engine's data layout in a quarter. The workable path is to identify the two or three passes that dominate the frame, move only their data into dense arrays behind a handle API, and leave the cold 95 percent of the codebase in whatever shape it is in. That is the same opportunistic-migration discipline as Chapter 79's `sort.Slice` retirement, applied to memory layout, and the ADR that records it should name the passes and their measured cost rather than gesturing at "cache efficiency."
