## 6. Folly::coro, Meta's Coroutine Library

Facebook/Meta's Folly library provides a production-grade coroutine framework that fills the gaps left by the C++20 standard. It is battle-tested across Meta's infrastructure serving billions of requests.

### Key Components

`folly::coro::Task<T>` is the production return type for async coroutines at Meta, analogous to C++20's coroutine machinery but with a scheduler (`folly::Executor`), structured concurrency (`AsyncScope`), and utilities like `collectAll` built in. `blockingWait` bridges coroutine and non-coroutine code by running the task on the caller's thread and blocking until completion, similar to Go's synchronous channel receive.
```cpp
#include <folly/experimental/coro/Task.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/experimental/coro/Collect.h>
#include <folly/experimental/coro/Generator.h>
#include <folly/experimental/coro/AsyncScope.h>
#include <folly/executors/CPUThreadPoolExecutor.h>

// folly::coro::Task - the standard async return type
folly::coro::Task<int> fetch_from_db(int id) {
    auto result = co_await db_client.query(id);
    co_return result.value();
}

// Structured concurrency: run tasks in parallel
folly::coro::Task<std::pair<int, std::string>> fetch_user_data(int user_id) {
    // collectAll runs both tasks concurrently
    auto [age, name] = co_await folly::coro::collectAll(
        fetch_age(user_id),
        fetch_name(user_id)
    );
    co_return {age.value(), name.value()};
}

// Generator for lazy sequences
folly::coro::Generator<int> range(int start, int end) {
    for (int i = start; i < end; ++i) {
        co_yield i;
    }
}

// AsyncGenerator for async lazy sequences
folly::coro::AsyncGenerator<std::string> stream_events() {
    while (auto event = co_await event_source.next()) {
        co_yield event->serialize();
    }
}

// Running coroutines from synchronous code
int main() {
    folly::CPUThreadPoolExecutor executor(4);
    
    // blockingWait bridges sync and async worlds
    auto result = folly::coro::blockingWait(
        fetch_user_data(42).scheduleOn(&executor)
    );
    
    std::cout << result.first << ", " << result.second << "\n";
}
```

### folly::coro Features Summary

| Feature | Description |
|---|---|
| `Task<T>` | Lazy async task, the primary coroutine type |
| `Generator<T>` | Synchronous lazy generator |
| `AsyncGenerator<T>` | Async lazy generator (can await internally) |
| `collectAll()` | Run multiple tasks concurrently, wait for all |
| `collectAny()` | Run multiple tasks, return first to complete |
| `blockingWait()` | Bridge from sync to async code |
| `AsyncScope` | Structured concurrency, spawn and join tasks |
| `scheduleOn(executor)` | Bind a task to a specific executor/thread pool |
| `co_withCancellation` | Cooperative cancellation support |
| `Timeout` | co_await with deadline, throws on timeout |
| `Retry` | Retry logic with exponential backoff |

### Cancellation in folly::coro

`folly::coro::co_current_cancellation_token` injects the current `CancellationToken` into the coroutine. The task polls `token.isCancellationRequested()` at each iteration boundary, giving clean cooperative cancellation similar to Go's `ctx.Done()` channel pattern. The `CancellationSource` on the caller side triggers cancellation, and `co_withCancellation` wraps an existing task with a new cancellation scope.
```cpp
folly::coro::Task<void> long_running_task() {
    auto token = co_await folly::coro::co_current_cancellation_token;
    
    while (!token.isCancellationRequested()) {
        auto batch = co_await fetch_next_batch();
        process(batch);
    }
    // Clean up resources before returning
    co_return;
}

// Caller can cancel
folly::coro::Task<void> caller() {
    folly::CancellationSource source;
    auto task = long_running_task()
        .scheduleOn(&executor)
        .start();
    
    // Cancel after timeout
    co_await folly::coro::sleep(std::chrono::seconds(30));
    source.requestCancellation();
}
```

---
