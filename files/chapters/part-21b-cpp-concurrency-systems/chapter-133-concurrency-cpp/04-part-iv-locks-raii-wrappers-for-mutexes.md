## Part IV: Locks - RAII Wrappers for Mutexes

Raw `lock()` and `unlock()` calls are error-prone. C++ provides RAII lock wrappers that acquire the mutex in their constructor and release it in their destructor. This guarantees the mutex is released even when exceptions are thrown.

### std::lock_guard - The Simplest Lock

Mutexes serialize access to shared mutable state across threads, preventing data races at the cost of potential contention and deadlock. The RAII wrappers `std::lock_guard` and `std::unique_lock` ensure the mutex is released when the scope exits, even if an exception is thrown.
```cpp
#include <mutex>
#include <vector>
#include <iostream>
#include <thread>

std::mutex mtx;
std::vector<int> shared_vec;

void safe_push(int value) {
    std::lock_guard<std::mutex> lock(mtx);  // acquires mutex
    shared_vec.push_back(value);
    // mutex released when lock goes out of scope
}

int main() {
    std::vector<std::thread> threads;
    for (int i = 0; i < 100; ++i) {
        threads.emplace_back(safe_push, i);
    }
    for (auto& t : threads) t.join();
    
    std::cout << "Vector size: " << shared_vec.size() << "\n";  // always 100
    return 0;
}
```

`lock_guard` is non-copyable, non-movable, and has no methods. It does one thing: lock on construction, unlock on destruction. Use it when you need to hold a lock for the entire scope.

### std::unique_lock - The Flexible Lock

`unique_lock` adds flexibility: deferred locking, manual lock/unlock, try-lock, timed lock, and the ability to transfer ownership via move.

```cpp
#include <mutex>
#include <iostream>
#include <thread>
#include <chrono>

std::mutex mtx;

void flexible_locking() {
    // Deferred lock - construct without locking
    std::unique_lock<std::mutex> lock(mtx, std::defer_lock);
    
    // Do some preparation work without holding the lock...
    
    // Now acquire the lock
    lock.lock();
    
    // Critical section
    std::cout << "Inside critical section.\n";
    
    // Manually unlock early
    lock.unlock();
    
    // Do more non-critical work...
    
    // Lock again if needed
    lock.lock();
    std::cout << "Re-entered critical section.\n";
    
    // Automatically unlocked when lock goes out of scope
}

void try_lock_example() {
    std::unique_lock<std::mutex> lock(mtx, std::try_to_lock);
    
    if (lock.owns_lock()) {
        std::cout << "Got the lock!\n";
    } else {
        std::cout << "Lock was busy, doing something else.\n";
    }
}

// Transfer lock ownership between functions
std::unique_lock<std::mutex> get_lock() {
    std::unique_lock<std::mutex> lock(mtx);
    // Prepare shared data...
    return lock;  // moves ownership to caller
}

int main() {
    std::thread t1(flexible_locking);
    std::thread t2(try_lock_example);
    t1.join();
    t2.join();
    
    auto lock = get_lock();
    std::cout << "Main has the lock.\n";
    // lock released on scope exit
    
    return 0;
}
```

`unique_lock` is required for use with condition variables (covered next) because condition variables need the ability to unlock and re-lock the mutex internally.

### std::shared_lock (C++14) - For Reader Access

Pairs with `std::shared_mutex` for read-side locking. Multiple threads can hold a `shared_lock` simultaneously.

```cpp
#include <shared_mutex>
#include <iostream>
#include <thread>
#include <vector>

class Config {
    mutable std::shared_mutex mtx_;
    std::map<std::string, int> settings_;
    
public:
    int read(const std::string& key) const {
        std::shared_lock lock(mtx_);  // multiple readers allowed
        auto it = settings_.find(key);
        return (it != settings_.end()) ? it->second : -1;
    }
    
    void write(const std::string& key, int value) {
        std::unique_lock lock(mtx_);  // exclusive access
        settings_[key] = value;
    }
};
```

### std::scoped_lock (C++17) - Lock Multiple Mutexes Safely

`scoped_lock` can lock multiple mutexes simultaneously using a deadlock-avoidance algorithm. This is the definitive solution to the classic deadlock problem where two threads lock mutexes in different orders.

```cpp
#include <mutex>
#include <iostream>
#include <thread>

class BankAccount {
public:
    std::mutex mtx;
    long long balance_cents;  // money is integer minor units
    int id;
    
    BankAccount(int id, long long initial_cents)
        : id(id), balance_cents(initial_cents) {}
};

void transfer(BankAccount& from, BankAccount& to, long long amount_cents) {
    // scoped_lock acquires BOTH mutexes without deadlock risk.
    // Internally uses std::lock() which tries all possible orderings.
    std::scoped_lock lock(from.mtx, to.mtx);
    
    if (from.balance_cents >= amount_cents) {
        from.balance_cents -= amount_cents;
        to.balance_cents += amount_cents;
        std::cout << "Transferred " << amount_cents << " cents" 
                  << " from account " << from.id 
                  << " to account " << to.id << "\n";
    }
}

int main() {
    BankAccount alice(1, 100000);  // $1,000.00 in cents
    BankAccount bob(2, 100000);
    
    // These two threads lock the accounts in opposite order.
    // With naive locking, this would deadlock.
    // With scoped_lock, it works correctly.
    std::thread t1(transfer, std::ref(alice), std::ref(bob), 10000LL);
    std::thread t2(transfer, std::ref(bob), std::ref(alice), 5000LL);
    
    t1.join();
    t2.join();
    
    std::cout << "Alice: " << alice.balance_cents
              << ", Bob: " << bob.balance_cents << " (cents)\n";
    
    return 0;
}
```

**Which lock to use:**
| Lock | Use Case |
|------|----------|
| `lock_guard` | Simple scope-based locking, single mutex |
| `unique_lock` | Condition variables, deferred/timed locking, transferring ownership |
| `shared_lock` | Read-side of reader-writer patterns |
| `scoped_lock` | Locking multiple mutexes simultaneously |

---

### Junior → FAANG: Always Use Lock Guards, Never Raw `lock()/unlock()`

The rule is absolute: never call `mutex.lock()` and `mutex.unlock()` directly. Always use `std::lock_guard`, `std::unique_lock`, or `std::scoped_lock`. Raw lock/unlock pairs have two failure modes: forgetting to unlock (causes deadlock) and exceptions between lock and unlock (leaves the mutex locked permanently). RAII locks eliminate both.

This is the C++ equivalent of Go's `defer mu.Unlock()` idiom, but with stronger guarantees because RAII works even when exceptions are thrown.

### Senior @ FAANG: Lock Scope Minimization and Performance

At the staff level, lock scope minimization is a performance discipline. Every operation inside a locked section serializes all threads. The rule: hold locks for the minimum necessary time. In practice: prepare data before acquiring the lock, do the minimal critical section operation, release the lock, then post-process outside the lock.

**Lock scope review in code review.** A staff engineer's code review checks: is any I/O (file, network, logging) happening inside a locked section? Is any blocking operation (condition_variable::wait, sleep) happening inside a locked section? Is any operation that might cause another lock acquisition happening inside this locked section (potential deadlock)? These are the three most common lock scope violations.

**Reader-writer locks for read-heavy workloads.** `std::shared_mutex` (reader-writer lock) allows multiple concurrent readers but exclusive writers. It is appropriate when reads significantly outnumber writes and reads are expensive enough that serializing them is a bottleneck. A staff engineer profiles contention before switching to `shared_mutex`: if the workload is not clearly read-heavy, `shared_mutex` adds overhead (more complex internal state) without benefit.

