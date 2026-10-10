## Abseil: Strings and String Processing

Abseil was open-sourced by Google in 2017 as the portability and utility layer used across virtually every Google binary. It solves a specific problem: the C++ standard library, while powerful, lacks many utilities Google needed for large-scale systems. `std::string` operations are verbose, `std::regex` is notoriously slow, and string building with `+` operator causes excessive copying. Abseil fixes all of this.

### absl::string_view

`absl::string_view` (predating and informing `std::string_view` in C++17) is a non-owning reference to a string. It avoids copies when passing strings through function boundaries.

```cpp
#include "absl/strings/string_view.h"
#include "absl/strings/str_split.h"
#include "absl/strings/str_join.h"

// No copy -- string_view points into the original buffer
void process_header(absl::string_view line) {
    // Split on ": " -- returns vector<absl::string_view>
    // Each piece points into the original `line` buffer
    std::vector<absl::string_view> parts = absl::StrSplit(line, ": ");
    if (parts.size() != 2) return;

    absl::string_view key   = parts[0];
    absl::string_view value = parts[1];

    // Use key and value -- no allocation
    (void)key; (void)value;
}

// StrSplit with a limit and skip-empty predicate
void parse_csv_line(absl::string_view line) {
    std::vector<absl::string_view> fields =
        absl::StrSplit(line, ',', absl::SkipEmpty());

    for (absl::string_view field : fields) {
        // field is a zero-copy view into `line`
        process_field(field);
    }
}

// StrJoin -- join with a delimiter
std::string rejoin(const std::vector<std::string>& parts) {
    return absl::StrJoin(parts, ", ");
}
```

In Go, `strings.Split` and `strings.Join` are the equivalents. The key difference: Go strings are immutable value types with reference semantics internally, so avoiding copies is less critical. In C++, `string_view` is the idiomatic way to accept string parameters without triggering allocations.

### absl::StrCat and absl::StrAppend

String concatenation with `+` in C++ creates a new allocation for each operation. `absl::StrCat` pre-calculates the total length and does one allocation.

```cpp
#include "absl/strings/str_cat.h"

// Bad: three allocations
std::string bad = "Hello, " + name + "! You are " + std::to_string(age) + ".";

// Good: one allocation, pre-computed total length
std::string good = absl::StrCat("Hello, ", name, "! You are ", age, ".");

// StrAppend -- append to existing string in-place
std::string result;
result.reserve(256);
absl::StrAppend(&result, "prefix-", id, "-suffix");

// Substitute -- named positional substitution
std::string msg = absl::Substitute("Hello $0, you have $1 messages.", name, count);
```

`absl::StrCat` accepts any type with a `absl::AlphaNum` conversion: `int`, `double`, `string_view`, `std::string`. This is the Go `fmt.Sprintf` equivalent, but without the interface{} boxing overhead.

### absl::StrFormat

For complex formatting, `absl::StrFormat` provides type-safe printf semantics checked at compile time.

```cpp
#include "absl/strings/str_format.h"

// Type-safe: mismatched format specifier is a compile error
std::string s = absl::StrFormat("Request %d completed in %.2fms", request_id, latency_ms);

// Write to a sink (stdout, string, file descriptor)
absl::PrintF("Server started on port %d\n", port);
absl::FPrintF(stderr, "Error: %s\n", error_message);

// Format to an existing string buffer (avoids allocation if pre-sized)
std::string buf;
absl::StrAppendFormat(&buf, " [%s:%d]", file, line);
```

The Go equivalent is `fmt.Sprintf`, but `absl::StrFormat` has a key advantage: the format string is validated against argument types at **compile time**. Passing a `double` where `%d` is expected is a compile error, not a runtime panic.

### String Predicates and Transformations

Abseil's string utility functions in `absl/strings/ascii.h`, `match.h`, and `strip.h` operate on `absl::string_view` rather than `std::string`, avoiding heap allocations for predicate checks and prefix/suffix stripping. Functions like `absl::AsciiStrToLower`, `absl::StartsWith`, and `absl::StripLeadingAsciiWhitespace` are the production-grade replacements for the C-string manipulation that typically accumulates as ad hoc utility code in large codebases.
```cpp
#include "absl/strings/ascii.h"
#include "absl/strings/match.h"
#include "absl/strings/strip.h"

absl::string_view s = "  Hello, World!  ";

// Predicates -- O(1) checks, no allocation
bool starts = absl::StartsWith(s, "  Hello");   // true
bool ends   = absl::EndsWith(s, "!  ");         // true
bool found  = absl::StrContains(s, "World");    // true

// Case conversion -- operates on a copy
std::string lower = absl::AsciiStrToLower("HTTP/1.1");  // "http/1.1"
std::string upper = absl::AsciiStrToUpper("get");        // "GET"

// Whitespace stripping -- string_view operations, no copy
absl::string_view stripped = absl::StripLeadingAsciiWhitespace(s);
stripped = absl::StripTrailingAsciiWhitespace(stripped);
stripped = absl::StripAsciiWhitespace(stripped);  // both ends

// Trim a specific prefix or suffix
absl::string_view path = "/api/v1/users";
absl::ConsumePrefix(&path, "/api");  // path is now "/v1/users"
```

Go equivalents: `strings.HasPrefix`, `strings.HasSuffix`, `strings.Contains`, `strings.ToLower`, `strings.TrimSpace`, `strings.TrimPrefix`. The APIs map almost one-to-one.

### Production Example: Parsing a Structured Log Line

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```cpp
#include "absl/strings/str_split.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/ascii.h"
#include "absl/strings/match.h"
#include "absl/strings/numbers.h"

struct LogEntry {
    std::string timestamp;
    std::string level;
    int64_t     request_id;
    std::string message;
};

// Parse: "2024-01-15T10:23:45Z INFO req=12345 message=user_login_success"
std::optional<LogEntry> parse_log_line(absl::string_view line) {
    // Split on whitespace, at most 4 parts
    std::vector<absl::string_view> parts = absl::StrSplit(
        line, absl::MaxSplits(' ', 3)
    );
    if (parts.size() < 4) return std::nullopt;

    LogEntry entry;
    entry.timestamp = std::string(parts[0]);
    entry.level     = absl::AsciiStrToUpper(std::string(parts[1]));

    // Parse "req=12345" -- split on '='
    std::vector<absl::string_view> req_kv = absl::StrSplit(parts[2], '=');
    if (req_kv.size() != 2 || !absl::SimpleAtoi(req_kv[1], &entry.request_id)) {
        return std::nullopt;
    }

    // Parse "message=..." -- everything after "message="
    absl::string_view msg_part = parts[3];
    if (!absl::ConsumePrefix(&msg_part, "message=")) return std::nullopt;
    entry.message = std::string(msg_part);

    return entry;
}

// Build a structured log line with StrCat
std::string format_log_line(const LogEntry& e) {
    return absl::StrCat(
        e.timestamp, " ", e.level,
        " req=", e.request_id,
        " message=", e.message
    );
}
```

This pattern, `StrSplit` into `string_view` pieces, check predicates, build output with `StrCat`, is idiomatic throughout Google's codebase. Zero unnecessary allocations, clear intent, and no raw `std::string` concatenation with `+`.

---
