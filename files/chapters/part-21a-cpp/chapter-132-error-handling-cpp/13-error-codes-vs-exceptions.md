## Error Codes vs Exceptions: `std::error_code` and Friends

Before `std::expected` shipped in C++23, the standard library's principled answer to "value or error without exceptions" was `std::error_code`. It is not going away. Filesystem (`<filesystem>`), networking proposals (Asio, P2300 senders), and most of the C-facing portions of the standard library expose `error_code` overloads alongside throwing overloads. Knowing this type is mandatory for any C++ engineer past their first job.

### The Three Types

```cpp
#include <system_error>

class error_category;        // identity, name, message lookup
class error_code;            // (int value, const error_category&)
class error_condition;       // platform-independent error class
class system_error;          // exception wrapping an error_code
```

- `error_category` is a singleton-per-domain. Compares by address. Provides `name()` and `message(int)`. POSIX errors live in `std::generic_category()`. Platform native errors (Win32 `GetLastError`, POSIX `errno`) live in `std::system_category()`.
- `error_code` is a 16-byte value type: a small int (`value()`) and a category pointer (`category()`). Cheap to copy, cheap to compare, no allocation.
- `error_condition` represents the abstract class of error ("file not found"), independent of OS. The mapping `error_code -> error_condition` is what lets you write portable comparisons.
- `system_error` is the exception type. Derives from `runtime_error`. Wraps an `error_code`.

### A Custom Category

```cpp
enum class parse_error {
    ok = 0,
    empty_input,
    bad_digit,
    overflow,
    unexpected_end,
};

class parse_category_t : public std::error_category {
public:
    const char* name() const noexcept override { return "parse"; }
    std::string message(int v) const override {
        switch (static_cast<parse_error>(v)) {
            case parse_error::ok:             return "ok";
            case parse_error::empty_input:    return "empty input";
            case parse_error::bad_digit:      return "bad digit";
            case parse_error::overflow:       return "overflow";
            case parse_error::unexpected_end: return "unexpected end of input";
        }
        return "parse: unknown";
    }
};

const std::error_category& parse_category() {
    static parse_category_t instance;
    return instance;
}

std::error_code make_error_code(parse_error e) {
    return {static_cast<int>(e), parse_category()};
}

namespace std {
    template<> struct is_error_code_enum<parse_error> : true_type {};
}
```

The `is_error_code_enum` trait plus the ADL-found `make_error_code` is what allows implicit conversion `parse_error -> std::error_code`. Without that opt-in, the conversion does not happen and you have to call `make_error_code` explicitly everywhere.

Use:

```cpp
std::error_code parse(std::string_view s, int& out) {
    if (s.empty()) return parse_error::empty_input;
    // ...
    return {};
}
```

`return {};` returns a default-constructed `error_code`, which compares equal to "no error". `if (ec)` is true exactly when `value() != 0`.

## Mapping to a Generic Condition

The `error_code -> error_condition` mapping lets callers ask "is this a 'no such file' error?" without caring whether the underlying source was POSIX, Windows, or your own category.

```cpp
class parse_category_t : public std::error_category {
    // ...
    std::error_condition default_error_condition(int v) const noexcept override {
        switch (static_cast<parse_error>(v)) {
            case parse_error::overflow:
                return std::make_error_condition(std::errc::result_out_of_range);
            default:
                return {v, *this};
        }
    }
};

// Caller code (portable):
std::error_code ec = parse(s, x);
if (ec == std::errc::result_out_of_range) { /* ... */ }
```

The comparison `error_code == errc` invokes the equivalence machinery: it asks each side's category whether they are equivalent. This is genuinely useful for code that wants to handle classes of errors without enumerating every category's specific values.

## `std::system_error`

```cpp
void must_parse(std::string_view s) {
    int v = 0;
    if (auto ec = parse(s, v)) {
        throw std::system_error(ec, "parsing config port");
    }
    // ...
}
```

`system_error::what()` returns a string combining the user message with the category's message. `system_error::code()` returns the original `error_code`. This is the canonical bridge between the error-code world and the exception world: bottom layers return codes, the boundary layer either propagates or throws.

### Performance

| Operation | Cost |
|---|---|
| Construct `error_code` | One int copy plus pointer copy |
| Compare two `error_code` | Two integer compares |
| Compare across categories | Virtual call to `equivalent` |
| Throw `system_error` | 10 to 50 microseconds |
| Return `error_code` up 20 frames | Nanoseconds |

This is why driver-level code (filesystem, networking, parsing) uses `error_code` and the exception variants are convenience wrappers. A web server doing 200k requests per second cannot afford a thrown exception per malformed header.

### Debuggability

Codes are easier to log and serialize. They carry no stack trace by themselves, but a logged `(category, value, where)` tuple is enough to grep production logs. Exceptions carry `what()` and (with C++23 `<stacktrace>`) optionally a stack, which is richer at the throw site but vanishes if anyone writes `catch (...) { /* swallow */ }`.

For post-mortem analysis (`gdb` on a core dump), throwing leaves the throw site on the stack only if you abort before catch (`-fno-omit-frame-pointer` plus a deliberate `terminate`). Codes are not on the stack at all and rely on logging.

### ABI Stability

`error_code` is plain old data plus a pointer. It crosses shared library boundaries safely as long as both sides agree on the category singleton. Static categories (`generic_category`, `system_category`) are guaranteed to be the same singleton because they are defined by the standard library. Custom categories defined in a header that is instantiated in two `.so`s can produce two distinct singletons, and comparisons across them silently fail.

The fix: define the category in a single translation unit, export the function, and never inline the category-returning function across DSOs.

```cpp
// header
ATTR_VISIBILITY_DEFAULT const std::error_category& parse_category();
// .cpp
const std::error_category& parse_category() {
    static parse_category_t instance;
    return instance;
}
```

Exceptions, by contrast, depend on RTTI agreement across DSO boundaries (covered in the ABI section). Codes are simpler.

## When to Pick Which

| Situation | Pick |
|---|---|
| Hot path, sub-microsecond budget | error_code or expected |
| Cross-DSO API | error_code, std::expected with POD error |
| Constructor that cannot defer failure | exception |
| Reporting OS errors | error_code via system_category |
| Domain "this can fail, here is why" | std::expected<T, your_error> |
| Library aimed at both worlds | provide both: throwing and ec-out overloads |

The third pattern is what `<filesystem>` does:

```cpp
bool exists(const path& p);                           // throws
bool exists(const path& p, std::error_code& ec) noexcept;  // sets ec
```

This is the pragmatic answer for libraries: ship both, document both, let the caller decide.

## Common Mistakes

- Defining a custom category but forgetting `is_error_code_enum`. Conversion does not happen, callers must construct manually, ergonomic suffers.
- Defining the category in a header without a single-TU anchor. Two singletons across DSOs.
- Returning `error_code` and ignoring it at the call site. Mark functions `[[nodiscard]]`.
- Using `int` for codes. You lose type safety, you cannot map to conditions, and POSIX `errno` values clash with your domain values.
- Throwing inside a `noexcept` function that should have set `ec`. This calls `terminate`. Audit any function with both a throwing and a non-throwing overload.

## FAANG Bar

A senior engineer should:

- Implement a custom `error_category` from memory (override `name`, `message`, optionally `default_error_condition`).
- Explain the ADL `make_error_code` pattern and the `is_error_code_enum` trait.
- Know when to surface `error_code` vs throw `system_error`.
- Recognize the `<filesystem>` dual-API pattern and replicate it in their own libraries.
- Diagnose a category-singleton mismatch across `.so` files.
