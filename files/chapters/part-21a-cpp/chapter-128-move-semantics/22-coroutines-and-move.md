## Coroutines and Move

C++20 coroutines introduce a new lifetime model. The coroutine frame is a heap-allocated object that holds parameters, locals, and the promise. How parameters enter the frame, how values flow through `co_yield` and `co_return`, and what happens to references across suspension points are all decided by move semantics.

### How Parameters Enter the Frame

When you call a coroutine, parameters are first evaluated at the call site, then the coroutine frame is allocated, then parameters are **moved** into the frame's parameter slots. After this, the coroutine begins executing.

```cpp
struct task { /* ... */ };

task example(std::string s) {
    co_await ...;
    use(s);
}

example("hello"s); // s constructed at call site, then moved into frame
```

For a parameter passed by value, the parameter is moved (or copied) into the frame. For a parameter passed by reference, **the reference is stored**, not the referent.

### The Reference Parameter Trap

```cpp
task uses_ref(const std::string& s) {
    co_await something();
    log(s); // s is a reference. After suspension, the original may be gone.
}

void caller() {
    uses_ref(std::string("hello")); // temporary
    // the temporary is destroyed at the end of this statement
    // the coroutine resumes later, reads dangling reference
}
```

This is the most dangerous coroutine bug. A coroutine taking a reference parameter may resume after the caller's stack frame is gone. The reference dangles. Reads return garbage, writes corrupt memory.

The rule: **never take a coroutine parameter by reference** unless you can prove the referent outlives the coroutine. For most application-level coroutines, take parameters by value:

```cpp
task uses_value(std::string s) {
    co_await something();
    log(s); // s is in the frame, lives as long as the coroutine
}
```

The caller's temporary is moved into the parameter, which is moved into the frame. After that, lifetime is the coroutine's responsibility.

If you must take by reference (for performance, when the referent is a large object known to outlive the coroutine), document the lifetime contract loudly.

### Lambda Captures and Coroutines

A coroutine that is a lambda body captures things from the enclosing scope:

```cpp
task launch(const std::string& name) {
    auto fn = [name = std::move(name)]() -> task {
        co_await ...;
        log(name);
    };
    co_await fn();
}
```

Wait. The lambda captures `name` by value. The lambda object holds the captured `name`. The coroutine captures the lambda (`this` of the lambda) by reference into its frame. If the lambda object dies before the coroutine resumes, the capture is gone.

The pattern that works:

```cpp
task make_logger(std::string name) {
    co_await ...;
    log(name);
}

task launch(std::string name) {
    co_await make_logger(std::move(name));
}
```

The coroutine takes parameters by value. No captures, no lambda.

If you need a lambda that becomes a coroutine, the capture-list of the lambda becomes the lambda object. The coroutine implicitly captures the lambda via `this` (the lambda's hidden first parameter). Make sure the lambda outlives the coroutine, or rewrite as a free function with by-value parameters.

### co_yield by Value vs Reference

```cpp
generator<std::string> producer() {
    std::string s;
    while (read_line(s)) {
        co_yield s; // copy or move?
    }
}
```

`co_yield expr` is shorthand for `co_await promise.yield_value(expr)`. The exact behavior depends on the promise's `yield_value` overloads.

Most generator implementations have:

```cpp
struct promise_type {
    std::optional<T> current;
    auto yield_value(T value) {
        current.emplace(std::move(value));
        return std::suspend_always{};
    }
};
```

A by-value parameter forces a move (or copy). The yielded expression is moved into the promise's storage. The consumer reads from `promise.current`.

If you want to yield by reference (no copy), use a generator that stores `T*`:

```cpp
struct promise_type {
    T* current = nullptr;
    auto yield_value(T& value) {
        current = &value;
        return std::suspend_always{};
    }
};
```

This is what `std::generator` (C++23) does for non-prvalue yields. The consumer's `*it` reads through the pointer. Lifetime is the producer's responsibility (the yielded object must outlive the suspension).

### std::generator (C++23)

C++23 added `std::generator<T>` as a standardized lazy generator coroutine type. It supports yielding by value, by reference, and by elements of nested generators.

```cpp
#include <generator> // C++23

std::generator<int> count(int n) {
    for (int i = 0; i < n; ++i) co_yield i;
}

for (int v : count(5)) {
    std::cout << v << ' ';
}
```

`std::generator` is move-only. The consumer iterates with a forward iterator. Yielding an lvalue stores a pointer, yielding a prvalue (e.g., `co_yield make_value()`) stores the value in the promise.

`std::generator` is implemented in libstdc++ 14, libc++ 19. Earlier toolchains can use cppcoro or other third-party generator types.

C++26 is expected to expand the coroutine library with `std::lazy<T>` (single-value lazy) and improvements to async coroutines.

### co_await and Awaiters

`co_await expr` invokes `expr.await_ready()`, optionally `expr.await_suspend(handle)`, and `expr.await_resume()`. The awaiter object lives in the coroutine frame for the duration of the await.

If the awaiter holds resources, it should be moveable so that you can construct it in place:

```cpp
struct file_awaiter {
    int fd;
    char* buf;
    std::size_t len;
    file_awaiter(int fd, char* buf, std::size_t len)
        : fd(fd), buf(buf), len(len) {}
    file_awaiter(file_awaiter&&) noexcept = default;
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<>) { /* schedule */ }
    ssize_t await_resume() { /* return result */ }
};
```

Most awaiters are small, trivially-movable structs. Move semantics rarely show up explicitly in awaiter code.

### Symmetric Transfer

A coroutine that awaits another coroutine can transfer execution directly without bouncing back through the scheduler. This is symmetric transfer: `await_suspend` returns the next coroutine's handle, and the caller's runtime resumes that handle.

Symmetric transfer is move-like in spirit: the active execution context is "moved" from one coroutine to another. The frames are reference-counted via handle ownership.

### Final Suspend and Move

A coroutine's `final_suspend()` is awaited when the coroutine is about to complete. Many task types have:

```cpp
auto final_suspend() noexcept {
    struct awaiter {
        bool await_ready() noexcept { return false; }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<promise_type> h) noexcept {
            if (auto cont = h.promise().continuation) return cont;
            return std::noop_coroutine();
        }
        void await_resume() noexcept {}
    };
    return awaiter{};
}
```

This implements continuation passing. The awaiter is constructed in place. Move semantics are not directly involved, but understanding that the awaiter lives in the frame and is destroyed when the await completes is essential for understanding lifetimes.

### Performance: Heap Allocation Elision

The coroutine frame is heap-allocated. C++20 added the Halo (Heap Allocation eLision Optimization) optimization: if the compiler can prove the coroutine handle does not escape its caller, it may elide the heap allocation and place the frame on the stack.

Halo combines with other optimizations:

- Inlining the coroutine body.
- Eliding the move of parameters into the frame (mandatory elision rules apply when the parameter type's copy/move are deleted).
- Devirtualizing awaiter calls.

In practice, simple coroutines that consume a temporary and return a value can compile to roughly the same code as a non-coroutine equivalent. Halo is best-effort, do not rely on it for hot paths without verifying with godbolt.

### Capture by Reference in Resumable Lambdas

C++23 added `[](auto&& self) -> task` patterns where a coroutine recursively calls itself. The deducing-this proposal lets coroutines reference themselves cleanly. Capture by reference in such patterns is still hazardous because the coroutine may suspend and resume.

The safe pattern: capture by value (move), use deducing-this for the recursion target. The coroutine's frame holds the captures.

### Junior at FAANG vs Senior at FAANG

Junior writes a coroutine taking `const std::string&` and watches it work in tests, then crash in production when the caller passes a temporary. Senior takes coroutine parameters by value reflexively, knows that references into the caller's frame dangle across suspension, and uses the lambda+coroutine pattern only when both the lambda's lifetime and the coroutine's lifetime are managed explicitly. Senior reaches for `std::generator` (C++23) over hand-rolled generator types when possible.

### Drill

1. What happens when a coroutine takes a parameter by reference and the caller passes a temporary? The reference dangles after the temporary's lifetime ends, reading it after suspension is UB.
2. What does `co_yield expr` translate to? `co_await promise.yield_value(expr)`.
3. Why are coroutine parameters "moved into the frame"? The compiler constructs frame-resident parameter copies/moves so the parameters survive across suspensions.
4. What is Halo? Heap Allocation Elision Optimization that may avoid the coroutine frame's heap allocation.
5. Which standard generator type was added in C++23? `std::generator`.
