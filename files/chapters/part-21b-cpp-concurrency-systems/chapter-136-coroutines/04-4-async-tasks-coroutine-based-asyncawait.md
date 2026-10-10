## 4. Async Tasks: Coroutine-Based Async/Await

While generators use `co_yield`, async tasks use `co_await` and `co_return` to express asynchronous workflows that look like synchronous code.

### A Complete Async Task Type

`AsyncTask<T>` is a coroutine return type that requires a nested `promise_type` satisfying the coroutine promise concept. The promise stores the result in a `std::variant` (unset, value, or exception), suspends immediately on construction (`initial_suspend` returns `std::suspend_always`), and resumes a continuation handle when the result is ready, the same pattern used by every production C++ async library.
```cpp
#include <coroutine>
#include <exception>
#include <functional>
#include <optional>
#include <variant>
#include <iostream>

template <typename T>
class AsyncTask {
public:
    struct promise_type {
        std::variant<std::monostate, T, std::exception_ptr> result;
        std::coroutine_handle<> continuation = nullptr;

        AsyncTask get_return_object() {
            return AsyncTask{
                std::coroutine_handle<promise_type>::from_promise(*this)
            };
        }

        std::suspend_always initial_suspend() { return {}; }

        auto final_suspend() noexcept {
            struct FinalAwaiter {
                bool await_ready() noexcept { return false; }
                std::coroutine_handle<> await_suspend(
                    std::coroutine_handle<promise_type> me
                ) noexcept {
                    if (me.promise().continuation) {
                        return me.promise().continuation;  // Symmetric transfer
                    }
                    return std::noop_coroutine();
                }
                void await_resume() noexcept {}
            };
            return FinalAwaiter{};
        }

        void return_value(T value) {
            result.template emplace<1>(std::move(value));
        }

        void unhandled_exception() {
            result.template emplace<2>(std::current_exception());
        }
    };

    using Handle = std::coroutine_handle<promise_type>;

    // Make AsyncTask awaitable
    bool await_ready() const noexcept { return false; }

    std::coroutine_handle<> await_suspend(std::coroutine_handle<> caller) {
        handle_.promise().continuation = caller;
        return handle_;    // Symmetric transfer: resume this task
    }

    T await_resume() {
        auto& result = handle_.promise().result;
        if (result.index() == 2) {
            std::rethrow_exception(std::get<2>(result));
        }
        return std::get<1>(std::move(result));
    }

    void start() { handle_.resume(); }

    explicit AsyncTask(Handle h) : handle_(h) {}
    ~AsyncTask() { if (handle_) handle_.destroy(); }

    AsyncTask(const AsyncTask&) = delete;
    AsyncTask& operator=(const AsyncTask&) = delete;
    AsyncTask(AsyncTask&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }
    AsyncTask& operator=(AsyncTask&& other) noexcept {
        if (this != &other) {
            if (handle_) handle_.destroy();
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }

private:
    Handle handle_;
};
```

### Symmetric Transfer

The `final_suspend` in the task above uses **symmetric transfer**: instead of returning to the caller that called `resume()`, it directly transfers control to the continuation coroutine. This avoids deep recursion on the stack when chaining coroutines.

```cpp
// Without symmetric transfer: A awaits B awaits C
// Stack grows: resume(A) -> resume(B) -> resume(C)
// With symmetric transfer:
// resume(A) -> suspend, resume(B) -> suspend, resume(C)
// Stack depth stays constant
```

### Using Async Tasks

`co_await fetch_value(1)` suspends `compute` until `fetch_value` completes and makes its result available. The sequential `co_await` chain reads like synchronous code despite being fully asynchronous, the same pattern as Go's sequential goroutine code, but without spawning an OS thread for each await point.
```cpp
AsyncTask<int> fetch_value(int id) {
    // Simulate async work (in real code, this would await I/O)
    co_return id * 10;
}

AsyncTask<int> compute() {
    int a = co_await fetch_value(1);    // Suspend until fetch_value completes
    int b = co_await fetch_value(2);    // Sequential: runs after 'a' is ready
    co_return a + b;                     // 10 + 20 = 30
}

// Void specialization for fire-and-forget tasks
template <>
class AsyncTask<void> {
    // Similar to AsyncTask<T> but with return_void()
    // ... (elided for brevity)
};
```

### An Awaitable Timer

Real async work requires integration with an event loop. Here is a timer awaitable that works with a simple scheduler:

```cpp
#include <chrono>
#include <queue>
#include <functional>

struct TimerAwaitable {
    std::chrono::milliseconds delay;

    bool await_ready() const noexcept {
        return delay <= std::chrono::milliseconds(0);
    }

    void await_suspend(std::coroutine_handle<> handle) const {
        // Register with the event loop to resume after delay
        auto resume_time = std::chrono::steady_clock::now() + delay;
        get_scheduler().schedule_at(resume_time, handle);
    }

    void await_resume() const noexcept {}
};

// Usage in a coroutine
AsyncTask<void> delayed_greeting() {
    std::cout << "Hello...\n";
    co_await TimerAwaitable{std::chrono::seconds(2)};
    std::cout << "...World!\n";
}
```

### Junior → FAANG: Async Tasks as Callback Replacement

The async task pattern replaces callback chains. Without coroutines, async I/O code in C++ looks like: start operation, provide a callback, callback starts next operation, provide another callback. This callback chain is hard to read and hard to handle errors in.

With coroutines, you write `auto result = co_await async_read(buffer)` and the code reads top-to-bottom even though it is asynchronous. Exceptions propagate normally. Local variables persist across the await point.

The Go analogy: `co_await` in C++ is similar to blocking on a channel receive in Go, except it does not block a thread. The coroutine is suspended and the thread moves on. When the awaited operation completes, the coroutine is resumed (on whatever thread the awaitable's completion handler runs on).

### Senior @ FAANG: Async Task Scheduling and Executor Integration

At L5+, the async task pattern is inseparable from the executor that resumes coroutines. The executor determines: which thread resumes the coroutine after an await completes, whether resumed coroutines can be stolen by other threads (work-stealing scheduler), and how backpressure propagates when the executor is overloaded.

Folly Coro's `Task<T>` and executor integration: `co_await folly::co_reschedule_on_current_executor` allows a coroutine to yield back to its executor without completing an I/O operation, implementing cooperative yield for long-running computation. This is the C++ equivalent of Go's `runtime.Gosched()`.

The design concern for async tasks at production scale: structured concurrency. When a parent task spawns child tasks via `co_await`, what happens if the parent is canceled? In Folly Coro, `CancellationToken` propagates cancellation to all children. In CppCoro, structured task groups enforce that all children are awaited before the parent returns. Without structured concurrency, async tasks can leak (fire-and-forget tasks that outlive their parent) and cause shutdown problems.

ADR for async task adoption: require structured concurrency for all task spawning. No `fire_and_forget` tasks on critical paths. Every spawned task must be awaited, canceled, or tracked in a task group before the spawner returns. This prevents the "background task escapes shutdown" class of bugs that are extremely common in async codebases.

---
