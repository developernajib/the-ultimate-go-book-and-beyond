## Part X: Common Pitfalls - Data Races, Deadlocks, and Priority Inversion

Concurrency bugs are the hardest bugs in software engineering. They are non-deterministic, rarely reproducible, and often manifest only under specific timing conditions that happen in production but never in testing.

### Data Races

A data race occurs when two threads access the same memory location, at least one is a write, and there is no synchronization between them. In C++, this is **undefined behavior** - the compiler is free to assume it never happens and optimize accordingly.

```cpp
#include <iostream>
#include <thread>
#include <vector>

// DATA RACE: undefined behavior
int counter = 0;

void unsafe_increment(int times) {
    for (int i = 0; i < times; ++i) {
        ++counter;  // Not atomic: read, modify, write
    }
}

// FIX 1: Use std::atomic
#include <atomic>
std::atomic<int> safe_counter{0};

void atomic_increment(int times) {
    for (int i = 0; i < times; ++i) {
        safe_counter.fetch_add(1, std::memory_order_relaxed);
    }
}

// FIX 2: Use a mutex
#include <mutex>
std::mutex mtx;
int guarded_counter = 0;

void mutex_increment(int times) {
    for (int i = 0; i < times; ++i) {
        std::lock_guard lock(mtx);
        ++guarded_counter;
    }
}

int main() {
    const int THREADS = 10;
    const int ITERATIONS = 1000000;
    
    // Unsafe version - will produce wrong results
    {
        counter = 0;
        std::vector<std::thread> threads;
        for (int i = 0; i < THREADS; ++i) {
            threads.emplace_back(unsafe_increment, ITERATIONS);
        }
        for (auto& t : threads) t.join();
        std::cout << "Unsafe counter: " << counter 
                  << " (expected " << THREADS * ITERATIONS << ")\n";
    }
    
    // Atomic version - correct
    {
        safe_counter = 0;
        std::vector<std::thread> threads;
        for (int i = 0; i < THREADS; ++i) {
            threads.emplace_back(atomic_increment, ITERATIONS);
        }
        for (auto& t : threads) t.join();
        std::cout << "Atomic counter: " << safe_counter << "\n";
    }
    
    return 0;
}
```

**Detecting data races:**
- **ThreadSanitizer (TSan):** Compile with `-fsanitize=thread`. Detects data races at runtime with ~5-15x slowdown.
- **Helgrind:** Valgrind-based detector. Slower but catches more patterns.
- **Code review:** Every shared variable must either be atomic or protected by a mutex. No exceptions.

```bash
# Compile with ThreadSanitizer
g++ -std=c++20 -fsanitize=thread -g -O1 program.cpp -o program
./program  # Will report races with stack traces
```

### Deadlocks

A deadlock occurs when two or more threads wait for each other to release resources, creating a cycle of dependencies. None can proceed.

```cpp
#include <iostream>
#include <thread>
#include <mutex>

std::mutex mutex_a;
std::mutex mutex_b;

// DEADLOCK: Thread 1 locks A then B, Thread 2 locks B then A.
void thread1_work() {
    std::lock_guard lock_a(mutex_a);  // acquires A
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    std::lock_guard lock_b(mutex_b);  // waits for B (held by thread2)
    std::cout << "Thread 1 done.\n";
}

void thread2_work() {
    std::lock_guard lock_b(mutex_b);  // acquires B
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    std::lock_guard lock_a(mutex_a);  // waits for A (held by thread1)
    std::cout << "Thread 2 done.\n";
}

// FIX: Use std::scoped_lock to acquire both in a consistent order
void thread1_fixed() {
    std::scoped_lock lock(mutex_a, mutex_b);
    std::cout << "Thread 1 done (fixed).\n";
}

void thread2_fixed() {
    std::scoped_lock lock(mutex_a, mutex_b);  // same order doesn't matter
    // scoped_lock internally uses std::lock() which avoids deadlock
    std::cout << "Thread 2 done (fixed).\n";
}

int main() {
    // Fixed version
    std::thread t1(thread1_fixed);
    std::thread t2(thread2_fixed);
    t1.join();
    t2.join();
    
    return 0;
}
```

**Four conditions for deadlock (all must be true):**
1. **Mutual exclusion:** Resources cannot be shared simultaneously.
2. **Hold and wait:** A thread holds one resource while waiting for another.
3. **No preemption:** Resources cannot be forcibly taken from a thread.
4. **Circular wait:** A cycle exists in the resource dependency graph.

**Prevention strategies:**
- **Lock ordering:** Always acquire mutexes in the same order across all threads. Use `std::scoped_lock` for multiple mutexes.
- **Try-lock with backoff:** Use `try_lock()` and release all held locks if any acquisition fails.
- **Lock hierarchy:** Assign levels to mutexes. A thread can only acquire a mutex at a level lower than any mutex it already holds.
- **Timeout:** Use `timed_mutex` and treat timeout as a potential deadlock signal.

### Priority Inversion

Priority inversion occurs when a high-priority thread is blocked waiting for a resource held by a low-priority thread, and a medium-priority thread preempts the low-priority thread. The high-priority thread is effectively at lower priority than the medium-priority thread.

This is the bug that crashed the Mars Pathfinder mission in 1997.

```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <chrono>

std::mutex resource;

// Simulating priority inversion scenario
void low_priority_task() {
    std::lock_guard lock(resource);
    std::cout << "Low-priority task holding resource...\n";
    // Simulates long computation
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    std::cout << "Low-priority task releasing resource.\n";
}

void medium_priority_task() {
    // Runs on CPU, preempting low-priority but not needing the resource
    std::cout << "Medium-priority task running (preempting low)...\n";
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    std::cout << "Medium-priority task done.\n";
}

void high_priority_task() {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    std::cout << "High-priority task wants resource...\n";
    
    auto start = std::chrono::high_resolution_clock::now();
    std::lock_guard lock(resource);  // BLOCKED by low-priority task
    auto end = std::chrono::high_resolution_clock::now();
    
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    std::cout << "High-priority task got resource after " 
              << ms.count() << "ms delay.\n";
}

int main() {
    std::thread low(low_priority_task);
    std::thread med(medium_priority_task);
    std::thread high(high_priority_task);
    
    low.join();
    med.join();
    high.join();
    
    return 0;
}
```

**Mitigations:**
- **Priority inheritance:** When a high-priority thread blocks on a mutex, the OS temporarily boosts the low-priority thread's priority to match. POSIX supports this via `pthread_mutexattr_setprotocol()`.
- **Priority ceiling:** Set a ceiling priority on the mutex. Any thread that acquires it runs at the ceiling priority. Prevents preemption by medium-priority threads.
- **Lock-free algorithms:** Avoid the problem entirely by not using locks. Use atomics and compare-and-swap operations.
- **Minimize critical sections:** Hold locks for the shortest possible time.

### The ABA Problem

In lock-free programming, the ABA problem occurs when a thread reads value A, gets preempted, another thread changes A to B then back to A, and the first thread's compare-and-swap succeeds even though the data changed.

```cpp
#include <atomic>
#include <iostream>
#include <thread>

// Simplified lock-free stack showing ABA potential
template <typename T>
class LockFreeStack {
    struct Node {
        T data;
        Node* next;
        Node(T val) : data(val), next(nullptr) {}
    };
    
    std::atomic<Node*> head_{nullptr};

public:
    void push(T value) {
        auto* new_node = new Node(value);
        new_node->next = head_.load(std::memory_order_relaxed);
        while (!head_.compare_exchange_weak(
            new_node->next, new_node,
            std::memory_order_release,
            std::memory_order_relaxed)) {
            // CAS failed, new_node->next updated to current head
        }
    }
    
    // WARNING: This pop() is vulnerable to ABA problem.
    // Thread 1: reads head = A, A->next = B
    // Thread 2: pops A, pops B, pushes A back (recycled memory)
    // Thread 1: CAS succeeds (head is A), but A->next is garbage
    bool pop(T& result) {
        Node* old_head = head_.load(std::memory_order_relaxed);
        while (old_head != nullptr) {
            Node* next = old_head->next;
            if (head_.compare_exchange_weak(
                old_head, next,
                std::memory_order_acquire,
                std::memory_order_relaxed)) {
                result = old_head->data;
                delete old_head;
                return true;
            }
        }
        return false;
    }
};

// FIX: Use a tagged pointer (stamp counter) or hazard pointers
// to detect that the pointer changed even if it has the same address.
```

### False Sharing

False sharing occurs when threads access different variables that happen to reside on the same cache line (typically 64 bytes). The CPU cache coherence protocol forces the cache line to bounce between cores, degrading performance dramatically.

```cpp
#include <iostream>
#include <thread>
#include <vector>
#include <chrono>
#include <atomic>

// BAD: counters on the same cache line
struct BadCounters {
    std::atomic<long long> a{0};
    std::atomic<long long> b{0};
    // a and b are 8 bytes apart - same cache line!
};

// GOOD: pad to separate cache lines
struct alignas(64) GoodCounters {
    struct alignas(64) PaddedCounter {
        std::atomic<long long> value{0};
    };
    PaddedCounter a;
    PaddedCounter b;
};

template <typename Counters>
long long benchmark(const char* label) {
    Counters counters;
    const int ITERATIONS = 50'000'000;
    
    auto start = std::chrono::high_resolution_clock::now();
    
    std::thread t1([&] {
        for (int i = 0; i < ITERATIONS; ++i) {
            counters.a.fetch_add(1, std::memory_order_relaxed);
        }
    });
    
    std::thread t2([&] {
        for (int i = 0; i < ITERATIONS; ++i) {
            counters.b.fetch_add(1, std::memory_order_relaxed);
        }
    });
    
    t1.join();
    t2.join();
    
    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    
    std::cout << label << ": " << ms.count() << "ms\n";
    return ms.count();
}

int main() {
    benchmark<BadCounters>("False sharing    ");
    benchmark<GoodCounters>("Cache-line aligned");
    
    return 0;
}
```

**Typical results:** The false-sharing version can be 3-10x slower than the cache-line-aligned version, despite doing the exact same logical work.

---

### Junior → FAANG: Concurrency Pitfalls as Interview Material

Data races, deadlocks, and priority inversion are the canonical C++ concurrency interview questions. Practice identifying each class from a code snippet: (1) a data race is two threads accessing shared data without a mutex. (2) a deadlock is two threads each holding a lock the other needs. (3) priority inversion is a low-priority thread holding a lock a high-priority thread needs. (4) false sharing is two threads writing to different variables that share a cache line.

For each pitfall, know the tool that detects it (TSan for data races, deadlock detection in TSan and Valgrind Helgrind for deadlocks, `perf stat` for false sharing) and the pattern that prevents it.

### Senior @ FAANG: Pitfall Prevention as a Concurrency Code Review Standard

At the staff level, these pitfalls are prevented systematically, not caught case-by-case in code review. A staff engineer establishes: (1) TSan as a mandatory CI gate for all multi-threaded code. (2) Clang thread safety annotations required for all shared data. (3) lock ordering documented and verified by annotations. (4) `alignas(64)` required for all per-thread data structures. (5) priority inheritance mutexes required for any critical section accessed by both real-time and background threads. These five rules, enforced by tooling and code review, prevent the majority of concurrency pitfalls in a production codebase.

