## C++ vs Go: Answering "Which Language" Interview Questions

Interviewers, especially at companies that use both C++ and Go, will ask you to compare the two languages. These questions are not trivia quizzes. They are probing whether you understand the fundamental constraints that drive language choice in production systems. Weak answers repeat marketing copy. Strong answers show you understand the tradeoffs from first principles.

---

### "Why does your team use C++ instead of Go?"

This question is asking you to articulate the legitimate engineering reasons that C++ is chosen over Go. The strongest answer comes from understanding what each language gives up.

**When C++ is the right answer:**

**Deterministic latency without a garbage collector.** Go's GC adds latency variance. In a worst-case GC pause, Go's concurrent mark-and-sweep can take 1-3 ms at high heap use. In trading systems, network stacks, and game engines, a 1 ms pause is unacceptable. C++ has no GC, memory is freed immediately when a destructor runs, with no background thread and no stop-the-world behavior.

```cpp
// C++: destructor runs deterministically at scope exit
{
    std::unique_ptr<Connection> conn = open_connection("server:9000");
    send_order(conn, order);
}  // conn destroyed here: TCP FIN sent, socket closed, memory freed
   // Worst case: ~100 ns (system call). No GC pause possible.
```

**Direct hardware access and zero-overhead abstractions.** C++ can use SIMD intrinsics (`_mm256_add_ps`), DMA buffers, memory-mapped I/O, and hardware atomics directly. Go's `unsafe` package is the only path to this, and it bypasses the type system entirely.

**Ecosystem requirements.** GPU compute (CUDA, ROCm, Metal), ML inference (TensorFlow C++ API, TensorRT), graphics (DirectX 12, Vulkan, OpenGL), and audio (JACK, CoreAudio) all have C/C++ as their primary, or only, language interface. Calling these from Go requires CGo, which has its own overhead and scheduling implications.

**Legacy codebase.** A 20-year-old codebase written in C++ is not being rewritten in Go. The practical answer for many teams is that C++ is used because the codebase is already in C++, the tooling is configured for it, and the team knows it.

**Zero-overhead abstractions.** C++ templates and `constexpr` allow abstractions with zero runtime cost. A `std::sort` with a custom comparator is as fast as hand-written qsort. A `std::unique_ptr` compiles to exactly the same code as a raw pointer. Go's interfaces always incur indirection.

---

### "What would you miss most about Go if you had to write C++?"

This question reveals whether you genuinely know Go well enough to articulate its advantages over C++. The best answer goes beyond "garbage collection."

**Goroutines and the scheduler.** Go's M:N scheduler gives you millions of concurrent lightweight coroutines with preemptive scheduling, goroutine-aware stack growth, and built-in channel communication. The equivalent in C++ requires a coroutine library (cppcoro, Asio) plus an executor, plus careful management of blocking vs. non-blocking code, plus your own cancellation mechanism. The Go runtime solves all of this out of the box.

```go
// Go: one goroutine per connection, natural, idiomatic
func handleConnections(listener net.Listener) {
    for {
        conn, err := listener.Accept()
        if err != nil { return }
        go handleConn(conn)  // 2 KB initial stack, grows as needed
    }
}
```

The C++ equivalent needs `io_uring`, coroutines, an executor, a task scheduler, and manual cancellation. It will be faster, but the complexity cost is real.

**`defer`.** Go's `defer` makes cleanup unconditional and reads naturally next to the resource acquisition. C++ RAII achieves the same safety guarantee, but the cleanup code is separated into a destructor definition elsewhere in the file, which is not always as readable for ad-hoc cleanup.

**The build system.** `go build ./...` works on any machine with Go installed. No CMakeLists.txt, no Bazel BUILD files, no toolchain configuration. C++ build systems are a major source of friction, especially when onboarding to a new codebase.

**Built-in testing.** `go test` is zero-configuration. C++ requires choosing between GoogleTest, Catch2, doctest, Boost.Test, and configuring them with the build system. The standard library has no test runner.

**`go fmt`.** Uniform code style, no debate, no configuration. C++ has `clang-format`, which is excellent but requires per-project configuration and is not universally adopted.

**Simple deployment.** A Go binary is statically linked by default. `scp binary server: && ssh server ./binary` works. A C++ binary typically depends on shared libraries (`libstdc++`, `libc`, custom `.so` files), requiring either static linking (which has its own complexities) or ensuring the target system has compatible library versions.

---

### "What can C++ do that Go fundamentally cannot?"

This is the technical depth question. It has clear, objective answers.

**No-heap embedded and real-time programming.** Go requires a runtime and a heap. You cannot run Go on a microcontroller with 256 KB of flash and 64 KB of RAM. C++ (with `-fno-exceptions`, `-fno-rtti`, no dynamic allocation) runs on microcontrollers with kilobytes of memory. FreeRTOS, Zephyr RTOS, and Arduino sketches are C/C++.

```cpp
// C++ on embedded: static allocation only, no heap
static uint8_t uart_buf[256];     // in .bss section (zero-initialized)
static SensorDriver sensor;       // in .data section (initialized)

int main() {
    sensor.init();
    while (1) {
        sensor.read(uart_buf, sizeof(uart_buf));
        uart_transmit(uart_buf, 256);
    }
}
// Binary size: ~4 KB. No OS. No heap allocator. No GC runtime.
```

**GPU kernels and CUDA.** CUDA C++ extends C++ with `__global__`, `__device__`, and `__shared__` qualifiers to write code that runs on NVIDIA GPUs. There is no Go equivalent, CGo wrapping of CUDA C code is possible but cannot express kernel launches with template parameters, shared memory, or warp-level primitives.

```cpp
// CUDA kernel: runs on GPU, not CPU
template<int BLOCK_SIZE>
__global__ void matrix_multiply(const float* A, const float* B, float* C, int N) {
    __shared__ float tile_A[BLOCK_SIZE][BLOCK_SIZE];
    __shared__ float tile_B[BLOCK_SIZE][BLOCK_SIZE];
    // ... tiled matrix multiply using shared memory ...
}

// Launch: <<<blocks, threads>>> syntax, C++ extension
matrix_multiply<16><<<dim3(N/16, N/16), dim3(16, 16)>>>(A, B, C, N);
```

**SIMD intrinsics.** Writing hand-vectorized code with AVX-512 intrinsics requires C or C++. You can process 16 floats in a single AVX-512 instruction (`_mm512_fmadd_ps`). Go's compiler auto-vectorizes some loops, but you cannot write explicit SIMD code.

**Worst-case execution time guarantees.** Safety-critical systems (avionics, automotive, DO-178C, ISO 26262) require deterministic worst-case execution time (WCET). A GC pause makes WCET analysis impossible. C++ with static allocation and no virtual dispatch can be formally analyzed for WCET.

**Custom allocators with object pooling.** C++ allocators control the exact source of every allocation. You can place objects in shared memory (`mmap`), persistent memory (Optane), GPU memory, or a lock-free pool. Go's allocator is not extensible.

---

### "How would you justify the C++ memory safety risks to a security team?"

This is the most mature question in this section. It assumes the interviewer knows that C++ has a history of memory safety vulnerabilities and wants to hear how a senior engineer would defend the choice.

**The honest answer has three parts:**

**1. Modern C++ with smart pointers eliminates most CVE categories.** A codebase that uses `unique_ptr`, `shared_ptr`, `span`, `string_view`, and containers without raw `new`/`delete` eliminates heap use-after-free, double-free, and memory leak bugs, the categories that historically account for ~70% of memory safety CVEs. This is not theoretical: Chrome's C++ codebase, with its strict "modern C++" guidelines, has dramatically fewer memory safety bugs per release since adopting these practices.

**2. Tooling provides runtime safety nets.** AddressSanitizer (`-fsanitize=address`) detects buffer overflows, use-after-free, and stack violations. MemorySanitizer catches uninitialized reads. ThreadSanitizer catches data races. UBSan (`-fsanitize=undefined`) catches undefined behavior. Fuzzing with libFuzzer or AFL automatically generates inputs that trigger edge cases. Combined, these give you coverage comparable to Go's memory safety for the code paths that are actually exercised in tests.

**3. For the highest-assurance code, use bounded types and static analysis.** `std::span<T, N>` with a fixed extent eliminates buffer overflows on array accesses. `clang-tidy` with the `bugprone-*` and `cppcoreguidelines-*` checks catches raw pointer misuse at compile time. The Rust language offers a formal proof-based approach to memory safety, if the security team's bar is "no memory safety risks at all," the honest answer may be that C++ cannot fully meet that bar, and Rust should be considered for the safety-critical components.

---

### "If you were starting a new service today, Go or C++?"

This is the synthesis question. A senior engineer's answer shows business context awareness, not just technical preference.

**The structured answer:**

**95% of services → Go.** Any service that handles HTTP requests, connects to databases, calls other services, and has less than 10,000 requests per second: Go. Faster development, easier deployment, simpler concurrency, built-in tooling, better talent availability. The GC pause problem is not relevant at this scale, the network RTT dwarfs any GC pause.

**Real-time/latency-critical → C++.** High-frequency trading (sub-microsecond order entry), video encoding pipeline, audio processing, embedded sensor firmware: C++. The GC is not acceptable. The hardware access requirements are not negotiable.

**ML inference → C++ or C++ core with Python wrapper.** TensorFlow, PyTorch, and TensorRT all expose C++ APIs as the primary interface. The inference hot path needs SIMD and GPU access that Go cannot provide.

**Storage engine / database → C++.** Custom buffer pools, page caches, B-tree implementations, and write-ahead logs require control over allocator behavior, NUMA topology, and `io_uring` interfaces that are not well-supported in Go.

**If the team knows Go and not C++: always Go.** The language that the team can maintain correctly is better than the language with theoretical performance advantages that the team will misuse. Memory safety bugs from inexperienced C++ usage are worse than GC pauses from Go.

```
Decision matrix:
  GC pause acceptable AND team knows Go → Go
  Embedded/RT/GPU/SIMD required         → C++
  Unsafe is your bottleneck (profiled)  → C++ (after profiling, not before)
  New project, greenfield, I/O-bound    → Go
  Existing C++ codebase                 → C++ (don't rewrite what isn't broken)
```

The nuanced answer that impresses interviewers: "I would prototype in Go to validate the design, profile in production, and rewrite only the specific hot paths in C++ if profiling shows Go is the bottleneck. A mixed Go/C++ service with CGo integration for a tight inner loop is often the best of both worlds."

---
