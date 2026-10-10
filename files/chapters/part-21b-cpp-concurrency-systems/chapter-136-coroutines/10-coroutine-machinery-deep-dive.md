## Coroutine Machinery Deep Dive

C++20 coroutines are a compiler transformation. The compiler rewrites a function with `co_await`, `co_yield`, or `co_return` into a state machine driven by a heap-allocated (or HALO-elided) frame. Understanding what the compiler actually emits is the difference between a coroutine that allocates per call and one that compiles down to a tight register-only state machine.

### The Promise Type Contract

Every coroutine has an associated `promise_type` discovered through `std::coroutine_traits<ReturnType, Args...>`. The compiler requires the following members. Missing any of them is a hard error.

```cpp
struct task_promise {
    Task get_return_object();              // returns the user-facing handle
    std::suspend_always initial_suspend(); // or suspend_never for eager start
    FinalAwaiter final_suspend() noexcept; // MUST be noexcept
    void unhandled_exception();            // captures escaping exceptions
    void return_value(T v);                // for co_return v;
    // OR void return_void();              // for co_return; (mutually exclusive)
    // optional:
    auto yield_value(T v);                 // for co_yield v;
    auto await_transform(auto&& a);        // intercepts every co_await
    void* operator new(size_t);            // custom frame allocator
    void operator delete(void*, size_t);
};
```

`return_value` and `return_void` are mutually exclusive. Defining both is ill-formed. If your coroutine can produce values, define exactly one. Generators usually define `return_void` and rely on `yield_value`.

`final_suspend` returning a non-`noexcept` awaiter is undefined behavior at the standards level. Compilers will compile it but the resulting program is broken under exception unwinding. Always mark it `noexcept`.

### initial_suspend Semantics

`initial_suspend` runs before the first user statement of the coroutine body. It has two canonical forms.

```cpp
std::suspend_always initial_suspend() noexcept { return {}; }  // lazy: caller must resume()
std::suspend_never  initial_suspend() noexcept { return {}; }  // eager: body runs immediately
```

Lazy start is the right default for `task<T>` because it lets you compose tasks before scheduling work, gives the awaiting coroutine a chance to install continuations, and avoids running side effects until something awaits the task. Eager start matches `std::async(std::launch::async, ...)` semantics and is appropriate for fire-and-forget detached work.

The standard does not require `initial_suspend` to be `noexcept`, but if it throws, the exception is caught by the implicit handler that runs `unhandled_exception`. Make it `noexcept` unless you have a deliberate reason.

### final_suspend and Symmetric Transfer

`final_suspend` runs after `co_return` (or after `unhandled_exception`). It is the integration point for continuation passing. The classic implementation chains the awaiting coroutine.

```cpp
struct FinalAwaiter {
    bool await_ready() noexcept { return false; }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<task_promise> h) noexcept {
        // Symmetric transfer: return the continuation handle directly.
        // The compiler emits a tail call. No stack growth.
        return h.promise().continuation
            ? h.promise().continuation
            : std::noop_coroutine();
    }
    void await_resume() noexcept {}
};
```

Returning a `coroutine_handle` from `await_suspend` is symmetric transfer. Introduced to fix the unbounded stack growth bug in the original TS where `h.resume()` from inside `await_suspend` would recurse. With symmetric transfer the compiler emits a guaranteed tail call to `resume()` of the returned handle. Stack frames are reused. A million chained `co_await`s compile to constant stack usage.

`std::noop_coroutine()` returns a sentinel handle whose `resume()` is a no-op and whose `done()` returns true. Use it when there is no continuation to avoid branching in the awaiter.

#### Junior to FAANG callout

A junior implementation calls `h.promise().continuation.resume()` from inside `await_suspend` and returns `void`. This works for shallow chains but blows the stack on deep awaits. The senior fix is symmetric transfer. If you see `.resume()` inside `await_suspend` in a code review, ask why it isn't returning the handle.

### Coroutine Handle Internals

`std::coroutine_handle<P>` is a thin wrapper around a pointer to the coroutine frame. It provides:

```cpp
void resume() const;          // resumes execution at the suspend point
void destroy() const;         // destroys the frame (calls promise dtor, frees memory)
bool done() const;            // true after final_suspend has executed
P& promise() const;           // access the promise object
void* address() const;        // raw frame pointer
static coroutine_handle from_address(void*);
static coroutine_handle from_promise(P&);  // computes frame from promise offset
```

`from_promise` is implemented as pointer arithmetic. The promise is at a known offset inside the frame, so the handle can be reconstructed without storing it. This is how awaiters in a chain locate the parent frame.

The type-erased form `coroutine_handle<>` (equivalent to `coroutine_handle<void>`) drops the promise reference and is used for symmetric transfer where the continuation type is unknown.

### Coroutine Frame Layout

The standard does not specify the layout. In practice all major compilers (Clang, GCC, MSVC) emit something like:

```
+--------------------------------+
| resume function pointer        |  <- frame.address()
| destroy function pointer       |
| promise_type                   |
| suspend index (state)          |
| spilled locals & temporaries   |
| parameter copies               |
+--------------------------------+
```

The first two pointers form an ABI: `coroutine_handle::resume()` is essentially `((void(*)(void*))frame[0])(frame)`. This is also why `coroutine_handle` is just a pointer and is `trivially_copyable`.

Frame size is determined at compile time by escape analysis on the coroutine body. Locals whose lifetimes do not span a suspend point are stack-allocated and never enter the frame. Locals that span suspends are spilled. Large arrays held across `co_await` will balloon the frame.

You can measure the frame size with a builtin on Clang:

```cpp
// Clang-only, undocumented but stable.
// __builtin_coro_size() returns the frame size at the call site.
```

In practice the way to measure frame size in production is to override `operator new` on the promise and log the size argument.

```cpp
struct task_promise {
    void* operator new(size_t n) {
        std::cerr << "frame size: " << n << "\n";
        return ::operator new(n);
    }
};
```

Typical frame sizes: a trivial `task<int>` with one suspend lands around 64 to 128 bytes on x86_64. Adding captured state, exception storage, and continuation pointers pushes it to 200+ bytes quickly.

### HALO: Heap Allocation Elision Optimization

P0981 specifies that the compiler may elide the heap allocation of a coroutine frame when the lifetime of the coroutine is bounded by the caller's scope and the frame can fit in the caller's stack frame. Both Clang and GCC implement this optimization.

The conditions for HALO to fire:

1. The coroutine handle does not escape (does not get stored, returned, or passed to an opaque function).
2. The coroutine is destroyed before the caller returns.
3. Optimizations are enabled (HALO does not run at `-O0`).
4. The promise's `operator new` is the default or is marked in a way the compiler can reason about.

The pattern that defeats HALO most often is storing a continuation handle inside the promise. The optimizer cannot prove the handle does not escape, so it conservatively allocates.

`[[clang::coro_only_destroy_when_complete]]` (Clang 17+) hints that the coroutine will only be destroyed at final_suspend, allowing more aggressive HALO. Use with caution. Misapplying it on a coroutine that gets canceled is undefined behavior.

A canonical HALO-friendly pattern:

```cpp
generator<int> ints(int n) {
    for (int i = 0; i < n; ++i) co_yield i;
}

int sum(int n) {
    int s = 0;
    for (int v : ints(n)) s += v;  // generator handle never escapes
    return s;                       // HALO eligible
}
```

At `-O2` Clang reduces this to a tight loop with no allocations. Verify with `-fno-discard-value-names` and Compiler Explorer.

### await_transform and the Awaitable Pipeline

When the compiler sees `co_await expr`, it does not directly use `expr` as the awaiter. It applies the following resolution:

1. If `promise.await_transform(expr)` exists, use its result.
2. Otherwise use `expr` directly.
3. If the result has `operator co_await`, call it.
4. The final value must satisfy the awaiter concept (`await_ready`, `await_suspend`, `await_resume`).

`await_transform` is the central interception point. Use it to:

- Reject `co_await` on unrelated awaitables (compile-time enforcement of executor affinity).
- Inject scheduler context, cancellation tokens, or tracing.
- Forbid raw `co_await` on naked types and force users to opt in.

```cpp
struct task_promise {
    Executor* exec;
    template <Awaitable A>
    auto await_transform(A&& a) {
        return scoped_awaiter{std::forward<A>(a), exec};
    }
    // Block accidental co_await on unrelated types.
    void await_transform(auto&&) = delete;
};
```

The `= delete` overload is a senior-level pattern. It turns a runtime contract violation into a compile error.

### Putting It Together: The Compiler Transformation

Given:

```cpp
task<int> compute() {
    int x = co_await fetch();
    co_return x + 1;
}
```

The compiler emits roughly:

```cpp
// Pseudocode of the lowering.
struct compute_frame {
    void (*resume_fn)(void*);
    void (*destroy_fn)(void*);
    task<int>::promise_type promise;
    int state;
    // spilled: int x;
    // spilled: fetch_awaiter awaiter - } - 
task<int> compute() {
    auto* f = new compute_frame{};  // may be elided by HALO
    f->resume_fn = &compute_resume;
    f->destroy_fn = &compute_destroy;
    auto ret = f->promise.get_return_object();
    if (!f->promise.initial_suspend().await_ready())
        return ret;            // suspended at initial
    compute_resume(f);          // eager path
    return ret;
}
```

The `state` field is an integer index into a switch statement that dispatches to the correct resume point. Each `co_await` is a labeled state. This is the same transformation Duff's device performed manually.

### Practical Checklist

- Mark `final_suspend` `noexcept`. Always.
- Use symmetric transfer (return a handle from `await_suspend`) for continuation chains.
- Default to `suspend_always` in `initial_suspend` for tasks. Eager start is a footgun.
- Override `operator new` on the promise during development to log frame sizes.
- Verify HALO at `-O2` on hot paths. Compiler Explorer is the tool.
- Use `await_transform` as a wall: delete the catch-all overload.
- Never store references to locals inside the promise or in awaiters. The frame moves no, but lifetimes do not extend across `co_return`.
