## Part V: Condition Variables - Coordinating Threads

Mutexes prevent concurrent access. Condition variables enable threads to **wait** for a specific condition to become true, efficiently - without spinning in a loop burning CPU cycles.

### The Producer-Consumer Pattern

The producer-consumer pattern decouples tasks producing data from workers processing it. The implementation below demonstrates a canonical thread-safe bounded queue using mutexes and condition variables:
```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <vector>

template <typename T>
class ThreadSafeQueue {
    std::queue<T> queue_;
    mutable std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    size_t max_size_;

public:
    explicit ThreadSafeQueue(size_t max_size = 100) 
        : max_size_(max_size) {}

    void push(T value) {
        std::unique_lock lock(mutex_);
        // Wait until there is room in the queue
        not_full_.wait(lock, [this] { 
            return queue_.size() < max_size_; 
        });
        queue_.push(std::move(value));
        not_empty_.notify_one();
    }

    T pop() {
        std::unique_lock lock(mutex_);
        // Wait until there is an item in the queue
        not_empty_.wait(lock, [this] { 
            return !queue_.empty(); 
        });
        T value = std::move(queue_.front());
        queue_.pop();
        not_full_.notify_one();
        return value;
    }
    
    bool empty() const {
        std::lock_guard lock(mutex_);
        return queue_.empty();
    }
};

int main() {
    ThreadSafeQueue<int> queue(10);
    bool done = false;
    
    // Producer
    std::thread producer([&] {
        for (int i = 0; i < 50; ++i) {
            queue.push(i);
            std::cout << "Produced: " << i << "\n";
        }
        done = true;
    });
    
    // Consumer
    std::thread consumer([&] {
        while (!done || !queue.empty()) {
            // In production, use try_pop with timeout
            // to avoid race between done check and empty check
            int val = queue.pop();
            std::cout << "Consumed: " << val << "\n";
        }
    });
    
    producer.join();
    consumer.join();
    
    return 0;
}
```

### Understanding Spurious Wakeups

A condition variable `wait()` can return even when no thread called `notify_one()` or `notify_all()`. This is called a **spurious wakeup**. It happens because of how operating system schedulers and signal handling interact with futexes. The predicate-based overload of `wait()` handles this automatically:

```cpp
// BAD - vulnerable to spurious wakeups
cv.wait(lock);
if (queue_.empty()) {
    // Oops, woke up but nothing is there
}

// GOOD - predicate is re-checked after every wakeup
cv.wait(lock, [this] { return !queue_.empty(); });
// Guaranteed: queue_ is not empty when wait() returns
```

The predicate-based `wait()` is equivalent to:
```cpp
while (!predicate()) {
    cv.wait(lock);
}
```

**Always use the predicate overload.** There is no valid reason to use the bare `wait()` in production code.

### Notify One vs Notify All

- `notify_one()` wakes exactly one waiting thread. Use when only one thread can make progress (e.g., one item added to a queue).
- `notify_all()` wakes all waiting threads. Use when the condition change could allow multiple threads to proceed, or when you need to broadcast a state change (e.g., shutdown signal).

```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <vector>

std::mutex mtx;
std::condition_variable cv;
bool shutdown = false;

void worker(int id) {
    std::unique_lock lock(mtx);
    cv.wait(lock, [] { return shutdown; });
    std::cout << "Worker " << id << " shutting down.\n";
}

int main() {
    std::vector<std::thread> workers;
    for (int i = 0; i < 5; ++i) {
        workers.emplace_back(worker, i);
    }
    
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    
    {
        std::lock_guard lock(mtx);
        shutdown = true;
    }
    cv.notify_all();  // Wake ALL workers for shutdown
    
    for (auto& w : workers) w.join();
    std::cout << "All workers shut down.\n";
    
    return 0;
}
```

**Comparison with Go:** Go's channels subsume the role of both mutexes and condition variables. A Go channel `ch <- value` is equivalent to pushing to a thread-safe queue with a condition variable. Go's `close(ch)` is equivalent to `notify_all()` with a shutdown flag. The channel abstraction eliminates an entire class of bugs (forgetting to hold the lock when checking the condition, forgetting to notify, spurious wakeup mishandling).

---

### Junior → FAANG: The Four Rules for Condition Variables

Condition variables have four mandatory usage rules that eliminate the most common bugs: (1) always check the condition in a `while` loop (not an `if`), to handle spurious wakeups. (2) always hold the mutex when checking the condition (always use the `wait(lock, predicate)` form). (3) always hold the mutex when calling `notify_one()` or `notify_all()` (technically not required by the standard but prevents a lost-wakeup race). (4) make the condition check idempotent (the predicate must be safe to call multiple times).

The `wait(lock, predicate)` form (with a predicate lambda) combines rules 1 and 2 into a single call that is correct by construction. Prefer this over `wait(lock)` with a manual while loop.

### Senior @ FAANG: Condition Variable Performance and Alternatives

At the staff level, condition variables have overhead: each notify involves a system call, and each wait involves acquiring and releasing the mutex around the check. For high-throughput producer-consumer scenarios (millions of tasks per second), this overhead is measurable.

**Semaphores as a lighter-weight alternative.** C++20 added `std::counting_semaphore` and `std::binary_semaphore`. A semaphore is lighter than a condition variable: `release()` does not acquire a mutex, making it faster for simple producer-consumer signaling. A staff engineer benchmarks the semaphore against condition variable for each specific use case before committing to one.

**Futex-based wait.** On Linux, the most efficient inter-thread signaling uses futexes (fast user-space mutexes) via `std::atomic::wait()` (C++20). An atomic variable is set by the producer. The consumer calls `atomic.wait(old_value)` which blocks until the value changes. This is the same mechanism used internally by `std::mutex` and `std::condition_variable`, but without the additional mutex acquisition overhead. A staff engineer uses this pattern for high-frequency signaling in performance-critical paths.

