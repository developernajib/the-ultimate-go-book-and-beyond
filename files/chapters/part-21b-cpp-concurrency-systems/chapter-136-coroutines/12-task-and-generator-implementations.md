## `task<T>` and `generator<T>` Implementations from Scratch

The standard library does not ship a general-purpose `task<T>` (as of C++23). Every shop rolls their own or pulls in cppcoro, folly::coro, libunifex, or stdexec. Writing one from scratch is the test of whether you actually understand coroutine machinery.

### Lazy `task<T>`

The lazy task starts suspended. The body runs only when something `co_await`s it. On completion, it symmetrically transfers back to the awaiter. This is the cppcoro shape.

```cpp
#include <coroutine>
#include <exception>
#include <utility>
#include <variant>

template <typename T>
class task {
public:
    struct promise_type {
        std::variant<std::monostate, T, std::exception_ptr> result;
        std::coroutine_handle<> continuation;

        task get_return_object() noexcept {
            return task{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() noexcept { return {}; }

        struct final_awaiter {
            bool await_ready() noexcept { return false; }
            std::coroutine_handle<> await_suspend(
                std::coroutine_handle<promise_type> h) noexcept {
                return h.promise().continuation
                    ? h.promise().continuation
                    : std::noop_coroutine();
            }
            void await_resume() noexcept {}
        };
        final_awaiter final_suspend() noexcept { return {}; }

        template <typename U>
            requires std::convertible_to<U, T>
        void return_value(U&& v) {
            result.template emplace<1>(std::forward<U>(v));
        }
        void unhandled_exception() noexcept {
            result.template emplace<2>(std::current_exception());
        }

        T&& take() && {
            if (result.index() == 2) std::rethrow_exception(std::get<2>(result));
            return std::move(std::get<1>(result));
        }
    };

    task(task&& o) noexcept : h_{std::exchange(o.h_, {})} {}
    task& operator=(task&& o) noexcept {
        if (h_) h_.destroy();
        h_ = std::exchange(o.h_, {});
        return *this;
    }
    ~task() { if (h_) h_.destroy(); }

    struct awaiter {
        std::coroutine_handle<promise_type> h;
        bool await_ready() noexcept { return !h || h.done(); }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<> waiter) noexcept {
            h.promise().continuation = waiter;
            return h;
        }
        T await_resume() { return std::move(h.promise()).take(); }
    };
    awaiter operator co_await() && noexcept { return awaiter{h_}; }

private:
    explicit task(std::coroutine_handle<promise_type> h) noexcept : h_{h} {}
    std::coroutine_handle<promise_type> h_{};
};
```

A `task<void>` specialization replaces `return_value` with `return_void` and the variant becomes `<monostate, exception_ptr>`. Production code uses a `result_holder<T>` that handles `T`, `T&`, and `void` uniformly.

The single-shot `&&` qualifier on `operator co_await` prevents double-await. If you need multi-shot, use `shared_task<T>` with reference counting and a list of continuations.

### Eager `task<T>`

An eager task starts running on construction. The first internal suspend captures the continuation slot.

```cpp
template <typename T>
class eager_task {
public:
    struct promise_type {
        // ... same result handling ...
        std::suspend_never initial_suspend() noexcept { return {}; }
        // final_suspend identical: still does symmetric transfer
    };
    // operator co_await reads from a flag the body sets when it suspends
};
```

Eager start changes one thing: by the time you call `co_await` on the task, the body may have already completed. The `await_ready` check on the awaiter must handle the synchronously-completed case.

Use eager when the body almost always completes synchronously (cached lookups, work that occasionally needs IO). The cost is loss of structured composition: you cannot wire cancellation in `when_all` because the work has already started.

### Single-Suspend-Point Task: `shared_task<T>`

A `shared_task` allows multiple awaiters. Implementation requires:

1. A reference count on the frame (cannot rely on RAII destroy).
2. A linked list of continuations populated under a mutex or atomic CAS.
3. A "completed" state machine so late awaiters resume immediately.

The publication step uses an atomic state pointer. Common pattern: a `void*` that is either a sentinel (`STATE_RUNNING`), a continuation handle, or `STATE_DONE`. CAS from `STATE_RUNNING` to a new `awaiter*` node forms a Treiber stack of waiters. On final_suspend, swap to `STATE_DONE` and walk the stack, resuming each waiter (or scheduling them on their executor).

```cpp
struct waiter_node {
    std::coroutine_handle<> h;
    waiter_node* next;
};
std::atomic<void*> state;  // RUNNING | waiter_node* | DONE
```

This is the same algorithm `std::shared_future` would use if it were lock-free.

### `generator<T>` from Scratch

A synchronous generator. `co_yield` pushes a value, the consumer pulls it via iterator.

```cpp
template <typename T>
class generator {
public:
    struct promise_type {
        T const* current;
        std::exception_ptr ex;

        generator get_return_object() noexcept {
            return generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() noexcept { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        std::suspend_always yield_value(T const& v) noexcept {
            current = std::addressof(v);
            return {};
        }
        std::suspend_always yield_value(T&& v) noexcept {
            current = std::addressof(v);
            return {};
        }
        void return_void() noexcept {}
        void unhandled_exception() noexcept { ex = std::current_exception(); }
        void rethrow_if_failed() {
            if (ex) std::rethrow_exception(ex);
        }
    };

    struct iterator {
        std::coroutine_handle<promise_type> h;

        iterator& operator++() {
            h.resume();
            if (h.done()) {
                h.promise().rethrow_if_failed();
                h = {};
            }
            return *this;
        }
        T const& operator*() const noexcept { return *h.promise().current; }
        bool operator==(std::default_sentinel_t) const noexcept {
            return !h || h.done();
        }
    };

    iterator begin() {
        if (h_) {
            h_.resume();
            if (h_.done()) h_.promise().rethrow_if_failed();
        }
        return iterator{h_};
    }
    std::default_sentinel_t end() noexcept { return {}; }

    generator(generator&& o) noexcept : h_{std::exchange(o.h_, {})} {}
    ~generator() { if (h_) h_.destroy(); }

private:
    explicit generator(std::coroutine_handle<promise_type> h) noexcept : h_{h} {}
    std::coroutine_handle<promise_type> h_{};
};
```

`yield_value` stores a pointer (not a copy) and returns `suspend_always`. The reference is valid only until the next resume. Consumers must not cache pointers across iterations. This is the zero-copy contract.

`yield_value` overloads for lvalue and rvalue handle both `co_yield x` and `co_yield std::move(x)`. Elements are kept inside the producer's frame in the rvalue case (the temporary lives across the suspend because the address-of operation extends it as part of the frame spill).

#### std::generator (P2502)

C++23 standardizes `std::generator<T, V, Allocator>` (P2502, voted in February 2023). Differences from a hand-rolled generator:

- Range adaptor support (it satisfies `view`).
- Recursive yield via nested generators (`co_yield std::ranges::elements_of(g)`) which avoids the O(depth) overhead of manual recursion.
- Allocator parameter for frame allocation (separate from value allocation).

Library availability: libstdc++ ships it from GCC 14, libc++ from LLVM 18 (partial), MSVC STL from VS 17.10. If you target older toolchains, pull from a backport (one of the cppcoro-derived implementations, or write your own following the spec).

### `async_generator<T>`

A generator whose `yield_value` is itself awaitable. The producer suspends at `co_yield`, the consumer suspends at `co_await ++it`.

The shape:

```cpp
template <typename T>
struct async_generator {
    struct promise_type {
        T const* current;
        std::coroutine_handle<> consumer;

        auto yield_value(T const& v) noexcept {
            current = std::addressof(v);
            struct awaiter {
                promise_type* p;
                bool await_ready() noexcept { return false; }
                std::coroutine_handle<> await_suspend(std::coroutine_handle<>) noexcept {
                    return p->consumer ? p->consumer : std::noop_coroutine();
                }
                void await_resume() noexcept {}
            };
            return awaiter{this};
        }
        // ...
    };

    struct iterator_awaiter { /* resumes the producer, awaits the next value */ };
    auto begin();
    auto next();  // returns an awaiter producing optional<T>
};
```

The handoff is bidirectional symmetric transfer. Each `co_yield` jumps to the consumer. Each `co_await ++it` jumps back to the producer. This compiles to a tight ping-pong with no heap activity beyond the two frames.

### Comparison: cppcoro, libunifex, stdexec

| Library | Model | Status |
|---|---|---|
| cppcoro (Lewis Baker) | task<T>, generator<T>, async_generator<T>, schedulers | Stable. Last meaningful update 2021. Reference design for everyone else. |
| folly::coro (Meta) | Task<T>, AsyncGenerator<T>, BlockingWait, executors | Production at Meta. Tightly coupled to folly. |
| libunifex (Meta) | Senders/receivers, predates P2300, task<T> available. | Active. Source of much of P2300. |
| stdexec (NVIDIA) | P2300 reference implementation. | Most active. Tracks the paper. Preferred for new code. |

For new code in 2026: use stdexec for the sender/receiver model and a small custom `task<T>` (or fold cppcoro's) for places where coroutine syntax is preferred. The two interoperate (`as_awaitable` adapter exists in stdexec).

### Pitfalls

- Forgetting to `destroy()` the handle in the destructor. The frame leaks. RAII or bust.
- Returning a reference from `task<T&>` requires the variant to hold a pointer, not a reference. References cannot be reseated.
- Move-only `T` requires the variant alternatives to be move-only-aware. `std::variant` is fine, but custom storage often is not.
- Allowing `task<T>` to be `co_await`ed twice. Use `&&`-qualified `operator co_await`.
- `generator<T>` returning by reference to a local in the consumer side. Always copy if you need to outlive the next iteration.
