## Interview Questions

### Conceptual Questions

**Q1: What is the difference between a `std::mutex` and a `std::recursive_mutex`? When would you use a recursive mutex?**

A regular `mutex` will deadlock if the same thread tries to lock it twice. A `recursive_mutex` allows the same thread to lock it multiple times - it maintains an internal lock count and only truly unlocks when the count reaches zero. You would use a recursive mutex when a function that holds a lock calls another function that also needs the same lock (e.g., recursive tree traversal). However, needing a recursive mutex is often a design smell - it usually means your locking strategy should be restructured so that internal functions assume the caller holds the lock.

**Q2: Explain the difference between `std::launch::async` and `std::launch::deferred`. What happens with the default policy?**

`std::launch::async` guarantees the task runs on a new thread. `std::launch::deferred` delays execution until `.get()` or `.wait()` is called, and runs on the calling thread. The default policy is `async | deferred`, which lets the implementation choose - and you cannot predict which. This is dangerous because deferred execution means the task might never run if you never call `.get()`. Always explicitly specify the policy.

**Q3: What is a spurious wakeup and how do you protect against it?**

A spurious wakeup occurs when `condition_variable::wait()` returns even though no thread called `notify_one()` or `notify_all()`. This happens due to OS-level signal handling and scheduler behavior. The protection is to always use the predicate overload of `wait()`, which re-checks the condition after every wakeup: `cv.wait(lock, []{ return condition. })`. This is equivalent to `while (!condition) cv.wait(lock)`.

**Q4: What is false sharing and how do you prevent it?**

False sharing occurs when different threads modify variables on the same CPU cache line (typically 64 bytes). The cache coherence protocol forces the line to bounce between cores, creating a performance bottleneck despite no logical data sharing. Prevent it by aligning frequently-modified per-thread data to cache line boundaries using `alignas(64)` or `std::hardware_destructive_interference_size` (C++17).

**Q5: Compare C++ `std::thread` with Go goroutines. What are the fundamental architectural differences?**

C++ threads are OS threads: heavyweight (~1MB stack), kernel-scheduled, expensive to create (~50us). Go goroutines are userspace-scheduled green threads: lightweight (~2KB initial stack, growable), managed by the Go runtime scheduler, cheap to create (~0.3us). Go multiplexes millions of goroutines onto a few OS threads using M:N scheduling. C++ maps one `std::thread` to one OS thread (1:1). Go's model excels at I/O concurrency with many tasks. C++ gives deterministic scheduling and zero runtime overhead.

### Coding Questions

**Q6: Implement a thread-safe singleton using `std::call_once`.**

```cpp
#include <mutex>
#include <memory>

class Database {
    static std::unique_ptr<Database> instance_;
    static std::once_flag init_flag_;
    
    Database() { /* expensive initialization */ }
    
public:
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;
    
    static Database& instance() {
        std::call_once(init_flag_, [] {
            instance_.reset(new Database());
        });
        return *instance_;
    }
    
    void query(const std::string& sql) { /* ... */ }
};

std::unique_ptr<Database> Database::instance_;
std::once_flag Database::init_flag_;
```

`std::call_once` guarantees that the lambda runs exactly once, even if multiple threads call `instance()` simultaneously. It uses an efficient internal mechanism (typically a futex) that is faster than a mutex after the first call.

**Q7: Write a function that executes N tasks with a timeout. If the timeout expires, cancel remaining tasks.**

```cpp
#include <future>
#include <vector>
#include <chrono>
#include <iostream>
#include <atomic>
#include <optional>

template <typename F>
std::vector<std::optional<std::invoke_result_t<F>>>
execute_with_timeout(
    std::vector<F>& tasks,
    std::chrono::milliseconds timeout) 
{
    using result_t = std::invoke_result_t<F>;
    std::atomic<bool> canceled{false};
    
    std::vector<std::future<result_t>> futures;
    for (auto& task : tasks) {
        futures.push_back(std::async(std::launch::async, [&task, &canceled] {
            if (canceled.load()) throw std::runtime_error("canceled");
            return task();
        }));
    }
    
    auto deadline = std::chrono::steady_clock::now() + timeout;
    std::vector<std::optional<result_t>> results(tasks.size());
    
    for (size_t i = 0; i < futures.size(); ++i) {
        auto remaining = deadline - std::chrono::steady_clock::now();
        if (remaining <= std::chrono::milliseconds(0)) {
            canceled.store(true);
            break;
        }
        
        auto status = futures[i].wait_for(remaining);
        if (status == std::future_status::ready) {
            try {
                results[i] = futures[i].get();
            } catch (...) {
                // Task threw or was canceled
            }
        } else {
            canceled.store(true);
            break;
        }
    }
    
    return results;
}
```

**Q8: What is wrong with this code? (FAANG interview classic)**

```cpp
std::string& get_greeting() {
    std::string greeting = "hello";
    std::thread t([&greeting] {
        greeting += " world";
    });
    t.detach();
    return greeting;  // BUG: returns reference to local
}
```

**Multiple bugs:** (1) Returns a reference to a local variable - undefined behavior as soon as the function returns. (2) The detached thread captures `greeting` by reference, but `greeting` is destroyed when the function returns - the thread accesses a dangling reference. (3) Even if the lifetime were correct, both the thread and the returning function access `greeting` without synchronization - data race (undefined behavior). Fix: use `std::jthread` with join, pass data by value or shared_ptr, and return by value.

**Q9: Design a rate limiter using `std::condition_variable`.**

```cpp
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <queue>

class RateLimiter {
    std::mutex mutex_;
    std::condition_variable cv_;
    std::queue<std::chrono::steady_clock::time_point> timestamps_;
    int max_requests_;
    std::chrono::milliseconds window_;

public:
    RateLimiter(int max_requests, std::chrono::milliseconds window)
        : max_requests_(max_requests), window_(window) {}

    void acquire() {
        std::unique_lock lock(mutex_);
        auto now = std::chrono::steady_clock::now();
        
        // Remove expired timestamps
        while (!timestamps_.empty() && 
               (now - timestamps_.front()) > window_) {
            timestamps_.pop();
        }
        
        if (static_cast<int>(timestamps_.size()) >= max_requests_) {
            // Wait until the oldest request expires
            auto wait_until = timestamps_.front() + window_;
            cv_.wait_until(lock, wait_until);
            
            // Re-clean after waking
            now = std::chrono::steady_clock::now();
            while (!timestamps_.empty() && 
                   (now - timestamps_.front()) > window_) {
                timestamps_.pop();
            }
        }
        
        timestamps_.push(std::chrono::steady_clock::now());
    }
};
```

**Q10: How would you debug a deadlock in a production C++ application?**

1. **Detect:** Monitor thread states. If all worker threads are in `WAITING` state for extended periods, suspect deadlock.
2. **Diagnose:** Attach GDB (`gdb -p <pid>`), then `thread apply all bt` to get backtraces for all threads. Look for threads blocked on `pthread_mutex_lock` and trace which mutexes they hold.
3. **Core dump analysis:** If the process is hung, send `SIGABRT` to generate a core dump, then analyze offline.
4. **Lock ordering audit:** Review the code paths shown in backtraces. Identify where two threads acquire the same set of mutexes in different orders.
5. **Prevention:** Use `std::scoped_lock` for multi-mutex acquisition. Implement a lock hierarchy validator in debug builds that asserts the ordering is always consistent.
6. **Tooling:** Use `-fsanitize=thread` in testing environments. Use Valgrind Helgrind or DRD for deadlock detection.

---

### Junior → FAANG: Concurrency Interview Preparation Protocol

For C++ concurrency interviews at FAANG, practice implementing the following from scratch under time pressure: (1) a thread-safe FIFO queue with a mutex and condition variable, (2) a reader-writer lock with preferential reader or writer, (3) a simple thread pool with a fixed number of workers. These three implementations cover the conceptual questions in this section and serve as building blocks for system design questions.

### Senior @ FAANG: Bar-Raiser Concurrency Questions at L6

At the L6 bar-raiser level, concurrency questions test architectural judgment. The expected follow-up to "implement a thread pool" is: "how would you size the pool for a service that handles both CPU-bound compression and I/O-bound database queries?" The expected answer: separate pools for CPU-bound and I/O-bound work, sized independently (hardware_concurrency for CPU, 2-4x for I/O), with priority policies that prevent I/O-bound tasks from starving CPU-bound tasks. This answer demonstrates understanding of queuing theory and workload characteristics.

