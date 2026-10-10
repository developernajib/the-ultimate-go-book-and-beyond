## C++ vs Go vs Rust: An Honest Comparison

This is the section most Go engineers skip to, and the one most likely to start arguments. Here is an honest, nuanced comparison based on what each language actually excels at, not what their advocates claim.

### Compilation Speed

| Language | Hello World Compile | Large Project (1M LOC) |
|----------|-------------------|----------------------|
| Go | ~100ms | 10-30 seconds |
| Rust | ~500ms | 5-30 minutes |
| C++ | ~200ms | 5-60 minutes |

Go wins decisively. This is by design: Rob Pike created Go partly because he was tired of waiting for C++ builds at Google. C++ compilation is slow because of textual `#include` processing (the preprocessor copies header files into every translation unit), template instantiation, and complex overload resolution. C++20 modules improve this, but adoption is still early.

Rust is similarly slow due to monomorphization of generics, borrow checker analysis, and LLVM backend optimization.

### Memory Safety

| Feature | Go | Rust | C++ |
|---------|-----|------|-----|
| Null safety | Nil panics at runtime | No null (Option type) | Null dereference = UB |
| Buffer overflow | Runtime bounds check | Compile-time + runtime | No automatic checks |
| Data races | Race detector (opt-in) | Prevented at compile time | No protection |
| Use-after-free | GC prevents | Borrow checker prevents | Programmer responsibility |
| Memory leaks | Possible (GC helps) | Possible (no GC) | Common |

Rust has the strongest safety guarantees. Go is safe in practice due to garbage collection and runtime checks, at the cost of performance overhead. C++ offers no safety guarantees. Correctness depends entirely on programmer discipline and tooling (sanitizers, static analyzers).

### Performance

Peak throughput differences are most visible in CPU-bound parsing benchmarks. C++ (simdjson) and Rust (simd-json) reach ~1 GB/s by exploiting SIMD intrinsics directly, while Go's `encoding/json` tops out around 150 MB/s due to reflection overhead and the absence of first-class SIMD support. Third-party libraries like `sonic` close much of the gap for Go by using assembly.
```
Benchmark: JSON parsing, 1MB payload (approximate)
C++ (simdjson):     ~1.2 GB/s
Rust (simd-json):   ~1.1 GB/s
Go (encoding/json): ~150 MB/s
Go (sonic):         ~800 MB/s
```

C++ and Rust achieve similar peak performance. Both compile to native code via LLVM (or GCC for C++), support SIMD intrinsics, allow custom allocators, and have zero-cost abstractions. Go is typically 2-10x slower due to:

- Garbage collector overhead
- Interface dispatch (dynamic dispatch for all interfaces)
- Bounds checking on every slice access
- No SIMD intrinsics (requires assembly or CGo)
- Goroutine stack management overhead

However, Go's performance is excellent for networked services. The performance gap narrows significantly for I/O-bound workloads where most time is spent waiting for network or disk.

### Concurrency

Go makes concurrency a first-class language feature: goroutines are cheap (2KB initial stack) and channels are built into the syntax. C++ requires explicit thread management via `std::thread` or `std::async`, with synchronization handled manually through futures, mutexes, or C++20 coroutines, each demanding more boilerplate and discipline than Go's counterparts.
```go
// Go: goroutines and channels are first-class
func main() {
    ch := make(chan int, 10)
    for i := 0; i < 10; i++ {
        go func(n int) {
            ch <- n * n
        }(i)
    }
    for i := 0; i < 10; i++ {
        fmt.Println(<-ch)
    }
}
```

```cpp
// C++: threads, futures, and coroutines (C++20)
#include <iostream>
#include <future>
#include <vector>

int main() {
    std::vector<std::future<int>> futures;
    for (int i = 0; i < 10; ++i) {
        futures.push_back(std::async(std::launch::async, [i] {
            return i * i;
        }));
    }
    for (auto& f : futures) {
        std::cout << f.get() << "\n";
    }
}
```

```rust
// Rust: async/await with Tokio runtime
use tokio;

#[tokio::main]
async fn main() {
    let mut handles = vec![];
    for i in 0..10 {
        handles.push(tokio::spawn(async move { i * i }));
    }
    for h in handles {
        println!("{}", h.await.unwrap());
    }
}
```

Go's concurrency model is the simplest and most productive. Goroutines are cheap (2KB initial stack), channels provide safe communication, and `select` enables multiplexing. You can spawn millions of goroutines.

C++ has `std::thread` (expensive OS threads), `std::async`/`std::future` (limited), and C++20 coroutines (powerful but verbose, and the standard library provides no runtime, meaning you need a library like `cppcoro` or `libunifex`).

Rust's async model is performant but complex. You must choose an async runtime (Tokio, async-std), deal with `Pin`, `Send`/`Sync` bounds, and navigate lifetime issues in async contexts.

### When to Use Each Language

**Choose Go when:**
- Building web services, APIs, microservices
- Writing CLI tools and DevOps tooling
- Building distributed systems (consensus, coordination)
- Developer productivity and team velocity are priorities
- You need fast compilation and deployment cycles
- The service is I/O-bound (network, database calls)
- You want a large talent pool for hiring

**Choose C++ when:**
- Building databases, storage engines, or embedded systems
- Writing browser engines, compilers, or language runtimes
- Developing game engines or real-time graphics
- Working on OS kernels or device drivers
- Sub-microsecond latency is required (HFT)
- Interfacing with existing C++ codebases
- Hardware-specific optimization (SIMD, GPU compute) is needed
- You need deterministic memory management without GC pauses

**Choose Rust when:**
- Building new systems software where memory safety is critical
- Writing security-sensitive code (TLS libraries, cryptography)
- Developing CLI tools that need C++-level performance
- Creating WebAssembly modules
- You want memory safety without garbage collection overhead
- The project is greenfield (no existing C++ codebase to integrate with)
- Building network services that need both safety and performance (Cloudflare, Discord)

### The Honest Trade-off Matrix

| Dimension | Go | C++ | Rust |
|-----------|-----|------|------|
| Learning curve | Low | Very High | High |
| Compile speed | Fastest | Slow | Slow |
| Runtime performance | Good | Best | Best |
| Memory safety | Good (GC) | Poor | Excellent |
| Concurrency ease | Excellent | Moderate | Moderate |
| Ecosystem maturity | Good (15 years) | Excellent (40+ years) | Growing (9 years) |
| FAANG adoption | High | Very High | Growing |
| Hiring pool | Large | Large | Small but growing |
| Debugging ease | Good | Hard | Moderate |
| Build system complexity | Minimal (`go build`) | High (CMake, Bazel) | Low (`cargo build`) |

---

### Junior → FAANG: Using the Comparison Table Without Getting Tribal

Junior engineers often turn language comparisons into identity arguments. The comparison table here is not about which language wins. It is about which language wins for a specific constraint. Practice answering this question with precision: "For a new service that needs sub-millisecond tail latency on a team of 8 Go engineers, which language and why?" The answer involves hiring pool, GC-pause budget, team ramp-up time, and available libraries, not just raw throughput numbers.

Interview entry point: FAANG interviewers at the L4/L5 level will sometimes ask "why would you choose C++ over Go for X?" The trap is to say "C++ is faster." The good answer names the specific constraint: GC pause sensitivity, SIMD requirement, existing C++ library dependency, or ABI compatibility. Each constraint maps to a specific language feature. Generic performance claims do not.

First-job habit: when you read a design doc that chose C++ or Go, find the rejected alternative and the reason it was rejected. That section teaches you more about language trade-offs than any comparison article.

### Senior @ FAANG: Language Choice as an ADR and Org-Level Decision

At L6, language choice is an architectural decision with a multi-year blast radius. A staff engineer needs frameworks for evaluating and documenting this choice in a way that survives team turnover.

**The five-axis ADR for language choice.** When writing an ADR for C++ versus Go (or Rust), the record should cover: (1) latency SLO and GC-pause tolerance (which language runtimes are compatible with your tail-latency budget?). (2) memory budget and control (do you need per-request arena allocators or is the Go runtime sufficient?). (3) team hiring and ramp-up (what is the local talent market for each language, and how long does a Go engineer take to become productive in C++?). (4) ecosystem fit (which libraries exist in each language for your domain?). (5) maintenance risk (memory safety CVE history in C++ codebases, and does your team have the sanitizer and fuzzing infrastructure to manage it?). An ADR that addresses all five is defensible. One that only cites benchmarks is not.

**Rust as the third option.** At the staff level, the C++ versus Go comparison increasingly has a third option: Rust. The bar-raiser question is: "when would you choose Rust over C++ for a new systems component?" The answer involves: memory safety without GC (Rust wins over C++), build system maturity (Cargo is better than CMake, comparable to Bazel), hiring pool (C++ still larger but Rust growing fast), interop with existing C++ (C++/Rust interop is maturing but still rough), and compile times at monorepo scale (Rust is slower than C++ with Clang at large scale). A staff engineer who can navigate this three-way comparison, with specific trade-offs cited, signals L6 depth.

**Cross-language boundary ownership.** When your org uses C++ for the hot path and Go for orchestration, someone must own the boundary: the CGo layer, the protobuf schema, the error translation strategy, the versioning policy. At L6, you define and document this ownership. The common failure mode is letting the boundary grow organically until it becomes a source of subtle bugs (CGo memory pinning, mismatched error codes, incompatible pointer lifetimes). The boundary design document is as important as the design of either system.

**L7 concern: language portfolio evolution.** Principal engineers participate in org-wide decisions about which languages are "supported" and which are "legacy." The framework: a language is supported if the company provides toolchain versioning, security patches, and internal library maintenance for it. A language is legacy if it is frozen (no new services) or in planned deprecation. Positioning C++ as supported versus legacy in a specific domain (e.g., "C++ is supported for storage engines but legacy for web services") is a strategic decision that affects hiring, tooling investment, and long-term maintenance cost.

