## 159.19 Performance and Power Tuning

The performance work that goes into a browser is among the most disciplined in software engineering. Every change to a hot path is gated by perf bots that catch sub-percent regressions. The frameworks for measuring, attributing, and bisecting performance are themselves substantial codebases.

### The RAIL Model

The Chrome team's mental model for web performance is RAIL: **R**esponse, **A**nimation, **I**dle, **L**oad.

- **Response.** Input handling under 100 ms. From tap to visual feedback.
- **Animation.** 16.67 ms per frame at 60 Hz. 8.33 ms at 120 Hz. Includes JS, layout, paint, raster, composite.
- **Idle.** Background work that the user does not see runs in idle slices, must yield within ~50 ms.
- **Load.** First Contentful Paint and Largest Contentful Paint within seconds, depending on connection class.

These are user-perceptual bounds. Each has separate tooling and metrics.

### Core Web Vitals

The publicly-tracked subset of perf metrics:

- **LCP** (Largest Contentful Paint): time to render the largest content element. Target under 2.5 s.
- **INP** (Interaction to Next Paint): worst-case input handling latency for the session. Target under 200 ms. Replaced FID in 2024.
- **CLS** (Cumulative Layout Shift): unexpected layout movements after first paint. Target under 0.1.

LCP, INP, and CLS feed Google Search ranking signals, so the metrics are not just internal Chrome quality bars. They drive performance discipline across the entire web ecosystem.

### Tracing Infrastructure: Perfetto

Perfetto is the multi-process tracing system used across Chrome and Android. Architecture:

- Producers (Chrome, Android system services) emit trace events.
- A Perfetto daemon (or in-process mode for Chrome) buffers events.
- Consumers (chrome://tracing UI, perfetto UI, custom analysis) read the trace.

Trace events in C++ code:

```cpp
// In any Chromium code, after #include "base/trace_event/trace_event.h"
TRACE_EVENT0("blink", "Document::UpdateStyle");
TRACE_EVENT1("v8", "Compile", "size", source_size);

{
  TRACE_EVENT_SCOPED("cc", "Raster::Tile",
                     [&](perfetto::EventContext ctx) {
                       ctx.event()->set_int_field(tile_id);
                     });
  RasterTile(tile);
}
```

Categories control which events are recorded. Common ones:

- `blink`, `blink.layout`, `blink.invalidation`
- `v8`, `v8.compile`, `v8.gc`
- `cc`, `cc.tile_manager`
- `gpu`, `gpu.memory`
- `loading`, `mojom`

`chrome://tracing` (or `ui.perfetto.dev`) renders the events as a multi-thread flame graph. Most performance investigations start here.

### Telemetry: The Benchmark Suite

`tools/perf/` contains the Telemetry framework: page sets, measurement implementations, and benchmark runners. Benchmarks include:

- **Speedometer 3** (Apple-led, reflects real framework workloads).
- **MotionMark** (graphics).
- **Jetstream 2** (JavaScript microbenchmarks).
- **System Health** (real-world workflows: news scrolling, reading email, watching video).
- **Loading benchmarks** (LCP, FCP across a corpus of real sites).
- **Memory** (private, shared, GPU memory at various phases).
- **Power** (battery drain on instrumented devices).

The perf bot fleet runs these continuously. A change to V8's IC handling that regresses Speedometer 3 by 0.5% triggers an investigation.

### Pinpoint Bisection

When a perf bot detects a regression, Pinpoint runs a bisection. Algorithm:

1. Identify the regressed metric and the commit range.
2. Run the benchmark at the midpoint commit.
3. Compare to known-good and known-bad reference points.
4. Recurse on the suspect half.
5. Result: a single CL identified as the regression cause, plus statistical confidence.

Bisection is parallelized: multiple commits run simultaneously on different bots. Wall-clock time for a 100-commit bisection is 1 to 4 hours.

### Memory Tracking

Memory is divided into:

- **Private memory.** Pages used only by this process.
- **Shared memory.** Pages shared with other processes (V8 snapshot, Skia textures via shared buffers).
- **GPU memory.** Counted separately, attributed to processes.

The browser process tracks per-process memory through `MemoryDumpManager` and dumps periodic snapshots into trace events. `chrome://tracing` -> Memory Infra surfaces the breakdown.

### Power Tuning

Battery is the tightest constraint on mobile and laptop devices. Sources of power draw:

- **CPU.** Big cores eat 5x to 10x the watts of little cores. Tier-up to TurboFan only when justified by execution time.
- **GPU.** Idle the GPU when nothing is animating. Promote videos to hardware overlays so the GL context can sleep.
- **Display.** Variable refresh rate (60 Hz when static, 120 Hz when scrolling).
- **Network.** Coalesce wakeups. Avoid keeping the radio in high-power state with constant trickles.
- **Sensors.** Permission gates and idle suspend.

Chrome aggressively backgrounds inactive tabs:

- After 5 minutes idle: throttle timers (1 minute granularity).
- After 10 minutes: page may be discarded entirely (tab shows reload page on focus).
- IntersectionObserver-based off-screen iframe throttling.

The `EnergySavingMode` adds extra throttling on low battery: limited frame rate, more aggressive GC, fewer prefetches.

### Frame Budget Tracing

To diagnose jank:

1. `chrome://tracing` with `blink`, `cc`, `v8`, `gpu` categories.
2. Find the long frame (one that exceeded 16.67 ms).
3. Walk the slices on the main thread: where did the time go?
 - Style: long style recalc.
 - Layout: long layout pass, often from forced sync layout.
 - Script: long script execution. Look at the V8 slices underneath.
 - GC: a major GC slice on the main thread.
4. Cross-check the compositor thread for raster waits.
5. Identify the responsible CL with `git log` or Pinpoint.

### "Forced Sync Layout" and Layout Thrashing

A common pattern that ruins frame times:

```js
// Bad:
for (const el of items) {
  el.style.width = (el.offsetWidth + 10) + 'px';  // read after write
}
```

Each `offsetWidth` read forces Blink to flush pending style and layout. Each `width` write invalidates them. The loop does N layouts.

Fixed:

```js
// Read all first, then write all.
const widths = items.map(e => e.offsetWidth);
items.forEach((e, i) => { e.style.width = (widths[i] + 10) + 'px'; });
```

Tracing shows this clearly: many small `Document::UpdateLayout` slices vs one big one. Chrome warns about forced reflows in DevTools' Performance panel.

### V8-Specific Tuning

Common high-use V8 perf wins:

- Keep object shapes stable (initialize properties in the same order).
- Avoid accessing undeclared properties on hot paths (megamorphic ICs).
- Prefer `for (let i = 0; i < arr.length; i++)` over `for...of` for SMI arrays.
- Precompile regexes outside hot paths.
- Use `--turbo-stats` and `--prof` to profile.

### Senior Interview Material

- "What is the RAIL model and how does each component map to a real implementation budget?"
- "Walk through diagnosing a frame drop using a Perfetto trace. What slices do you look at first?"
- "How does Pinpoint bisect a regression? What does it do that a developer cannot easily do by hand?"
- "Explain why `getBoundingClientRect` followed by a style write is a perf bug. Where does the time go?"
- "What does Chrome do to extend battery life on a backgrounded tab?"

The next section steps back and compares the three major browser engines.

---
