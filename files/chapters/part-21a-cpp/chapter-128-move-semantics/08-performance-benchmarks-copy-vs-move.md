## Performance Benchmarks: Copy vs. Move

Let us measure the real-world impact of move semantics with different types and sizes.

### Benchmark: `std::string`

The following benchmark measures the difference between deep-copying a 1 MB string (which involves allocating heap memory and copying bytes) versus moving it (which transfers internal pointers):
```cpp
#include <chrono>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

int main() {
    const int iterations = 1'000'000;

    // Create a large string (1MB)
    std::string large(1'000'000, 'x');

    // Benchmark: Copy construction
    {
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            std::string copy(large);             // Copy: allocate + memcpy 1MB
            (void)copy;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "String copy (1MB x " << iterations << "): " << ms.count() << " ms\n";
    }

    // Benchmark: Move construction
    {
        std::vector<std::string> sources(iterations, large);  // Pre-allocate sources
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            std::string moved(std::move(sources[i]));  // Move: swap 3 pointers
            (void)moved;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "String move (1MB x " << iterations << "): " << ms.count() << " ms\n";
    }

    return 0;
}
```

Typical results on a modern machine (compiled with `-O2`):

```
String copy (1MB x 1000000): 4200 ms
String move (1MB x 1000000): 12 ms
```

Move is approximately **350x faster** for large strings because it transfers a pointer instead of copying a megabyte.

### Benchmark: `std::vector`

For dynamically sized containers like `std::vector<int>`, copy construction duplicates the underlying buffer on the heap, whereas move construction swaps the internal data pointers and size metadata in constant time:
```cpp
#include <chrono>
#include <iostream>
#include <utility>
#include <vector>

int main() {
    const int iterations = 100'000;
    const int vec_size = 100'000;

    // Create a large vector
    std::vector<int> large(vec_size, 42);

    // Benchmark: Copy
    {
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            std::vector<int> copy(large);  // Copy: allocate + copy 400KB
            (void)copy;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "Vector copy (" << vec_size << " ints x " << iterations << "): "
                  << ms.count() << " ms\n";
    }

    // Benchmark: Move
    {
        std::vector<std::vector<int>> sources(iterations, large);
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            std::vector<int> moved(std::move(sources[i]));  // Move: swap 3 pointers
            (void)moved;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "Vector move (" << vec_size << " ints x " << iterations << "): "
                  << ms.count() << " ms\n";
    }

    return 0;
}
```

Typical results:

```
Vector copy (100000 ints x 100000): 3800 ms
Vector move (100000 ints x 100000): 3 ms
```

### Benchmark: Custom Large Object

For a compound object containing strings, dynamic arrays, stack buffers, and smart pointers, moving avoids multiple independent heap reallocations and deep buffer traversals:
```cpp
#include <array>
#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

class GameState {
public:
    std::string player_name;
    std::vector<double> positions;           // 10,000 positions
    std::array<char, 4096> stack_buffer{};   // Stack-allocated buffer
    std::unique_ptr<int[]> heap_data;        // Heap-allocated data

    GameState()
        : player_name("Player One"),
          positions(10'000, 3.14),
          heap_data(std::make_unique<int[]>(1000)) {}

    // Copy constructor - expensive
    GameState(const GameState& other)
        : player_name(other.player_name),
          positions(other.positions),
          stack_buffer(other.stack_buffer),
          heap_data(std::make_unique<int[]>(1000)) {
        std::copy(other.heap_data.get(), other.heap_data.get() + 1000, heap_data.get());
    }

    // Move constructor - cheap
    GameState(GameState&&) noexcept = default;

    GameState& operator=(const GameState&) = delete;
    GameState& operator=(GameState&&) noexcept = default;
};

int main() {
    const int iterations = 50'000;
    GameState original;

    // Copy benchmark
    {
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            GameState copy(original);
            (void)copy;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "GameState copy x " << iterations << ": " << ms.count() << " ms\n";
    }

    // Move benchmark
    {
        std::vector<GameState> sources;
        sources.reserve(iterations);
        for (int i = 0; i < iterations; ++i) {
            sources.push_back(GameState(original));
        }
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < iterations; ++i) {
            GameState moved(std::move(sources[i]));
            (void)moved;
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "GameState move x " << iterations << ": " << ms.count() << " ms\n";
    }

    return 0;
}
```

Typical results:

```
GameState copy x 50000: 2100 ms
GameState move x 50000: 8 ms
```

### Performance Summary Table

| Type | Size | Copy Time | Move Time | Speedup |
|------|------|-----------|-----------|---------|
| `std::string` (1MB) | 1 MB | ~4.2 ns/byte | ~12 ns total | ~350x |
| `std::vector<int>` (100K) | 400 KB | ~38 ns/elem | ~30 ns total | ~1200x |
| `GameState` (complex) | ~84 KB | ~42 us | ~0.16 us | ~260x |
| `int` | 4 B | ~1 ns | ~1 ns | 1x (no benefit) |
| `std::array<char, 16>` | 16 B | ~2 ns | ~2 ns | 1x (no benefit) |

Key insight: move semantics provide dramatic speedups for types that own heap-allocated resources. For small, stack-only types, there is no benefit because the "move" is just a copy of the bytes.

---

### Junior → FAANG: Benchmarking as a Professionalism Signal

Go engineers who want to claim performance differences use `go test -bench`. In C++, Google Benchmark is the equivalent. Any claim about copy vs. move performance in a code review should be backed by a benchmark, not intuition. "Moving should be faster than copying" is true in general. "moving is faster than copying for this specific type in this specific usage pattern" requires evidence.

Practice: run the benchmarks in this section with modifications. What happens when the string is 16 bytes (small string optimization territory)? What happens when `noexcept` is removed from the move constructor? What happens with `-O0` vs. `-O2`? These experiments build the mental model that benchmarks reveal rather than intuition guesses.

### Senior @ FAANG: Benchmark Infrastructure Ownership and Regression Detection

At the staff level, performance benchmarks are not one-time experiments. They are part of the CI infrastructure. A staff engineer ensures: Google Benchmark runs are part of CI (though not blocking, due to machine variance), baseline numbers are stored and compared across PRs (using tools like `bencher.dev` or a custom benchmark comparison script), and significant regressions (more than 5% on benchmarks explicitly marked as performance-sensitive) trigger an alert and block the PR.

The move vs. copy benchmark specifically should be part of the benchmark suite for any type that is on the performance-critical hot path. When a PR modifies a type's copy or move semantics, the benchmark immediately reveals whether the change regressed or improved the critical path.

