## 3. Generators: Lazy Sequence Generation

Generators are the most intuitive application of coroutines. A generator produces values on demand, each call to `next()` resumes the coroutine, which runs until the next `co_yield` and suspends.

### Range-Compatible Generator

Here is a generator that integrates with C++ range-based for loops:

```cpp
#include <coroutine>
#include <iterator>
#include <utility>
#include <exception>

template <typename T>
class Generator {
public:
    struct promise_type {
        T current_value;
        std::exception_ptr exception = nullptr;

        Generator get_return_object() {
            return Generator{Handle::from_promise(*this)};
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        
        std::suspend_always yield_value(T value) {
            current_value = std::move(value);
            return {};
        }
        
        void return_void() {}
        
        void unhandled_exception() {
            exception = std::current_exception();
        }
    };

    using Handle = std::coroutine_handle<promise_type>;

    // Iterator for range-based for
    class iterator {
    public:
        using iterator_category = std::input_iterator_tag;
        using value_type = T;
        using difference_type = std::ptrdiff_t;
        using pointer = T*;
        using reference = T&;

        iterator() = default;
        explicit iterator(Handle handle) : handle_(handle) {}

        iterator& operator++() {
            handle_.resume();
            if (handle_.done()) {
                auto& promise = handle_.promise();
                if (promise.exception) {
                    std::rethrow_exception(promise.exception);
                }
                handle_ = nullptr;
            }
            return *this;
        }

        iterator operator++(int) {
            auto tmp = *this;
            ++(*this);
            return tmp;
        }

        T& operator*() { return handle_.promise().current_value; }
        T* operator->() { return &handle_.promise().current_value; }

        bool operator==(const iterator& other) const {
            return handle_ == other.handle_;
        }
        bool operator!=(const iterator& other) const {
            return !(*this == other);
        }

    private:
        Handle handle_ = nullptr;
    };

    iterator begin() {
        if (handle_) {
            handle_.resume();
            if (handle_.done()) return end();
        }
        return iterator{handle_};
    }

    iterator end() { return iterator{}; }

    explicit Generator(Handle h) : handle_(h) {}
    ~Generator() { if (handle_) handle_.destroy(); }

    Generator(const Generator&) = delete;
    Generator& operator=(const Generator&) = delete;
    Generator(Generator&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }
    Generator& operator=(Generator&& other) noexcept {
        if (this != &other) {
            if (handle_) handle_.destroy();
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }

private:
    Handle handle_ = nullptr;
};
```

### Practical Generator Examples

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```cpp
// Infinite sequence of natural numbers
Generator<int> naturals(int start = 0) {
    while (true) {
        co_yield start++;
    }
}

// Filtered range
Generator<int> even_numbers(int limit) {
    for (int i = 0; i < limit; ++i) {
        if (i % 2 == 0) {
            co_yield i;
        }
    }
}

// Reading lines from a large file lazily
Generator<std::string> read_lines(const std::string& filename) {
    std::ifstream file(filename);
    std::string line;
    while (std::getline(file, line)) {
        co_yield std::move(line);
    }
    // File closes when coroutine is destroyed
}

// Composing generators: flatten nested vectors
template <typename T>
Generator<T> flatten(std::vector<std::vector<T>>& nested) {
    for (auto& inner : nested) {
        for (auto& elem : inner) {
            co_yield elem;
        }
    }
}

int main() {
    // Take first 5 natural numbers
    int count = 0;
    for (int n : naturals()) {
        std::cout << n << " ";
        if (++count >= 5) break;
    }
    // Output: 0 1 2 3 4

    std::cout << "\n";

    // Even numbers up to 10
    for (int n : even_numbers(10)) {
        std::cout << n << " ";
    }
    // Output: 0 2 4 6 8

    std::cout << "\n";

    // Lazy file reading - only reads lines as consumed
    for (const auto& line : read_lines("data.txt")) {
        if (line.starts_with("#")) continue;  // Skip comments
        process(line);
    }
}
```

The key insight: a generator that reads a 10 GB file consumes only enough memory for one line at a time. The coroutine frame keeps the file handle and local variables alive between yields.

### Junior → FAANG: Generators as Lazy Iterators

The generator pattern solves a specific problem: you want to produce a sequence lazily (one element at a time, on demand) without managing explicit iterator state. The classic example: generating Fibonacci numbers, reading lines from a file, or producing permutations. Without coroutines, you need an iterator class with explicit state fields. With coroutines, local variables serve as the state.

The C++23 `std::generator<T>` (based on the Ranges TS) is the standard way to write generators from C++23 onward. For C++20, use CppCoro's `generator<T>` or implement a simple one following the promise type pattern in the previous section.

First-job tip: generators compose well with C++20 ranges. A generator that produces elements can be piped into range adaptors (`std::views::filter`, `std::views::transform`) without materializing the full sequence. This is the C++ equivalent of Go's channel-based pipelines.

### Senior @ FAANG: Generator Performance and Integration with Ranges

At L5+, the generator's performance characteristics are relevant for data pipelines. A coroutine generator has higher constant overhead than a hand-rolled iterator: each `co_yield` involves a coroutine suspend/resume, which is roughly equivalent to a function call (20-50ns on a modern CPU). For tight loops generating millions of simple values per second, this overhead is measurable.

The optimization: for performance-critical generators, use `std::generator<T>` (C++23) which is specifically optimized by the standard for generator use (symmetric transfer, no heap allocation in simple cases). For C++20, CppCoro's generator is similarly optimized.

Integration with io_uring (for async generators producing I/O results): an async generator that `co_await`s an io_uring completion and `co_yield`s the result combines the lazy evaluation of generators with the async I/O of coroutines. This pattern is used in production HTTP servers to process request bodies as a lazy sequence of buffers without materializing the full body.

ADR consideration: before using a generator-based pipeline for a high-throughput data path, benchmark against a push-based pipeline (callback or observer pattern). Pull-based pipelines (generators) are easier to reason about but have one context switch per element. Push-based pipelines batch work but require explicit backpressure mechanisms. The crossover depends on element size and processing cost per element.

---
