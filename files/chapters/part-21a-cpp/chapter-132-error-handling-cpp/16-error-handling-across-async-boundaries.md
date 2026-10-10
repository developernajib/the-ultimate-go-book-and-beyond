## Error Handling Across Async Boundaries

Async code complicates error propagation because the throw site and the catch site live in different stack frames, often on different threads, and possibly in different cores. C++ has three async models in production right now: `std::future` / `std::promise`, coroutines (`co_await`), and the sender/receiver model from P2300 (`std::execution`). Each handles errors with a slightly different shape.

### `std::exception_ptr` Is the Bridge

Any time you must move an in-flight exception across a thread or store it for later, you use `std::exception_ptr`. It is a reference-counted handle to a heap-allocated exception object.

```cpp
#include <exception>

std::exception_ptr capture() {
    try {
        do_work();
    } catch (...) {
        return std::current_exception();   // ref-bumps the in-flight exception
    }
    return nullptr;
}

void replay(std::exception_ptr p) {
    if (p) std::rethrow_exception(p);      // throws the captured exception in the current thread
}
```

`current_exception` outside a catch block returns `nullptr`. `rethrow_exception` on a null pointer is undefined behavior. The handle is thread-safe to copy, move, and rethrow (each thread that rethrows gets its own materialized exception object).

This is the only sanctioned way to ferry an exception across a thread. Do not store and rethrow `std::exception` objects by value: slicing destroys the dynamic type.

## `std::promise` and `std::future`

```cpp
std::promise<int> p;
auto f = p.get_future();

std::thread t([&p] {
    try {
        int v = compute_or_throw();
        p.set_value(v);
    } catch (...) {
        p.set_exception(std::current_exception());
    }
});

try {
    int v = f.get();        // either returns the value, or rethrows
    use(v);
} catch (const Error& e) {
    handle(e);
}
t.join();
```

`promise::set_exception` stores the `exception_ptr` inside the shared state. `future::get` checks for an exception first, if present, it rethrows it on the current thread. The exception type is preserved exactly.

The pitfall: if the promise is destroyed without `set_value` or `set_exception`, the future's `get` throws `std::future_error` with code `broken_promise`. This is a footgun in code paths where the producing thread exits early, fails to acquire a resource, or panics. Always ensure either `set_value` or `set_exception` is called on every path before the promise is dropped. A scope guard helps:

```cpp
auto guard = absl::Cleanup([&]() noexcept {
    if (!p.is_satisfied()) {                 // your own flag
        p.set_exception(std::make_exception_ptr(
            std::runtime_error("producer dropped without result")));
    }
});
```

### Coroutines

A coroutine that can throw must surface the exception through its promise type. The library type (`task<T>`, `lazy<T>`, `Awaitable<T>`) decides how. A typical pattern:

```cpp
template <typename T>
struct task {
    struct promise_type {
        std::variant<std::monostate, T, std::exception_ptr> result;

        task<T> get_return_object() {
            return task{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_never initial_suspend() noexcept { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void unhandled_exception() noexcept {
            result.template emplace<2>(std::current_exception());
        }
        template <typename U>
        void return_value(U&& v) {
            result.template emplace<1>(std::forward<U>(v));
        }
    };
    // ...
    T await_resume() {
        auto& r = handle_.promise().result;
        if (r.index() == 2) std::rethrow_exception(std::get<2>(r));
        return std::move(std::get<1>(r));
    }
};
```

Three things worth pinning:

1. `unhandled_exception()` is the coroutine's catch-all. The compiler wraps the body in a `try { ... } catch (...) { promise.unhandled_exception(); }`. If `unhandled_exception` rethrows, the exception propagates out of `coroutine_handle::resume()`, which is almost always the wrong place (because resume is often called from a scheduler that does not expect to catch).
2. The exception is stored, not propagated synchronously. A consumer awaiting the task receives the throw at the `co_await` site, which is the natural place for it.
3. The `final_suspend` returning `suspend_always` is required for safe RAII semantics around the captured exception. Returning `suspend_never` destroys the promise (and the stored `exception_ptr`) before the awaiter can look at it.

A common bug: forgetting to rethrow on `await_resume`, so a coroutine that "succeeded" silently dropped an exception.

### Cancellation Is Not an Error

A coroutine, future, or sender that is canceled is in a different state from one that failed. Conflating them produces bad metrics and bad user experience. The model that has stuck:

- **Value channel.** Success.
- **Error channel.** Failure (exception, error_code, status).
- **Done / stopped channel.** Cancellation. Carries no payload.

P2300 (`std::execution`, expected in C++26) makes this explicit:

```cpp
namespace ex = std::execution;

auto sndr = ex::just(42)
          | ex::then([](int x) { return x + 1; })
          | ex::let_error([](auto e) {
                if constexpr (std::same_as<decltype(e), std::error_code>) {
                    return ex::just_error(e);
                } else {
                    return ex::just_error(std::current_exception());
                }
            })
          | ex::upon_stopped([] { /* cleanup, no value */ });
```

A receiver has three completion signals: `set_value`, `set_error`, `set_stopped`. A scheduler that cancels a chain calls `set_stopped` on the receiver. A library that maps cancellation to an exception (e.g., a `std::operation_canceled` thrown out of `co_await`) loses the distinction and forces every layer to filter.

Asio's stop_token, libunifex's `done` signal, and folly's `SemiFuture::cancel` all express the same idea: cancellation is a third channel. Treat it that way.

### Coroutines and `noexcept`

A coroutine cannot be `noexcept`. Its body is wrapped in a try/catch the compiler synthesizes. What you can do is mark `await_ready`, `await_suspend`, and `await_resume` `noexcept` to give the optimizer and the awaiter clearer guarantees. `await_suspend` throwing is particularly bad because it occurs after suspension, with state half-set up. Mark `await_suspend` `noexcept` and translate any internal failure to a `set_error` on the receiver.

### Common Mistakes

**Throwing through a thread boundary by raw pointer.** `std::thread`'s function should not throw. If it does, `terminate` is called. Always wrap the thread body in try/catch that funnels into `promise::set_exception` or a domain channel.

**Storing exceptions by base class.** Slicing. Use `exception_ptr`.

**Destroying the consumer before the producer completes.** `future::~future` does not block (except for `std::async`'s shared state). The exception you carefully captured is dropped if no one calls `get`.

**`shared_future` and double rethrow.** Multiple consumers can call `get` on a `shared_future`. Each gets a fresh rethrown copy. This is correct, but watch for double-logging: if every consumer logs and rethrows, one error becomes N log lines.

**Interleaving `set_value` and `set_exception`.** Calling either twice on a `promise` throws `std::future_error`. If two paths might satisfy a promise, gate with a flag or atomic.

**Cancellation as exception.** Mapping cancel to a thrown `OperationCanceled` blends with real errors. Use a `stop_token` and a third channel.

### Folly and Sender Patterns

`folly::SemiFuture<T>` and `folly::Future<T>` propagate exceptions via `folly::Try<T>`, which is essentially `variant<T, exception_wrapper>`. `exception_wrapper` is folly's portable equivalent of `exception_ptr` with extra ergonomics (peek at the type, format it, rethrow). The `then` continuation receives `Try<T>` so the consumer can branch:

```cpp
future.thenTry([](folly::Try<int> t) {
    if (t.hasException()) {
        t.exception().handle(
            [](const NotFound& e) { /* ... */ },
            [](const std::exception& e) { /* ... */ });
        return -1;
    }
    return t.value();
});
```

This is more pleasant than `try/catch` around `t.get()` because the type is matched without rethrow.

## FAANG Bar

A senior engineer should:

- Use `exception_ptr` to ferry exceptions across threads.
- Recognize the `broken_promise` failure mode and prevent it.
- Implement a coroutine `promise_type` with a correct `unhandled_exception`.
- Distinguish error from cancellation in API design.
- Mark coroutine awaiter members `noexcept` where possible.
- Map P2300 `set_error` and `set_stopped` to their consumer channels correctly.
