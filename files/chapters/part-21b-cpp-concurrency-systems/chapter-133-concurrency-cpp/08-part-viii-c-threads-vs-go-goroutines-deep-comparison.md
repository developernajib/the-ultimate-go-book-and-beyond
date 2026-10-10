## Part VIII: C++ Threads vs Go Goroutines - Deep Comparison

This is one of the most important sections for engineers choosing between these languages for concurrent systems.

### Cost of Creation

| Metric | C++ std::thread | Go goroutine |
|--------|----------------|--------------|
| Stack size (initial) | 1-8 MB (OS default) | 2-8 KB (growable) |
| Creation overhead | ~20-50 us (syscall) | ~0.3 us (runtime alloc) |
| Max practical count | Thousands | Millions |
| Scheduling | OS kernel | Go runtime (userspace) |
| Context switch cost | ~1-5 us (kernel) | ~0.1-0.2 us (userspace) |

### Benchmark: Spawning 100,000 Tasks

To quantify the operational differences between OS-level threads and runtime-scheduled goroutines, we compare dispatching 100,000 tasks across a fixed C++ thread pool versus spawning 100,000 native Go goroutines:
```cpp
// C++ - Thread pool approach (creating 100K OS threads would crash)
#include <iostream>
#include <chrono>
#include <vector>
#include <future>
#include <atomic>

// Using the ThreadPool class from Part VII
// ...

int main() {
    const int N = 100000;
    std::atomic<int> counter{0};
    
    auto start = std::chrono::high_resolution_clock::now();
    
    ThreadPool pool(std::thread::hardware_concurrency());
    std::vector<std::future<void>> futures;
    futures.reserve(N);
    
    for (int i = 0; i < N; ++i) {
        futures.push_back(pool.submit([&counter] {
            counter.fetch_add(1, std::memory_order_relaxed);
        }));
    }
    
    for (auto& f : futures) f.get();
    
    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    
    std::cout << "C++ ThreadPool: " << ms.count() << "ms for " 
              << N << " tasks. Counter: " << counter << "\n";
    
    return 0;
}
```

Equivalent Go:

```go
// Go - native goroutines
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

func main() {
    const N = 100000
    var counter int64
    var wg sync.WaitGroup

    start := time.Now()

    for i := 0; i < N; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            atomic.AddInt64(&counter, 1)
        }()
    }

    wg.Wait()

    elapsed := time.Since(start)
    fmt.Printf("Go goroutines: %v for %d tasks. Counter: %d\n",
        elapsed, N, counter)
}
```

**Typical results on a modern machine:**
- C++ with thread pool (8 threads): ~15-30ms
- Go goroutines: ~20-50ms
- C++ raw threads (100K): would crash or take 10+ seconds

For compute-bound tasks running on a thread pool, C++ and Go perform similarly. Go's advantage is convenience and the ability to have millions of concurrent tasks. C++'s advantage is deterministic scheduling and zero runtime overhead per task once the pool exists.

### Communication Patterns

Go channels are the primary coordination mechanism. C++ has no built-in equivalent - you build channels from mutexes and condition variables.

```cpp
// C++ channel equivalent (simplified)
template <typename T>
class Channel {
    std::queue<T> buffer_;
    std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    size_t capacity_;
    bool closed_ = false;

public:
    explicit Channel(size_t capacity = 0) : capacity_(capacity) {}
    
    bool send(T value) {
        std::unique_lock lock(mutex_);
        if (capacity_ > 0) {
            not_full_.wait(lock, [this] { 
                return buffer_.size() < capacity_ || closed_; 
            });
        }
        if (closed_) return false;
        buffer_.push(std::move(value));
        not_empty_.notify_one();
        return true;
    }
    
    std::pair<T, bool> receive() {
        std::unique_lock lock(mutex_);
        not_empty_.wait(lock, [this] { 
            return !buffer_.empty() || closed_; 
        });
        if (buffer_.empty() && closed_) {
            return {T{}, false};
        }
        T value = std::move(buffer_.front());
        buffer_.pop();
        if (capacity_ > 0) not_full_.notify_one();
        return {std::move(value), true};
    }
    
    void close() {
        std::unique_lock lock(mutex_);
        closed_ = true;
        not_empty_.notify_all();
        not_full_.notify_all();
    }
};
```

Equivalent Go:
```go
ch := make(chan int, 10)
ch <- 42       // send
val := <-ch    // receive
close(ch)      // close
```

The Go version is 3 lines. The C++ version is 50+ lines and has to be carefully audited for correctness. This is the fundamental tradeoff: Go's runtime provides safe concurrency primitives as first-class language features. C++ gives you the building blocks to construct exactly what you need, at the cost of significantly more code and more opportunities for bugs.

### When to Use Which

**Choose C++ threads when:**
- You need deterministic, low-latency scheduling (real-time systems, game engines)
- You need fine-grained control over thread affinity, priority, and stack size
- You are building a library that cannot depend on a runtime
- Cache behavior and memory layout are critical
- You need lock-free data structures with custom memory ordering

**Choose Go goroutines when:**
- You have many concurrent I/O operations (network servers, API gateways)
- You want rapid development with fewer concurrency bugs
- The number of concurrent tasks is large and dynamic (10K+ connections)
- You need built-in cancellation propagation (`context.Context`)
- Team productivity matters more than squeezing out the last microsecond

---

### Junior → FAANG: The Decision Flowchart

For a Go engineer deciding between C++ threads and Go goroutines for a new concurrent component: (1) does the component require deterministic sub-microsecond latency? If yes, C++ threads. (2) does it require millions of concurrent lightweight tasks? If yes, goroutines. (3) does it require NUMA awareness or CPU pinning? If yes, C++ threads. (4) otherwise, goroutines are simpler, safer, and fast enough.

This flowchart resolves 90% of the C++ threads vs. Go goroutines decision in practice.

### Senior @ FAANG: The Goroutine vs. Thread Choice as an Org-Level Architecture Decision

At the staff level, the choice between C++ threads and Go goroutines for a new system is an architecture decision with years-long implications. A staff engineer documents this decision with the flowchart reasoning, the measured performance requirements, and the revisit criteria. "We chose C++ threads because the p99 requirement is 200us and Go's GC pauses would violate it" is the right framing. "We chose C++ because C++ is faster" is not.

**Hybrid systems.** Many FAANG services use Go for the orchestration layer (request routing, configuration, health checking) and C++ threads for the hot-path computation. A staff engineer who designs the boundary between them owns the latency budget for the boundary overhead (CGo, gRPC, shared memory) and ensures it is accounted for in the overall p99 budget.

