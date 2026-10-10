## Part VII: Thread Pools with Work Stealing

Creating a thread per task is expensive. Each OS thread costs ~1MB of stack space and thousands of CPU cycles to create. A thread pool maintains a fixed number of worker threads and distributes tasks among them.

### A Production-Grade Thread Pool

A thread pool amortizes the cost of thread creation by maintaining a fixed set of worker threads that pick up tasks from a shared queue. This pattern bounds resource consumption and prevents the overhead of spawning a new OS thread for each unit of work.
```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <queue>
#include <vector>
#include <future>
#include <atomic>
#include <stdexcept>

class ThreadPool {
public:
    explicit ThreadPool(size_t num_threads = std::thread::hardware_concurrency()) 
        : stop_(false) 
    {
        if (num_threads == 0) num_threads = 1;
        
        for (size_t i = 0; i < num_threads; ++i) {
            workers_.emplace_back([this] { worker_loop(); });
        }
    }
    
    ~ThreadPool() {
        {
            std::unique_lock lock(mutex_);
            stop_ = true;
        }
        cv_.notify_all();
        for (auto& worker : workers_) {
            worker.join();
        }
    }
    
    // Submit a task and get a future for the result
    template <typename F, typename... Args>
    auto submit(F&& func, Args&&... args) 
        -> std::future<std::invoke_result_t<F, Args...>> 
    {
        using return_type = std::invoke_result_t<F, Args...>;
        
        auto task = std::make_shared<std::packaged_task<return_type()>>(
            std::bind(std::forward<F>(func), std::forward<Args>(args)...)
        );
        
        std::future<return_type> future = task->get_future();
        
        {
            std::unique_lock lock(mutex_);
            if (stop_) {
                throw std::runtime_error("submit() called on stopped ThreadPool");
            }
            tasks_.emplace([task] { (*task)(); });
        }
        cv_.notify_one();
        
        return future;
    }
    
    size_t queue_size() const {
        std::unique_lock lock(mutex_);
        return tasks_.size();
    }

private:
    void worker_loop() {
        while (true) {
            std::function<void()> task;
            {
                std::unique_lock lock(mutex_);
                cv_.wait(lock, [this] { 
                    return stop_ || !tasks_.empty(); 
                });
                
                if (stop_ && tasks_.empty()) return;
                
                task = std::move(tasks_.front());
                tasks_.pop();
            }
            task();
        }
    }

    std::vector<std::thread> workers_;
    std::queue<std::function<void()>> tasks_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool stop_;
};

int main() {
    ThreadPool pool(4);
    
    // Submit diverse tasks
    std::vector<std::future<int>> results;
    
    for (int i = 0; i < 20; ++i) {
        results.push_back(pool.submit([i] {
            // Simulate variable-length work
            std::this_thread::sleep_for(
                std::chrono::milliseconds(10 + (i % 5) * 20)
            );
            return i * i;
        }));
    }
    
    // Collect results
    for (int i = 0; i < 20; ++i) {
        std::cout << "Task " << i << " result: " 
                  << results[i].get() << "\n";
    }
    
    return 0;
}
```

### Work-Stealing Thread Pool

The basic thread pool above uses a single shared queue - a contention bottleneck under high load. A work-stealing pool gives each worker its own queue. When a worker's queue is empty, it steals tasks from other workers' queues.

```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <deque>
#include <vector>
#include <future>
#include <atomic>
#include <random>

class WorkStealingQueue {
    std::deque<std::function<void()>> deque_;
    mutable std::mutex mutex_;

public:
    void push(std::function<void()> task) {
        std::lock_guard lock(mutex_);
        deque_.push_back(std::move(task));
    }
    
    // Pop from the back (LIFO for cache locality)
    bool try_pop(std::function<void()>& task) {
        std::lock_guard lock(mutex_);
        if (deque_.empty()) return false;
        task = std::move(deque_.back());
        deque_.pop_back();
        return true;
    }
    
    // Steal from the front (FIFO - oldest tasks first)
    bool try_steal(std::function<void()>& task) {
        std::lock_guard lock(mutex_);
        if (deque_.empty()) return false;
        task = std::move(deque_.front());
        deque_.pop_front();
        return true;
    }
    
    bool empty() const {
        std::lock_guard lock(mutex_);
        return deque_.empty();
    }
};

class WorkStealingPool {
public:
    explicit WorkStealingPool(size_t num_threads = std::thread::hardware_concurrency())
        : stop_(false), queues_(num_threads) 
    {
        if (num_threads == 0) num_threads = 1;
        queues_.resize(num_threads);
        
        for (size_t i = 0; i < num_threads; ++i) {
            workers_.emplace_back([this, i] { worker_loop(i); });
        }
    }
    
    ~WorkStealingPool() {
        stop_.store(true, std::memory_order_release);
        cv_.notify_all();
        for (auto& w : workers_) w.join();
    }
    
    template <typename F>
    auto submit(F&& func) -> std::future<decltype(func())> {
        using return_type = decltype(func());
        auto task = std::make_shared<std::packaged_task<return_type()>>(
            std::forward<F>(func)
        );
        auto future = task->get_future();
        
        // Round-robin assignment to worker queues
        size_t idx = next_queue_.fetch_add(1) % queues_.size();
        queues_[idx].push([task] { (*task)(); });
        cv_.notify_one();
        
        return future;
    }

private:
    void worker_loop(size_t my_index) {
        while (!stop_.load(std::memory_order_acquire)) {
            std::function<void()> task;
            
            // 1. Try own queue first
            if (queues_[my_index].try_pop(task)) {
                task();
                continue;
            }
            
            // 2. Try stealing from other queues
            bool stolen = false;
            for (size_t i = 0; i < queues_.size(); ++i) {
                size_t victim = (my_index + i + 1) % queues_.size();
                if (queues_[victim].try_steal(task)) {
                    task();
                    stolen = true;
                    break;
                }
            }
            if (stolen) continue;
            
            // 3. Sleep briefly to avoid busy-waiting
            std::unique_lock lock(wait_mutex_);
            cv_.wait_for(lock, std::chrono::microseconds(100));
        }
    }

    std::vector<std::thread> workers_;
    std::vector<WorkStealingQueue> queues_;
    std::atomic<bool> stop_;
    std::atomic<size_t> next_queue_{0};
    std::mutex wait_mutex_;
    std::condition_variable cv_;
};

int main() {
    WorkStealingPool pool(4);
    
    std::vector<std::future<long long>> results;
    for (int i = 0; i < 100; ++i) {
        results.push_back(pool.submit([i]() -> long long {
            long long sum = 0;
            for (long long j = 0; j < 100000; ++j) {
                sum += j * (i + 1);
            }
            return sum;
        }));
    }
    
    long long total = 0;
    for (auto& f : results) {
        total += f.get();
    }
    std::cout << "Total: " << total << "\n";
    
    return 0;
}
```

**Comparison with Go:** Go's runtime scheduler is essentially a sophisticated work-stealing thread pool built into the language. The `GOMAXPROCS` goroutines map onto OS threads (called M in Go's runtime), and each M has a local run queue that other Ms can steal from. The key difference: Go multiplexes potentially millions of goroutines onto a small number of OS threads, while C++ thread pools map one task to one thread execution slot. Go's approach has lower overhead per task (~2KB goroutine stack vs ~8MB OS thread stack default) but less control over scheduling priorities.

---

### Junior → FAANG: Thread Pool as the Default Unit of Work Execution

For Go engineers, goroutines are free to create (2KB stack, M:N scheduling). C++ threads are expensive (8MB stack by default, 1:1 with OS threads). The consequence: never spawn a thread per task in C++. Always use a thread pool. The thread pool is the C++ equivalent of the Go runtime scheduler: a fixed number of worker threads that execute tasks from a shared queue.

The minimum viable thread pool: a fixed number of threads, a thread-safe task queue, and proper shutdown. For production, use an existing implementation (Abseil's `ThreadPool`, `folly::CPUThreadPoolExecutor`, Intel TBB's `task_group`) rather than writing your own.

### Senior @ FAANG: Thread Pool Sizing, Monitoring, and Work-Stealing Trade-offs

At the staff level, thread pool sizing is not set-and-forget. The optimal pool size depends on the workload (CPU-bound: hardware_concurrency, I/O-bound: 2x to 4x hardware_concurrency) and changes under production load. A staff engineer adds thread pool metrics to the service's observability: queue depth (backpressure indicator), worker utilization (overload indicator), and task latency distribution (SLO indicator).

**Work-stealing trade-offs.** Work stealing (dequeue a task from another worker's queue when your own is empty) reduces average idle time but adds contention on the victim's queue. For short tasks (microseconds), the contention overhead of stealing may exceed the benefit. For long tasks (milliseconds), stealing is clearly beneficial. A staff engineer profiles the work-stealing thread pool with the actual task duration distribution before committing to it over a simpler shared-queue design.

