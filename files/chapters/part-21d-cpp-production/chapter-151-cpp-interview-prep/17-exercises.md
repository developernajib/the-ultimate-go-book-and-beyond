## Exercises

These five exercises are not drill problems, they are the kind of open-ended implementation tasks you will encounter in a FAANG C++ interview. Each one requires a design decision, a complete implementation, and awareness of edge cases. Work through them before the interview.

---

### Exercise 1: Implement `shared_ptr` from Scratch

Implement a simplified `SharedPtr<T>` with thread-safe reference counting. It must support:
- Construction from a raw pointer
- Copy and move semantics
- `operator->` and `operator*`
- `use_count()`
- Correct destruction when the last owner releases

```cpp
#include <atomic>
#include <cassert>
#include <utility>

template<typename T>
class SharedPtr {
    struct ControlBlock {
        T*                   object;
        std::atomic<int>     ref_count{1};
        explicit ControlBlock(T* obj) : object(obj) {}
    };

    ControlBlock* ctrl_ = nullptr;

    void release() {
        if (!ctrl_) return;
        if (ctrl_->ref_count.fetch_sub(1, std::memory_order_acq_rel) == 1) {
            delete ctrl_->object;
            delete ctrl_;
        }
        ctrl_ = nullptr;
    }

public:
    // Construct from raw pointer, takes ownership
    explicit SharedPtr(T* ptr = nullptr) {
        if (ptr) ctrl_ = new ControlBlock(ptr);
    }

    // Copy constructor: increment ref count
    SharedPtr(const SharedPtr& other) : ctrl_(other.ctrl_) {
        if (ctrl_) ctrl_->ref_count.fetch_add(1, std::memory_order_relaxed);
    }

    // Move constructor: steal the control block, null out source
    SharedPtr(SharedPtr&& other) noexcept : ctrl_(other.ctrl_) {
        other.ctrl_ = nullptr;
    }

    // Copy assignment
    SharedPtr& operator=(const SharedPtr& other) {
        if (this != &other) {
            release();
            ctrl_ = other.ctrl_;
            if (ctrl_) ctrl_->ref_count.fetch_add(1, std::memory_order_relaxed);
        }
        return *this;
    }

    // Move assignment
    SharedPtr& operator=(SharedPtr&& other) noexcept {
        if (this != &other) {
            release();
            ctrl_      = other.ctrl_;
            other.ctrl_ = nullptr;
        }
        return *this;
    }

    ~SharedPtr() { release(); }

    T* operator->() const { return ctrl_ ? ctrl_->object : nullptr; }
    T& operator*()  const { return *ctrl_->object; }
    T* get()        const { return ctrl_ ? ctrl_->object : nullptr; }
    explicit operator bool() const { return ctrl_ && ctrl_->object; }
    int use_count() const {
        return ctrl_ ? ctrl_->ref_count.load(std::memory_order_relaxed) : 0;
    }
};

// Test:
void test_shared_ptr() {
    SharedPtr<int> a(new int(42));
    assert(a.use_count() == 1);
    {
        SharedPtr<int> b = a;
        assert(a.use_count() == 2);
        assert(*b == 42);
    }
    assert(a.use_count() == 1);

    SharedPtr<int> c = std::move(a);
    assert(a.use_count() == 0);
    assert(c.use_count() == 1);
    assert(*c == 42);
    // c goes out of scope: ref_count → 0, int deleted
}
```

**What to discuss**: Why `fetch_sub` uses `acq_rel` while `fetch_add` can use `relaxed`. The missing `WeakPtr` support (weak reference count in control block). Why `make_shared` is better (allocates object and control block together). The difference between this implementation and `std::shared_ptr` (no aliasing constructor, no deleter support, no array support).

---

### Exercise 2: Variadic `printf`-Style Function Using Fold Expressions

Implement a type-safe `log` function that accepts any number of arguments of any types and prints them space-separated, using fold expressions. No format string required, it derives types from the arguments.

```cpp
#include <iostream>
#include <sstream>
#include <string>

// Helper: converts a single value to string
template<typename T>
std::string to_str(const T& val) {
    std::ostringstream oss;
    oss << val;
    return oss.str();
}

// Type-safe variadic log using fold expression + initializer_list trick
template<typename... Args>
void log(Args&&... args) {
    // Build array of strings via fold expression in initializer_list
    std::initializer_list<std::string> parts{to_str(std::forward<Args>(args))...};
    bool first = true;
    for (const auto& p : parts) {
        if (!first) std::cout << ' ';
        std::cout << p;
        first = false;
    }
    std::cout << '\n';
}

// Alternative: operator, fold for sequential evaluation
template<typename... Args>
void log_v2(Args&&... args) {
    int i = 0;
    ((std::cout << (i++ ? " " : "") << std::forward<Args>(args)), ...);
    std::cout << '\n';
}

// With log level:
enum class Level { Info, Warn, Error };

template<typename... Args>
void log_level(Level level, Args&&... args) {
    const char* prefix = (level == Level::Error) ? "[ERROR] " :
                         (level == Level::Warn)  ? "[WARN]  " : "[INFO]  ";
    std::cout << prefix;
    log(std::forward<Args>(args)...);
}

// Test:
void test_log() {
    log("hello", "world");                           // hello world
    log("count:", 42, "rate:", 3.14, "ok:", true);   // count: 42 rate: 3.14 ok: 1
    log_level(Level::Error, "connection", "failed", "port:", 8080);
}
```

**What to discuss**: The difference between comma fold and `initializer_list` fold (evaluation order: comma fold on `initializer_list` is left-to-right and guaranteed. Unary fold with `,` operator is also left-to-right in C++17). How you would add compile-time type checking (e.g., require `operator<<` to be defined for each T, which the `to_str` approach already enforces). How this compares to `std::format` (C++20) and `fmt::print`.

---

### Exercise 3: Merge K Sorted Lists Using `priority_queue`

Implement the merge, but this time, wrap the solution in a class, handle memory ownership correctly, and add a streaming interface so the merged result can be consumed lazily.

```cpp
#include <queue>
#include <vector>
#include <functional>
#include <optional>
#include <memory>

struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v, ListNode* n = nullptr) : val(v), next(n) {}
};

// Streaming merger: yields one element at a time without materializing the full list
class KListMerger {
    struct Entry {
        int       val;
        ListNode* next;
        bool operator>(const Entry& o) const { return val > o.val; }
    };
    std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> pq_;

public:
    explicit KListMerger(const std::vector<ListNode*>& heads) {
        for (ListNode* h : heads)
            if (h) pq_.push({h->val, h->next});
    }

    // Returns the next smallest value, or nullopt if exhausted
    std::optional<int> next() {
        if (pq_.empty()) return std::nullopt;
        auto [val, next_node] = pq_.top();
        pq_.pop();
        if (next_node) pq_.push({next_node->val, next_node->next});
        return val;
    }

    bool done() const { return pq_.empty(); }
};

// Eager version: returns a new merged list
ListNode* mergeKLists(std::vector<ListNode*>& heads) {
    KListMerger merger{heads};
    ListNode dummy{0};
    ListNode* tail = &dummy;
    while (auto val = merger.next()) {
        tail->next = new ListNode(*val);
        tail = tail->next;
    }
    return dummy.next;
}

// Test:
void test_merge_k() {
    // Lists: [1→4→5], [1→3→4], [2→6]
    ListNode* l1 = new ListNode(1, new ListNode(4, new ListNode(5)));
    ListNode* l2 = new ListNode(1, new ListNode(3, new ListNode(4)));
    ListNode* l3 = new ListNode(2, new ListNode(6));

    std::vector<ListNode*> lists = {l1, l2, l3};
    KListMerger merger{lists};

    // Stream: 1, 1, 2, 3, 4, 4, 5, 6
    while (auto val = merger.next()) {
        std::cout << *val << " ";
    }
    // Clean up merged list (omitted for brevity)
}
```

**What to discuss**: Why the streaming interface is valuable (constant memory, early termination possible). Ownership: who owns the original list nodes? The merged list's nodes are new allocations, who frees them? How you would wrap this in a proper RAII iterator.

---

### Exercise 4: Thread-Safe Object Pool

Implement an object pool that pre-allocates N objects and lends them out. Borrowed objects are returned to the pool when their `unique_ptr` goes out of scope.

```cpp
#include <vector>
#include <mutex>
#include <memory>
#include <optional>
#include <functional>
#include <stdexcept>

template<typename T>
class ObjectPool {
    std::vector<std::unique_ptr<T>> available_;
    std::mutex                      mu_;

    // Custom deleter: returns the object to the pool instead of deleting it
    struct Returner {
        ObjectPool<T>* pool;
        void operator()(T* obj) const {
            std::lock_guard lock{pool->mu_};
            pool->available_.push_back(std::unique_ptr<T>(obj));
        }
    };

public:
    using Handle = std::unique_ptr<T, Returner>;

    // Pre-allocate n objects using factory function
    template<typename Factory>
    ObjectPool(size_t n, Factory&& factory) {
        available_.reserve(n);
        for (size_t i = 0; i < n; ++i)
            available_.push_back(std::unique_ptr<T>(factory()));
    }

    // Borrow an object. Returns nullopt if pool is empty.
    std::optional<Handle> borrow() {
        std::lock_guard lock{mu_};
        if (available_.empty()) return std::nullopt;
        T* raw = available_.back().release();
        available_.pop_back();
        return Handle{raw, Returner{this}};
    }

    // Blocking borrow (simple spin, production would use condition_variable)
    Handle borrow_or_throw() {
        if (auto h = borrow()) return std::move(*h);
        throw std::runtime_error("object pool exhausted");
    }

    size_t available() const {
        std::lock_guard lock{mu_};
        return available_.size();
    }
};

// Test:
struct Connection {
    int id;
    explicit Connection(int i) : id(i) {}
};

void test_pool() {
    ObjectPool<Connection> pool(3, [i = 0]() mutable {
        return new Connection(i++);
    });

    assert(pool.available() == 3);
    {
        auto c1 = pool.borrow();  // borrow connection 2
        auto c2 = pool.borrow();  // borrow connection 1
        assert(pool.available() == 1);
        // c1 and c2 go out of scope here: returned to pool
    }
    assert(pool.available() == 3);  // both returned
}
```

**What to discuss**: Why the custom deleter approach is superior to a manual `return()` call (no risk of forgetting to return). Thread safety: the mutex is held only during borrow/return, not during the lifetime of the borrowed object. How you would add `std::condition_variable` for blocking wait instead of returning nullopt. Production connection pool additions: max lifetime, health check on return, connection validation.

---

### Exercise 5: Mock C++ Interview End-to-End

Here is a complete mock interview question with model answers. Practice delivering these answers aloud, in a 35-minute window.

**Question**: "Design a rate limiter in C++. It should support per-key rate limiting (e.g., per user ID), allow 100 requests per second per key, and be thread-safe. Implement the token bucket algorithm."

**Model Answer, Design Phase (5 minutes):**

Token bucket: each key has a bucket with capacity C and a fill rate R tokens/second. Each request consumes one token. Tokens accumulate up to capacity C. If the bucket is empty, the request is rejected.

Data: `unordered_map<Key, BucketState>` protected by a `shared_mutex` or per-key fine-grained locking.

**Model Answer, Implementation (25 minutes):**

```cpp
#include <unordered_map>
#include <shared_mutex>
#include <chrono>
#include <cmath>

using Clock     = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

struct Bucket {
    double    tokens;           // current token count (fractional)
    TimePoint last_refill;

    Bucket(double capacity, TimePoint now)
        : tokens(capacity), last_refill(now) {}
};

class RateLimiter {
    const double capacity_;   // max tokens (e.g., 100)
    const double rate_;       // tokens per second (e.g., 100)

    std::unordered_map<std::string, Bucket> buckets_;
    mutable std::shared_mutex               mu_;

    // Refill tokens based on elapsed time since last refill
    void refill(Bucket& b) const {
        auto now = Clock::now();
        double elapsed = std::chrono::duration<double>(now - b.last_refill).count();
        b.tokens    = std::min(capacity_, b.tokens + elapsed * rate_);
        b.last_refill = now;
    }

public:
    RateLimiter(double capacity, double rate)
        : capacity_(capacity), rate_(rate) {}

    // Returns true if the request is allowed, false if rate-limited
    bool allow(const std::string& key) {
        // Fast path: shared lock for existing buckets
        {
            std::shared_lock read_lock{mu_};
            auto it = buckets_.find(key);
            if (it != buckets_.end()) {
                // Upgrade would be ideal but shared_mutex doesn't support it
                // Drop and re-acquire as unique lock
            }
        }

        std::unique_lock write_lock{mu_};
        auto it = buckets_.find(key);
        if (it == buckets_.end()) {
            it = buckets_.emplace(key, Bucket{capacity_, Clock::now()}).first;
        }

        Bucket& b = it->second;
        refill(b);

        if (b.tokens >= 1.0) {
            b.tokens -= 1.0;
            return true;   // allowed
        }
        return false;      // rate limited
    }

    // Cleanup old buckets (call periodically)
    void evict_stale(double max_idle_seconds) {
        std::unique_lock lock{mu_};
        auto now = Clock::now();
        for (auto it = buckets_.begin(); it != buckets_.end(); ) {
            double idle = std::chrono::duration<double>(now - it->second.last_refill).count();
            it = (idle > max_idle_seconds) ? buckets_.erase(it) : std::next(it);
        }
    }
};
```

**Model Answer, Discussion Phase (5 minutes):**

"There is a scalability concern with this implementation: a single `unique_lock` for every request means all requests are serialized. For high throughput, I would shard the rate limiter into N shards (by `hash(key) % N`), each with its own mutex. This gives N-way parallelism.

For distributed rate limiting across multiple service instances, a Redis-based token bucket using `INCRBY` + `EXPIRE` provides eventual consistency. The tradeoff: Redis adds network round-trip (~0.5 ms) per rate-limit check. An in-process limiter is nanoseconds. The choice depends on whether per-instance limits are acceptable or whether a global per-user limit is required.

A production rate limiter would also expose Prometheus metrics: `rate_limiter_allowed_total`, `rate_limiter_rejected_total`, `rate_limiter_bucket_count`."

---
