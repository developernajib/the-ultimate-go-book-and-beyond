## Forwarding References vs Rvalue References

`T&&` looks the same in two very different contexts. In one, it is a forwarding reference that binds to anything. In the other, it is a plain rvalue reference that binds only to rvalues. Confusing the two is the most common source of perfect-forwarding bugs.

### The Two Contexts

#### Forwarding reference (deduced)

```cpp
template <class T>
void f(T&& x); // T deduced from argument; T&& is a forwarding reference

f(42);   // T = int, x is int&&
int i;
f(i);    // T = int&, x is int& (collapsed)
```

#### Rvalue reference (not deduced)

```cpp
void f(int&& x);    // int&& is a plain rvalue reference

template <class T>
class Vec {
    void push(T&& x); // T is fixed by Vec, T&& is plain rvalue ref of T
};
```

The distinction is whether `T` is being deduced at the point where `T&&` appears. If yes, forwarding. If no, plain rvalue.

### Why the Distinction Matters

Forwarding references can bind to lvalues. Plain rvalue references cannot.

```cpp
void g(int&& x) { /* ... */ }

int i = 0;
g(i);            // ill-formed: cannot bind rvalue ref to lvalue
g(42);           // ok
g(std::move(i)); // ok
```

```cpp
template <class T>
void h(T&& x) { /* ... */ }

int i = 0;
h(i);            // ok: T = int&, x is int&
h(42);           // ok: T = int, x is int&&
h(std::move(i)); // ok: T = int, x is int&&
```

The rules of reference collapsing make the deduced version "universal".

### Recognizing the Forwarding Context

A `T&&` is a forwarding reference iff:

1. The function is a template.
2. `T` is a template parameter of that function.
3. `T` is being deduced at the parameter position.
4. The exact spelling is `T&&` (not `const T&&`, not `T const&&`, not `vector<T>&&`).

Otherwise it is a plain rvalue reference.

```cpp
template <class T> void f(T&& x);              // forwarding
template <class T> void f(const T&& x);        // plain rvalue (const-qualified)
template <class T> void f(std::vector<T>&& v); // plain rvalue (vector<T>, not T)
template <class T>
struct S {
    void f(T&& x); // plain rvalue: T is fixed when S is instantiated
};

template <class T> void f(T&&...);     // forwarding (pack)
template <class T> auto f(T&&) -> auto&; // forwarding
```

### std::move vs std::forward

The two casts have different invariants.

`std::move(x)` unconditionally produces an xvalue. Use it when you have a named lvalue and you intend to consume it.

`std::forward<T>(x)` produces an lvalue or xvalue depending on `T`. Use it on forwarding references to preserve the original category.

```cpp
template <class T>
void wrapper(T&& x) {
    consume(std::move(x));   // BUG: hijacks lvalues
    consume(std::forward<T>(x)); // correct
}
```

If the caller passes an lvalue `i`, `wrapper(i)` deduces `T = int&`. With `std::move(x)`, `x` becomes an xvalue and `consume` may move from it. The caller's `i` is silently destroyed.

With `std::forward<T>(x)`, `T = int&`, the cast is `static_cast<int& &&>(x)` which collapses to `int&`. The lvalue category is preserved. `consume` sees an lvalue.

### Common Mistakes

#### 1. Move on a forwarding reference

```cpp
template <class T>
void log(T&& x) {
    spdlog::info("{}", std::move(x)); // BUG
}
```

The fix: `std::forward<T>(x)`.

#### 2. Forward on a plain rvalue reference

```cpp
void log(std::string&& x) {
    spdlog::info("{}", std::forward<std::string>(x)); // works but is misleading
}
```

Plain rvalue references are always rvalues at the call site. `std::move(x)` is the correct cast. `std::forward<T>(x)` works because `T` is `std::string` (no reference) and `T&&` is `std::string&&`, but writing forward suggests there is a deduction at play. There is not. Use move.

#### 3. Forwarding twice

```cpp
template <class T>
void wrapper(T&& x) {
    a(std::forward<T>(x));
    b(std::forward<T>(x)); // x may be moved-from
}
```

Forward at most once. If both calls need an rvalue, copy first or split the API.

#### 4. Treating `auto&&` as always-forwarding

```cpp
auto&& x = produce();
// x is named, lvalue inside the block
sink(x);                    // copies (if possible) or fails
sink(std::forward<decltype(x)>(x)); // correct in generic lambdas
```

#### 5. Forward without explicit T

```cpp
template <class T>
void wrapper(T&& x) {
    sink(std::forward(x)); // ill-formed: cannot deduce T from forward(x)
}
```

`std::forward<T>(x)` requires the explicit template argument by design.

### [[nodiscard]] on Forwarding Helpers

A forwarding wrapper that produces a value benefits from `[[nodiscard]]`:

```cpp
template <class T>
[[nodiscard]] decltype(auto) tap(T&& x) {
    log(x);
    return std::forward<T>(x);
}

auto y = tap(make_widget()); // ok
tap(make_widget());          // warning: discarded
```

`std::move` and `std::forward` are themselves `[[nodiscard]]` since C++20 in some implementations. Using them in a discarded-value position is a likely bug (you converted but did nothing with the result).

### Constraining Forwarding Constructors

Forwarding constructors compete with copy/move constructors:

```cpp
struct Holder {
    template <class T>
    Holder(T&& x) : value(std::forward<T>(x)) {}
    int value;
};

Holder h(42);
Holder h2 = h; // resolves to template, not implicit copy! T = Holder&
```

The template binds `T = Holder&` and the constructor body tries to initialize `int` from `Holder`. Compile error in the body.

Constrain the template:

```cpp
struct Holder {
    template <class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Holder>)
    Holder(T&& x) : value(std::forward<T>(x)) {}
    Holder(const Holder&) = default;
    Holder(Holder&&)      = default;
    int value;
};
```

The constraint excludes `Holder` itself, preventing the template from competing with the copy/move constructors.

### Forwarding in Lambdas

Generic lambdas (C++14+) use `auto`. The forwarding equivalent uses `auto&&`:

```cpp
auto fn = [](auto&& x) {
    use(std::forward<decltype(x)>(x));
};
```

`decltype(x)` yields the deduced type with reference qualifiers. Forwarding via `decltype(x)` reproduces the template forwarding pattern.

C++20 added explicit template parameters in lambdas:

```cpp
auto fn = []<class T>(T&& x) {
    use(std::forward<T>(x));
};
```

Cleaner and avoids `decltype(x)`.

C++23 added explicit `this` parameter and ref-qualifiers on lambdas, useful for advanced patterns.

### Forwarding in Variadic Templates

```cpp
template <class F, class... Args>
decltype(auto) invoke_logged(F&& f, Args&&... args) {
    log("calling");
    return std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
}
```

`std::forward<Args>(args)...` is a pack expansion. Each element of `args` is forwarded with its corresponding `Args` element. The result is perfect forwarding for the entire argument list.

### The Decay Trap

When you store a forwarding reference, you usually want to decay it (remove references and cv-qualifiers):

```cpp
template <class T>
auto store(T&& x) {
    using D = std::decay_t<T>;
    return D(std::forward<T>(x)); // store as a value
}
```

Forgetting to decay stores a reference, often dangling. `std::decay_t<T>` strips references, cv, and applies array-to-pointer/function-to-pointer. C++20's `std::remove_cvref_t<T>` is preferable when you only want to drop references and cv (no array decay).

### Junior at FAANG vs Senior at FAANG

Junior reads `template <class T> void f(T&& x)` and `void g(int&& x)` and assumes both behave the same. They write `std::move(x)` in both bodies. The template silently moves lvalues. Senior reads the function signature, identifies whether `T&&` is a forwarding reference (template + deduction) or a plain rvalue reference, picks `std::forward<T>` or `std::move` accordingly, and constrains forwarding constructors with `remove_cvref_t` to avoid hijacking copy/move.

### Drill

1. `template <class T> void f(std::vector<T>&& v);`. Is `v` a forwarding reference? No: parameter is `vector<T>&&`, not `T&&`.
2. Inside `template <class T> void g(T&& x);`, what should you write to forward `x`? `std::forward<T>(x)`.
3. What does `auto&&` deduce when bound to `make()` (which returns by value)? `decltype(x)` is `RetType&&`, an rvalue reference.
4. Why does a forwarding constructor often hijack copy? Template binds `T = MyClass&` and is a better match than `MyClass(const MyClass&)`.
5. What's the C++20 trait for stripping cv and references but not array/function decay? `std::remove_cvref_t`.
