## Part II: std::jthread - The Modern Thread (C++20)

C++20 introduced `std::jthread` (joining thread) to fix the two biggest problems with `std::thread`: forgetting to join, and the inability to request a thread to stop.

### Automatic Joining

`std::jthread`'s destructor automatically calls `request_stop()` followed by `join()`, so when the `jthread` object goes out of scope the thread is always joined. This eliminates the `std::terminate` crash that `std::thread`'s destructor triggers when a joinable thread is destroyed without being joined, the single most common threading bug in pre-C++20 code.
```cpp
#include <iostream>
#include <thread>
#include <chrono>

void work(int id) {
    std::cout << "jthread " << id << " running.\n";
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    std::cout << "jthread " << id << " done.\n";
}

int main() {
    {
        std::jthread t1(work, 1);
        std::jthread t2(work, 2);
        // No explicit join needed!
        // When t1 and t2 go out of scope, their destructors
        // automatically call request_stop() then join().
    }
    // Both threads are guaranteed complete here.
    std::cout << "All jthreads completed.\n";
    
    return 0;
}
```

This is RAII applied to threads. The destructor handles cleanup. Exception safety comes for free - if an exception is thrown between construction and the end of scope, the `jthread` destructor still joins properly.

### Cooperative Cancellation with Stop Tokens

The killer feature of `std::jthread` is cooperative cancellation via `std::stop_token`. The thread checks periodically whether a stop has been requested, and exits gracefully when it has.

```cpp
#include <iostream>
#include <thread>
#include <chrono>

void cancellable_work(std::stop_token stoken, int id) {
    int counter = 0;
    while (!stoken.stop_requested()) {
        // Do a chunk of work
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        ++counter;
        std::cout << "Thread " << id << " iteration " << counter << "\n";
    }
    std::cout << "Thread " << id << " canceled after " 
              << counter << " iterations.\n";
}

int main() {
    std::jthread worker(cancellable_work, 1);
    
    // Let it run for 500ms
    std::this_thread::sleep_for(std::chrono::milliseconds(550));
    
    // Request the thread to stop
    worker.request_stop();
    
    // Destructor will join automatically
    // The thread will notice stop_requested() and exit its loop
    
    return 0;
}
```

### Stop Callbacks

You can register callbacks that fire when a stop is requested. This is useful for interrupting blocking operations like I/O waits or condition variable waits.

```cpp
#include <iostream>
#include <thread>
#include <chrono>
#include <condition_variable>
#include <mutex>

std::mutex mtx;
std::condition_variable_any cv;
bool data_ready = false;

void waiting_thread(std::stop_token stoken) {
    std::unique_lock lock(mtx);
    
    // condition_variable_any::wait() with stop_token
    // automatically wakes up when stop is requested
    if (cv.wait(lock, stoken, [] { return data_ready; })) {
        std::cout << "Data received!\n";
    } else {
        std::cout << "Wait was canceled via stop token.\n";
    }
}

int main() {
    std::jthread waiter(waiting_thread);
    
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    
    // Instead of providing data, cancel the wait
    waiter.request_stop();
    
    // jthread destructor joins
    return 0;
}
```

**Comparison with Go:** Go uses `context.Context` for cancellation, passing it explicitly through function chains. C++'s stop token is similar in concept but tied to the thread rather than passed as a function parameter. Go's context carries deadlines and values alongside cancellation. C++ stop tokens do cancellation only.

---

### Junior → FAANG: `std::jthread` as the Default, `std::thread` as the Exception

With C++20 available, `std::jthread` should be the default for new code. The automatic join on destruction eliminates the most common `std::thread` safety mistake (forgetting to join). The stop token integration enables cooperative cancellation without building a custom boolean flag and condition variable.

For teams at C++17, the equivalent pattern is a thread wrapper that joins in the destructor (a "RAII thread" idiom), plus a `std::atomic<bool> stop_requested` for cancellation.

### Senior @ FAANG: Stop Token Patterns in Service Shutdown Sequences

At the staff level, cooperative cancellation via stop tokens is a key component of the service shutdown sequence. A staff engineer designs the shutdown sequence to: (1) signal all active threads via stop tokens, (2) wait for threads to reach a cancellation check point and exit, (3) drain the task queue, (4) join all threads. The total shutdown time is bounded: each thread's cancellation check interval determines the maximum time from signal to exit.

**Graceful shutdown as an SLO requirement.** For a service that handles in-flight requests, the shutdown sequence must complete in-flight requests before exiting. A staff engineer ensures the thread pool implementation supports "stop accepting new tasks, complete existing tasks, then exit." This is a different stop semantics than "exit immediately" and requires distinct stop token handling in the thread pool loop.

