## Memory Orderings: The Six Options

Every atomic operation accepts an optional `std::memory_order` parameter that controls how the operation interacts with surrounding memory accesses. Using weaker orderings where possible improves performance, especially on weakly-ordered architectures like ARM.

### memory_order_relaxed: No Ordering Constraints

Relaxed operations guarantee atomicity only. The compiler and CPU are free to reorder them relative to any other memory operation. No happens-before relationship is established with other threads (beyond the modification order of the atomic variable itself).

**When to use**: Counters, statistics, progress indicators, anything where you need correctness of the atomic value itself but don't need to synchronize other data.

```cpp
#include <atomic>
#include <thread>
#include <vector>
#include <iostream>

struct Statistics {
    std::atomic<uint64_t> requests{0};
    std::atomic<uint64_t> errors{0};
    std::atomic<uint64_t> bytes_transferred{0};

    void record_request(uint64_t bytes, bool error) {
        // Relaxed: We only care about the final count, not ordering
        // relative to other variables. Each counter is independent.
        requests.fetch_add(1, std::memory_order_relaxed);
        bytes_transferred.fetch_add(bytes, std::memory_order_relaxed);
        if (error) {
            errors.fetch_add(1, std::memory_order_relaxed);
        }
    }

    void print() {
        // Note: Since we use relaxed ordering, these three loads might
        // see values from different "points in time." The error count
        // could temporarily appear larger than the request count.
        // This is acceptable for approximate statistics.
        std::cout << "Requests: " << requests.load(std::memory_order_relaxed)
                  << ", Errors: " << errors.load(std::memory_order_relaxed)
                  << ", Bytes: " << bytes_transferred.load(std::memory_order_relaxed)
                  << "\n";
    }
};

int main() {
    Statistics stats;
    std::vector<std::thread> threads;

    for (int i = 0; i < 8; ++i) {
        threads.emplace_back([&stats]() {
            for (int j = 0; j < 100000; ++j) {
                stats.record_request(256, j % 100 == 0);
            }
        });
    }

    for (auto& t : threads) t.join();
    stats.print();
    // Requests: 800000, Errors: 8000, Bytes: 204800000 (always exact)
    return 0;
}
```

**What relaxed does NOT guarantee**: Ordering between different atomic variables or between atomic and non-atomic accesses.

```cpp
std::atomic<int> x(0), y(0);

// Thread 1
void thread1() {
    x.store(1, std::memory_order_relaxed); // A
    y.store(1, std::memory_order_relaxed); // B
}

// Thread 2
void thread2() {
    // With relaxed ordering, thread 2 can see y == 1 but x == 0
    // Even though thread 1 wrote x before y (in program order),
    // relaxed ordering allows the stores to become visible out of order.
    while (y.load(std::memory_order_relaxed) != 1) {}
    assert(x.load(std::memory_order_relaxed) == 1); // CAN FAIL on ARM/POWER
}
```

### memory_order_acquire and memory_order_release: The Workhorse Pair

This is the most commonly used ordering pair. It establishes a **synchronizes-with** relationship between a release store and an acquire load of the same atomic variable.

- **Release** (`memory_order_release`): All memory writes (atomic and non-atomic) performed before this store are visible to any thread that performs an acquire load of the same variable and sees the stored value.
- **Acquire** (`memory_order_acquire`): All memory writes that happened before the corresponding release store are visible after this load.

Think of release as "publish everything I've done so far" and acquire as "see everything the publisher did."

```cpp
#include <atomic>
#include <thread>
#include <iostream>
#include <string>
#include <cassert>

// Classic producer-consumer with acquire/release
struct Message {
    std::string content;
    int priority;
};

Message shared_message;
std::atomic<bool> ready(false);

void producer() {
    // These non-atomic writes happen before the release store
    shared_message.content = "Hello from producer";
    shared_message.priority = 5;

    // Release: guarantees all previous writes are visible to the acquirer
    ready.store(true, std::memory_order_release);
}

void consumer() {
    // Acquire: once we see ready == true, all writes before the release
    // are guaranteed visible
    while (!ready.load(std::memory_order_acquire)) {
        // Spin
    }

    // These reads are guaranteed to see the producer's writes
    assert(shared_message.priority == 5);                    // Always holds
    assert(shared_message.content == "Hello from producer"); // Always holds
    std::cout << shared_message.content << " (priority "
              << shared_message.priority << ")\n";
}

int main() {
    std::thread t1(producer);
    std::thread t2(consumer);
    t1.join();
    t2.join();
    return 0;
}
```

**Why this works on ARM**: The release store emits a store-release barrier (DMB ISH + STR or STLR on ARMv8), ensuring all prior stores are flushed from the store buffer before the flag is written. The acquire load emits a load-acquire barrier (LDAR on ARMv8), ensuring no subsequent loads are reordered before it.

**Release/acquire with fetch operations**:

```cpp
#include <atomic>
#include <thread>
#include <iostream>
#include <vector>

// A simple reference counter demonstrating release on decrement
class RefCounted {
    std::atomic<int> ref_count{1};
    int* data;

public:
    explicit RefCounted(int value) : data(new int(value)) {}

    void add_ref() {
        // Relaxed is fine for increment: we don't need to synchronize
        // any data - we just need the count to be correct
        ref_count.fetch_add(1, std::memory_order_relaxed);
    }

    void release() {
        // Release: all prior accesses to `data` must be visible before
        // another thread might delete the object
        if (ref_count.fetch_sub(1, std::memory_order_release) == 1) {
            // We were the last reference (old value was 1, new is 0)
            // Acquire fence: ensure we see all writes from other threads
            // that previously released their references
            std::atomic_thread_fence(std::memory_order_acquire);
            delete data;
            data = nullptr;
        }
    }

    int get() const { return *data; }
};
```

### memory_order_acq_rel: Combined Acquire-Release

Used for read-modify-write operations (like `compare_exchange` or `fetch_add`) that need to both acquire (see prior writes) and release (publish their own writes). Think of it as "acquire on the read part, release on the write part."

```cpp
#include <atomic>
#include <thread>
#include <iostream>
#include <cassert>

// Lock-free stack push using acq_rel on CAS
struct Node {
    int data;
    Node* next;
    Node(int d) : data(d), next(nullptr) {}
};

std::atomic<Node*> head{nullptr};

void push(int value) {
    Node* new_node = new Node(value);
    new_node->next = head.load(std::memory_order_relaxed);

    // CAS with acq_rel:
    // - Acquire: sees all data written by threads that previously
    //   succeeded in pushing (we need to read head->next correctly)
    // - Release: our writes to new_node are visible to future poppers
    while (!head.compare_exchange_weak(
        new_node->next,
        new_node,
        std::memory_order_acq_rel,   // Success: acquire + release
        std::memory_order_relaxed     // Failure: just retry
    )) {
        // new_node->next updated to current head, retry
    }
}

Node* pop() {
    Node* old_head = head.load(std::memory_order_acquire);
    while (old_head && !head.compare_exchange_weak(
        old_head,
        old_head->next,
        std::memory_order_acq_rel,
        std::memory_order_relaxed
    )) {
        // old_head updated, retry
    }
    return old_head;
}

int main() {
    // Push from multiple threads
    std::thread t1([]{ for (int i = 0; i < 5; ++i) push(i); });
    std::thread t2([]{ for (int i = 5; i < 10; ++i) push(i); });
    t1.join();
    t2.join();

    // Pop and print all
    Node* node;
    while ((node = pop()) != nullptr) {
        std::cout << node->data << " ";
        delete node;
    }
    std::cout << "\n";
    return 0;
}
```

### memory_order_seq_cst: Sequential Consistency (The Default)

The strongest ordering. All `seq_cst` operations appear to execute in a single total order agreed upon by all threads. This is the default for all atomic operations when you don't specify an ordering.

**The cost**: On x86, `seq_cst` stores emit a full memory barrier (`MFENCE` or `lock`-prefixed instruction). On ARM, it emits both acquire and release barriers plus a full barrier. This is measurably slower than acquire/release.

**When you need it**: When the correctness of your program depends on a global total order of operations across multiple atomic variables.

```cpp
#include <atomic>
#include <thread>
#include <iostream>
#include <cassert>

std::atomic<bool> x(false);
std::atomic<bool> y(false);
std::atomic<int> z(0);

// Dekker's algorithm pattern - requires seq_cst
void write_x() {
    x.store(true, std::memory_order_seq_cst); // A
}

void write_y() {
    y.store(true, std::memory_order_seq_cst); // B
}

void read_x_then_y() {
    while (!x.load(std::memory_order_seq_cst)) {} // C: spins until x is true
    if (y.load(std::memory_order_seq_cst)) {       // D
        ++z;
    }
}

void read_y_then_x() {
    while (!y.load(std::memory_order_seq_cst)) {} // E: spins until y is true
    if (x.load(std::memory_order_seq_cst)) {       // F
        ++z;
    }
}

int main() {
    std::thread t1(write_x);
    std::thread t2(write_y);
    std::thread t3(read_x_then_y);
    std::thread t4(read_y_then_x);

    t1.join(); t2.join(); t3.join(); t4.join();

    // With seq_cst: z is ALWAYS >= 1
    // Either x was stored before y (so read_y_then_x sees x==true → z++)
    // or y was stored before x (so read_x_then_y sees y==true → z++)
    // or both were stored "simultaneously" (both readers see both → z += 2)
    assert(z.load() != 0); // ALWAYS holds with seq_cst

    // With acquire/release: z == 0 IS POSSIBLE!
    // Because acq/rel doesn't establish a total order between independent variables.
    std::cout << "z = " << z.load() << "\n";
    return 0;
}
```

### memory_order_consume: Deprecated in Practice

`memory_order_consume` was intended to be weaker than acquire, preserving only data-dependent orderings. In practice, no compiler implements it correctly, all compilers promote it to acquire. The C++ standards committee has effectively deprecated it. **Never use it. Use acquire instead.**

### Summary Table

| Ordering | Guarantees | Use Case | Cost (x86) | Cost (ARM) |
|----------|-----------|----------|-------------|------------|
| `relaxed` | Atomicity only | Counters, statistics | Free (plain MOV) | Free (plain LDR/STR) |
| `acquire` | No reads/writes move before this load | Consumer side of publish | Free (x86 loads are inherently acquire) | LDAR instruction |
| `release` | No reads/writes move after this store | Publisher side | Free (most x86 stores) but store may need XCHG for seq | STLR instruction |
| `acq_rel` | Acquire on read, release on write | CAS in lock-free structures | Same as acquire + release | LDAR + STLR |
| `seq_cst` | Total global order | Dekker-like patterns, default | MFENCE or LOCK XCHG | Full barrier (DMB ISH) |

### Junior → FAANG: Choosing Memory Orderings Without Guessing

The practical rule for engineers who are new to atomics: use `memory_order_seq_cst` until you have a measured performance reason to use something weaker. seq_cst is the default for a reason. It is correct in all cases where an atomic is appropriate, and the performance cost is only visible in high-contention hot paths on multi-socket servers.

The two orderings you should understand deeply before your first systems interview are acquire and release. They pair together: a store with `memory_order_release` synchronizes with a load with `memory_order_acquire` on the same atomic variable. Everything the releasing thread did before the store is visible to the acquiring thread after the load. This is the foundation of every lock, mutex, and message queue.

Worked example: a producer writes data to a buffer, then sets `ready.store(true, memory_order_release)`. The consumer spins on `ready.load(memory_order_acquire)`. When the consumer sees `true`, the entire buffer write is guaranteed visible. This is correct. If you flip the orderings to relaxed, the consumer may see `true` but still read garbage from the buffer on ARM.

### Senior @ FAANG: Ordering Selection as a Correctness and Performance Contract

At L5+, the choice of memory ordering is a documented decision, not a guess. The table above summarizes costs, but the architectural implication is what matters: every acquire/release pair creates a synchronization edge in the happens-before graph. Understanding which edges exist (and which do not) is required for reasoning about correctness of any lock-free algorithm at production scale.

The senior trap: using `memory_order_acq_rel` on a `compare_exchange` when only `memory_order_release` is needed on the success path. On a high-frequency CAS loop, the unnecessary acquire on failure is wasted cost. The correct pattern is `compare_exchange_weak(expected, desired, memory_order_release, memory_order_relaxed)`: release on success (to publish the new value), relaxed on failure (the loop retries with a fresh load anyway). This is a 5-10% throughput difference in a hot CAS loop at 64 threads.

ADR consideration: for any new lock-free data structure, require that the memory ordering for every atomic operation be documented in a comment adjacent to the operation, citing which synchronizes-with edge it establishes. This documentation must survive code review and become part of the maintenance contract.

Bar-raiser signal: if asked "what is the difference between acquire/release and seq_cst on x86?", the correct answer is: on x86, acquire loads and release stores are free (the hardware enforces TSO), but seq_cst requires an MFENCE or LOCK XCHG which is a full pipeline barrier costing 20-100 cycles. On ARM, acquire and release generate LDAR/STLR instructions which carry their own cost. A candidate who can quantify these costs and link them to specific hardware instructions is demonstrating principal-level depth.

---
