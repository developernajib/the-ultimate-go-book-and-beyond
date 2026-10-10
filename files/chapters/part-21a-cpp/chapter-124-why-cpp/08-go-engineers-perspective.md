## Go Engineer's Perspective

This section is for you, the Go developer, stepping into C++ territory. Here is what will feel familiar, what will trip you up, and how to map your Go mental model to C++.

### What Will Feel Familiar

**Structs and methods.** C++ structs are similar to Go structs. Methods are defined inside the struct (or class) rather than separately, but the concept is the same.

```cpp
struct Server {
    std::string host;
    int port;

    // Method (like Go's func (s *Server) Address() string)
    std::string address() const {
        return host + ":" + std::to_string(port);
    }
};
```

**Interfaces (abstract classes).** C++ uses pure virtual functions to define interfaces, similar to Go's implicit interfaces but explicit (you must declare that you implement them).

```cpp
// C++ interface (like Go's io.Reader)
class Reader {
public:
    virtual ~Reader() = default;
    virtual size_t read(char* buf, size_t len) = 0;  // Pure virtual = must implement
};

// Implementation (like Go's bytes.Reader implementing io.Reader)
class FileReader : public Reader {
public:
    size_t read(char* buf, size_t len) override {
        // ... read from file
        return bytes_read;
    }
};
```

**Error handling.** Modern C++ is moving toward value-based error handling with `std::expected` (C++23), which is structurally identical to Go's `(value, error)` pattern. Many Google C++ projects use `absl::Status` and `absl::StatusOr<T>`, which are direct analogs.

```cpp
// Google's abseil style (very similar to Go's error handling)
absl::StatusOr<User> GetUser(int id) {
    auto result = db_.Query(id);
    if (!result.ok()) {
        return result.status();  // Propagate error
    }
    return User{result->name, result->email};
}

// Usage (compare to Go's if err != nil pattern)
auto user = GetUser(42);
if (!user.ok()) {
    LOG(ERROR) << "Failed: " << user.status();
    return user.status();
}
// Use *user
```

### What Will Trip You Up

**Header files and forward declarations.** Coming from Go where every file in a directory is automatically visible, you will forget to `#include` headers, create circular includes, and wonder why the compiler cannot find a type you clearly defined.

**Compilation times.** Your first large C++ project will shock you. A full build of Chromium takes 30+ minutes on a powerful machine. Incremental builds are faster, but nothing like Go's sub-second compilation.

**The build system.** There is no `cpp build`. You must choose CMake, Bazel, Meson, or something else. Each has its own syntax and learning curve.

**Templates vs generics.** C++ templates are far more powerful than Go generics but also far more complex. Template error messages can span hundreds of lines. Concepts (C++20) help, but the learning curve is steep.

**Undefined behavior.** In Go, if you access an out-of-bounds index, you get a panic with a clear stack trace. In C++, you get undefined behavior: the program might crash, might produce wrong results, might appear to work correctly, or might format your hard drive (theoretically). The compiler is allowed to assume UB never happens and optimize accordingly, which can produce genuinely surprising results.

```cpp
// DANGER: Undefined behavior in C++
int arr[5] = {1, 2, 3, 4, 5};
int val = arr[10];  // UB! No panic, no error. Anything can happen.
// Go equivalent: arr[10] would panic immediately with "index out of range"
```

**RAII (Resource Acquisition Is Initialization).** This is C++'s core resource management idiom. Instead of `defer` in Go, C++ uses destructors that run automatically when objects go out of scope. Once you understand RAII, you will find it elegant. It is deterministic (runs exactly when the scope ends, not at GC time) and composable (nested objects clean up in reverse order).

```cpp
// C++ RAII (like Go's defer, but automatic and deterministic)
{
    std::lock_guard<std::mutex> lock(mutex_);  // Acquires lock
    // ... critical section ...
}  // lock released here, automatically, even if exception thrown

// Go equivalent:
// mu.Lock()
// defer mu.Unlock()
```

**Move semantics.** Go copies structs by value and passes pointers when you want to avoid copies. C++ has move semantics (since C++11) that transfer ownership of resources without copying. When you write `std::move(x)`, you are saying "I am done with `x`, take its guts." The moved-from object is in a valid but unspecified state.

```cpp
std::vector<int> v1 = {1, 2, 3, 4, 5};
std::vector<int> v2 = std::move(v1);
// v2 now owns the data. v1 is empty. No copying occurred.
// In Go, this would require passing a pointer and nil-ing the original.
```

### Mental Model Mapping

| Go Concept | C++ Equivalent |
|-----------|---------------|
| `go build` | CMake + Ninja (or `g++ ...`) |
| `go.mod` | `CMakeLists.txt` + `vcpkg.json` |
| `go get` | `vcpkg install` or `conan install` |
| `go test` | Google Test (`gtest`) + CTest |
| `defer` | RAII (destructors), `std::lock_guard`, `std::unique_ptr` |
| `interface` | Abstract class with pure virtual methods |
| `goroutine` | `std::jthread` (C++20) or coroutines |
| `channel` | `std::future`/`std::promise` or a concurrent queue |
| `select` | No direct equivalent (use condition variables or coroutines) |
| `slice` | `std::vector` + `std::span` (C++20) |
| `map` | `std::unordered_map` or `absl::flat_hash_map` |
| `string` | `std::string` (mutable, unlike Go's immutable strings) |
| `error` | `std::expected` (C++23), `absl::Status`, or exceptions |
| `context.Context` | No standard equivalent (use `absl::AnyInvocable` + cancellation token) |
| `panic`/`recover` | `throw`/`catch` (exceptions) |
| `unsafe.Pointer` | Raw pointers (`void*`), `reinterpret_cast` |
| Garbage collector | Smart pointers (`unique_ptr`, `shared_ptr`) + RAII |

### Your First Week of C++ as a Go Engineer

1. **Day 1-2:** Write small programs using `std::vector`, `std::string`, `std::unordered_map`. Get comfortable with `auto`, range-based for loops, and lambdas. These are the C++ equivalents of your daily Go tools.

2. **Day 3:** Learn smart pointers (`std::unique_ptr`, `std::shared_ptr`). Do not use `new`/`delete` directly. If you write `new`, wrap it in `std::make_unique` or `std::make_shared` immediately.

3. **Day 4:** Set up CMake for a multi-file project. Add Google Test for testing. Write your first test.

4. **Day 5:** Learn RAII by implementing a simple resource wrapper (file handle, network socket). Understand how destructors replace `defer`.

5. **Day 6-7:** Write a concurrent program using `std::thread`, `std::mutex`, and `std::condition_variable`. Compare the experience to goroutines and channels. You will miss Go's concurrency model.

---

### Junior → FAANG: Translating Go Habits to C++ Without Cargo-Culting

The most common Go-to-C++ mistake is importing Go idioms directly. Channels do not exist. Goroutine-per-request does not scale the same way. `defer` does not exist. But the underlying intent (resource cleanup, concurrency, error propagation) exists in C++. It just uses different mechanisms.

Build a translation table for yourself: Go `defer` maps to C++ RAII destructors. Go `goroutine` maps to C++ `std::thread` or a thread pool. Go `chan` maps to C++ `std::condition_variable` plus a queue or a lock-free ring buffer. Go `error` return value maps to C++ `std::expected` (C++23) or `absl::StatusOr`. The mapping is not perfect, but having it explicit in your head prevents the "I miss Go" paralysis.

First-job habit: when you are frustrated by C++'s verbosity (header files, explicit includes, manual memory management), ask "what runtime cost does this save?" Usually the answer is measurable. That reframe makes the complexity feel intentional rather than arbitrary.

### Senior @ FAANG: Cross-Language Team Leadership and Knowledge Transfer

At the staff level, you may lead a team that has both Go and C++ engineers, or you may be migrating a Go service to C++ (or vice versa). The leadership challenge is different from the technical one.

**Go-to-C++ migration leadership.** When a Go service needs to be rewritten in C++ for latency reasons, the migration plan must address: what is the measurable latency target (not "faster" but "p99 < 500us"), what is the team's C++ proficiency baseline, what is the incremental migration path (rewrite a single RPC handler first), and what is the rollback plan if the C++ version regresses in correctness. The migration is not complete when the C++ version is deployed. It is complete when the Go version is deleted and the team is self-sufficient in C++.

**Knowledge transfer design.** When bringing Go engineers up to C++, a staff engineer designs the knowledge transfer, not just recommends tutorials. This means: pairing Go engineers with C++ engineers on the first three C++ PRs (not just code review after the fact), creating a team-specific C++ style guide that explicitly maps from Go idioms, and running a weekly "C++ pitfalls" meeting for the first two months where post-mortems of bugs (use-after-free, dangling reference, UB) are reviewed as a team. The goal is building shared mental models, not individual proficiency.

**Maintaining polyglot codebases.** When a system spans Go and C++, the interface between them (CGo, gRPC, shared memory, sidecar) must be owned explicitly. At L6, you write the interface contract: what data types cross the boundary, who owns memory on each side, how errors are translated, and how the interface is versioned. Unowned interfaces in polyglot systems become the source of the hardest production bugs because neither language team feels full ownership of the boundary.

**L7 concern: polyglot org strategy.** At the principal level, supporting two systems languages (Go and C++) requires duplicated investment in tooling, libraries, and expertise. A principal engineer periodically reassesses whether that investment is justified by reviewing: what fraction of services genuinely require C++, what is the p99 latency difference between the C++ and Go versions of similar services, and what is the security cost of the C++ codebase (CVE rate, sanitizer coverage). The output of this review informs the org's hiring strategy and tooling investment for the next planning cycle.

