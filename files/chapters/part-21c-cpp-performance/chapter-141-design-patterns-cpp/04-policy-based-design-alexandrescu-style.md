## Policy-Based Design (Alexandrescu Style)

Policy-based design, introduced by Andrei Alexandrescu in "Modern C++ Design" (2001), is a compile-time composition technique. Instead of inheriting behavior from a base class, you parameterize a class with template arguments called policies. Each policy is a class that provides one orthogonal aspect of behavior. The host class combines them. The result is zero-overhead abstraction: no vtable, no virtual calls, no runtime dispatch.

### The Core Idea

Runtime polymorphism lets you swap implementations at runtime (via virtual functions). Policy-based design lets you swap implementations at compile time (via template parameters). The compiler sees the concrete types and can inline everything.

```cpp
// Runtime polymorphism -- always paying the virtual dispatch cost
class Logger {
public:
    virtual void write(std::string_view msg) = 0;
    virtual ~Logger() = default;
};

// Policy-based -- zero overhead, behavior baked in at compile time
template <typename OutputPolicy, typename FormatterPolicy>
class Logger {
    OutputPolicy    output_;
    FormatterPolicy formatter_;

public:
    void log(std::string_view msg, int level) {
        output_.write(formatter_.format(msg, level));
    }
};
```

### A Production-Quality Logger with Policies

Policy-based design composes a class from small policy types supplied as template parameters, so threading behavior, formatting, and output destination are chosen at compile time with zero runtime dispatch. A logger is the classic showcase.
```cpp
#include <string>
#include <string_view>
#include <iostream>
#include <fstream>
#include <chrono>
#include <format>  // C++20

// ---- Output Policies -------------------------------------------------------

struct ConsoleOutput {
    void write(std::string_view line) const {
        std::cout << line << '\n';
    }
};

struct FileOutput {
    explicit FileOutput(const std::string& path)
        : file_(path, std::ios::app)
    {
        if (!file_) throw std::runtime_error("cannot open log file: " + path);
    }

    void write(std::string_view line) const {
        file_ << line << '\n';
    }

private:
    mutable std::ofstream file_;
};

struct NullOutput {
    void write(std::string_view) const noexcept {}  // Discards everything
};

// ---- Formatter Policies ----------------------------------------------------

struct PlainFormatter {
    std::string format(std::string_view msg, int level) const {
        static constexpr std::string_view levels[] = {
            "DEBUG", "INFO", "WARN", "ERROR"
        };
        const auto& lv = (level < 4) ? levels[level] : levels[3];
        return std::string(lv) + ": " + std::string(msg);
    }
};

struct JsonFormatter {
    std::string format(std::string_view msg, int level) const {
        auto now = std::chrono::system_clock::now();
        auto ts  = std::chrono::duration_cast<std::chrono::milliseconds>(
                       now.time_since_epoch()).count();
        return std::format(
            R"({{"ts":{},"level":{},"msg":"{}"}})",
            ts, level, msg
        );
    }
};

// ---- Host Class: composing policies ----------------------------------------

template <typename OutputPolicy   = ConsoleOutput,
          typename FormatterPolicy = PlainFormatter>
class Logger {
    OutputPolicy    output_;
    FormatterPolicy formatter_;

public:
    // Forward constructor args to the output policy (e.g., filename)
    template <typename... Args>
    explicit Logger(Args&&... args)
        : output_(std::forward<Args>(args)...)
    {}

    void debug(std::string_view msg) { write(msg, 0); }
    void info (std::string_view msg) { write(msg, 1); }
    void warn (std::string_view msg) { write(msg, 2); }
    void error(std::string_view msg) { write(msg, 3); }

private:
    void write(std::string_view msg, int level) {
        output_.write(formatter_.format(msg, level));
    }
};

// ---- Instantiations: distinct types, no virtual dispatch -------------------

using ConsoleLogger  = Logger<ConsoleOutput, PlainFormatter>;
using FileJsonLogger = Logger<FileOutput,    JsonFormatter>;
using SilentLogger   = Logger<NullOutput,    PlainFormatter>;  // No-op in tests

// Usage
void run_server(auto& log) {
    log.info("Server starting");
    log.warn("Config missing, using defaults");
}

// int main() {
//     ConsoleLogger  console_log;
//     FileJsonLogger file_log("/var/log/app.json");
//
//     run_server(console_log);
//     run_server(file_log);
// }
```

The compiler generates two completely separate, fully-inlined versions of `run_server`. The call to `log.info(...)` compiles down to direct calls to the formatter and output, no indirection.

### Alexandrescu's Smart Pointer: The Original Example

The canonical policy-based design example from "Modern C++ Design" is a smart pointer parameterized over ownership, checking, and storage policies:

```cpp
template <
    typename T,
    typename OwnershipPolicy,  // RefCounted, DestructiveCopy, NoCopy
    typename CheckingPolicy,   // Assert, Reject, NoCheck
    typename StoragePolicy     // DefaultStorage, LockedStorage
>
class SmartPtr
    : public StoragePolicy
    , public OwnershipPolicy
    , public CheckingPolicy
{
public:
    using PointerType = typename StoragePolicy::PointerType;

    SmartPtr(PointerType p = StoragePolicy::Default())
        : StoragePolicy(p) {}

    PointerType operator->() const {
        CheckingPolicy::check(StoragePolicy::get_pointer());
        return StoragePolicy::get_pointer();
    }

    // Ownership transfer handled by OwnershipPolicy
    SmartPtr(const SmartPtr& other) {
        StoragePolicy::set_pointer(
            OwnershipPolicy::clone(other.StoragePolicy::get_pointer())
        );
    }
};

// Different combinations = different smart pointers, zero overhead each
using RcPtr   = SmartPtr<Widget, RefCounted,       NoCheck,      DefaultStorage>;
using SafePtr = SmartPtr<Widget, NoCopy,            Assert,       DefaultStorage>;
using UniPtr  = SmartPtr<Widget, DestructiveCopy,   NoCheck,      DefaultStorage>;
```

This predates `std::unique_ptr` and `std::shared_ptr` by a decade, those standard types are policy-based smart pointers with fixed policies.

### When Policy-Based Design Beats Inheritance

Use policies when:
- Performance is critical and virtual dispatch overhead is measurable.
- You have orthogonal dimensions of variation (output × format × threading, etc.) that would create an inheritance explosion (M × N × P combinations → M+N+P implementations).
- The combination is always known at compile time (e.g., a specific server build uses JSON logging, tests use null logging).

Prefer virtual dispatch when:
- The concrete type must be determined at runtime (reading from config, dependency injection).
- The number of policy dimensions is small (one or two).
- ABI stability is required across shared library boundaries.

### Go Comparison

Go achieves similar composition through interfaces, but at runtime:

```go
type Logger struct {
    output    OutputWriter    // interface -- runtime dispatch
    formatter Formatter       // interface -- runtime dispatch
}
```

Go's approach is simpler and more flexible (implementations can be swapped at runtime), but every call through the interface incurs one indirect dispatch. C++ policy-based design achieves zero dispatch at the cost of compile-time fixedness and longer compile times from template instantiation.

C++20 concepts make policy requirements explicit and produce better error messages:

```cpp
template <typename T>
concept OutputPolicy = requires(T t, std::string_view s) {
    { t.write(s) } -> std::same_as<void>;
};

template <OutputPolicy O, typename F>
class Logger { /* ... */ };
```

---
