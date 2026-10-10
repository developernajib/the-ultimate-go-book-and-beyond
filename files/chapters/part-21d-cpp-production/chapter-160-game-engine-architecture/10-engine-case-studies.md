## Engine Case Studies

These are drawn from public record: published talks, open-source code, and documentation. Where an engine's internals are not public, the pattern is described as the industry approach rather than attributed.

### id Tech and the Open-Source Lineage

The id Tech engines are the most valuable case study available because the source is public. Doom, Quake, Quake II, Quake III, and Doom 3 have all been released under the GPL, which makes them the only AAA engines you can read end to end.

What they teach is architectural evolution under a fixed constraint. Quake's software renderer, its BSP tree for visibility, and its PVS (potentially visible set) precomputation are all answers to "how do you render a 3D world on a 1996 CPU with no GPU." The BSP is the ancestor of every spatial partition in this chapter, and the PVS is offline baking (section 07) applied to visibility: compute the expensive thing once, at build time, so the frame does not.

Quake III's networking is the origin of the snapshot-interpolation model in section 08, and its `.pk3` asset packaging is the ancestor of every modern bundle format. If you read one engine's source, read this one, and read it for the trade-offs rather than the code.

### Unreal and Unity: Two Answers to Scripting

The two dominant commercial engines made opposite bets on the same problem, which is that C++ iteration is slow and designers should not wait for a compile.

Unreal keeps gameplay in C++ and adds Blueprints, a visual scripting layer, plus a reflection system (`UPROPERTY`, `UCLASS`) implemented by a custom header-parsing tool that generates code at build time. That reflection is what powers the editor, serialization, and network replication, and it is why Unreal's build has an extra tool in front of the compiler. The cost is build complexity and a macro-heavy dialect of C++ that is genuinely its own language.

Unity keeps the runtime in C++ and puts gameplay in C#, accepting a managed-language boundary and a garbage collector in exchange for fast iteration. Then, having discovered that a GC in a frame loop is exactly the problem section 05 describes, Unity built DOTS: an ECS with a compiler (Burst) that turns a restricted C# subset into vectorized native code with no allocation. DOTS is an implementation of this chapter's sections 03, 04, and 06 in a managed language, which is a strong argument that the architecture is forced by the problem rather than by C++.

The lesson is that both converged on the same runtime shape from opposite directions: dense arrays, no per-frame allocation, jobs over threads.

### The Console Certification Constraint

Console platform holders impose technical requirements that must be met to ship: memory ceilings, load-time limits, suspend/resume behaviour, and stability bars. A build that fails certification does not ship, full stop.

This is worth studying as an engineering-culture artifact rather than a technical one. Every other domain in this book treats performance and memory as goals that compete with features and usually lose. Console development treats them as **gates**, and the effect is visible: the budget tables in sections 00 and 05, the perf ratchet in section 09, and the per-subsystem ownership all exist because someone external will refuse the build otherwise.

The transferable question for any team: what is your equivalent gate? If the answer is "we intend to be fast," you will not be fast in three years. Cert is arbitrary and external and it works precisely because it is not negotiable by the team under schedule pressure.

### Simulation, Robotics, and AV Inherited This

The architecture in this chapter has spread well beyond games, and this is where its interview relevance is growing fastest.

Robotics simulators, autonomous-vehicle simulation stacks, and digital-twin systems all have the game engine's problem: a fixed timestep, a large entity count, a hard deadline, and no tolerance for allocator spikes. So they took the solution wholesale. NVIDIA's Omniverse and Isaac Sim are built on engine technology. Several AV companies run their simulation on Unreal or on in-house engines with the same structure. The fixed-timestep loop from section 02 is standard in robotics for exactly the determinism reason.

The consequence for a reader: this chapter is not only a games chapter. If you interview at an AV, robotics, or simulation company for a C++ role, the material here is the material, and the determinism section is likely to matter more there than it does in most games, because a simulation you cannot reproduce is a simulation you cannot certify.

### What They Share

Read the four together and the same forces produce the same answers every time. Offline is better than online (PVS, baked assets, precompiled shaders). Dense arrays beat pointer chases at scale, and both Unreal and Unity's DOTS arrived there independently. Deadlines must be gates or they erode. And the architecture is driven by the frame budget's arithmetic, not by taste, which is why engines built decades apart in different languages by competing companies look so much alike.
