## The Game Loop and the Frame Budget

Every engine is a loop. The interesting part is that simulation and rendering want different timesteps, and reconciling that is the first architectural decision.

### Why Variable Timestep Breaks

The naive loop measures elapsed time and advances the simulation by it:

```cpp
// BROKEN: physics behaviour now depends on frame rate.
while (running) {
    float dt = timer.elapsed();
    update(dt);
    render();
}
```

This fails for reasons that are not obvious until they bite:

**Non-determinism.** The same input produces different results on a 144 Hz machine and a 60 Hz machine, because floating-point integration over different step sizes accumulates differently. Replays desync. Lockstep multiplayer desyncs. Physics-based puzzles solve on one machine and not another.

**Tunneling.** A frame spike produces a large `dt`, and a fast object integrates straight through a wall because the collision test never saw it overlapping.

**Instability.** Spring and constraint solvers are only stable below a timestep threshold. Exceed it and the simulation explodes, literally: objects fly to infinity and the values become NaN.

The infamous case is *Quake III*, where physics ran per-frame and specific frame rates produced measurably different jump heights, which speedrunners exploited by capping fps to precise values. The general lesson is that frame rate is a property of the machine and physics must not be.

### Fixed Timestep With Interpolation

The standard solution decouples them. Simulate in fixed increments, render whatever is left over by interpolating.

```cpp
constexpr double kFixedDt = 1.0 / 60.0;  // simulation step
double accumulator = 0.0;
double currentTime = now();

while (running) {
    double newTime = now();
    double frameTime = newTime - currentTime;
    currentTime = newTime;

    // Clamp: never let a huge stall (breakpoint, disk hitch, alt-tab)
    // turn into a spiral of death where we try to catch up forever.
    if (frameTime > 0.25) frameTime = 0.25;
    accumulator += frameTime;

    pollInput();

    while (accumulator >= kFixedDt) {
        previousState = currentState;
        simulate(currentState, kFixedDt);   // always the same dt
        accumulator -= kFixedDt;
    }

    // What fraction of the way to the next sim step are we?
    const double alpha = accumulator / kFixedDt;
    render(lerp(previousState, currentState, alpha));
}
```

Three details carry the design:

**The clamp** prevents the spiral of death. Without it, a 5-second stall queues 300 simulation steps, which take longer than a frame to run, which grows the accumulator further, and the game never recovers. Clamping drops simulation time rather than the game.

**The interpolation** is why this looks smooth rather than juddery. The simulation is at 60 Hz but the renderer may run at 144 Hz, so you render a blend between the last two simulated states. Skip this and a 144 Hz display shows each simulated state 2.4 times on average, unevenly, which reads as stutter.

**`previousState`** must be stored. This is the cost: you keep two copies of every interpolatable transform. Engines usually store only the render-relevant subset (position, rotation, scale) rather than the whole entity.

### Rendering One Frame Behind

Most shipping engines go further and pipeline the CPU and GPU: while the GPU renders frame N, the CPU simulates N+1. This nearly doubles throughput and costs one frame of input latency, which is why competitive shooters expose it as an option and why "low latency mode" in drivers is a real setting that real players notice.

The consequence for engine code is that a frame's data must stay alive until the GPU finishes with it, which is why engines have per-frame resource lifetimes and N-buffered upload rings rather than freeing at end-of-frame. Chapter 161 covers the GPU-side synchronization this requires.

### Measuring Against the Budget

The number that matters is not average frame time. It is the distribution's tail.

```cpp
// A frame-time histogram is worth more than a mean.
// 16.6 ms at 60 fps: count how often you miss, not how fast you usually are.
struct FrameStats {
    void record(double ms) {
        samples[index++ & (kCount - 1)] = ms;
        if (ms > budgetMs) missed++;
    }
    double percentile(int p) const;  // sort a copy, index at p
    int missed = 0;
    double budgetMs = 16.6;
    static constexpr size_t kCount = 256;
    double samples[kCount] = {};
    size_t index = 0;
};
```

Ship criteria are expressed as "99th percentile frame time under 16.6 ms," not "average frame time under 16.6 ms." An engine averaging 8 ms with a 40 ms spike every second is a stuttering mess and its mean looks excellent.

### Junior to FAANG: The Question They Will Ask

"Why do games use a fixed timestep?" is a standard opener at any engine studio, and the weak answer is "for consistency."

The strong answer names the three failures: determinism (replays and lockstep multiplayer desync because float integration differs per step size), tunneling (a large dt steps a fast object through a wall), and solver instability (constraint solvers diverge above a timestep threshold). Then name the cost: you must interpolate for rendering or it looks juddery on a display that is not at your sim rate, and that means storing the previous state.

The follow-up is usually the spiral of death. Know that the clamp exists and why: without it, one long stall makes the catch-up loop take longer than real time and the game never recovers.

### Senior at FAANG: Where the Loop Actually Goes Wrong

At senior level the loop above is table stakes and the interesting failures are in the seams.

**Input sampling versus simulation rate.** The loop polls input once per render frame but simulates possibly several times. If a button is pressed and released within one render frame, a naive poll misses it entirely. Engines that care sample input on a separate higher-frequency path or latch edge events so a press is never lost between sim steps. This is the difference between a fighting game that feels right and one that does not.

**Time source.** `std::chrono::steady_clock` is correct here and wall clock is a bug: NTP adjustments and DST have shipped as gameplay bugs more than once. On consoles the platform provides a guaranteed-monotonic timer and engines use it.

**The accumulator is state.** Save games, pause, and level transitions all interact with it. Pausing by not calling `simulate` while still accumulating time means unpausing runs a burst of catch-up steps. Every engine has had this bug.

The architectural point worth raising in a design review: the fixed-timestep loop makes the simulation a pure function of (state, input, dt), and that purity is what buys deterministic replays, rollback netcode, and reproducible bug repros from a player's input log. Teams that let non-determinism creep in, a `rand()` without a seeded stream, a physics query that depends on iteration order of a hash map, an uninitialized float, lose all three capabilities at once and usually do not notice until they try to ship replays.
