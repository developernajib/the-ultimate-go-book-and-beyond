## 1. Co_await, co_yield, co_return: The Three Keywords

A function becomes a coroutine when its body contains any of three keywords: `co_await`, `co_yield`, or `co_return`. The compiler detects these keywords and transforms the function into a state machine. No special declaration syntax is needed, the keywords themselves trigger the transformation.

### co_await: Suspend Until Ready

`co_await` suspends the coroutine and transfers control back to the caller (or resumer). It takes an *awaitable* expression and produces a value when the coroutine resumes.

```cpp
#include <coroutine>
#include <iostream>
#include <thread>
#include <chrono>

// Forward declaration - we'll define Task fully in section 4
struct Task {
    struct promise_type {
        Task get_return_object() { 
            return Task{std::coroutine_handle<promise_type>::from_promise(*this)}; 
        }
        std::suspend_never initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;

    explicit Task(std::coroutine_handle<promise_type> h) : handle(h) {}
    ~Task() { if (handle) handle.destroy(); }

    // Non-copyable, movable
    Task(const Task&) = delete;
    Task& operator=(const Task&) = delete;
    Task(Task&& other) noexcept : handle(other.handle) { other.handle = nullptr; }
    Task& operator=(Task&& other) noexcept {
        if (this != &other) {
            if (handle) handle.destroy();
            handle = other.handle;
            other.handle = nullptr;
        }
        return *this;
    }
};

// A simple awaitable that always suspends
struct SuspendAlways {
    bool await_ready() const noexcept { return false; }   // Should we suspend?
    void await_suspend(std::coroutine_handle<>) const noexcept {} // What to do on suspend
    void await_resume() const noexcept {}                  // What to return on resume
};

Task example_coroutine() {
    std::cout << "Before suspend\n";
    co_await SuspendAlways{};                // Suspends here
    std::cout << "After resume\n";
}
```

The three methods on an awaitable control the suspension:

- **`await_ready()`**: Returns `true` if the result is already available (skip suspension). Returns `false` to suspend.
- **`await_suspend(handle)`**: Called after suspension. Receives the coroutine handle. Can schedule resumption, transfer to another coroutine, or do nothing.
- **`await_resume()`**: Called when the coroutine resumes. Its return value becomes the result of the `co_await` expression.

### co_yield: Produce a Value and Suspend

`co_yield value` is syntactic sugar for `co_await promise.yield_value(value)`. It produces a value to the caller and suspends, making it the foundation for generators.

```cpp
#include <coroutine>
#include <iostream>
#include <optional>

template <typename T>
struct Generator {
    struct promise_type {
        T current_value;

        Generator get_return_object() {
            return Generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        
        std::suspend_always yield_value(T value) {
            current_value = std::move(value);
            return {};
        }
        
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;

    explicit Generator(std::coroutine_handle<promise_type> h) : handle(h) {}
    ~Generator() { if (handle) handle.destroy(); }

    Generator(const Generator&) = delete;
    Generator& operator=(const Generator&) = delete;
    Generator(Generator&& other) noexcept : handle(other.handle) { other.handle = nullptr; }
    Generator& operator=(Generator&& other) noexcept {
        if (this != &other) {
            if (handle) handle.destroy();
            handle = other.handle;
            other.handle = nullptr;
        }
        return *this;
    }

    bool next() {
        if (!handle || handle.done()) return false;
        handle.resume();
        return !handle.done();
    }

    T value() const { return handle.promise().current_value; }
};

Generator<int> fibonacci() {
    int a = 0, b = 1;
    while (true) {
        co_yield a;              // Produce value and suspend
        auto next = a + b;
        a = b;
        b = next;
    }
}

int main() {
    auto fib = fibonacci();
    for (int i = 0; i < 10; ++i) {
        fib.next();
        std::cout << fib.value() << " ";
    }
    // Output: 0 1 1 2 3 5 8 13 21 34
}
```

### co_return: Complete the Coroutine

`co_return` completes the coroutine, optionally providing a final value. It calls either `promise.return_value(expr)` or `promise.return_void()` depending on whether a value is provided.

```cpp
struct AsyncInt {
    struct promise_type {
        int result;

        AsyncInt get_return_object() {
            return AsyncInt{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_never initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        
        void return_value(int value) {   // Called by co_return <value>
            result = value;
        }
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;

    explicit AsyncInt(std::coroutine_handle<promise_type> h) : handle(h) {}
    ~AsyncInt() { if (handle) handle.destroy(); }

    int get() const { return handle.promise().result; }
};

AsyncInt compute_answer() {
    // Simulate async work
    co_return 42;    // Complete the coroutine with value 42
}
```

**Key rule**: A coroutine body must not contain both `co_return <expr>` and `co_return;` (void). The promise type must define either `return_value` or `return_void`, never both.

### Junior → FAANG: The Three Keywords as a Mental Checklist

The three coroutine keywords map to three different actions. `co_yield` pauses and produces a value (generators). `co_await` pauses and waits for an async operation (async tasks). `co_return` ends the coroutine and optionally produces a final value.

The most common confusion: using `co_await` when you mean `co_yield`. `co_await` suspends and waits for an awaitable to complete. `co_yield` suspends and hands a value to the caller via the generator protocol. If you are writing a generator, use `co_yield`. If you are writing an async task, use `co_await`.

Interview preparation: know that any function containing `co_await`, `co_yield`, or `co_return` is transformed into a coroutine by the compiler. The return type of the coroutine determines what the caller gets, not what the function body produces. The body produces values via the promise type's `yield_value` or `return_value` methods.

### Senior @ FAANG: The Three Keywords as Suspension Protocol Contracts

At L5+, the three keywords are entry points into the coroutine machinery that must be implemented correctly in the promise type. Each keyword invokes a specific method on the promise: `co_yield expr` calls `promise.yield_value(expr)`, `co_await expr` transforms `expr` through `operator co_await`, and `co_return expr` calls `promise.return_value(expr)`. Understanding the exact transformation is required for writing custom awaitable types.

The senior design concern: `co_await` and `co_yield` interact with the promise's `initial_suspend` and `final_suspend` to create a protocol that must be consistent. If `final_suspend` returns `std::suspend_always`, the caller is responsible for destroying the coroutine frame via `coroutine_handle::destroy()`. If it returns `std::suspend_never`, the frame is automatically destroyed. An inconsistency here causes double-free or memory leak.

Bar-raiser signal: when reviewing a custom coroutine type, always ask "who destroys the coroutine frame?" The answer must be unambiguous: either the coroutine destroys itself (suspend_never at final_suspend) or the caller destroys it (suspend_always at final_suspend, and the handle must be stored and destroyed explicitly). A coroutine type where the ownership is unclear is a memory safety bug waiting to happen.

---
