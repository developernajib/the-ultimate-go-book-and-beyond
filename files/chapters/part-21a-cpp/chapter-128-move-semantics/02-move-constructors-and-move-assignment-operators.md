## Move Constructors and Move Assignment Operators

A class supports move semantics by defining a **move constructor** and a **move assignment operator**. These are the functions called when constructing or assigning from an rvalue.

### Anatomy of a Movable Class

A movable class needs both a move constructor and a move assignment operator. The move constructor steals the heap buffer from the source (transferring ownership of `data_`), sets the source pointer to `nullptr` so its destructor becomes a no-op, and marks the function `noexcept` so standard library containers can choose move over copy when resizing.
```cpp
#include <algorithm>
#include <cstring>
#include <iostream>
#include <utility>

class Buffer {
public:
    // Constructor
    explicit Buffer(size_t size)
        : data_(new char[size]), size_(size) {
        std::memset(data_, 0, size_);
        std::cout << "  Constructed: " << size_ << " bytes\n";
    }

    // Destructor
    ~Buffer() {
        delete[] data_;
        std::cout << "  Destroyed: "
                  << (data_ ? std::to_string(size_) + " bytes" : "empty")
                  << "\n";
    }

    // Copy constructor - deep copy
    Buffer(const Buffer& other)
        : data_(new char[other.size_]), size_(other.size_) {
        std::memcpy(data_, other.data_, size_);
        std::cout << "  Copied: " << size_ << " bytes\n";
    }

    // Copy assignment operator - deep copy
    Buffer& operator=(const Buffer& other) {
        if (this != &other) {
            delete[] data_;
            data_ = new char[other.size_];
            size_ = other.size_;
            std::memcpy(data_, other.data_, size_);
            std::cout << "  Copy-assigned: " << size_ << " bytes\n";
        }
        return *this;
    }

    // Move constructor - transfer ownership
    Buffer(Buffer&& other) noexcept
        : data_(other.data_), size_(other.size_) {
        other.data_ = nullptr;
        other.size_ = 0;
        std::cout << "  Moved: " << size_ << " bytes\n";
    }

    // Move assignment operator - transfer ownership
    Buffer& operator=(Buffer&& other) noexcept {
        if (this != &other) {
            delete[] data_;          // Release current resources
            data_ = other.data_;     // Steal the pointer
            size_ = other.size_;
            other.data_ = nullptr;   // Leave source in valid state
            other.size_ = 0;
            std::cout << "  Move-assigned: " << size_ << " bytes\n";
        }
        return *this;
    }

    size_t size() const { return size_; }

private:
    char* data_;
    size_t size_;
};
```

The move constructor and move assignment operator share a pattern:

1. **Steal the resources** from the source by copying its internal pointers and sizes.
2. **Null out the source** so its destructor does not release the stolen resources.
3. **Mark as `noexcept`**, this is critical (explained below).

### When Move vs. Copy Is Called

The compiler selects copy or move based on value category: an lvalue (named variable `a`) invokes the copy constructor. An xvalue produced by `std::move(a)` invokes the move constructor. A prvalue (temporary returned from a function) typically elides the constructor entirely via RVO. After a move, `a` is in a valid but unspecified state, do not read from it.
```cpp
Buffer create_buffer() {
    return Buffer(1024);  // May use RVO (covered later)
}

int main() {
    std::cout << "--- Construction from prvalue ---\n";
    Buffer a(4096);

    std::cout << "\n--- Copy construction ---\n";
    Buffer b(a);                    // 'a' is lvalue → copy constructor

    std::cout << "\n--- Move construction ---\n";
    Buffer c(std::move(a));         // std::move(a) is xvalue → move constructor

    std::cout << "\n--- Copy assignment ---\n";
    Buffer d(2048);
    d = b;                          // 'b' is lvalue → copy assignment

    std::cout << "\n--- Move assignment ---\n";
    d = std::move(b);              // std::move(b) is xvalue → move assignment

    std::cout << "\n--- Construction from temporary ---\n";
    Buffer e(Buffer(512));          // prvalue → move (or RVO eliminates it)

    std::cout << "\n--- Destructors ---\n";
    return 0;
}
```

### Why `noexcept` Matters

The `noexcept` specifier on move operations is not optional in practice. The standard library containers, particularly `std::vector`, will only use move operations during reallocation if those operations are `noexcept`. If your move constructor can throw, `vector` falls back to copying for exception safety.

```cpp
#include <iostream>
#include <vector>
#include <utility>

class ThrowingMove {
public:
    ThrowingMove() = default;
    ThrowingMove(const ThrowingMove&) { std::cout << "  copy\n"; }
    ThrowingMove(ThrowingMove&&) { std::cout << "  move\n"; }  // NOT noexcept
};

class SafeMove {
public:
    SafeMove() = default;
    SafeMove(const SafeMove&) { std::cout << "  copy\n"; }
    SafeMove(SafeMove&&) noexcept { std::cout << "  move\n"; }  // noexcept
};

int main() {
    std::cout << "--- ThrowingMove (vector reallocation uses COPY) ---\n";
    std::vector<ThrowingMove> v1;
    v1.reserve(2);
    v1.emplace_back();
    v1.emplace_back();
    std::cout << "Trigger realloc:\n";
    v1.emplace_back();  // Reallocation copies old elements

    std::cout << "\n--- SafeMove (vector reallocation uses MOVE) ---\n";
    std::vector<SafeMove> v2;
    v2.reserve(2);
    v2.emplace_back();
    v2.emplace_back();
    std::cout << "Trigger realloc:\n";
    v2.emplace_back();  // Reallocation moves old elements

    return 0;
}
```

### The Rule of Five

If you define any of the five special member functions (destructor, copy constructor, copy assignment, move constructor, move assignment), you should define all five. This is the **Rule of Five**, the C++11 extension of the Rule of Three.

```cpp
class Resource {
public:
    Resource();
    ~Resource();                                    // 1. Destructor
    Resource(const Resource& other);                // 2. Copy constructor
    Resource& operator=(const Resource& other);     // 3. Copy assignment
    Resource(Resource&& other) noexcept;            // 4. Move constructor
    Resource& operator=(Resource&& other) noexcept; // 5. Move assignment
};
```

Better yet, prefer the **Rule of Zero**: design your class so it owns no raw resources. Use `std::unique_ptr`, `std::shared_ptr`, `std::string`, and `std::vector` as members. The compiler-generated special members will do the right thing automatically.

```cpp
#include <memory>
#include <string>
#include <vector>

// Rule of Zero: no user-defined special members needed.
// The compiler generates correct copy/move/destroy operations.
class Employee {
    std::string name_;
    std::string department_;
    std::vector<std::string> skills_;
    std::unique_ptr<int[]> performance_history_;
    // unique_ptr makes this class move-only (non-copyable) automatically.
};
```

---

### Junior → FAANG: The Two Requirements for a Correct Move Constructor

Every move constructor must do two things: transfer the resources from the source to the destination, and leave the source in a valid state that the destructor can safely clean up. The most common mistake is forgetting the second step: not nulling out the source's pointer after transferring it, so when the source is destroyed, its destructor frees memory that is now owned by the destination.

Concrete checklist for writing a move constructor: (1) move each member (use `std::move` for class members that have their own move semantics), (2) set all raw pointer members of the source to `nullptr`, (3) set all size/capacity members of the source to 0, (4) mark the constructor `noexcept` if no operation in it can throw. Step 4 is critical for `std::vector` performance.

### Senior @ FAANG: `noexcept` Move Operations as a Correctness Requirement

At the staff level, `noexcept` on move constructors and move assignment operators is not an optimization hint. It is a correctness requirement for types used in standard containers.

`std::vector` provides the strong exception safety guarantee during reallocation (either all elements are moved to the new buffer, or the original buffer is unchanged). To satisfy this guarantee, `std::vector` uses `std::move_if_noexcept`: it moves elements only if the move constructor is `noexcept`. Otherwise it copies. If your move constructor is not `noexcept`, `std::vector` falls back to copying, silently.

**Enforcement in CI.** A staff engineer adds a static assertion or clang-tidy check for all types that are stored in `std::vector` or moved through performance-critical paths: `static_assert(std::is_nothrow_move_constructible_v<T>)`. This catches the "silent copy" regression when someone adds a throwing operation to a move constructor.

**Move-only types for resource ownership.** Types that manage exclusive resources (file handles, sockets, GPU contexts) should be move-only: delete the copy constructor and copy assignment operator. This makes ownership transfer explicit and prevents accidental copies. The pattern is the same as Go's approach of using pointers for shared access, but with compile-time enforcement rather than runtime GC.

