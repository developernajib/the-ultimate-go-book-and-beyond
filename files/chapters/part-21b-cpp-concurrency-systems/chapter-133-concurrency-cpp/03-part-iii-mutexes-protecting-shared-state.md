## Part III: Mutexes - Protecting Shared State

When multiple threads access the same data and at least one writes, you have a data race. Data races in C++ are undefined behavior - not just "you might get a stale value" but "your program might format your hard drive." Mutexes serialize access to shared data.

### std::mutex - The Basic Lock

Mutexes serialize access to shared mutable state across threads, preventing data races at the cost of potential contention and deadlock. The RAII wrappers `std::lock_guard` and `std::unique_lock` ensure the mutex is released when the scope exits, even if an exception is thrown.
```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <vector>

std::mutex counter_mutex;
int shared_counter = 0;

void increment(int times) {
    for (int i = 0; i < times; ++i) {
        counter_mutex.lock();
        ++shared_counter;
        counter_mutex.unlock();
    }
}

int main() {
    std::vector<std::thread> threads;
    for (int i = 0; i < 10; ++i) {
        threads.emplace_back(increment, 100000);
    }
    for (auto& t : threads) {
        t.join();
    }
    
    // Without mutex: undefined behavior, likely wrong count.
    // With mutex: always exactly 1,000,000.
    std::cout << "Final counter: " << shared_counter << "\n";
    
    return 0;
}
```

**Never call `lock()` and `unlock()` directly in production code.** If an exception is thrown between `lock()` and `unlock()`, the mutex stays locked forever (deadlock). Always use RAII lock guards.

### std::recursive_mutex

A regular mutex deadlocks if the same thread tries to lock it twice. A `recursive_mutex` allows the same thread to lock it multiple times, maintaining a lock count. Each `lock()` must have a matching `unlock()`.

```cpp
#include <iostream>
#include <mutex>

class TreeNode {
    std::recursive_mutex mtx;
    int value;
    TreeNode* left = nullptr;
    TreeNode* right = nullptr;

public:
    TreeNode(int v) : value(v) {}
    
    int sum() {
        std::lock_guard<std::recursive_mutex> lock(mtx);
        int total = value;
        if (left)  total += left->sum();   // re-entrant: ok with recursive_mutex
        if (right) total += right->sum();
        return total;
    }
};
```

**Use `recursive_mutex` sparingly.** If you need it, your design likely has a problem. Prefer restructuring your code so that public methods lock and private methods assume the lock is held.

### std::shared_mutex (C++17) - Reader-Writer Lock

When reads vastly outnumber writes, a `shared_mutex` allows multiple concurrent readers but exclusive writers.

```cpp
#include <iostream>
#include <thread>
#include <shared_mutex>
#include <string>
#include <map>
#include <vector>

class ThreadSafeCache {
    mutable std::shared_mutex mutex_;
    std::map<std::string, std::string> cache_;

public:
    // Multiple threads can read simultaneously
    std::string get(const std::string& key) const {
        std::shared_lock lock(mutex_);  // shared (read) access
        auto it = cache_.find(key);
        return (it != cache_.end()) ? it->second : "";
    }
    
    // Only one thread can write at a time, and no readers during write
    void put(const std::string& key, const std::string& value) {
        std::unique_lock lock(mutex_);  // exclusive (write) access
        cache_[key] = value;
    }
    
    size_t size() const {
        std::shared_lock lock(mutex_);
        return cache_.size();
    }
};

int main() {
    ThreadSafeCache cache;
    
    // Writer thread
    std::thread writer([&cache] {
        for (int i = 0; i < 1000; ++i) {
            cache.put("key" + std::to_string(i), "value" + std::to_string(i));
        }
    });
    
    // Multiple reader threads
    std::vector<std::thread> readers;
    for (int r = 0; r < 4; ++r) {
        readers.emplace_back([&cache, r] {
            for (int i = 0; i < 1000; ++i) {
                auto val = cache.get("key" + std::to_string(i));
                // Readers run concurrently with each other
            }
        });
    }
    
    writer.join();
    for (auto& t : readers) t.join();
    
    std::cout << "Cache size: " << cache.size() << "\n";
    return 0;
}
```

**Comparison with Go:** Go's `sync.RWMutex` is the direct equivalent. The semantics are identical: multiple readers or one writer, with writers having priority to prevent reader starvation.

### std::timed_mutex

A `timed_mutex` adds `try_lock_for()` and `try_lock_until()` methods, allowing threads to give up waiting after a timeout rather than blocking forever.

```cpp
#include <iostream>
#include <thread>
#include <mutex>
#include <chrono>

std::timed_mutex tmtx;

void try_lock_with_timeout(int id) {
    // Try to acquire the lock for up to 100 milliseconds
    if (tmtx.try_lock_for(std::chrono::milliseconds(100))) {
        std::cout << "Thread " << id << " acquired the lock.\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        tmtx.unlock();
    } else {
        std::cout << "Thread " << id << " timed out waiting for lock.\n";
    }
}

int main() {
    std::thread t1(try_lock_with_timeout, 1);
    std::thread t2(try_lock_with_timeout, 2);
    
    t1.join();
    t2.join();
    
    return 0;
}
```

Timed mutexes are useful for deadlock avoidance (try, fail, back off, retry) and for health monitoring (if a lock cannot be acquired in N seconds, something is wrong).

---

### Junior → FAANG: Mutex Annotation as a Self-Documentation Habit

Go's `go vet` does not enforce mutex ownership (unlike `sync/mutex` with `noCopy` checks). C++ has no language-level enforcement either. The habit: annotate every mutex in a class with a comment naming the data it protects, and annotate every data member with which mutex protects it. Abseil provides `ABSL_GUARDED_BY(mutex)` annotations that Clang's thread safety analysis (`-Wthread-safety`) enforces at compile time.

Interview note: "what is thread safety analysis in Clang?" Answer: Clang can analyze source code annotated with `GUARDED_BY`, `REQUIRES`, `LOCKS_EXCLUDED` etc. to verify at compile time that locks are held when accessing guarded data. It catches data races before tests run.

### Senior @ FAANG: Clang Thread Safety Analysis as a CI Requirement

At the staff level, Clang thread safety analysis (`-Wthread-safety`) on annotated code is a compile-time data race prevention tool. A staff engineer adds the annotations to all new classes with shared mutable state and enables `-Wthread-safety-precise` as an error in CI. This catches data races before TSan would find them at runtime.

**Lock ordering documentation.** For services with multiple mutexes, document the canonical lock ordering in a comment at the top of the file or in a separate document. Abseil's `absl::MutexLock` with `ABSL_LOCKS_EXCLUDED` and `ABSL_REQUIRES` annotations makes lock ordering verifiable by the compiler. A staff engineer requires these annotations on all functions that acquire more than one mutex.

