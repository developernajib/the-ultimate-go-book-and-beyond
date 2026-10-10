## Smart Pointers Deep Dive

Smart pointers are RAII wrappers around raw pointers. They automate memory deallocation so you rarely need to write `delete` manually. Modern C++ (C++11 and later) provides three smart pointers in `<memory>`.

### std::unique_ptr: Exclusive Ownership

A `unique_ptr` owns its pointed-to object exclusively. There is exactly one `unique_ptr` pointing to any given object. When the `unique_ptr` is destroyed, the object is deleted.

```cpp
#include <memory>
#include <iostream>
#include <vector>

class HttpResponse {
    int statusCode_;
    std::string body_;
public:
    HttpResponse(int code, std::string body)
        : statusCode_(code), body_(std::move(body)) {
        std::cout << "Response created: " << statusCode_ << "\n";
    }
    ~HttpResponse() {
        std::cout << "Response destroyed: " << statusCode_ << "\n";
    }
    int status() const { return statusCode_; }
    const std::string& body() const { return body_; }
};

void uniquePtrBasics() {
    // Create using make_unique (preferred -- exception safe, single allocation)
    auto response = std::make_unique<HttpResponse>(200, "OK");
    
    std::cout << "Status: " << response->status() << "\n";
    std::cout << "Body: " << response->body() << "\n";
    
    // unique_ptr cannot be copied
    // auto copy = response;  // COMPILE ERROR
    
    // But it CAN be moved (transfers ownership)
    auto movedResponse = std::move(response);
    
    // response is now nullptr
    if (response == nullptr) {
        std::cout << "Original is null after move\n";
    }
    
    // movedResponse owns the object now
    std::cout << "Moved status: " << movedResponse->status() << "\n";
    
}  // movedResponse destroyed here, ~HttpResponse() called

// Passing unique_ptr to functions
void consumeResponse(std::unique_ptr<HttpResponse> resp) {
    // This function takes ownership. resp is destroyed when function returns.
    std::cout << "Consuming: " << resp->status() << "\n";
}

void inspectResponse(const HttpResponse& resp) {
    // Borrow without taking ownership -- pass the raw reference
    std::cout << "Inspecting: " << resp.status() << "\n";
}

void smartPointerPassing() {
    auto resp = std::make_unique<HttpResponse>(404, "Not Found");
    
    // Lend it (don't transfer ownership)
    inspectResponse(*resp);      // Dereference to get reference
    
    // Transfer ownership permanently
    consumeResponse(std::move(resp));  // resp is now null
}
```

#### unique_ptr with Custom Deleters

Sometimes you need to clean up resources that are not freed with `delete`. Custom deleters handle this:

```cpp
#include <memory>
#include <cstdio>

// Custom deleter for C FILE*
struct FileDeleter {
    void operator()(FILE* f) const {
        if (f) {
            std::cout << "Closing file\n";
            fclose(f);
        }
    }
};

void customDeleterExample() {
    // Using a functor
    std::unique_ptr<FILE, FileDeleter> file(fopen("data.txt", "r"));
    
    // Using a lambda
    auto fileL = std::unique_ptr<FILE, decltype(&fclose)>(
        fopen("data.txt", "r"), &fclose
    );
    
    // Using with C libraries (e.g., OpenSSL, SQLite)
    // auto ctx = std::unique_ptr<SSL_CTX, decltype(&SSL_CTX_free)>(
    //     SSL_CTX_new(TLS_method()), &SSL_CTX_free
    // );
    
    if (file) {
        char buf[256];
        while (fgets(buf, sizeof(buf), file.get())) {
            std::cout << buf;
        }
    }
    // fclose called automatically via FileDeleter
}
```

#### unique_ptr with Arrays

While `std::vector` is usually preferred, `std::unique_ptr<T[]>` manages dynamically allocated C-style arrays and automatically calls `delete[]` upon destruction:
```cpp
void arrayUniquePtr() {
    // unique_ptr supports array types
    auto arr = std::make_unique<int[]>(100);
    
    for (int i = 0; i < 100; ++i) {
        arr[i] = i * i;  // operator[] works
    }
    
    // delete[] is called automatically (not delete)
}
```

#### unique_ptr in Containers

Standard containers can store `std::unique_ptr` elements directly, enforcing unique ownership for every item while supporting move-only semantics:
```cpp
void uniquePtrInContainers() {
    // Vector of unique_ptrs -- each element is exclusively owned by the vector
    std::vector<std::unique_ptr<HttpResponse>> responses;
    
    responses.push_back(std::make_unique<HttpResponse>(200, "OK"));
    responses.push_back(std::make_unique<HttpResponse>(404, "Not Found"));
    responses.push_back(std::make_unique<HttpResponse>(500, "Error"));
    
    for (const auto& resp : responses) {
        std::cout << resp->status() << "\n";
    }
    
    // Moving an element out of the vector
    auto extracted = std::move(responses[0]);
    // responses[0] is now nullptr -- be careful!
}
```

**Go comparison:** `unique_ptr` is conceptually similar to a Go value that you pass by pointer. When a function takes a `*MyStruct`, there is an implicit understanding about who "owns" it, but Go does not enforce this at compile time. In C++, `unique_ptr` makes ownership explicit and enforced by the compiler.

### std::shared_ptr: Shared Ownership

A `shared_ptr` allows multiple pointers to share ownership of the same object. The object is deleted when the last `shared_ptr` pointing to it is destroyed. This is implemented via **reference counting**.

```cpp
#include <memory>
#include <iostream>
#include <vector>

class Config {
    std::string data_;
public:
    Config(std::string data) : data_(std::move(data)) {
        std::cout << "Config created\n";
    }
    ~Config() {
        std::cout << "Config destroyed\n";
    }
    const std::string& data() const { return data_; }
};

void sharedPtrBasics() {
    // Create using make_shared (preferred -- single allocation for object + control block)
    auto config = std::make_shared<Config>("production");
    
    std::cout << "Ref count: " << config.use_count() << "\n";  // 1
    
    {
        auto config2 = config;  // Copy: increments reference count
        std::cout << "Ref count: " << config.use_count() << "\n";  // 2
        
        auto config3 = config;  // Another copy
        std::cout << "Ref count: " << config.use_count() << "\n";  // 3
    }
    // config2 and config3 destroyed, ref count back to 1
    
    std::cout << "Ref count: " << config.use_count() << "\n";  // 1
    
}  // config destroyed, ref count hits 0, Config object is deleted
```

#### The Control Block

Every `shared_ptr` group has a **control block** that stores the reference count and other metadata. Understanding its layout is crucial for performance analysis:

```
    shared_ptr<Config> sp1 ----+
    shared_ptr<Config> sp2 ----+----> Control Block          Config Object
    shared_ptr<Config> sp3 ----+      +------------------+   +-------------+
                                      | strong_count: 3  |   | data_: ...  |
                                      | weak_count: 1    |   +-------------+
                                      | deleter (opt.)   |         ^
                                      | allocator (opt.) |         |
                                      | ptr to object ---------->-+
                                      +------------------+
    
    make_shared optimization: single allocation for both
    +------------------+-------------+
    | Control Block    | Config Obj  |   <-- one malloc call, better cache locality
    | strong: 3        | data_: ...  |
    | weak: 1          |             |
    +------------------+-------------+
```

**Two allocation strategies:**

```cpp
void allocationStrategies() {
    // Strategy 1: make_shared -- ONE allocation (recommended)
    auto sp1 = std::make_shared<Config>("fast");
    // Allocates control block + Config object in one block
    // Better cache locality, fewer allocator calls
    
    // Strategy 2: new + shared_ptr constructor -- TWO allocations
    std::shared_ptr<Config> sp2(new Config("slow"));
    // First allocation: new Config (the object)
    // Second allocation: control block (internal to shared_ptr)
    // Worse cache locality, more allocator calls
    
    // make_shared has one downside: the memory for the object cannot be freed
    // until all weak_ptrs are also gone (because object and control block
    // share one allocation). This matters for large objects with long-lived
    // weak_ptrs.
}
```

#### Thread Safety of shared_ptr

The reference count operations are **atomic** (thread-safe), but the pointed-to object is NOT automatically thread-safe:

```cpp
#include <thread>
#include <atomic>

void threadSafetyDemo() {
    auto config = std::make_shared<Config>("shared");
    
    // SAFE: copying/destroying shared_ptr from multiple threads
    // (reference count is atomic)
    std::thread t1([config]() {
        auto local = config;  // Atomic increment: safe
        std::cout << local->data() << "\n";
    });  // Atomic decrement: safe
    
    std::thread t2([config]() {
        auto local = config;  // Atomic increment: safe
        std::cout << local->data() << "\n";
    });
    
    t1.join();
    t2.join();
    
    // NOT SAFE: modifying the shared_ptr itself from multiple threads
    // (the pointer variable, not the reference count)
    // std::thread t3([&config]() {
    //     config = std::make_shared<Config>("new"); // DATA RACE on config itself
    // }); // Use std::atomic<std::shared_ptr<T>> in C++20 for this case
}
```

### std::weak_ptr: Non-Owning Observer

A `weak_ptr` observes a `shared_ptr`-managed object without affecting its lifetime. It does not increment the strong reference count. Before using the object, you must `lock()` the weak_ptr to get a temporary `shared_ptr`.

```cpp
#include <memory>
#include <iostream>
#include <unordered_map>

// Use case 1: Breaking circular references
class Employee;
class Department {
public:
    std::string name;
    std::vector<std::shared_ptr<Employee>> employees;  // Owns employees
    
    ~Department() { std::cout << "Department " << name << " destroyed\n"; }
};

class Employee {
public:
    std::string name;
    std::weak_ptr<Department> department;  // Does NOT own department (breaks cycle)
    
    ~Employee() { std::cout << "Employee " << name << " destroyed\n"; }
    
    void printDepartment() {
        if (auto dept = department.lock()) {  // Attempt to get shared_ptr
            std::cout << name << " works in " << dept->name << "\n";
        } else {
            std::cout << name << "'s department no longer exists\n";
        }
    }
};

void circularReferenceDemo() {
    auto dept = std::make_shared<Department>();
    dept->name = "Engineering";
    
    auto emp = std::make_shared<Employee>();
    emp->name = "Alice";
    emp->department = dept;   // weak_ptr assignment from shared_ptr
    dept->employees.push_back(emp);
    
    emp->printDepartment();   // "Alice works in Engineering"
    
    dept.reset();             // Department destroyed
    emp->printDepartment();   // "Alice's department no longer exists"
}
```

#### Cache Implementation with weak_ptr

`std::weak_ptr` is ideal for in-memory caches where cached items can be evicted automatically once all active consumers release their `std::shared_ptr` handles:
```cpp
// Use case 2: Cache that doesn't prevent cleanup
class TextureCache {
    std::unordered_map<std::string, std::weak_ptr<Texture>> cache_;
    
public:
    std::shared_ptr<Texture> getTexture(const std::string& path) {
        auto it = cache_.find(path);
        if (it != cache_.end()) {
            // Try to lock the weak_ptr
            if (auto texture = it->second.lock()) {
                std::cout << "Cache hit: " << path << "\n";
                return texture;  // Still alive, return it
            }
            // Object was destroyed, remove stale entry
            cache_.erase(it);
        }
        
        // Cache miss: load and cache
        auto texture = std::make_shared<Texture>(path);
        cache_[path] = texture;  // Store as weak_ptr (won't prevent cleanup)
        return texture;
    }
    
    void purgeStale() {
        for (auto it = cache_.begin(); it != cache_.end(); ) {
            if (it->second.expired()) {
                it = cache_.erase(it);
            } else {
                ++it;
            }
        }
    }
};
```

#### Observer Pattern with weak_ptr

Event broadcaster systems use `std::weak_ptr` to maintain observer lists without preventing subscriber objects from being destroyed when they leave scope:
```cpp
class EventEmitter {
    std::vector<std::weak_ptr<EventListener>> listeners_;
    
public:
    void subscribe(std::shared_ptr<EventListener> listener) {
        listeners_.push_back(listener);  // Store as weak_ptr
    }
    
    void emit(const Event& event) {
        // Iterate and auto-clean dead listeners
        auto it = listeners_.begin();
        while (it != listeners_.end()) {
            if (auto listener = it->lock()) {
                listener->onEvent(event);
                ++it;
            } else {
                it = listeners_.erase(it);  // Listener was destroyed
            }
        }
    }
};
```

### Smart Pointer Decision Guide

Use the following decision tree to choose the most efficient and safe pointer abstraction for any scenario:
```
    Do you need heap allocation?
    |
    +-- No --> Use stack allocation (local variable)
    |
    +-- Yes --> Does the object have a single owner?
               |
               +-- Yes --> Use std::unique_ptr
               |           |
               |           +-- Need custom cleanup? --> Use custom deleter
               |           +-- Passing to function? --> Pass by reference (borrow)
               |                                       or std::move (transfer)
               |
               +-- No --> Is ownership truly shared?
                          |
                          +-- Yes --> Use std::shared_ptr
                          |           |
                          |           +-- Need non-owning reference? --> Use std::weak_ptr
                          |           +-- Possible cycles? --> Break with std::weak_ptr
                          |
                          +-- No --> Reconsider design.
                                    Most "shared" ownership can be
                                    refactored to single ownership.
```

**Go comparison:** Go has no smart pointer equivalents because the garbage collector handles all of this. The GC traces live references and frees unreachable objects. This means Go developers never worry about cycles (the GC handles them), ownership (there is no ownership), or reference counting (the GC uses tracing, not counting). The trade-off is GC pause latency and higher memory overhead.

---

### Junior → FAANG: Building the Smart Pointer Intuition Before Using Raw Pointers

The default for every new allocation in modern C++ should be `unique_ptr`. Only escalate to `shared_ptr` when you have proven that ownership is genuinely shared. Never use raw owning pointers. This is not a style preference. It is the rule in every serious C++ style guide (Google, LLVM, C++ Core Guidelines).

The most common junior mistake is reaching for `shared_ptr` for everything because it "feels safer." `shared_ptr` has a thread-safe reference count (atomic increment/decrement) that costs real performance. A hot path with many `shared_ptr` copies has measurable overhead from atomic operations. Use `unique_ptr` by default, pass by `const T&` when you do not transfer ownership, and use `shared_ptr` only when the documentation explicitly states that ownership is shared.

Interview preparation: be able to explain `shared_ptr` cycle detection (it cannot, use `weak_ptr` to break cycles) and `weak_ptr::lock()` (returns an empty `shared_ptr` if the object has been destroyed). These are common interview questions.

### Senior @ FAANG: Smart Pointer Policy, Ownership Documentation, and `shared_ptr` Audit

At the staff level, smart pointer usage is a performance and correctness policy, not a personal choice.

**Ownership documentation standard.** Every C++ API that takes or returns a pointer should document its ownership semantics explicitly. Google's Abseil uses comment annotations: `// Takes ownership`, `// Caller retains ownership`, `// Unowned`. A staff engineer defines the convention for their team and enforces it in code review. Ownership ambiguity is the root cause of both memory leaks and double-free bugs.

**`shared_ptr` audit as a performance investigation tool.** When a C++ service shows unexpected CPU usage from atomic operations, a `shared_ptr` audit is often the first step. Tools: `perf` to find functions spending time in `__atomic_fetch_add`, then tracing which `shared_ptr` copies are happening in the hot path. Common findings: a `shared_ptr` captured by value in a lambda that is called millions of times, or a container of `shared_ptr` whose elements are accessed in a tight loop. Each finding translates to either converting to `unique_ptr` (if ownership allows) or capturing by raw pointer (with lifetime documented and ASan coverage in tests).

**`enable_shared_from_this` hazards.** The `enable_shared_from_this` pattern (calling `shared_from_this()` inside a member function to get a `shared_ptr` to `this`) is essential for async callbacks but has two serious hazards: calling `shared_from_this()` before the object is managed by any `shared_ptr` is UB, and circular references between objects that both use `enable_shared_from_this` with `shared_ptr` members create memory leaks. A staff engineer adds a code review checklist item: any class inheriting `enable_shared_from_this` must be created exclusively via a factory function that returns `shared_ptr`, and all back-references from child to parent must be `weak_ptr`.

