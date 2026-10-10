## C++ vs Go: When Go Is Not Enough

> **Junior to FAANG:** Go is the right answer for most backend services. If you are reaching for C++, be ready to defend the choice in design review with numbers, not vibes.
>
> **Senior at FAANG:** The interesting question is not "C++ or Go", it is "which 5% of this system pays the C++ tax". Identify the hot path, isolate it, keep the rest in Go.

Go is an excellent language. You probably know it well if you are reading this book. The point of this section is not to disparage Go but to mark the lines where Go's design choices stop fitting the problem.

### The GC Pause Problem

Go's garbage collector is genuinely impressive. The Go 1.27 collector targets sub-millisecond stop-the-world pauses on most workloads. For a typical request-response server, this is invisible.

It is not invisible everywhere.

**High-frequency trading.** A market data tick arrives. You need to compute, decide, and send an order in under 1 microsecond on the wire. A 500 microsecond GC pause is a catastrophic event. Citadel, Jane Street's C++ side, Hudson River Trading, Two Sigma's latency-critical paths, and IMC all run C++ for this reason. Some shops use Java with Azul's Zing or pause-free GCs and accept worse 99.99th percentile. Almost none use Go.

**Real-time audio.** A 48 kHz audio buffer at 64 frames means you have ~1.3 milliseconds to fill the next buffer. A GC pause causes an audible glitch. JUCE, the dominant audio plugin framework, is C++. AudioKit's DSP layer is C++ with Swift wrappers. Live performance DAWs (Ableton, Bitwig, Pro Tools) are all C++.

**Real-time control.** Drone flight controllers, industrial robotics, automotive ADAS. Hard real-time deadlines mean a GC pause is not "slow", it is "the wrong answer". These are C++ or C territory, often with a real-time kernel underneath.

**Game engines.** A 144 Hz target gives you 6.9 ms per frame. AAA engines budget GPU submission, physics, animation, AI, and audio inside that window. Even a 2 ms GC pause every few frames is a noticeable hitch. Unreal, CryEngine, id Tech, Frostbite, Source 2, RE Engine. All C++.

The pattern: any time the 99.9th percentile latency matters more than the median, GC becomes a liability. Go's design optimizes for throughput and median latency, which is correct for almost all backend work and wrong for these domains.

### Tight Memory Budgets

The Go runtime currently has a baseline of around 4-8 MB of memory just to start a binary that prints "hello". The garbage collector keeps a working set typically 2x the live heap. Maps, slices, and goroutine stacks all carry overhead.

If you have an embedded target with 256 KB of RAM (a Cortex-M4 microcontroller), Go is not an option. TinyGo exists, runs on some MCUs, and it is interesting research. It is not what ships in shipping consumer hardware in volume. Shipping firmware in 2026 is C, C++, sometimes Rust, occasionally MicroPython for prototypes.

Kernel work is the same story. The Linux kernel does not link against libc, has no malloc in the conventional sense, and is written in C with optional Rust support since 6.1. There is no path to running Go in ring 0. The same goes for kernel drivers and bootloaders.

Memory-constrained user space (think a SQLite-style embedded database that needs to run inside someone else's process with a 1 MB total footprint) is also off the table for Go.

### Inline Assembly and SIMD

Go has limited intrinsics support. You can write Plan 9 assembly in `.s` files, which works but is awkward (Plan 9 syntax is not what Intel's manual uses). Go has no equivalent of GCC's `__attribute__((target("avx2")))` runtime dispatch with intrinsics.

For SIMD-heavy work (image codecs, video encoders, cryptography, neural network inference, database SIMD scans), you want the C/C++ intrinsics headers (`<immintrin.h>`, `<arm_neon.h>`) or compiler auto-vectorization. C++ also gets you `std::simd` (P1928, in C++26) and Highway, Eve, xsimd as portable libraries.

Concrete example: x265 (HEVC encoder) is C++ with hand-tuned AVX2, AVX-512, and NEON kernels. You will not match its performance from Go.

### Deterministic Destruction (RAII for Non-Memory Resources)

This is the underrated reason senior engineers reach for C++. Go's `defer` runs at function return. C++'s destructors run at scope exit, deterministically, in reverse order of construction.

This matters for non-memory resources where order and timing are correctness, not just hygiene.

```cpp
// C++: lock guards, scoped transactions, scoped GPU contexts.
{
    std::scoped_lock lock(mu_);
    auto txn = db.begin_transaction();
    auto gpu = cuda::scoped_context(device_id);
    auto trace = tracing::scoped_span("compute");
    work();
    // Destructors run in reverse: trace, gpu, txn (commit or rollback), lock.
} // Exact, predictable cleanup order.
```

Go's `defer` works for the simple case. It does not compose into reusable RAII types. You cannot return a "guard object" from a function and have its cleanup run when the caller's scope ends. This forces awkward patterns: factory functions return `(value, cleanup func, error)` triples, and callers must remember to call cleanup.

For CUDA streams, GPU contexts, file descriptors that must be closed in a specific order, transactions that nest, audio buffers, mmap regions, this is a real productivity gap.

### C Interop

Go has cgo. Cgo works. Cgo is also slow (several hundred nanoseconds per call), painful to debug, and breaks Go's runtime assumptions in ways that show up as obscure goroutine scheduling bugs. Every senior Go engineer eventually learns to minimize cgo calls.

C++ has zero-cost C interop because C++ is a near-superset. `extern "C"` works. Header inclusion works. Linking works. There is no FFI overhead.

If you are writing a database that links against `librdkafka`, `libpq`, `libcurl`, OpenSSL, libuv, ZeroMQ, gRPC C++, or any vendor SDK shipped as a C/C++ library, your life is meaningfully easier in C++.

Drivers and kernel modules are C-only on Linux, C++ inside the Windows kernel (with restrictions), and a mix on macOS (DriverKit is C++).

### Heavy Template Metaprogramming

Go generics (since 1.18) cover the common cases: generic containers, generic algorithms, type-parameterized functions. They do not give you compile-time computation.

C++ templates are Turing-complete and give you:

- Compile-time strings, regex, JSON parsing (`constexpr` everywhere in C++20+)
- Expression templates for numerical libraries (Eigen, Blaze)
- Type-level state machines and protocol checking
- Zero-cost abstractions where the optimizer can see all the way through

If you are writing Eigen, a template-heavy ECS for a game engine, a compile-time SQL DSL, or a numerics library that must compile down to perfect assembly, Go cannot meaningfully compete.

### When to Stay in Go

This is the more important list, because it covers 90% of work at most companies including FAANG:

- **Backend services.** REST and gRPC services that fan out to databases and other services. Go is excellent here. Writing this in C++ buys you nothing but pain.
- **CLI tools.** Single static binary, fast startup, cross-compilation. Go wins.
- **Cloud infrastructure tooling.** Kubernetes, Docker, Terraform, Prometheus, Helm. The whole modern infra stack is Go because Go's deployment story (one static binary) fits the operator model.
- **Network services with simple per-request work.** Reverse proxies, load balancers, API gateways, ingestion pipelines. Go's goroutine model is purpose-built for this.
- **Anything where 99th percentile of 50 ms is acceptable.** That covers most of consumer SaaS.
- **Glue code, data pipelines, batch jobs, internal tools.** Go's standard library plus `go test` plus `go build` is unbeatable for productivity.

### The Pragmatic Decision Tree

1. Is the 99.9th percentile latency budget under 1 ms? Consider C++ or Rust.
2. Does it run on a constrained device (sub-MB RAM, embedded MCU, kernel)? C, C++, or Rust.
3. Is it CPU-bound on SIMD-friendly numerical work? C++ or Rust.
4. Does it link against a major C/C++ library where cgo is the bottleneck? C++ if the library is C++.
5. Does it need template metaprogramming or expression templates? C++.
6. Otherwise: stay in Go. You will ship faster.

### A Real Example from a Hybrid System

A common pattern at a mid-size HFT shop or a mid-size adtech company: the order book or auction core is C++, the surrounding infrastructure (config service, monitoring, RPC routing, CI tooling, on-call runbooks) is Go.

```
+------------------+         shared memory or             +-----------------+
|  Go control      |  <----  small ringbuffer  ---->     |  C++ hot loop   |
|  plane           |         (single-producer,            |  (lock-free,    |
|  - config push   |          single-consumer)            |   no GC)        |
|  - metrics       |                                      |                 |
|  - ops endpoints |                                      |                 |
+------------------+                                      +-----------------+
```

Roughly 70% of code lives in Go (which is 95% of *engineer time*) and 30% in C++ (which is 99% of *latency-critical execution*). This is the real shape of a senior C++ role at a company that is not pure HFT or pure game dev. You write C++ where it pays for itself, Go everywhere else, and you maintain the boundary aggressively.
