## Reference Collapsing and Perfect Forwarding

Perfect forwarding rests on two language rules and one library function. If you understand all three, you can write any forwarding wrapper. If you misunderstand any one, your wrapper will silently copy when it should move, or worse, dangle.

### The Four Collapsing Rules

References to references cannot exist as types in well-formed C++. They can arise during template substitution and `typedef`/alias expansion. The standard collapses them:

```
T&  &  -> T&
T&  && -> T&
T&& &  -> T&
T&& && -> T&&
```

Mnemonic: any lvalue reference in the chain wins. Only `&& &&` stays as `&&`.

```cpp
using LRef = int&;
using RRef = int&&;

using A = LRef&;   // int&  (& & -> &)
using B = LRef&&;  // int&  (& && -> &)
using C = RRef&;   // int&  (&& & -> &)
using D = RRef&&;  // int&& (&& && -> &&)
```

These rules apply only in contexts where references-to-references can syntactically appear: template instantiation, alias expansion, and `decltype` results. You cannot write `int& &` directly.

### Forwarding References

When `T` is a template parameter and the function takes `T&&`, the parameter is a **forwarding reference** (Scott Meyers called these "universal references", a name the standard rejected). Deduction works as follows:

- Argument is an lvalue of type `U`. `T` deduces to `U&`. Parameter type after collapsing: `U&`.
- Argument is an rvalue of type `U`. `T` deduces to `U`. Parameter type after collapsing: `U&&`.

```cpp
template <class T>
void f(T&& x) {
    // T deduced from argument category
}

int  i = 0;
f(i);            // T = int&,  x is int&
f(42);           // T = int,   x is int&&
f(std::move(i)); // T = int,   x is int&&
```

The name `T` carries the category information. `std::is_lvalue_reference_v<T>` tells you whether the caller passed an lvalue.

### Why std::forward Exists

Inside a forwarding function, the parameter `x` is an lvalue regardless of how it was deduced. Names of things are always lvalues. To preserve the original category when passing `x` further, you cast back to `T&&`:

```cpp
template <class T>
void wrapper(T&& x) {
    callee(static_cast<T&&>(x)); // preserves category
}
```

That cast is exactly what `std::forward<T>` does. Its definition (simplified):

```cpp
namespace std {
    template <class T>
    constexpr T&& forward(std::remove_reference_t<T>& x) noexcept {
        return static_cast<T&&>(x);
    }

    template <class T>
    constexpr T&& forward(std::remove_reference_t<T>&& x) noexcept {
        static_assert(!std::is_lvalue_reference_v<T>,
            "cannot forward an rvalue as an lvalue");
        return static_cast<T&&>(x);
    }
}
```

If `T` is `U&`, then `T&&` collapses to `U&`. `forward` returns an lvalue reference. The receiving function sees an lvalue.

If `T` is `U`, then `T&&` is `U&&`. `forward` returns an rvalue reference. The receiving function sees an xvalue.

### Why T&& and Not U&&

A common bug: writing `std::forward<U>` where `U` is a different parameter, or omitting the template argument:

```cpp
template <class T>
void wrapper(T&& x) {
    callee(std::forward(x));     // ill-formed: cannot deduce T from forward
    callee(std::forward<int>(x)); // wrong if T was int&: forwards as rvalue
}
```

`std::forward` requires the explicit template argument because deducing it would defeat its purpose. The whole point is to use the deduced `T` from the enclosing template.

`std::utility` is the header. The forward declaration lives in `<utility>`. Pre-C++20 you needed to include it explicitly. C++20 module `std` includes it.

### Common Bugs

#### 1. Forgetting to forward

```cpp
template <class T>
void wrapper(T&& x) {
    callee(x); // BUG: x is always lvalue here, even if caller passed rvalue
}
```

The fix: `callee(std::forward<T>(x))`. Without forward, an rvalue argument silently becomes a copy at the next call.

#### 2. Forwarding twice

```cpp
template <class T>
void wrapper(T&& x) {
    log(std::forward<T>(x));    // may move
    process(std::forward<T>(x)); // BUG: x is now moved-from
}
```

If the first forward triggers a move, `x` is a husk. Forward at most once per forwarding reference. If you need both, copy first or take ownership explicitly.

#### 3. Using std::move on a forwarding reference

```cpp
template <class T>
void wrapper(T&& x) {
    callee(std::move(x)); // BUG: turns even lvalue arguments into xvalues
}
```

If the caller passed an lvalue `i`, the wrapper now moves from `i`. The caller's variable is silently destroyed. This is a classic Meyers-style trap.

#### 4. The auto&& trap

```cpp
auto&& x = some_function(); // forwarding-like binding, but x is a name
                            // x is an lvalue inside the block
```

`auto&&` deduction follows the same rules as `T&&`. The variable itself is still an lvalue. Use `std::forward<decltype(x)>(x)` to preserve category in generic lambdas:

```cpp
auto fn = [](auto&& x) { sink(std::forward<decltype(x)>(x)); };
```

#### 5. Non-deduced contexts

```cpp
template <class T>
struct Wrapper {
    void f(T&& x); // NOT a forwarding reference. T is fixed at instantiation.
};
```

`T&&` is a forwarding reference only when `T` is being deduced for that parameter. Member functions of class templates have `T` already fixed. Their `T&&` is a plain rvalue reference.

The same applies to:

```cpp
template <class T>
void f(std::vector<T>&& v); // NOT forwarding. T is deduced, but the parameter type is vector<T>&&, not T&&.
```

### Why "Universal Reference" Is Fragile

Meyers's "universal reference" name was descriptive but misleading. It suggested any `T&&` was universal. In reality, the property requires:

1. The parameter type is exactly `T&&`, not `vector<T>&&` or `T const&&`.
2. `T` is deduced at the point of declaration.
3. There is no `cv`-qualifier on the parameter.

`const T&&` is not a forwarding reference. It binds only to const rvalues. Use it deliberately for "this function takes a movable const", which is rare.

The committee picked "forwarding reference" because the property is what you can do with it (forward), not where it appears.

### Forwarding Multiple Arguments

Variadic templates compose with forwarding via pack expansion:

```cpp
template <class F, class... Args>
decltype(auto) invoke_wrapper(F&& f, Args&&... args) {
    return std::forward<F>(f)(std::forward<Args>(args)...);
}
```

Each `args` element is forwarded with its own `T` from the pack. The expansion `std::forward<Args>(args)...` applies forward elementwise.

### Perfect Forwarding's Imperfections

"Perfect" is aspirational. Forwarding fails for:

- Braced init lists. `f({1,2,3})` cannot deduce a type from `{1,2,3}`.
- 0 as a null pointer. `f(0)` deduces `int`, not a pointer.
- String literals to `const char[N]`. The wrapper sees an array, not a `const char*`.
- Bit-fields. You cannot bind a reference to a bit-field.
- Overloaded functions and templates. Passing the name of an overloaded function does not deduce.
- Static const integral members without out-of-class definition (pre-C++17).

For these, callers need to help: explicit casts, `std::string_view`, or `std::reference_wrapper`.

### Junior at FAANG vs Senior at FAANG

Junior writes `template <class T> void push(T&& x) { vec.push_back(x); }` and the code review gets a "missing forward" comment. Senior writes the same with `std::forward<T>(x)`, ref-qualifies `&&` overloads where it matters, and knows when to use `decay_t<T>` in concepts to constrain the deduced type. Senior also recognizes when `T&&` is **not** a forwarding reference (member of class template, qualified type) and reaches for two overloads (`const T&` and `T&&`) instead.

### Forwarding-Constructor SFINAE

The classic mistake when adding a forwarding constructor:

```cpp
struct Holder {
    template <class T>
    Holder(T&& x); // hijacks copy/move and competes with default copy ctor
};
```

`Holder(Holder&)` resolves to the template, not the implicit copy constructor, because the template is a better match than the const-copy. Constrain with `requires` or `enable_if`:

```cpp
struct Holder {
    template <class T,
              class = std::enable_if_t<!std::is_same_v<std::decay_t<T>, Holder>>>
    Holder(T&& x);
};
```

Or in C++20:

```cpp
struct Holder {
    template <class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Holder>)
    Holder(T&& x);
};
```

`std::remove_cvref_t` (C++20) replaces the `decay_t` idiom for this purpose because it does not perform array-to-pointer or function-to-pointer conversions.
