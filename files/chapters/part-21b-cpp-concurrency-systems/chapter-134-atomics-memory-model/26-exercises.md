## Exercises

### Exercise 1: Lock-Free Max

Implement a `lock_free_max` function that atomically updates an `std::atomic<int>` to hold the maximum of its current value and a given value. Use `compare_exchange_weak` in a loop.

```cpp
void lock_free_max(std::atomic<int>& target, int value) {
    // Your implementation here
    // Hint: Load current, compare with value, CAS if value is larger
}
```

### Exercise 2: MPMC Bounded Counter

Implement a bounded counter that multiple threads can increment but that never exceeds a maximum value. `try_increment()` should return `true` if the increment succeeded and `false` if the counter was already at the maximum.

```cpp
class BoundedCounter {
    std::atomic<int> count{0};
    int max_value;

public:
    explicit BoundedCounter(int max) : max_value(max) {}
    bool try_increment(); // Implement this
    int get() const { return count.load(std::memory_order_relaxed); }
};
```

### Exercise 3: Double-Checked Locking

Implement thread-safe lazy initialization using `std::atomic` and a mutex, following the double-checked locking pattern. The first thread to call `get()` initializes the resource. Subsequent calls return the cached pointer.

```cpp
class LazyResource {
    std::atomic<Resource*> resource{nullptr};
    std::mutex init_mutex;

public:
    Resource* get(); // Implement this with double-checked locking
};
```

### Exercise 4: Ticket Lock

Implement a fair lock using two atomic counters: `now_serving` and `next_ticket`. Each thread takes a ticket (atomic increment) and spins until its ticket is being served.

```cpp
class TicketLock {
    alignas(64) std::atomic<uint64_t> next_ticket{0};
    alignas(64) std::atomic<uint64_t> now_serving{0};

public:
    void lock();    // Implement: take ticket, spin until served
    void unlock();  // Implement: advance now_serving
};
```

### Exercise 5: Detect False Sharing

Write a benchmark that demonstrates false sharing. Create two versions of a struct with two atomic counters: one with false sharing and one with cache-line alignment. Have two threads increment different counters and measure the time difference. Target at least a 2x difference on your hardware.

### Exercise 6: Go Translation

Translate the SPSC queue from this chapter into Go using `sync/atomic`. Identify which parts become simpler and which become harder without explicit memory orderings.

### Junior → FAANG: Getting the Most from These Exercises

For exercises 1-3 (basic atomic operations and spinlock), the goal is not just "it compiles and passes a quick test." Run the code under ThreadSanitizer (`-fsanitize=thread`) with at least 8 threads and a long enough runtime to expose races. A passing single-threaded test proves nothing about concurrent correctness.

For exercise 4 (SPSC queue), benchmark it at 1M operations with a producer and consumer on separate physical cores. Compare against `std::queue` with a `std::mutex`. The atomic SPSC queue should be 3-5x faster. If it is not, profile to find the bottleneck.

For exercise 6 (Go translation), the learning goal is not to make Go as fast as C++. It is to understand what you gain (Go's safety model prevents ordering mistakes) and what you lose (you cannot express weak orderings, so some optimizations are impossible). This exercise builds the cross-language reasoning that FAANG interviews probe.

### Senior @ FAANG: Exercise Extensions for Staff-Level Depth

Extend exercise 4: implement the SPSC queue with a ring buffer backed by huge pages (via `mmap` with `MAP_HUGETLB`). Benchmark the TLB miss reduction at 1M element payload size. The expected improvement is 15-30% on x86-64 due to fewer TLB entries needed for the buffer.

Extend exercise 5 (seqlock): add a benchmark that measures reader latency under writer contention at 1%, 10%, and 50% write rates. Plot the p99 latency. The seqlock is optimal only when write rates are low. At 50% write rate, a mutex typically wins on throughput. Understand where the crossover is for your target workload.

For the Go translation exercise, extend it: measure whether Go's `sync/atomic.CompareAndSwapInt64` (always seq_cst) vs. a manually-ordered C++ implementation shows measurable difference in a SPSC queue at 10M operations on ARM Graviton. This is a benchmark that distinguishes senior from staff: you know what to measure and why.

---
