## Destructors and RAII

### Deterministic Cleanup

A destructor runs automatically when an object goes out of scope (stack objects) or is explicitly deleted (heap objects). This is deterministic: you know exactly when cleanup happens.

```cpp
#include <fstream>
#include <iostream>
#include <string>

class FileWriter {
public:
    FileWriter(const std::string& filename)
        : file_(filename, std::ios::out) {
        if (!file_.is_open()) {
            throw std::runtime_error("Cannot open file: " + filename);
        }
        std::cout << "File opened: " << filename << "\n";
    }

    ~FileWriter() {
        if (file_.is_open()) {
            file_.close();
            std::cout << "File closed\n";
        }
    }

    void write(const std::string& data) {
        file_ << data;
    }

private:
    std::ofstream file_;
};

void processData() {
    FileWriter writer("output.txt"); // constructor opens file
    writer.write("Hello, RAII!\n");
    // destructor automatically closes file when writer goes out of scope
    // even if an exception is thrown between construction and here
}
```

### RAII: Resource Acquisition Is Initialization

RAII is the most important idiom in C++. The idea: tie resource lifetime (memory, file handles, mutexes, network connections) to object lifetime. Acquire in the constructor, release in the destructor. This guarantees cleanup even when exceptions unwind the stack.

```cpp
#include <mutex>
#include <iostream>

class ThreadSafeCounter {
public:
    void increment() {
        std::lock_guard<std::mutex> lock(mutex_); // RAII: acquires lock
        ++count_;
        // lock_guard destructor releases the mutex, even if an exception occurs
    }

    int get() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return count_;
    }

private:
    mutable std::mutex mutex_;
    int count_ = 0;
};
```

**Go comparison:** Go uses `defer` for cleanup. It is not tied to object lifetime but to function scope:

```go
func processData() error {
    f, err := os.Create("output.txt")
    if err != nil {
        return err
    }
    defer f.Close() // runs when processData returns

    _, err = f.WriteString("Hello, defer!\n")
    return err
}

func increment(mu *sync.Mutex, count *int) {
    mu.Lock()
    defer mu.Unlock() // released when function returns
    *count++
}
```

**Key differences:**

| Aspect | C++ RAII | Go defer |
|---|---|---|
| Tied to | Object lifetime (scope) | Function return |
| Granularity | Any scope (block, function, loop body) | Function-level only |
| Exception safety | Yes, destructors run during stack unwinding | N/A (Go uses panic/recover, not exceptions) |
| Composability | Objects nested in other objects chain destruction | defer calls are flat within a function |
| Performance | Zero overhead (compiler inlines destructors) | Small overhead per deferred call |

### Smart Pointers as RAII

The standard library provides RAII wrappers for heap memory:

```cpp
#include <memory>

class Connection {
public:
    Connection(const std::string& url) : url_(url) {
        std::cout << "Connected to " << url_ << "\n";
    }
    ~Connection() {
        std::cout << "Disconnected from " << url_ << "\n";
    }
    void query(const std::string& q) {
        std::cout << "Querying: " << q << "\n";
    }
private:
    std::string url_;
};

void doWork() {
    // unique_ptr: exclusive ownership, zero overhead
    auto conn = std::make_unique<Connection>("db://localhost:5432");
    conn->query("SELECT * FROM users");
    // Connection destructor called automatically when conn goes out of scope

    // shared_ptr: shared ownership, reference counted
    auto shared_conn = std::make_shared<Connection>("db://remote:5432");
    auto another_ref = shared_conn; // refcount = 2
    // Connection destructor called when last shared_ptr is destroyed
}
```

---

### Junior → FAANG: RAII as the Most Important Pattern in C++

If there is one pattern that separates C++ engineers who write safe code from those who do not, it is RAII. Every resource (memory, file handle, mutex lock, database connection, network socket) should be wrapped in a type whose destructor releases the resource. This makes resource leaks structurally impossible when no exceptions or early returns are possible to forget.

The Go equivalent of RAII is `defer`: you explicitly write the cleanup. RAII is stronger: the cleanup is automatic and cannot be forgotten. The downside is that C++ RAII requires writing wrapper types, while Go `defer` works on any existing API.

Practice: take three resources in the system you are working on (a file, a socket, a lock) and verify that each is managed by an RAII wrapper. If any is managed by manual cleanup, write the RAII wrapper and replace the manual cleanup. This is the single most impactful safety improvement you can make to legacy C++ code.

### Senior @ FAANG: RAII at Scale: Scope Guards, Transaction Patterns, and Exception Safety

At the staff level, RAII is not just about memory. It is about correctness guarantees for any stateful operation. Exception safety (the guarantee that a function leaves program state consistent even when an exception is thrown) is implemented entirely through RAII in modern C++.

**Scope guards for non-RAII APIs.** When a C API or legacy C++ API does not provide an RAII wrapper, a scope guard provides RAII semantics without a custom class. The pattern: `auto guard = absl::MakeCleanup([&] { cleanup_fn(); });`. The cleanup runs when the guard goes out of scope, whether normally or via exception. A staff engineer adds scope guards rather than `goto cleanup` or repeated cleanup at every return point, which is a code review policy: no function should have more than one cleanup path.

**Transaction pattern.** For operations that must be atomic (either all succeed or all roll back), the RAII transaction pattern is: acquire all resources in the constructor (or return error from factory), perform the work, call `commit()` to confirm the work (which disarms the rollback destructor). If `commit()` is not called before destruction, the destructor rolls back all changes. This pattern is used in database engines (RocksDB's `WriteBatch`) and distributed systems (two-phase commit clients). A staff engineer recognizes this pattern in code review and verifies that every exception path correctly rolls back.

**Exception safety guarantees as API contracts.** Every function in a well-designed C++ API has an explicit exception safety guarantee: basic (program state remains valid, no resources leaked), strong (operation either completes fully or has no effect), or nothrow (operation never throws, marked `noexcept`). A staff engineer requires that new API functions document their exception safety guarantee in the header comment, and code reviews verify that the implementation satisfies the stated guarantee.

