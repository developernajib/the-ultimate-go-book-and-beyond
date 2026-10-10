## Interview Questions

### Conceptual Questions

**Q1: What makes a C++ function a coroutine?**

A function becomes a coroutine when its body contains `co_await`, `co_yield`, or `co_return`. The compiler detects these keywords and transforms the function into a state machine with a heap-allocated frame. No special return type annotation or declaration keyword is needed, the keywords in the body are the only signal.

**Q2: Explain the difference between stackful and stackless coroutines.**

Stackless coroutines (C++) can only suspend at the top-level coroutine function. The coroutine frame stores only local variables that span suspension points. Stackful coroutines (Go goroutines, Boost.Context) preserve the entire call stack, allowing suspension from any depth of nested function calls. Stackless coroutines use less memory but cannot suspend inside helper functions.

**Q3: What is the "coloring problem" with C++ coroutines?**

Coroutines return special types (`Task<T>`, `Generator<T>`) that differ from regular return types. A function that calls a coroutine with `co_await` must itself be a coroutine. This "colors" the codebase, async and sync code have different signatures, and converting between them requires explicit bridging (like `blockingWait`). Go avoids this: any function can be spawned as a goroutine, and channel operations work identically in sync and async contexts.

**Q4: Why does `final_suspend` return `std::suspend_always` in most coroutine types?**

If `final_suspend` returns `suspend_never`, the coroutine frame is destroyed immediately when the coroutine completes. Any coroutine handle still pointing to it becomes dangling. By returning `suspend_always`, the coroutine suspends at the end, keeping the frame alive so the caller can read the result from the promise and then explicitly call `handle.destroy()`. This gives the owner control over the frame's lifetime.

**Q5: What is symmetric transfer and why does it matter?**

Symmetric transfer is when `await_suspend` returns a `coroutine_handle<>` instead of `void` or `bool`. The runtime directly resumes the returned handle without first returning to the caller of `resume()`. This prevents stack overflow when coroutines are deeply chained (A awaits B awaits C...) because each transfer replaces the current frame on the stack rather than nesting deeper.

### Coding Questions

**Q6: Write a coroutine that counts from 1 to N, yielding each value.**

```cpp
Generator<int> count_to(int n) {
    for (int i = 1; i <= n; ++i) {
        co_yield i;
    }
}
```

**Q7: Given the following code, explain the execution order:**

```cpp
Task step_through() {
    std::cout << "A";
    co_await std::suspend_always{};
    std::cout << "B";
    co_await std::suspend_always{};
    std::cout << "C";
}

int main() {
    auto t = step_through();  // Assume lazy start
    std::cout << "1";
    t.handle.resume();
    std::cout << "2";
    t.handle.resume();
    std::cout << "3";
    t.handle.resume();
    std::cout << "4";
}
```

**Answer:** Output is `1A2B3C4`. The coroutine is lazy (suspended at `initial_suspend`). First `resume()` runs to "A" then suspends. Second `resume()` prints "B" and suspends. Third `resume()` prints "C" and reaches `final_suspend`.

**Q8: What happens if a coroutine throws an exception and `unhandled_exception()` stores it?**

The exception is captured via `std::current_exception()` and stored in the promise. When the caller retrieves the result (via `await_resume()` or a `get()` method), it calls `std::rethrow_exception()` to propagate the exception to the caller's context. This is how exceptions tunnel through suspension points.

**Q9: Can you use `co_return` and `co_yield` in the same coroutine?**

Yes. `co_yield` is used to produce intermediate values, and `co_return` (with void) terminates the coroutine. The promise type must define both `yield_value` and `return_void`. However, you cannot use `co_return <value>` (with a non-void expression) together with `co_yield` unless the promise type defines both `yield_value` and `return_value`, which is unusual.

**Q10: Design an awaitable that resumes the coroutine on a specific thread.**

```cpp
struct ResumeOnThread {
    std::thread::id target_thread;
    ThreadPool& pool;  // Assumes a thread pool with per-thread queues

    bool await_ready() const noexcept {
        return std::this_thread::get_id() == target_thread;
    }

    void await_suspend(std::coroutine_handle<> handle) {
        pool.schedule_on(target_thread, handle);
    }

    void await_resume() const noexcept {}
};
```

This is useful for resuming on the UI thread from a background computation, or for thread affinity in NUMA architectures.

---
