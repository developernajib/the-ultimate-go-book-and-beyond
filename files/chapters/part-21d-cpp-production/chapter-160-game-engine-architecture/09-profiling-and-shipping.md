## Profiling and Shipping

Engine profiling is spike hunting. The mean is a distraction and the flat profile that serves a server well will not find your problem.

### Why the Flat Profile Fails

`perf` aggregating over 60 seconds tells you physics used 18 percent of CPU. That is useless. The question is not "what is expensive on average," it is "what made *frame 4,127* take 40 ms," and the answer is invisible in an aggregate: a 40 ms spike once per second is 6 percent of a 60-second profile and it is the only thing wrong with your game.

Engines therefore instrument the frame explicitly with a timeline, not a sampler.

```cpp
// Scoped instrumentation. Every subsystem is a named span, and the
// output is a timeline per frame, not a sum over a minute.
struct ScopedZone {
    ScopedZone(const char* name) : name_(name), start_(rdtsc()) {}
    ~ScopedZone() { Profiler::record(name_, start_, rdtsc()); }
    const char* name_;
    uint64_t start_;
};
#define PROFILE_ZONE(name) ScopedZone _zone_##__LINE__(name)

void updatePhysics(float dt) {
    PROFILE_ZONE("Physics");
    { PROFILE_ZONE("Broadphase");  broadphase(); }
    { PROFILE_ZONE("Narrowphase"); narrowphase(); }
    { PROFILE_ZONE("Solver");      solve(dt); }
}
```

The output is a flame chart per frame, per thread, with the job system's spans included. Tracy is the widely used open-source tool for this and it is what most C++ engine work uses when there is no in-house equivalent. It shows you frame 4,127 specifically, which is the only view that answers the question.

### The Numbers That Ship

Ship criteria are percentiles and worst cases, never means.

| Metric | Typical target |
|--------|----------------|
| Frame time p99 | under budget (16.6 ms at 60 fps) |
| Worst frame in a 10-minute session | under 2x budget |
| Hitches over 100 ms | zero |
| Memory peak | under platform budget with headroom |
| Load time | under a platform-mandated limit |

Console certification is the forcing function that makes this concrete. Platform holders have technical requirements, and a build that violates them does not ship. That is a genuinely useful constraint: it converts "performance is important" into a gate, which is the only thing that reliably makes performance work get funded.

### Where the Spikes Come From

The differential diagnosis, roughly in order of frequency:

**Shader/PSO compilation.** A new material or state combination hits an uncached pipeline object and the driver compiles it, on the frame, for tens of milliseconds. This is the single most common stutter in modern PC games. The fix is precompiling permutations offline and warming the cache at load, which Chapter 161 covers.

**Allocation.** Something on the frame path called `new` and hit an allocator slow path. Section 05 exists to prevent this.

**Streaming.** A synchronous read, or an asset that was requested too late and blocked. Section 07.

**GC or refcount cascade.** In engines with a scripting VM, a collection ran on the frame. Incremental collectors with a per-frame time budget are the mitigation.

**Page faults.** First touch of freshly allocated memory faults it in. Engines pre-touch and, on platforms that allow it, use large pages.

**OS preemption.** Another process took your core. On console this is controlled - on PC it is a fact of life and the reason for the slack row in section 00's budget table.

### Junior to FAANG: The Debugging Script

"The game runs at 60 fps but stutters every few seconds. Find it."

Do not open a sampling profiler, and say why: an aggregate hides a periodic spike. Instead capture a frame timeline and find a bad frame specifically, then read what the timeline says about it.

Then reason from periodicity. Every few seconds with no player input suggests a background system: a GC, a streaming tick, an autosave. Correlated with movement suggests streaming or PSO compilation as new content enters view. Correlated with an effect firing suggests a shader compile or a particle allocation spike.

The instinct they are testing: spikes and averages are different problems, and you must measure the distribution to see the one that matters.

### Senior at FAANG: Performance as a Ratchet

The staff-level problem is that performance regresses continuously and invisibly. Every feature costs 0.2 ms, every cost is individually defensible, and forty features later you ship at 45 fps with no single commit to blame. This is not a technical failure, it is the absence of a ratchet.

The mechanism that works is automated: a perf bot runs a fixed benchmark scene on fixed hardware every commit, records frame-time percentiles, and **fails the build on regression beyond a threshold**. Chromium does exactly this, per Chapter 159, and reverts changes that regress top metrics. The engineering content is mostly in making the benchmark stable enough that the signal exceeds the noise, which means fixed hardware, fixed clocks, deterministic scene playback, and enough runs to bound variance. That is real work and it is the work, because a flaky perf gate gets ignored within a month and then you have no gate.

The organizational half is per-subsystem budgets with owners, exactly parallel to the memory budgets in section 05. Physics owns 4 ms. If physics wants 5, that is a negotiation with whoever gives up a millisecond, held in the open, rather than a silent regression discovered at cert. Budgets make the tradeoff explicit and assign it a decider, and that is the only reason a 60 fps title stays at 60 fps for a three-year development cycle.
