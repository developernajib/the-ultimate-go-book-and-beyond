## Cancellation and Stop Tokens

Cancellation is the hardest part of async C++. Threads have `pthread_cancel` (don't use it). Coroutines have `std::stop_token` (C++20) and the structured concurrency model. Done right, cancellation is cooperative, exception-safe, and propagates across executor boundaries. Done wrong, you have leaks and torn state.

### std::stop_token Recap

```cpp
std::stop_source src;
std::stop_token tok = src.get_token();

src.request_stop();           // signals cancellation
tok.stop_requested();         // poll
std::stop_callback cb{tok, [] { /* invoked on request_stop */ }};
```

`stop_callback` constructors register an inline callback. If the source has already been stopped, the callback runs synchronously inside the constructor on the requesting thread. Otherwise it runs from the thread calling `request_stop`. Either way, the callback runs exactly once.

`stop_source` and `stop_token` share state via a reference-counted control block. Copying tokens is cheap. The control block lives until all sources and tokens are destroyed.

### Integrating stop_token into a Coroutine

There is no built-in mechanism. You add it to the promise.

```cpp
template <typename T>
struct task {
    struct promise_type {
        std::stop_token stop;

        // ... standard members ...

        auto await_transform(get_stop_token_t) noexcept {
            struct awaiter {
                std::stop_token tok;
                bool await_ready() noexcept { return true; }
                void await_suspend(std::coroutine_handle<>) noexcept {}
                std::stop_token await_resume() noexcept { return tok; }
            };
            return awaiter{stop};
        }

        template <Awaitable A>
        auto await_transform(A&& a) {
            return wrap_with_stop(std::forward<A>(a), stop);
        }
    };
};

inline constexpr struct get_stop_token_t {} get_stop_token{};

// Inside a coroutine:
task<int> work() {
    std::stop_token st = co_await get_stop_token;
    if (st.stop_requested()) co_return -1;
    // ...
}
```

The `await_transform` overload for `get_stop_token_t` exposes the token to the coroutine body. The general `await_transform` wraps every awaiter with a stop-aware variant that checks the token before suspending and registers a `stop_callback` on the awaiter to resume early on cancellation.

### Wrapping Awaiters for Cancellation

```cpp
template <typename A>
struct cancel_awaiter {
    A inner;
    std::stop_token tok;
    std::optional<std::stop_callback<std::function<void()>>> cb;

    bool await_ready() {
        return tok.stop_requested() || inner.await_ready();
    }

    auto await_suspend(std::coroutine_handle<> h) {
        if (tok.stop_requested()) return false;  // skip suspend
        cb.emplace(tok, [this, h] {
            // The cancel_op must wake us - here we assume inner exposes one.
            inner.cancel();
        });
        return inner.await_suspend(h);
    }

    auto await_resume() {
        cb.reset();
        if (tok.stop_requested()) throw operation_canceled{};
        return inner.await_resume();
    }
};
```

The wrapper assumes `inner.cancel()` is callable. Real awaiters expose this only if their backing operation supports cancellation (io_uring `IORING_OP_ASYNC_CANCEL`, asio `cancellation_slot`, timer `cancel_one`). Without backend support, cooperative cancellation degrades to "check at suspend points".

The `stop_callback` is destroyed on `await_resume`. Order matters: destroy the callback before checking the token, because the destructor synchronizes with any in-flight invocation. After destruction you know the callback will not fire again.

### Propagation Across await Points

If the parent coroutine has a stop token and `co_await`s a child task, the child should observe the parent's token. Without explicit propagation it does not.

The clean solution: pass the token through the awaiter chain. Two viable patterns.

#### Pattern 1: Token via Promise

The promise carries the token. Child tasks copy it from their parent at the awaiter's `await_suspend` time.

```cpp
auto await_suspend(std::coroutine_handle<parent_promise> waiter) {
    auto& parent = waiter.promise();
    h.promise().stop = parent.stop;       // inherit token
    h.promise().continuation = waiter;
    return h;
}
```

This requires the awaiter to know the parent's promise type. In a polymorphic system you cannot, which is why senders/receivers use type erasure via `env`.

#### Pattern 2: Environment (Receivers)

P2300 senders carry an `env` accessible to the receiver. The receiver provides queries: `get_stop_token(env)`, `get_scheduler(env)`, `get_allocator(env)`. Operations that compose tasks (`when_all`, `let_value`) propagate the env.

```cpp
auto child = stdexec::then(parent_sender, [](auto&& env, auto&& v) {
    auto stop = stdexec::get_stop_token(env);
    if (stop.stop_requested()) throw canceled{};
    return v + 1;
});
```

The env is the structured way. Coroutine-only worlds bake the token into the promise, sender-only worlds use env. Mixed code translates between them.

### Structured Concurrency Cancellation

The structured rule: a parent does not return until all children have completed (or been canceled). Cancellation flows downward, completion (success or failure) flows upward.

```cpp
task<void> parent() {
    auto scope = async_scope{};
    scope.spawn(child_a());
    scope.spawn(child_b());
    co_await scope.join();   // does not return until both children finish
}
```

If `parent` is canceled, `scope`'s destructor (or `join`) requests cancellation on all children, then awaits their completion. The parent does not return while children are alive. This invariant prevents the "use after free of captured locals" bug that haunts unstructured spawn.

cppcoro's `async_scope` is the canonical implementation. It owns a `stop_source` shared with all spawned coroutines and a counter that `join()` waits on.

```cpp
class async_scope {
    std::stop_source src_;
    std::atomic<size_t> count_{0};
    std::coroutine_handle<> waiter_{};

public:
    template <typename T>
    void spawn(task<T>&& t) {
        count_.fetch_add(1, std::memory_order_relaxed);
        spawn_detached(std::move(t), src_.get_token(), [this] { on_child_done(); });
    }
    auto join() noexcept { return join_awaiter{this}; }
    void request_stop() { src_.request_stop(); }
    ~async_scope() { /* require join to have been awaited */ }
};
```

Forgetting to `co_await scope.join()` is a programmer error, equivalent to leaking a thread without `join` or `detach`. Some scope implementations make the destructor block (terminate if children remain) to fail loudly.

### Cancellation Across Executor Boundaries

A coroutine may hop executors mid-run. Cancellation must follow.

```cpp
task<Resp> handle_request(Req req) {
    co_await schedule_on(io_executor);
    auto data = co_await read_db(req);     // io_uring
    co_await schedule_on(cpu_executor);
    auto resp = co_await compute(data);    // cpu work
    co_return resp;
}
```

If the request is canceled while suspended in `read_db`, the io_uring backend must observe the stop token and submit a cancel SQE. If canceled in `compute`, the CPU work must check the token at loop boundaries. The token itself is executor-agnostic. Only the suspend points need backend cooperation.

A common bug: switching executor by `co_await sched.schedule()` and forgetting to forward the stop token. The schedule operation is cancellable in principle (it can refuse to enqueue if the token is already stopped), but if the awaiter does not check, you wait until the executor runs the task before noticing cancellation.

### Cancellation as Exception vs Sentinel

Two camps.

- Exception (cppcoro, folly::coro): `await_resume` throws `operation_canceled` when the operation was canceled. The coroutine unwinds normally. Cleanup happens via destructors.
- Sentinel value (some asio configurations): the operation completes with a special error code. The user must check it manually.

Exceptions integrate cleanly with structured cleanup but cost more on the cancellation path. Sentinels are cheap but easy to forget. The senior consensus has shifted toward exceptions for `task<T>` and toward error codes for callback APIs and tight loops.

stdexec uses `set_stopped(receiver)` as a third terminal channel (alongside `set_value` and `set_error`). Cancellation is neither a value nor an error: it is its own outcome. This avoids the "is `operation_canceled` an error or a control flow signal" debate.

#### Junior to FAANG callout

A junior wraps every `co_await` in a `try/catch(operation_canceled&)` and "handles" cancellation by logging. This breaks structured cancellation: the parent thinks the child completed normally and never sees the cancellation. Let the exception propagate up to the scope boundary and only catch it where the cancellation policy is decided (the request handler, the top-level supervisor).

### Race-Free stop_callback Removal

The hardest part of cancellable awaiters is destroying the `stop_callback` race-free. The callback may be running on a different thread when `await_resume` starts. The destructor of `stop_callback` synchronizes with in-flight invocations (it blocks until they complete, on Clang/libc++ via a sequence number protocol). After destruction, you know the callback will not run again.

What you must not do:

- Destroy state the callback reads before destroying the callback.
- Re-enter the same `stop_source` from inside a callback (the standard forbids it).
- Hold a lock across `stop_callback` construction or destruction that the callback also acquires (deadlock).

The pattern: own the callback in the awaiter (or the operation state). Construct it after the awaiter has published its handle. Destroy it first thing in `await_resume`, before reading any state the callback might have written.

### Practical Checklist

- Every long-running awaiter checks the token in `await_ready`.
- Every awaiter that suspends for indefinite time installs a `stop_callback`.
- Cancellation throws on resume. Catch only at policy boundaries.
- Use `async_scope` for fan-out. Always `co_await scope.join()` in the parent.
- Propagate the token through the promise (or env, in sender world). Inheritance is not automatic.
- Test cancellation with deterministic schedules. The race window is real and exposed by chaos tests.
