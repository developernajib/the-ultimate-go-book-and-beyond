## Constructors

C++ gives you six categories of constructors. Go gives you zero, relying on zero-value initialization and factory functions. Understanding C++ constructors is critical because they control object lifetime, resource acquisition, and copying semantics.

### Default Constructor

Called when an object is created without arguments. If you write no constructors at all, the compiler generates one (unless you define another constructor).

```cpp
class Logger {
public:
    Logger() : level_("INFO") {
        std::cout << "Logger created with default level\n";
    }

    std::string level() const { return level_; }

private:
    std::string level_;
};

// Usage
Logger log; // calls default constructor
```

**Go equivalent:** The zero value serves as the default constructor.

```go
type Logger struct {
    Level string // zero value is ""
}

// If you need non-zero defaults, use a factory
func NewLogger() *Logger {
    return &Logger{Level: "INFO"}
}
```

### Parameterized Constructor

Accepts arguments to initialize the object:

```cpp
class Rectangle {
public:
    Rectangle(double w, double h) : width_(w), height_(h) {}

    double area() const { return width_ * height_; }

private:
    double width_;
    double height_;
};

Rectangle r(10.0, 5.0); // parameterized construction
```

### Member Initializer Lists

The `: width_(w), height_(h)` syntax is the member initializer list. It initializes members directly rather than default-constructing then assigning. This matters for:

1. **`const` members** - must be initialized, cannot be assigned
2. **Reference members** - must be initialized at construction
3. **Members without default constructors** - must be explicitly initialized
4. **Performance** - avoids a default-construct-then-assign double initialization

```cpp
class Employee {
public:
    // CORRECT: initializer list
    Employee(std::string name, int id)
        : name_(std::move(name)), id_(id) {}

    // WRONG (compiles but wasteful): assignment in body
    // Employee(std::string name, int id) {
    //     name_ = name; // default-constructs name_ first, then assigns
    //     id_ = id;
    // }

private:
    std::string name_;
    const int id_; // const: MUST use initializer list
};
```

### Copy Constructor

Creates a new object as a copy of an existing one. The compiler generates one by default that performs a memberwise copy.

```cpp
class Buffer {
public:
    Buffer(size_t size) : size_(size), data_(new int[size]) {
        std::fill(data_, data_ + size_, 0);
    }

    // Copy constructor: deep copy
    Buffer(const Buffer& other) : size_(other.size_), data_(new int[other.size_]) {
        std::copy(other.data_, other.data_ + other.size_, data_);
        std::cout << "Copy constructor: deep copied " << size_ << " elements\n";
    }

    ~Buffer() { delete[] data_; }

    int& operator[](size_t i) { return data_[i]; }
    size_t size() const { return size_; }

private:
    size_t size_;
    int* data_;
};

Buffer a(100);
a[0] = 42;
Buffer b(a); // copy constructor: b gets its own memory with same values
```

**Go comparison:** Go copies structs by value automatically, but all copies are shallow. Slices, maps, and pointers inside a struct are not deep-copied:

```go
package main

type Buffer struct {
    Data []int
}

// For deep copy, you must be explicit:
func (buf Buffer) DeepCopy() Buffer {
    newData := make([]int, len(buf.Data))
    copy(newData, buf.Data)
    return Buffer{Data: newData}
}

func main() {
    a := Buffer{Data: make([]int, 100)}
    a.Data[0] = 42
    b := a          // shallow copy: b.Data points to SAME backing array
    b.Data[0] = 999 // also changes a.Data[0]!
    _ = b
}
```

### Move Constructor

Transfers ownership of resources from a temporary (rvalue) to a new object, avoiding expensive copies. This is one of C++'s most important performance features and has no direct Go equivalent.

```cpp
class Buffer {
public:
    Buffer(size_t size) : size_(size), data_(new int[size]) {
        std::fill(data_, data_ + size_, 0);
    }

    // Move constructor: steal resources from temporary
    Buffer(Buffer&& other) noexcept
        : size_(other.size_), data_(other.data_) {
        other.size_ = 0;
        other.data_ = nullptr; // leave source in valid but empty state
        std::cout << "Move constructor: transferred ownership\n";
    }

    ~Buffer() { delete[] data_; }

private:
    size_t size_;
    int* data_;
};

Buffer createLargeBuffer() {
    Buffer temp(1'000'000);
    return temp; // move constructor (or copy elision)
}

Buffer b = createLargeBuffer(); // no million-element copy
```

**Why Go does not need move semantics:** Go's garbage collector handles memory. Slices, maps, and channels are already reference types (they hold internal pointers). When you pass a slice, you copy the header (pointer, length, capacity), not the backing array. The GC decides when to free memory. C++ has no GC, so moving resources explicitly is the performance escape hatch.

### Delegating Constructors

One constructor calls another to avoid duplication:

```cpp
class Connection {
public:
    Connection(const std::string& host, int port, int timeout)
        : host_(host), port_(port), timeout_(timeout) {}

    // Delegates to the three-argument constructor
    Connection(const std::string& host, int port)
        : Connection(host, port, 30) {} // default timeout: 30 seconds

    // Delegates further
    Connection(const std::string& host)
        : Connection(host, 80) {} // default port: 80

    // Default
    Connection() : Connection("localhost") {}

private:
    std::string host_;
    int port_;
    int timeout_;
};

Connection c1;                        // localhost:80, timeout 30
Connection c2("example.com");         // example.com:80, timeout 30
Connection c3("example.com", 443);    // example.com:443, timeout 30
Connection c4("example.com", 443, 5); // example.com:443, timeout 5
```

**Go equivalent:** Use functional options or default values in a factory:

```go
type Connection struct {
    Host    string
    Port    int
    Timeout int
}

type Option func(*Connection)

func WithPort(p int) Option    { return func(c *Connection) { c.Port = p } }
func WithTimeout(t int) Option { return func(c *Connection) { c.Timeout = t } }

func NewConnection(host string, opts ...Option) *Connection {
    c := &Connection{Host: host, Port: 80, Timeout: 30}
    for _, opt := range opts {
        opt(c)
    }
    return c
}
```

### The `explicit` Keyword

Prevents implicit conversions through constructors:

```cpp
class Meters {
public:
    explicit Meters(double value) : value_(value) {}
    double value() const { return value_; }
private:
    double value_;
};

void printDistance(Meters m) {
    std::cout << m.value() << " meters\n";
}

// printDistance(3.14);       // ERROR: implicit conversion prevented
printDistance(Meters(3.14));  // OK: explicit construction
```

Without `explicit`, `printDistance(3.14)` would silently convert `3.14` to `Meters(3.14)`, which can hide bugs. Go handles this by not having implicit conversions at all. `Meters(3.14)` in Go is an explicit type conversion.

---

### Junior → FAANG: Memorizing the Constructor Hierarchy to Avoid Ordering Bugs

C++ member initialization order is determined by declaration order in the class, not by the order in the initializer list. This is a frequent source of bugs: initializing member B with the value of member A when A is declared after B in the class means A is uninitialized when B's initializer runs.

Rule: always write the initializer list in the same order as member declarations. Enable `-Wreorder` (GCC/Clang) to get a warning when they differ. This is a simple mechanical habit that prevents a whole class of bugs.

Interview tip: "what is the order of construction in C++?" The full answer: (1) base classes in declaration order, (2) member variables in declaration order, (3) constructor body. Knowing this order is required to reason about any non-trivial constructor.

### Senior @ FAANG: Constructor API Design for Large Codebases

At the staff level, constructor design is an API design problem: how does a user create a valid object, and how does the type system prevent invalid objects from existing?

**Factory function pattern over complex constructors.** When a constructor requires multiple steps that can fail, or when the initialization order has complex dependencies, prefer a static factory function that returns `unique_ptr<T>` or `absl::StatusOr<T>`. The factory can return an error if construction fails, which a constructor cannot (throwing exceptions is expensive and often disabled in embedded/HFT contexts, returning an error from a constructor is not possible without out-parameters or sentinel values). Google's Abseil explicitly recommends factory functions over complex constructors for this reason.

**`explicit` as a policy, not an option.** Every single-argument constructor that is not explicitly intended to be an implicit conversion should be `explicit`. Make this a code review policy: any new single-argument constructor without `explicit` requires a written justification for why implicit conversion is intended. The cost of a missing `explicit` is a silent type confusion bug that may appear months later in a distant call site.

