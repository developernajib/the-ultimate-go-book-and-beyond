## C++ Learning Curve, Realistically

> **Junior to FAANG:** You are not behind because C++ is hard. C++ takes longer than most languages and that is normal. Budget the hours, do not rush.
>
> **Senior at FAANG:** Do not learn the whole language. Learn the subset your team uses, plus the failure modes (UB, lifetime, ABI). Save the WG21 paper reading for after you ship.

This chapter assumes you are a competent Go engineer (or competent in any GC language with two to four years of professional experience). The hour estimates below are study + practice hours, not calendar time, and assume real focused effort, not background reading on the train.

### The honest hour budget

| Stage | Cumulative hours | Calendar (10-15 hrs/week) |
|----------------------------------------------|------------------|---------------------------|
| Syntax and "I can write a working program" | 80 | 2 months |
| Idiomatic modern C++ (RAII, smart pointers, std lib) | 250 | 4-6 months |
| Templates well enough to read library code | 500 | 9-12 months |
| Templates well enough to write a generic library | 800 | 14-18 months |
| Undefined behavior intuition | 1000-1500 | 18-30 months |
| Build systems and ABI in production | ongoing | ongoing |
| Lock-free, memory model, atomics | 1500+ | 2+ years |

The 600-hour-to-L4 number you may have heard is realistic if your job pays you to write C++ daily and your team does code review well. Without the daily reps, double the calendar time.

### Stage 1: Syntax (first month, ~80 hours)

Read one book. Pick *A Tour of C++* (Bjarne Stroustrup, 3rd edition, covers C++20). It is short, accurate, and written by the language designer. Skim *Programming Principles and Practice Using C++* if you have never written low-level code at all. Skip *The C++ Programming Language* (the 1300-page reference) until later.

Goals:
- Compile a hello world with `g++` or `clang++` and `-std=c++23 -Wall -Wextra -Wpedantic -Werror`.
- Understand value vs reference vs pointer semantics. This is *the* concept that trips up Go and Java engineers. Internalize that `T x = y;` copies, `T& x = y;` aliases, `T* x = &y;` is an indirection.
- Use `std::vector`, `std::string`, `std::unordered_map`, `std::optional`, `std::variant`. These cover 80% of normal data needs.
- Use range-based `for`, `auto`, structured bindings.
- Learn `std::unique_ptr` and `std::shared_ptr`. Never type `new` or `delete` outside library code.
- Run a sanitizer (`-fsanitize=address,undefined`) on every test.

Anti-goal: do not learn template metaprogramming, do not learn iterator categories, do not learn the difference between `std::move` and `std::forward`. These come later.

### Stage 2: Idiomatic modern C++ (months 2-5, ~250 hours total)

Read *Effective Modern C++* (Scott Meyers). It is from 2014 but still the single best book on what to *do* in modern C++. Pair it with the C++ Core Guidelines (online, free, maintained by Stroustrup and Sutter).

What you should be able to do:

- Write a class with the rule of zero (no manual destructor, copy, move, assign), letting `unique_ptr` and `vector` members handle resources.
- Know when to write the rule of five (you own a raw resource, and want full control).
- Use `std::span` and `std::string_view` for non-owning views into data.
- Pass parameters correctly (by value for small POD, by const ref for large objects, by rvalue ref for sink parameters in constructors).
- Understand `std::move` is just a cast, `std::forward` is conditional move for templates.
- Use lambdas, including capture lists. Know when to capture by value vs reference.
- Use `<algorithm>` and `<ranges>` instead of hand-written loops where it makes the code clearer.

Practical project at this stage: rewrite a non-trivial Go program (a CLI tool, a small server, a parser) in C++. Use Catch2 or GoogleTest for tests. Set up CMake to build with sanitizers in CI. This is the project that takes you from "can read C++" to "can ship C++".

```cpp
// Idiomatic C++23 example after stage 2
#include <vector>
#include <string>
#include <ranges>
#include <iostream>
#include <expected>

std::expected<int, std::string> parse_port(std::string_view s) {
    int port = 0;
    auto [p, ec] = std::from_chars(s.data(), s.data() + s.size(), port);
    if (ec != std::errc{} || port < 1 || port > 65535) {
        return std::unexpected("invalid port: " + std::string(s));
    }
    return port;
}
```

If that code looks reasonable to you, you are at stage 2.

### Stage 3: Templates as a reader (months 6-12, ~500 hours)

You are not yet writing template-heavy code, but you can read it. You should understand:

- Function templates and class templates.
- Type deduction rules for function templates.
- The two-phase name lookup rule (the most surprising part of templates for newcomers).
- SFINAE in its modern form (`requires` clauses, `if constexpr`).
- Concepts (C++20 onwards). Use them. They make compiler errors readable for the first time in template history.
- Variadic templates and parameter pack expansion.
- CRTP (curiously recurring template pattern) and when to use it vs virtual dispatch.

Read sections of `<algorithm>`, `<ranges>`, `<functional>`, and a small library like `fmt` or `nlohmann::json`. You should be able to follow the code, even if you would not write it from scratch.

Anti-goal: do not learn expression templates, `std::enable_if` (now legacy), or the SFINAE workarounds older code uses. Concepts replace most of this.

### Stage 4: Templates as a writer (months 12-18, ~800 hours)

Now you can write a small generic library. Pick a real problem: a typed result type, a small functional library, a thread-safe queue, a fixed-size ring buffer template. Write it, test it, fuzz it, benchmark it.

Topics:
- Template template parameters.
- Tag dispatch and customization point objects.
- `std::is_*` traits and writing your own.
- Constexpr metaprogramming: compile-time strings, compile-time data structures, compile-time hashing.
- Deduction guides for class templates.

Most C++ engineers never reach this level. You do not need to either. Most production C++ code is plain non-template code with judicious use of standard library templates. Reaching this level is a marker for L5+ at FAANG and a hard requirement for library authors.

### Stage 5: Undefined behavior intuition (months 12-30, ~1000-1500 hours)

This is the differentiator between someone who *writes* C++ and someone who can *debug* C++ in production. UB is the failure mode of the language.

Topics to internalize:

- **Lifetime.** Pointer to expired stack object. Reference to destroyed temporary. Dangling iterator after `vector::push_back`. Use-after-free. Use-after-move.
- **Aliasing and strict aliasing.** Why `*reinterpret_cast<float*>(&i)` is UB. Why `std::bit_cast` exists.
- **Signed integer overflow.** Why `for (int i = 0; i < n + 1; i++)` can loop forever if `n` is `INT_MAX`.
- **Uninitialized reads.** `int x; if (x) ...` is UB. Why `valgrind` and MSan exist.
- **Data races.** Two threads, one writes, one reads, no synchronization. UB.
- **One-definition rule.** Two TUs each define `void f() { ... }` differently and link. UB.
- **Sequencing rules.** `i++ + i++` is UB pre-C++17 in many contexts.
- **Null pointer dereference, divide by zero, shift by negative or oversized amount.**

How to build the intuition:

1. Run *every* test under `-fsanitize=address,undefined,leak`. Make sanitizer-clean a CI gate. If a sanitizer finds an issue, treat it like a build failure.
2. Run a fuzzer (libFuzzer or AFL++) against any code that takes external input. Real fuzzers find real UB faster than humans.
3. Read Chandler Carruth's CppCon talks on UB. Watch Hyrum Wright on Hyrum's Law. Read John Regehr's blog on undefined behavior. These three sources cover 90% of what working engineers need.
4. When you debug a Heisenbug, before patching it, write a one-line description of the UB rule it violated. Build the rule index in your own head.

This stage never really ends. Even Stroustrup gets surprised by UB occasionally.

### Stage 6: Build systems and ABI (ongoing)

This is operational knowledge, not language knowledge. You learn it by getting bitten.

- CMake target-based builds. Understand `target_link_libraries`, `target_include_directories`, `target_compile_definitions`, with PUBLIC/PRIVATE/INTERFACE visibility. Stop using directory-based commands like `include_directories`.
- Linkage and the One Definition Rule across translation units.
- `-fvisibility=hidden` and explicit export annotations for shared libraries.
- ABI compatibility: when can you ship a new `.so` and not break dependent binaries. Itanium C++ ABI rules.
- `compile_commands.json` and how clangd, clang-tidy, IWYU consume it.
- vcpkg or Conan for dependency management. (See chapter on tooling.)

You will spend years in this layer if you work on shipped libraries. If you only work on internal services, you will learn the minimum and forget the rest.

### What to skip until needed

These are the topics that show up in C++ books and blog posts but are not on the critical path for productive work:

- **Custom allocators.** Skip until you have a measured allocation bottleneck.
- **Expression templates.** Skip unless you are writing a numerics library.
- **Template metaprogramming with recursive types.** Skip. Use concepts and `if constexpr`.
- **`std::enable_if` SFINAE.** Use `requires` instead.
- **Multiple inheritance, virtual inheritance, the diamond problem.** Skim once, then never use it.
- **Boost.MPL, Boost.Hana.** Historical curiosities now that we have C++20 concepts.
- **Old streams (`<iostream>` formatting).** Use `std::format` and `std::print`.
- **`std::async`, `std::future`.** Skip. Use a real executor (Asio, folly::Executor) or wait for executors in C++26.

### Pitfalls Go engineers fall into specifically

- **Treating references like pointers.** A `T&` is *not* a nullable pointer. It is bound at construction and never reseats. If you want optional, use `std::optional<T&>` (C++26) or `T*`.
- **Using `shared_ptr` everywhere.** Go's GC made you lazy about ownership. Default to `unique_ptr`. Reach for `shared_ptr` only when actual shared ownership exists, which is rare.
- **Returning by reference from a function that returns a temporary.** UB. Return by value, the compiler will elide the copy.
- **`auto` over-use.** `auto x = vec[0];` copies, `auto& x = vec[0];` references. Be deliberate.
- **Forgetting to mark single-arg constructors `explicit`.** Implicit conversions cause silent bugs.
- **Throwing exceptions across DLL boundaries on Windows.** Don't.

### A realistic 12-month plan from Go to L4-equivalent C++

- **Month 1-2:** *A Tour of C++*, build small CLI tools, get sanitizers and CMake working.
- **Month 3-4:** *Effective Modern C++*. Rewrite a real Go project. Set up GoogleTest, fuzzer, CI.
- **Month 5-6:** Read Chrome, LLVM, or Folly source code for an hour a day. Write a tool that uses one of them.
- **Month 7-8:** Concepts, ranges, `std::expected`, modern facilities. *C++ Concurrency in Action* (Anthony Williams) chapters 1-5.
- **Month 9-10:** Templates. Write a small generic library. Read part of Effective Modern C++ again, it will hit different.
- **Month 11-12:** Build a non-trivial project that exercises multiple subsystems: a key-value store, a small interpreter, a compute kernel with SIMD intrinsics. Get it through code review by a senior C++ engineer.

After that, you can interview for a C++-track L4 role and pass on technical merit. The remaining gap is years of production debugging and design judgment, which is the same gap any senior engineer has when changing languages.
