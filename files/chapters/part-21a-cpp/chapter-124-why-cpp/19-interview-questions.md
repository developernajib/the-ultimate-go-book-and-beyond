## Interview Questions

These questions are commonly asked in staff-level interviews at FAANG companies where C++ is relevant. They test understanding of when and why to use C++, not just syntax knowledge.

### System Design and Architecture

**Q1: You are designing a new embedded key-value store for a distributed database. Would you choose Go or C++ for the storage engine? Justify your choice.**

*Strong answer:* C++ for the storage engine. Key-value stores like RocksDB require deterministic memory management for buffer pool control, custom allocators for different allocation patterns (arena allocators for write batches, slab allocators for block cache), direct I/O (`O_DIRECT`) for bypassing the OS page cache, memory-mapped files with precise control over `mmap`/`munmap`, and the ability to use SIMD instructions for key comparison and CRC calculation. Go's garbage collector would introduce unpredictable latency spikes during compaction, and CGo overhead would negate performance gains from custom allocators. However, Go is an excellent choice for the distributed layer above the storage engine (Raft consensus, cluster management, client API), as CockroachDB demonstrates with its Go codebase using a Go-native storage engine (Pebble).

**Q2: Your team maintains a high-throughput API gateway that processes 100,000 requests per second with a p99 latency of 50ms. Leadership wants to rewrite it in C++ for performance. Do you agree?**

*Strong answer:* Probably not. At 100K RPS with 50ms p99, the workload is I/O-bound (network, upstream service calls). Go excels here: goroutines handle concurrent connections efficiently, the GC pause is sub-millisecond (well within the 50ms budget), and developer productivity matters for a component that evolves with business requirements. C++ would increase development time, bug surface area (memory safety issues), and hiring difficulty without proportional performance gains. The exception would be if profiling reveals that CPU-intensive processing (complex request transformation, cryptographic operations, compression) dominates latency. In that case, consider writing only the hot path in C++ and calling it via CGo, or better yet, optimize the Go implementation first.

**Q3: Explain the trade-offs between using `std::shared_ptr` in C++ and Go's garbage collector for managing object lifetimes in a concurrent system.**

*Strong answer:* `std::shared_ptr` uses atomic reference counting. It is deterministic (the object is destroyed immediately when the last reference is dropped), has predictable overhead (one atomic increment/decrement per copy/destroy), and avoids stop-the-world pauses. However, it cannot handle cyclic references (use `std::weak_ptr` to break cycles), the atomic operations add per-access overhead on every copy, and forgetting to use `std::make_shared` wastes an allocation. Go's GC handles cycles automatically, has no per-access overhead, and requires no programmer intervention, but introduces latency variance and uses more memory (objects are not freed immediately). For a high-throughput concurrent system, `shared_ptr` gives more predictable tail latency, while Go's GC gives simpler code and eliminates use-after-free and double-free bugs entirely.

### Language Knowledge

**Q4: What is the difference between `std::unique_ptr` and `std::shared_ptr`? When would you use each?**

*Strong answer:* `std::unique_ptr` represents exclusive ownership. Only one `unique_ptr` can own a resource at a time, and it cannot be copied, only moved. It has zero runtime overhead (same as a raw pointer). Use it by default for heap-allocated objects. `std::shared_ptr` represents shared ownership through reference counting. Multiple `shared_ptr` instances can own the same resource, and the resource is destroyed when the last one is destroyed. It has overhead: an atomic reference count, a control block allocation, and larger size (two pointers). Use it only when you genuinely need shared ownership, such as caches, observer patterns, or objects shared across threads. In Go terms, `unique_ptr` is like passing a pointer to exactly one goroutine. `shared_ptr` is like passing a pointer to multiple goroutines and relying on the GC to clean up.

**Q5: What is undefined behavior, and why does Go not have it?**

*Strong answer:* Undefined behavior (UB) means the C++ standard places no requirements on what happens when certain rules are violated. Common causes: null pointer dereference, out-of-bounds access, signed integer overflow, data races, and use-after-free. The compiler is allowed to assume UB never occurs and can optimize based on that assumption, which can cause surprising behavior (dead code elimination, reordering, removing "unnecessary" checks). Go avoids UB by design: array access is bounds-checked at runtime (panics instead of UB), nil pointer dereference is a runtime panic (not UB), data races are detected by the race detector, and there is no pointer arithmetic in safe code. The trade-off is that Go's runtime checks add overhead that C++ avoids, which is part of why C++ can be faster for compute-intensive work.

**Q6: Explain RAII and compare it to Go's `defer` statement.**

*Strong answer:* RAII ties resource lifetime to object lifetime. When an object is constructed, it acquires a resource (opens a file, locks a mutex, allocates memory). When the object is destroyed (goes out of scope), the destructor releases the resource. This is deterministic, exception-safe, and composable. Go's `defer` is similar in intent but different in mechanism: `defer` runs at function exit (not scope exit), is ordered LIFO, and adds minimal runtime overhead. Key differences: (1) RAII runs at scope exit, `defer` at function exit, so RAII is more granular. (2) RAII works with temporary objects and expressions, `defer` requires an explicit statement. (3) RAII composes naturally with containers (a vector of `unique_ptr` cleans up all elements when destroyed), while Go relies on the GC for this. (4) `defer` can call any function, while RAII is limited to destructors.

**Q7: Modern C++ claims to be as safe as Go. Is that true?**

*Strong answer:* No, not yet. Modern C++ is significantly safer than legacy C++ thanks to smart pointers (eliminating most use-after-free and memory leaks), `std::span` and `std::array` (bounds-checked alternatives to raw arrays), `std::optional` (reducing null dereferences), `std::variant` (replacing unsafe unions), and compile-time checks via `constexpr` and `static_assert`. However, C++ still allows raw pointers, unchecked array access, pointer arithmetic, and type punning through casts. Safety is opt-in and requires discipline. Go's safety is opt-out (you need `unsafe` to be unsafe). In practice, large C++ codebases at FAANG companies enforce safety through coding standards (Google C++ Style Guide), static analysis (clang-tidy), and runtime sanitizers (AddressSanitizer, ThreadSanitizer, UndefinedBehaviorSanitizer). These tools close much of the gap but do not eliminate it.

### Practical Coding

**Q8: Write a thread-safe LRU cache in C++ and explain how it differs from a Go implementation.**

```cpp
#include <list>
#include <unordered_map>
#include <mutex>
#include <optional>

template <typename Key, typename Value>
class LRUCache {
public:
    explicit LRUCache(size_t capacity) : capacity_(capacity) {}

    std::optional<Value> Get(const Key& key) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;

        // Move accessed item to front of list
        list_.splice(list_.begin(), list_, it->second);
        return it->second->second;
    }

    void Put(const Key& key, const Value& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);

        if (it != map_.end()) {
            it->second->second = value;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }

        if (map_.size() >= capacity_) {
            auto last = list_.back();
            map_.erase(last.first);
            list_.pop_back();
        }

        list_.emplace_front(key, value);
        map_[key] = list_.begin();
    }

private:
    size_t capacity_;
    std::list<std::pair<Key, Value>> list_;
    std::unordered_map<Key, typename std::list<std::pair<Key, Value>>::iterator> map_;
    std::mutex mutex_;
};
```

Key differences from a Go implementation: (1) The C++ version uses templates for type safety across any key/value type, while Go would use generics (since Go 1.18) or `interface{}`. (2) The mutex is embedded in the struct and automatically released via RAII (`lock_guard`), while Go requires explicit `mu.Lock()` and `defer mu.Unlock()`. (3) The C++ version stores iterators (pointer-like references to list nodes) in the map, which is only valid because `std::list` guarantees iterator stability. Go has no equivalent iterator concept. (4) Memory layout: the C++ `std::list` allocates each node individually (linked list), while a Go equivalent might use a doubly-linked list from `container/list` (also individually allocated) or a custom implementation using slices for better cache locality.

**Q9: How would you interface a C++ library from Go code?**

*Strong answer:* Use CGo, Go's mechanism for calling C functions. Since CGo calls C (not C++), you need a C wrapper around the C++ API. Create a header file with `extern "C"` declarations, implement the wrapper functions in a `.cpp` file that calls the C++ library, compile the C++ code into a static or shared library, and link it from Go using CGo directives. Be aware of CGo overhead: each CGo call costs approximately 50-100 nanoseconds due to goroutine stack switching and the need to inform the Go scheduler. For high-frequency calls, batch operations or use a single CGo call that processes multiple items. Alternative: use gRPC or a socket protocol to communicate between Go and C++ processes, avoiding CGo's complexity and overhead entirely.

**Q10: You are evaluating whether to add Rust or C++ to your Go team's toolbox for a new performance-critical component. What factors drive the decision?**

*Strong answer:* Factors favoring C++: (1) Existing C++ dependencies or libraries you need to integrate with. (2) Team experience, C++ developers are more abundant than Rust developers. (3) Mature tooling for your domain (game engines, embedded systems with vendor-specific C++ SDKs). (4) Interop with C is seamless (no FFI boundary). (5) Extensive FAANG-quality open-source libraries (Abseil, Folly, Boost).

Factors favoring Rust: (1) Greenfield project with no C++ legacy code. (2) Memory safety is critical (security-sensitive code, network-facing services). (3) Modern tooling out of the box (Cargo is excellent, like Go's toolchain). (4) The borrow checker catches bugs at compile time that C++ sanitizers only catch at runtime. (5) Better concurrency safety (Send/Sync traits prevent data races at compile time). (6) Growing FAANG adoption (Android, Chrome, AWS, Cloudflare).

The pragmatic answer: if you are already in a C++ ecosystem, stay with C++. If you are starting fresh and safety matters, choose Rust. If neither C++ nor Rust is justified and the bottleneck is I/O, optimize your Go code first, as it is likely fast enough.

---

### Junior → FAANG: How to Practice These Questions Without a C++ Codebase

Most of these interview questions test reasoning about trade-offs, not ability to write C++ from memory. A junior engineer preparing for an L4/L5 C++ role should practice the following: given a constraint (GC-pause sensitivity, SIMD requirement, hardware ABI), state which language feature addresses it and why. Practice out loud, with a timer.

For the language comparison questions (C++ vs Rust, C++ vs Go), prepare a structured answer: start with the shared goal (memory control, low latency), then name the key difference (Rust's borrow checker at compile time vs. C++'s sanitizers at runtime), then give the tie-breaker (hiring pool, ecosystem, existing codebase). A two-minute structured answer beats a five-minute ramble.

First-job habit: after each sprint, pick one interview question from this list and write a two-paragraph answer from memory. Send it to a mentor for feedback. This builds the articulation habit that separates candidates who understand the material from those who just know the syntax.

### Senior @ FAANG: Bar-Raiser Framing for C++ Strategic Questions

At the L6/L7 bar-raiser level, interview questions about C++ are not about syntax or even architecture. They are about judgment, governance, and org-level impact.

**The question behind the question.** When a bar-raiser asks "how would you migrate a 2M LOC C++ service from C++14 to C++20?", they are not asking for a technical recipe. They are asking: do you know how to scope a multi-team migration, how to gate it on measurable criteria, how to communicate the plan to stakeholders, and how to handle the teams that resist the upgrade because of short-term disruption? The technical steps (audit includes, update CMakeLists, fix new warnings) take one paragraph. The leadership and governance plan takes five.

**The "when would you not use C++?" question.** This is a classic bar-raiser probe. The expected answer for a senior candidate: "I would not use C++ for a new web API service where the team's expertise is Go and the latency requirement is 10ms, because the GC pause budget is ample and the CGo boundary would add operational complexity. I would not use C++ for a new ML training job where PyTorch already provides the kernel performance and Python is the team's productivity language. I would use C++ when the hardware API requires it, when the GC pause budget is sub-millisecond, or when we need to link against existing C++ infrastructure that cannot be wrapped safely."

**Demonstrating platform thinking.** The highest-signal answer in a C++ strategic interview references the org-wide impact of decisions: "changing the allocator from tcmalloc to jemalloc requires benchmarking under production traffic profiles, not just micro-benchmarks, and requires coordinating with every team that uses the shared library because the allocator is a singleton." This level of answer signals that you think about systems, not just components.

**Preparation strategy.** For a staff C++ interview at FAANG, prepare one ADR-format answer for each of: a language choice decision (C++ vs. Rust for a new subsystem), a toolchain upgrade decision (C++17 to C++20), and a library adoption decision (adopting Abseil or Folly on a new team). Each answer should include the decision, the alternatives considered, the criteria used to decide, and the revisit trigger. Practicing ADR-format answers trains the structured thinking that bar-raisers are looking for.

