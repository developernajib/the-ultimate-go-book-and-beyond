## 5. RCU (Read-Copy-Update) Patterns

RCU originated in the Linux kernel and is ideal for read-heavy, write-rare workloads. Readers access data with zero synchronization overhead. Writers create a copy, modify it, publish it atomically, then wait for all existing readers to finish before freeing the old version.

### Userspace RCU in C++

`RCUProtected<T>` stores the current data behind an `std::atomic<T*>`. Readers call `read()` which atomically loads the pointer, no locking, no cache invalidation on the read path. Writers acquire a mutex (ensuring only one writer at a time), create a modified copy, atomically swap the pointer so readers immediately see the new data, and delete the old pointer after all in-flight readers have finished.
```cpp
#include <atomic>
#include <memory>
#include <functional>
#include <mutex>

template <typename T>
class RCUProtected {
    std::atomic<T*> data_;
    std::mutex writer_lock_;  // Only one writer at a time

public:
    explicit RCUProtected(T initial)
        : data_(new T(std::move(initial))) {}

    // Readers: zero overhead -- just load the pointer
    class ReadGuard {
        const T* ptr_;
    public:
        explicit ReadGuard(const RCUProtected& rcu)
            : ptr_(rcu.data_.load(std::memory_order_acquire)) {}

        const T& operator*() const { return *ptr_; }
        const T* operator->() const { return ptr_; }
    };

    ReadGuard read() const {
        return ReadGuard(*this);
    }

    // Writers: copy, modify, publish, reclaim
    template <typename F>
    void update(F modifier) {
        std::lock_guard<std::mutex> lock(writer_lock_);

        T* old_data = data_.load(std::memory_order_acquire);
        T* new_data = new T(*old_data);  // Copy

        modifier(*new_data);              // Modify the copy

        data_.store(new_data, std::memory_order_release);  // Publish

        // Grace period: wait for all readers to release old_data.
        // In a real implementation, use epoch-based reclamation.
        synchronize_rcu();

        delete old_data;                  // Reclaim
    }

private:
    void synchronize_rcu() {
        // Simplified: in production, use EBR or quiescent-state tracking.
        // This placeholder assumes a grace period mechanism exists.
        std::atomic_thread_fence(std::memory_order_seq_cst);
    }
};
```

### Practical RCU with shared_ptr

For simpler cases, `std::atomic<std::shared_ptr<T>>` (C++20) provides RCU semantics:

```cpp
#include <atomic>
#include <memory>
#include <mutex>

template <typename T>
class SimpleRCU {
    std::atomic<std::shared_ptr<const T>> data_;
    std::mutex writer_lock_;

public:
    explicit SimpleRCU(T initial)
        : data_(std::make_shared<const T>(std::move(initial))) {}

    // Readers: atomic load of shared_ptr
    std::shared_ptr<const T> read() const {
        return data_.load(std::memory_order_acquire);
    }

    // Writers: copy-on-write
    template <typename F>
    void update(F modifier) {
        std::lock_guard<std::mutex> lock(writer_lock_);
        auto old = data_.load(std::memory_order_acquire);
        auto copy = std::make_shared<T>(*old);  // Mutable copy
        modifier(*copy);
        data_.store(std::move(copy), std::memory_order_release);
        // Old data is freed when the last reader's shared_ptr is released
    }
};

// Usage
SimpleRCU<std::map<std::string, int>> config(
    {{"timeout", 30}, {"retries", 3}}
);

// Reader thread (fast, no locking)
auto snapshot = config.read();
int timeout = snapshot->at("timeout");

// Writer thread (rare)
config.update([](auto& map) {
    map["timeout"] = 60;
});
```

### When to Use RCU

RCU excels when:
- Reads vastly outnumber writes (100:1 or more).
- Read latency must be minimal and predictable.
- Data is replaced wholesale, not mutated in place.

RCU is not suitable when:
- Writes are frequent (copy overhead dominates).
- Data structures are very large (copying is expensive).
- You need fine-grained per-field updates.

### Junior → FAANG: RCU as the Practical Lock-Free Read Pattern

RCU (read-copy-update) is the most practical lock-free pattern for read-heavy workloads. The idea: readers access shared data with no locks and no atomic overhead. Writers make a copy, modify the copy, then atomically swap the pointer. Old data is reclaimed only after all readers that started before the swap have finished.

The Go analogy: Go does not have built-in RCU, but `sync.Value` (for `Store`/`Load` on an arbitrary value) implements the same pattern. The store is atomic, the load is atomic, and there is no locking for readers. C++ RCU gives more control over reclamation.

Interview framing: if asked "how do you make a read-mostly configuration struct thread-safe without degrading read performance?", the answer is RCU (or `sync.Value` in Go). Mutex-based locking adds contention on every read. RCU makes reads free, paying only on writes.

### Senior @ FAANG: RCU as a Platform Primitive for Configuration Management

At L5+, RCU is the standard pattern for any read-mostly shared state: feature flags, routing tables, rate limit configs, TLS certificate stores. The RCU guarantee is that reads are always bounded (wait-free in the read path), writes are atomic (no reader sees a partial update), and stale reads are bounded to the reclamation epoch.

The C++ implementation choices: `std::atomic<std::shared_ptr<T>>` (C++20) gives RCU semantics with automatic reclamation via reference counting. The shared_ptr copy in the read path increments a reference count (one atomic operation). Folly `rcu_domain` gives true Linux-kernel-style RCU with deferred reclamation and no per-read atomic operations. For maximum read throughput (thousands of reads per microsecond), Folly's RCU domain wins.

ADR consideration: for a configuration store that is read on every request, the read overhead must be below 10ns to avoid contributing meaningfully to request latency. `atomic<shared_ptr>` adds one atomic CAS per read (5-15ns). Folly RCU adds zero atomic operations per read (readers use thread-local epoch tracking). For a service handling 100K RPS with 10 config reads per request, the difference is 1-1.5ms per second of saved CPU at the fleet level.

Governance signal: RCU is safe only when the old data's destructor can run after all readers are done. If the old object has side effects (file descriptors, sockets, locks) in its destructor, the deferred destruction may cause surprising behavior. Document the reclamation epoch and destructor behavior in the library's API contract.

---
