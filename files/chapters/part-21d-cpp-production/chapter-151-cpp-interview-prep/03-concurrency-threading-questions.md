## Concurrency and Threading Questions

C++ concurrency questions separate candidates who have written real multithreaded systems from those who have only read about them. The C++ memory model is more explicit and more complex than Go's, there is no built-in channel, no select, and the happens-before guarantees must be established manually via atomics and mutexes.

---

### Q1. What is a data race? How is it different from a race condition?

A **data race** is a precise, formally-defined term in the C++ standard: two threads access the same memory location, at least one access is a write, and no synchronization operation establishes a happens-before relationship between them. A data race is undefined behavior, the compiler and CPU may reorder, tear, or invent writes.

A **race condition** is a broader concept: the correctness of a program depends on the relative timing of threads. A race condition can occur even with no data race (e.g., a TOCTOU, time-of-check-time-of-use bug on a file system). And a data race is one way to have a race condition.

```cpp
// DATA RACE, undefined behavior:
int counter = 0;
// Thread 1:
counter++;  // read-modify-write: not atomic, no synchronization
// Thread 2:
counter++;  // another read-modify-write: data race

// RACE CONDITION without data race:
// Thread 1:
if (file_exists("config.txt")) {   // check
    // Thread 2 deletes the file here
    open("config.txt");             // use, TOCTOU race condition, no data race
}
```

ThreadSanitizer (TSan, `-fsanitize=thread`) detects data races at runtime. It is the first tool to run on any new concurrent C++ code.

---

### Q2. What is `std::mutex`? What is `std::shared_mutex`?

`std::mutex` provides exclusive mutual exclusion. Only one thread can hold the lock at a time, both readers and writers block.

`std::shared_mutex` (C++17) supports two lock modes:
- **Exclusive lock** (`lock()` / `unique_lock`): one writer, no concurrent readers
- **Shared lock** (`lock_shared()` / `shared_lock`): multiple concurrent readers, no writers

```cpp
#include <shared_mutex>
#include <unordered_map>

class Cache {
    mutable std::shared_mutex mu_;
    std::unordered_map<std::string, std::string> data_;
public:
    std::string get(const std::string& key) const {
        std::shared_lock lock{mu_};  // multiple readers OK
        auto it = data_.find(key);
        return it != data_.end() ? it->second : "";
    }

    void put(const std::string& key, const std::string& val) {
        std::unique_lock lock{mu_};  // exclusive write
        data_[key] = val;
    }
};
```

`shared_mutex` is beneficial when reads vastly outnumber writes and the critical section is long enough that multiple readers provide meaningful throughput gain. For short critical sections, the overhead of `shared_mutex` can exceed the benefit, profile before using.

---

### Q3. What is RAII locking? Show `lock_guard` vs `unique_lock`.

RAII locking wraps a mutex acquisition in an object whose destructor releases the lock. This guarantees the mutex is released even if an exception is thrown.

`std::lock_guard`, the simplest RAII lock. Acquires the mutex on construction, releases on destruction. Cannot be unlocked manually.

`std::unique_lock`, flexible RAII lock. Can be unlocked and re-locked manually, transferred to another thread via move, used with condition variables, and constructed with deferred lock.

```cpp
#include <mutex>
#include <condition_variable>

std::mutex mu;
std::condition_variable cv;
bool ready = false;

// lock_guard: simple, prefer when you just need "lock until end of scope"
void simple_writer() {
    std::lock_guard<std::mutex> lock{mu};  // locked here
    ready = true;
}   // unlocked here, even if exception thrown

// unique_lock: required for condition variables, manual unlock
void flexible_reader() {
    std::unique_lock<std::mutex> lock{mu};    // locked
    cv.wait(lock, [] { return ready; });      // atomically unlocks during wait
    // lock is re-acquired before wait returns
    // ... use shared data ...
}   // unlocked on destruction

// unique_lock with deferred acquisition:
std::unique_lock<std::mutex> lock{mu, std::defer_lock};
// ... do work without the lock ...
lock.lock();    // acquire now
// ... do protected work ...
lock.unlock();  // release before scope ends
```

---

### Q4. What is a deadlock? How do you detect and prevent it?

A deadlock occurs when two or more threads each hold a lock the other needs, forming a cycle of waiting with no thread able to proceed.

```cpp
std::mutex mu_a, mu_b;

// Thread 1:
mu_a.lock();
mu_b.lock();  // waits for Thread 2 to release mu_b, never happens

// Thread 2:
mu_b.lock();
mu_a.lock();  // waits for Thread 1 to release mu_a, never happens
// DEADLOCK
```

**Prevention strategies:**

1. **Lock ordering**: always acquire locks in a globally consistent order. Thread 1 and 2 both lock mu_a first, then mu_b.

2. **`std::lock()` / `std::scoped_lock`**: acquires multiple locks atomically, using deadlock avoidance internally:
```cpp
// Safe: acquires both atomically, never deadlocks
std::scoped_lock lock{mu_a, mu_b};
```

3. **Try-lock with backoff**: `try_lock()` fails immediately if the lock is taken. Retry after a delay.

4. **Lock hierarchy**: assign integer levels to mutexes. Only ever lock higher levels while holding lower levels.

**Detection**: Valgrind's Helgrind tool detects lock-order violations. In production, a watchdog thread that dumps lock ownership on timeout can identify which threads are stuck.

---

### Q5. What is `std::atomic`? What does `memory_order_relaxed` mean?

`std::atomic<T>` provides lock-free, atomic read-modify-write operations on type `T` (if the hardware supports it, `is_lock_free()` confirms). Operations on atomics never produce torn reads or data races.

`memory_order` controls the visibility ordering guarantees applied to surrounding non-atomic loads and stores. These correspond to CPU memory barrier instructions.

```cpp
#include <atomic>

std::atomic<int> counter{0};
counter.fetch_add(1, std::memory_order_relaxed);  // atomic increment, no ordering
```

**Memory orders from weakest to strongest:**

- `relaxed`: only atomicity guaranteed. No ordering with other operations. Use for counters where only the final value matters, not when it is visible.
- `acquire`: this load sees all stores from the thread that did the matching `release` store. Forms the "acquire" half of a lock.
- `release`: all stores before this are visible to the thread that does the matching `acquire` load. Forms the "release" half of a lock.
- `acq_rel`: both acquire and release, for read-modify-write operations like compare-and-swap.
- `seq_cst`: sequential consistency, total order across all `seq_cst` operations on all threads. The default, and the most expensive (~3ns per operation on x86 due to `MFENCE`).

```cpp
// Classic publish/subscribe pattern:
std::atomic<bool> data_ready{false};
int shared_data = 0;

// Producer:
shared_data = 42;                            // regular store
data_ready.store(true, std::memory_order_release); // publish

// Consumer:
while (!data_ready.load(std::memory_order_acquire)); // wait for publish
assert(shared_data == 42);  // guaranteed visible due to acquire/release pairing
```

---

### Q6. What is the happens-before relationship?

In the C++ memory model, operation A **happens-before** operation B if B is guaranteed to see the effects of A. It is established by:

1. **Sequenced-before**: within a single thread, statements execute in order
2. **Synchronizes-with**: an atomic store with `release` synchronizes-with a load of the same variable with `acquire`, establishing happens-before across threads
3. **Transitivity**: if A happens-before B and B happens-before C, then A happens-before C

```
Thread 1:                      Thread 2:
x = 10;         ──────────────────────────────────
flag.store(true, release);     flag.load(acquire) == true?
                                   └── YES: x = 10 is visible
                                   // happens-before chain established
```

Without a happens-before chain, there is no guarantee that Thread 2 sees Thread 1's writes, even for non-atomic variables. This is what makes `relaxed` atomics dangerous for anything other than simple counters: they provide no happens-before guarantee.

---

### Q7. What is sequential consistency? Why is it expensive?

Sequential consistency (SC) is the strongest memory ordering guarantee: there exists a total ordering of all `seq_cst` operations across all threads such that each thread's operations appear in program order within that total order.

It is the model programmers naturally expect, and it is what Go's memory model provides for its synchronization primitives.

```cpp
std::atomic<int> x{0}, y{0};

// Thread 1:              Thread 2:
x.store(1);              y.store(1);
int a = y.load();        int b = x.load();

// With seq_cst (default): a=0,b=0 is impossible.
// A total order exists: either x store comes before y store, or vice versa.

// With relaxed:
x.store(1, std::memory_order_relaxed);  // a=0,b=0 IS possible
```

**Why it is expensive:** On x86, `seq_cst` stores require a `LOCK XCHG` or `MFENCE` instruction, which drains the store buffer and stalls the CPU pipeline. On ARM and POWER (weakly-ordered architectures), the cost is even higher, explicit barrier instructions are needed for both loads and stores.

In practice: use `seq_cst` as the default (it is correct). Only downgrade to `acquire/release` or `relaxed` after profiling shows the atomics are a bottleneck, and only with very careful reasoning about correctness.

---

### Q8. What is a condition variable? Implement a producer-consumer queue.

A condition variable allows a thread to sleep until a condition becomes true, without spinning. It always works in conjunction with a mutex.

```cpp
#include <queue>
#include <mutex>
#include <condition_variable>
#include <optional>

template<typename T>
class BoundedQueue {
    std::queue<T>           q_;
    mutable std::mutex      mu_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    const size_t            capacity_;
    bool                    done_ = false;

public:
    explicit BoundedQueue(size_t cap) : capacity_(cap) {}

    void push(T item) {
        std::unique_lock lock{mu_};
        not_full_.wait(lock, [&] { return q_.size() < capacity_ || done_; });
        if (done_) return;
        q_.push(std::move(item));
        not_empty_.notify_one();
    }

    std::optional<T> pop() {
        std::unique_lock lock{mu_};
        not_empty_.wait(lock, [&] { return !q_.empty() || done_; });
        if (q_.empty()) return std::nullopt;
        T item = std::move(q_.front());
        q_.pop();
        not_full_.notify_one();
        return item;
    }

    void close() {
        std::unique_lock lock{mu_};
        done_ = true;
        not_empty_.notify_all();
        not_full_.notify_all();
    }
};
```

The critical interview point: condition variable waits must use the predicate form (`wait(lock, predicate)`) to handle **spurious wakeups**, the OS can wake a waiting thread even when the condition is false. The predicate re-checks and re-waits if needed.

---

### Q9. What is `std::async` vs `std::thread`?

`std::thread` creates a thread and you are responsible for joining or detaching it. There is no built-in mechanism to get a return value.

`std::async` launches a callable asynchronously and returns a `std::future<T>` that carries the result (or re-thrown exception). It may or may not create a new thread, `std::launch::async` forces a new thread, `std::launch::deferred` evaluates lazily when `get()` is called.

```cpp
#include <future>
#include <thread>

// std::thread: manual join, no return value
std::thread t([]() { /* work */ });
t.join();

// std::async: future-based, exception propagation
auto f = std::async(std::launch::async, [](int x) {
    return x * x;
}, 42);
// ... do other work ...
int result = f.get();  // blocks until done, re-throws any exception

// IMPORTANT: the destructor of a future returned by async blocks until completion
// So always capture the future:
auto fut = std::async(std::launch::async, heavy_work);  // correct
std::async(std::launch::async, heavy_work);  // WRONG: destructor blocks immediately
```

The C++ community generally recommends `std::thread` + synchronization primitives for production code and using a proper thread pool. `std::async` has surprising blocking behavior in its destructor that makes it unsuitable for fire-and-forget patterns.

---

### Q10. What is a thread pool? Implement a basic one.

A thread pool maintains a fixed set of threads that pull tasks from a shared queue. This avoids thread creation overhead and bounds resource usage.

```cpp
#include <vector>
#include <queue>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <future>

class ThreadPool {
    std::vector<std::thread>          workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex                        mu_;
    std::condition_variable           cv_;
    bool                              stop_ = false;

public:
    explicit ThreadPool(size_t n) {
        for (size_t i = 0; i < n; ++i) {
            workers_.emplace_back([this] {
                for (;;) {
                    std::function<void()> task;
                    {
                        std::unique_lock lock{mu_};
                        cv_.wait(lock, [this] { return stop_ || !tasks_.empty(); });
                        if (stop_ && tasks_.empty()) return;
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
        }
    }

    template<typename F, typename... Args>
    auto submit(F&& f, Args&&... args) -> std::future<std::invoke_result_t<F, Args...>> {
        using R = std::invoke_result_t<F, Args...>;
        auto task = std::make_shared<std::packaged_task<R()>>(
            std::bind(std::forward<F>(f), std::forward<Args>(args)...)
        );
        std::future<R> fut = task->get_future();
        {
            std::unique_lock lock{mu_};
            if (stop_) throw std::runtime_error("pool is stopped");
            tasks_.emplace([task] { (*task)(); });
        }
        cv_.notify_one();
        return fut;
    }

    ~ThreadPool() {
        { std::unique_lock lock{mu_}; stop_ = true; }
        cv_.notify_all();
        for (auto& t : workers_) t.join();
    }
};
```

---

### Q11. What is false sharing in multithreaded code? Show the fix.

(See Memory Management Q12 for the detailed explanation.)

```cpp
// PROBLEM: two atomic counters on the same cache line
struct Stats {
    std::atomic<uint64_t> requests;  // bytes 0-7
    std::atomic<uint64_t> errors;    // bytes 8-15
    // One 64-byte cache line holds both, write to requests invalidates errors' line
};

// FIX: hardware_destructive_interference_size (C++17 = typically 64)
#include <new>  // for hardware_destructive_interference_size

struct alignas(std::hardware_destructive_interference_size) PaddedCounter {
    std::atomic<uint64_t> value{0};
};

struct Stats {
    PaddedCounter requests;  // cache line 1
    PaddedCounter errors;    // cache line 2, no false sharing
};
```

---

### Q12. What is lock-free programming? What is the ABA problem?

**Lock-free programming** uses atomic compare-and-swap (CAS) operations instead of mutexes to achieve thread safety. A lock-free data structure guarantees system-wide progress: at least one thread completes an operation in a finite number of steps, even if others are preempted.

**The ABA problem**: a CAS-based algorithm reads value A, prepares to swap it to C, but between the read and the CAS another thread changes A→B→A. The CAS succeeds (still reads A) but the state has changed in a way the algorithm did not account for.

```cpp
#include <atomic>

// Classic lock-free stack, suffers ABA:
template<typename T>
class LockFreeStack {
    struct Node { T val; Node* next; };
    std::atomic<Node*> head_{nullptr};
public:
    void push(T val) {
        Node* n = new Node{std::move(val), nullptr};
        n->next = head_.load(std::memory_order_relaxed);
        while (!head_.compare_exchange_weak(n->next, n,
               std::memory_order_release, std::memory_order_relaxed));
    }
};

// ABA fix: tagged pointer, pack a version counter with the pointer
struct TaggedPtr {
    Node*    ptr;
    uint64_t tag;  // incremented on every change
};
std::atomic<TaggedPtr> head_;
// Now CAS checks both ptr AND tag, A→B→A changes the tag, CAS fails correctly
```

On 64-bit x86, `std::atomic<TaggedPtr>` can use a 128-bit compare-and-swap (`CMPXCHG16B`) via `std::atomic<__int128>` or platform-specific intrinsics.

---

### Q13. What is `std::latch` vs `std::barrier` (C++20)?

Both are thread coordination primitives. The difference: a latch is single-use. A barrier is reusable.

**`std::latch`**: a countdown counter. Any thread can decrement it. When it reaches zero, all threads waiting on `wait()` are released. Cannot be reset.

```cpp
#include <latch>

std::latch work_done{5};  // expect 5 threads to complete

// Each of 5 worker threads:
do_work();
work_done.count_down();

// Main thread:
work_done.wait();  // blocks until 5 count_downs have occurred
```

**`std::barrier`**: a synchronization point that all N threads must reach before any can proceed. Resets automatically for the next phase. Accepts a completion function called when all threads arrive.

```cpp
#include <barrier>

std::barrier sync{4, []() noexcept {
    // Called once when all 4 threads reach the barrier
    swap_buffers();
}};

// Each of 4 threads, in a loop:
while (has_work()) {
    process_chunk();
    sync.arrive_and_wait();  // wait for all threads, then completion fn runs
    // All threads continue together into next phase
}
```

Barriers are used in parallel algorithms where each phase must complete before the next begins, SIMD processing, multi-pass rendering, parallel BFS.

---

### Q14. What is a `std::promise` / `std::future`?

A `promise`/`future` pair provides a one-shot communication channel between threads. The producer sets a value (or exception) via the `promise`. The consumer retrieves it via the `future`.

```cpp
#include <future>
#include <thread>

std::promise<int> prom;
std::future<int>  fut = prom.get_future();

std::thread producer([&prom] {
    try {
        int result = compute_something();
        prom.set_value(result);
    } catch (...) {
        prom.set_exception(std::current_exception());  // propagate to consumer
    }
});

// Consumer: blocks until value is set or exception thrown
try {
    int result = fut.get();
    std::cout << result << "\n";
} catch (const std::exception& e) {
    std::cerr << "Error: " << e.what() << "\n";
}
producer.join();
```

`std::shared_future` allows multiple consumers to `get()` the same result. The key limitation of `promise`/`future`: one-shot only. For ongoing streams of values, use a queue or channel pattern.

---

### Q15. What is `std::jthread` (C++20)?

`std::jthread` is a RAII-safe thread that automatically joins on destruction (unlike `std::thread`, which calls `std::terminate` if destroyed while joinable). It also supports cooperative cancellation via `std::stop_token`.

```cpp
#include <thread>
#include <stop_token>
#include <chrono>

// jthread: automatically joins on destruction
{
    std::jthread t([] {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    });
}  // t.join() called automatically here, no terminate

// jthread with stop_token: cooperative cancellation
std::jthread worker([](std::stop_token stoken) {
    while (!stoken.stop_requested()) {
        do_work_unit();
    }
});

// Later:
worker.request_stop();  // sets the stop token, worker checks and exits
// worker.join() called automatically in destructor
```

`std::stop_token` + `std::stop_source` also integrate with `std::condition_variable_any::wait()`, you can wait for either a condition or a cancellation request, whichever comes first. This makes `jthread` the right choice for any cancellable background task.

---

### Q16. What is ThreadSanitizer and what does it find?

ThreadSanitizer (TSan, `-fsanitize=thread`) instruments memory accesses and synchronization operations to detect data races at runtime. Unlike static analysis, TSan detects races only on actually-executed code paths.

```bash
g++ -fsanitize=thread -fno-omit-frame-pointer -g -O1 prog.cpp -o prog
./prog

# Output on data race:
# WARNING: ThreadSanitizer: data race (pid=1234)
#   Write of size 4 at 0x... by thread T2:
#     #0 increment() prog.cpp:10
#   Previous write of size 4 at 0x... by thread T1:
#     #0 increment() prog.cpp:10
```

TSan imposes ~5-15x runtime overhead and ~5-10x memory overhead. It is suitable for unit tests and integration tests, but not production. Important: TSan requires all code in the process to be instrumented, uninstrumented libraries (linked without `-fsanitize=thread`) produce false negatives.

TSan finds: data races on non-atomic memory, misuse of mutexes (e.g., lock/unlock on different threads for non-reentrant mutexes), use-after-free in multithreaded context.

---

### Q17. What is a spinlock? When is it better than a mutex?

A spinlock busy-waits (loops reading the lock flag) instead of blocking the OS thread. This avoids the overhead of a context switch (~1-10 µs) at the cost of consuming CPU cycles.

```cpp
#include <atomic>

class Spinlock {
    std::atomic_flag flag_ = ATOMIC_FLAG_INIT;
public:
    void lock() {
        while (flag_.test_and_set(std::memory_order_acquire)) {
            // Spin, optionally with _mm_pause() (x86 PAUSE instruction)
            // to reduce power consumption and improve hyper-threading fairness
            __builtin_ia32_pause();
        }
    }
    void unlock() {
        flag_.clear(std::memory_order_release);
    }
};
```

**Spinlock is better than mutex when:**
- The critical section is extremely short (< ~50 ns), the context switch cost exceeds spin time
- The lock holder will never be preempted while holding the lock (real-time, kernel code)
- There are only 2 competing threads (or contention is rare)

**Mutex is better when:**
- The critical section takes > ~1 µs
- There are many competing threads, spinning wastes many CPU-cycles
- Threads do significant work while holding the lock

In Go, `sync.Mutex` uses a hybrid approach: it spins briefly before blocking, which is the behavior of most modern OS mutexes (futex on Linux).

---

### Q18. What are coroutines in C++20? Compare to goroutines.

C++20 coroutines are functions that can be suspended and resumed. They are stackless, the coroutine frame is heap-allocated, not stack-allocated. The language provides three keywords: `co_await`, `co_yield`, and `co_return`.

```cpp
#include <coroutine>
#include <optional>

// A simple generator using C++20 coroutines
template<typename T>
struct Generator {
    struct promise_type {
        T current;
        Generator get_return_object() {
            return Generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        std::suspend_always yield_value(T val) {
            current = val;
            return {};
        }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;
    explicit Generator(std::coroutine_handle<promise_type> h) : handle(h) {}
    ~Generator() { if (handle) handle.destroy(); }

    bool next() { handle.resume(); return !handle.done(); }
    T    value() const { return handle.promise().current; }
};

Generator<int> fibonacci() {
    int a = 0, b = 1;
    for (;;) {
        co_yield a;
        auto next = a + b;
        a = b;
        b = next;
    }
}
```

**C++ coroutines vs Go goroutines:**
| | C++20 Coroutines | Go Goroutines |
|---|---|---|
| Stackless/Stackful | Stackless (heap frame) | Stackful (growable stack) |
| Scheduling | Manual (library provides scheduler) | Automatic (Go runtime) |
| Blocking calls | Must use async wrappers | Can block directly |
| Memory | ~100 bytes per frame | ~2 KB initial goroutine stack |
| Completion | Explicit co_await points | Preemptive |
| Ecosystem | Nascent (cppcoro, Asio, etc.) | Built-in channels, select |

C++ coroutines are a language mechanism, not a concurrency model. You need a coroutine library (Asio, cppcoro) to get scheduling, I/O integration, and goroutine-like behavior.

---

### Q19. What is the `volatile` keyword? Does it provide thread safety?

`volatile` tells the compiler that the variable may change outside the program's control (hardware register, signal handler, MMIO). It prevents the compiler from caching the value in a register or optimizing away reads/writes.

`volatile` does **NOT** provide thread safety. It generates no memory barriers. It does not prevent CPU reordering. It does not make operations atomic.

```cpp
volatile bool flag = false;   // WRONG for threading

// Thread 1:
flag = true;   // may be reordered by CPU, not atomic on all architectures

// Thread 2:
while (!flag); // may spin forever due to CPU caching, even with volatile

// CORRECT:
std::atomic<bool> flag{false};   // atomic + memory ordering
```

The correct use of `volatile` in C++:
1. Memory-mapped I/O registers in embedded/kernel code
2. `setjmp`/`longjmp` with variables that change between them
3. Signal handler communication (though `sig_atomic_t` is the proper type)

In Go, there is no `volatile`, all shared-memory synchronization goes through channels or `sync` primitives, which provide both atomicity and ordering.

---

### Q20. How would you implement a thread-safe singleton?

The classic singleton with double-checked locking was broken before C++11 because the memory model did not guarantee the object was fully constructed before the pointer was made visible. C++11 fixed this in two ways:

**Method 1, Meyers Singleton (preferred):**
Function-local `static` variables in C++11 are guaranteed to be initialized exactly once, thread-safely, on first call.

```cpp
class Database {
    Database() { /* expensive init */ }
public:
    static Database& instance() {
        static Database db;  // C++11: thread-safe, lazy, no lock needed
        return db;
    }
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;
};

Database& db = Database::instance();  // thread-safe first call
```

**Method 2, `std::call_once` (when you need a pointer/heap allocation):**

```cpp
#include <mutex>

class Registry {
    static std::unique_ptr<Registry> instance_;
    static std::once_flag            once_;
public:
    static Registry* get() {
        std::call_once(once_, [] {
            instance_ = std::make_unique<Registry>();
        });
        return instance_.get();
    }
};
std::unique_ptr<Registry> Registry::instance_;
std::once_flag            Registry::once_;
```

The Meyers singleton is correct, simple, and idiomatic C++11. Prefer it over double-checked locking with `atomic` unless you need to inject a different instance for testing (in which case, reconsider whether a singleton is the right pattern at all).

---
