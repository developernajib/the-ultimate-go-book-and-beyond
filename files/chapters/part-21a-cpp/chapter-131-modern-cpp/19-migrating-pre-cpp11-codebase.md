## Migrating a Pre-C++11 Codebase

A pre-C++11 codebase carries fifteen-plus years of idioms that the language has obsoleted: raw `new`/`delete`, `NULL`, `throw()` exception specifications, hand-rolled smart pointers, manual function objects, copy-only types pretending to be moveable. Migrating is not a single switch flip. It is a multi-quarter effort with a build-system upgrade, a tooling investment, and a backlog ranked by safety impact.

### Step 0: Compiler and Standard Lift

You cannot migrate code without first compiling it under the new standard. The first task is to bump the compiler and the language flag, in that order.

```bash
# CMake
set(CMAKE_CXX_STANDARD 20)        # or 23
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Bazel
build --cxxopt=-std=c++20

# MSBuild
<LanguageStandard>stdcpp20</LanguageStandard>
```

Expect a wave of new warnings and a smaller wave of hard errors. `register` storage class removed in C++17. `throw()` specifications removed in C++17 (replaced by `noexcept`). `auto_ptr` removed in C++17. `random_shuffle` removed. Bind expressions with `std::bind1st` removed. `std::iterator` deprecated.

Resolve the hard errors first. Then bump warnings to errors progressively (`-Werror`, `/WX`) per module, not globally.

### The Migration Backlog, Ranked by Safety Impact

Rank the work by how much pain each item causes. Top of the list is what burns down production.

#### 1. Raw new/delete (highest priority)

Every `new` without a matching `delete` is a leak. Every `delete` of a non-owning pointer is a double-free. Replace with smart pointers.

```cpp
// Before.
Foo* p = new Foo();
use(p);
delete p;   // missing on every error path

// After.
auto p = std::make_unique<Foo>();
use(*p);
```

For owned containers of pointers: `std::vector<Foo*>` becomes `std::vector<std::unique_ptr<Foo>>`. For shared ownership: `std::shared_ptr`. For non-owning observation: raw pointer or `T&`.

The clang-tidy check is `modernize-make-unique` and `modernize-use-smartptr`. Run on the entire codebase, review diffs, commit incrementally.

#### 2. NULL and 0 for Pointers

`NULL` is a macro defined as `0` or `((void*)0)` depending on platform. In C++ it overloads to `int`, which causes the wrong overload to be selected.

```cpp
void f(int);
void f(void*);

f(NULL);      // calls f(int) on most implementations
f(nullptr);   // calls f(void*) unambiguously
```

clang-tidy: `modernize-use-nullptr`. Mechanical. Safe.

### 3. Throw() Specifications

`void f() throw()` is dynamic exception specification, removed in C++17. Replace with `noexcept`.

```cpp
void f() throw();      // pre-C++17
void f() noexcept;     // C++17 and later
```

clang-tidy: `modernize-use-noexcept`. Caveat: `throw()` and `noexcept` have slightly different behavior on violation. `throw()` calls `unexpected` (which historically called `terminate`). `noexcept` calls `terminate` directly. The end result is the same in practice.

#### 4. Pre-Move Idioms

Pre-C++11 code returned containers by reference parameters because copies were too expensive. Post-C++11 you return by value and let move semantics avoid the copy.

```cpp
// Before.
void make_list(std::vector<int>& out);
std::vector<int> v;
make_list(v);

// After.
std::vector<int> make_list();
auto v = make_list();   // moved or RVO'd, no copy
```

Audit `&` parameters. The ones whose names start with `out_` or that are clearly "fill this" are candidates for return-by-value. Profile to confirm RVO/move semantics give equivalent performance.

#### 5. Hand-Rolled Smart Pointers

Many pre-C++11 codebases have a `RefCounted` base class, a `Ref<T>` template, or a custom `ScopedPtr`. Port to `std::shared_ptr`, `std::unique_ptr`, and `boost::intrusive_ptr` (for tightly-controlled allocation).

The migration order: replace internal users first, deprecate the legacy type, remove after one release.

#### 6. Function Pointers and Functors

Custom `Functor` base classes and the `std::bind1st`/`bind2nd` family go away. Replace with lambdas.

```cpp
// Before.
std::for_each(v.begin(), v.end(), std::bind1st(std::plus<int>(), 5));

// After.
std::ranges::for_each(v, [](int x) { return x + 5; });
```

clang-tidy: `modernize-avoid-bind`.

#### 7. typedef to using

`typedef` is still legal but `using` reads better and supports template aliases.

```cpp
typedef std::vector<int> IntVec;            // before
using IntVec = std::vector<int>;            // after

template <typename T>
using Vec = std::vector<T>;                 // template alias, impossible with typedef
```

clang-tidy: `modernize-use-using`.

### 8. Iterators Replaced by Range For and Ranges

```cpp
for (std::vector<int>::iterator it = v.begin(); it != v.end(); ++it) use(*it);

// C++11.
for (auto& x : v) use(x);

// C++20 with ranges and projections.
std::ranges::for_each(v, [](auto& x){ use(x); });
```

clang-tidy: `modernize-loop-convert`.

### 9. Implicit Constructors and Conversions

Single-argument constructors should be `explicit` unless implicit conversion is part of the design. Pre-C++11 code rarely marks them.

```cpp
// Before.
class Foo { Foo(int); };
void take(Foo);
take(42);   // implicit conversion, surprising

// After.
class Foo { explicit Foo(int); };
take(42);              // error
take(Foo{42});         // explicit
```

clang-tidy: `google-explicit-constructor`.

### 10. enum to enum class

Strongly-typed enums prevent implicit-int conversions and namespace pollution.

```cpp
enum Color { Red, Green, Blue };           // before, leaks Red into outer scope
enum class Color { Red, Green, Blue };     // after
auto c = Color::Red;
```

clang-tidy: `modernize-use-enum`. Manual review required where enums are used as bit flags or as array indices.

## Tooling: clang-tidy modernize-* Checks

The `modernize-*` family is the engine of automated migration. Run as part of CI. Selective enabling.

```bash
clang-tidy -checks='-*,modernize-*' -fix file.cpp
```

The full list (selected).

| Check | What it does |
|---|---|
| `modernize-use-nullptr` | `NULL` to `nullptr` |
| `modernize-use-auto` | `std::vector<int>::iterator` to `auto` |
| `modernize-use-using` | `typedef` to `using` |
| `modernize-use-noexcept` | `throw()` to `noexcept` |
| `modernize-use-default-member-init` | inline default member initializers |
| `modernize-use-emplace` | `push_back(T(...))` to `emplace_back(...)` |
| `modernize-use-make-unique` | `new T(...)` to `std::make_unique<T>(...)` |
| `modernize-use-make-shared` | `new T(...)` to `std::make_shared<T>(...)` |
| `modernize-use-trailing-return-type` | `int f()` to `auto f() -> int` (style) |
| `modernize-loop-convert` | iterator loop to range-for |
| `modernize-avoid-bind` | `std::bind` to lambda |
| `modernize-pass-by-value` | const-ref parameter to by-value where it improves moves |
| `modernize-replace-random-shuffle` | `std::random_shuffle` to `std::shuffle` |
| `modernize-deprecated-headers` | `<stdio.h>` to `<cstdio>` |
| `modernize-redundant-void-arg` | `f(void)` to `f()` |

Run them in waves. Each wave produces a reviewable diff. Bisecting bugs after a 50,000-line clang-tidy commit is painful, so commit per-check, per-directory.

## Google's Migration Strategy

Google's C++ codebase is the largest in existence, and the migration playbook is documented. The shape.

1. **Read-only adoption first.** Use new features in new code. Existing code stays put.
2. **Library layer wraps both old and new.** Internal `absl::*` hides API differences (`absl::optional` predates `std::optional`, `absl::string_view` predates `std::string_view`). When the standard catches up, swap the underlying type via a typedef change.
3. **Automated mass refactors.** Go/Python tooling on top of clang-tidy and a custom AST-rewriting framework. Migrations land as machine-generated diffs reviewed by domain teams.
4. **One standard at a time.** The codebase is on a single language standard at any moment. Bumping the standard is a multi-month project across the entire monorepo.
5. **No partial adoption per directory.** Either everything compiles under C++17, or nothing does.

The Abseil library is the artifact. It backports modern facilities to the previous standard so code can be written in modern style years before the language officially supports it.

## Bloomberg's Migration Strategy

Bloomberg's C++ codebase is similarly large and similarly old. The strategy differs.

1. **Per-component standard.** Each library declares its required standard. The build system enforces that consumers build under at least that standard.
2. **BDE (Bloomberg Development Environment).** A library similar in spirit to Abseil, providing portable utilities and disciplined memory allocators (`bslma::Allocator`).
3. **Allocator-aware everywhere.** Bloomberg standardized on stateful allocators years before the standard library caught up. Migration to standard `std::pmr` is ongoing.
4. **Component-level deprecation.** Older components are deprecated with a target removal date. New code uses replacements.
5. **Stricter compiler warnings.** Bloomberg builds with all warnings on, errors on warnings, and a project-wide allowlist for the residue.

Both strategies share a principle: do not migrate the codebase in one push. Migrate the **build system** and the **tooling** first, then incrementally migrate code while keeping the codebase compilable at every commit.

## Build System Upgrades

A C++03 codebase on Make or Autotools is now building modules and using `import std`. The build system upgrade is parallel to the language upgrade.

- Adopt CMake 3.28+ for module support.
- Standardize on Ninja for build speed.
- Enable `compile_commands.json` so clang-tidy and clangd work.
- Add `clang-format` to enforce style consistently.
- Set up a sanitiser-instrumented CI lane (`-fsanitize=address,undefined`).

## Quantifying Migration Risk

Before doing the work, measure.

- Count `new`/`delete` pairs. Plot the leak surface.
- Count `throw()` instances.
- Count `NULL` usages.
- Run `-Wreorder`, `-Wmissing-declarations`, `-Wunused-variable` and quantify the warning count.

These numbers become the migration backlog and the success metric. Burn them down per quarter.

## Junior to FAANG / Senior at FAANG

A junior on a migration team should run clang-tidy `modernize-*` checks, review and commit their diffs, replace `new`/`delete` with smart pointers in new code, and avoid touching legacy patterns until the migration owner has approved a refactor.

A senior is expected to plan the migration: pick the target standard, sequence the backlog by safety impact, configure clang-tidy and clang-format for CI, design the compatibility layer (the local equivalent of Abseil or BDE), coordinate with build-system owners on the standard bump, and time-box each phase. They should know how to convert dynamic exception specifications without breaking ABI, when `pmr` allocators replace bespoke allocator hierarchies, and how to keep the codebase green at every commit during a multi-quarter modernization.
