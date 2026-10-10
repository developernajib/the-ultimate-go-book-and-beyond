## RAII: Resource Acquisition Is Initialization

RAII is arguably the single most important concept in C++. If you learn nothing else from this chapter, learn RAII. It is the foundation upon which all modern C++ resource management is built.

### The Core Idea

RAII ties the lifetime of a resource (memory, file handle, mutex lock, network connection, database transaction) to the lifetime of an object. When the object is constructed, it acquires the resource. When the object is destroyed (goes out of scope), it releases the resource. **Destruction is guaranteed** even if an exception is thrown.

```
    RAII Lifecycle
    
    {                              // Scope begins
        Resource r(args);          // Constructor: acquire resource
        r.use();                   // Use the resource
        r.use();                   // Use the resource some more
        // ...
        if (error) throw Ex();     // Even if we throw...
    }                              // Scope ends: destructor runs, resource released
                                   // GUARANTEED cleanup, no matter how we exit
```

### RAII in Practice

RAII (Resource Acquisition Is Initialization) ties the lifetime of a resource to the lifetime of a stack-allocated object, guaranteeing cleanup even when exceptions are thrown. This idiom is the cornerstone of exception-safe C++ and the basis for all standard library resource wrappers.
```cpp
#include <fstream>
#include <mutex>
#include <memory>
#include <vector>
#include <stdexcept>

// Example 1: File handling with RAII
void processFile(const std::string& path) {
    std::ifstream file(path);  // Constructor opens the file
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open: " + path);
    }
    
    std::string line;
    while (std::getline(file, line)) {
        // process line...
        if (line == "CORRUPT") {
            throw std::runtime_error("Corrupt data");
            // file is STILL closed properly -- destructor runs during stack unwinding
        }
    }
    // file closed here by destructor, whether we threw or not
}

// Example 2: Mutex locking with RAII
class ThreadSafeCounter {
    mutable std::mutex mutex_;
    int count_ = 0;

public:
    void increment() {
        std::lock_guard<std::mutex> lock(mutex_);  // Acquires lock
        ++count_;
        // If ++count_ somehow threw, the lock is still released
    }  // lock_guard destructor releases mutex
    
    int get() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return count_;
    }  // lock released
};

// Example 3: Database transaction with RAII
class Transaction {
    Database& db_;
    bool committed_ = false;

public:
    explicit Transaction(Database& db) : db_(db) {
        db_.execute("BEGIN");
    }
    
    void execute(const std::string& sql) {
        db_.execute(sql);
    }
    
    void commit() {
        db_.execute("COMMIT");
        committed_ = true;
    }
    
    ~Transaction() {
        if (!committed_) {
            db_.execute("ROLLBACK");  // Auto-rollback if not committed
        }
    }
};

void transferFunds(Database& db, int from, int to, long long amountCents) {
    Transaction txn(db);  // BEGIN
    
    // Toy API for the RAII demonstration. Real code binds these values
    // as query parameters, never by building SQL from strings.
    txn.execute("UPDATE accounts SET balance_cents = balance_cents - " +
                std::to_string(amountCents) + " WHERE id = " + std::to_string(from));
    txn.execute("UPDATE accounts SET balance_cents = balance_cents + " +
                std::to_string(amountCents) + " WHERE id = " + std::to_string(to));
    
    // If anything above throws, ~Transaction() runs ROLLBACK
    txn.commit();  // COMMIT
}  // If commit succeeded, ~Transaction() sees committed_==true and does nothing
```

### Writing Your Own RAII Wrapper

While standard library types cover most resources, legacy C APIs (file descriptors, sockets, C libraries) often require custom RAII wrappers. Here is a generic wrapper pattern for any C-style resource:

```cpp
#include <cstdio>
#include <stdexcept>

// Generic RAII wrapper for any C-style resource
template<typename T, typename Deleter>
class ScopedResource {
    T resource_;
    Deleter deleter_;
    bool valid_;
    
public:
    explicit ScopedResource(T resource, Deleter deleter)
        : resource_(resource), deleter_(deleter), valid_(true) {}
    
    // Move-only (like unique_ptr)
    ScopedResource(ScopedResource&& other) noexcept
        : resource_(other.resource_), deleter_(other.deleter_), valid_(other.valid_) {
        other.valid_ = false;
    }
    
    ScopedResource& operator=(ScopedResource&& other) noexcept {
        if (this != &other) {
            if (valid_) deleter_(resource_);
            resource_ = other.resource_;
            deleter_ = other.deleter_;
            valid_ = other.valid_;
            other.valid_ = false;
        }
        return *this;
    }
    
    // No copying
    ScopedResource(const ScopedResource&) = delete;
    ScopedResource& operator=(const ScopedResource&) = delete;
    
    T get() const { return resource_; }
    
    ~ScopedResource() {
        if (valid_) deleter_(resource_);
    }
};

// Usage with a C file handle
void useFile() {
    auto file = ScopedResource<FILE*, decltype(&fclose)>(
        fopen("data.txt", "r"), &fclose
    );
    
    if (file.get() == nullptr) {
        throw std::runtime_error("Cannot open file");
    }
    
    char buffer[256];
    while (fgets(buffer, sizeof(buffer), file.get())) {
        // process...
    }
    // fclose called automatically
}
```

### Go Comparison: RAII vs defer

Go uses `defer` for cleanup, which serves a similar purpose but with key differences:

```go
// Go: defer for cleanup
func processFile(path string) error {
    file, err := os.Open(path)
    if err != nil {
        return err
    }
    defer file.Close()  // Runs when function returns
    
    scanner := bufio.NewScanner(file)
    for scanner.Scan() {
        // process...
    }
    return scanner.Err()
}
```

| Aspect | C++ RAII | Go `defer` |
|--------|----------|------------|
| Scope | Block scope (any `{}`) | Function scope only |
| Timing | End of enclosing block | End of function |
| Composability | Naturally composable | Must stack multiple defers |
| Forgettability | Impossible to forget (it's the type) | Easy to forget `defer` |
| Loop cleanup | Automatic per iteration | Defer in loop = deferred until func return |
| Cost | Zero runtime overhead | Small runtime overhead per defer |

The critical difference: RAII is **structural**, the cleanup is part of the type definition. You cannot create a `std::lock_guard` and forget to unlock. In Go, you can forget to write `defer file.Close()` and the compiler will not warn you.

---
