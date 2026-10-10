## Part I: std::thread - The Foundation

### Creating and Joining Threads

`std::thread` is the fundamental unit of concurrency in C++. It maps directly to an operating system thread - a heavyweight entity with its own stack, registers, and kernel scheduling context.

```cpp
#include <iostream>
#include <thread>
#include <string>

void greet(const std::string& name) {
    std::cout << "Hello from thread, " << name << "!\n";
}

int main() {
    // Create a thread that executes greet("Alice")
    std::thread t1(greet, "Alice");
    
    // The main thread continues executing here concurrently
    std::cout << "Hello from main thread!\n";
    
    // MUST join or detach before t1 is destroyed
    // join() blocks until the thread completes
    t1.join();
    
    return 0;
}
```

The constructor of `std::thread` takes a callable (function pointer, lambda, functor) and its arguments. The thread begins executing immediately upon construction - there is no `start()` method.

**Critical rule:** Every `std::thread` must be either joined or detached before it is destroyed. If the destructor runs on a joinable thread, `std::terminate()` is called. Your program crashes. No cleanup. No destructors. No logs.

```cpp
#include <iostream>
#include <thread>
#include <vector>

void compute(int id, int iterations) {
    int sum = 0;
    for (int i = 0; i < iterations; ++i) {
        sum += i;
    }
    std::cout << "Thread " << id << " computed sum: " << sum << "\n";
}

int main() {
    const int num_threads = 4;
    std::vector<std::thread> threads;
    
    // Launch threads
    for (int i = 0; i < num_threads; ++i) {
        threads.emplace_back(compute, i, 1000000);
    }
    
    // Join all threads
    for (auto& t : threads) {
        t.join();
    }
    
    std::cout << "All threads completed.\n";
    return 0;
}
```

### Passing Arguments: Copies, References, and Moves

By default, arguments passed to `std::thread` are **copied** into the thread's internal storage, even if the function signature takes a reference. This is a safety mechanism - it prevents dangling references if the calling thread's local variables go out of scope.

```cpp
#include <iostream>
#include <thread>
#include <string>
#include <functional>  // for std::ref

void modify_value(int& val) {
    val = 42;
}

void process_string(const std::string& s) {
    std::cout << "Processing: " << s << "\n";
}

int main() {
    int x = 0;
    
    // ERROR at compile time: std::thread copies arguments,
    // but modify_value expects a non-const reference.
    // std::thread t1(modify_value, x);  // won't compile
    
    // Use std::ref to pass a genuine reference
    std::thread t1(modify_value, std::ref(x));
    t1.join();
    std::cout << "x after thread: " << x << "\n";  // prints 42
    
    // String literals are converted to std::string via copy
    std::thread t2(process_string, "hello world");
    t2.join();
    
    // Move semantics for non-copyable types
    auto data = std::make_unique<int>(100);
    std::thread t3([](std::unique_ptr<int> ptr) {
        std::cout << "Received: " << *ptr << "\n";
    }, std::move(data));
    t3.join();
    // data is now nullptr - ownership transferred to thread
    
    return 0;
}
```

**Warning about `std::ref`:** When you pass a reference with `std::ref`, you are responsible for ensuring the referenced object outlives the thread. If the calling function returns before the thread reads the reference, you get undefined behavior - and it will work fine in testing, then crash in production under load.

### Detaching Threads

Detaching a thread lets it run independently. The detached thread continues executing even after the `std::thread` object is destroyed. You lose all ability to join it or check if it completed.

```cpp
#include <iostream>
#include <thread>
#include <chrono>

void background_task() {
    // Simulates long-running background work
    std::this_thread::sleep_for(std::chrono::seconds(2));
    std::cout << "Background task completed.\n";
}

int main() {
    std::thread t(background_task);
    t.detach();  // Thread runs independently
    
    // t is no longer joinable
    std::cout << "t.joinable(): " << t.joinable() << "\n";  // prints 0
    
    // WARNING: If main() returns before the background task finishes,
    // the program exits and the detached thread is killed mid-execution.
    // In production, you need a proper shutdown mechanism.
    std::this_thread::sleep_for(std::chrono::seconds(3));
    
    return 0;
}
```

**In practice, avoid `detach()`.** It creates threads you cannot control, cannot wait for, and cannot shut down cleanly. Every serious codebase uses join-based lifetime management or a thread pool instead.

### Thread Identity and Hardware Concurrency

`std::this_thread::get_id()` returns the current thread's unique identifier, useful for logging and debugging. `std::thread::hardware_concurrency()` returns a hint for the number of concurrent threads the hardware supports (typically the number of logical CPU cores), which is the conventional upper bound for a thread pool's worker count to avoid context-switch overhead.
```cpp
#include <iostream>
#include <thread>

void show_id() {
    std::cout << "Thread ID: " << std::this_thread::get_id() << "\n";
}

int main() {
    std::cout << "Main thread ID: " << std::this_thread::get_id() << "\n";
    std::cout << "Hardware concurrency: " 
              << std::thread::hardware_concurrency() << "\n";
    
    std::thread t(show_id);
    std::cout << "Spawned thread ID: " << t.get_id() << "\n";
    t.join();
    
    return 0;
}
```

`std::thread::hardware_concurrency()` returns the number of concurrent threads the hardware supports. This is your guideline for how many compute-bound threads to create. Spawning 1000 threads on a 16-core machine does not give you 1000x parallelism - it gives you 16x parallelism with massive context-switching overhead.

---

### Junior → FAANG: The Three Rules for `std::thread` Safety

Rule 1: always join or detach every `std::thread` before it goes out of scope. A `std::thread` that is neither joined nor detached calls `std::terminate` on destruction. Rule 2: never capture references to local variables in a thread's lambda if the thread may outlive the local scope. Rule 3: never share data between threads without synchronization. Even reading a variable while another thread writes it is a data race and UB.

These three rules, followed consistently, prevent the most common `std::thread` bugs. Prefer `std::jthread` (C++20) over `std::thread` for new code: it joins automatically on destruction and supports cooperative cancellation.

### Senior @ FAANG: Thread Lifecycle Management and Thread Pool Policy

At the staff level, creating `std::thread` directly for each task is rarely the right pattern. Thread creation is expensive (OS-level, ~100 microseconds). A thread pool amortizes this cost. A staff engineer defines the thread pool strategy for the service: which thread pool library (Abseil's `ThreadPool`, Folly's `CPUThreadPoolExecutor`, or a custom implementation), what the pool size policy is (fixed at N = hardware concurrency, or dynamically sized based on queue depth), and what the task queuing policy is (bounded queue to prevent runaway memory growth, or unbounded with backpressure).

**Thread naming for debugging.** In a production service with multiple thread pools, naming each thread (`pthread_setname_np`) makes profiler output and crash dump analysis dramatically easier. A staff engineer adds thread naming to all thread pool implementations and verifies the names appear in `perf` and GDB outputs before deploying.

