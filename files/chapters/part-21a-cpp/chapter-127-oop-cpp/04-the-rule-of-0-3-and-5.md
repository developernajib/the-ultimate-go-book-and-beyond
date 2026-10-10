## The Rule of 0, 3, and 5

These rules tell you how many special member functions you should define. Getting this wrong is the number one source of resource bugs in C++.

### The Six Special Member Functions

Every C++ class has up to six compiler-generated special member functions: destructor, copy constructor, copy assignment, move constructor, move assignment, and default constructor. Which of them you declare, delete, or default determines how your type copies, moves, and cleans up.
```
1. Default constructor          T()
2. Destructor                   ~T()
3. Copy constructor             T(const T&)
4. Copy assignment operator     T& operator=(const T&)
5. Move constructor             T(T&&)
6. Move assignment operator     T& operator=(T&&)
```

### Rule of Zero

If your class manages no resources directly (no raw pointers, no file handles, no manual allocations), define none of the special members. Let the compiler generate them all.

```cpp
// Rule of Zero: no manual resource management
class Employee {
public:
    Employee(std::string name, int id)
        : name_(std::move(name)), id_(id) {}

    const std::string& name() const { return name_; }
    int id() const { return id_; }

    // Compiler generates:
    // - Default constructor (deleted because we have a user-defined one)
    // - Destructor (default)
    // - Copy constructor (copies name_ and id_)
    // - Copy assignment (copies name_ and id_)
    // - Move constructor (moves name_, copies id_)
    // - Move assignment (moves name_, copies id_)

private:
    std::string name_; // std::string handles its own memory
    int id_;
};
```

**This is the Go model.** Go structs follow the Rule of Zero by default. The runtime handles memory, and copies are always shallow memberwise copies.

### Rule of Three

If you define any one of {destructor, copy constructor, copy assignment}, you almost certainly need all three. This arises when your class manages a resource manually.

```cpp
// Rule of Three: manages raw memory
class DynamicArray {
public:
    explicit DynamicArray(size_t size)
        : size_(size), data_(new double[size]) {
        std::fill(data_, data_ + size_, 0.0);
    }

    // 1. Destructor
    ~DynamicArray() {
        delete[] data_;
    }

    // 2. Copy constructor
    DynamicArray(const DynamicArray& other)
        : size_(other.size_), data_(new double[other.size_]) {
        std::copy(other.data_, other.data_ + other.size_, data_);
    }

    // 3. Copy assignment operator
    DynamicArray& operator=(const DynamicArray& other) {
        if (this != &other) { // self-assignment check
            delete[] data_;
            size_ = other.size_;
            data_ = new double[size_];
            std::copy(other.data_, other.data_ + other.size_, data_);
        }
        return *this;
    }

    double& operator[](size_t i) { return data_[i]; }
    size_t size() const { return size_; }

private:
    size_t size_;
    double* data_;
};
```

**What happens if you forget one:**

```cpp
// BUG: destructor without copy constructor/assignment
class Broken {
public:
    Broken(size_t n) : data_(new int[n]), size_(n) {}
    ~Broken() { delete[] data_; }
    // compiler-generated copy constructor does shallow copy of data_
    // two Broken objects now point to the same memory
    // double-free when both are destroyed!
private:
    int* data_;
    size_t size_;
};

Broken a(10);
Broken b = a; // shallow copy: both point to same data_
// when b is destroyed, data_ is freed
// when a is destroyed, data_ is freed AGAIN -> undefined behavior
```

### Rule of Five

In modern C++ (C++11 and later), you extend the Rule of Three with move constructor and move assignment for efficiency:

```cpp
class DynamicArray {
public:
    explicit DynamicArray(size_t size)
        : size_(size), data_(new double[size]) {
        std::fill(data_, data_ + size_, 0.0);
    }

    // 1. Destructor
    ~DynamicArray() {
        delete[] data_;
    }

    // 2. Copy constructor
    DynamicArray(const DynamicArray& other)
        : size_(other.size_), data_(new double[other.size_]) {
        std::copy(other.data_, other.data_ + other.size_, data_);
    }

    // 3. Copy assignment (copy-and-swap idiom)
    DynamicArray& operator=(DynamicArray other) { // note: by value
        swap(*this, other);
        return *this;
    }

    // 4. Move constructor
    DynamicArray(DynamicArray&& other) noexcept
        : size_(0), data_(nullptr) {
        swap(*this, other);
    }

    // 5. Move assignment is handled by the copy-and-swap in operator=

    friend void swap(DynamicArray& a, DynamicArray& b) noexcept {
        using std::swap;
        swap(a.size_, b.size_);
        swap(a.data_, b.data_);
    }

    double& operator[](size_t i) { return data_[i]; }
    const double& operator[](size_t i) const { return data_[i]; }
    size_t size() const { return size_; }

private:
    size_t size_;
    double* data_;
};

// Move avoids copying a million doubles
DynamicArray createArray() {
    DynamicArray arr(1'000'000);
    arr[0] = 3.14;
    return arr; // move (or copy elision)
}
```

**The copy-and-swap idiom** used above is the gold standard for assignment operators. By taking the parameter by value, the copy constructor or move constructor does the heavy lifting. Then `swap` exchanges the internals. The old data is destroyed when the parameter goes out of scope. This gives you exception-safe assignment for free.

### Summary Table

| Rule | When | You Define |
|---|---|---|
| Rule of 0 | Class owns no resources | Nothing (use smart pointers and standard containers) |
| Rule of 3 | Class owns a resource (pre-C++11) | Destructor + Copy constructor + Copy assignment |
| Rule of 5 | Class owns a resource (C++11+) | Rule of 3 + Move constructor + Move assignment |

**Best practice:** Prefer Rule of Zero. Use `std::unique_ptr`, `std::shared_ptr`, `std::string`, and `std::vector` to manage resources. Only drop to Rule of Five when writing low-level resource handles.

---

### Junior → FAANG: Making Rule of Zero the Default, Not the Exception

The most important application of the Rule of Zero is recognizing when you are about to violate it. If you find yourself writing a destructor to release a resource that is not a smart pointer or standard container, stop and ask: can I wrap that resource in a `unique_ptr` with a custom deleter? Usually yes. A custom deleter converts Rule of Five code into Rule of Zero code.

```cpp
// Rule of Five (error-prone): custom destructor, copy, move for a FILE*
// Rule of Zero (preferred): unique_ptr with custom deleter
auto file = std::unique_ptr<FILE, decltype(&fclose)>(fopen("f.txt", "r"), &fclose);
```

Interview note: "what is the Rule of Five?" is a standard C++ interview question. The complete answer names all five (destructor, copy constructor, copy assignment, move constructor, move assignment) and explains that defining any one of them typically means you need to define all five to maintain correct resource ownership semantics.

### Senior @ FAANG: Enforcing Rule of Zero in Code Review and Tooling

At the staff level, Rule of Zero compliance in a codebase is a measurable quality metric. Count the number of classes that define a non-trivial destructor but do not own a raw resource. Each is a candidate for Rule of Zero migration.

**clang-tidy enforcement.** The `cppcoreguidelines-special-member-functions` check flags classes that define some but not all of the Rule of Five members, and the `hicpp-special-member-functions` check does the same with stricter settings. A staff engineer enables these checks in CI for new code (as warnings initially, then as errors after a migration window). The combination catches newly introduced Rule of Five violations before they land.

**Migration strategy for legacy Rule of Three code.** Many C++ codebases have Rule of Three classes (destructor + copy constructor + copy assignment) written before C++11 that do not have move operations. These classes are silently slow: passing them to functions copies data that could be moved. The migration: add move constructor and move assignment to each Rule of Three class, measured by a microbenchmark before and after. Prioritize classes on hot paths (ones that appear frequently in profiler output). This migration is a multi-quarter project in a large codebase. A staff engineer plans it as a series of small PRs with measurable performance improvements per batch.

