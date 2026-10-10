## Part VI: std::async, std::future, std::promise - Task-Based Parallelism

Threads are about *how* work runs. Tasks are about *what* work produces. The `<future>` header provides a higher-level abstraction where you focus on results, not thread management.

### std::async - Fire and Forget (Almost)

`std::future` and `std::promise` provide a one-shot channel for returning a value or exception from an asynchronous operation to the calling thread. `std::async` wraps this mechanism with automatic thread management, making it easy to run a computation in the background and retrieve the result when needed.
```cpp
#include <iostream>
#include <future>
#include <chrono>
#include <cmath>
#include <vector>
#include <numeric>

// CPU-intensive computation
double compute_pi(int terms) {
    double sum = 0.0;
    for (int i = 0; i < terms; ++i) {
        double term = 1.0 / (2.0 * i + 1.0);
        sum += (i % 2 == 0) ? term : -term;
    }
    return 4.0 * sum;
}

int main() {
    auto start = std::chrono::high_resolution_clock::now();
    
    // Launch async task - may run on a new thread or deferred
    auto future1 = std::async(std::launch::async, compute_pi, 100000000);
    auto future2 = std::async(std::launch::async, compute_pi, 200000000);
    
    // Do other work while computations run in parallel...
    std::cout << "Computing in parallel...\n";
    
    // Block until results are ready
    double pi1 = future1.get();  // blocks until future1 completes
    double pi2 = future2.get();
    
    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    
    std::cout << "Pi (100M terms):  " << pi1 << "\n";
    std::cout << "Pi (200M terms):  " << pi2 << "\n";
    std::cout << "Total time: " << ms.count() << "ms\n";
    
    return 0;
}
```

Launch policies:
- `std::launch::async` - guaranteed to run on a new thread.
- `std::launch::deferred` - lazy evaluation. Runs when `.get()` is called on the calling thread.
- `std::launch::async | std::launch::deferred` (default) - implementation chooses. **Never rely on the default** - you cannot predict which policy will be used.

**Critical gotcha:** If you discard the returned `std::future`, the destructor blocks until the task completes. This means `std::async(std::launch::async, some_function);` without capturing the future runs **synchronously** because the temporary future's destructor blocks immediately.

```cpp
// LOOKS async but runs synchronously!
std::async(std::launch::async, slow_function);  // blocks here

// Correct: capture the future
auto f = std::async(std::launch::async, slow_function);
// ... do other work ...
f.get();  // blocks here instead
```

### std::promise and std::future - Manual Channel

A `promise`/`future` pair is a one-shot communication channel. The producer writes a value into the `promise`. The consumer reads it from the `future`.

```cpp
#include <iostream>
#include <thread>
#include <future>
#include <string>

void fetch_data(std::promise<std::string> promise) {
    try {
        // Simulate network request
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        
        // Success path: set the value
        promise.set_value("{ \"status\": \"ok\", \"data\": [1, 2, 3] }");
    }
    catch (...) {
        // Error path: propagate the exception to the consumer
        promise.set_exception(std::current_exception());
    }
}

int main() {
    std::promise<std::string> promise;
    std::future<std::string> future = promise.get_future();
    
    std::thread worker(fetch_data, std::move(promise));
    
    // Do other work while waiting...
    std::cout << "Waiting for data...\n";
    
    try {
        // Block until the promise is fulfilled
        std::string data = future.get();
        std::cout << "Received: " << data << "\n";
    }
    catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
    }
    
    worker.join();
    return 0;
}
```

### std::shared_future - Multiple Consumers

A regular `future` can only be `.get()`-ed once. A `shared_future` allows multiple threads to wait for and read the same result.

```cpp
#include <iostream>
#include <thread>
#include <future>
#include <vector>

int main() {
    auto future = std::async(std::launch::async, [] {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        return 42;
    });
    
    // Convert to shared_future so multiple threads can read it
    std::shared_future<int> shared = future.share();
    
    std::vector<std::thread> consumers;
    for (int i = 0; i < 5; ++i) {
        consumers.emplace_back([shared, i] {
            int result = shared.get();  // all 5 threads get 42
            std::cout << "Consumer " << i << " got: " << result << "\n";
        });
    }
    
    for (auto& t : consumers) t.join();
    
    return 0;
}
```

**Comparison with Go:** Go's channels are more flexible than `future`/`promise`. A Go channel can send multiple values over time. A `future` is a one-shot. Go's `select` can wait on multiple channels simultaneously. C++ has no native equivalent for multiple futures (you need `std::when_any` from the Concurrency TS or poll in a loop). However, `std::async` is simpler than spawning a goroutine and manually wiring up a channel for a single return value.

---

### Junior → FAANG: `std::async` as a Simple Parallel Task Launcher

For simple "run this function in parallel and get the result" use cases, `std::async(std::launch::async, fn, args...)` is the idiomatic C++ tool. It is the closest equivalent to Go's `go func()` + a channel for the result. The future returned by `std::async` blocks on destruction (if not yet ready), which prevents "fire and forget" bugs where exceptions from the async task are silently lost.

The Go `errgroup` pattern (run multiple goroutines, collect errors) maps to launching multiple `std::async` calls and calling `.get()` on each future. Exceptions thrown in the async task are rethrown by `.get()`.

### Senior @ FAANG: `std::async` Limitations and Folly Futures as the Production Alternative

At the staff level, `std::async` has significant limitations for production use: the implementation may or may not actually run the task asynchronously (implementation-defined unless `std::launch::async` is specified), there is no way to chain futures (`.then()` style), and there is no cancellation. For production async code at FAANG, Folly's `folly::Future` / `folly::SemiFuture` or Abseil's coroutines are the correct tools.

**Folly SemiFuture for safe async chains.** `folly::SemiFuture` decouples the future creation from the executor (thread pool) that runs it, enabling safe cancellation and composition. A staff engineer designs async APIs using `SemiFuture` rather than `std::future` for any chain longer than one step. The extra type safety (SemiFutures require explicit executor attachment before work begins) prevents accidental blocking on a thread that should not block.

