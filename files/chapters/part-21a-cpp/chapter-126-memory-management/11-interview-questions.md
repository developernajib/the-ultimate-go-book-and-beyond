## Interview Questions

### Question 1: Stack vs Heap (Junior)

**Q:** When would you allocate an object on the heap instead of the stack in C++?

**A:** You must use the heap when:
- The object needs to outlive the function that creates it
- The size is not known at compile time
- The size is too large for the stack (typically > 1 MB)
- You need polymorphism (store a derived class through a base pointer)
- The object needs to be shared across multiple owners

Always prefer the stack when possible because it is faster (no allocator overhead), does not fragment memory, and provides automatic cleanup.

### Question 2: Smart Pointer Choice (Mid-level)

**Q:** You have a configuration object that multiple services read but nobody modifies. What smart pointer do you use, and why?

**A:** Use `std::shared_ptr<const Config>`. The `shared_ptr` allows multiple services to share ownership. Making it `const` communicates and enforces that nobody modifies it. When the last service releases its reference, the config is automatically cleaned up.

If you can guarantee one owner with a clear lifetime (e.g., the `main` function), prefer `unique_ptr<Config>` with raw references passed to services, simpler, no atomic reference counting overhead.

### Question 3: RAII Design (Mid-level)

**Q:** Design a connection pool that safely manages database connections.

**A:** Key points:
- The pool owns all connections
- Borrowing a connection returns an RAII handle that returns the connection to the pool on destruction
- Use `unique_ptr` with a custom deleter that returns to pool instead of freeing

```cpp
class ConnectionPool {
    std::vector<std::unique_ptr<Connection>> available_;
    std::mutex mutex_;
    
public:
    using PooledConnection = std::unique_ptr<Connection, std::function<void(Connection*)>>;
    
    PooledConnection borrow() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (available_.empty()) throw std::runtime_error("Pool exhausted");
        
        Connection* raw = available_.back().release();
        available_.pop_back();
        
        // Custom deleter returns connection to pool instead of freeing
        return PooledConnection(raw, [this](Connection* c) {
            std::lock_guard<std::mutex> lock(mutex_);
            available_.push_back(std::unique_ptr<Connection>(c));
        });
    }
};
```

### Question 4: Memory Layout (Senior)

**Q:** Why does false sharing occur, and how do you prevent it?

**A:** False sharing occurs when two threads access different variables that happen to reside on the same cache line (typically 64 bytes). Even though they are accessing different data, the CPU's cache coherency protocol forces the cache line to bounce between cores, destroying performance.

Prevention:
- Pad structures to ensure frequently-accessed fields are on separate cache lines
- Use `alignas(64)` in C++ or `std::hardware_destructive_interference_size`
- In Go, use padding: `_ [64]byte` between fields

```cpp
// Bad: x and y share a cache line
struct Counters {
    std::atomic<int> x;  // Thread 1 writes
    std::atomic<int> y;  // Thread 2 writes -- false sharing!
};

// Good: x and y on separate cache lines
struct Counters {
    alignas(64) std::atomic<int> x;
    alignas(64) std::atomic<int> y;
};
```

### Question 5: GC vs Manual Management (Staff)

**Q:** You are designing a system that maintains a 50 GB in-memory index. Would you use Go or C++, and why?

**A:** C++, for several reasons:

1. **GC scanning cost**: Go's GC must periodically scan or at least be aware of all 50 GB of live pointers. Even concurrent marking introduces significant CPU overhead proportional to the live set.

2. **Memory overhead**: Go's 2-3x memory overhead means you need 100-150 GB of RAM instead of 50 GB.

3. **GC tuning limits**: With `GOGC=100` (default), Go tries to keep total memory at 2x the live set. With 50 GB live, you need 100 GB before a GC cycle completes. Lowering GOGC increases GC frequency and CPU usage.

4. **Custom allocators**: In C++, you can use arena allocators, memory-mapped files, or custom data structures that minimize pointer chasing, all impossible in Go.

5. **Pointer-free optimization**: If the index data is pointer-free (integers, fixed-size strings), C++ can allocate it in flat arrays. Go's GC would still need to scan memory that contains no pointers, wasting CPU.

However, if the 50 GB index is read-heavy with rare updates, and latency requirements are moderate (tens of ms), Go could work. The key question is: what are your latency requirements at P99.99?

### Question 6: Debugging (Senior)

**Q:** Your C++ service crashes intermittently in production. Core dumps show the crash is in `free()`. What are the most likely causes and how do you investigate?

**A:** Crashes in `free()` indicate heap corruption. Most likely causes:

1. **Double free**: Same pointer freed twice
2. **Buffer overflow**: Writing past the end of an allocation corrupts allocator metadata
3. **Use-after-free**: Writing to freed memory corrupts the free list
4. **Mismatched alloc/dealloc**: `malloc`'d pointer freed with `delete`

Investigation steps:
1. Run with AddressSanitizer (`-fsanitize=address`) in a staging environment to get a precise stack trace of the first illegal operation
2. If ASan is too slow for your workload, use `MALLOC_CHECK_=3` (glibc) to enable heap consistency checks
3. Check for missing virtual destructors in polymorphic base classes
4. Review all raw `new`/`delete` usage, convert to smart pointers
5. Enable core dump analysis with debug symbols: `addr2line` or `gdb` on the core

### Question 7: make_shared vs shared_ptr(new T) (Mid-level)

**Q:** What is the difference between `std::make_shared<T>(args)` and `std::shared_ptr<T>(new T(args))`? When would you prefer one over the other?

**A:** `make_shared` performs a single allocation for both the object and the control block (reference count metadata). The two-step construction with `new` performs two separate allocations.

Benefits of `make_shared`:
- **One allocation instead of two**: Faster, less fragmentation
- **Better cache locality**: Object and control block are adjacent in memory
- **Exception safety**: In `f(shared_ptr<A>(new A), shared_ptr<B>(new B))`, if `new A` succeeds but `shared_ptr` construction fails before taking ownership, `A` leaks. `make_shared` avoids this

Drawback of `make_shared`:
- The object's memory cannot be freed until all `weak_ptr`s are also gone. Since the object and control block share one allocation, the allocator cannot free the object portion independently. This matters for large objects with long-lived `weak_ptr` observers.

Use the two-step form when:
- You need a custom deleter (make_shared does not support custom deleters)
- You have large objects with long-lived weak_ptr references
- You need to construct from a raw pointer given by a C library

### Question 8: Virtual Destructor (Junior/Mid)

**Q:** What happens if a base class does not have a virtual destructor and you delete a derived object through a base pointer?

**A:** Undefined behavior. In practice, only the base class destructor runs, and the derived class's destructor (and any resources it manages) is skipped. This causes resource leaks and potentially heap corruption.

```cpp
// BUGGY
class Base {
public:
    ~Base() { std::cout << "~Base\n"; }  // NOT virtual
};

class Derived : public Base {
    int* data_;
public:
    Derived() : data_(new int[1000]) {}
    ~Derived() { delete[] data_; std::cout << "~Derived\n"; }
};

void bug() {
    Base* ptr = new Derived();
    delete ptr;  // Only ~Base runs! ~Derived never called. data_ leaks.
}

// FIXED
class Base {
public:
    virtual ~Base() { std::cout << "~Base\n"; }  // Virtual!
};
// Now delete ptr calls ~Derived first, then ~Base. Correct.
```

**Rule:** If a class has any virtual functions, it must have a virtual destructor. If a class is designed to be a base class, give it a virtual destructor.

### Question 9: enable_shared_from_this (Senior)

**Q:** What is `std::enable_shared_from_this`, and when do you need it?

**A:** When an object managed by `shared_ptr` needs to create additional `shared_ptr`s to itself (e.g., to register itself with a callback system or pass `this` to an async operation), it cannot simply construct `shared_ptr<T>(this)`, that would create a second control block and lead to double-free.

`enable_shared_from_this<T>` provides a `shared_from_this()` method that returns a `shared_ptr` sharing the existing control block.

```cpp
class AsyncTask : public std::enable_shared_from_this<AsyncTask> {
    std::string name_;
public:
    AsyncTask(std::string name) : name_(std::move(name)) {}
    
    void start() {
        // Capture a shared_ptr to this for the async callback
        auto self = shared_from_this();
        
        threadPool.submit([self]() {
            // self keeps the AsyncTask alive until the lambda completes
            self->execute();
        });
    }
    
    void execute() {
        std::cout << "Executing: " << name_ << "\n";
    }
};

// CORRECT usage:
auto task = std::make_shared<AsyncTask>("download");
task->start();
// task may go out of scope, but the lambda holds a shared_ptr keeping it alive

// INCORRECT: calling shared_from_this on a non-shared object
// AsyncTask t("bad");
// t.start();  // UNDEFINED BEHAVIOR: t is not managed by shared_ptr
```

### Question 10: Allocator-Aware Containers (Staff)

**Q:** How would you design a system where HTTP request processing allocates zero heap memory?

**A:** Use a per-request arena allocator with allocator-aware containers:

1. Pre-allocate a stack buffer (or thread-local buffer) large enough for typical requests
2. Create an arena allocator backed by that buffer
3. Use `std::pmr::` (polymorphic memory resource) containers with the arena
4. When the request completes, reset the arena (one operation frees all allocations)

```cpp
#include <memory_resource>
#include <vector>
#include <string>

void handleHttpRequest() {
    // Stack-based buffer for this request (no heap allocation)
    char buffer[65536];
    std::pmr::monotonic_buffer_resource arena(buffer, sizeof(buffer));
    
    // All allocations come from the stack buffer
    std::pmr::vector<std::pmr::string> headers(&arena);
    headers.push_back("Content-Type: application/json");
    headers.push_back("X-Request-Id: abc123");
    
    std::pmr::string body(&arena);
    body = R"({"status": "ok", "data": [1, 2, 3]})";
    
    // Process request...
    
    // When this function returns, the stack buffer is automatically freed.
    // No heap allocation occurred. No fragmentation. No GC pressure.
}
```

This pattern is used at FAANG companies for latency-sensitive services. It eliminates allocator contention, heap fragmentation, and GC overhead entirely.

---
