## 159.5 V8 Internals Overview

V8 is the JavaScript and WebAssembly engine that ships in Chrome, Node.js, Electron, Deno, and Cloudflare Workers. It lives in the `v8/` top-level directory of Chromium and is also a standalone repo. V8 is roughly 2 million lines of C++, plus generated code, plus a substantial Torque (a domain-specific language for V8 builtins).

### The Tier Pipeline

As of 2024, V8 has a four-tier execution pipeline:

```
JavaScript source
   |
   v
Parser  ->  Pre-parser (lazy)
   |
   v
Bytecode generation (Ignition)
   |
   v
Ignition interpreter  ----+
   |                       \
   | (warm: ~100 calls)     \
   v                         \
Sparkplug baseline JIT  -----+
   |                          \
   | (hot: ~500 calls)         \
   v                            \
Maglev mid-tier JIT  -----------+
   |                             \
   | (very hot, type-stable)      \
   v                               \
TurboFan top-tier optimizer  ------+
                                    \
                          (deopt) <--+
```

**Ignition** is a register-based bytecode interpreter. Bytecode is compact (good for memory on Android), portable across architectures, and fast to generate. Most code on a typical page runs only in Ignition because it executes a few times and is not worth optimizing.

**Sparkplug** is a non-optimizing, non-deoptimizing baseline JIT. It compiles bytecode to native code linearly, one bytecode handler at a time, with no inlining and no type speculation. It is roughly 5x to 10x faster than Ignition while compiling in microseconds. Sparkplug shipped in Chrome 91 (2021).

**Maglev** is a mid-tier optimizer. It does basic type speculation and inlining but uses a simpler IR than TurboFan. Maglev compiles 10x faster than TurboFan and produces code that is roughly half as fast. Maglev shipped in Chrome 117 (2023) and is on by default for many workloads.

**TurboFan** is the top-tier optimizer. Sea-of-nodes IR, full inlining, escape analysis, range analysis, deoptimization-based speculation. Compile time is high, output is the fastest tier.

The runtime promotes a function up tiers when call counts and execution time cross thresholds. It demotes (deoptimizes) when speculation fails.

### Hidden Classes (Maps)

JavaScript objects are dynamic, but V8 internally stores them as if they were typed structs. The "type" of an object is a `Map` (V8's name for a hidden class), which describes the property layout: which property names exist, in what order, at what offsets.

```js
const a = {};
a.x = 1;       // Map M0 -> Map M1 (added x at offset 0)
a.y = 2;       // Map M1 -> Map M2 (added y at offset 1)

const b = {};
b.x = 1;       // Map M0 -> Map M1 (transitions are shared)
b.y = 2;       // Map M1 -> Map M2 (b ends up with same map as a)
```

If you initialize properties in different orders across instances, you get different maps:

```js
const c = {};
c.y = 2;       // Map M0 -> Map M3
c.x = 1;       // Map M3 -> Map M4 (different from M2!)
```

`a` and `b` share Map M2, `c` has Map M4. Code that operates on `c` cannot use the inline cache it set up for `a`. Lesson for performance-sensitive JS: initialize properties in the same order.

In V8 source: `src/objects/map.h`. A `Map` is itself a heap object with fields for instance size, descriptor array, prototype, and transition tree.

### Inline Caches

A property access `obj.x` in bytecode is `LdaNamedProperty` with an embedded slot in the closure's feedback vector. The first call records the receiver's Map and the property's offset into the slot. Subsequent calls compare the receiver's Map against the cached one and, on match, load directly from the offset.

States:

- **Uninitialized.** First call, no data.
- **Monomorphic.** One Map seen. Branch-and-load, fast path.
- **Polymorphic.** Two to four Maps seen. Linear probe.
- **Megamorphic.** More than four Maps. Falls back to a hash lookup.

A function written generically over many shapes degenerates to megamorphic and runs ~10x slower than a monomorphic version. This is why React's reconciler tries to keep "fiber" objects shape-stable.

The IC code is in `src/ic/`. The optimizing compilers read IC state to decide which speculations to make.

### Deoptimization

TurboFan (and Maglev) generate code that assumes IC speculations hold. If the assumption is violated at runtime, the code "deoptimizes": execution transfers back to the interpreter at the corresponding bytecode offset, with all live values reconstructed.

The mechanism: the optimizer emits `DeoptimizeIf` checks. On failure, control jumps to a deopt entry that consults the `DeoptimizationData` (mapping from optimized PC to bytecode offset and frame state) to rebuild the interpreter frame.

Deopt is expensive: tens to hundreds of microseconds. A function that deopts repeatedly is "deopt loop" pathological and gets blocklisted from optimization. Common causes:

- A property's stored type changes (was always `Smi`, now sometimes `HeapObject`).
- An `Array` becomes a "holey" array (sparse) when it was assumed packed.
- A function is called with a different number of arguments than the optimized version assumes.
- A `try/catch` is entered (older V8 versions deopted, current versions handle catch in optimized code).

### The Heap

V8's managed heap has multiple spaces:

- **New space.** Two semi-spaces for the Scavenger collector. Most allocations land here. Roughly 1 to 16 MB per Isolate.
- **Old space.** Survivors of two scavenges. Mark-compact collected.
- **Large object space.** Objects bigger than ~512 KB (skip generational collection).
- **Code space.** Generated machine code.
- **Read-only space.** Shared across Isolates: roots, builtins, well-known objects.
- **Trusted space.** Recent (V8 12.x): for objects whose integrity is required for V8's sandbox, stored outside the sandboxed pointer-cage.

The heap is described in `src/heap/`. GC is covered in the next section, on V8 garbage collection.

### Pointer Compression and the V8 Sandbox

On 64-bit systems V8 uses pointer compression: heap pointers are stored as 32-bit offsets into a 4 GB cage allocated at Isolate startup. This halves the size of every pointer in the JS heap (a Map header has many pointers, so this matters for memory).

The V8 Sandbox is a defense-in-depth feature where heap accesses are bounds-checked into the cage. An attacker who corrupts a JS object pointer can only reach addresses inside the cage, not arbitrary memory in the renderer. The sandbox shipped as a runtime configuration in 2024 and is being expanded year over year.

### Embedder API Surface

The public C++ API in `include/v8.h` is what Chromium, Node, Electron use. Key types:

- `v8::Isolate`: a complete V8 instance. Single-threaded. Owns one heap.
- `v8::Context`: a JavaScript global scope. Multiple Contexts can share an Isolate.
- `v8::Local<T>`: a stack-rooted handle. Lives within a `HandleScope`.
- `v8::Persistent<T>`: a long-lived handle.
- `v8::FunctionTemplate`, `v8::ObjectTemplate`: factories for binding C++ functions and objects into JS.

The embedder API section that follows covers this in detail with a working example.

### WebAssembly

V8 also implements WebAssembly. The pipeline:

```
.wasm bytes
   |
   v
Liftoff baseline compiler  -> code, fast compile
   |
   v
TurboFan tier-up           -> optimized code
```

Liftoff is a streaming, single-pass baseline compiler analogous to Sparkplug. TurboFan re-uses its IR for Wasm functions.

### Performance Numbers Worth Memorizing

- Cold function call (first time, parsed): ~1 to 5 microseconds depending on size.
- Ignition bytecode dispatch: ~0.5 ns per bytecode.
- Sparkplug call: roughly 2x to 5x faster than Ignition for hot loops.
- Maglev call: ~10x faster than Ignition.
- TurboFan call: ~20x to 50x faster than Ignition for numeric workloads.
- Map transition (first time): ~100 ns.
- IC miss to megamorphic: ~50 ns extra per access vs monomorphic.
- Minor GC (Scavenge): 1 to 5 ms typical.
- Major GC (Mark-Compact, with concurrent marking): 50 to 200 ms total wall, under 10 ms on main thread.

### Senior Interview Material

- "Why does V8 have four tiers? What problem does each tier solve?"
- "Walk me through what happens at the bytecode and IC level when I call `obj.x` for the first time, the tenth time, and the millionth time."
- "What is a deoptimization, and what triggers it?"
- "How does pointer compression work, and what is its memory cost?"
- "Compare Maglev to TurboFan: when would you ship a feature that runs only in Maglev?"

The next section dives into the garbage collector, which is the half of V8 that the embedder rarely sees but always pays for.

---
