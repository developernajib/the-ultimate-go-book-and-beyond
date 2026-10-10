## C++ at FAANG

Every major technology company maintains significant C++ codebases and actively develops new C++ infrastructure. Staff-level engineers need to know these projects because you will either use them directly, interface with them, or be asked about them in system design interviews.

### Google

Google is arguably the largest C++ shop in the world. Their internal codebase contains billions of lines of C++, and they have invested enormously in C++ tooling, libraries, and language evolution. Several Google engineers sit on the C++ standards committee.

**Abseil** is Google's open-source collection of C++ library components designed to augment the C++ standard library. It provides hash maps (the `SwissTable` implementation that is significantly faster than `std::unordered_map`), string utilities, time libraries, synchronization primitives, and status types. Abseil represents Google's philosophy that the standard library is a starting point, not a destination.

```cpp
// Abseil's flat_hash_map vs std::unordered_map
#include "absl/container/flat_hash_map.h"

// Swiss Table: open addressing, SIMD-accelerated probing
// ~2x faster than std::unordered_map for most workloads
absl::flat_hash_map<std::string, int> word_counts;
word_counts["hello"] = 1;
word_counts["world"] = 2;

// Compare to Go's built-in map (which uses a similar Swiss Table
// design since Go 1.24's map implementation overhaul):
// wordCounts := map[string]int{"hello": 1, "world": 2}
```

**gRPC** was created at Google and its core implementation is C++. The C++ implementation (`grpc_core`) is the reference implementation from which other language bindings (including Go's `grpc-go`, which is a pure Go reimplementation) derive their protocol understanding. If you have used gRPC in Go, you have used a system whose protocol and design originated in C++.

**Spanner** is Google's globally distributed, strongly consistent database. Its storage layer and distributed consensus implementation are C++. Spanner handles Google's advertising data, Play Store transactions, and Cloud Spanner (the external product). The paper "Spanner: Google's Globally-Distributed Database" describes a system where microsecond-level clock synchronization (TrueTime) and nanosecond-level timestamp comparison are fundamental to correctness. This is C++ territory.

**Protobuf** (Protocol Buffers) has its core serialization/deserialization in C++. The Go protobuf library (`google.golang.org/protobuf`) reimplements the logic in Go but follows the C++ reference semantics.

**Chrome/V8/Blink**, as discussed above, are Google's browser stack, entirely in C++.

**TensorFlow** was created at Google Brain. Its core is C++ with Python bindings.

### Meta (Facebook)

**Folly** (Facebook Open-source Library) is Meta's collection of C++ components that complement Abseil and Boost. It includes:
- `folly::fbvector`: a `std::vector` replacement with better growth policies
- `folly::FBString`: an optimized string with small string optimization
- `folly::ConcurrentHashMap`: a lock-free concurrent hash map
- `folly::Future`/`folly::Promise`: an async programming model
- `folly::IOBuf`: zero-copy buffer chains for networking

```cpp
// Folly's IOBuf: zero-copy buffer chains
// Compare to Go's bytes.Buffer which copies on every write
#include <folly/io/IOBuf.h>

auto buf = folly::IOBuf::create(1024);
// Chain buffers without copying
auto chain = folly::IOBuf::create(512);
buf->appendChain(std::move(chain));
// Total: 1536 bytes across two buffers, zero copies
```

In Go, `bytes.Buffer` copies data internally, and `io.Reader`/`io.Writer` interfaces add indirection. Folly's `IOBuf` is designed for networking code where copying a 64KB buffer instead of passing a pointer costs measurable microseconds at scale.

**RocksDB**, as discussed, was created at Facebook and remains one of the most important C++ projects in the database world.

**Thrift** is Meta's RPC framework (predating gRPC). Its compiler and runtime are C++, with code generation for multiple languages including Go.

**HHVM** (HipHop Virtual Machine) is Meta's PHP/Hack runtime, written in C++. It JIT-compiles PHP into machine code.

**Proxygen** is Meta's HTTP framework, powering their load balancers that handle billions of requests daily.

### Apple

**LLVM/Clang**, as discussed, was originally an Apple-funded project at the University of Illinois. Apple is the largest contributor to LLVM and uses it as the compiler for all Apple platforms.

**Metal** is Apple's GPU API. The shading language (Metal Shading Language) is based on C++14. The runtime and driver are C++.

**WebKit** is Apple's browser engine (used in Safari and all iOS browsers). Like Chromium, it is primarily C++.

**Core ML**, **ARKit**, and **RealityKit** all have C++ cores. Swift interfaces with these through C++ interop (significantly improved in Swift 5.9+).

### Microsoft

**MSVC** (Microsoft Visual C++) is both a compiler and a set of libraries. The MSVC compiler team maintains the only major C++ compiler written by a company that also ships a commercial operating system, giving them unique insight into Windows-specific optimizations.

**The C++ Standard Library (STL)** implementation that ships with MSVC is open-source on GitHub (`microsoft/STL`). It is one of three major STL implementations (alongside libstdc++ from GCC and libc++ from LLVM).

**DirectX** is the graphics and compute API for Windows and Xbox. Direct3D 12 is a low-level C++ API that competes with Vulkan. The DirectX Shader Compiler (DXC) is based on LLVM.

**Windows itself** is largely C and C++. The Windows kernel, Win32 API, COM infrastructure, and most system services are C/C++.

**Office 365** applications (Word, Excel, PowerPoint) are C++ on desktop platforms. Excel's calculation engine is heavily optimized C++.

**Azure SDK for C++** provides native cloud service access without managed runtime overhead, critical for embedded and IoT scenarios.

### Amazon

**AWS SDK for C++** provides C++ interfaces to all AWS services. It is used in performance-critical applications that cannot afford the overhead of the Python or Java SDKs.

**Firecracker**, the microVM technology behind Lambda and Fargate, is written in Rust, but its predecessor (a QEMU fork) was C++. The KVM hypervisor it builds on is C.

**Amazon's retail systems** use C++ in their core recommendation engine, search ranking infrastructure, and warehouse robotics control systems.

**S3's storage layer** uses C++ for the data path. The metadata and control plane may use Java or other languages, but the actual bytes-to-disk path is C++.

---

### Junior → FAANG: Building a Company-Specific C++ Knowledge Map

Junior engineers often treat FAANG C++ libraries as monolithic "big company stuff." The practical gap is not knowing which library to reach for, and why it was created instead of using the standard library.

For each company in this section, build a one-paragraph mental model: what pain did their internal codebase have, what did they build to fix it, and what does that mean for a Go engineer interfacing with it? Abseil's `flat_hash_map` exists because `std::unordered_map` is too slow and too allocation-heavy for Google-scale lookup tables. Folly's `IOBuf` exists because copying network buffers across Meta's infrastructure at billions of QPS is unacceptably expensive. These are not abstract library choices. They are responses to measured production pain.

Interview entry point: for any FAANG company you are interviewing at, know two or three of their internal C++ libraries and one concrete reason each was created. This signals domain awareness, not just language proficiency.

### Senior @ FAANG: Library Governance, Adoption, and Deprecation at Scale

Staff engineers at these companies do not just use internal libraries. They decide which libraries are canonical, how they evolve, and when they retire.

**Abseil governance model.** Google's approach to Abseil is instructive: it is versioned by date, not semantic version, because Google's internal monorepo cannot support semver-style dependency graphs. Every team in the monorepo uses the same Abseil head. The implication for staff engineers: any change to Abseil must be backward compatible or paired with a migration script that fixes all call sites across billions of lines. This is the scale at which "API design" becomes "migration engineering." Bar-raisers test for awareness of this by asking how you would evolve a widely-used internal API.

**Folly adoption decisions.** At Meta, choosing to depend on Folly is a strategic decision, not a tactical one. Folly's `Future`/`Promise` model predates C++20 coroutines. New code at Meta increasingly uses coroutines via `folly::coro`. A staff engineer must know when to use the legacy `Future` API (existing callsites, team familiarity) and when to invest in the coroutine migration. This is an ADR-level decision with engineering-hours cost implications.

**Cross-company library boundaries.** When your team ships a C++ service that calls gRPC (Google), uses RocksDB (Meta origin), and links against LLVM (Apple/community), you own the dependency graph. Each library may have incompatible memory model assumptions, different logging frameworks, and conflicting allocator hooks. A bar-raiser question: "how would you debug a latency regression that appeared after upgrading RocksDB from 7.x to 8.x in a service that also uses Abseil and Folly?" The answer requires knowing how to isolate library interactions, how to read RocksDB's compaction statistics, and how to attribute latency via perf.

**L7 concern: library standardization across org.** At principal/L7 level, you may govern which C++ libraries are approved for use across your organization. The approval criteria include: license compatibility, security audit history (memory safety CVE rate), build system integration (does it work with Bazel or only CMake?), and support model (who inside the company owns upgrades?). A library that ships with excellent features but no internal champion is a maintenance liability that grows as the codebase scales.
