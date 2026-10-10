## 5. Coroutine Schedulers and Executors

C++20 provides the coroutine machinery but does not include a scheduler or event loop. You must provide your own (or use a library). Here is a simple single-threaded scheduler:

### Single-Threaded Event Loop

The `Scheduler` maintains a priority queue of coroutine handles sorted by resume time. The event loop pops handles whose resume time has passed and calls `handle.resume()` to continue execution from the last `co_await` point. This is the minimal infrastructure C++20 requires you to provide, production code uses library event loops (Asio, libevent) rather than building this manually.
```cpp
#include <coroutine>
#include <queue>
#include <chrono>
#include <functional>
#include <vector>
#include <iostream>

class Scheduler {
public:
    struct TimedTask {
        std::chrono::steady_clock::time_point resume_time;
        std::coroutine_handle<> handle;

        bool operator>(const TimedTask& other) const {
            return resume_time > other.resume_time;
        }
    };

    void schedule(std::coroutine_handle<> handle) {
        ready_queue_.push(handle);
    }

    void schedule_at(
        std::chrono::steady_clock::time_point when,
        std::coroutine_handle<> handle
    ) {
        timer_queue_.push(TimedTask{when, handle});
    }

    // Awaitable that yields to the scheduler
    auto suspend() {
        struct ScheduleAwaiter {
            Scheduler& scheduler;
            bool await_ready() const noexcept { return false; }
            void await_suspend(std::coroutine_handle<> h) {
                scheduler.schedule(h);  // Re-enqueue for later
            }
            void await_resume() const noexcept {}
        };
        return ScheduleAwaiter{*this};
    }

    // Run until all tasks complete
    void run() {
        while (!ready_queue_.empty() || !timer_queue_.empty()) {
            // Process all ready tasks
            while (!ready_queue_.empty()) {
                auto handle = ready_queue_.front();
                ready_queue_.pop();
                handle.resume();
            }

            // Check timers
            if (!timer_queue_.empty()) {
                auto now = std::chrono::steady_clock::now();
                while (!timer_queue_.empty() && 
                       timer_queue_.top().resume_time <= now) {
                    auto handle = timer_queue_.top().handle;
                    timer_queue_.pop();
                    handle.resume();
                }

                // If only timers remain, sleep until the next one
                if (ready_queue_.empty() && !timer_queue_.empty()) {
                    std::this_thread::sleep_until(
                        timer_queue_.top().resume_time
                    );
                }
            }
        }
    }

private:
    std::queue<std::coroutine_handle<>> ready_queue_;
    std::priority_queue<
        TimedTask, 
        std::vector<TimedTask>, 
        std::greater<TimedTask>
    > timer_queue_;
};

// Global scheduler instance (in production, use dependency injection)
Scheduler& get_scheduler() {
    static Scheduler instance;
    return instance;
}
```

### Multi-Threaded Work-Stealing Scheduler

For CPU-bound work, a thread pool with work stealing distributes coroutines across threads:

```cpp
#include <coroutine>
#include <thread>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <vector>
#include <atomic>
#include <random>
#include <functional>

class ThreadPoolScheduler {
public:
    explicit ThreadPoolScheduler(size_t num_threads)
        : running_(true) 
    {
        for (size_t i = 0; i < num_threads; ++i) {
            queues_.emplace_back();
            mutexes_.emplace_back(std::make_unique<std::mutex>());
        }

        for (size_t i = 0; i < num_threads; ++i) {
            threads_.emplace_back([this, i] { worker_loop(i); });
        }
    }

    ~ThreadPoolScheduler() {
        running_ = false;
        cv_.notify_all();
        for (auto& t : threads_) {
            if (t.joinable()) t.join();
        }
    }

    void schedule(std::coroutine_handle<> handle) {
        auto idx = next_queue_.fetch_add(1) % queues_.size();
        {
            std::lock_guard lock(*mutexes_[idx]);
            queues_[idx].push_back(handle);
        }
        cv_.notify_one();
    }

    // Awaitable to transfer to the thread pool
    auto schedule_on() {
        struct Awaiter {
            ThreadPoolScheduler& pool;
            bool await_ready() const noexcept { return false; }
            void await_suspend(std::coroutine_handle<> h) {
                pool.schedule(h);
            }
            void await_resume() const noexcept {}
        };
        return Awaiter{*this};
    }

private:
    void worker_loop(size_t my_index) {
        while (running_) {
            std::coroutine_handle<> task = try_pop(my_index);
            
            if (!task) {
                // Try to steal from another queue
                task = try_steal(my_index);
            }

            if (task) {
                task.resume();
            } else {
                std::unique_lock lock(*mutexes_[my_index]);
                cv_.wait_for(lock, std::chrono::milliseconds(1));
            }
        }
    }

    std::coroutine_handle<> try_pop(size_t index) {
        std::lock_guard lock(*mutexes_[index]);
        if (queues_[index].empty()) return nullptr;
        auto handle = queues_[index].front();
        queues_[index].pop_front();
        return handle;
    }

    std::coroutine_handle<> try_steal(size_t my_index) {
        for (size_t i = 0; i < queues_.size(); ++i) {
            if (i == my_index) continue;
            std::lock_guard lock(*mutexes_[i]);
            if (!queues_[i].empty()) {
                auto handle = queues_[i].back();  // Steal from back
                queues_[i].pop_back();
                return handle;
            }
        }
        return nullptr;
    }

    std::vector<std::deque<std::coroutine_handle<>>> queues_;
    std::vector<std::unique_ptr<std::mutex>> mutexes_;
    std::vector<std::thread> threads_;
    std::condition_variable cv_;
    std::atomic<bool> running_;
    std::atomic<size_t> next_queue_{0};
};
```

### Junior → FAANG: Schedulers as the Missing Piece of C++ Coroutines

The most confusing aspect of C++ coroutines for Go engineers: there is no built-in scheduler. `go func()` automatically schedules the goroutine on the runtime's thread pool. `co_await something()` suspends the coroutine, but who resumes it and on which thread depends entirely on the awaitable's implementation.

In practice: you pick an executor (Folly's `IOThreadPoolExecutor`, ASIO's io_context, a custom work-stealing pool) and all your async awaitables are designed to resume on that executor. The executor is the scheduler.

First-job approach: use an existing executor from your framework. If your service uses Folly, use Folly's executors. If it uses Boost.ASIO, use ASIO's io_context. Do not write a custom executor unless you have a specific requirement that existing executors cannot meet.

### Senior @ FAANG: Executor Design and Coroutine Affinity

At L5+, the executor design determines the performance characteristics of your coroutine system. The key parameters: number of executor threads, whether tasks are pinned to threads (for cache affinity) or can be stolen (for load balancing), and whether the executor supports prioritization.

Work-stealing executors (like Folly's `CPUThreadPoolExecutor`) give good load balancing but break CPU cache affinity. If a coroutine builds up local working set in L1/L2 cache, stealing it to another CPU flushes that cache. For compute-heavy coroutines, pinning to a specific executor thread may give better throughput.

The coroutine affinity pattern: use `co_await executor.schedule_on(preferred_thread)` to migrate a coroutine to a specific thread for a cache-hot section, then `co_await executor.yield()` to return it to the pool. Folly Coro supports this pattern explicitly.

Executor sizing at production scale: the optimal thread count for a coroutine executor depends on the ratio of compute-bound to I/O-bound work. For I/O-bound work, use one thread per CPU and rely on io_uring/epoll to keep all threads busy. For mixed workloads, profile the CPU utilization and adjust. The wrong thread count (too many for CPU-bound, too few for I/O-bound) shows up as either CPU contention or idle threads.

Bar-raiser signal: in a design review of a coroutine-based service, ask "how does this executor handle backpressure?" If tasks arrive faster than the executor processes them, the queue grows unboundedly. The correct answer includes: a bounded task queue with a rejection policy (error return, backpressure signal, or caller suspension), and monitoring of the queue depth as an SLO-relevant metric.

---
