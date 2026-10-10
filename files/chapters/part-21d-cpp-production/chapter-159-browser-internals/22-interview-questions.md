## 159.22 Interview Questions

Fifteen deep browser-internals C++ questions, sourced from the kinds of conversations that happen in Chrome, V8, WebKit, and Gecko interview loops. Each question is followed by what a senior or staff-level answer should cover.

### 1. Walk me through what happens between typing `https://example.com` and the page being fully visible.

Coverage expected:

- URL parsing in the browser process. Omnibox -> NavigationRequest.
- DNS via `HostResolver` (system, async, or DoH).
- TCP connection and TLS handshake (or QUIC 0-RTT) in the network service.
- HTTP request, response. HTTP cache check.
- Bytes streamed through Mojo data pipe to renderer.
- Renderer process selection (Site Isolation: existing process for example.com or new).
- HTML parser -> DOM.
- CSS parser -> stylesheet -> style recalc.
- Layout, pre-paint, paint.
- Compositor: layer tree, tile raster on workers.
- Viz aggregation in GPU process.
- Display swap.
- LCP firing when the largest content element paints.

You are expected to mention threads and processes at every stage.

### 2. Why does V8 have four execution tiers?

Each tier solves a different point on the (compile time, output speed) trade-off. Ignition is fast to generate, slow to execute. Sparkplug is a quick win for warm code. Maglev is a mid-cost optimizer that gets most of the perf for half the compile time of TurboFan. TurboFan is the heaviest, used only for very hot code where compile time amortizes. Tiering up is driven by feedback vector counters.

Bonus: explain that Maglev was added in 2023 specifically to close the gap between Sparkplug and TurboFan, because previously hot-but-not-very-hot code paid TurboFan's compile cost for marginal benefit.

### 3. Explain the V8 hidden class (Map) system and inline caches.

Objects start with a Map. Adding a property transitions to a new Map. Two objects with the same property addition history share the same Map. ICs at property access sites cache the Map and offset, becoming monomorphic when one Map dominates. Polymorphic when 2 to 4 are seen. Megamorphic when more, falling back to a hashed dictionary lookup.

Mention: initializing properties in different orders produces different Maps and ruins IC monomorphism.

### 4. Walk me through the V8 garbage collector.

Generational. New gen uses a Cheney-style semi-space scavenger, parallel. Old gen uses Mark-Compact, with incremental and concurrent marking. Tricolor write barrier preserves the marking invariant under concurrent mutation. Orinoco scheduler interleaves marking with idle slices. Compaction selects evacuation pages by fragmentation.

Mention pretenuring (allocation site feedback for objects that always survive) and the unified heap with cppgc (Blink Oilpan integrated into the same GC cycle).

### 5. What is the V8 Sandbox and what threat does it model?

A defense-in-depth mechanism inside the renderer. Assumes V8 has memory-safety bugs. All heap pointers are 32-bit offsets into a 4 GB cage. Corrupted pointers can only reach the cage. External pointers go through a sandboxed pointer table indexed by token. Trusted objects (Code, FunctionTemplate) live in a separate trusted space outside the cage.

Threat: an attacker who exploits a V8 type confusion still cannot freely read/write renderer memory. They have to find another bug in the validation around the cage to escalate.

### 6. Describe Chromium's Site Isolation. Why was it shipped?

Each origin (eTLD+1) gets its own renderer. Cross-origin iframes are hosted out-of-process (OOPIF). The frame tree is unified in the browser, renderers see local frames as `LocalFrame` and remote frames as `RemoteFrame` placeholders.

Motivation: Spectre. Side-channel attacks on a shared renderer could read another origin's memory. Site Isolation removes the cross-origin memory from the address space.

Cost: more processes, more memory. Mitigated on Android where the model degrades under pressure.

### 7. What is Mojo, and how does an interface go from `.mojom` to runtime?

`.mojom` is an IDL. The mojom compiler generates C++ proxy, stub, and validator classes. `Remote<T>` is a typed handle that serializes calls. `Receiver<T>` decodes calls into a virtual dispatch on the impl. Underneath is a message pipe, an OS-level primitive (Unix socket / named pipe / Mach port).

Trust boundary: validators check every incoming message before reaching your handler. A compromised renderer cannot send an out-of-spec message that bypasses your impl.

### 8. Explain Blink's Oilpan. Why is it used instead of `std::shared_ptr`?

Tracing GC for Blink C++ objects. `Member<T>` replaces raw pointers, `Persistent<T>` is a root. The DOM is a graph with cycles (parent-child + observer references), and reference counting would leak. Oilpan handles cycles natively.

Mention incremental marking, write barriers via `Member` assignment, and unification with V8's GC through cppgc so a cycle through JS objects and DOM nodes is collected correctly.

### 9. How does Blink's CSS engine match selectors at scale?

Right-to-left selector matching, RuleSet bucketed by rightmost compound, Bloom filter ancestor pruning, style sharing across siblings, MatchedPropertiesCache for cascade reuse. Invalidation is bounded by per-class invalidation sets that describe which descendants need recalc when a feature changes.

A naive O(elements * rules) would be 50 million matches on a Gmail-sized page. Bucketing and pruning bring it to thousands.

### 10. Walk me through what happens when a CSS `transform` animation runs.

Transforms are compositor-friendly. Once a layer has `will-change: transform` (or is otherwise eligible), Blink promotes it into its own composited layer. Animation runs on the compositor thread, updating the layer's transform matrix per frame, no Blink main-thread work. The GPU process composites the layer with the new transform.

Contrast with `top`/`left` animation: triggers full layout per frame on the main thread.

### 11. Why does the network stack run out of process? Walk through the trust boundary.

Network parsers are a top CVE source: HTTP header parsing, certificate path validation, image decoding inside response handlers. Isolating them in a sandboxed process limits blast radius of a compromise.

Reliability: network process can crash and respawn without taking down the browser. Renderers reconnect.

The Mojo interface between renderer and network service is the trust boundary: the network service treats every renderer message as untrusted, validates origins, and applies cookie partitioning.

### 12. Explain how `getBoundingClientRect` followed by a style write becomes a performance bug.

`getBoundingClientRect` flushes pending style recalc and layout synchronously. A subsequent style write invalidates them. In a loop, you alternate flush and invalidate, doing N layouts where 1 would have sufficed. This is "layout thrashing".

Fix: read all values first, then write all values. Or use `IntersectionObserver` / `ResizeObserver` for async layout reads.

### 13. How does Mojo pass a file handle from one process to another?

A `mojo::PlatformHandle` wraps an OS handle (fd on POSIX, HANDLE on Windows, Mach port on macOS). Mojo's underlying transport (the message pipe IPC) supports passing these out of band: serialized into the message envelope, the kernel transfers ownership across the process boundary (SCM_RIGHTS on Unix, DuplicateHandle on Windows). The receiving side gets a fresh handle in its handle table.

Validation: the receiver should treat the handle as untrusted, check it points to what it expects (e.g., a regular file vs a device node).

### 14. Compare the V8 and JSC GC strategies.

Both are generational, concurrent. V8: Scavenger for new gen, Mark-Compact for old gen, Orinoco scheduler. JSC: Riptide concurrent collector, also generational, with constraint solving for retention.

Differences: JSC integrates GC with the JIT's deoptimization machinery differently. V8 uses precise stack scanning via stack maps in optimized code. JSC's bmalloc is its allocator and integrates with the GC for fast paths.

### 15. Why does Chrome force MV3 for extensions? What changed architecturally?

MV3 replaces persistent background pages with service workers, replaces blocking `webRequest` with `declarativeNetRequest`, forbids remote code, and tightens permissions.

Motivations:

- Memory: persistent backgrounds were always-on overhead. SW gets torn down idle.
- Performance: blocking webRequest forced a browser-renderer round trip per request, slowing every fetch. Declarative rules evaluate in the network service.
- Security: remote code injection (a major MV2 abuse vector) is blocked.
- Privacy: tighter permissions reduce data exposure surface.

Mention the controversy: ad-blockers argue declarativeNetRequest is less expressive than blocking webRequest, and Chrome eventually raised rule limits in response.

The next section gives hands-on lab exercises.

---
