## Executors and Schedulers

A coroutine that never hops execution context is just syntax. Real systems need an executor: the abstraction that owns threads and decides where work runs. The right executor model determines latency, throughput, fairness, and your ability to reason about thread affinity.

### The Executor Concept

An executor schedules a callable. The minimum interface:

```cpp
struct executor_concept {
    void schedule(std::coroutine_handle<>);             // resume the handle on us
    bool on_executor() const noexcept;                  // affinity check
};
```

`schedule(h)` enqueues `h` for resumption. The handle is type-erased so any coroutine can be parked on any executor. `on_executor()` lets fast-path code skip the hop when already on the right thread.

In sender/receiver land the equivalent is the `scheduler` concept: an object exposing `schedule()` returning a sender that completes on the scheduler. Same idea, different vocabulary.

### A Minimal thread_pool Executor

```cpp
class thread_pool {
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::coroutine_handle<>> q_;
    std::vector<std::jthread> workers_;
    bool stopped_{false};

public:
    explicit thread_pool(size_t n) {
        for (size_t i = 0; i < n; ++i)
            workers_.emplace_back([this](std::stop_token st) { worker(st); });
    }

    void schedule(std::coroutine_handle<> h) {
        {
            std::lock_guard lk{mu_};
            q_.push_back(h);
        }
        cv_.notify_one();
    }

    auto schedule() {
        struct awaiter {
            thread_pool* p;
            bool await_ready() noexcept { return false; }
            void await_suspend(std::coroutine_handle<> h) noexcept { p->schedule(h); }
            void await_resume() noexcept {}
        };
        return awaiter{this};
    }

private:
    void worker(std::stop_token st) {
        while (true) {
            std::coroutine_handle<> h;
            {
                std::unique_lock lk{mu_};
                cv_.wait(lk, [&] { return !q_.empty() || st.stop_requested(); });
                if (st.stop_requested() && q_.empty()) return;
                h = q_.front();
                q_.pop_front();
            }
            h.resume();
        }
    }
};
```

Two things to notice. First, `schedule()` returns an awaiter with empty `await_resume`. The "value" of the await is the side effect of running on the pool. Second, the coroutine handle is the unit of work. No `std::function`, no allocation per task. The frame already exists, we just shuffle a pointer.

This is the central efficiency win of coroutines vs `std::async` or callback tasks: the work item does not own captured state. Captured state lives in the coroutine frame, which exists exactly once.

### Hop and Affinity

```cpp
task<void> handler(Req req) {
    co_await io_pool.schedule();
    auto data = co_await read_socket(req.fd);
    co_await cpu_pool.schedule();
    auto out = compute(data);
    co_await io_pool.schedule();
    co_await write_socket(req.fd, out);
}
```

The fast-path optimization: if `await_ready` returns `true` when already on the target executor, the suspend is skipped. The `schedule` awaiter checks `pool->on_executor()` (which queries `thread_local` state set by the worker loop) and short-circuits.

```cpp
bool await_ready() noexcept {
    return p->on_executor();   // already there? do not hop.
}
```

This pattern is the single most important optimization in production async pipelines. Without it, a request that already lives on the IO thread pays a queue round-trip for every `co_await io_pool.schedule()`.

### when_all

Run multiple awaitables concurrently and complete when all are done.

```cpp
template <typename... Ts>
auto when_all(task<Ts>... tasks) -> task<std::tuple<Ts...>> {
    auto state = std::make_shared<when_all_state<Ts...>>(sizeof...(Ts));
    (spawn_child(std::move(tasks), state), ...);
    co_return co_await state->awaiter();
}
```

`when_all_state` holds:

- A `std::tuple<std::optional<Ts>...>` of results.
- An atomic counter initialized to N.
- A continuation handle (the parent).
- A stop_source shared with children for fail-fast cancellation.

Each child writes its result, atomically decrements the counter, and the last one to reach zero resumes the parent (symmetric transfer to it). If a child throws, we move it into the result slot and request stop on the source so siblings cancel.

The fail-fast policy is configurable. cppcoro's `when_all_ready` waits for all (no stop on first error). `when_all` (cancel siblings on error) is the convention in folly::coro and stdexec.

### when_any

Complete when the first awaitable completes. The losers are canceled.

```cpp
template <typename... Ts>
auto when_any(task<Ts>... tasks) -> task<std::variant<Ts...>>;
```

Implementation parallels `when_all` but uses a single-write-wins atomic flag instead of a counter. The first child to complete writes its result, requests stop on the source, and resumes the parent. Late children's results are discarded.

`when_any` is the building block for timeouts: `when_any(work(), sleep(deadline))`.

### Work-Stealing Executors

The thread_pool above has a single mutex-guarded queue. It bottlenecks at ~1M schedule/sec on contemporary hardware. Production systems use work stealing.

The shape:

- Each worker has a per-thread deque (Chase-Lev or similar).
- The worker pushes new work to its own deque (LIFO from the local end, cache-warm).
- Workers steal from the back (FIFO) of other workers' deques when their own is empty.
- A global queue holds work submitted from non-worker threads.

```cpp
class work_stealing_pool {
    std::vector<std::unique_ptr<chase_lev_deque<coroutine_handle<>>>> locals_;
    moodycamel::ConcurrentQueue<coroutine_handle<>> global_;
    std::vector<std::jthread> workers_;
    std::counting_semaphore<> sem_{0};
    inline static thread_local int worker_id_ = -1;

public:
    void schedule(coroutine_handle<> h) {
        if (worker_id_ >= 0) locals_[worker_id_]->push(h);
        else global_.enqueue(h);
        sem_.release();
    }
};
```

Chase-Lev deques are lock-free for the owning thread and use a CAS on steals. This is the data structure behind Tokio's runtime, Go's scheduler, and most modern thread pools. Niall Douglas's `static_thread_pool` (in P0443's reference impl) uses this design.

Senior tradeoff: work stealing reduces tail latency under load imbalance but adds memory ordering cost on every push/pop. For uniformly-loaded pipelines a per-worker queue with no stealing can be faster. Measure before defaulting.

### IO-Bound vs CPU-Bound Pools

Run them as separate executors. Mixing them is a tail latency disaster.

- IO pool: typically 1-2 threads (or as many as IO completion drivers can saturate). io_uring SQ_POLL eliminates the need for a thread at all in some configurations. Threads here mostly sleep on completion queues.
- CPU pool: `std::thread::hardware_concurrency()` workers. Pinned to cores when latency-sensitive. Locks should be uncontended.

A coroutine that does `read -> parse -> compute -> serialize -> write` should hop: IO -> CPU -> IO. The hops are cheap (a queue push) compared to mixing CPU bursts onto the IO thread, which delays completion handling and tanks throughput.

```cpp
task<Resp> handler(Req r) {
    auto raw = co_await io.async_read(r.fd);
    co_await cpu.schedule();
    auto parsed = parse(raw);
    auto resp = compute(parsed);
    auto out = serialize(resp);
    co_await io.schedule();
    co_await io.async_write(r.fd, out);
    co_return resp;
}
```

#### Junior to FAANG callout

A junior puts everything on one pool sized to `hardware_concurrency()`. Under bursty load the IO completion handlers compete with compute and the p99 latency explodes. Split the pools. Run the IO pool with 1-2 threads and the CPU pool with the rest. Verify by stalling the CPU pool with synthetic work and watching that IO completions still drain.

### Strands and Serial Execution

A strand serializes execution within a pool. Useful for protecting per-connection state without locks.

```cpp
class strand {
    executor* pool_;
    std::atomic<int> count_{0};
    std::deque<std::coroutine_handle<>> q_;
    std::mutex mu_;

public:
    void schedule(std::coroutine_handle<> h) {
        {
            std::lock_guard lk{mu_};
            q_.push_back(h);
        }
        if (count_.fetch_add(1, std::memory_order_acq_rel) == 0)
            pool_->schedule(handle_one());
    }
};
```

A strand admits one runnable at a time onto the pool. Per-connection state guarded by a strand needs no mutex inside the handler. Asio's `strand` does this, folly's `SerialExecutor` does this. The implementation cost is one CAS per schedule.

### libunifex and stdexec Schedulers

In sender land:

```cpp
auto sched = pool.get_scheduler();
auto s = stdexec::on(sched, do_work());     // run do_work on sched
sync_wait(s);
```

`on(sched, sender)` is the declarative equivalent of `co_await sched.schedule(); co_await sender;`. The benefit is the framework knows the scheduler, so cancellation and forward progress guarantees compose. The cost is verbosity.

The two worlds bridge. `stdexec::let_value` accepts a sender returning a coroutine. `as_awaitable` turns a sender into an awaiter. Greenfield code in 2026 should pick one and stick to it. Mixing is a refactoring tax.

### schedule_after and Timer Integration

```cpp
auto sleep_for(executor& ex, std::chrono::milliseconds d);
```

Implementation: a single timer thread (or io_uring `IORING_OP_TIMEOUT`) maintains a min-heap of (deadline, handle). On tick, expired entries are scheduled on their target executor. The awaiter holds the stop_callback that cancels the timer entry on stop.

libunifex's `schedule_after` and folly's `TimedDrivableExecutor` are the reference implementations. A self-rolled version with `eventfd` plus a `timerfd` works fine on Linux. Avoid one timer per coroutine: heap operations are cheap, syscalls are not.

### Executor Pitfalls

- Resuming a coroutine on the wrong executor and losing thread affinity invariants. Use strands or hop explicitly.
- Forgetting that `await_resume` runs on the executor that called `resume()`. If an awaiter resumes from a callback thread, the rest of the coroutine runs on that thread until the next hop.
- Detached coroutines outliving the executor. The executor's destructor must drain all pending work and refuse new schedules. Otherwise a `resume()` after pool shutdown crashes.
- Recursive scheduling: `await_suspend` calling `schedule(h)` synchronously and the executor synchronously calling `h.resume()` (single-thread executors). Use `defer` semantics or trampolining to avoid stack overflow.
