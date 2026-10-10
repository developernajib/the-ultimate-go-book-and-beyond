## Part III: C++23 - Refinement and Ergonomics

C++23 is a smaller release focused on filling gaps and improving ergonomics. It rounds out features introduced in C++20 and adds several long-awaited utilities.

### `std::expected` - Monadic Error Handling

`std::expected<T, E>` is like Rust's `Result<T, E>`: it holds either a value of type `T` or an error of type `E`. Combined with monadic operations, it enables functional-style error chains.

```cpp
#include <expected>
#include <string>
#include <iostream>
#include <fstream>
#include <charconv>
#include <system_error>

enum class ParseError {
    empty_input,
    invalid_format,
    out_of_range
};

std::string to_string(ParseError e) {
    switch (e) {
        case ParseError::empty_input:    return "empty input";
        case ParseError::invalid_format: return "invalid format";
        case ParseError::out_of_range:   return "out of range";
    }
    return "unknown";
}

std::expected<int, ParseError> parse_int(std::string_view s) {
    if (s.empty()) return std::unexpected(ParseError::empty_input);

    int result;
    auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), result);
    if (ec == std::errc::invalid_argument)
        return std::unexpected(ParseError::invalid_format);
    if (ec == std::errc::result_out_of_range)
        return std::unexpected(ParseError::out_of_range);
    if (ptr != s.data() + s.size())
        return std::unexpected(ParseError::invalid_format);

    return result;
}

std::expected<int, ParseError> parse_positive(std::string_view s) {
    return parse_int(s).and_then([](int n) -> std::expected<int, ParseError> {
        if (n <= 0) return std::unexpected(ParseError::out_of_range);
        return n;
    });
}

int main() {
    // Monadic chaining: transform (map), and_then (flat_map), or_else
    auto result = parse_int("42")
        .transform([](int n) { return n * 2; })          // map: 84
        .transform([](int n) { return std::to_string(n); }); // map: "84"

    if (result) {
        std::cout << "Result: " << *result << "\n";
    }

    // Error path
    auto err = parse_int("not_a_number");
    if (!err) {
        std::cout << "Error: " << to_string(err.error()) << "\n";
    }

    // or_else: recover from errors
    auto recovered = parse_int("bad")
        .or_else([](ParseError e) -> std::expected<int, ParseError> {
            std::cout << "Recovering from: " << to_string(e) << "\n";
            return 0;  // default value
        });
    std::cout << "Recovered: " << *recovered << "\n";

    // Chaining multiple operations
    auto final_result = parse_positive("15")
        .transform([](int n) { return n * n; })
        .transform([](int n) { return std::to_string(n) + " squared"; });

    std::cout << *final_result << "\n";  // "225 squared"

    return 0;
}
```

**Go comparison**: Go uses `value, err` return pairs. `std::expected` is a sum type that forces you to check the result (you cannot access the value when it holds an error without invoking undefined behavior). Go's approach is simpler but has the well-known problem of ignoring error returns.

### `std::mdspan` - Multidimensional View

`std::mdspan` provides a non-owning multidimensional view over contiguous data. It is essential for scientific computing, image processing, and matrix operations.

```cpp
#include <mdspan>
#include <vector>
#include <iostream>

void print_matrix(std::mdspan<const double, std::dextents<size_t, 2>> mat) {
    for (size_t i = 0; i < mat.extent(0); ++i) {
        for (size_t j = 0; j < mat.extent(1); ++j) {
            std::cout << mat[i, j] << "\t";
        }
        std::cout << "\n";
    }
}

int main() {
    // Flat data, viewed as 3x4 matrix
    std::vector<double> data = {
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12
    };

    // Create a 3x4 mdspan view
    std::mdspan matrix(data.data(), 3, 4);

    std::cout << "Matrix:\n";
    print_matrix(matrix);

    // Access elements with multidimensional subscript
    std::cout << "Element [1][2]: " << matrix[1, 2] << "\n";  // 7

    // Static extents (known at compile time)
    std::mdspan<double, std::extents<size_t, 3, 4>> fixed(data.data());
    static_assert(fixed.static_extent(0) == 3);

    // 3D tensor view
    std::vector<int> tensor_data(2 * 3 * 4, 0);
    std::iota(tensor_data.begin(), tensor_data.end(), 0);
    std::mdspan tensor(tensor_data.data(), 2, 3, 4);
    std::cout << "Tensor[1][2][3]: " << tensor[1, 2, 3] << "\n";

    // Custom layout (column-major)
    std::mdspan<double, std::dextents<size_t, 2>,
                std::layout_left> col_major(data.data(), 3, 4);
    // col_major[i,j] accesses data[j*3 + i] instead of data[i*4 + j]

    return 0;
}
```

### `std::generator` - Standard Coroutine Generator

C++23 finally provides the standard generator type that C++20 coroutines were missing.

```cpp
#include <generator>
#include <iostream>
#include <ranges>
#include <string>

// No more writing your own Generator class!
std::generator<int> fibonacci() {
    int a = 0, b = 1;
    while (true) {
        co_yield a;
        auto next = a + b;
        a = b;
        b = next;
    }
}

std::generator<std::string> lines_of(std::string_view text) {
    size_t start = 0;
    while (start < text.size()) {
        auto end = text.find('\n', start);
        if (end == std::string_view::npos) end = text.size();
        co_yield std::string(text.substr(start, end - start));
        start = end + 1;
    }
}

// Composable with ranges
std::generator<int> squares_of(std::generator<int> gen) {
    for (int val : gen) {
        co_yield val * val;
    }
}

int main() {
    // Take first 10 Fibonacci numbers
    std::cout << "Fibonacci: ";
    for (auto val : fibonacci() | std::views::take(10)) {
        std::cout << val << " ";
    }
    std::cout << "\n";

    // Parse lines
    std::string_view text = "line one\nline two\nline three";
    for (const auto& line : lines_of(text)) {
        std::cout << "  > " << line << "\n";
    }

    return 0;
}
```

### `std::print` and `std::println`

C++23 adds `std::print` and `std::println`, replacing `std::cout` for formatted output. They use the same format string syntax as `std::format`.

```cpp
#include <print>
#include <vector>
#include <string>

int main() {
    // Simple printing (no more << chains)
    std::println("Hello, world!");
    std::print("No newline here...");
    std::println(" but here.");

    // Formatted
    std::println("Name: {}, Age: {}", "Alice", 30);
    std::println("Hex: {:#x}, Bin: {:#b}", 255, 42);
    std::println("Pi: {:.5f}", 3.14159265);

    // Width and alignment
    std::println("{:>20}", "right-aligned");
    std::println("{:*^20}", "centered");

    // Container-like output (with manual loop)
    std::vector<int> nums = {1, 2, 3, 4, 5};
    std::print("[");
    for (size_t i = 0; i < nums.size(); ++i) {
        if (i > 0) std::print(", ");
        std::print("{}", nums[i]);
    }
    std::println("]");

    return 0;
}
```

`std::println` writes to `stdout` by default and is both faster than `iostream` and type-safe unlike `printf`. It flushes the unicode-aware output atomically, avoiding interleaved output from multiple threads.

### `flat_map` and `flat_set`

These are drop-in replacements for `std::map` and `std::set` that store elements in sorted contiguous arrays instead of balanced trees. Better cache performance for read-heavy workloads.

```cpp
#include <flat_map>
#include <flat_set>
#include <print>
#include <string>

int main() {
    // flat_map: sorted keys in contiguous memory
    std::flat_map<std::string, int> scores;
    scores.insert({"Alice", 95});
    scores.insert({"Bob", 87});
    scores.insert({"Carol", 91});
    scores["Dave"] = 88;

    // Iteration is cache-friendly (contiguous memory)
    for (const auto& [name, score] : scores) {
        std::println("{}: {}", name, score);
    }

    // Lookup: O(log n) binary search on sorted array
    if (auto it = scores.find("Bob"); it != scores.end()) {
        std::println("Found Bob: {}", it->second);
    }

    // flat_set: sorted unique elements in contiguous memory
    std::flat_set<int> unique_ids = {5, 3, 1, 4, 2, 3, 1};
    for (int id : unique_ids) {
        std::print("{} ", id);  // 1 2 3 4 5 (sorted, unique)
    }
    std::println("");

    return 0;
}
```

**When to use**: `flat_map`/`flat_set` are faster than `std::map`/`std::set` for small-to-medium collections (hundreds of elements) and read-heavy workloads. They are slower for frequent insertions and deletions into large collections because each insert may shift elements. FAANG codebases often use flat associative containers (Google's `absl::flat_hash_map`, Facebook's `folly::F14FastMap`) for this reason, predating the standardized versions.

### Deducing `this`

Deducing `this` eliminates the need for CRTP (Curiously Recurring Template Pattern) and removes code duplication between `const` and non-`const` overloads.

```cpp
#include <iostream>
#include <string>

class TextBuffer {
    std::string data_;
public:
    TextBuffer(std::string s) : data_(std::move(s)) {}

    // Before C++23: you needed two overloads
    // std::string& content() { return data_; }
    // const std::string& content() const { return data_; }

    // C++23: one function with deducing this
    auto&& content(this auto&& self) {
        return std::forward<decltype(self)>(self).data_;
    }

    // Deducing this enables recursive lambdas
    void demonstrate_recursive_lambda() {
        auto factorial = [](this auto self, int n) -> int {
            return n <= 1 ? 1 : n * self(n - 1);
        };
        std::cout << "5! = " << factorial(5) << "\n";
    }

    // Chaining with move support
    TextBuffer&& append(this TextBuffer&& self, std::string_view s) {
        self.data_ += s;
        return std::move(self);
    }
};

// Replace CRTP with deducing this
struct Equality {
    bool operator!=(this auto const& self, auto const& other) {
        return !(self == other);
    }
};

struct MyInt : Equality {
    int value;
    bool operator==(const MyInt& other) const { return value == other.value; }
};

int main() {
    TextBuffer buf("hello");
    std::cout << buf.content() << "\n";

    const TextBuffer cbuf("const");
    std::cout << cbuf.content() << "\n";

    buf.demonstrate_recursive_lambda();

    // MyInt is an aggregate with a base class, so a bare {1} would
    // try to initialize the Equality base. Designate the member.
    MyInt a{.value = 1}, b{.value = 2};
    std::cout << "a != b: " << (a != b) << "\n";  // uses deducing this

    return 0;
}
```

### `std::stacktrace`

C++23 standardizes stack trace capture, replacing platform-specific APIs.

```cpp
#include <stacktrace>
#include <iostream>
#include <stdexcept>

void inner_function() {
    // Capture current stack trace
    auto trace = std::stacktrace::current();
    std::cout << "Current stack trace:\n" << trace << "\n";
}

void middle_function() {
    inner_function();
}

void outer_function() {
    middle_function();
}

class DetailedException : public std::runtime_error {
    std::stacktrace trace_;
public:
    DetailedException(const std::string& msg)
        : std::runtime_error(msg)
        , trace_(std::stacktrace::current()) {}

    const std::stacktrace& trace() const { return trace_; }
};

int main() {
    outer_function();

    try {
        throw DetailedException("something went wrong");
    } catch (const DetailedException& e) {
        std::cout << "Exception: " << e.what() << "\n";
        std::cout << "Stack trace:\n" << e.trace() << "\n";
    }

    return 0;
}
```

**Go comparison**: Go includes stack traces in panics by default. C++ has historically lacked this capability in the standard, making `std::stacktrace` a welcome addition, though its runtime overhead means it is best used for error reporting, not hot paths.

### `ranges::to` and Other C++23 Range Additions

C++23 adds `std::ranges::to`, which fills a critical gap: collecting a range pipeline into a container. C++20 ranges could filter and transform lazily but had no standard way to materialize the result into a vector or set.

```cpp
#include <ranges>
#include <vector>
#include <string>
#include <set>
#include <print>

int main() {
    std::vector<int> numbers = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};

    // Collect a pipeline into a vector
    auto evens = numbers
        | std::views::filter([](int n) { return n % 2 == 0; })
        | std::views::transform([](int n) { return n * n; })
        | std::ranges::to<std::vector>();
    // evens: {4, 16, 36, 64, 100}

    // Collect into a different container type
    auto unique_evens = numbers
        | std::views::filter([](int n) { return n % 2 == 0; })
        | std::ranges::to<std::set>();

    // Collect strings
    std::vector<std::string> words = {"Hello", "World", "C++", "23"};
    auto long_words = words
        | std::views::filter([](const auto& s) { return s.size() > 2; })
        | std::ranges::to<std::vector>();

    for (const auto& w : long_words) {
        std::println("{}", w);  // Hello, World, C++
    }

    return 0;
}
```

C++23 also adds `std::views::zip`, `std::views::enumerate`, `std::views::chunk`, and `std::views::slide`, which bring C++ ranges closer to the ergonomics of Python itertools or Rust iterators.

```cpp
#include <ranges>
#include <vector>
#include <print>

int main() {
    std::vector<std::string> names = {"Alice", "Bob", "Carol"};
    std::vector<int> ages = {30, 25, 28};

    // zip: combine two ranges element-wise
    for (auto [name, age] : std::views::zip(names, ages)) {
        std::println("{} is {} years old", name, age);
    }

    // enumerate: get index and value (like Python's enumerate)
    for (auto [i, name] : std::views::enumerate(names)) {
        std::println("[{}] {}", i, name);
    }

    // chunk: split into groups of N
    std::vector<int> data = {1, 2, 3, 4, 5, 6, 7};
    for (auto chunk : data | std::views::chunk(3)) {
        std::print("[ ");
        for (int x : chunk) std::print("{} ", x);
        std::println("]");
    }
    // [ 1 2 3 ]
    // [ 4 5 6 ]
    // [ 7 ]

    return 0;
}
```

---

### Junior → FAANG: C++23 Features Worth Learning Now

For a junior engineer, the most immediately useful C++23 feature is `std::expected<T, E>`, which provides monadic error handling analogous to Go's `(T, error)` return. The difference: `std::expected` can be chained with `.and_then()` and `.transform()` without nested if-statements. `std::print` and `std::println` make output simpler than `std::cout`. `std::flat_map` and `std::flat_set` provide cache-friendly sorted containers as standard library types.

### Senior @ FAANG: C++23 Adoption in a C++20 Codebase

At the staff level, adopting C++23 features in a codebase that is already at C++20 is an incremental process. The priority list: `std::expected` (reduces error handling boilerplate significantly), `std::flat_map` and `std::flat_set` (replaces sorted-vector-as-map patterns), `std::print` (replaces logging boilerplate), and `std::generator` for lazy sequences. Each feature is adopted individually, with a build system flag change and a clang-tidy rule to prefer the new API over the old one in new code.

