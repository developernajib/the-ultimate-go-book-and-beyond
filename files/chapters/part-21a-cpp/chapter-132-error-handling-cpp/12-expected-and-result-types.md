## `std::expected` and Result Types

C++23 added `std::expected<T, E>`, the standard library's first proper sum type for "value or error". It mirrors Rust's `Result<T, E>`, Haskell's `Either e a`, and the long line of pre-standard libraries (Boost.Outcome, `tl::expected`, `absl::StatusOr`, `folly::Expected`). This is the library facility that finally lets a C++ codebase express "this function might fail" without paying for exception machinery and without smuggling errors through out-parameters.

### Anatomy of `std::expected`

```cpp
#include <expected>
#include <string>
#include <system_error>

std::expected<int, std::error_code> parse_port(std::string_view s) {
    int v = 0;
    auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
    if (ec != std::errc{}) {
        return std::unexpected(std::make_error_code(ec));
    }
    if (v <= 0 || v > 65535) {
        return std::unexpected(std::make_error_code(std::errc::result_out_of_range));
    }
    return v;
}
```

Storage is a tagged union of `T` and `E` plus a discriminant. Size is `max(sizeof(T), sizeof(E)) + alignment + 1`. There is no heap allocation. Constructing the error case goes through `std::unexpected<E>`, which exists to disambiguate from `T` in the constructors.

Access:

```cpp
auto r = parse_port("8080");
if (r) {                      // contextually convertible to bool
    use(*r);                  // or r.value()
} else {
    log(r.error());
}
int port = r.value_or(80);    // default
```

`*r` and `r.value()` differ: `*r` is undefined behavior if there is no value (a precondition violation), while `value()` throws `std::bad_expected_access<E>` carrying the error. Use `*r` after an explicit `if (r)` check (zero overhead). Use `value()` when you genuinely want exception propagation at that boundary.

## Monadic Operations

The C++23 API lifts `expected` into a small monad:

```cpp
std::expected<Config, Error> load_config(std::string_view path);

auto result = load_config("/etc/svc.toml")
    .and_then([](Config c) -> std::expected<Server, Error> {
        return build_server(c);
    })
    .transform([](Server s) {
        return s.with_default_routes();
    })
    .or_else([](Error e) -> std::expected<Server, Error> {
        if (e == Error::not_found) return default_server();
        return std::unexpected(e);
    });
```

- `transform(f)`: if value, apply `f`, wrap in `expected`. Equivalent to `fmap`. Maps `T -> U` keeping `E`.
- `and_then(f)`: if value, apply `f` which itself returns `expected<U, E>`. Equivalent to monadic bind. Maps `T -> expected<U, E>`.
- `transform_error(f)`: maps `E -> F` keeping `T`. Equivalent to `fmap` on the error channel.
- `or_else(f)`: if error, apply `f` which returns `expected<T, F>`. Recovery. Maps `E -> expected<T, F>`.

These chain without nested `if` ladders, which is why pipelines that previously required four levels of indentation collapse to a flat chain.

## Compared with Exceptions

| Axis | `std::expected` | Exceptions |
|---|---|---|
| Cost on success | One branch, often inlined out | Effectively zero (Itanium) |
| Cost on failure | One branch | 10 to 50 microseconds |
| Visible in signature | Yes | No (unless `noexcept` used) |
| Crosses ABI cleanly | Yes | Risky across `.so` boundaries |
| Forces caller to handle | Yes (warn-unused-result) | No |
| Chains naturally | Yes (monadic) | No |
| Carries context | Whatever `E` carries | Type plus `what()` |

The right rule on a large codebase: use `expected` for expected-but-non-success outcomes (parse failure, key not found, validation error), use exceptions for genuinely exceptional invariant violations (OOM, programmer error not caught by `assert`, unrecoverable I/O). Mixing both is correct. The mistake is using exceptions for control flow or `expected` for a programmer bug.

## `absl::StatusOr<T>` (Google)

Predates `std::expected` by a decade. Used across Google production C++.

```cpp
absl::StatusOr<int> ParsePort(absl::string_view s);

ASSIGN_OR_RETURN(int port, ParsePort(s));     // Google macro, early-return on error
RETURN_IF_ERROR(StartServer(port));
```

`absl::Status` carries a code (an enum, gRPC-aligned), a message, and a payload map (arbitrary `absl::Cord` blobs keyed by URL). The payload map is the killer feature: you can attach a stack trace, a request ID, a debug proto, anything. `std::expected` has nothing like it. If you build a polyglot service mesh, `absl::Status` is closer to what you want, because the error channel is rich enough to round-trip across an RPC.

`absl::StatusOr<T>` enforces "must check before access" via `CHECK` (process-fatal). `std::expected` uses UB on `*` and exception on `value()`. The two are not interchangeable in style: Google code is dense with `ASSIGN_OR_RETURN`, which is essentially Rust's `?` operator.

## Boost.Outcome (Niall Douglas)

`outcome::result<T, E>` and `outcome::outcome<T, EC, E>`. The third type parameter holds an "exception payload" so you can carry both a structured error code and an exception type without throwing. Outcome's design goals were:

- Zero-overhead empty-error path.
- Strong contractual guarantees (no exceptions thrown by the type itself, fully `constexpr`).
- Customization points for converting between error categories (`SYSTEM_ERROR2_CONSTEXPR14` and friends).

Outcome predates `std::expected` and influenced its API. If you maintain a codebase that started on Outcome, migration to `std::expected` is mostly mechanical, but you lose the third "exception-ptr" channel.

### `tl::expected` (Sy Brand)

Header-only, C++11/14/17 backport of `std::expected`. The reference pre-standardization implementation. If you cannot move to C++23, `tl::expected` is the right choice. API is essentially identical, including `transform` and `and_then`.

### `folly::Expected` and `folly::Try`

Meta's pair. `folly::Expected<V, E>` is similar to `tl::expected`. `folly::Try<T>` is interesting because it stores either a value, an exception (via `exception_wrapper`), or "empty". `Try` is the bridge between Meta's `folly::Future<T>::then()` callbacks and exceptions: a future's continuation receives `Try<T>` so it can branch on error without unwinding.

### Pitfalls

**Reference types.** `std::expected<T&, E>` is supported in C++23 and forces you to think about lifetime. Most codebases stick to value types and use `std::expected<std::reference_wrapper<T>, E>` if they need a reference, because plain `T&` invites dangling.

**Void value.** `std::expected<void, E>` is the right type for "function with side effect that can fail". Use it instead of `std::expected<bool, E>` or `std::optional<E>`.

**Implicit conversions.** `std::expected<int, int>` is a footgun: both arms are the same type. Wrap your error in a tag struct or use `std::error_code` rather than raw `int`.

**Discarded results.** Mark functions returning `expected` with `[[nodiscard]]`. Without it, callers can drop errors on the floor exactly as silently as a thrown-and-caught-and-ignored exception.

```cpp
[[nodiscard]] std::expected<File, std::error_code> open(std::string_view path);
```

**Equality.** `std::expected<T, E>` defines `operator==` element-wise. Two errors compare equal if `E` does. This is occasionally surprising: a successful zero may equal a different value-arm zero across types.

### When to Use What

- Plain `bool` return with out-parameter: legacy code only. New code never.
- `std::optional<T>`: "absence is not an error". Map lookup miss, parsed-or-not, end-of-stream.
- `std::expected<T, E>`: "this can fail and the caller needs to know why".
- Exceptions: invariant violations, unrecoverable resource exhaustion, "this should never happen but I cannot prove it statically", or constructor failures where the type cannot be partially constructed.
- `absl::StatusOr<T>`: when you need rich, RPC-friendly error context with payloads.

### FAANG Bar

A senior engineer should:

- Reach for `expected` (or its equivalent) before reaching for exceptions in domain code.
- Know that `value()` throws and `*` is UB on the error path.
- Use `transform` / `and_then` for pipelines instead of nested `if (r) {}`.
- Pick `absl::Status`-shaped types when the error must cross a network or process boundary.
- Mark return types `[[nodiscard]]`.
