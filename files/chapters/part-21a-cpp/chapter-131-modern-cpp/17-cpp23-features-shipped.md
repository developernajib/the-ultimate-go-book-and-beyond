## C++23 Features Shipped

C++23 is the polish release after C++20's big four (concepts, ranges, modules, coroutines). It fills gaps with high-impact library additions and small language ergonomics. This is the per-feature inventory with compiler support as of 2026.

### `std::expected<T, E>`

A sum type carrying either a value of `T` or an error of `E`. Replaces error-returning `std::optional`, `int` error codes, and `std::variant<T, std::error_code>` patterns.

```cpp
#include <expected>

std::expected<int, std::string> parse_int(std::string_view s) {
    int v;
    auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
    if (ec != std::errc{}) return std::unexpected("not a number");
    return v;
}

if (auto r = parse_int("42")) {
    std::print("got {}\n", *r);
} else {
    std::print("error: {}\n", r.error());
}
```

`std::expected` supports monadic operations.

```cpp
auto pipeline = parse_int(s)
              .transform([](int x) { return x * 2; })
              .and_then([](int x) -> std::expected<int, std::string> {
                  if (x > 100) return std::unexpected("too big");
                  return x;
              })
              .or_else([](auto e) -> std::expected<int, std::string> {
                  std::print("recovered from: {}\n", e);
                  return 0;
              });
```

`transform` maps the value, `and_then` chains another expected-returning call, `or_else` recovers from errors. This is the Rust `Result<T, E>` API in C++ form.

Compilers: GCC 12+, Clang 16+, MSVC 17.3+.

### std::print and std::println

Already covered in detail. Direct stdout writing, compile-time format check, Unicode-correct on Windows. GCC 14+, Clang 18+, MSVC 17.7+.

### std::flat_map and std::flat_set

Sorted-vector-backed associative containers with the same interface as `std::map` and `std::set` but cache-friendly storage.

```cpp
#include <flat_map>

std::flat_map<int, std::string> m = {{3, "c"}, {1, "a"}, {2, "b"}};
m[4] = "d";
auto it = m.find(2);
```

Internally a sorted `std::vector<std::pair<Key, Value>>` (or two parallel vectors with `std::flat_map`'s container split). Lookup is O(log n) via binary search. Insertion is O(n) because of vector shifts. Best for read-heavy small-to-medium maps where iteration locality dominates.

Performance vs `std::map`. `std::map` is a red-black tree with one allocation per node. Cache-hostile. `std::flat_map` is contiguous, cache-friendly, but expensive to mutate. Switch to `flat_map` when:

- The map is built once and read many times.
- The map is small (under a few thousand entries).
- Iteration is in a hot path.
- Memory fragmentation matters.

Compilers: libstdc++ partial (GCC 15+), MSVC 17.10+, libc++ pending. Use Boost.Container or `absl::flat_hash_map` (different semantics) as fallback.

### std::mdspan

Non-owning multidimensional view over contiguous memory. The C++ answer to NumPy's array view.

```cpp
#include <mdspan>

std::vector<double> data(rows * cols);
std::mdspan<double, std::dextents<std::size_t, 2>> mat(data.data(), rows, cols);

for (std::size_t i = 0; i < rows; ++i)
    for (std::size_t j = 0; j < cols; ++j)
        mat[i, j] = i * cols + j;     // C++23 multi-arg subscript
```

Templates control extents (compile-time vs runtime), layout (row-major, column-major, strided, padded), and accessor (default, atomic, custom). Zero-cost abstraction over raw memory. Fundamental for SciML, simulation, and image processing.

```cpp
// Compile-time fixed extents.
std::mdspan<float, std::extents<std::size_t, 4, 4>> rotation(buf);

// Strided layout (e.g., a column slice).
using LayoutStrided = std::layout_stride;
std::mdspan<double, std::dextents<std::size_t, 2>, LayoutStrided>
    slice(data, mapping);
```

Compilers: GCC 14+, Clang 18+, MSVC 17.10+. Reference implementation in Kokkos predates the standard.

### std::generator

Coroutine-based input range. Already covered. GCC 14+, Clang 18+, MSVC 17.10+.

### std::start_lifetime_as

Begins the lifetime of an object in pre-existing storage without running a constructor. The legitimate way to interpret raw bytes as a trivial type.

```cpp
char buffer[sizeof(Header)];
std::memcpy(buffer, network_data, sizeof(Header));
Header* h = std::start_lifetime_as<Header>(buffer);
process(*h);
```

Before C++23 this required `std::launder` plus implementation-defined assumptions about strict aliasing. `std::start_lifetime_as` makes the operation well-defined for trivially copyable types. Critical for serialization, network protocols, and shared-memory IPC.

`std::start_lifetime_as_array<T>(p, n)` works for arrays.

Compilers: GCC 14+, Clang 18+, MSVC 17.9+.

## std::byteswap

Endian conversion for integer types. Replaces `htonl`, `__builtin_bswap32`, and hand-written shift hacks.

```cpp
##include <bit>

std::uint32_t native = 0x12345678;
auto swapped = std::byteswap(native);   // 0x78563412
```

Compiles to a single `bswap` instruction on x86 / `rev` on ARM. `std::endian::native` (since C++20) tells you the host endianness at compile time.

```cpp
std::uint32_t to_big_endian(std::uint32_t x) {
    if constexpr (std::endian::native == std::endian::little)
        return std::byteswap(x);
    else
        return x;
}
```

GCC 13+, Clang 16+, MSVC 17.4+.

## std::ranges::to

Materialises a view into a container. Closes the gap between view pipelines and concrete containers.

```cpp
auto vec = std::views::iota(1, 100)
         | std::views::filter([](int x){ return x % 3 == 0; })
         | std::ranges::to<std::vector>();

auto set = std::views::transform(words, [](auto&& w){ return std::hash<std::string>{}(w); })
         | std::ranges::to<std::unordered_set<std::size_t>>();
```

Generic over the target container. Works with `std::vector`, `std::list`, `std::map`, `std::string`, anything with the right constructors.

GCC 14+, Clang 17+, MSVC 17.8+.

## Other Notable Additions

**Multi-dimensional subscript `[i, j]`.** The `operator[](auto...)` form. Used by `std::mdspan`. GCC 12+, Clang 15+, MSVC 17.6+.

**`if consteval`.** Already covered. GCC 12+, Clang 14+, MSVC 17.4+.

**Deducing this.** Already covered. GCC 14+, Clang 18+, MSVC 17.10+.

**Static `operator()`.** A function-object's call operator can be `static`, dropping the implicit object pointer. Useful for stateless function objects passed by value.

```cpp
struct Hash {
    static constexpr auto operator()(std::string_view s) noexcept {
        return std::hash<std::string_view>{}(s);
    }
};
```

GCC 13+, Clang 16+, MSVC 17.5+.

**`std::move_only_function`.** A `std::function` that supports move-only callables. Allocates only on capture overflow. Replaces `std::function` for `unique_ptr`-capturing lambdas.

```cpp
std::move_only_function<void()> task = [p = std::make_unique<Resource>()] {
    p->run();
};
```

GCC 13+, Clang 17+, MSVC 17.5+.

**`std::stacktrace`.** Captures and prints a stack trace. Long overdue.

```cpp
##include <stacktrace>

void log_error() {
    std::println("error at:\n{}", std::stacktrace::current());
}
```

GCC 14+, MSVC 17.4+, Clang 18+ (with `-lstdc++_libbacktrace` on libstdc++).

**`size_t` literals.** `1uz` is a `size_t`. Useful for loop bounds against container sizes.

```cpp
for (auto i = 0uz; i < v.size(); ++i) /* ... */;
```

GCC 11+, Clang 13+, MSVC 17.4+.

**Multidimensional `subscript[]` for user types.** Not just for `mdspan`.

**Named universal character escapes.** `"\N{GREEK SMALL LETTER PI}"`.

## Compiler Adoption Snapshot (2026)

| Feature | GCC | Clang | MSVC |
|---|---|---|---|
| std::expected | 12 | 16 | 17.3 |
| std::print/println | 14 | 18 | 17.7 |
| std::flat_map | 15 | partial | 17.10 |
| std::mdspan | 14 | 18 | 17.10 |
| std::generator | 14 | 18 | 17.10 |
| start_lifetime_as | 14 | 18 | 17.9 |
| byteswap | 13 | 16 | 17.4 |
| ranges::to | 14 | 17 | 17.8 |
| deducing this | 14 | 18 | 17.10 |
| if consteval | 12 | 14 | 17.4 |
| static operator() | 13 | 16 | 17.5 |
| move_only_function | 13 | 17 | 17.5 |
| stacktrace | 14 | 18 | 17.4 |

GCC 14, Clang 18, and MSVC 17.10 are roughly the "C++23 complete" baselines. Earlier versions cover most of the language but lag on library features.

## Junior to FAANG / Senior at FAANG

A junior should reach for `std::expected` over error codes, use `std::print` instead of `std::cout`, materialise views with `std::ranges::to<std::vector>()`, and use `std::byteswap` for endian conversion.

A senior is expected to evaluate `std::flat_map` vs `std::unordered_map` based on access pattern and size, design APIs around `std::mdspan` for numeric kernels, replace `std::launder` rituals with `std::start_lifetime_as` in zero-copy code paths, and migrate `std::function` callbacks to `std::move_only_function` to enable `unique_ptr` captures. They should track per-compiler adoption when shipping libraries that target multiple toolchains, and know which features still require flag opt-in (`-std=c++23`, `/std:c++latest`).
