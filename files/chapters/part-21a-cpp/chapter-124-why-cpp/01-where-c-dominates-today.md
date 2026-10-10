## Where C++ Dominates Today

C++ is not a general-purpose web development language. It occupies a specific and critical niche: systems where microseconds matter, where hardware access is required, where deterministic resource management is non-negotiable, or where decades of existing infrastructure make rewriting impractical. Here are the major domains.

### Databases and Storage Engines

The storage engines that power modern distributed databases are overwhelmingly written in C++.

**RocksDB** is an embedded key-value store created at Facebook (Meta). It is a fork of Google's LevelDB, optimized for fast storage on SSDs. RocksDB is the storage engine behind MySQL's MyRocks, CockroachDB, TiKV (the storage layer of TiDB), and dozens of other databases. It is written entirely in C++ because storage engines require precise control over memory allocation, disk I/O scheduling, and cache management. The LSM-tree data structure at its core involves careful coordination between in-memory buffers and on-disk sorted runs, where every unnecessary allocation or copy impacts throughput.

**LevelDB** is Google's original sorted key-value store. It introduced the LSM-tree approach that RocksDB later extended.

**SQLite**, the most deployed database engine in the world (present on every smartphone, every browser, and most desktop applications), is written in C. Its successor and many extensions use C++.

**MongoDB's WiredTiger** storage engine is C/C++. **MySQL's InnoDB** is C/C++. **PostgreSQL** is C, but its extension ecosystem increasingly uses C++.

Why not Go? Go's garbage collector introduces unpredictable pause times. Even with Go 1.27's sub-millisecond GC pauses, a storage engine processing millions of operations per second cannot afford any pause that is not explicitly scheduled. C++ gives you `malloc`, `free`, custom allocators, and memory pools where every allocation and deallocation happens exactly when you decide.

```cpp
// C++ custom allocator for a storage engine's block cache
// This is a simplified version of what RocksDB does internally
class BlockCacheAllocator {
public:
    explicit BlockCacheAllocator(size_t pool_size)
        : pool_(static_cast<char*>(std::aligned_alloc(4096, pool_size))),
          pool_size_(pool_size),
          offset_(0) {}

    ~BlockCacheAllocator() { std::free(pool_); }

    void* Allocate(size_t bytes) {
        size_t aligned = (bytes + 63) & ~63;  // 64-byte alignment for cache lines
        size_t current = offset_.fetch_add(aligned, std::memory_order_relaxed);
        if (current + aligned > pool_size_) return nullptr;
        return pool_ + current;
    }

private:
    char* pool_;
    size_t pool_size_;
    std::atomic<size_t> offset_;
};
```

In Go, you would rely on the runtime allocator and garbage collector. You cannot align allocations to cache line boundaries, you cannot use memory pools that bypass the GC, and you cannot guarantee that a freed block is immediately available for reuse.

### Web Browsers

**Chromium** (the open-source project behind Chrome, Edge, Brave, Opera, and Vivaldi) is approximately 35 million lines of C++. The rendering engine (Blink), the JavaScript engine (V8), the networking stack, the GPU process, and the compositor are all C++. Firefox's Gecko engine is a mix of C++ and Rust.

Browsers must parse HTML, build DOM trees, compute CSS layouts, rasterize pixels, composite layers on the GPU, and execute JavaScript, all within 16.67 milliseconds per frame to maintain 60fps. This is a hard real-time constraint on consumer hardware ranging from high-end desktops to budget Android phones. There is no garbage collector pause budget.

### Compilers and Language Toolchains

**LLVM** is a compiler infrastructure framework written in C++. It provides the backend for Clang (the C/C++ compiler), Rust's `rustc`, Swift's compiler, Kotlin Native, and many others. The Go compiler itself does not use LLVM (it has its own backend written in Go), but `gollvm` is Google's experimental Go frontend for LLVM.

**GCC** (the GNU Compiler Collection) is written in C and C++. It has been the default compiler on Linux for decades.

Compilers are ideal C++ territory because they perform millions of pointer-heavy tree and graph transformations per compilation, where allocation patterns are irregular and short-lived intermediate representations dominate memory usage. Custom arena allocators in LLVM dramatically outperform general-purpose allocation.

### Game Engines

**Unreal Engine** by Epic Games is the most prominent C++ game engine. It powers AAA titles like Fortnite, Final Fantasy VII Remake, and countless others. Unity's core runtime is also C++ (with a C# scripting layer).

Game engines require:
- Deterministic frame timing (no GC pauses)
- Direct GPU API access (Vulkan, DirectX, Metal)
- SIMD intrinsics for physics and math
- Custom memory allocators per subsystem
- Bit-level control over data layouts for cache efficiency

None of these are available in Go. Go's strengths (goroutines, channels, fast compilation) are irrelevant in a game engine's inner loop.

### High-Frequency Trading

HFT firms measure latency in nanoseconds. A trading system that processes market data and generates orders must do so in single-digit microseconds. C++ is the dominant language because:

- No garbage collector pauses (even nanosecond pauses are unacceptable)
- Kernel bypass networking (DPDK, RDMA) requires C/C++ APIs
- SIMD instructions for parallel data processing
- Lock-free data structures with precise memory ordering
- CPU cache line optimization and NUMA awareness

Go is used at some trading firms for non-latency-critical components (order management systems, risk dashboards, data pipelines), but the hot path is always C++ or, increasingly, a combination of C++ and hand-tuned assembly.

### Operating System Kernels

The Linux kernel is written in C (with recent additions in Rust). Windows NT kernel is C and C++. macOS/iOS kernels (XNU) are C and C++. Device drivers, filesystem implementations, network stacks, and schedulers are all systems-level code that requires direct hardware access, interrupt handling, and zero-overhead abstractions.

Go cannot run without an operating system (or at least a runtime). It depends on OS-provided threading, memory management, and I/O primitives. The Go runtime itself is partly written in C and assembly.

### Machine Learning Runtimes

**TensorFlow's** core is C++ with a Python API layer. The computational graph executor, the kernel implementations (matrix multiplication, convolution, activation functions), and the device placement logic are all C++. CUDA kernels for GPU acceleration are written in CUDA C++.

**PyTorch's** core library, **LibTorch**, is C++. The autograd engine, tensor operations, and JIT compiler (TorchScript) are implemented in C++. Python is the user-facing API. C++ is where computation happens.

**ONNX Runtime** (Microsoft's cross-platform ML inference engine) is C++. **TensorRT** (NVIDIA's inference optimizer) is C++. **Core ML** (Apple's on-device ML framework) has a C++ core.

The pattern is clear: Python is the API language for ML, but C++ is the execution language. Every matrix multiplication, every gradient computation, every memory transfer between CPU and GPU is orchestrated by C++ code.

---

### Junior → FAANG: Reading Domain Constraints, Not Just Language Features

A common junior mistake is learning C++ features in isolation (smart pointers, templates, RAII) without understanding why those features exist in each domain. Interviewers at FAANG notice when a candidate can recite `unique_ptr` semantics but cannot explain why a storage engine cannot tolerate GC pauses.

Work through this file by asking for each domain: what is the hard constraint (latency, determinism, hardware access, ABI compatibility) and how does C++ satisfy it in a way Go cannot? Write that mapping down. In a phone screen, you may be asked "why is this ML runtime written in C++ and not Python?" and the answer is "Python is the API layer. The execution happens in C++ kernels for performance and CUDA interop."

First-job habit: when you join a team that owns a C++ service, locate the benchmark suite and the latency dashboards immediately. The numbers tell you which domain constraint is actually binding. If the p99 latency is 200ms, cache-line optimization is not your bottleneck. If it is 2 microseconds, it is.

### Senior @ FAANG: Domain Ownership and Cross-Language Boundary Design

Staff engineers at FAANG regularly own systems that span C++ and Go (or C++ and Python). The skill is knowing where to put the boundary and how to make it safe and maintainable.

**Boundary design.** The C++/Go boundary via CGo is expensive (goroutine stack pinning, GC interaction, separate heaps) and error-prone (memory ownership ambiguity). The better pattern, used by projects like Vitess and CockroachDB's Pebble, is to avoid CGo and re-implement the C++ logic in Go where Go's constraints are acceptable, or to use a sidecar process communicating over a local socket. A staff engineer owns the decision of which boundary mechanism is used and writes the policy.

**Domain-specific maturity signals.** Each domain in this section has different production maturity indicators. For storage engines: does your C++ allocator expose per-component memory usage metrics? For ML runtimes: is the kernel dispatch latency instrumented per op type? For HFT: is there a hardware timestamp on every market data message? These are the questions you ask in design reviews, not the feature questions juniors ask.

**Governance of C++ usage.** At L6, you may need to defend a decision to keep a storage engine in C++ rather than adopting a Go-based alternative (such as Pebble for RocksDB). The argument structure: functional parity (what features does RocksDB have that Pebble lacks?), performance parity (measured p99 latency and throughput under production traffic), operational parity (observability, crash dump analysis, existing runbooks), and migration cost (data format compatibility, operator retraining). All four must be addressed. Missing one is a bar-raiser red flag.

**L7 concern: deprecating C++ domains.** As memory-safe alternatives (Rust, Go, Swift) mature, a principal-level engineer may be asked to assess which C++ subsystems are candidates for rewriting. The assessment must weigh security debt (number of CVEs attributable to memory unsafety in the last 3 years), performance headroom (how much slower would a Go or Rust replacement be?), and strategic alignment (does the company's hiring strategy support maintaining C++ expertise in this domain long-term?). This is not a technical question. It is an organizational strategy question with technical constraints.
