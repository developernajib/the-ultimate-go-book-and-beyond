## Part II: C++20 - The Big Four and Beyond

C++20 is the largest update since C++11. Four major features define it: concepts, ranges, coroutines, and modules. Each one is substantial enough to warrant its own chapter. We cover them here in practical depth alongside the other important C++20 additions.

### Concepts and Requires Clauses

Concepts replace SFINAE with readable, composable constraints on template parameters. Instead of cryptic `enable_if` expressions buried in template parameter lists, you write what you mean.

```cpp
#include <concepts>
#include <type_traits>
#include <iostream>
#include <string>
#include <vector>

// Define a concept: T must support + and be printable via <<
template<typename T>
concept Addable = requires(T a, T b) {
    { a + b } -> std::convertible_to<T>;
};

template<typename T>
concept Printable = requires(T a, std::ostream& os) {
    { os << a } -> std::same_as<std::ostream&>;
};

// Combine concepts
template<typename T>
concept PrintableAddable = Addable<T> && Printable<T>;

// Use concept as constraint - clear error messages on violation
template<PrintableAddable T>
T add_and_print(T a, T b) {
    T result = a + b;
    std::cout << a << " + " << b << " = " << result << "\n";
    return result;
}

// Alternative syntax: requires clause
template<typename T>
    requires std::integral<T> || std::floating_point<T>
T square(T x) {
    return x * x;
}

// Abbreviated function template with auto + concept
void process(std::integral auto value) {
    std::cout << "Integer: " << value << "\n";
}

// Constraining class templates
template<typename T>
    requires std::default_initializable<T> && std::copyable<T>
class Cache {
    std::vector<T> items_;
public:
    void add(const T& item) { items_.push_back(item); }
    size_t size() const { return items_.size(); }
};

// More complex requires expressions
template<typename T>
concept Container = requires(T c) {
    typename T::value_type;
    typename T::iterator;
    { c.begin() } -> std::same_as<typename T::iterator>;
    { c.end() }   -> std::same_as<typename T::iterator>;
    { c.size() }  -> std::convertible_to<std::size_t>;
};

template<Container C>
void print_container(const C& c) {
    for (const auto& elem : c) {
        std::cout << elem << " ";
    }
    std::cout << "\n";
}

int main() {
    add_and_print(1, 2);
    add_and_print(1.5, 2.5);
    add_and_print(std::string("hello "), std::string("world"));

    // add_and_print(std::vector<int>{}, std::vector<int>{});
    // ^ compile error: vector is not Printable - clear message

    std::cout << square(5) << "\n";
    std::cout << square(2.5) << "\n";

    process(42);
    // process(3.14);  // error: double is not integral

    Cache<std::string> cache;
    cache.add("item1");

    print_container(std::vector{1, 2, 3, 4, 5});

    return 0;
}
```

Concepts provide three things that SFINAE never did: readable error messages, composability through `&&` and `||`, and discoverability (you can look at the concept definition and know what a type needs to satisfy it).

**Standard library concepts** in `<concepts>`: `same_as`, `derived_from`, `convertible_to`, `integral`, `floating_point`, `copyable`, `movable`, `regular`, `invocable`, `predicate`, and many more.

### Ranges: Views, Adaptors, and Composability

Ranges replace iterator pairs with composable, lazy view pipelines. Instead of calling algorithms with `begin()`/`end()` pairs and storing intermediates, you compose transformations.

```cpp
#include <ranges>
#include <vector>
#include <string>
#include <iostream>
#include <algorithm>
#include <numeric>

namespace views = std::views;
namespace ranges = std::ranges;

int main() {
    std::vector<int> numbers = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};

    // Pipe syntax: filter, then transform, then take
    // Lazy - no intermediate containers allocated
    auto result = numbers
        | views::filter([](int n) { return n % 2 == 0; })     // 2,4,6,8,10
        | views::transform([](int n) { return n * n; })        // 4,16,36,64,100
        | views::take(3);                                       // 4,16,36

    std::cout << "Pipeline result: ";
    for (int n : result) {
        std::cout << n << " ";
    }
    std::cout << "\n";

    // iota: generate a range of values
    for (int n : views::iota(1, 6)) {
        std::cout << n << " ";   // 1 2 3 4 5
    }
    std::cout << "\n";

    // Reverse view
    for (int n : numbers | views::reverse | views::take(3)) {
        std::cout << n << " ";   // 10 9 8
    }
    std::cout << "\n";

    // String splitting (C++20)
    std::string csv = "Alice,Bob,Carol,Dave";
    for (auto word : csv | views::split(',')) {
        // word is a subrange - convert to string_view for printing
        std::cout << std::string_view(word.begin(), word.end()) << "\n";
    }

    // Range algorithms (take range instead of iterator pair)
    std::vector<int> data = {5, 3, 1, 4, 2};
    ranges::sort(data);
    std::cout << "Sorted: ";
    ranges::for_each(data, [](int n) { std::cout << n << " "; });
    std::cout << "\n";

    // Projection: sort by a member or computed value
    struct Employee {
        std::string name;
        int salary;
    };
    std::vector<Employee> team = {
        {"Alice", 120000}, {"Bob", 95000}, {"Carol", 110000}
    };
    ranges::sort(team, {}, &Employee::salary);  // sort by salary ascending
    for (const auto& e : team) {
        std::cout << e.name << ": " << e.salary << "\n";
    }

    // zip (C++23, but showing the pattern)
    // enumerate view
    for (auto [i, val] : numbers | views::enumerate) {
        if (i < 3) std::cout << "[" << i << "]=" << val << " ";
    }
    std::cout << "\n";

    return 0;
}
```

Views are non-owning, lazy, and O(1) to copy. They compose through the pipe operator. The underlying data is never copied. Each view just adjusts what the iterator does at each step.

**Go comparison**: Go has no equivalent to ranges. You write explicit `for` loops with `if` conditions. The ranges library brings a functional, composable style to C++ that Go deliberately avoids for simplicity.

### Coroutines: `co_await`, `co_yield`, `co_return`

C++20 coroutines are stackless, compiler-transformed functions. A function becomes a coroutine if its body contains `co_await`, `co_yield`, or `co_return`. The compiler transforms it into a state machine.

C++20 provides the low-level machinery (promise types, awaitables, handles) but not the high-level types. You must either write your own or use a library. Here we show a simplified generator:

```cpp
#include <coroutine>
#include <iostream>
#include <optional>
#include <cstdint>

// A simple generator that yields values lazily
template<typename T>
class Generator {
public:
    struct promise_type {
        T current_value;
        std::exception_ptr exception;

        Generator get_return_object() {
            return Generator{
                std::coroutine_handle<promise_type>::from_promise(*this)
            };
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void unhandled_exception() { exception = std::current_exception(); }

        std::suspend_always yield_value(T value) {
            current_value = std::move(value);
            return {};
        }
        void return_void() {}
    };

    using handle_type = std::coroutine_handle<promise_type>;

    explicit Generator(handle_type h) : handle_(h) {}
    ~Generator() { if (handle_) handle_.destroy(); }

    // Move only
    Generator(Generator&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }
    Generator& operator=(Generator&&) = delete;
    Generator(const Generator&) = delete;

    // Iterator interface for range-based for
    struct iterator {
        handle_type handle;
        bool done;

        iterator& operator++() {
            handle.resume();
            done = handle.done();
            return *this;
        }
        T& operator*() { return handle.promise().current_value; }
        bool operator!=(const iterator&) const { return !done; }
    };

    iterator begin() {
        handle_.resume();
        return {handle_, handle_.done()};
    }
    iterator end() { return {handle_, true}; }

private:
    handle_type handle_;
};

// A coroutine that generates Fibonacci numbers
Generator<uint64_t> fibonacci(int count) {
    uint64_t a = 0, b = 1;
    for (int i = 0; i < count; ++i) {
        co_yield a;
        auto next = a + b;
        a = b;
        b = next;
    }
}

// A coroutine that generates filtered values
Generator<int> even_squares(int limit) {
    for (int i = 0; i < limit; ++i) {
        if (i % 2 == 0) {
            co_yield i * i;
        }
    }
}

int main() {
    std::cout << "Fibonacci: ";
    for (auto val : fibonacci(15)) {
        std::cout << val << " ";
    }
    std::cout << "\n";

    std::cout << "Even squares: ";
    for (auto val : even_squares(10)) {
        std::cout << val << " ";
    }
    std::cout << "\n";

    return 0;
}
```

The coroutine machinery is low-level by design. Libraries like `cppcoro` or the C++23 `std::generator` provide ready-made types. The key insight: coroutines let you write lazy, composable, sequential-looking code that executes incrementally.

**Go comparison**: Go's goroutines are stackful and scheduled by the runtime. C++ coroutines are stackless, compiler-transformed, and require explicit scheduling. Go's approach is simpler. C++'s approach is zero-overhead and more flexible.

### Modules

Modules replace the textual `#include` preprocessor model with a proper compilation unit system. They eliminate header file duplication, dramatically speed up compilation, and prevent macro leakage.

```cpp
// math_utils.cppm (module interface unit)
export module math_utils;

import <cmath>;

export namespace math {
    double distance(double x1, double y1, double x2, double y2) {
        double dx = x2 - x1;
        double dy = y2 - y1;
        return std::sqrt(dx * dx + dy * dy);
    }

    constexpr double pi = 3.14159265358979323846;

    double circle_area(double radius) {
        return pi * radius * radius;
    }
}

// This function is NOT exported - internal to the module
double internal_helper(double x) {
    return x * x;
}
```

```cpp
// main.cpp
import math_utils;
import <iostream>;

int main() {
    double d = math::distance(0, 0, 3, 4);
    std::cout << "Distance: " << d << "\n";
    std::cout << "Circle area: " << math::circle_area(5) << "\n";
    // internal_helper(3);  // error: not exported
    return 0;
}
```

Module adoption is slow because build systems (CMake, Bazel) are still catching up with module dependency scanning. Most production codebases still use headers, but modules are the future direction.

**Key module concepts**:
- **Module interface unit** (`.cppm`): declares what is exported
- **Module implementation unit**: provides definitions for declarations in the interface
- **Module partitions**: split a module into sub-units for internal organization
- **Global module fragment**: allows `#include` of legacy headers that are not yet modularized

```cpp
// Module partition example
// math_utils-impl.cppm (partition implementation)
export module math_utils:impl;

export double fast_inverse_sqrt(double x) {
    // Quake III-inspired, but using standard math for correctness
    return 1.0 / std::sqrt(x);
}
```

```cpp
// math_utils.cppm (primary interface re-exports partition)
export module math_utils;
export import :impl;  // re-export the partition

export namespace math {
    double distance(double x1, double y1, double x2, double y2);
}
```

The build time improvements from modules are dramatic in large projects. Google has reported that header parsing accounts for over 80% of C++ compile time in some codebases. Modules eliminate redundant parsing entirely: each module is compiled once, and importers receive a pre-compiled binary representation. However, the migration path from headers to modules is not incremental for most projects because modules and headers have subtly different semantics around macros and include order.

### `std::span` - Non-Owning View of Contiguous Data

`std::span` is to arrays and vectors what `string_view` is to strings: a non-owning, bounds-aware view.

```cpp
#include <span>
#include <vector>
#include <array>
#include <iostream>
#include <numeric>

// Accepts any contiguous container without templates
void print_data(std::span<const int> data) {
    std::cout << "[";
    for (size_t i = 0; i < data.size(); ++i) {
        if (i > 0) std::cout << ", ";
        std::cout << data[i];
    }
    std::cout << "]\n";
}

double average(std::span<const double> values) {
    if (values.empty()) return 0.0;
    double sum = std::accumulate(values.begin(), values.end(), 0.0);
    return sum / values.size();
}

int main() {
    // From C array
    int c_arr[] = {1, 2, 3, 4, 5};
    print_data(c_arr);

    // From std::vector
    std::vector<int> vec = {10, 20, 30};
    print_data(vec);

    // From std::array
    std::array<int, 4> arr = {100, 200, 300, 400};
    print_data(arr);

    // Subspan
    std::span<int> full(c_arr);
    auto first_three = full.first(3);
    auto last_two = full.last(2);
    auto middle = full.subspan(1, 3);
    print_data(first_three);  // [1, 2, 3]
    print_data(last_two);     // [4, 5]
    print_data(middle);       // [2, 3, 4]

    // Fixed-extent span (size known at compile time)
    std::span<int, 5> fixed(c_arr);
    static_assert(fixed.extent == 5);

    std::vector<double> grades = {92.5, 88.0, 95.5, 78.0};
    std::cout << "Average: " << average(grades) << "\n";

    return 0;
}
```

### `std::format` - Python-Style String Formatting

`std::format` brings Python `str.format()` style formatting to C++, replacing the type-unsafe `printf` and the verbose `iostream` manipulators.

```cpp
#include <format>
#include <iostream>
#include <string>
#include <vector>
#include <chrono>

int main() {
    // Basic formatting
    std::string msg = std::format("Hello, {}!", "world");
    std::cout << msg << "\n";

    // Positional arguments
    std::cout << std::format("{0} + {1} = {2}\n", 1, 2, 3);

    // Format specifiers
    std::cout << std::format("Hex: {:#x}\n", 255);         // 0xff
    std::cout << std::format("Binary: {:#b}\n", 42);       // 0b101010
    std::cout << std::format("Fixed: {:.3f}\n", 3.14159);  // 3.142
    std::cout << std::format("Sci: {:.2e}\n", 12345.6789); // 1.23e+04
    std::cout << std::format("Width: {:>10}\n", "right");   //      right
    std::cout << std::format("Width: {:<10}\n", "left");    // left
    std::cout << std::format("Width: {:^10}\n", "center");  //   center
    std::cout << std::format("Fill: {:*>10}\n", "hi");      // ********hi

    // Chrono integration
    auto now = std::chrono::system_clock::now();
    // std::cout << std::format("Time: {:%Y-%m-%d %H:%M:%S}\n", now);
    
    // format_to for writing to output iterators
    std::string buffer;
    std::format_to(std::back_inserter(buffer),
                   "User {} has {} points", "Alice", 1500);
    std::cout << buffer << "\n";

    return 0;
}
```

### `std::jthread` and Cooperative Cancellation

`std::jthread` is a joining thread: its destructor automatically requests stop and joins, preventing the `std::terminate` that `std::thread` causes if you forget to join.

```cpp
#include <thread>
#include <stop_token>
#include <iostream>
#include <chrono>

void worker(std::stop_token token, int id) {
    while (!token.stop_requested()) {
        std::cout << "Worker " << id << " running\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    std::cout << "Worker " << id << " stopped\n";
}

int main() {
    {
        std::jthread t1(worker, 1);
        std::jthread t2(worker, 2);

        std::this_thread::sleep_for(std::chrono::seconds(1));

        // request_stop signals the stop_token
        t1.request_stop();
        // t2 will be automatically stopped and joined when it goes out of scope
    }
    // Both threads are guaranteed joined here - no leaks, no terminate()

    std::cout << "All workers done\n";
    return 0;
}
```

### Synchronization Primitives: `std::latch`, `std::barrier`, `std::counting_semaphore`

C++20 added three synchronization primitives that were previously only available through platform APIs or Boost.

```cpp
#include <latch>
#include <barrier>
#include <semaphore>
#include <thread>
#include <iostream>
#include <vector>
#include <functional>

void latch_example() {
    // Latch: one-time countdown barrier
    constexpr int num_workers = 4;
    std::latch startup(num_workers);

    auto task = [&startup](int id) {
        // Simulate initialization
        std::this_thread::sleep_for(std::chrono::milliseconds(100 * id));
        std::cout << "Worker " << id << " ready\n";
        startup.count_down();      // signal completion
    };

    std::vector<std::jthread> threads;
    for (int i = 0; i < num_workers; ++i) {
        threads.emplace_back(task, i);
    }

    startup.wait();  // block until all workers have counted down
    std::cout << "All workers initialized\n";
}

void barrier_example() {
    // Barrier: reusable synchronization point
    constexpr int num_threads = 3;
    int phase = 0;

    std::barrier sync_point(num_threads, [&phase]() noexcept {
        ++phase;
        std::cout << "--- Phase " << phase << " complete ---\n";
    });

    auto worker = [&sync_point](int id) {
        for (int i = 0; i < 3; ++i) {
            std::cout << "Thread " << id << " working phase " << i << "\n";
            sync_point.arrive_and_wait();  // synchronize after each phase
        }
    };

    std::vector<std::jthread> threads;
    for (int i = 0; i < num_threads; ++i) {
        threads.emplace_back(worker, i);
    }
}

void semaphore_example() {
    // Counting semaphore: limit concurrent access
    std::counting_semaphore<3> pool(3);  // max 3 concurrent

    auto task = [&pool](int id) {
        pool.acquire();  // blocks if 3 already acquired
        std::cout << "Task " << id << " using resource\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        std::cout << "Task " << id << " done\n";
        pool.release();
    };

    std::vector<std::jthread> threads;
    for (int i = 0; i < 8; ++i) {
        threads.emplace_back(task, i);
    }
}

int main() {
    std::cout << "=== Latch ===\n";
    latch_example();

    std::cout << "\n=== Barrier ===\n";
    barrier_example();

    std::cout << "\n=== Semaphore ===\n";
    semaphore_example();

    return 0;
}
```

**Go comparison**: Go uses channels and `sync.WaitGroup` for these patterns. `std::latch` is similar to `WaitGroup`, `std::barrier` has no direct Go equivalent (you would use channels), and `std::counting_semaphore` maps to a buffered channel used as a semaphore.

### Three-Way Comparison (Spaceship Operator)

The `<=>` operator generates all six comparison operators from a single definition.

```cpp
#include <compare>
#include <iostream>
#include <string>
#include <set>

struct Version {
    int major;
    int minor;
    int patch;

    // One line generates ==, !=, <, >, <=, >=
    auto operator<=>(const Version&) const = default;
};

struct CaseInsensitiveString {
    std::string value;

    std::strong_ordering operator<=>(const CaseInsensitiveString& other) const {
        // Custom comparison logic
        auto to_lower = [](char c) { return std::tolower(c); };
        auto it1 = value.begin();
        auto it2 = other.value.begin();

        while (it1 != value.end() && it2 != other.value.end()) {
            char c1 = to_lower(*it1++);
            char c2 = to_lower(*it2++);
            if (c1 < c2) return std::strong_ordering::less;
            if (c1 > c2) return std::strong_ordering::greater;
        }

        if (value.size() < other.value.size()) return std::strong_ordering::less;
        if (value.size() > other.value.size()) return std::strong_ordering::greater;
        return std::strong_ordering::equal;
    }

    bool operator==(const CaseInsensitiveString& other) const {
        return (*this <=> other) == 0;
    }
};

int main() {
    Version v1{1, 2, 3};
    Version v2{1, 3, 0};
    Version v3{1, 2, 3};

    std::cout << (v1 < v2)  << "\n";   // 1 (true)
    std::cout << (v1 == v3) << "\n";   // 1 (true)
    std::cout << (v2 >= v1) << "\n";   // 1 (true)

    // Works in ordered containers
    std::set<Version> versions = {{1,0,0}, {2,1,0}, {1,5,3}};
    for (auto [maj, min, pat] : versions) {
        std::cout << maj << "." << min << "." << pat << "\n";
    }

    CaseInsensitiveString a{"Hello"}, b{"hello"}, c{"World"};
    std::cout << (a == b) << "\n";  // 1 (true)
    std::cout << (a < c) << "\n";   // 1 (true, H < W)

    return 0;
}
```

Three comparison categories exist: `std::strong_ordering` (equal values are indistinguishable), `std::weak_ordering` (equal values may differ in some way), and `std::partial_ordering` (some values may be incomparable, like NaN for floats).

### `consteval`, `constinit`, and `std::source_location`

`consteval` forces a function to be evaluated only at compile time, calling it with a runtime argument is a compile error. `constinit` guarantees a variable's initializer runs at compile time to prevent the static initialization order fiasco, while still allowing runtime mutation. `std::source_location` captures file name, line number, and function name at the call site without macros, making it the C++20 replacement for `__FILE__` and `__LINE__`.
```cpp
#include <iostream>
#include <source_location>

// consteval: function MUST be evaluated at compile time
consteval int factorial(int n) {
    int result = 1;
    for (int i = 2; i <= n; ++i) {
        result *= i;
    }
    return result;
}

// constexpr can be runtime OR compile-time
// consteval is ALWAYS compile-time
constexpr int square(int x) { return x * x; }  // can be either

// constinit: variable must be initialized at compile time,
// but can be modified at runtime (unlike constexpr)
constinit int global_counter = 0;  // no static initialization order fiasco

// source_location: replaces __FILE__, __LINE__, __func__ macros
void log(const std::string& message,
         const std::source_location loc = std::source_location::current()) {
    std::cout << loc.file_name() << ":"
              << loc.line() << " ["
              << loc.function_name() << "] "
              << message << "\n";
}

int main() {
    // consteval: computed at compile time, guaranteed
    constexpr int fact10 = factorial(10);  // 3628800
    std::cout << "10! = " << fact10 << "\n";

    // This would NOT compile:
    // int n = 5;
    // int result = factorial(n);  // error: n is not a constant expression

    // constinit variable can be modified at runtime
    global_counter = 42;
    std::cout << "Counter: " << global_counter << "\n";

    // source_location: automatic file/line/function tracking
    log("Application started");
    log("Processing request");

    return 0;
}
```

`consteval` is the strict version of `constexpr`. Use it when a function must never be called at runtime (compile-time configuration, code generation). `constinit` solves the "static initialization order fiasco" by guaranteeing compile-time initialization while still allowing runtime mutation. `std::source_location` replaces the `__FILE__` and `__LINE__` preprocessor macros with a proper type that works with templates and default arguments.

---
