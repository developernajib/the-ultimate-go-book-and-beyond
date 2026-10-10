## Awaitable Design Patterns

The awaiter contract is three functions: `await_ready`, `await_suspend`, `await_resume`. Every C++ coroutine integration eventually decomposes into a custom awaiter. This chapter is the design grammar for writing them.

### The Three-Function Contract

```cpp
struct awaiter {
    bool await_ready();                                       // (1) fast path check
    R    await_suspend(std::coroutine_handle<P> h);           // (2) park the coroutine
    T    await_resume();                                      // (3) produce the result
};
```

`await_ready` returns `true` if the value is already available and the coroutine should not suspend. The compiler skips `await_suspend` and goes straight to `await_resume`. This is the synchronous fast path: cached IO, immediate cancellation, completed futures.

`await_suspend` runs after the coroutine state is fully serialized into the frame but before `resume()` returns control to the outer caller. It can return one of three types.

| Return type | Meaning |
|---|---|
| `void` | Suspend. Caller of `resume()` regains control. Awaiter must arrange resumption. |
| `bool` | If `false`, do not suspend (resume immediately). If `true`, suspend. |
| `coroutine_handle<>` | Symmetric transfer. Resume that handle as a tail call. |

`await_resume` produces the value returned by the `co_await` expression. It runs on the coroutine that is being resumed, after `resume()` is called on the handle. If the operation produced an error and you want it to propagate as an exception, throw from `await_resume`.

### Awaiter vs Awaitable

The two terms are not synonyms.

- An awaitable is anything you can write `co_await x` on.
- An awaiter is the object the compiler ends up calling `await_ready/suspend/resume` on.

The path from awaitable to awaiter:

```cpp
auto&& awaitable = expr;
// 1. promise().await_transform(awaitable) if available
// 2. awaitable.operator co_await() if available, else operator co_await(awaitable)
// 3. the result is the awaiter
```

Implementing `operator co_await` lets a value-typed awaitable yield a stateful awaiter that holds references back into it. This is the standard pattern for `task<T>`.

```cpp
template <typename T>
struct task {
    struct awaiter {
        std::coroutine_handle<promise_type> coro;
        bool await_ready() noexcept { return coro.done(); }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<> waiter) noexcept {
            coro.promise().continuation = waiter;
            return coro;  // symmetric transfer into the task body
        }
        T await_resume() { return std::move(coro.promise()).result(); }
    };
    awaiter operator co_await() && noexcept { return awaiter{handle_}; }
};
```

Note the rvalue-reference qualifier on `operator co_await`. It enforces single-shot consumption. `co_await std::move(t)` works. `co_await t` on an lvalue does not. Senior code review should flag any `task<T>::operator co_await() &`.

### std::suspend_always vs std::suspend_never

These are the two canonical empty awaiters in the standard.

```cpp
struct suspend_always {
    bool await_ready() const noexcept { return false; }
    void await_suspend(coroutine_handle<>) const noexcept {}
    void await_resume() const noexcept {}
};
struct suspend_never {
    bool await_ready() const noexcept { return true; }
    void await_suspend(coroutine_handle<>) const noexcept {}
    void await_resume() const noexcept {}
};
```

`suspend_always` is what you return from `initial_suspend` for a lazy task. `suspend_never` is the eager variant. Outside `initial_suspend` and `final_suspend` you almost never want either: they do nothing useful, because `await_suspend` is empty and the coroutine cannot be resumed except by an external `resume()` call you arrange manually.

### Lazy vs Eager Start

The choice happens in `initial_suspend`.

- Lazy (`suspend_always`): the body does not execute until something `co_await`s the task. Composition is free of side effects. This is the cppcoro and folly::coro default. Senior code uses lazy by default.
- Eager (`suspend_never`): the body runs to the first internal suspend point as part of constructing the task. The continuation is captured at the first internal suspend. This is what `boost::asio::awaitable` does.

Eager start is a hazard with structured concurrency: if you build a `task<>` to pass to `when_all`, an eager start has already begun running before `when_all` had a chance to wire cancellation and tracing. Lazy is safer. Eager is faster for trivial tasks because it can complete synchronously and bypass the suspend.

A hybrid pattern: lazy start at the body, eager poll inside `await_ready`.

```cpp
bool await_ready() noexcept {
    coro.resume();              // run the body inline
    return coro.done();         // synchronous completion fast path
}
```

This is how you get "lazy semantics with sync fast path". cppcoro's `task<T>` uses this pattern.

### Parameterized Awaiters

Awaiters often need to carry context: an executor, a cancellation token, a deadline. Parameterize them.

```cpp
template <typename Clock, typename Duration>
struct sleep_awaiter {
    timer_service* svc;
    std::chrono::time_point<Clock, Duration> deadline;
    std::stop_token stop;

    bool await_ready() noexcept { return Clock::now() >= deadline; }
    void await_suspend(std::coroutine_handle<> h) {
        svc->schedule(deadline, h, stop);
    }
    void await_resume() {
        if (stop.stop_requested()) throw operation_canceled{};
    }
};

auto sleep_until(auto deadline, std::stop_token st = {}) {
    return sleep_awaiter{global_timer(), deadline, st};
}
```

The factory function returns a value-typed awaiter the compiler consumes directly. No `operator co_await` needed because the awaiter is the awaitable.

### Conditional Suspension via bool Return

Returning `bool` from `await_suspend` is the cleanest pattern for "suspend only if necessary".

```cpp
struct queue_awaiter {
    queue* q;
    T value;

    bool await_ready() noexcept { return false; }
    bool await_suspend(std::coroutine_handle<> h) {
        std::lock_guard lk{q->mu};
        if (!q->buffer.empty()) {
            value = std::move(q->buffer.front());
            q->buffer.pop_front();
            return false;        // do not suspend, await_resume runs
        }
        q->waiters.push_back({h, &value});
        return true;             // suspend, producer will resume us
    }
    T await_resume() noexcept { return std::move(value); }
};
```

This pattern (check under lock, decide to suspend) is the foundation of every coroutine-aware synchronization primitive. The lock is held during the publication of the handle into the waiter list, eliminating the race between "found buffer empty" and "producer wakes us".

#### Junior to FAANG callout

The naive version checks for emptiness first, then suspends, then enqueues the waiter. This loses wake-ups: a producer can publish between the check and the enqueue. The fix is to enqueue under the same lock as the check, then return `true`. This is the same race that `condition_variable::wait(lock, pred)` solves with the predicate loop.

### Symmetric Transfer Awaiters

Returning a `coroutine_handle<>` from `await_suspend` is how to chain coroutines without growing the stack. Three common shapes.

#### 1. Continuation handoff

```cpp
std::coroutine_handle<> await_suspend(std::coroutine_handle<> waiter) noexcept {
    promise.continuation = waiter;
    return inner_handle;       // jump into the awaited coroutine
}
```

#### 2. Scheduler hop

```cpp
std::coroutine_handle<> await_suspend(std::coroutine_handle<> h) noexcept {
    if (executor->on_executor()) return h;          // already there, no hop
    executor->schedule(h);
    return std::noop_coroutine();
}
```

#### 3. Conditional fast path

```cpp
std::coroutine_handle<> await_suspend(std::coroutine_handle<> h) noexcept {
    return ready ? h : std::noop_coroutine();
}
```

`std::noop_coroutine()` is the sentinel. Returning it tells the compiler "stay suspended, return to the resumer". Without it you would need a `bool`-returning overload.

### Operator co_await Free Functions vs Members

You can provide `operator co_await` as a member or as a free function in the same namespace as the type (ADL). Member is the common case. Free is useful for adapting third-party types.

```cpp
// Member: defined alongside your type.
struct my_future { auto operator co_await() && noexcept; };

// Free: adapts a third-party type via ADL.
namespace third_party { struct external_future {}; }
namespace third_party {
    inline auto operator co_await(external_future&& f) noexcept {
        return external_awaiter{std::move(f)};
    }
}
```

Per-type opt-in via free function is how libraries provide coroutine support for types they do not own. Both Asio and gRPC provide their integration this way.

### Composing Awaiters

Awaiters compose through wrapper awaiters. The wrapper holds the inner awaiter and adds behavior.

```cpp
template <typename A>
struct logged_awaiter {
    A inner;
    const char* name;

    bool await_ready() noexcept { return inner.await_ready(); }
    auto await_suspend(std::coroutine_handle<> h) {
        log("suspend at {}", name);
        return inner.await_suspend(h);
    }
    auto await_resume() {
        log("resume at {}", name);
        return inner.await_resume();
    }
};
```

The `auto` return type forwards whatever `inner.await_suspend` returns (`void`, `bool`, or `handle`). This is how cross-cutting concerns (tracing, metrics, RBAC checks) are layered without modifying the underlying awaiter.

### Pitfalls

- Returning a reference from `await_resume` to a local in the awaiter is fine because the awaiter outlives the call. Returning a reference into a temporary that died before `await_resume` is undefined.
- An awaiter's `await_suspend` must publish the handle to the resumer before returning. Once it returns, the calling coroutine has been parked, and the only way to resume it is the published handle. Forgetting this is the most common deadlock cause.
- Throwing from `await_ready` or `await_suspend` is allowed but error-prone. `await_resume` is the canonical place for exceptions because the coroutine is in a clean state. If `await_suspend` throws, the coroutine is resumed and the exception is propagated, but only if the throw happens before the suspend was published.
- Do not call `resume()` on `h` from within `await_suspend` directly. Use symmetric transfer instead (return the handle).
