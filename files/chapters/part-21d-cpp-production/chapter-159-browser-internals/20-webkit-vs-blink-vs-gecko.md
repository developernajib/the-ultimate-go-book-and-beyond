## 159.20 WebKit vs Blink vs Gecko

There are three independent browser engine codebases shipped at scale today: Blink (Chrome, Edge, Opera, Brave, Electron), WebKit (Safari, all iOS browsers because of App Store policy), and Gecko (Firefox). They share a common ancestor in Mosaic / Netscape but have diverged enough that working on one is meaningfully different from working on another.

### Lineage

- **Mosaic / Netscape (1993-1998).** First widely-used browser code base.
- **Mozilla** (1998 open source release). Becomes Gecko.
- **KHTML** (1998 KDE). Independent rewrite from scratch.
- **WebKit** (2001). Apple forks KHTML for Safari.
- **Chrome** (2008). Forks WebKit for the original Chromium.
- **Blink** (2013). Chrome forks WebKit's WebCore into Blink.
- **Edge** switches from EdgeHTML to Blink (2020).

### Why Chrome Forked Blink in 2013

Chrome and Apple shared WebKit from 2008 to 2013. Tensions:

- **Multi-process model.** Chrome had one. WebKit2 was Apple's later answer, with a different design Chrome did not want to adopt.
- **JavaScript engine.** Chrome used V8. Apple used JavaScriptCore (JSC). Bindings code was forked-in-spirit already.
- **Build system.** Chromium used GYP/GN. WebKit used CMake and Xcode projects.
- **Threading model.** Chrome's compositor and threading divergence required structural changes Apple did not want.

The fork let both sides iterate without coordinating. Blink immediately removed code that Chrome did not use (other ports' platform abstractions, vendor-prefix rules) and started a "warden" effort to delete or refactor large parts of the codebase. Within a year Blink was meaningfully cleaner and faster.

WebKit continued evolving in parallel. WebKit2's process model diverged from Chrome's. JSC added the FTL JIT, then B3, then DFG/FTL/B3 multi-tier (similar in spirit to V8's tiered approach). Core architectural decisions on each side reflected the team's priorities.

### Architectural Differences

| Aspect | Blink | WebKit | Gecko |
|---|---|---|---|
| JavaScript engine | V8 | JavaScriptCore (JSC) | SpiderMonkey |
| GC | Oilpan + V8 GC | bmalloc + JSC GC | Cycle Collector + SpiderMonkey GC |
| Layout | LayoutNG | WebKit RenderTree | Servo-derived (Stylo) |
| Style | Blink style engine | WebKit style | Stylo (parallel) |
| Compositor | cc/ + Viz | WebKit compositor | WebRender |
| Process model | Browser/Renderer/GPU/Network/etc. | UIProcess/WebContent | Parent/Content/GPU |
| Build | GN + Ninja | CMake / Xcode | Mach (Python) + Cargo + make |
| Language | C++ + Mojo IDL | C++ + Objective-C++ on Apple | C++ + Rust |

### V8 vs JavaScriptCore vs SpiderMonkey

All three are tiered JIT engines. The pipelines:

**V8.** Ignition (interpreter) -> Sparkplug (baseline JIT, no opt) -> Maglev (mid-tier) -> TurboFan (top-tier).

**JavaScriptCore.** LLInt (interpreter) -> Baseline JIT -> DFG (Data Flow Graph, mid-tier) -> FTL (Faster Than Light, top-tier, B3 IR backend).

**SpiderMonkey.** Interpreter -> Baseline Interpreter -> Baseline JIT -> Warp/Ion (top-tier).

Each has its idiosyncrasies. JSC's Baseline JIT is more aggressive than V8's Sparkplug (more inline caching). DFG is conceptually similar to Maglev but predates it by a decade. FTL was the first browser-class JIT to use a general-purpose backend (LLVM, then B3). SpiderMonkey's WarpMonkey (the latest top tier) is a major rewrite that consolidated previous tiers.

Hidden classes: V8 calls them Maps, JSC calls them Structures, SpiderMonkey calls them Shapes. Same idea: monomorphic ICs over a stable property layout.

GC: V8 uses generational, mostly-concurrent, mark-compact. JSC uses Riptide (concurrent, generational, parallel). SpiderMonkey uses generational with concurrent marking.

### Servo and Stylo

Mozilla started Servo around 2012 as a research project to build a browser engine from scratch in Rust, with parallelism as a first-class design constraint. Servo never became a full browser engine, but two of its subsystems were upstreamed into Gecko:

- **Stylo.** The CSS style system from Servo, ported into Firefox in 2017. Implements style recalc with parallel work-stealing across cores. A multi-core style recalc is up to 2x faster than the previous serial Gecko implementation.
- **WebRender.** A GPU-driven renderer that treats display lists as scenes for a custom GPU shader-based renderer. Shipped in Firefox in 2018, replacing the older painting code.

Servo itself was donated to the Linux Foundation in 2020 and continues as an independent project. It is not used as a production browser engine but is a research vehicle for parallel layout and other ideas.

### WebKit's Role on iOS

Apple's App Store policy historically required all iOS browsers to use WebKit. Chrome on iOS, Firefox on iOS, all the third-party iOS browsers shipped wrapped UIs over the system WebKit (`WKWebView`). The actual rendering, JavaScript, and networking all go through WebKit.

EU's Digital Markets Act pressure in 2024 forced Apple to allow alternative engines on iOS in the EU. The mechanism is "Browser Engine Choice", where browsers can ship their own engine if they meet Apple's terms. Adoption has been slow because the engineering cost (porting Blink to iOS, passing Apple's review) is enormous.

### Differences in Threading

Blink: most rendering on one main thread per renderer, with the compositor on a second thread, raster on a worker pool. Each Service Worker, each Web Worker, each cross-origin iframe gets its own renderer process.

WebKit (WebKit2): "WebContent" process per origin (similar to Site Isolation in Chrome). Compositor in a separate "GPU process". Networking in a "Networking process".

Gecko: "Content" process per group of tabs (Fission, Mozilla's name for Site Isolation, shipped 2021). Compositor in the parent process historically. WebRender moved to a GPU process model.

The threading-model differences are why the same web platform feature can have meaningfully different performance characteristics across browsers. A heavily-animated page may hit different bottlenecks on Blink (main-thread JS competing with style) vs WebKit (compositor IPC) vs Gecko (Stylo's parallel recalc).

### Standards Bodies and Coordination

The web platform is specified at:

- **W3C.** CSS, ARIA, Web Components, others.
- **WHATWG.** HTML, DOM, Fetch, URL, Streams.
- **TC39.** JavaScript (ECMAScript).
- **IETF.** HTTP, QUIC, TLS.
- **WebGPU CG, GPUWeb.** WebGPU.

Engines participate in spec work, file interop bugs, and sometimes converge through `web-platform-tests`, the shared test suite at `wpt.live`. WPT scores are the public scoreboard for spec interop and are tracked tab by tab on `wpt.fyi`.

### Why It Matters for Engineers

If you are interviewing for one of these teams:

- **Chrome / V8 / Blink.** Expect deep questions on the multi-process architecture, Mojo, V8 ICs, and the rendering pipeline.
- **WebKit at Apple.** Expect questions on JSC's tier pipeline, WebKit2's UIProcess/WebContent split, and CoreAnimation integration.
- **Firefox / Gecko at Mozilla.** Expect questions on Stylo's parallelism, Rust/C++ FFI, WebRender, and the differences between Stylo's invalidation and Blink's.
- **Edge at Microsoft.** Most engineering is on top of upstream Blink, so Chrome/Blink knowledge transfers. Microsoft contributes upstream and adds a few Edge-only features (WebView2 embedder API).

### Senior Interview Material

- "Why did Chrome fork Blink from WebKit?"
- "Compare V8 and JavaScriptCore's tiering. What does each call its tiers?"
- "What is Stylo, and what does parallel style recalc buy?"
- "Why was Servo built in Rust, and what shipped in Firefox?"
- "Why did all iOS browsers use WebKit until 2024, and what changed?"

The next section is the interview-question bank.

---
