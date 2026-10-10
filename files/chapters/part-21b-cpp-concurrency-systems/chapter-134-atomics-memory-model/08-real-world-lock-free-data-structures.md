## Real-World Lock-Free Data Structures

### Lock-Free Counter With Statistics

Lock-free data structures use atomic compare-and-swap operations instead of mutexes, allowing multiple threads to make progress concurrently without blocking each other. Implementing correct lock-free algorithms requires careful analysis of ABA problems, memory ordering, and the interaction between CPU cache coherence and the C++ memory model.
```cpp
#include <atomic>
#include <thread>
#include <vector>
#include <iostream>
#include <algorithm>
#include <numeric>

class DistributedCounter {
    // Per-thread counters to minimize contention, aligned to avoid false sharing
    struct alignas(64) PaddedCounter {
        std::atomic<int64_t> value{0};
    };

    std::vector<PaddedCounter> counters;
    std::atomic<int> next_slot{0};
    static thread_local int my_slot;

    int get_slot() {
        if (my_slot == -1) {
            my_slot = next_slot.fetch_add(1, std::memory_order_relaxed);
        }
        return my_slot;
    }

public:
    explicit DistributedCounter(int max_threads)
        : counters(max_threads) {}

    void increment() {
        counters[get_slot()].value.fetch_add(1, std::memory_order_relaxed);
    }

    void decrement() {
        counters[get_slot()].value.fetch_sub(1, std::memory_order_relaxed);
    }

    int64_t get() const {
        // Sum all per-thread counters
        // This is not a point-in-time snapshot - it's approximate
        int64_t total = 0;
        for (const auto& c : counters) {
            total += c.value.load(std::memory_order_relaxed);
        }
        return total;
    }
};

thread_local int DistributedCounter::my_slot = -1;

int main() {
    DistributedCounter counter(16);
    const int per_thread = 1'000'000;

    std::vector<std::thread> threads;
    for (int i = 0; i < 8; ++i) {
        threads.emplace_back([&]() {
            for (int j = 0; j < per_thread; ++j) {
                counter.increment();
            }
        });
    }
    for (auto& t : threads) t.join();

    std::cout << "Total: " << counter.get() << "\n";
    // Output: Total: 8000000
    return 0;
}
```

### Single-Producer Single-Consumer (SPSC) Ring Buffer

The SPSC queue is the crown jewel of lock-free programming. With exactly one reader and one writer, you need only acquire/release ordering and no CAS operations.

```cpp
#include <atomic>
#include <array>
#include <optional>
#include <thread>
#include <iostream>
#include <cassert>

template <typename T, size_t Capacity>
class SPSCQueue {
    static_assert((Capacity & (Capacity - 1)) == 0,
                  "Capacity must be a power of 2 for efficient modulo");

    std::array<T, Capacity> buffer;

    // Producer writes to write_pos, consumer reads it
    // Consumer writes to read_pos, producer reads it
    // Separate cache lines to avoid false sharing
    alignas(64) std::atomic<size_t> write_pos{0};
    alignas(64) std::atomic<size_t> read_pos{0};

public:
    bool try_push(const T& item) {
        const size_t wp = write_pos.load(std::memory_order_relaxed);
        const size_t next_wp = (wp + 1) & (Capacity - 1);

        // Check if full: next write position would equal read position
        if (next_wp == read_pos.load(std::memory_order_acquire)) {
            return false; // Queue is full
        }

        buffer[wp] = item;

        // Release: makes the buffer write visible to the consumer
        write_pos.store(next_wp, std::memory_order_release);
        return true;
    }

    std::optional<T> try_pop() {
        const size_t rp = read_pos.load(std::memory_order_relaxed);

        // Check if empty: read position equals write position
        if (rp == write_pos.load(std::memory_order_acquire)) {
            return std::nullopt; // Queue is empty
        }

        T item = buffer[rp];
        const size_t next_rp = (rp + 1) & (Capacity - 1);

        // Release: makes the buffer read visible to the producer
        // (so producer knows the slot is free)
        read_pos.store(next_rp, std::memory_order_release);
        return item;
    }

    bool empty() const {
        return read_pos.load(std::memory_order_acquire)
            == write_pos.load(std::memory_order_acquire);
    }
};

int main() {
    SPSCQueue<int, 1024> queue;
    const int count = 1'000'000;

    // Single producer
    std::thread producer([&]() {
        for (int i = 0; i < count; ++i) {
            while (!queue.try_push(i)) {
                // Spin (in production, use pause/yield)
            }
        }
    });

    // Single consumer
    int64_t sum = 0;
    std::thread consumer([&]() {
        for (int i = 0; i < count; ++i) {
            std::optional<int> val;
            while (!(val = queue.try_pop())) {
                // Spin
            }
            sum += *val;
        }
    });

    producer.join();
    consumer.join();

    int64_t expected = static_cast<int64_t>(count - 1) * count / 2;
    assert(sum == expected);
    std::cout << "Sum: " << sum << " (expected " << expected << ")\n";
    return 0;
}
```

**Why SPSC only needs acquire/release**: There is exactly one writer of `write_pos` (the producer) and one reader of `read_pos` (the consumer). No two threads ever write to the same atomic variable, so CAS is unnecessary. The acquire/release pairs on `write_pos` and `read_pos` synchronize the buffer contents.

### Seqlock: Readers Never Block Writers

A seqlock allows a writer to update data without blocking readers. Readers detect concurrent writes by checking a sequence counter and retrying. Used in the Linux kernel for time-keeping.

```cpp
#include <atomic>
#include <thread>
#include <iostream>
#include <chrono>

class Seqlock {
    // Even sequence = no write in progress
    // Odd sequence  = write in progress
    std::atomic<uint32_t> sequence{0};

public:
    uint32_t read_begin() const {
        uint32_t seq;
        do {
            seq = sequence.load(std::memory_order_acquire);
        } while (seq & 1); // Retry while writer is active
        return seq;
    }

    bool read_retry(uint32_t start_seq) const {
        // Acquire fence ensures all reads in the critical section
        // are complete before we re-check the sequence
        std::atomic_thread_fence(std::memory_order_acquire);
        return sequence.load(std::memory_order_relaxed) != start_seq;
    }

    void write_lock() {
        // Increment to odd: signals "write in progress"
        uint32_t seq = sequence.load(std::memory_order_relaxed);
        sequence.store(seq + 1, std::memory_order_release);
    }

    void write_unlock() {
        // Increment to even: signals "write complete"
        uint32_t seq = sequence.load(std::memory_order_relaxed);
        sequence.store(seq + 1, std::memory_order_release);
    }
};

// Protected data: a 3D coordinate (too large for a single atomic)
struct Coordinate {
    double x, y, z;
};

Seqlock lock;
Coordinate position{0.0, 0.0, 0.0};

Coordinate read_position() {
    Coordinate local;
    uint32_t seq;
    do {
        seq = lock.read_begin();
        // Read the coordinate - may be torn if a writer is active
        local = position;
    } while (lock.read_retry(seq));
    // If we get here, the read was consistent
    return local;
}

void update_position(double x, double y, double z) {
    lock.write_lock();
    position = {x, y, z};
    lock.write_unlock();
}

int main() {
    std::thread writer([]() {
        for (int i = 0; i < 1'000'000; ++i) {
            double v = static_cast<double>(i);
            update_position(v, v * 2, v * 3);
        }
    });

    std::thread reader([]() {
        for (int i = 0; i < 1'000'000; ++i) {
            Coordinate c = read_position();
            // The relationship between x, y, z should always be consistent
            // y should be 2*x and z should be 3*x
            if (c.x != 0.0) {
                // Floating point comparison - exact because we set exact multiples
                assert(c.y == c.x * 2.0);
                assert(c.z == c.x * 3.0);
            }
        }
    });

    writer.join();
    reader.join();
    std::cout << "Seqlock verification passed\n";
    return 0;
}
```

**Seqlock properties**:
- Writers never block (no CAS, no waiting for readers).
- Readers retry on conflict (optimistic concurrency).
- Best when writes are rare and reads are frequent.
- The data must be trivially copyable (memcpy-safe).

### Junior → FAANG: Reading Lock-Free Code Without Getting Lost

Lock-free data structures look intimidating on first read because they have CAS loops, retry logic, and memory orderings everywhere. The key to reading them is to identify the invariant first, then trace how each operation maintains it.

For a lock-free stack: the invariant is that `head` always points to the top of the stack. The push operation reads head, creates a new node pointing to head, then CAS-swaps head to the new node. If the CAS fails, head changed between the read and the swap, and we retry. The memory ordering on the CAS must be `acq_rel` (acquire the current head to read the list safely, release the new node so other threads see its data before they see it as the head).

For your first FAANG job: you will likely use existing lock-free containers (Folly's `MPMCQueue`, Abseil's `flat_hash_map`, Intel's TBB concurrent containers) rather than writing your own. The skill is reading them correctly, understanding their guarantees, and choosing the right one for the access pattern.

Interview entry point: if asked to implement a lock-free stack in an interview, start by stating the invariant, then write the CAS loop, then justify the memory ordering. Do not start with the CAS loop and hope the reasoning follows. Interviewers want to see structured reasoning.

### Senior @ FAANG: Lock-Free Structures as Infrastructure with Governance Requirements

At L5+, the decision to use a lock-free data structure in production infrastructure is a platform-level commitment. Lock-free structures are harder to reason about, harder to debug (no mutex to strace or hold in a debugger), and harder to modify without introducing races. The bar for introducing a new lock-free structure must be high.

The production checklist for a new lock-free structure: (1) benchmarked against a mutex-based alternative at production concurrency levels, (2) validated with ThreadSanitizer under the actual access pattern, (3) validated with a litmus test or model checker, (4) hazard pointer or epoch-based reclamation for any structure that deletes nodes (ABA problem), (5) documented fast-path and slow-path behavior, (6) rollback plan if it exhibits correctness issues in production.

The seqlock pattern (mentioned in this chapter) is widely used in Linux kernel and production FAANG systems for read-mostly data with occasional writes. The key insight is that readers do not take a lock, they read a version counter before and after the data read, and retry if the counter changed. This gives O(1) read latency in the uncontended case. The FAANG use case: high-read-rate configuration data (feature flags, routing tables) where mutex contention would be measurable.

ABA is the most common correctness bug in lock-free code. The fix options are: tagged pointers (store a counter in unused pointer bits), hazard pointers (C++26 `std::hazard_pointer`), or epoch-based reclamation (Folly's `hazptr`). Choosing among these is a platform decision: hazard pointers have lower memory overhead, epoch reclamation has better throughput. Both must be benchmarked.

Bar-raiser signal: in a design review for a lock-free queue, ask "how does this handle ABA?" and "what is the reclamation strategy?" If the answer is "we don't delete nodes" (a common simplification), ask "how does memory grow under load?" A lock-free structure with unbounded memory growth is not production-ready.

---
