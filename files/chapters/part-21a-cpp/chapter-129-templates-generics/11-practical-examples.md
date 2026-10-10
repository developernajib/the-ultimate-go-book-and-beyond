## Practical Examples

### Example 1: Generic Container with Iterator Support

Iterators abstract over traversal, decoupling algorithms from container implementations and enabling the standard algorithms to work uniformly across arrays, linked lists, trees, and custom data structures. Implementing the required iterator concept integrates a custom type with the entire standard library algorithm suite.
```cpp
#include <initializer_list>
#include <iostream>
#include <memory>
#include <stdexcept>

template <typename T>
class DynamicArray {
    std::unique_ptr<T[]> data_;
    size_t size_;
    size_t capacity_;

    void Grow() {
        size_t newCap = capacity_ == 0 ? 4 : capacity_ * 2;
        auto newData = std::make_unique<T[]>(newCap);
        for (size_t i = 0; i < size_; ++i) {
            newData[i] = std::move(data_[i]);
        }
        data_ = std::move(newData);
        capacity_ = newCap;
    }

public:
    // Constructors
    DynamicArray() : data_(nullptr), size_(0), capacity_(0) {}

    DynamicArray(std::initializer_list<T> init)
        : data_(std::make_unique<T[]>(init.size()))
        , size_(init.size())
        , capacity_(init.size()) {
        size_t i = 0;
        for (const auto& elem : init) {
            data_[i++] = elem;
        }
    }

    // Element access
    T& operator[](size_t index) {
        if (index >= size_) {
            throw std::out_of_range("Index out of bounds");
        }
        return data_[index];
    }

    const T& operator[](size_t index) const {
        if (index >= size_) {
            throw std::out_of_range("Index out of bounds");
        }
        return data_[index];
    }

    // Modifiers
    void PushBack(const T& value) {
        if (size_ == capacity_) { Grow(); }
        data_[size_++] = value;
    }

    void PushBack(T&& value) {
        if (size_ == capacity_) { Grow(); }
        data_[size_++] = std::move(value);
    }

    template <typename... Args>
    T& EmplaceBack(Args&&... args) {
        if (size_ == capacity_) { Grow(); }
        data_[size_] = T(std::forward<Args>(args)...);
        return data_[size_++];
    }

    void PopBack() {
        if (size_ == 0) {
            throw std::underflow_error("Array is empty");
        }
        --size_;
    }

    // Size
    size_t Size() const { return size_; }
    size_t Capacity() const { return capacity_; }
    bool Empty() const { return size_ == 0; }

    // Iterators (raw pointer iterators)
    T* begin() { return data_.get(); }
    T* end() { return data_.get() + size_; }
    const T* begin() const { return data_.get(); }
    const T* end() const { return data_.get() + size_; }
};

int main() {
    DynamicArray<int> arr = {1, 2, 3, 4, 5};
    arr.PushBack(6);
    arr.EmplaceBack(7);

    for (int x : arr) {
        std::cout << x << " ";
    }
    // Output: 1 2 3 4 5 6 7

    DynamicArray<std::string> names;
    names.EmplaceBack("Alice");
    names.EmplaceBack("Bob");
    names.PushBack("Charlie");

    for (const auto& name : names) {
        std::cout << name << " ";
    }
    // Output: Alice Bob Charlie
    return 0;
}
```

### Example 2: Compile-Time Fibonacci

Compile-time Fibonacci is the classic demonstration that template instantiation is a Turing-complete computation performed entirely by the compiler: the values exist as constants in the binary and cost nothing at runtime.
```cpp
// C++11 style: recursive template instantiation
template <int N>
struct Fibonacci {
    static constexpr int value = Fibonacci<N-1>::value + Fibonacci<N-2>::value;
};

template <>
struct Fibonacci<0> {
    static constexpr int value = 0;
};

template <>
struct Fibonacci<1> {
    static constexpr int value = 1;
};

// C++14+ style: constexpr function (much simpler)
constexpr int fib(int n) {
    if (n <= 1) return n;
    int a = 0, b = 1;
    for (int i = 2; i <= n; ++i) {
        int temp = a + b;
        a = b;
        b = temp;
    }
    return b;
}

// C++17: constexpr if with templates
template <int N>
constexpr int FibV2() {
    if constexpr (N <= 1) {
        return N;
    } else {
        return FibV2<N-1>() + FibV2<N-2>();
    }
}

int main() {
    // All computed at compile time -- zero runtime cost
    static_assert(Fibonacci<10>::value == 55);
    static_assert(fib(10) == 55);
    static_assert(FibV2<10>() == 55);

    // These are embedded as constants in the binary
    constexpr int f20 = fib(20);  // 6765, computed at compile time
    std::cout << f20 << "\n";
    return 0;
}
```

Go has no compile-time computation beyond constant expressions. You cannot compute Fibonacci at compile time in Go.

### Example 3: Policy-Based Design

Policy-based design uses template parameters to inject behavior, producing highly configurable classes with zero runtime overhead.

```cpp
#include <iostream>
#include <vector>
#include <mutex>
#include <shared_mutex>

// Threading policies
struct SingleThreaded {
    struct Lock {
        Lock() = default;
        void lock() {}
        void unlock() {}
    };
    using MutexType = Lock;
};

struct MultiThreaded {
    using MutexType = std::shared_mutex;
};

// Logging policies
struct NoLogging {
    static void Log(const std::string&) {}
};

struct ConsoleLogging {
    static void Log(const std::string& msg) {
        std::cout << "[LOG] " << msg << "\n";
    }
};

// Bounds checking policies
struct NoBoundsCheck {
    static void Check(size_t, size_t) {}
};

struct StrictBoundsCheck {
    static void Check(size_t index, size_t size) {
        if (index >= size) {
            throw std::out_of_range(
                "Index " + std::to_string(index) +
                " out of range [0, " + std::to_string(size) + ")"
            );
        }
    }
};

// The container, parameterized by policies
template <
    typename T,
    typename ThreadingPolicy = SingleThreaded,
    typename LoggingPolicy = NoLogging,
    typename BoundsPolicy = NoBoundsCheck
>
class PolicyVector {
    std::vector<T> data_;
    mutable typename ThreadingPolicy::MutexType mutex_;

public:
    void PushBack(const T& value) {
        std::lock_guard lock(mutex_);
        LoggingPolicy::Log("PushBack called");
        data_.push_back(value);
    }

    T& At(size_t index) {
        std::lock_guard lock(mutex_);
        BoundsPolicy::Check(index, data_.size());
        LoggingPolicy::Log("At(" + std::to_string(index) + ") called");
        return data_[index];
    }

    size_t Size() const {
        std::lock_guard lock(mutex_);
        return data_.size();
    }
};

int main() {
    // Fast, unsafe, single-threaded -- no overhead
    PolicyVector<int> fast;
    fast.PushBack(42);

    // Debug mode: logging + bounds checking, single-threaded
    PolicyVector<int, SingleThreaded, ConsoleLogging, StrictBoundsCheck> debug;
    debug.PushBack(10);
    debug.PushBack(20);
    debug.At(0);  // [LOG] At(0) called

    // Production: thread-safe, no logging, bounds checked
    PolicyVector<int, MultiThreaded, NoLogging, StrictBoundsCheck> production;
    production.PushBack(100);

    return 0;
}
```

Each combination of policies generates a different class. The single-threaded, no-logging, no-bounds-check version compiles down to essentially the same code as a raw `std::vector`. The compiler optimizes away empty function calls completely.

Go achieves similar flexibility through interfaces and dependency injection, but with runtime overhead from interface dispatch:

```go
type Logger interface {
    Log(msg string)
}

type NoopLogger struct{}
func (NoopLogger) Log(string) {}

type ConsoleLogger struct{}
func (ConsoleLogger) Log(msg string) { fmt.Println("[LOG]", msg) }

type SafeVector[T any] struct {
    data   []T
    logger Logger
}
```

The Go version pays for interface dispatch on every `Log` call, even if the logger does nothing. The C++ version with `NoLogging` generates no instructions for logging at all.

### Example 4: Compile-Time Dimensional Analysis

Using non-type template parameters to represent base physical dimensions (Mass, Length, Time) allows the compiler to enforce dimensional correctness during arithmetic and compute resulting units at compile time with zero runtime overhead:
```cpp
template <int Mass, int Length, int Time>
struct Dimension {
    static constexpr int mass = Mass;
    static constexpr int length = Length;
    static constexpr int time = Time;
};

template <typename Dim>
class Quantity {
    double value_;
public:
    explicit constexpr Quantity(double v) : value_(v) {}
    constexpr double Value() const { return value_; }

    // Addition: dimensions must match (enforced at compile time)
    constexpr Quantity operator+(Quantity other) const {
        return Quantity(value_ + other.value_);
    }

    constexpr Quantity operator-(Quantity other) const {
        return Quantity(value_ - other.value_);
    }

    constexpr Quantity operator*(double scalar) const {
        return Quantity(value_ * scalar);
    }
};

// Multiplication of quantities: dimensions add
template <typename D1, typename D2>
constexpr auto operator*(Quantity<D1> a, Quantity<D2> b) {
    using ResultDim = Dimension<
        D1::mass + D2::mass,
        D1::length + D2::length,
        D1::time + D2::time
    >;
    return Quantity<ResultDim>(a.Value() * b.Value());
}

// Division of quantities: dimensions subtract
template <typename D1, typename D2>
constexpr auto operator/(Quantity<D1> a, Quantity<D2> b) {
    using ResultDim = Dimension<
        D1::mass - D2::mass,
        D1::length - D2::length,
        D1::time - D2::time
    >;
    return Quantity<ResultDim>(a.Value() / b.Value());
}

// Type aliases for physical units
using Scalar   = Quantity<Dimension<0, 0, 0>>;   // dimensionless
using Mass     = Quantity<Dimension<1, 0, 0>>;    // kg
using Length   = Quantity<Dimension<0, 1, 0>>;    // meters
using Time     = Quantity<Dimension<0, 0, 1>>;    // seconds
using Velocity = Quantity<Dimension<0, 1, -1>>;   // m/s
using Accel    = Quantity<Dimension<0, 1, -2>>;   // m/s^2
using Force    = Quantity<Dimension<1, 1, -2>>;   // kg*m/s^2 = Newton

int main() {
    Length distance(100.0);  // 100 meters
    Time duration(9.58);     // 9.58 seconds

    Velocity speed = distance / duration;  // m/s -- compiles
    std::cout << "Speed: " << speed.Value() << " m/s\n";  // ~10.44 m/s

    Mass m(75.0);            // 75 kg
    Accel a = speed / duration;  // m/s / s = m/s^2

    Force f = m * a;         // kg * m/s^2 = Newton -- compiles
    std::cout << "Force: " << f.Value() << " N\n";

    // This would NOT compile:
    // Length bad = distance + duration;  // error: cannot add meters and seconds
    // Force bad2 = m + a;               // error: cannot add kg and m/s^2

    return 0;
}
```

The compiler prevents dimensionally incorrect operations at compile time with zero runtime cost. The generated code is identical to raw `double` arithmetic. This is impossible in Go, you would need runtime checks.

---
