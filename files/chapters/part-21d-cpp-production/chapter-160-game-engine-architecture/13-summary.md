## Summary

A game engine is a soft real-time system with a deadline that arrives sixty times a second, and every architectural decision in this chapter descends from dividing 16.6 ms among subsystems.

**The frame loop** simulates at a fixed timestep and interpolates for rendering. Fixed steps buy determinism, prevent tunneling, and keep constraint solvers stable - interpolation is what makes a 60 Hz sim look smooth on a 144 Hz display, and the accumulator must be clamped or one long stall spirals into permanent catch-up.

**Data-oriented design** is arithmetic, not taste. A cache line is 64 bytes and a main-memory miss is ~200 cycles against ~4 for L1, so a loop reading two fields of a fat struct wastes most of the bandwidth it consumes. Transposing to struct-of-arrays typically buys 5-10x and lets the loop vectorize, and no algorithmic change was available.

**ECS** is that principle as an architecture. Entities are IDs, components are plain data in dense per-archetype arrays, systems are passes. It solves the hierarchy problem by composition, the cache problem by layout, and the parallelism problem by making data dependencies declarative. It costs structural-change performance and debuggability.

**Memory** obeys one rule: no allocation during the frame. `malloc` is fast on average and the frame cannot spend averages, so engines use arenas (bump, reset, no destructors) and pools (free list inside the free slots), both with a worst case equal to their average. Per-subsystem allocators exist as much for budget accountability as for speed.

**The job system** is work-stealing deques, because engine jobs are microseconds and a shared mutex-guarded queue costs more than the work. Grain size is a real knob, and waiting workers must run jobs rather than block.

**Assets** bake offline into memory-mappable blobs of offsets, cache by content hash (with the tool version in the key), stream on prediction rather than demand, keep eviction hysteresis to avoid boundary thrash, and degrade rather than stall.

**Netcode** picks from requirements: lockstep for many entities, snapshots for untrusted clients, rollback for instant local input. Two of the three demand bit-exact determinism, which is an invariant maintained and verified from day one, not retrofitted.

**Profiling** hunts spikes. The mean is a distraction - ship criteria are p99 frame time and zero hitches, and the gate must be automated or performance erodes one defensible 0.2 ms at a time.

### The Through-Line

Every section is the same trade made in a different place: **move work out of the frame**. Bake assets offline instead of parsing them. Precompile shaders instead of compiling on demand. Allocate arenas at load instead of calling `new`. Precompute visibility instead of testing it. Predict and stream ahead instead of loading on arrival. Interpolate instead of simulating faster.

The frame budget is not a performance target. It is the constraint that generates the architecture, and it is why engines built decades apart, in different languages, by competing companies, converge on the same shape. Unity arrived at ECS, dense arrays, and no-allocation jobs from C#, which is strong evidence that the problem forces the solution.

### Where This Goes Next

**Chapter 161** takes the GPU side: Vulkan, Metal, D3D12, shaders, and the rendering techniques that consume the draw calls this chapter's engine submits. Where this chapter says "submit," Chapter 161 says how, and it is where the pipeline-state-object compilation stutter from section 09 gets solved properly.

**Chapter 162** takes audio, whose deadline is stricter than the renderer's: a missed video frame is a stutter, a missed audio buffer is an audible click, and the callback runs on a thread where you may not allocate, lock, or block at all. Section 05's discipline becomes an absolute law there.

**Chapter 163** takes embedded and RTOS work, where the same real-time reasoning applies with hard rather than soft deadlines.

And beyond games: robotics, autonomous-vehicle simulation, and digital twins inherited this architecture wholesale, because they have the identical problem. The fixed-timestep loop, the ECS, the job system, and the determinism harness are now standard well outside the industry that invented them, which is the best argument that what this chapter teaches is the shape of real-time simulation rather than the folklore of one field.

---

| [◀ Chapter 159: Browser Internals in C++](../chapter-159-browser-internals/00-introduction.md) | [Chapter 160: Game Engine Architecture in C++](00-introduction.md) | [Chapter 161: Modern Graphics APIs in C++](../chapter-161-graphics-apis/00-introduction.md) ▶ |
