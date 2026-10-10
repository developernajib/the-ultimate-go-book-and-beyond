## Concepts Deep Dive

C++20 concepts replace the SFINAE machinery that templated code carried for two decades. A concept is a named, compile-time predicate over template parameters. The compiler evaluates it during overload resolution, prunes candidates that fail, and produces error messages that point at the failing requirement instead of dumping a 400-line template instantiation backtrace.

### Concept Declaration

A concept is declared with the `concept` keyword. The right-hand side is a constant boolean expression, often built from `requires` expressions or other concepts.

```cpp
template <typename T>
concept Integral = std::is_integral_v<T>;

template <typename T>
concept SignedIntegral = Integral<T> && std::is_signed_v<T>;

template <typename T>
concept UnsignedIntegral = Integral<T> && !SignedIntegral<T>;
```

Concepts are first-class in the type system. They participate in overload resolution and partial ordering. Two functions can share a name if their constraints differ.

```cpp
void process(SignedIntegral auto x)   { /* signed path */ }
void process(UnsignedIntegral auto x) { /* unsigned path, no sign-extension */ }
```

The `auto` form is the abbreviated function template syntax. It is equivalent to `template <SignedIntegral T> void process(T x)` but reads like a normal function.

### Requires Expressions

A `requires` expression is a compile-time check on a set of expressions. It returns `true` if every requirement is well-formed.

```cpp
template <typename T>
concept Hashable = requires(T a) {
    { std::hash<T>{}(a) } -> std::convertible_to<std::size_t>;
};

template <typename Iter>
concept RandomAccessIter = requires(Iter it, std::ptrdiff_t n) {
    { it + n }  -> std::same_as<Iter>;
    { it[n]  }  -> std::convertible_to<std::iter_value_t<Iter>>;
    { it - it } -> std::convertible_to<std::ptrdiff_t>;
};
```

Four kinds of requirements live inside a `requires` block:

1. **Simple requirement.** An expression that must compile. `a + b`.
2. **Type requirement.** `typename T::value_type` proves a nested type exists.
3. **Compound requirement.** `{ expr } noexcept -> Concept` checks compile, optional `noexcept`, and the result satisfies a concept.
4. **Nested requirement.** `requires Concept<T>` introduces another constraint.

```cpp
template <typename C>
concept Container = requires(C c) {
    typename C::value_type;
    typename C::iterator;
    { c.begin() } -> std::same_as<typename C::iterator>;
    { c.end()   } -> std::same_as<typename C::iterator>;
    { c.size()  } noexcept -> std::convertible_to<std::size_t>;
    requires std::copyable<typename C::value_type>;
};
```

### Requires Clauses

A `requires` clause attaches a constraint to a template, function, or member. It can sit after the template parameter list, after the function signature, or both.

```cpp
template <typename T>
    requires std::integral<T>
T gcd(T a, T b) {
    while (b) { auto t = b; b = a % b; a = t; }
    return a;
}

// Trailing requires-clause sees the parameters by name.
template <typename T>
T abs_val(T x) requires std::signed_integral<T> {
    return x < 0 ? -x : x;
}
```

Combining clauses with logical operators is allowed only with `&&` and `||` at the top level. Anything more complex must be wrapped in a named concept or a parenthesised expression. This restriction exists so the compiler can do subsumption analysis on the constraint syntax tree.

### Atomic Constraints and Subsumption

The compiler decomposes a constraint expression into **atomic constraints**, the leaves of the `&&` / `||` tree. Two functions overload on constraints, and the more-constrained one wins. The rule used is **subsumption**.

Constraint A subsumes B when every disjunctive clause of A implies some disjunctive clause of B. Two atomic constraints are equivalent only if they originate from the same source location after substitution. This is why `std::is_integral_v<T>` written twice in two different places is **not** considered the same atomic constraint, but `Integral<T>` referenced in two places is.

```cpp
template <typename T> concept A = std::is_integral_v<T>;
template <typename T> concept B = A<T> && std::is_signed_v<T>;

void f(A auto);   // less constrained
void f(B auto);   // more constrained, wins for signed integers
```

If you wrote the body of `B` inline as `std::is_integral_v<T> && std::is_signed_v<T>` instead of going through `A`, the compiler still subsumes because both atomic constraints are sourced from the same trait expression. The practical guidance is to **always go through named concepts** so subsumption is predictable across translation units.

### Replacing SFINAE

Pre-C++20 code expressed constraints with `std::enable_if_t` or expression SFINAE. Both work but produce the worst error messages in the language.

```cpp
// Old SFINAE.
template <typename T,
          std::enable_if_t<std::is_integral_v<T>, int> = 0>
T twice(T x) { return x + x; }

// Concepts.
template <std::integral T>
T twice(T x) { return x + x; }

// Even shorter.
auto twice(std::integral auto x) { return x + x; }
```

When `twice("hello")` fails, the SFINAE version emits "no matching function". The concept version emits "the required expression `std::integral<const char*>` evaluated to false". That is the entire reason concepts shipped.

### Common Standard Concepts

The `<concepts>` header defines a layered hierarchy. Production code mostly touches these.

| Concept | What it guarantees |
|---|---|
| `same_as<T, U>` | `T` and `U` are the same type after `std::remove_cvref` does not apply |
| `convertible_to<From, To>` | implicit and explicit conversion |
| `derived_from<D, B>` | `D*` converts to `B*` |
| `integral`, `signed_integral`, `unsigned_integral`, `floating_point` | numeric kinds |
| `equality_comparable<T>` | `==` and `!=` return `bool` |
| `equality_comparable_with<T, U>` | cross-type `==` plus a common reference |
| `totally_ordered<T>` | `<`, `>`, `<=`, `>=`, all consistent |
| `movable<T>`, `copyable<T>` | rule-of-five subsets |
| `semiregular<T>` | `copyable` plus default-constructible |
| `regular<T>` | `semiregular` plus `equality_comparable` |
| `invocable<F, Args...>` | callable, no return constraint |
| `predicate<F, Args...>` | callable returning something convertible to `bool` |

`regular` is the type Stepanov defined in *Elements of Programming* as the well-behaved type. If your value type is `regular`, generic algorithms can copy, compare, and store it without surprise.

```cpp
template <std::regular T>
class small_vector {
    // safe to copy, default-construct, and compare element-wise.
};
```

`equality_comparable_with<T, U>` is the cross-type version. It additionally requires `std::common_reference_with<T, U>`, which prevents nonsense like comparing a `std::string` to a `std::vector<char>` even though both have a notion of equality with `const char*`.

### Constrained Auto and Return Types

Concepts work everywhere `auto` is allowed.

```cpp
std::integral auto sum(std::ranges::range auto&& r) {
    std::integral auto acc = 0;
    for (auto&& x : r) acc += x;
    return acc;
}
```

The return slot constrains the deduced type. If a refactor accidentally returns a `double`, the compiler rejects it at the function definition rather than at some far-away caller.

### Junior to FAANG / Senior at FAANG

A junior engineer joining a FAANG C++ codebase should be able to write `template <std::integral T>` and use `requires` clauses to constrain function templates. They should know that concepts produce better error messages than SFINAE and should reach for `std::regular` when defining value types.

A senior engineer is expected to design concept hierarchies that subsume cleanly, debug overload resolution failures by reading the constraint tree the compiler reports, and decide when to introduce a new concept versus reuse a standard one. They should know that atomic constraints are identified by source location, that concepts cannot be specialized, and that constraint checking is part of name lookup, which means a poorly-written concept slows compilation across every translation unit that includes it.
