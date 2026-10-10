## std::format and std::print (C++20 / C++23)

`std::format` shipped with C++20. `std::print` and `std::println` shipped with C++23. Together they replace `printf`, `iostream`, and most third-party formatting libraries with a type-safe, extensible, compile-time-checked formatter that lives in the standard library. The lineage traces directly to Victor Zverovich's `{fmt}` library, which the committee adopted nearly verbatim.

## std::format

`std::format` returns a `std::string` built from a format string and arguments.

```cpp
#include <format>

std::string s = std::format("hello {}, you are {} years old", name, age);
```

Placeholders use `{}` with optional positional and format specifiers.

```cpp
std::format("{0} and {1} and {0}", "a", "b");          // "a and b and a"
std::format("{:>10}", "x");                            // "         x"
std::format("{:0>5d}", 42);                            // "00042"
std::format("{:.3f}", 3.14159);                        // "3.142"
std::format("{:#x}", 255);                             // "0xff"
std::format("{:%Y-%m-%d}", date);                      // chrono date
```

The grammar mirrors Python's f-string mini-language, which is itself derived from `printf` family conventions but cleaner. Width, fill, alignment, sign, alternate form, precision, type. The full table is in the standard.

### Compile-Time Format String Validation

The format string is checked at compile time. A type mismatch fails to compile.

```cpp
std::format("{:d}", "hello");   // ERROR: 'd' requires integer
std::format("{} {}", 1);         // ERROR: not enough arguments
std::format("{:.3f}", "x");      // ERROR: 'f' requires floating point
```

This works because the constructor of `std::format_string<Args...>` is `consteval`. The format string is parsed against the argument types during translation. There is no runtime validation cost. Misuse becomes a compiler error, not a thrown exception or silent garbage.

If the format string is itself a runtime value, use `std::vformat`.

```cpp
std::string fmt = load_localised_string();
std::string out = std::vformat(fmt, std::make_format_args(name, age));
```

`vformat` accepts a runtime string and validates at runtime. Failure throws `std::format_error`.

## std::format_to

Formats into an iterator. Avoids allocating a `std::string` when writing into a buffer or stream.

```cpp
char buf[64];
auto end = std::format_to(buf, "value={}", x);
*end = '\0';

std::vector<char> v;
std::format_to(std::back_inserter(v), "{}-{}", a, b);
```

`std::format_to_n` writes at most N characters and returns both the past-the-end iterator and the count that would have been written without truncation.

### std::print and std::println (C++23)

`std::print` writes a formatted string to `stdout` (or a passed `FILE*` or `std::ostream`).

```cpp
##include <print>

std::print("hello {}\n", name);
std::println("hello {}", name);                  // adds newline

std::print(stderr, "error: {}\n", msg);
std::println(std::cerr, "error: {}", msg);
```

`println` is the newline variant. Both are vastly faster than `iostream` because they bypass the stateful `std::cout` machinery. They are also Unicode-correct on Windows out of the box (they write UTF-8 to the console correctly, which `iostream` famously does not).

The formatter validates the string at compile time, like `std::format`.

### Custom Formatters

Specialise `std::formatter<T>` for your own type.

```cpp
struct Point { double x, y; };

template <>
struct std::formatter<Point> {
    constexpr auto parse(std::format_parse_context& ctx) {
        return ctx.begin();   // accept no spec
    }
    auto format(const Point& p, std::format_context& ctx) const {
        return std::format_to(ctx.out(), "({}, {})", p.x, p.y);
    }
};

std::print("location {}\n", Point{1.5, 2.5});   // location (1.5, 2.5)
```

`parse` consumes any spec characters between `:` and `}`. `format` writes the output to `ctx.out()`. For richer formatters that accept their own spec, parse the format spec in `parse` and store it on `*this`.

```cpp
template <>
struct std::formatter<Point> {
    bool with_label = false;

    constexpr auto parse(std::format_parse_context& ctx) {
        auto it = ctx.begin();
        if (it != ctx.end() && *it == 'L') { with_label = true; ++it; }
        if (it != ctx.end() && *it != '}') throw std::format_error("bad");
        return it;
    }

    auto format(const Point& p, std::format_context& ctx) const {
        if (with_label) return std::format_to(ctx.out(), "Point(x={}, y={})", p.x, p.y);
        else            return std::format_to(ctx.out(), "({}, {})", p.x, p.y);
    }
};

std::format("{}",  Point{1, 2});   // (1, 2)
std::format("{:L}", Point{1, 2});  // Point(x=1, y=2)
```

Inherit from a built-in formatter for trivial reuse:

```cpp
template <>
struct std::formatter<Point> : std::formatter<std::string> {
    auto format(const Point& p, std::format_context& ctx) const {
        return std::formatter<std::string>::format(
            std::format("({}, {})", p.x, p.y), ctx);
    }
};
```

This hands the spec parsing to the string formatter, so width and alignment work for free.

## Performance

The 2020-2023 benchmarks consistently put `std::format` and `{fmt}` ahead of `printf` and far ahead of `iostream`.

| Operation | Relative time |
|---|---|
| `iostream <<` | 1.00 |
| `printf` | 0.4 |
| `std::format` | 0.25 |
| `std::print` (C++23) | 0.22 |
| `fmt::format` | 0.20 |

Reasons. `std::print` writes directly to the underlying file descriptor without going through `std::cout`'s synchronization. Format-string parsing is fully consteval, so the runtime side is just type-erased argument writing. There is no locale lookup unless you ask for it (`std::format_to(std::locale{}, ...)`).

For maximum throughput, prefer `std::format_to` into a fixed buffer over `std::format` into a `std::string`.

## Replacing iostream in Production

The migration plan large codebases follow.

1. Replace `std::cout << x << ' ' << y` with `std::println("{} {}", x, y)`.
2. Replace `std::cerr << "err: " << msg` with `std::println(std::cerr, "err: {}", msg)`.
3. Replace `std::stringstream` builders with `std::format` calls.
4. Replace `printf("%d %s", n, s)` with `std::print("{} {}\n", n, s)`. The compiler now catches type mismatches.
5. Implement `std::formatter<T>` for domain types instead of `operator<<`.

The wins. Type safety, compile-time format checking, faster runtime, correct Unicode on Windows, no locale-induced surprises, no global state mutations.

The cost. `<format>` and `<print>` are heavyweight headers. Including them in widely-used headers slows compilation. Use them in `.cpp` files or, in module-aware projects, behind `import std`.

## Compiler Support (2026)

| Compiler | std::format | std::print |
|---|---|---|
| GCC 13 | yes | partial |
| GCC 14+ | yes | yes |
| Clang 17 | yes | partial |
| Clang 18+ | yes | yes |
| MSVC 17.5+ | yes | yes (17.7+) |

For older toolchains, the `{fmt}` library is a drop-in. `fmt::format` and `fmt::print` are nearly identical APIs. Many shops use `{fmt}` even on C++20-capable compilers because it backports C++23 features to older standards.

## Junior to FAANG / Senior at FAANG

A junior should know `std::format`, `std::print`, and `std::println`. They should understand that the format string is consteval-checked and that `std::vformat` is the runtime escape hatch. They should write a `std::formatter<MyType>` specialization when introducing a printable type.

A senior is expected to retire `iostream` from new code, build logging pipelines on top of `std::format_to` to avoid string allocations, design custom formatters that accept rich format specs (chrono, ranges, structured types), and benchmark format-heavy hot paths. They should know how `std::print` interacts with stdio synchronization, when to lock around shared file handles, and how to integrate `std::format` with structured logging frameworks that consume key-value pairs.
