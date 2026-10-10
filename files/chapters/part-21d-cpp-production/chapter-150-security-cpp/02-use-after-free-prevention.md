## Use-After-Free Prevention

Use-after-free (UAF) is the second major class of memory safety bugs behind buffer overflows. It happens when code holds a pointer or reference to memory that has already been deallocated, then reads or writes through it. The consequences range from information disclosure (reading what the next allocation placed in that memory) to full code execution (an attacker shapes heap layout so that freed memory is reallocated as a controlled object, then exploits the stale pointer to overwrite function pointers or vtable entries).

UAF is the root cause of the majority of Chrome browser exploits. The V8 JavaScript engine, Blink's DOM, and media decoders all represent complex object graphs with non-trivial lifetimes, precisely the conditions where UAF thrives.

Go's garbage collector makes UAF impossible: memory is only reclaimed when no live references point to it. C++ requires you to encode that guarantee in your design.

### What UAF Looks Like

The UAF pattern below shows a raw `Connection*` being deleted or having its resources freed in one code path while another code path still holds the pointer and calls methods on it. At the point of the second call, the pointer's target memory may have been reallocated and overwritten, turning the UAF into either a silent data corruption or a controllable write primitive that attackers can use for code execution.
```cpp
// UAF via raw pointer, classic pattern
struct Connection {
    void send(const std::string& msg);
    void close();
};

void handle_request(Connection* conn) {
    conn->close();      // frees internal resources, or caller deletes conn
    delete conn;
    conn->send("ok");   // UB: conn points to freed memory
                        // attacker may control what's now at that address
}
```

The compiler is not required to warn about this. The program may appear to work correctly in debug builds where the allocator zeroes or poisons freed memory, then fail catastrophically in release builds where the freed block is reused immediately.

```cpp
// UAF via iterator invalidation
void demo_iterator_uaf() {
    std::vector<int> v = {1, 2, 3};
    auto it = v.begin();        // points into v's internal buffer

    v.push_back(4);             // may reallocate, iterator now dangling
    v.push_back(5);             // definitely reallocated if capacity was 3

    *it = 99;                   // UAF: it points to freed old buffer
}
```

Iterator invalidation rules are documented for every container. Reallocation invalidates all iterators, pointers, and references into `std::vector`. Insertion into `std::list` does not. Know the rules and enforce them with ASan during testing.

### Prevention with `unique_ptr`

`unique_ptr` expresses single ownership explicitly. When the `unique_ptr` goes out of scope, the object is destroyed. No manual `delete`. No possibility of forgetting to delete. No possibility of double-free from two pointers to the same object.

```cpp
#include <memory>
#include <string>

struct Connection {
    explicit Connection(std::string id) : id_(std::move(id)) {}
    void send(const std::string& msg) { /* ... */ }
    std::string id_;
};

// Caller owns the connection via unique_ptr
std::unique_ptr<Connection> make_connection(std::string id) {
    return std::make_unique<Connection>(std::move(id));
}

void use_connection() {
    auto conn = make_connection("session-42");
    conn->send("hello");
    // conn destroyed here, automatic, deterministic
}

// Raw pointer for non-owning access: valid only while owner is alive
void log_connection(const Connection* conn) {
    // caller guarantees conn outlives this function
    // do not store conn, it's a non-owning observer
}
```

The rule: only one `unique_ptr` exists per object. If you need to pass the object to another function that will outlive the current scope, transfer ownership with `std::move`. If the callee only observes (does not outlive the owner), pass a raw pointer or reference, but document that contract.

### Prevention with `shared_ptr` and `weak_ptr`

When multiple owners share a resource with non-trivial lifetime, `shared_ptr` provides reference counting. `weak_ptr` breaks reference cycles and allows observing without extending lifetime.

```cpp
#include <memory>
#include <iostream>

struct Session {
    std::string token;
    explicit Session(std::string t) : token(std::move(t)) {}
    void process() { std::cout << "processing " << token << '\n'; }
};

class RequestHandler {
    std::weak_ptr<Session> session_;  // does not extend Session's lifetime
public:
    explicit RequestHandler(std::shared_ptr<Session> s) : session_(s) {}

    void handle() {
        // lock() returns shared_ptr if object is still alive, nullptr otherwise
        if (auto s = session_.lock()) {
            s->process();   // safe: object is confirmed alive
        } else {
            std::cerr << "session expired\n";  // handle gracefully
        }
    }
};

void demonstrate_weak_ptr() {
    auto session = std::make_shared<Session>("tok-abc");
    RequestHandler handler(session);

    handler.handle();               // succeeds: session alive

    session.reset();                // last shared_ptr gone, Session destroyed

    handler.handle();               // safe: lock() returns nullptr, no UAF
}
```

The key invariant: `weak_ptr::lock()` is atomic with respect to the reference count. There is no window between "check if alive" and "use" where the object can be destroyed.

### `std::enable_shared_from_this`

A common source of UAF is capturing `this` in a callback when the object is managed by `shared_ptr`. The raw `this` pointer does not extend lifetime, the object may be destroyed before the callback fires.

```cpp
#include <memory>
#include <functional>

// Unsafe: raw `this` captured in lambda, UAF if object is destroyed first
class UnsafeTimer {
public:
    void start() {
        schedule_callback([this]() {
            this->on_tick();  // UAF if UnsafeTimer is destroyed before callback fires
        });
    }
    void on_tick() {}
};

// Safe: shared_from_this() captures shared ownership
class SafeTimer : public std::enable_shared_from_this<SafeTimer> {
public:
    void start() {
        auto self = shared_from_this();  // extends lifetime through callback
        schedule_callback([self]() {
            self->on_tick();  // safe: self keeps object alive
        });
    }
    void on_tick() {}
};

// Must be constructed via shared_ptr for enable_shared_from_this to work
void use_safe_timer() {
    auto timer = std::make_shared<SafeTimer>();
    timer->start();
}
```

Never call `shared_from_this()` in a constructor, the `shared_ptr` control block does not exist yet.

### Lifetime Anti-Patterns

The following examples illustrate dangerous lifetime anti-patterns that frequently cause use-after-free vulnerabilities in C++:
```cpp
// Anti-pattern 1: raw pointer extracted from shared_ptr
std::shared_ptr<Session> global_session = make_shared_session();
Session* raw = global_session.get();
global_session.reset();     // shared_ptr gone
raw->process();             // UAF

// Anti-pattern 2: reference to local returned
const std::string& get_name() {
    std::string name = compute_name();
    return name;    // returns reference to destroyed local
}

// Anti-pattern 3: pointer stored across suspension point
std::vector<int> data = {1, 2, 3};
int* ptr = data.data();
co_await some_async_operation();  // data may have been moved or destroyed
*ptr = 99;                        // UAF
```

In async and coroutine code, assume that any suspension point may invalidate raw pointers into containers or local storage. Prefer value semantics or `shared_ptr` across suspension points.

### Static Analysis and Runtime Detection

`clang-tidy` with `cppcoreguidelines-pro-lifetime` performs static lifetime analysis, flagging pointers that may outlive their owners. Enable it in CI:

```bash
clang-tidy --checks='cppcoreguidelines-pro-lifetime,*' source.cpp
```

AddressSanitizer detects UAF at runtime with exact allocation and free stack traces:

```
ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010
READ of size 4 at 0x602000000010 thread T0
    #0 0x... in handle_request connection.cpp:18
PREVIOUSLY FREED by thread T0 here:
    #0 0x... in operator delete connection.cpp:16
ORIGINALLY ALLOCATED by thread T0 here:
    #0 0x... in make_connection connection.cpp:12
```

This output tells you exactly where the object was allocated, freed, and incorrectly accessed, enough to fix the bug without guessing.

---
