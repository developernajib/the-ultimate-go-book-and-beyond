## 159.23 Summary

A browser is the largest piece of consumer C++ software in production. Chromium passed 35 million lines in 2024, with major contributions from V8, Skia, libwebrtc, BoringSSL, and dozens of other vendored components. Working on Chrome, V8, WebKit, or Gecko means working at the intersection of:

- A multi-process architecture with strict trust boundaries enforced by per-OS sandboxing primitives (seccomp-bpf on Linux, AppContainer on Windows, Seatbelt on macOS).
- A typed IPC system (Mojo) where every interface is generated from `.mojom` IDL with validators that reject malformed messages from compromised processes.
- A rendering engine (Blink) that walks DOM mutations through style recalc, layout, paint, and compositor stages within an 8 ms budget per frame.
- A JavaScript engine (V8) with four-tier execution (Ignition / Sparkplug / Maglev / TurboFan) and a generational, mostly-concurrent garbage collector (Orinoco).
- A graphics library (Skia) transitioning from Ganesh to Graphite for modern GPU APIs.
- A network stack with HTTP/2 and HTTP/3 over QUIC, sandboxed in its own process.
- A storage stack with origin-partitioned IndexedDB, Cache Storage, and Storage Buckets backed by LevelDB.
- A DevTools Protocol that drives the in-browser debugger, headless mode, Puppeteer, and Playwright.

The interview bar at Chrome, V8, WebKit, and Gecko is high because the work is high. A senior engineer is expected to understand the multi-process architecture, the rendering pipeline, the V8 tier system, the GC, the security model, and the build tooling well enough to ship features without regressing perf, security, memory, or binary size. The metric is not "does the test pass" but "did Speedometer 3 stay green, did the renderer process count not regress, did the patch-gap stay under a week".

The path forward for an engineer who wants to work on browsers:

1. Build Chromium from source. Ship a CL, even a small one.
2. Write a V8 embedder. Understand handles and contexts viscerally.
3. Profile a real page with Perfetto. Identify a bottleneck.
4. Read a Blink design doc and ask the right follow-up question on blink-dev.
5. Repeat for a year.

The compensation for this kind of work is among the highest in the industry. The reason is the same as the reason the work is hard: there are perhaps a few thousand engineers in the world who can contribute meaningfully to a production browser engine, and the demand far exceeds the supply.

The next chapters of this book cover graphics APIs (Vulkan, DirectX, Metal) and audio DSP, both of which are adjacent areas a browser engineer often touches.

---

| [◀ Chapter 158: Production Reliability for C++ Services](../chapter-158-production-reliability/00-introduction.md) | [Chapter 159: Browser Internals in C++](00-introduction.md) | [Chapter 160: Game Engine Architecture in C++](../chapter-160-game-engine-architecture/00-introduction.md) ▶ |
