## Production Coroutine Patterns

The patterns in this chapter are the building blocks every real async service ends up writing. Each one assumes a `task<T>` runtime with stop_token integration (Cancellation and Stop Tokens) and a working executor (Executors and Schedulers). The implementations are deliberately minimal so you can adapt them to your concrete types.

### Timeout Pattern

Race the operation against a timer. Whoever finishes first wins, the loser is canceled.

```cpp
template <Awaitable Op>
auto with_timeout(Op op, std::chrono::milliseconds d) -> task<typename Op::result_type> {
    using R = typename Op::result_type;
    auto stop = std::stop_source{};
    auto winner = co_await when_any(
        std::move(op),
        async_sleep(d, stop.get_token())
    );
    if (winner.index() == 1) {
        stop.request_stop();
        throw timeout_error{d};
    }
    co_return std::get<0>(std::move(winner));
}

task<Data> fetch_with_timeout(Url u) {
    co_return co_await with_timeout(fetch(u), std::chrono::milliseconds{500});
}
```

The hazard: the operation must observe the stop token. Without cooperation, `with_timeout` returns from the timer branch but the operation continues running, holding resources. Verify cancellation propagation end-to-end.

`when_any` returns the first-completed result and signals stop on the others. The losing operation gets a `set_stopped` (in sender world) or an `operation_canceled` exception (in coroutine world). The coroutine catches it inside the awaiter and exits cleanly.

### Retry with Exponential Backoff

```cpp
template <typename F>
auto retry(F op, retry_policy p) -> task<std::invoke_result_t<F>::value_type> {
    auto delay = p.initial_delay;
    for (int attempt = 0; attempt < p.max_attempts; ++attempt) {
        try {
            co_return co_await op();
        } catch (retryable_error const& e) {
            if (attempt + 1 == p.max_attempts) throw;
            auto jittered = with_jitter(delay, p.jitter_pct);
            co_await async_sleep(jittered);
            delay = std::min(delay * 2, p.max_delay);
        }
    }
    std::unreachable();
}

struct retry_policy {
    int max_attempts = 5;
    std::chrono::milliseconds initial_delay{100};
    std::chrono::milliseconds max_delay{30'000};
    double jitter_pct = 0.2;
};
```

`with_jitter` adds randomized jitter to avoid thundering-herd on retries. Without jitter, every client retries at the same instant. Production systems use full jitter (`uniform(0, delay)`) per AWS's guidance, not the +/- jitter shown here.

The retryable_error filter is critical. Retrying on permanent errors (4xx) burns the budget and causes cascading load. The senior pattern is a discriminator function:

```cpp
auto retry(auto op, retry_policy p, auto is_retryable) -> task<...> {
    for (...) {
        try { co_return co_await op(); }
        catch (std::exception const& e) {
            if (!is_retryable(e) || attempt + 1 == p.max_attempts) throw;
            // ... backoff ...
        }
    }
}
```

### Throttling: Bounded Concurrency Semaphore

A counting semaphore that suspends the coroutine when the limit is reached. Production caps on outbound concurrency live here.

```cpp
class async_semaphore {
    std::mutex mu_;
    int permits_;
    std::deque<std::coroutine_handle<>> waiters_;

public:
    explicit async_semaphore(int permits) : permits_{permits} {}

    auto acquire() {
        struct awaiter {
            async_semaphore* s;
            bool await_ready() noexcept {
                std::lock_guard lk{s->mu_};
                if (s->permits_ > 0) { --s->permits_; return true; }
                return false;
            }
            void await_suspend(std::coroutine_handle<> h) {
                std::lock_guard lk{s->mu_};
                if (s->permits_ > 0) {
                    --s->permits_;
                    h.resume();   // not great: re-entrant. Better: schedule.
                    return;
                }
                s->waiters_.push_back(h);
            }
            void await_resume() noexcept {}
        };
        return awaiter{this};
    }

    void release() {
        std::coroutine_handle<> h{};
        {
            std::lock_guard lk{mu_};
            if (waiters_.empty()) { ++permits_; return; }
            h = waiters_.front();
            waiters_.pop_front();
        }
        h.resume();   // schedule onto an executor in real code
    }
};

class semaphore_guard {
    async_semaphore* s;
public:
    explicit semaphore_guard(async_semaphore& sem) : s{&sem} {}
    ~semaphore_guard() { if (s) s->release(); }
    semaphore_guard(semaphore_guard&& o) noexcept : s{std::exchange(o.s, nullptr)} {}
};

task<Resp> handle(Req req, async_semaphore& sem) {
    co_await sem.acquire();
    semaphore_guard g{sem};
    co_return co_await downstream_call(req);
}
```

The pattern: acquire, RAII guard releases on scope exit (including exception unwinding). The semaphore guard works because coroutine destructors run on unwind, the guard's destructor calls release synchronously and the semaphore's release schedules the next waiter.

Production tweak: `release()` should not synchronously call `resume()` on the woken handle. It should schedule to the executor. Otherwise a release in the middle of a hot path can recurse arbitrarily deep.

### Pipeline Composition

```cpp
async_generator<Out> pipeline(async_generator<In> source) {
    auto stage1 = transform(std::move(source), parse);
    auto stage2 = filter(std::move(stage1), is_valid);
    auto stage3 = transform(std::move(stage2), enrich);
    co_await for (auto&& x : stage3) {
        co_yield x;
    }
}

task<void> consumer(async_generator<Out> gen) {
    co_await for (auto&& x : gen) {
        co_await write_output(x);
    }
}
```

The stages compose because each is itself an async_generator. Backpressure is automatic: if the consumer is slow, `co_yield` in the producer suspends until the consumer pulls. No queue. No backpressure logic. The coroutine handoff IS the backpressure.

For multi-producer or buffered pipelines, build a `bounded_channel<T>`:

```cpp
template <typename T>
class bounded_channel {
public:
    explicit bounded_channel(size_t capacity);

    task<void> send(T v);          // suspends if full
    task<std::optional<T>> recv(); // suspends if empty, nullopt on close
    void close();
};
```

This is the C++ equivalent of Go's buffered channel. It serializes work between producers and consumers with explicit buffer size. Useful when you want the producer to run ahead of the consumer up to a bounded backlog.

### Structured Logging Across Awaits

Trace context (request ID, span ID, etc.) lives in `thread_local` storage in synchronous code. In a coroutine that may resume on a different thread, `thread_local` is the wrong abstraction. The fix: capture context into the awaiter, restore on resume.

```cpp
struct trace_ctx {
    std::string request_id;
    std::string span_id;
};

inline thread_local trace_ctx current_ctx;

template <Awaitable A>
struct traced_awaiter {
    A inner;
    trace_ctx saved;

    bool await_ready() noexcept { return inner.await_ready(); }
    auto await_suspend(std::coroutine_handle<> h) {
        saved = current_ctx;
        return inner.await_suspend(h);
    }
    auto await_resume() {
        current_ctx = saved;
        return inner.await_resume();
    }
};

struct task_promise {
    template <Awaitable A>
    auto await_transform(A&& a) {
        return traced_awaiter{std::forward<A>(a), {}};
    }
};
```

Every `co_await` saves and restores the trace context. Logs from the resumed coroutine see the right context. This is the pattern OpenTelemetry's C++ SDK uses internally.

In the sender world the equivalent uses `env`: trace context is queried from `get_env(receiver)` and propagated through composition automatically. Less ceremony, but only if your codebase is sender-native.

#### Junior to FAANG callout

A junior writes coroutine code, sees their trace IDs randomly missing in logs, and wraps every log call in "if (current_ctx.request_id.empty()) skip()". They ship broken observability. Senior code restores context at every resume so the trace never goes silent. Test it: spawn 100 concurrent coroutines, log throughout, grep for the request ID, verify the log line count matches expected. Missing log lines mean broken context propagation.

### Async File I/O on Linux

Until io_uring, "async file IO" on Linux was a lie (`O_NONBLOCK` does not work for regular files). With io_uring, real async file IO is available.

```cpp
auto async_read_file(io_ring& r, int fd, std::span<std::byte> buf, off_t offset) {
    return r.submit([=](io_uring_sqe* sqe) {
        io_uring_prep_read(sqe, fd, buf.data(), buf.size(), offset);
    });
}

task<std::vector<std::byte>> read_whole_file(io_ring& r, std::string path) {
    int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) throw std::system_error{errno, std::generic_category()};
    auto _ = scope_exit([&] { ::close(fd); });

    struct stat st;
    ::fstat(fd, &st);
    std::vector<std::byte> buf(st.st_size);
    size_t total = 0;
    while (total < buf.size()) {
        int n = co_await async_read_file(r, fd, std::span{buf}.subspan(total), total);
        if (n <= 0) throw std::runtime_error{"short read"};
        total += n;
    }
    co_return buf;
}
```

io_uring's `IORING_OP_READ` for regular files is genuinely async (the kernel offloads to a worker if the page is not cached). For SSD-backed files this is faster than `pread` because the syscall path is shorter and submissions can be batched.

For files on slow media (network filesystems, tape), the kernel's worker pool can saturate. Use `IORING_FEAT_NATIVE_WORKERS` (kernel 5.12+) which gives io_uring its own worker threads instead of co-opting the global async pool.

`IORING_OP_OPENAT2` for async open avoids blocking on directory lookups. `IORING_OP_FSYNC` for async fsync is essential for write paths that need durability without blocking the event loop. `IORING_OP_STATX` for async metadata.

### Connection Pool with Coroutines

```cpp
class conn_pool {
    async_semaphore sem_;
    std::deque<conn> idle_;
    std::mutex mu_;
public:
    explicit conn_pool(size_t max) : sem_{static_cast<int>(max)} {}

    task<conn> acquire() {
        co_await sem_.acquire();
        std::unique_lock lk{mu_};
        if (!idle_.empty()) {
            conn c = std::move(idle_.front());
            idle_.pop_front();
            co_return c;
        }
        lk.unlock();
        co_return co_await new_connection();
    }

    void release(conn c) {
        if (c.is_healthy()) {
            std::lock_guard lk{mu_};
            idle_.push_back(std::move(c));
        }
        sem_.release();
    }
};

class pooled_conn {
    conn_pool* pool;
    conn c;
public:
    pooled_conn(conn_pool& p, conn cn) : pool{&p}, c{std::move(cn)} {}
    ~pooled_conn() { if (pool) pool->release(std::move(c)); }
    pooled_conn(pooled_conn&& o) noexcept : pool{std::exchange(o.pool, nullptr)}, c{std::move(o.c)} {}
    conn& operator*() noexcept { return c; }
};

task<Resp> query(conn_pool& pool, Req req) {
    pooled_conn pc{pool, co_await pool.acquire()};
    co_return co_await (*pc).execute(req);
}
```

The pool composes three patterns: semaphore-based capacity, RAII for return-on-exception, and lazy connection creation. Health-check on release weeds out broken connections. Idle-timeout (not shown) closes connections that have sat too long.

### Cancellable Long-Polling

```cpp
task<Event> long_poll(client& c, std::stop_token st) {
    auto poll_op = c.async_poll();
    std::stop_callback cb{st, [&] { c.cancel_poll(poll_op); }};
    co_return co_await poll_op;
}
```

The `stop_callback` calls into the client to cancel the underlying request. The client's cancel function is responsible for waking the awaiter. Order of destruction matters: `stop_callback` is destroyed at coroutine exit, which synchronizes with any in-flight callback invocation. After the callback's destructor returns, no further calls to `cancel_poll` will occur.

### Practical Checklist

- Every blocking-shaped operation should accept a `stop_token` (or be wrapped to derive one from the env).
- Every limit (concurrency, queue depth, retry attempts) should be enforced at coroutine boundaries.
- Trace context: restore on every resume.
- RAII for cleanup: rely on coroutine unwinding to free resources.
- Fan-out: use `async_scope`. Always join.
- Backoff: exponential plus jitter. Cap at 30s typical.
- Retries: discriminate retryable from permanent.
- Pools: bound by semaphore. Health-check on release.
