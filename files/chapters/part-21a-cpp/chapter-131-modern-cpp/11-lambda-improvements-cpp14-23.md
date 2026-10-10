## Lambda Improvements C++14 to C++23

Lambdas began in C++11 as a syntactic sugar for ad-hoc function objects. Each subsequent standard expanded their power until, by C++23, a lambda is essentially a fully-featured class with templated members, perfect-forwarding self-reference, and constant-evaluation support.

### C++14: Generic Lambdas and Init Captures

`auto` parameters turn a lambda into a function template.

```cpp
auto add = [](auto a, auto b) { return a + b; };
add(1, 2);          // int
add(1.5, 2.5);      // double
add(std::string{"a"}, "b");
```

Each call site instantiates a specialization of `operator()`. The closure type has a templated call operator, so a single lambda can serve heterogeneous callers.

Init captures (also called generalized lambda captures) introduce new names in the capture list with arbitrary initializers. The two big use cases are renaming and capturing by move.

```cpp
auto p = std::make_unique<Resource>();
auto job = [resource = std::move(p)]() mutable {
    resource->run();
};
```

Capturing a `unique_ptr` by value is impossible without init capture, because the default capture clause copies. `[resource = std::move(p)]` constructs the closure member by moving from `p`. The closure now owns the resource.

## C++17: constexpr Lambdas and Captureless to Function-Pointer

Lambdas with no captures convert to a plain function pointer. C++17 allows the call operator to be `constexpr`, which means the lambda can run during constant evaluation.

```cpp
constexpr auto sq = [](int x) { return x * x; };
static_assert(sq(7) == 49);

void (*f)(int) = [](int x) { std::cout << x; };  // captureless, decays to fp
```

C++17 also added `[*this]`, which captures the enclosing object **by value**, copying it into the closure. This is critical for asynchronous methods.

```cpp
struct Worker {
    int id;
    auto post() {
        return std::async([*this] {        // safe: copy of Worker
            std::println("worker {}", id);
        });
        // [this] would dangle if Worker dies before the async runs.
    }
};
```

`[=, this]` captures everything by value but `this` by raw pointer (the older C++11 default). `[=, *this]` captures the object by value. The asymmetry is a frequent source of dangling-pointer bugs in older code.

### C++20: Template Lambdas, Pack Captures, consteval Lambdas

Generic lambdas got a proper template parameter list, so the type can be named and constrained.

```cpp
auto first_arg = []<typename T>(T&& x, auto&&...) -> T&& {
    return std::forward<T>(x);
};

auto sized = []<typename T, std::size_t N>(std::array<T, N> a) {
    return N;
};
```

Pack captures landed too.

```cpp
auto bind_front = [](auto f, auto&&... args) {
    return [f, ...captured = std::forward<decltype(args)>(args)](auto&&... rest) {
        return f(captured..., std::forward<decltype(rest)>(rest)...);
    };
};
```

`...captured = std::forward<decltype(args)>(args)` is a pack init capture. Each parameter in `args` becomes a separate closure member. Expanded with `captured...` inside the body.

C++20 also clarified that lambdas are constexpr-callable by default when their body permits, and added `consteval` lambdas.

```cpp
constexpr auto double_it  = [](int x) { return x * 2; };  // constexpr by default
auto force_compile_time   = [](int x) consteval { return x * 2; };
```

Stateless lambdas in C++20 are also default-constructible and assignable, which makes them usable as comparators in `std::map` without naming them in the type:

```cpp
std::map<int, int, decltype([](int a, int b){ return a > b; })> m;
```

The closure type is its own default-constructible comparator. No need to write a separate struct.

## C++23: Explicit Object Parameters (Deducing this)

C++23 introduced **explicit object parameters**, often called "deducing this". A member function (or a lambda) takes its object as a named first parameter with type deduction. This unlocks recursive lambdas without `std::function`, and collapses CRTP into normal inheritance.

```cpp
auto fact = [](this auto self, int n) -> int {
    return n < 2 ? 1 : n * self(n - 1);
};
fact(10);   // 3628800
```

`this auto self` says: deduce the type of the closure as `self`. Inside the body, `self(...)` is a recursive call into the same lambda. No `std::function`, no two-pass declaration trick, no `Y` combinator.

The same syntax works on members.

```cpp
struct Tree {
    int value;
    std::vector<Tree> kids;

    template <typename Self>
    auto&& root(this Self&& self) {
        return std::forward<Self>(self).value;   // perfect forwarding
    }
};
```

One definition handles `Tree&`, `const Tree&`, `Tree&&`, `const Tree&&` callers, returning a reference of the matching category. Pre-C++23 this required four overloads.

### Complete Capture Cheatsheet

| Capture | Meaning |
|---|---|
| `[]` | nothing |
| `[=]` | all used by value |
| `[&]` | all used by reference |
| `[x]` | `x` by value |
| `[&x]` | `x` by reference |
| `[x = expr]` | new member `x` from `expr` (init capture) |
| `[&x = expr]` | new reference member `x` bound to `expr` |
| `[this]` | raw pointer to enclosing object |
| `[*this]` | copy of enclosing object |
| `[=, this]` | all-by-value plus raw `this` (deprecated semantics in C++20) |
| `[=, *this]` | all-by-value, object copied |
| `[&, x]` | all-by-reference except `x` by value |
| `[..., args = ...]` | pack init capture |

Defaulted captures (`[=]` and `[&]`) only capture names actually used in the body. They do not capture every name in scope.

### Mutable Lambdas

By default, the call operator of a lambda is `const`. Captured-by-value members are not mutable. `mutable` lifts that restriction.

```cpp
auto counter = [n = 0]() mutable { return n++; };
counter();   // 0
counter();   // 1
```

Without `mutable`, `n++` does not compile because `operator()` is `const`.

### Recursive Lambdas Before C++23

Before deducing this, recursion required a workaround. The classic patterns.

```cpp
// std::function. Type-erased, allocates, slow.
std::function<int(int)> fact = [&](int n) {
    return n < 2 ? 1 : n * fact(n - 1);
};

// Y-combinator style.
auto y = [](auto self, int n) -> int {
    return n < 2 ? 1 : n * self(self, n - 1);
};
y(y, 10);
```

C++23 makes both obsolete. `[](this auto self, int n) { ... }` is the right answer.

### Empty Closure Optimization

A captureless lambda has size 1 (the standard mandates non-zero size for distinct objects). Stored as a member with `[[no_unique_address]]`, it costs nothing.

```cpp
template <typename F>
struct compressed {
    [[no_unique_address]] F f;
    int payload;
};
```

`sizeof(compressed<decltype([](int x){ return x; })>) == sizeof(int)` on most ABIs. This is how STL containers store empty allocators and comparators without paying for them.

## Performance Notes

A captureless lambda compiles to the same code as a free function. A small-by-value capture compiles to a struct passed by value. A `[&]` capture is a pointer. Lambdas inline as readily as any other function, often more readily because the type is unique to the call site, so the optimizer sees a known callee.

The pessimistic case is `std::function<...>`, which type-erases the closure and forces a virtual call plus a heap allocation for non-small closures. Avoid `std::function` in hot paths. Use templated callbacks (`template <typename F> void take(F f)`) or `std::move_only_function` (C++23) when the callback must be stored.

## Junior to FAANG / Senior at FAANG

A junior should write generic lambdas with `auto` parameters, capture `unique_ptr` with init capture, and prefer `[*this]` over `[this]` for asynchronous code. They should know that `mutable` is required to modify by-value captures, and that captureless lambdas decay to function pointers.

A senior is expected to use deducing-this lambdas for recursion, design fluent APIs that exploit explicit object parameters, know when `std::move_only_function` replaces `std::function`, and recognize lambda lifetime hazards across coroutine and thread boundaries. They should be able to read the closure type the compiler synthesises, predict whether `[[no_unique_address]]` collapses an empty capture, and replace SFINAE-driven function-object hierarchies with template lambdas.
