# Chapter 160: Game Engine Architecture in C++

> "The frame budget is 16.6 milliseconds. Physics does not get to be slow because physics is hard.", Anonymous engine programmer

A game engine is a soft real-time system with a hard deadline that arrives sixty times per second, and it is the domain where C++ is least replaceable. Unreal Engine 5 is roughly 5 million lines of C++. Unity's runtime core is C++ with a C# scripting layer on top. Every shipping console title, every AAA engine, id Tech, Frostbite, Source 2, Decima, RE Engine, is C++ down to the metal. This is not inertia. It is that no other language lets you control memory layout, avoid allocation on the hot path, and hit a 16.6 ms deadline with a hundred thousand simulated entities.

The deadline is what makes engine work different from everything else in this part. A browser that takes 20 ms to paint a frame is slightly janky. A database that takes 20 ms for a query is fast. A game that takes 20 ms for a frame **missed 60 fps and the player felt it**. There is no averaging, no p99 that hides behind a good p50: every frame is a deadline, and a single 34 ms frame is a visible stutter that a reviewer will write about. At 60 fps you have 16.6 ms. At 120 fps you have 8.3 ms. At 90 fps for VR you have 11.1 ms and missing it makes people physically ill. Within that budget you must run input, gameplay, animation, physics, audio, AI, particles, culling, and submit a frame's worth of draw calls.

This chapter is the CPU-side architecture of an engine: how the frame is structured, how entities are stored so the cache cooperates, how memory is managed when `malloc` is banned from the hot path, how work is spread across cores without locks, and how assets stream in without a hitch. It deliberately stops at the GPU boundary. Chapter 161 covers Vulkan, Metal, D3D12, shaders, and the rendering techniques that consume what this chapter produces, and Chapter 162 takes the audio pipeline, whose deadline is even less forgiving than the renderer's.

## Why Games Are Different

Most of this book's C++ chapters optimize for throughput or tail latency over a long-running process. Engines optimize for **worst-case frame time**, which inverts several common systems engineering habits.

Allocation is the clearest example. A server that allocates on every request is fine, the allocator is fast and amortizes well. An engine that allocates on every frame will eventually hit an allocator slow path, and that slow path lands on a random frame and shows up as a stutter. So engines do not allocate during the frame. They allocate arenas at load time and hand out memory with pointer bumps.

Exceptions are the second. Most engines compile with `-fno-exceptions`. Not because exceptions are slow when not thrown, they are close to free, but because the unwind tables cost binary size, because console toolchains historically discouraged them, and because error handling in a frame loop tends to mean "log it and keep rendering" rather than unwind. `std::vector` is frequently replaced too, not out of NIH but because the engine wants its own allocator, its own growth policy, and no exception machinery.

The third is that averages lie. A profile showing 8 ms average frame time with occasional 40 ms spikes is a bad engine, and the mean will never tell you. Engine profiling is spike hunting, which is why every engine ships a frame timeline view rather than a flat profile.

## The Frame Budget Is the Architecture

Every architectural decision in an engine descends from dividing 16.6 ms among subsystems. A representative budget for a 60 fps console title:

| Subsystem | Budget |
|-----------|--------|
| Gameplay and scripting | 3-4 ms |
| Animation and skinning | 2-3 ms |
| Physics | 2-4 ms |
| Culling and render submission | 2-3 ms |
| Particles and VFX | 1-2 ms |
| Audio | under 1 ms on the game thread |
| Slack for spikes | 2-3 ms |

The slack row is the one juniors delete and seniors defend. An engine budgeted to exactly 16.6 ms ships at 45 fps, because real frames have spikes: a shader compiles, an asset finishes loading, the OS preempts you, a player triggers an explosion that spawns 4,000 particles. The budget must absorb them.

Notice what the table implies: no subsystem gets more than about 4 ms, so no subsystem can afford an O(n log n) pass over every entity with a bad constant. This is why engines are built the way they are, and why data-oriented design is not a style preference but the arithmetic working out.

## Junior to FAANG: What You Should Already Know

You need Chapters 126 (memory management), 128 (move semantics), and 134 (atomics and the C++ memory model) before this chapter. Engine code is where those three combine: you will write a custom allocator, you will care whether a type is trivially copyable, and you will read lock-free queues in the job system.

You should be able to explain a cache line, why an array of structs and a struct of arrays have different performance, and why a virtual call in a loop over 100,000 objects is a problem. If any of those is fuzzy, Chapter 139 (performance engineering) first.

The mental shift to make: stop thinking about the cost of one operation and start thinking about the cost of a pass over data. `Update()` on one entity is irrelevant. `Update()` on 50,000 entities, and whether that pass is linear in memory or a pointer chase, is the whole question.

## Senior at FAANG: What This Chapter Adds

If you have shipped server C++ this chapter is where your instincts get inverted, and knowing which of your habits to drop is the point.

You will meet data-oriented design as an actual discipline rather than a slogan, and see the ECS pattern that dominates modern engines as a specific answer to a specific cache problem, not a design-pattern preference. You will see why engines ban `std::shared_ptr` on the hot path, why handles beat pointers, why the single-frame arena is the most-used allocator in the codebase, and why the job system is a work-stealing deque rather than a thread pool with a mutex.

Interview relevance: Epic, Unity, Valve, Roblox, id, Naughty Dog, and the console platform teams at Sony and Microsoft all interview on this material, and so, increasingly, do simulation, robotics, and AV teams, who inherited the engine architecture wholesale because they have the same problem: a fixed deadline, a large entity count, and no tolerance for allocator spikes.
