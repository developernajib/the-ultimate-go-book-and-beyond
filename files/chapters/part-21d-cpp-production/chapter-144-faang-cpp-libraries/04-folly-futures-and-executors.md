## Folly: Futures and Executors

`std::future<T>` was introduced in C++11 to represent asynchronous values. It has a critical limitation: it cannot be composed. You can't chain `.then()` on a `std::future`, you can't specify where continuation code runs, and you can't wait for multiple futures without blocking a thread. Meta built `folly::Future` to solve these problems for infrastructure that processes billions of requests daily.

### The Core Types

`folly::Future<T>` is the consumer side, a handle to a value that may not be ready yet. `folly::Promise<T>` is the producer side, you fulfill the promise, which resolves the future. `folly::SemiFuture<T>` is a future without an executor attached. It must have `.via(executor)` called before you can attach continuations.

```cpp
#include <folly/futures/Future.h>
#include <folly/executors/ThreadPoolExecutor.h>
#include <folly/executors/CPUThreadPoolExecutor.h>

// Immediate value
folly::Future<int> f = folly::makeFuture(42);

// Promise/Future pair -- cross-thread communication
folly::Promise<std::string> promise;
folly::SemiFuture<std::string> semi_future = promise.getSemiFuture();

// On another thread: fulfill the promise
std::thread([p = std::move(promise)]() mutable {
    // do work...
    p.setValue("result");
    // or on error: p.setException(std::make_exception_ptr(std::runtime_error("...")));
}).detach();
```

### Chaining with .thenValue and .thenError

Folly's `.thenValue()` chains an async step that receives the unwrapped success value, while `.thenError()` catches a specific exception type and returns a fallback value so the pipeline can continue. The `.via(pool.get())` call at the start of the chain pins all subsequent continuations to a specific executor, giving precise control over which thread pool performs CPU-bound versus I/O-bound work without changing the callback logic.
```cpp
auto pool = std::make_shared<folly::CPUThreadPoolExecutor>(4);

folly::SemiFuture<std::string> fetch_user(int64_t user_id);
folly::SemiFuture<Response>    build_response(const User& user);

// Async pipeline -- each step runs on `pool`
folly::Future<Response> pipeline = fetch_user(user_id)
    .via(pool.get())
    .thenValue([](std::string raw_user) -> User {
        // Runs on pool thread
        return parse_user(raw_user);
    })
    .thenValue([](User user) -> folly::SemiFuture<Response> {
        // Can return another future -- Folly flattens it (like Promise.then)
        return build_response(user);
    })
    .thenError<UserNotFoundException>([](UserNotFoundException&& ex) -> Response {
        // Handle specific exception type
        return Response::not_found(ex.user_id());
    })
    .thenError(folly::tag_t<std::exception>{}, [](std::exception&& ex) -> Response {
        // Catch-all error handler
        LOG(ERROR) << "Pipeline failed: " << ex.what();
        return Response::internal_error();
    });
```

The Go equivalent of this pipeline is a goroutine chain with channels, or `golang.org/x/sync/errgroup` for concurrent fan-out. The key difference is that Folly futures are **values**, you can store them, pass them around, and compose them. Go channels are communication primitives, not values.

### Collecting Multiple Futures

`std::future` and `std::promise` provide a one-shot channel for returning a value or exception from an asynchronous operation to the calling thread. `std::async` wraps this mechanism with automatic thread management, making it easy to run a computation in the background and retrieve the result when needed.
```cpp
#include <folly/futures/Future.h>

// Wait for ALL futures -- fails if any fails
std::vector<folly::Future<int>> futures;
for (int i = 0; i < 10; ++i) {
    futures.push_back(compute_async(i).via(pool.get()));
}

folly::Future<std::vector<folly::Try<int>>> all_results =
    folly::collectAll(std::move(futures));

// Or: fail fast if any fails (unlike collectAll which waits for all)
folly::Future<std::vector<int>> strict_results =
    folly::collect(std::move(futures));  // exception if any future throws

// Wait for ANY future to complete
folly::Future<std::pair<size_t, folly::Try<int>>> any_result =
    folly::collectAny(std::move(futures));
```

Go equivalent: `errgroup.Go()` + `errgroup.Wait()` for `collectAll`. A `select` on multiple channels for `collectAny`. The Folly API is more composable because everything is a value.

### `folly::Try<T>`: Representing Success or Failure

`folly::Try<T>` is the type stored inside a future's result, it holds either a value or an exception.

```cpp
#include <folly/Try.h>

folly::Try<int> t1 = folly::Try<int>(42);       // success
folly::Try<int> t2 = folly::Try<int>(            // failure
    folly::exception_wrapper(std::runtime_error("failed"))
);

if (t1.hasValue()) {
    int v = t1.value();  // 42
}
if (t2.hasException()) {
    LOG(ERROR) << t2.exception().what();
}

// withTry -- receive the Try directly in a callback
future.via(pool.get()).thenTry([](folly::Try<int> t) {
    if (t.hasException()) {
        // handle error
        return -1;
    }
    return t.value() * 2;
});
```

Go's `error` return value serves the same role, but `folly::Try<T>` carries an exception rather than an error value. This matters when exceptions are the error signaling mechanism (as in much of Folly's own code).

### Executors: Controlling Where Code Runs

Folly provides specialized executor types for different workload characteristics: `CPUThreadPoolExecutor` for CPU-bound tasks sized to `hardware_concurrency()`, `IOThreadPoolExecutor` for async I/O tasks where threads block on epoll/kqueue, and `InlineExecutor` for synchronous testing without thread overhead. Choosing the wrong executor, running blocking I/O on a CPU pool, will starve CPU tasks as all threads block waiting for I/O completion.
```cpp
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/executors/IOThreadPoolExecutor.h>
#include <folly/executors/InlineExecutor.h>
#include <folly/executors/ManualExecutor.h>

// CPU-bound work -- thread count matches hardware concurrency
auto cpu_pool = std::make_shared<folly::CPUThreadPoolExecutor>(
    std::thread::hardware_concurrency()
);

// I/O-bound work -- larger pool OK, threads spend most time waiting
auto io_pool = std::make_shared<folly::IOThreadPoolExecutor>(32);

// Run inline in calling thread -- for testing or when overhead matters
auto inline_ex = folly::InlineExecutor::instance();

// ManualExecutor -- deterministic testing of async code
folly::ManualExecutor manual;
folly::Future<int> f = folly::via(&manual, [] { return compute(); });
// f is not yet resolved -- code hasn't run
manual.drain();  // run all queued work synchronously
// now f is resolved
EXPECT_EQ(42, std::move(f).get());
```

`folly::ManualExecutor` is the killer feature for testing. Instead of spawning real threads and racing against time in tests, you control exactly when each continuation executes. Go has no equivalent, testing async Go code requires real goroutines or careful use of fake channels.

### Blocking Synchronously

`.get()` blocks the calling thread until the future resolves, useful at top-level `main` or in test harnesses but dangerous inside an executor thread since it ties up a thread that could be doing real work. `.wait()` is the safer alternative for inspection: it blocks until the future has a value or exception but leaves the future object valid so you can call `.value()` or `.exception()` afterward.
```cpp
// .get() blocks the calling thread until the future resolves
// Use sparingly -- defeats the purpose of async
int result = std::move(f).via(pool.get()).thenValue([](int v) {
    return v * 2;
}).get();

// .wait() blocks but leaves the future in a valid state for inspection
folly::Future<int> f2 = make_work().via(pool.get());
f2.wait();  // block until done
if (f2.hasValue()) { /* ... */ }

// Or: convert to SemiFuture and use .get() with a timeout
auto semi = make_work();
folly::SemiFuture<int> with_timeout = std::move(semi).within(
    std::chrono::seconds(5),
    folly::FutureTimeout{}
);
```

The pattern mirrors Go's `ctx.Done()` for cancellation and `time.After()` for timeouts, but expressed as future combinators rather than channel selects. Neither approach is universally superior, Go's channel-based model scales better in highly concurrent code. Folly's value-based model composes better for complex pipelines.

---
