## Google C++ Style and Enforcement

The Google C++ Style Guide is the most influential C++ style document in the industry. It is enforced inside Google by tooling (cpplint, clang-tidy, presubmit checks) and by code review. Outside Google, projects from Chromium to LLVM adopt subsets of it. This file covers the essentials, the rationale, and the enforcement layers.

### The Reading List

- google/styleguide repo on GitHub: cppguide.html.
- abseil.io/tips: "Tips of the Week", concise idioms used internally.
- The 2010-era TotW posts are still required reading for new hires.

### Naming

- Files: `lower_snake_case.cc` and `lower_snake_case.h`.
- Types: `CamelCase`. `User`, `HttpRequest`.
- Functions: `CamelCase` for free functions and methods. `OpenFile`, `ParseInput`. Accessors are lowercase: `name()`, `set_name()`.
- Variables: `lower_snake_case`. Members: `lower_snake_case_` (trailing underscore).
- Constants: `kCamelCase`. `kMaxRetries`, `kDefaultTimeout`.
- Macros: `UPPER_SNAKE_CASE`. Avoid macros where possible.
- Namespaces: `lower_snake_case`.

The trailing underscore on members is non-negotiable. It distinguishes member access (`name_`) from local variables (`name`) and parameters at a glance, eliminating an entire class of `this->name = name` bugs.

### Header Discipline

Every `.cc` file has a corresponding `.h` if it exposes anything. Headers use `#ifndef` guards based on the full repo path:

```cpp
#ifndef MY_PROJECT_FOO_BAR_H_
#define MY_PROJECT_FOO_BAR_H_
// ...
#endif  // MY_PROJECT_FOO_BAR_H_
```

Include order in a `.cc` file:

1. The matching header (`bar.h` for `bar.cc`).
2. C system headers.
3. C++ standard library.
4. Other libraries' headers.
5. This project's headers.

Each block alphabetized. cpplint enforces this.

### Forward Declarations and Includes

Prefer including the header for any type whose definition you use. Forward declare only when:

- You only use a pointer or reference to the type.
- The type appears as a function parameter or return value.

This rule reverses the older C++ habit of forward declaring everything to speed compilation. Modern Google code prefers full includes because:

- Build systems handle compile time (Bazel, distributed builds).
- Forward declarations create silent ABI bugs when types change.

### Exceptions Disabled

Google C++ disables exceptions (`-fno-exceptions`). The reasons are partly historical and partly technical:

- Historical: 2000-era C++ codebases pre-dated reliable RAII patterns. Existing code was not exception-safe. Retrofitting was prohibitive.
- Technical: exceptions cross ABI boundaries unpredictably, complicate debugger workflows, and (in practice) lead to silent control flow that is hard to reason about under load.

Modern alternative: error-as-value. Functions return `absl::Status` or `absl::StatusOr<T>`. Macros (`RETURN_IF_ERROR`, `ASSIGN_OR_RETURN`) make the chain ergonomic. Constructors that can fail are private, with a static factory returning `StatusOr<T>`.

```cpp
class Connection {
 public:
  static absl::StatusOr<std::unique_ptr<Connection>> Create(absl::string_view addr);
 private:
  Connection() = default;  // Cannot fail.
};
```

The downside: every fallible function signature carries the error type. The upside: errors are visible in the type system, the compiler enforces handling, and stack unwinding is predictable.

### RTTI Disabled

`-fno-rtti` is the default in google3. `dynamic_cast` and `typeid` are unavailable. Polymorphism uses virtual functions. Type discrimination uses tagged unions, `std::variant`, or explicit `Kind()` methods.

Cost saved: every virtual class would otherwise carry typeinfo metadata, ~50 to 200 bytes per class times tens of thousands of classes per binary.

### Smart Pointer Rules

- `std::unique_ptr<T>` for sole ownership. Default choice for owning a heap object.
- `std::shared_ptr<T>` only when shared ownership is genuinely needed. Audit every use.
- Raw `T*` for non-owning references with optional null. Bare references where null is impossible.
- `absl::Nonnull<T*>` and `absl::Nullable<T*>` annotations communicate intent (and are checked by static analysis).

A function that takes `std::unique_ptr<T>` by value is signaling "I am taking ownership". A function taking `T*` is signaling "I am borrowing, and I do not retain past this call".

`new` and `delete` are nearly extinct in modern Google C++. Use `std::make_unique<T>(...)` and let the destructor handle it.

### Threadsafety Annotations (Clang TSA)

Clang's thread safety analysis is a static checker that requires annotations on shared state. Used pervasively in google3:

```cpp
class Cache {
 public:
  void Insert(absl::string_view k, std::string v) ABSL_LOCKS_EXCLUDED(mu_);
  std::optional<std::string> Lookup(absl::string_view k) const ABSL_LOCKS_EXCLUDED(mu_);

 private:
  mutable absl::Mutex mu_;
  absl::flat_hash_map<std::string, std::string> data_ ABSL_GUARDED_BY(mu_);
};

void Cache::Insert(absl::string_view k, std::string v) {
  absl::MutexLock l(&mu_);
  data_[std::string(k)] = std::move(v);  // OK, mu_ held.
}
```

`ABSL_GUARDED_BY` declares which lock guards a member. `ABSL_LOCKS_EXCLUDED` declares the function must be called without the lock. Touching `data_` without holding `mu_` is a compile error under `-Wthread-safety`. The check is purely lexical (it does not understand all alias patterns) but catches the majority of forgotten-lock bugs.

### What cpplint Enforces

cpplint is a Python tool that runs on every CL. It checks:

- Header guards present and correctly named.
- Include order correct.
- Line length (default 80, overridable to 100 with team approval).
- No tabs (spaces only, 2 per indent level).
- No trailing whitespace.
- `using namespace std;` forbidden in headers (and discouraged everywhere).
- Copyright header present.
- Variable naming heuristics.

cpplint is fast and runs as a presubmit check. A cpplint failure blocks submission.

### What clang-tidy Adds

clang-tidy is a Clang-based static analyzer with a richer rule set. Google uses it for:

- `modernize-*`: replace raw loops with range-for, replace `typedef` with `using`, replace `NULL` with `nullptr`.
- `performance-*`: detect unnecessary copies, expensive `find` followed by `insert`, `string::find('x') == 0` (use `starts_with`).
- `bugprone-*`: misuse of `optional`, `string_view` of a temporary, integer overflow patterns.
- `readability-*`: inconsistent naming, magic numbers, trailing return type style.
- `google-*`: Google-specific rules (header guards, namespace open form).

clang-tidy is slower than cpplint and runs in batch. Some projects gate submission on it, others run nightly with a backlog system.

### Compile-Time Checks

Google relies on Clang warnings as errors:

- `-Wall -Wextra -Wpedantic`: all the standard warnings.
- `-Wthread-safety`: TSA annotations.
- `-Wshadow`: variable shadowing.
- `-Wconversion`: implicit narrowing conversions.
- `-Wno-c++98-compat`: do not warn about post-C++98 features (we are well past that).

A new warning that fires on existing code is fixed everywhere before being escalated to an error. The "global cleanup" tool (Rosie, then LSC tooling) automates these multi-thousand-CL cleanups.

### google3 Layout

The internal monorepo has a deep directory layout:

```
//google3
  /base               - core utilities (absl predecessors)
  /util               - more utilities (status, time, gtl)
  /net                - networking, RPC, HTTP
  /storage            - bigtable, spanner clients, file APIs
  /third_party        - external dependencies, vendored
  /experimental       - opt-in alpha code
  /<team>/<project>   - team code lives under team-owned dirs
```

Every directory has an OWNERS file. CL approval requires at least one owner per touched directory. The build is Blaze (the internal Bazel). Every BUILD file declares targets, deps, visibility.

Visibility defaults to package-private. To use a target from outside its package, the owner must add your package to `visibility`. This forces deliberate API exposure.

### Bazel Basics

Bazel (the open-source release of Blaze) builds C++, Java, Go, Python, and proto from one tool. A `BUILD` file:

```python
cc_library(
    name = "user_service",
    srcs = ["user_service.cc"],
    hdrs = ["user_service.h"],
    deps = [
        "//base:status",
        "@com_google_absl//absl/strings",
        ":user_proto_cc",
    ],
    visibility = ["//myproject:__subpackages__"],
)

cc_test(
    name = "user_service_test",
    srcs = ["user_service_test.cc"],
    deps = [
        ":user_service",
        "@com_google_googletest//:gtest_main",
    ],
)

proto_library(
    name = "user_proto",
    srcs = ["user.proto"],
)

cc_proto_library(
    name = "user_proto_cc",
    deps = [":user_proto"],
)
```

Bazel's hermetic, content-addressed build cache means a clean build of millions of files completes in minutes when the remote cache is warm. This is the substrate that makes a monorepo workable.

### Junior to FAANG: Style Is Real Engineering

A junior dismisses style guides as bikeshedding. A FAANG-track engineer understands that style is a forcing function for consistency, and consistency is what makes a 10-million-file codebase navigable. Trailing underscores on members, `kCamelCase` for constants, header guards by full path: these are not preferences. They are how the system stays maintainable as it scales.

### Senior at FAANG: Driving Style Evolution

Senior engineers do not just follow the style guide. They propose changes, write the LSC (large scale change) to migrate existing code, and update tooling. When C++17 added `std::optional`, someone wrote the cleanup that migrated `absl::optional` use sites. When `[[nodiscard]]` became standard, someone added it to every fallible function. That work is how seniors leave a mark on the codebase.
