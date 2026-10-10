## 159.1 Learning Objectives

By the end of this chapter you will be able to:

### Architectural Understanding

- Draw the Chromium multi-process architecture from memory: browser, renderer, GPU, network, utility, audio service, storage service. Explain which process owns which resource, which is sandboxed, and what the IPC topology looks like.
- Describe Site Isolation: when each origin gets its own renderer, the trade-offs in process count vs memory, and how cross-origin iframes are handled (out-of-process iframes, OOPIF).
- Explain why Chrome forked Blink from WebKit in 2013, what survived from WebCore, what was rewritten, and how Blink and WebKit diverged on threading models, V8/JSC bindings, and resource loading.
- Map a Chromium feature request to the right layer: `chrome/`, `content/`, `components/`, `services/`, or `third_party/blink/`.

### Mojo IPC

- Author a `.mojom` interface, generate C++ bindings, implement the interface in one process, bind a remote in another process, and reason about lifetime when either end disconnects.
- Distinguish associated interfaces, sync calls, message pipes, data pipes, and shared buffers. Pick the right primitive for streaming a 100 MB upload vs a 200-byte settings change.
- Audit a Mojo interface for sandbox-escape risk: trust boundaries, validation, and what happens when a compromised renderer sends malformed messages.

### Blink Rendering Engine

- Walk a DOM mutation through to pixels: parser, DOM tree, style recalc, layout, paint, raster, compositor, display.
- Explain BlinkGC (Oilpan): what is on the Oilpan heap vs the C++ heap, when finalizers run, and why a `Member<T>` cannot point to a non-Oilpan object.
- Read a layout tree dump and identify why a particular subtree was invalidated.
- Identify the fast paths in style invalidation (descendant invariants, sibling sets, BloomFilter ancestor pruning) and write CSS that hits them.

### V8 Internals

- Explain the four-tier execution pipeline: Ignition bytecode interpreter, Sparkplug baseline JIT, Maglev mid-tier optimizer, TurboFan top-tier optimizer. Know the trigger thresholds and tier-up mechanics.
- Describe hidden classes (Maps), inline caches (monomorphic / polymorphic / megamorphic), and how a single type confusion deoptimizes hot code.
- Walk through the generational GC: Scavenger semi-spaces, Mark-Compact for old generation, incremental and concurrent marking under the Orinoco scheduler, write barriers, and finalization.
- Embed V8 in a standalone C++ program: create an `Isolate`, bind a C++ function into JavaScript, return a value, and tear down cleanly without leaking handles.

### Graphics Pipeline

- Trace a `<canvas>` 2D draw call from JavaScript through the V8 binding into Skia and out through the GPU process command buffer.
- Compare Ganesh and Graphite, the two Skia GPU backends. Understand why Graphite was written, what changed in the API surface, and the timeline for replacing Ganesh.
- Explain the cc (Chromium compositor) layer tree, tile rasterization, BeginFrame protocol, and how Viz aggregates surfaces from multiple renderers.

### Network Stack

- Map a `fetch()` call from JavaScript through Blink, into the network service via Mojo, through `URLRequest`, into the HTTP/2 or HTTP/3 (QUIC) session, out through TLS, and back.
- Explain HTTP/3 / QUIC integration in Cronet, including 0-RTT, connection migration, and how QUIC bypasses TCP head-of-line blocking.
- Reason about certificate verification, CT logs, HSTS preload, and how the network service isolates network parsing from the rest of the browser.

### Storage Stack

- Compare IndexedDB, Cache Storage, LocalStorage, and Storage Buckets. Know the underlying LevelDB layout and the per-origin quota system.
- Explain Service Worker registration, the install/activate lifecycle, the fetch event interception model, and why Service Workers are isolated to their own threads in the renderer.

### Security Model

- Explain seccomp-bpf renderer sandbox on Linux, AppContainer on Windows, and the seatbelt sandbox on macOS. Know which syscalls remain allowed and why.
- Reason about exploit mitigations: stack cookies, ASLR, CFI (control-flow integrity), Windows CFG, MTE on ARMv8.5, V8 sandbox, Oilpan compaction.
- Audit a feature CL for sandbox-escape risk: privileged resource access, IPC validation, capability passing.

### Tooling

- Build Chromium from source with GN and ninja, configure a release build, run a single component test, and submit a CL to Gerrit.
- Use perfetto and `chrome://tracing` to profile a page load, identify a layout thrash, and attribute time to the right thread.
- Reproduce a regression locally, bisect with `git bisect` or Pinpoint, and write a CL with the test that catches the regression.

### Communication

- Talk fluently about browser-internals topics in a Chrome / V8 / WebKit interview at the senior or staff level.
- Read a public Chromium design doc, ask the right follow-up questions, and write a counter-proposal that fits the existing architecture.

The next sections work through each of these in depth, starting with the multi-process architecture that everything else builds on.

---
