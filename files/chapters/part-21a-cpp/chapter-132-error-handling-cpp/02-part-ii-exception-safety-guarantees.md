## Part II: Exception Safety Guarantees

Exception safety is about what invariants your code maintains when an exception occurs. Bjarne Stroustrup and Dave Abrahams formalized three levels:

### The Basic Guarantee

**Promise:** No resources are leaked, and all objects remain in a valid (but possibly modified) state.

This is the minimum acceptable level. Any code that fails to provide the basic guarantee has bugs.

```cpp
#include <vector>
#include <string>
#include <algorithm>

class UserDatabase {
public:
    // Basic guarantee: if an exception occurs during insertion,
    // the database remains valid but may or may not contain the new user
    void add_user_basic(const std::string& name, int age) {
        names_.push_back(name);      // may throw (allocation)
        ages_.push_back(age);        // may throw (allocation)
        // BUG: if ages_.push_back throws, names_ has one extra entry
        // but ages_ does not. The object is in an inconsistent state.
    }

private:
    std::vector<std::string> names_;
    std::vector<int> ages_;
};
```

The example above illustrates a failure to provide even the basic guarantee. The two vectors can end up with different sizes.

### The Strong Guarantee (Commit-or-Rollback)

**Promise:** If an operation throws, the program state is exactly as it was before the operation started. Either the operation completes fully or has no effect.

```cpp
class UserDatabaseStrong {
public:
    // Strong guarantee using copy-and-swap
    void add_user(const std::string& name, int age) {
        // Work on copies
        auto new_names = names_;     // copy (may throw)
        auto new_ages = ages_;       // copy (may throw)
        new_names.push_back(name);   // modify copy (may throw)
        new_ages.push_back(age);     // modify copy (may throw)
        // Commit: swap is noexcept for vectors
        std::swap(names_, new_names);   // noexcept
        std::swap(ages_, new_ages);     // noexcept
    }

    // Strong guarantee using a single data structure
    struct User {
        std::string name;
        int age;
    };

    void add_user_v2(const std::string& name, int age) {
        users_.push_back(User{name, age});  // atomic: one push_back
        // If it throws, vector is unchanged (standard guarantee)
    }

private:
    std::vector<std::string> names_;
    std::vector<int> ages_;
    std::vector<User> users_;
};
```

The copy-and-swap idiom is the classic technique: do all work that might throw on temporary copies, then commit with `noexcept` swap operations.

### The Nothrow Guarantee

**Promise:** The operation will never throw an exception. Period.

```cpp
class Buffer {
public:
    Buffer(size_t size) : data_(new char[size]), size_(size) {}

    ~Buffer() noexcept {
        // Destructors must never throw - nothrow guarantee
        delete[] data_;
    }

    // Swap is a classic nothrow operation
    void swap(Buffer& other) noexcept {
        std::swap(data_, other.data_);
        std::swap(size_, other.size_);
    }

    // Move operations should be noexcept
    Buffer(Buffer&& other) noexcept
        : data_(std::exchange(other.data_, nullptr))
        , size_(std::exchange(other.size_, 0)) {}

    Buffer& operator=(Buffer&& other) noexcept {
        if (this != &other) {
            delete[] data_;
            data_ = std::exchange(other.data_, nullptr);
            size_ = std::exchange(other.size_, 0);
        }
        return *this;
    }

private:
    char* data_;
    size_t size_;
};
```

**Critical rule:** Destructors, move operations, and swap functions should always be `noexcept`. If a destructor throws during stack unwinding from another exception, `std::terminate` is called. The program dies.

### Practical Exception Safety: The Assignment Operator

The copy-and-swap idiom gives you the strong guarantee for assignment operators almost for free:

```cpp
class Image {
public:
    Image(int width, int height)
        : width_(width)
        , height_(height)
        , pixels_(new uint8_t[width * height * 4]) {}

    // Copy constructor - may throw
    Image(const Image& other)
        : width_(other.width_)
        , height_(other.height_)
        , pixels_(new uint8_t[width_ * height_ * 4]) {
        std::copy(other.pixels_, other.pixels_ + width_ * height_ * 4, pixels_);
    }

    // Move constructor - noexcept
    Image(Image&& other) noexcept
        : width_(std::exchange(other.width_, 0))
        , height_(std::exchange(other.height_, 0))
        , pixels_(std::exchange(other.pixels_, nullptr)) {}

    ~Image() noexcept { delete[] pixels_; }

    // Unified assignment using copy-and-swap
    // Takes parameter by VALUE (invokes copy or move constructor)
    // Then swaps with the temporary - noexcept
    Image& operator=(Image other) noexcept {
        swap(other);
        return *this;
    }

    void swap(Image& other) noexcept {
        std::swap(width_, other.width_);
        std::swap(height_, other.height_);
        std::swap(pixels_, other.pixels_);
    }

private:
    int width_;
    int height_;
    uint8_t* pixels_;
};
```

This is elegantly exception-safe: if the copy constructor throws, the assignment operator never modifies `*this`. If the copy succeeds, the swap is `noexcept`.

---

### Junior → FAANG: Exception Safety as a Code Contract

Exception safety guarantees are contracts that a function makes with its caller about what state the program is in after an exception. A function without a documented exception safety guarantee is a function whose behavior under failure is undefined for the caller.

Practice: for each function you write that uses exceptions, add a comment stating its exception safety guarantee (basic, strong, or nothrow). Then verify that the implementation satisfies that guarantee by mentally tracing through the exception paths.

Interview note: "what is the strong exception safety guarantee?" The full answer: the operation either completes successfully or has no effect. The state is as if the operation was never attempted. This is often implemented using copy-and-swap: copy the resource, perform the operation on the copy, then swap with the original (which is nothrow).

### Senior @ FAANG: Exception Safety Documentation as an API Standard

At the staff level, exception safety guarantees are part of the public API contract. They should appear in the header file comment, not just in implementation notes. A staff engineer adds exception safety documentation to the team's code review checklist: every new public function that can throw must document its safety guarantee and every new public function that is nothrow must be marked `noexcept`.

**Strong vs. basic safety trade-off.** The strong safety guarantee requires copy-and-swap, which adds a copy for every operation. In a hot path, this may be unacceptable. The documented trade-off: "this function provides basic safety (not strong) for performance reasons. The state remains valid after an exception, but may be partially modified." Making this trade-off explicit in documentation prevents callers from assuming stronger guarantees.

