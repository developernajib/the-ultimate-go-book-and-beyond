## Learning Objectives

By the end of this chapter, you will be able to:

- Structure a frame loop with a fixed-timestep simulation and an interpolated render, and explain why variable timestep breaks physics determinism
- Explain the cache argument for data-oriented design and measure the difference between AoS and SoA layouts
- Implement an archetype-based entity component system and justify it against the alternatives
- Build the allocators an engine actually uses: frame arena, pool, and stack, and explain why `new` is banned from the hot path
- Design a work-stealing job system and explain why it beats a mutex-guarded thread pool at frame scale
- Structure an asset pipeline with offline baking and runtime streaming that never blocks the frame
- Choose a netcode model (lockstep, snapshot interpolation, rollback) from the game's requirements
- Read a frame timeline and hunt spikes rather than averages

### What You Should Be Able to Build

Concretely: an ECS that iterates 100,000 entities' transform and velocity components in a linear pass, a frame allocator that services thousands of allocations per frame at pointer-bump cost and resets in O(1), a job system that saturates 8 cores on a parallel-for without a lock in the steady state, and a profiler overlay that shows per-subsystem timings against a 16.6 ms budget.

If you can build those four, you can read any modern engine's source and recognize the shape.

### Prerequisites

Chapter 126 (memory management), Chapter 128 (move semantics and value categories), Chapter 134 (atomics and the C++ memory model), and Chapter 139 (performance engineering). Chapter 135 (lock-free programming) is required for the job system section rather than optional: the work-stealing deque is a lock-free data structure and this chapter does not re-derive it.

Chapter 161 covers the GPU side, and this chapter stops where it starts. Where this chapter says "submit the draw calls," Chapter 161 says how.
