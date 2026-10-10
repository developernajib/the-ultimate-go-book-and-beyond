## Structured Concurrency with Task Groups

Unstructured coroutines are a footgun. Spawn a `task`, forget to await it, and you get dangling coroutine frames, silent cancellation failures, and crashes during shutdown. Structured concurrency, popularized by Trio and Kotlin, enforces a simple rule: every task has a parent, and no parent exits until all children have completed or been canceled. C++26's `std::execution` brings this discipline to the standard, but the pattern is implementable today on top of C++20 coroutines.

### Task groups: scoped concurrency

A task group is a nursery in which child tasks live. When the group exits, all outstanding children are joined or canceled. No child can outlive its group. This one rule eliminates the majority of async resource leaks.

```cpp
#include <coroutine>
#include <atomic>
#include <vector>
#include <mutex>
#include <exception>

class task_group {
public:
    task_group() = default;
    task_group(const task_group&) = delete;
    task_group& operator=(const task_group&) = delete;

    template <typename Awaitable>
    void spawn(Awaitable aw) {
        outstanding_.fetch_add(1, std::memory_order_relaxed);
        // Wrap the awaitable so completion decrements the counter
        schedule([this, a = std::move(aw)]() mutable -> detached_task {
            try {
                co_await std::move(a);
            } catch (...) {
                std::lock_guard g(mu_);
                if (!first_error_) first_error_ = std::current_exception();
                cancel_token_.request_cancel();
            }
            if (outstanding_.fetch_sub(1, std::memory_order_acq_rel) == 1) {
                done_.set();
            }
        }());
    }

    auto join() -> join_awaitable { return {this}; }

    cancel_token& token() noexcept { return cancel_token_; }

private:
    std::atomic<int> outstanding_{0};
    one_shot_event done_;
    std::mutex mu_;
    std::exception_ptr first_error_;
    cancel_token cancel_token_;
    friend struct join_awaitable;
};
```

`join()` suspends the parent until `outstanding_` drops to zero. If any child threw, the parent rethrows the first captured exception after all siblings have wound down. This is the critical guarantee: a partial failure never leaves orphaned work.

### Cancellation propagates downward

The group owns a `cancel_token`. Children accept it as a parameter and poll it at suspension points. When the group decides to cancel, all children receive the signal and unwind via a cooperative `canceled_exception`. There is no forceful termination, coroutines release resources through their destructors exactly as synchronous code does.

```cpp
task<void> fetch(std::string url, cancel_token& tok) {
    while (true) {
        tok.throw_if_canceled();
        auto chunk = co_await http_read(url);
        if (chunk.empty()) co_return;
        co_await write_to_sink(chunk);
    }
}

task<void> fan_out(std::vector<std::string> urls) {
    task_group g;
    for (auto& u : urls) {
        g.spawn(fetch(std::move(u), g.token()));
    }
    co_await g.join();                   // all children done or canceled
}
```

If one `fetch` throws (network failure), the group cancels the others, waits for them to exit, and rethrows the first exception. Callers see a clean failure boundary with no leaks.

### Deadlines as tokens

Timeouts compose trivially with cancel tokens: a `deadline_task` spawned into the same group flips the token after N milliseconds. All siblings observe it at their next suspension point. This is the cleanest timeout model available in any mainstream language.

### Comparison with Go

Go's `context.Context` plus `errgroup.Group` implements the same pattern, and this is not a coincidence, structured concurrency is convergent design. C++ task groups add deterministic destruction order and RAII cleanup, which Go defers to GC. On the other hand, Go's goroutines are cheaper than C++ coroutine frames for short tasks, so very fine-grained fan-out favors Go.

### C++26 `std::execution`

P2300 unifies coroutines, senders, and receivers under a single algebra. `when_all`, `start_detached`, and `scope` provide standard-library primitives that subsume hand-written task groups. Libraries like stdexec and libunifex already ship production implementations. New code should target this API, the hand-rolled group above is a stepping stone.

Structured concurrency turns async code from a minefield into ordinary scoped resource management. Adopt it as the default spawning discipline.
