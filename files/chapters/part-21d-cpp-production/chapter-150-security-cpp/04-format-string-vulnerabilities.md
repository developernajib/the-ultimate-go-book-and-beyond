## Format String Vulnerabilities: std::format vs printf

Format string vulnerabilities were classified as a distinct attack class in the late 1990s after researchers discovered that `printf` with a user-controlled format string is not just a logic error, it is a read/write primitive that can extract stack values and write to arbitrary memory addresses.

In Go, `fmt.Sprintf` is type-safe. The format verbs `%v`, `%s`, `%d` operate on the argument list, they cannot read memory outside it, and `%n` does not exist. The entire class is architecturally impossible. In C++, `printf` and its family (`sprintf`, `fprintf`, `snprintf`) are inherited from C and carry the vulnerability with them.

### How the Attack Works

Passing attacker-controlled data directly as `printf`'s format string lets the attacker inject `%x` specifiers to read stack memory (leaking return addresses, stack canaries, and heap pointers) and `%n` to write the current byte count to a stack address. The example input `"%x %x %x %x %x %x %x %s"` would print six 4-byte stack values as hex then dereference the seventh as a string pointer, a classic information-disclosure path that precedes a more targeted exploitation attempt.
```c
// The vulnerability: user controls the format string
void vulnerable_log(const char* user_message) {
    printf(user_message);  // format string injection
}

// Attacker input: "%x %x %x %x %x %x %x %s"
// printf interprets these as format specifiers against the call stack
// %x reads 4 bytes of stack as hex, leaks return addresses, canary values
// %s dereferences a stack value as a pointer, may crash or leak memory

// Attacker input with %n: "AAAA%12$n"
// %12$n writes the number of bytes printed so far to the 12th argument
// If the 12th "argument" (stack value) is an address, this is an arbitrary write
```

The `%n` specifier writes an integer to a pointer argument. When the attacker controls the format string and can influence stack contents, they can write arbitrary values to arbitrary addresses, which is equivalent to arbitrary code execution in binaries without modern hardening.

### Safe Alternatives: Always Use Literal Format Strings

The immediate fix for `printf` is always using a literal format string:

```cpp
// Vulnerable: user_message is the format string
printf(user_message);

// Safe: user_message is an argument, not a format string
printf("%s", user_message);
printf("%s\n", user_message.c_str());
```

This pattern is not exploitable: `%n` is a specifier in the literal `"%s"`, not in `user_message`. The compiler flag `-Wformat-security` warns on `printf` calls where the format string is not a string literal. `-Wformat=2` adds additional checks.

```bash
# Enable in all builds, zero cost at runtime
clang++ -Wformat -Wformat-security -Wformat=2 -Werror ...
```

### `std::format` (C++20)

`std::format` is the modern replacement for `printf`. It is type-safe, compile-time validated, and has no format string injection vector because the format string syntax (`{}`, `{:08x}`) has no memory-access specifiers.

```cpp
#include <format>
#include <string>
#include <iostream>

// Type-safe: {} matched to argument by position, not interpreted as memory access
std::string greet(const std::string& name, int score) {
    return std::format("Hello, {}! Your score is {}.", name, score);
}

// Format specifiers: width, precision, base, but no %n equivalent
std::string format_hex(uint32_t value) {
    return std::format("0x{:08x}", value);      // "0x0000cafe"
}

std::string format_float(double val) {
    return std::format("{:.4f}", val);           // "3.1416"
}

// Compile-time validation: invalid format strings are caught at compile time
// std::format("{} {} {}", a, b) - // compile error: 2 args for 3 placeholders

// Logging to stderr safely
void log_event(const std::string& event, int code) {
    std::cerr << std::format("[EVENT] {} (code={})\n", event, code);
}
```

The format string in `std::format` must be a compile-time constant, it cannot be a runtime string. This is the architectural guarantee: an attacker cannot inject format specifiers because format specifiers are not evaluated at runtime from user data.

### The `{fmt}` Library

`{fmt}` is the production-grade predecessor to `std::format`, developed by Victor Zverovich. It is used at Meta, Google (partially), and many high-performance C++ systems. It predates C++20 and compiles on C++11 and later.

```cpp
#include <fmt/format.h>
#include <fmt/chrono.h>

// Drop-in safe printf replacement
void safe_logging(const std::string& user_name, int64_t user_id) {
    fmt::print("[AUTH] user={} id={}\n", user_name, user_id);
}

// Rich format specifiers without memory access risk
std::string format_status(const std::string& host, uint16_t port, bool connected) {
    return fmt::format("{}:{} [{}]", host, port,
                       connected ? "CONNECTED" : "DISCONNECTED");
}

// Hex dump of binary data safely
void log_packet(std::span<const uint8_t> data) {
    std::string hex;
    for (auto byte : data) {
        hex += fmt::format("{:02x} ", byte);
    }
    fmt::print("packet[{}]: {}\n", data.size(), hex);
}

// Compile-time format string validation (C++20 mode)
consteval auto make_fmt() {
    return FMT_COMPILE("{}:{}");  // validated at compile time
}
```

spdlog, the most widely used C++ logging library, is built on `{fmt}` and inherits its type safety:

```cpp
#include <spdlog/spdlog.h>

void production_logging(const std::string& path, int status_code) {
    spdlog::info("Request path={} status={}", path, status_code);
    spdlog::warn("Slow response path={} latency_ms={}", path, 1250);
    spdlog::error("Handler failed path={} error={}", path, "timeout");
    // None of these can be exploited via format string injection
    // because the format string is always a literal
}
```

### Eliminating `printf` from a Codebase

Migrating an existing codebase from `printf` to `std::format` or `{fmt}` is mechanical. `clang-tidy` with `cppcoreguidelines-pro-type-vararg` flags all variadic function calls:

```bash
clang-tidy --checks='cppcoreguidelines-pro-type-vararg' \
           --fix source.cpp
```

A simple search-and-replace handles the most common patterns:

```bash
# Find all printf calls (review each, don't blindly replace)
grep -rn '\bprintf\b\|\bsprintf\b\|\bfprintf\b' src/
```

The conversion pattern:

```cpp
// Before
printf("Processing %s: status=%d\n", name.c_str(), status);
fprintf(stderr, "Error in %s: %s\n", func_name, strerror(errno));
char buf[256];
snprintf(buf, sizeof(buf), "key_%d", index);

// After
fmt::print("Processing {}: status={}\n", name, status);
fmt::print(stderr, "Error in {}: {}\n", func_name, strerror(errno));
std::string key = fmt::format("key_{}", index);
```

### Compiler Enforcement

GCC and Clang's `-Wformat-security` and `-Wformat-nonliteral` flags emit warnings whenever a non-literal string is passed as a `printf`-family format argument, catching the `printf(user_message)` pattern at compile time. Adding `-Werror=format-security` to the CMake target promotes the warning to a hard error so format string injection vulnerabilities are impossible to ship without an explicit suppression that would be visible in code review.
```cmake
# CMakeLists.txt, enforce format string safety
target_compile_options(myapp PRIVATE
    -Wformat
    -Wformat-security
    -Wformat=2
    -Wformat-nonliteral   # warns on non-literal format strings
    -Werror=format-security
)
```

With `-Werror=format-security`, any call to `printf` with a non-literal format string fails compilation. This is the zero-tolerance policy that teams like Chrome enforce.

---
