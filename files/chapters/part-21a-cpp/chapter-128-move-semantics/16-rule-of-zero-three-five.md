## Rule of Zero, Three, and Five

The "rule of N" guides which special member functions you write yourself. The rules evolved with the language. Today, the default is rule of zero (write none) and the exception is rule of five (write all five) when you own a resource directly.

### The Six Special Members

A C++ class has six special member functions:

1. Default constructor.
2. Destructor.
3. Copy constructor.
4. Copy assignment operator.
5. Move constructor.
6. Move assignment operator.

The compiler can implicitly declare each as defaulted or deleted. The rules for when implicit generation happens are intricate. The "rule of N" exists because once you write one, you usually need to think about all of them.

### Rule of Zero

If your class manages no resource directly, write none of the special members. Let the compiler default everything.

```cpp
class User {
    std::string name_;
    std::vector<int> scores_;
    std::shared_ptr<Connection> conn_;
public:
    User(std::string n, std::vector<int> s, std::shared_ptr<Connection> c)
        : name_(std::move(n)), scores_(std::move(s)), conn_(std::move(c)) {}
};
```

The compiler generates:

- A defaulted copy constructor (copies each member).
- A defaulted copy assignment (copies each member).
- A defaulted move constructor (moves each member, noexcept iff all members are noexcept-movable).
- A defaulted move assignment (same).
- A defaulted destructor.

This is correct, exception-safe, and noexcept-correct. Each member's special member runs. `std::string` and `std::vector` know how to copy and move themselves. `std::shared_ptr` handles its own reference counting.

The C++ Core Guideline C.20: "If you can avoid defining default operations, do." This is rule of zero stated as a rule.

### Rule of Three (Pre-C++11)

In C++03, if a class manages a resource directly (a raw pointer to memory it owns, a file handle, etc.), you needed to write three operations:

1. Destructor (release the resource).
2. Copy constructor (deep copy the resource).
3. Copy assignment (release old, deep copy new).

If you wrote one, you probably needed all three. Forgetting any of the three caused leaks, double-frees, or shallow copies that crashed.

```cpp
class StringPre11 {
    char* data_;
    std::size_t len_;
public:
    StringPre11(const char* s) {
        len_ = std::strlen(s);
        data_ = new char[len_ + 1];
        std::strcpy(data_, s);
    }
    ~StringPre11() { delete[] data_; }

    StringPre11(const StringPre11& o) {
        len_ = o.len_;
        data_ = new char[len_ + 1];
        std::strcpy(data_, o.data_);
    }

    StringPre11& operator=(const StringPre11& o) {
        if (this != &o) {
            delete[] data_;
            len_ = o.len_;
            data_ = new char[len_ + 1];
            std::strcpy(data_, o.data_);
        }
        return *this;
    }
};
```

This was the bread and butter of C++03 resource management.

### Rule of Five (C++11 and Later)

C++11 added move semantics, which means two more operations: move constructor and move assignment. If you write any of the five (destructor, copy ctor, copy assign, move ctor, move assign), you should think about all five.

```cpp
class String {
    char* data_ = nullptr;
    std::size_t len_ = 0;
public:
    String() = default;

    explicit String(const char* s)
        : len_(std::strlen(s)), data_(new char[len_ + 1]) {
        std::memcpy(data_, s, len_ + 1);
    }

    ~String() { delete[] data_; }

    String(const String& o)
        : len_(o.len_), data_(new char[o.len_ + 1]) {
        std::memcpy(data_, o.data_, len_ + 1);
    }

    String& operator=(const String& o) {
        if (this != &o) {
            char* nd = new char[o.len_ + 1];
            std::memcpy(nd, o.data_, o.len_ + 1);
            delete[] data_;
            data_ = nd;
            len_ = o.len_;
        }
        return *this;
    }

    String(String&& o) noexcept
        : data_(std::exchange(o.data_, nullptr)),
          len_(std::exchange(o.len_, 0)) {}

    String& operator=(String&& o) noexcept {
        if (this != &o) {
            delete[] data_;
            data_ = std::exchange(o.data_, nullptr);
            len_ = std::exchange(o.len_, 0);
        }
        return *this;
    }
};
```

Each operation has a clear contract. The destructor releases. Copies allocate. Moves transfer ownership and leave the source empty.

Real production code rarely looks like this. You wrap the resource in `std::unique_ptr<char[]>` or `std::vector<char>` and the rule of zero takes over.

### Implicit Deletion Rules

The compiler's implicit generation rules cause many surprises:

- If you declare any copy operation, the move operations are not implicitly declared. They behave as if deleted.
- If you declare any move operation, the copy operations are implicitly deleted.
- If you declare a destructor, the move operations are not implicitly declared (but the implicit copy is still generated, deprecated since C++11).

The deprecation: a class with a user-declared destructor still gets an implicit copy. C++11 deprecated this because such classes usually manage a resource and the implicit copy is wrong. The deprecation has not been removed because it would break too much existing code.

The practical lesson: if you declare any of the five, declare all five (or default/delete them explicitly). C++ Core Guideline C.21.

### Defaulting and Deleting

`= default` asks the compiler for the default implementation. `= delete` makes the operation ill-formed to call.

```cpp
class Polymorphic {
public:
    virtual ~Polymorphic() = default;     // explicit virtual destructor
    Polymorphic() = default;
    Polymorphic(const Polymorphic&) = default;
    Polymorphic& operator=(const Polymorphic&) = default;
    Polymorphic(Polymorphic&&) = default;
    Polymorphic& operator=(Polymorphic&&) = default;
};
```

Explicit defaults document intent and re-enable implicit generation that the destructor would have suppressed.

```cpp
class Singleton {
public:
    Singleton(const Singleton&) = delete;
    Singleton& operator=(const Singleton&) = delete;
};
```

Deleted copies prevent duplication. The class is also implicitly non-movable because move operations are not generated when copy operations are user-declared.

If you want move-only:

```cpp
class MoveOnly {
public:
    MoveOnly(const MoveOnly&) = delete;
    MoveOnly& operator=(const MoveOnly&) = delete;
    MoveOnly(MoveOnly&&) = default;
    MoveOnly& operator=(MoveOnly&&) = default;
};
```

If you want immovable (cannot be copied or moved):

```cpp
class Pinned {
public:
    Pinned(const Pinned&) = delete;
    Pinned& operator=(const Pinned&) = delete;
    Pinned(Pinned&&) = delete;
    Pinned& operator=(Pinned&&) = delete;
};
```

`std::mutex`, `std::once_flag`, and types with a stable address (intrusive list nodes, type-erased polymorphic bases) are pinned.

### When to Write Each

| You... | Implies |
|--------|---------|
| Own raw resources (file descriptor, malloc'd memory). | Rule of five. |
| Wrap RAII types only (`unique_ptr`, `vector`, `string`). | Rule of zero. |
| Need polymorphism. | Virtual destructor, default the rest, consider deleting copy/move and exposing `clone()`. |
| Want move-only semantics. | Default move, delete copy. |
| Want pinned (no copy, no move). | Delete all four assignment/construction operations except default. |

### Rule of Zero with Polymorphism

A polymorphic base needs a virtual destructor. Once you declare one, the rule of zero is partially compromised: implicit moves disappear.

```cpp
class Shape {
public:
    virtual ~Shape() = default;
    Shape() = default;
    Shape(const Shape&) = default;
    Shape& operator=(const Shape&) = default;
    Shape(Shape&&) noexcept = default;
    Shape& operator=(Shape&&) noexcept = default;

    virtual std::unique_ptr<Shape> clone() const = 0;
};
```

You either default all five explicitly, or you delete copy/move on the base and rely on polymorphic ownership through pointers. Many codebases delete copy and move on bases to prevent slicing:

```cpp
class Shape {
public:
    virtual ~Shape() = default;
    Shape() = default;
    Shape(const Shape&) = delete;
    Shape& operator=(const Shape&) = delete;
    Shape(Shape&&) = delete;
    Shape& operator=(Shape&&) = delete;
    virtual std::unique_ptr<Shape> clone() const = 0;
};
```

You then own through `std::unique_ptr<Shape>` and never have a `Shape` value.

### C++ Core Guidelines C.20 and C.21

- C.20: "If you can avoid defining any default operations, do." (Rule of zero.)
- C.21: "If you define or `=delete` any default operation, define or `=delete` them all." (Rule of five.)
- C.22: "Make default operations consistent." (If your copy is shallow, your move should be too.)

### Junior at FAANG vs Senior at FAANG

Junior writes a destructor "just to log destruction" and accidentally suppresses moves. The class becomes copy-only, performance regresses, nobody notices for two quarters. Senior knows that any user-declared destructor disables implicit move generation, defaults the moves explicitly, and writes a static_assert checking move-noexcept. Senior also pushes back on logging in destructors as a cross-cutting concern that should not live in domain types.

### Drill

1. You add `~Foo()` for logging. What happens to `Foo`'s move constructor? Not implicitly declared, copies are still made and moves silently turn into copies.
2. Your class has `std::unique_ptr` and nothing else. How many of the six should you write? Zero. Rule of zero.
3. You delete the copy constructor. What is the move constructor's status? Not implicitly declared (because copy is user-declared). The class is non-movable unless you default the move.
4. What does `Foo(Foo&&) = default;` produce when one member is non-movable? An implicitly deleted move (the defaulted member call would be ill-formed).
5. The C++ Core Guideline that says "follow the rule of five" is which one? C.21.
