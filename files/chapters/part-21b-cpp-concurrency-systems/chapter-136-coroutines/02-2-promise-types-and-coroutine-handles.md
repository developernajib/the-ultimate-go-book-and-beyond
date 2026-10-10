## 2. Promise Types and Coroutine Handles

The coroutine machinery in C++ is built on two pillars: the **promise type** that controls the coroutine's behavior and the **coroutine handle** that provides external access to the suspended coroutine.

### The Coroutine Frame

When the compiler encounters a coroutine, it allocates a *coroutine frame* on the heap. This frame contains:

1. The **promise object** (controls behavior at suspension/resumption/completion points)
2. Copies of all **function parameters**
3. All **local variables** that live across suspension points
4. The **suspension point index** (which `co_await`/`co_yield` the coroutine is suspended at)

```
+------------------------------------------+
|            Coroutine Frame               |
+------------------------------------------+
| Resume function pointer                  |
| Destroy function pointer                 |
| Promise object                           |
| Suspension point index                   |
| Copies of parameters                     |
| Local variables (across suspend points)  |
+------------------------------------------+
```

### Promise Type Requirements

The promise type is the central customization point. The compiler looks for a nested `promise_type` in the coroutine's return type.

```cpp
template <typename T>
struct MyCoroutine {
    struct promise_type {
        // REQUIRED: Create the return object given to the caller
        MyCoroutine get_return_object();

        // REQUIRED: Should the coroutine suspend before executing the body?
        // suspend_always = lazy start (caller must resume explicitly)
        // suspend_never  = eager start (body runs immediately)
        std::suspend_always initial_suspend();

        // REQUIRED: Should the coroutine suspend after completing?
        // suspend_always = caller must call handle.destroy()
        // suspend_never  = frame auto-destroys (handle becomes dangling)
        std::suspend_always final_suspend() noexcept;

        // ONE OF THESE (not both):
        void return_void();              // For co_return; or falling off the end
        void return_value(T value);      // For co_return <expr>;

        // REQUIRED: Called if the coroutine body throws
        void unhandled_exception();

        // OPTIONAL: Called by co_yield <expr>
        auto yield_value(T value);

        // OPTIONAL: Customize coroutine frame allocation
        static void* operator new(std::size_t size);
        static void operator delete(void* ptr, std::size_t size);

        // OPTIONAL: Transform co_await expressions
        auto await_transform(auto&& expr);
    };
};
```

### Coroutine Handle

`std::coroutine_handle<Promise>` is a lightweight, non-owning pointer to the coroutine frame. It is the primary interface for interacting with a suspended coroutine from outside.

```cpp
#include <coroutine>
#include <iostream>

struct ManualCoroutine {
    struct promise_type {
        ManualCoroutine get_return_object() {
            return ManualCoroutine{
                std::coroutine_handle<promise_type>::from_promise(*this)
            };
        }
        std::suspend_always initial_suspend() { return {}; }  // Lazy start
        std::suspend_always final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;

    explicit ManualCoroutine(std::coroutine_handle<promise_type> h) : handle(h) {}
    ~ManualCoroutine() { if (handle) handle.destroy(); }
};

ManualCoroutine stepping_coroutine() {
    std::cout << "Step 1\n";
    co_await std::suspend_always{};
    std::cout << "Step 2\n";
    co_await std::suspend_always{};
    std::cout << "Step 3\n";
}

int main() {
    auto coro = stepping_coroutine();
    // Coroutine is lazy - suspended at initial_suspend

    std::cout << "Resuming...\n";
    coro.handle.resume();   // Prints "Step 1", suspends at first co_await
    
    std::cout << "Resuming...\n";
    coro.handle.resume();   // Prints "Step 2", suspends at second co_await
    
    std::cout << "Resuming...\n";
    coro.handle.resume();   // Prints "Step 3", suspends at final_suspend
    
    std::cout << "Done: " << coro.handle.done() << "\n";  // true
}
```

Key handle operations:

| Method | Description |
|---|---|
| `handle.resume()` | Resume execution from current suspension point |
| `handle.destroy()` | Destroy the coroutine frame and free memory |
| `handle.done()` | Returns `true` if the coroutine is at final_suspend |
| `handle.promise()` | Access the promise object |
| `handle.address()` | Get raw `void*` pointer (for storage in C APIs) |
| `from_address(ptr)` | Reconstruct handle from raw pointer |

### The Coroutine Lifecycle

The compiler transforms a coroutine into roughly this pseudocode:

```
// What the compiler generates (conceptual):
{
    Frame* frame = new Frame{...};
    Promise& promise = frame->promise;
    
    ReturnType result = promise.get_return_object();
    
    co_await promise.initial_suspend();  // Suspend before body?
    
    try {
        <body>                           // Your coroutine code
    } catch (...) {
        promise.unhandled_exception();
    }
    
    co_await promise.final_suspend();    // Suspend after body?
    
    // Frame destroyed (if not suspended at final_suspend)
}
```

### Junior → FAANG: Promise Types as the Coroutine's Contract

The promise type is the mechanism that connects the coroutine body to the caller. It is not the same as `std::promise`. The coroutine promise defines: how the coroutine starts (initial_suspend), what happens when it yields or returns a value (yield_value, return_value), how it handles exceptions (unhandled_exception), and what happens when it finishes (final_suspend).

The first-job approach: do not write promise types from scratch. Use CppCoro's `Task<T>`, Folly Coro's `Task<T>`, or `std::generator<T>` (C++23). These libraries have correct, battle-tested promise implementations. Write your own promise only when you need behavior that no library provides.

Understanding the lifecycle diagram in this section is essential for debugging coroutine leaks. If a coroutine is suspended at `final_suspend` and the handle is never destroyed, the coroutine frame leaks. This shows up as slow memory growth in long-running services.

### Senior @ FAANG: Promise Type Design as a Library API Contract

At L5+, designing a new coroutine promise type is a library design problem, not just a C++ template problem. The promise type defines the observable behavior of every coroutine that uses it: does it start eagerly or lazily? Does it propagate exceptions or swallow them? Does the caller or the coroutine own the frame?

The design decisions and their tradeoffs: `initial_suspend` returning `std::suspend_always` means the coroutine starts lazily (nothing runs until the first `co_await`). This is the recommended pattern for task-based coroutines because it avoids running code before the caller has a chance to set up error handling. `initial_suspend` returning `std::suspend_never` runs eagerly, which can cause ordering surprises.

`final_suspend` returning `std::suspend_always` is required for any promise type where the caller needs to observe the result or exception after the coroutine finishes. The Folly and CppCoro task types both do this. The consequence: the caller must hold and eventually destroy the coroutine handle. Forgetting to destroy the handle leaks the frame.

Governance: a custom promise type must document its ownership model in its API contract. "The caller is responsible for destroying the coroutine_handle after the coroutine is done" is a non-obvious requirement that must appear in the header comment. RAII wrappers (like Folly's `Task<T>`) encode this contract in the type system: the `Task` destructor destroys the handle. Every custom promise type should do the same.

---
