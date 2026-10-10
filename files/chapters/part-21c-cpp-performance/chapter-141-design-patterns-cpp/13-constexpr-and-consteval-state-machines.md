## `constexpr` and `consteval` State Machines

The state-machine-via-`std::variant` pattern discussed earlier works well at runtime, but for protocol parsers and compile-time-known configurations, C++20 and C++26 let you evaluate the entire state machine at compile time, producing zero-runtime-cost dispatch tables and enabling the compiler to verify exhaustiveness.

### Why Compile-Time State Machines Matter

A typical HTTP parser, a regex compiler, or a URL validator has a finite set of states and a finite set of transitions that never change between builds. Encoding this at runtime with virtual dispatch or a jump table means the processor must load the transition table from memory on every step. Encoding it at compile time means the compiler can inline the transition logic, constant-fold it, and produce branchless sequences of compare-and-jump.

In C++26, the addition of `consteval` (immediate functions) and `constexpr std::vector`/`std::string` (full allocating constexpr) makes this practical for production.

### A Worked Example: a Protocol Parser State Machine

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

enum class State : std::uint8_t {
    Start, Method, AfterMethod, Path, Version, Done, Error
};

enum class CharClass : std::uint8_t {
    Space, Letter, Digit, Slash, Dot, Other
};

consteval CharClass classify(char c) {
    if (c == ' ') return CharClass::Space;
    if (c == '/') return CharClass::Slash;
    if (c == '.') return CharClass::Dot;
    if (c >= 'A' && c <= 'Z') return CharClass::Letter;
    if (c >= 'a' && c <= 'z') return CharClass::Letter;
    if (c >= '0' && c <= '9') return CharClass::Digit;
    return CharClass::Other;
}

consteval State next_state(State s, CharClass c) {
    using enum State;
    using enum CharClass;
    switch (s) {
        case Start:
            return (c == Letter) ? Method : Error;
        case Method:
            if (c == Letter) return Method;
            if (c == Space)  return AfterMethod;
            return Error;
        case AfterMethod:
            return (c == Slash) ? Path : Error;
        case Path:
            if (c == Space) return Version;
            if (c == Other) return Error;
            return Path;
        case Version:
            if (c == Letter || c == Digit || c == Dot || c == Slash) return Version;
            return Done;
        default: return Error;
    }
}

// Build a 256-entry transition table at compile time.
consteval auto build_transition_table() {
    std::array<std::array<State, 256>, 7> table{};
    for (std::size_t s = 0; s < 7; ++s) {
        for (int ch = 0; ch < 256; ++ch) {
            auto cls = classify(static_cast<char>(ch));
            table[s][ch] = next_state(static_cast<State>(s), cls);
        }
    }
    return table;
}

inline constexpr auto kTransitions = build_transition_table();

bool parse_request_line(std::string_view input) noexcept {
    State s = State::Start;
    for (char c : input) {
        s = kTransitions[static_cast<std::size_t>(s)][static_cast<std::uint8_t>(c)];
        if (s == State::Error) return false;
    }
    return s == State::Done || s == State::Version;
}
```

The entire 7x256 transition table is computed by the compiler, materialized in read-only data, and accessed in the hot loop with a single indexed load. No runtime computation of transitions, no virtual dispatch, no function-pointer table. The loop body compiles to roughly five instructions per character on x86-64.

### Compile-Time Exhaustiveness via Concepts

C++20 concepts combined with `consteval` let you encode state-machine invariants that the compiler checks at every transition site.

```cpp
template <typename T>
concept StateEnum = std::is_enum_v<T> && requires { T::Done; T::Error; };

template <StateEnum S, auto Transitions>
struct Machine {
    consteval static bool all_states_reachable() {
        // compile-time BFS: fail compilation if a state is unreachable
        // ... omitted for brevity
        return true;
    }
    static_assert(all_states_reachable(), "unreachable state detected");
};
```

This is where `consteval` shines. A function marked `consteval` can never run at runtime. Any attempt to invoke it with runtime values is a compile error. The machinery is forced into the translation phase, and the resulting runtime code contains only table lookups.

### Reflection-Powered State Machines (C++26)

Static reflection in C++26 lets you discover enum members at compile time and auto-generate the transition table from a declarative description.

```cpp
#include <meta>

consteval auto generate_table_from_enum() {
    constexpr auto states = std::meta::enumerators_of(^^State);
    // Iterate enumerators, query metadata, emit transition logic.
    // Full reflection example elided. The point: no runtime code to maintain
    // when a new state is added to the enum.
}
```

Before reflection, adding a state meant editing the enum, the transition function, and every switch statement. With reflection, the enum is the single source of truth, and the table is regenerated on every build. Protocol parsers at Meta and Google are already converting macro-heavy state-machine generators to reflection-based equivalents, cutting thousands of lines of generated code and eliminating the external code-gen pass from the build graph.
