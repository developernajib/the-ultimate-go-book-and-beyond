## Interview Questions

**Q1: Why do games use a fixed timestep for simulation?**

Three failures force it. **Determinism**: float integration over varying step sizes accumulates differently, so the same inputs produce different results on different machines, which desyncs replays and lockstep multiplayer. **Tunneling**: a frame spike gives a large dt and a fast object integrates straight through a wall because no collision test ever saw an overlap. **Solver instability**: constraint and spring solvers diverge above a timestep threshold and the simulation explodes to NaN.

The cost: the render rate no longer matches the sim rate, so you interpolate between the previous and current states for display, which means storing the previous state. And you must clamp accumulated time or a long stall triggers a spiral of death where catch-up steps take longer than real time.

---

**Q2: Here is a struct and a loop over 100,000 of them. Make it faster.**

Do not micro-optimize. Notice the layout. If the loop reads two fields of a 128-byte struct, every 64-byte cache line fetched carries mostly data the loop ignores, so roughly 80 percent of memory bandwidth is wasted and a main-memory miss is ~200 cycles against ~4 for L1.

Transpose to struct-of-arrays: each field in its own contiguous array. Now every fetched byte is used, the prefetcher tracks two linear streams, and the loop vectorizes. Typically 5-10x with no algorithmic change.

Then state the boundary: this is worth it at 100,000 elements and pointless at 12, because the win scales with the pass length and the readability cost is fixed.

---

**Q3: Why ECS instead of an inheritance hierarchy?**

Composition: a flying pilotable enemy has no place in a tree, and in ECS it is just a component set. Cache: components live in dense per-type arrays, so a system's pass is linear and vectorizable instead of a pointer chase through heterogeneous objects with vtables. Parallelism: systems declare which components they read and write, so a scheduler can prove which systems are disjoint and run them concurrently without locks.

Name a cost or the answer sounds unexamined: in archetype ECS, adding or removing a component moves the entity between archetypes, which copies its data, so structural churn is expensive. And debugging is worse, since an entity is an integer rather than an object, which is why every ECS ships an inspector.

---

**Q4: Why do engines write custom allocators when malloc is fast?**

Because malloc is fast *on average*, and a frame loop cannot spend averages. It may lock, search a free list, fall to a slow path, or fault, each rarely. Rarely, times 10,000 allocations per frame, is every frame, and a 200 microsecond tail is a visible stutter at 60 fps.

Second reason: fragmentation. On a console with a fixed budget and no swap, a long session fragments the heap until a large allocation fails despite adequate free memory. Real games have crashed hours in from exactly this.

The fixes: a frame arena (bump to allocate, reset the offset to free everything, no fragmentation possible, no destructors) for per-frame scratch, and a pool (free list threaded through the free slots) for fixed-size objects with individual lifetimes. Both have a worst case equal to their average case, which is the property that matters.

---

**Q5: Design a job system for an 8-core engine.**

Not one queue with a mutex. Engine jobs are ~20 microseconds and there are hundreds per frame, so lock contention plus cache-line ping-pong on the queue head across 8 threads costs a large fraction of the job itself.

Work stealing: one deque per worker. The owner pushes and pops its own end with no synchronization in the steady state - an idle worker steals from the opposite end of someone else's, so `top_` and `bottom_` are usually different cache lines and only the last-job case races, resolved by one CAS. It load-balances with no central scheduler.

Two details that show experience: grain size is a real tuning knob (too small and overhead dominates, too large and one chunk becomes the critical path), and `waitFor` must run jobs while waiting rather than block, or you idle a core.

Then name what cannot be parallelized: order-dependent gameplay, anything holding a mutex on the hot path, and typically GPU submission.

---

**Q6: A player turns a corner and the game hitches 200 ms. Diagnose it.**

Differential, most likely first. **Shader/PSO compilation**: new content brought an uncached pipeline state and the driver compiled it on the frame. This is the most common stutter in modern PC games - the fix is offline precompilation and load-time cache warming. **Synchronous I/O**: something blocked the game thread on a read. **Allocation spike**: the load path called new and hit a slow path. **GPU upload stall**: a texture upload waited on the GPU.

Every fix has the same shape: move it off the frame, do it earlier, and degrade (low mip, low LOD, proxy) if it is not ready. The frame never waits.

---

**Q7: How would you network an RTS with 20,000 units? A fighting game? A 64-player shooter?**

**RTS**: deterministic lockstep. Snapshotting 20,000 entities is impossible bandwidth - inputs are bytes and are independent of entity count. Cost: bit-exact determinism required, and the slowest player gates everyone.

**Fighting game**: rollback. Local input must feel instant, so predict the remote input, simulate immediately, and rewind and re-simulate when the real input contradicts you. Cost: determinism, plus the sim must run several frames' worth inside one frame during a rollback. The entity count is small, so that is affordable.

**64-player shooter**: server-authoritative snapshot interpolation with client-side prediction and reconciliation. Do not require determinism across 64 heterogeneous machines, and never trust a client's position, only its inputs.

The derivation is the answer. Any candidate can name the three models - the signal is picking from requirements and naming the cost.

---

**Q8: What breaks bit-exact determinism?**

Floating point first: x87 80-bit intermediates, FMA contraction changing rounding, `-ffast-math` reassociating, and differing `libm` transcendentals. Mitigate with strict IEEE mode, no fast-math, no FMA contraction, and your own trig, or go fixed-point.

Then iteration order: a hash map keyed by pointer visits in allocation-address order, which differs per machine, and any reduction over it diverges. Dense arrays in index order instead.

Then uninitialized memory, where a read before write yields different garbage per machine. Then `rand()`, which must be a seeded PRNG whose state is part of the simulation and rolls back with it.

The senior addition: determinism is an invariant maintained from day one and verified continuously, typically by hashing sim state every step in CI, not a feature retrofitted later. Retrofitting it onto a non-deterministic engine is a rewrite.

---

**Q9: Your profiler shows 8 ms average frame time but the game stutters. What is wrong with that measurement?**

The average is the wrong statistic. A 40 ms spike once per second is 6 percent of an aggregate profile and it is the entire problem. Sampling profilers aggregating over 60 seconds cannot see it.

Use a frame timeline with scoped instrumentation so you can look at the bad frame specifically. Ship criteria are p99 frame time under budget and zero hitches over 100 ms, never mean frame time.

Then reason from periodicity: regular with no input suggests a background system (GC, streaming tick, autosave) - correlated with movement suggests streaming or shader compilation - correlated with an effect suggests a compile or an allocation spike.
