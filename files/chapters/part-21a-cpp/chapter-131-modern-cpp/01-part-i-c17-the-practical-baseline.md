## Part I: C++17 - The Practical Baseline

C++17 is the version most large codebases have standardized on. Its features feel mature and stable. Compilers have had years to optimize them. Most of what C++17 added falls into the category of "things everyone needed but had to hack around before."

### `std::optional` - Nullable Values Done Right

Before C++17, representing "a value that might not exist" required sentinel values (`-1`, empty strings), pointers, or `std::pair<T, bool>`. `std::optional<T>` gives you a vocabulary type for this.

```cpp
#include <optional>
#include <string>
#include <iostream>
#include <map>

// Before C++17: return a pointer, or use a sentinel, or take an out-parameter
// After C++17: return std::optional
std::optional<std::string> find_user(const std::map<int, std::string>& db, int id) {
    auto it = db.find(id);
    if (it != db.end()) {
        return it->second;          // implicitly constructs optional
    }
    return std::nullopt;            // explicitly "no value"
}

int main() {
    std::map<int, std::string> users = {{1, "Alice"}, {2, "Bob"}};

    auto result = find_user(users, 1);
    if (result) {                              // contextual conversion to bool
        std::cout << "Found: " << *result << "\n";   // dereference to access
    }

    auto missing = find_user(users, 99);
    std::cout << missing.value_or("Unknown") << "\n"; // default if empty

    // Monadic operations (C++23 adds transform/and_then/or_else, but
    // in C++17 you use has_value() and value() directly)
    if (auto user = find_user(users, 2); user.has_value()) {
        std::cout << "User 2: " << user.value() << "\n";
    }

    return 0;
}
```

Key properties: `std::optional<T>` stores the `T` inline (no heap allocation). It is trivially destructible when `T` is. It supports comparison operators that treat `std::nullopt` as less than any value.

**Go comparison**: Go uses multiple return values (`value, ok := m[key]`) or `nil` interfaces. `std::optional` provides a single type that encodes the "maybe" concept, whereas Go relies on convention.

### `std::variant` - Type-Safe Unions

`std::variant<Types...>` holds exactly one of its alternative types at any time. It replaces C-style unions with type safety and visitor-based access.

```cpp
#include <variant>
#include <string>
#include <iostream>
#include <vector>

// A configuration value can be an int, double, string, or bool
using ConfigValue = std::variant<int, double, std::string, bool>;

// Visitor pattern using overloaded lambdas
template<class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template<class... Ts> overloaded(Ts...) -> overloaded<Ts...>;  // CTAD guide

void print_config(const std::string& key, const ConfigValue& val) {
    std::cout << key << " = ";
    std::visit(overloaded{
        [](int i)                { std::cout << i << " (int)"; },
        [](double d)             { std::cout << d << " (double)"; },
        [](const std::string& s) { std::cout << '"' << s << '"'; },
        [](bool b)               { std::cout << (b ? "true" : "false"); }
    }, val);
    std::cout << "\n";
}

int main() {
    std::vector<std::pair<std::string, ConfigValue>> config = {
        {"port", 8080},
        {"threshold", 3.14},
        {"name", std::string("myapp")},
        {"debug", true}
    };

    for (const auto& [key, value] : config) {
        print_config(key, value);
    }

    // Direct access with std::get or std::get_if
    ConfigValue v = 42;
    if (auto* p = std::get_if<int>(&v)) {
        std::cout << "Integer value: " << *p << "\n";
    }

    // index() tells you which alternative is active
    std::cout << "Active index: " << v.index() << "\n";  // 0 (int)

    return 0;
}
```

`std::variant` is never empty (unless an assignment throws during transition, which puts it in a `valueless_by_exception` state). It stores everything inline, so `sizeof(variant<int, double, string>)` is `sizeof(string) + alignment overhead + index`.

### `std::any` - Type-Erased Storage

`std::any` can hold a value of any copyable type. It uses type erasure internally, typically with a small-buffer optimization for small types and heap allocation for larger ones.

```cpp
#include <any>
#include <iostream>
#include <string>

int main() {
    std::any a = 42;
    std::cout << std::any_cast<int>(a) << "\n";     // 42

    a = std::string("hello");
    std::cout << std::any_cast<std::string>(a) << "\n";  // hello

    // Bad cast throws std::bad_any_cast
    try {
        std::any_cast<int>(a);  // a holds string, not int
    } catch (const std::bad_any_cast& e) {
        std::cout << "Error: " << e.what() << "\n";
    }

    // Pointer-based access returns nullptr on type mismatch
    if (auto* p = std::any_cast<std::string>(&a)) {
        std::cout << "String: " << *p << "\n";
    }

    // Check if it holds a value
    std::any empty;
    std::cout << "Has value: " << empty.has_value() << "\n";  // 0

    return 0;
}
```

Use `std::any` sparingly. Prefer `std::variant` when you know the set of types at compile time. `std::any` is most useful in plugin systems or generic property maps where the type set is truly open.

### `std::string_view` - Non-Owning String References

`std::string_view` is a lightweight, non-owning reference to a contiguous sequence of characters. It avoids the allocation and copying overhead of `std::string` when you only need to read.

```cpp
#include <string_view>
#include <string>
#include <iostream>

// Accepts string literals, std::string, or any contiguous char sequence
// without copying
void log_message(std::string_view msg) {
    std::cout << "[LOG] " << msg << "\n";
}

// Efficient substring: no allocation, just pointer + length adjustment
std::string_view extract_filename(std::string_view path) {
    auto pos = path.find_last_of('/');
    return (pos != std::string_view::npos) ? path.substr(pos + 1) : path;
}

int main() {
    // From string literal - no std::string constructed
    log_message("server starting");

    // From std::string - implicit conversion
    std::string msg = "request processed in 42ms";
    log_message(msg);

    // Substring operations are O(1)
    std::string_view filename = extract_filename("/usr/local/bin/myapp");
    std::cout << "Filename: " << filename << "\n";  // myapp

    // DANGER: string_view does not own the data
    // std::string_view dangling() {
    //     std::string temp = "oops";
    //     return temp;  // dangling reference!
    // }

    return 0;
}
```

**Critical rule**: never return a `string_view` to a local `std::string` or temporary. The `string_view` does not extend the lifetime of its referent. This is the number one `string_view` bug in production code.

### Structured Bindings

Structured bindings let you decompose aggregates, tuples, and pairs into named variables in a single declaration.

```cpp
#include <map>
#include <tuple>
#include <iostream>
#include <string>

struct Point { double x; double y; double z; };

std::tuple<int, std::string, bool> get_user_info() {
    return {42, "Alice", true};
}

int main() {
    // Decompose a struct
    Point p{1.0, 2.0, 3.0};
    auto [x, y, z] = p;
    std::cout << x << ", " << y << ", " << z << "\n";

    // Decompose a tuple
    auto [id, name, active] = get_user_info();
    std::cout << id << " " << name << " " << active << "\n";

    // Decompose in range-based for loop (most common use)
    std::map<std::string, int> scores = {{"Alice", 95}, {"Bob", 87}};
    for (const auto& [student, score] : scores) {
        std::cout << student << ": " << score << "\n";
    }

    // Decompose std::pair from map::insert
    auto [iter, inserted] = scores.insert({"Carol", 91});
    std::cout << "Inserted: " << inserted << "\n";

    return 0;
}
```

Structured bindings bind by value (`auto`), by reference (`auto&`), or by const reference (`const auto&`). Always prefer `const auto&` when iterating to avoid copies.

### `if constexpr` - Compile-Time Branching

`if constexpr` evaluates conditions at compile time and discards the false branch entirely. This eliminates the need for SFINAE and tag dispatch in many template metaprogramming scenarios.

```cpp
#include <type_traits>
#include <string>
#include <iostream>

template<typename T>
std::string to_string_safe(const T& value) {
    // Decay first: a string literal deduces as a char array, not
    // const char*, so comparing T directly against const char* would
    // send literals into the static_assert branch. is_convertible
    // catches both char* and const char* after decay.
    using U = std::decay_t<T>;
    if constexpr (std::is_arithmetic_v<U>) {
        return std::to_string(value);
    } else if constexpr (std::is_same_v<U, std::string>) {
        return value;
    } else if constexpr (std::is_convertible_v<U, const char*>) {
        return std::string(value);
    } else {
        static_assert(sizeof(T) == 0, "Unsupported type");
    }
}

// Before if constexpr, you needed SFINAE overloads or tag dispatch:
// template<typename T, std::enable_if_t<std::is_arithmetic_v<T>, int> = 0>
// std::string to_string_safe(const T& value) { ... }
// ... one overload per branch

int main() {
    std::cout << to_string_safe(42) << "\n";
    std::cout << to_string_safe(3.14) << "\n";
    std::cout << to_string_safe(std::string("hello")) << "\n";
    std::cout << to_string_safe("world") << "\n";
    return 0;
}
```

The discarded branch is not instantiated, so it can contain code that would not compile for the given type. This is the key difference from a regular `if` statement in a template.

### Filesystem Library

C++17 brought `<filesystem>` into the standard, replacing platform-specific code and Boost.Filesystem.

```cpp
#include <filesystem>
#include <iostream>
#include <fstream>

namespace fs = std::filesystem;

int main() {
    // Path manipulation - portable across Windows and Unix
    fs::path p = "/home/user/documents/report.txt";
    std::cout << "Filename:  " << p.filename() << "\n";
    std::cout << "Stem:      " << p.stem() << "\n";
    std::cout << "Extension: " << p.extension() << "\n";
    std::cout << "Parent:    " << p.parent_path() << "\n";

    // Directory iteration
    for (const auto& entry : fs::directory_iterator(".")) {
        std::cout << entry.path().filename();
        if (entry.is_regular_file()) {
            std::cout << " (" << entry.file_size() << " bytes)";
        } else if (entry.is_directory()) {
            std::cout << " [dir]";
        }
        std::cout << "\n";
    }

    // Recursive directory iteration
    std::uintmax_t total_size = 0;
    for (const auto& entry : fs::recursive_directory_iterator(".")) {
        if (entry.is_regular_file()) {
            total_size += entry.file_size();
        }
    }
    std::cout << "Total size: " << total_size << " bytes\n";

    // Create directories, copy files, check existence
    fs::create_directories("output/subdir");
    std::ofstream("output/subdir/test.txt") << "hello";
    std::cout << "Exists: " << fs::exists("output/subdir/test.txt") << "\n";

    // Space information
    auto info = fs::space(".");
    std::cout << "Free space: " << info.free / (1024*1024) << " MB\n";

    // Error handling with error_code (no exceptions)
    std::error_code ec;
    fs::remove_all("output", ec);
    if (ec) {
        std::cerr << "Cleanup failed: " << ec.message() << "\n";
    }

    return 0;
}
```

**Go comparison**: Go's `os` and `filepath` packages provide similar functionality. The C++ filesystem library is notably more object-oriented with its `path` type, while Go uses plain strings with utility functions.

### Parallel STL and Execution Policies

C++17 added execution policies to standard algorithms, enabling parallel and vectorized execution with a single argument change.

```cpp
#include <algorithm>
#include <execution>
#include <vector>
#include <numeric>
#include <iostream>
#include <chrono>

int main() {
    constexpr size_t N = 100'000'000;
    std::vector<double> data(N);

    // Fill with values
    std::iota(data.begin(), data.end(), 1.0);

    // Sequential sort
    auto start = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::seq, data.begin(), data.end(),
              std::greater<>{});
    auto seq_time = std::chrono::high_resolution_clock::now() - start;

    // Parallel sort - uses thread pool internally
    std::iota(data.begin(), data.end(), 1.0);
    start = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::par, data.begin(), data.end(),
              std::greater<>{});
    auto par_time = std::chrono::high_resolution_clock::now() - start;

    // Parallel unsequenced - allows SIMD vectorization + threading
    std::iota(data.begin(), data.end(), 1.0);
    start = std::chrono::high_resolution_clock::now();
    std::sort(std::execution::par_unseq, data.begin(), data.end(),
              std::greater<>{});
    auto par_unseq_time = std::chrono::high_resolution_clock::now() - start;

    using ms = std::chrono::milliseconds;
    std::cout << "Sequential:     "
              << std::chrono::duration_cast<ms>(seq_time).count() << "ms\n";
    std::cout << "Parallel:       "
              << std::chrono::duration_cast<ms>(par_time).count() << "ms\n";
    std::cout << "Par+Unsequenced: "
              << std::chrono::duration_cast<ms>(par_unseq_time).count() << "ms\n";

    // Parallel reduce (not fold - reduce allows reordering for parallelism)
    double sum = std::reduce(std::execution::par,
                             data.begin(), data.end(), 0.0);
    std::cout << "Sum: " << sum << "\n";

    // Parallel transform_reduce (map-reduce pattern)
    double sum_squares = std::transform_reduce(
        std::execution::par,
        data.begin(), data.end(),
        0.0,                           // initial value
        std::plus<>{},                 // reduce operation
        [](double x) { return x * x; } // transform operation
    );
    std::cout << "Sum of squares: " << sum_squares << "\n";

    return 0;
}
```

Three execution policies exist: `seq` (sequential, same as no policy), `par` (parallel across threads), and `par_unseq` (parallel and vectorized). The function passed to parallel algorithms must not cause data races.

### Polymorphic Memory Resources (PMR)

PMR decouples containers from their allocation strategy. Instead of the allocator being a template parameter, you pass a runtime `std::pmr::memory_resource*`.

```cpp
#include <memory_resource>
#include <vector>
#include <string>
#include <iostream>
#include <array>

int main() {
    // Stack-based buffer with monotonic allocator (no deallocation)
    std::array<std::byte, 4096> buffer;
    std::pmr::monotonic_buffer_resource pool(
        buffer.data(), buffer.size(),
        std::pmr::null_memory_resource()  // fail if buffer exhausted
    );

    // Vector uses stack memory - zero heap allocations
    std::pmr::vector<int> vec(&pool);
    for (int i = 0; i < 100; ++i) {
        vec.push_back(i);
    }
    std::cout << "Size: " << vec.size() << "\n";

    // Synchronized pool for multi-threaded allocation
    std::pmr::synchronized_pool_resource sync_pool;
    std::pmr::vector<std::pmr::string> names(&sync_pool);
    names.emplace_back("Alice");
    names.emplace_back("Bob");

    // Unsynchronized pool for single-threaded hot paths
    std::pmr::unsynchronized_pool_resource fast_pool;
    std::pmr::vector<int> hot_data(&fast_pool);
    for (int i = 0; i < 1000; ++i) {
        hot_data.push_back(i);
    }

    std::cout << "Names: " << names.size() << "\n";
    std::cout << "Hot data: " << hot_data.size() << "\n";

    return 0;
}
```

PMR is important for performance-critical systems: game engines, trading platforms, embedded systems. The monotonic buffer resource is particularly useful for request-scoped allocations where you allocate many objects, process them, and then discard everything at once.

### Nested Namespaces, Inline Variables, and CTAD

Three smaller but frequently used C++17 features.

```cpp
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

// Nested namespace definition (C++17)
// Before: namespace A { namespace B { namespace C { ... }}}
namespace Company::Product::Detail {
    int internal_value = 42;
}

// Inline variables, define variables in headers without ODR violations
// Commonly used for constants in header-only libraries
struct Config {
    inline static const int max_connections = 1000;
    inline static const std::string default_host = "localhost";
};

// Class Template Argument Deduction (CTAD)

int main() {
    // Before C++17: std::pair<int, std::string> p(1, "hello");
    // After C++17:
    std::pair p(1, std::string("hello"));  // deduces pair<int, string>

    std::tuple t(1, 2.0, "three");         // deduces tuple<int, double, const char*>

    std::vector v = {1, 2, 3, 4, 5};      // deduces vector<int>

    std::optional o(42);                    // deduces optional<int>

    // CTAD with lock_guard
    std::mutex mtx;
    std::lock_guard lock(mtx);             // deduces lock_guard<std::mutex>

    std::cout << std::get<0>(t) << "\n";
    std::cout << Company::Product::Detail::internal_value << "\n";
    std::cout << Config::max_connections << "\n";

    return 0;
}
```

CTAD eliminates much of the verbosity that made C++ templates feel heavy. Combined with structured bindings, C++17 code reads significantly cleaner than C++11/14 equivalents.

---

### Junior → FAANG: C++17 as the Minimum Viable Modern C++

C++17 is the standard that closed the most critical Go-vs.-C++ readability gap. Structured bindings (`auto [k, v] = *it`) read like Go's multiple return values. `std::optional` is the `(value, ok)` pattern with a type. `std::variant` is Go's tagged union without a library. `if constexpr` eliminates SFINAE for most common use cases.

For a Go engineer, fluency in C++17 features is the entry ticket to reading modern C++ code without constant confusion. Invest here before moving to C++20.

### Senior @ FAANG: C++17 as the Migration Target for Legacy C++11/14 Codebases

At the staff level, C++17 is often the upgrade target for codebases still at C++11 or C++14. The migration plan: audit all uses of `boost::optional` (replace with `std::optional`), all uses of `boost::variant` (replace with `std::variant`), all SFINAE patterns with `enable_if` (replace with `if constexpr` where applicable), and all structured access to pair iterators (replace with structured bindings). This migration is mechanical and can be partially automated with clang-tidy modernize passes (`modernize-use-auto`, `modernize-use-std-variant`). A staff engineer scopes the migration into quarterly milestones, each with a measurable reduction in pre-C++17 pattern usage.

