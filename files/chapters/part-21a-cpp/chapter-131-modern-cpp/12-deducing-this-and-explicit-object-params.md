## Deducing this and Explicit Object Parameters

C++23 introduced **explicit object parameters** (P0847), also called "deducing this". A member function may take its object as a named, deduced first parameter. This collapses qualifier overloads, replaces CRTP, enables recursive lambdas, and makes fluent APIs natural to write.

### The Syntax

```cpp
struct Foo {
    int x;

    template <typename Self>
    auto&& get(this Self&& self) {
        return std::forward<Self>(self).x;
    }
};
```

`this Self&& self` introduces a parameter named `self` whose type is the deduced object type. There is no implicit `this` pointer inside the body. You access members through `self`.

`get` here is one definition. Called on `Foo&` it returns `int&`. Called on `const Foo&` it returns `const int&`. Called on `Foo&&` it returns `int&&`. Called on `const Foo&&` it returns `const int&&`. **Four overloads collapse into one.**

### The Pre-C++23 Pain

The same forwarding behavior required four hand-written overloads.

```cpp
struct FooOld {
    int x;
    int&        get() &        { return x; }
    const int&  get() const &  { return x; }
    int&&       get() &&       { return std::move(x); }
    const int&& get() const && { return std::move(x); }
};
```

Each must be kept in sync. Mistakes in one variant silently surface as the wrong reference category. Code generators wrote scripts to expand the matrix. C++23 retires the matrix.

### Forwarding to a Helper

The pattern composes. A common idiom is to have one templated entry point that forwards into a static helper, so the forwarding logic lives in one place.

```cpp
struct Container {
    std::vector<int> data;

    template <typename Self>
    auto&& at(this Self&& self, std::size_t i) {
        return std::forward<Self>(self).data[i];
    }

    template <typename Self>
    auto begin(this Self&& self) {
        return std::forward<Self>(self).data.begin();
    }
};
```

The same `at` works for read-only access on `const Container&` and write access on `Container&`. There is no UB hidden behind a `const_cast`, no copy-paste between the const and non-const variants.

### CRTP Replacement

The Curiously Recurring Template Pattern emulated static polymorphism by templating a base on the derived class.

```cpp
// Old CRTP.
template <typename D>
struct Comparable {
    bool operator!=(const Comparable& o) const {
        return !static_cast<const D&>(*this).equals(static_cast<const D&>(o));
    }
};

struct Money : Comparable<Money> {
    int cents;
    bool equals(const Money& o) const { return cents == o.cents; }
};
```

The `static_cast` boilerplate is necessary because `*this` is a `Comparable<D>`, not a `D`. With deducing this, the cast disappears.

```cpp
struct Comparable {
    template <typename Self>
    bool operator!=(this const Self& self, const Self& o) {
        return !self.equals(o);
    }
};

struct Money : Comparable {
    int cents;
    bool equals(const Money& o) const { return cents == o.cents; }
};
```

`self` is already `const Money&` because the template deduced it. The base class can be non-templated. Inheritance chains stay simple. Multiple "mixin" bases compose without the diamond-CRTP nightmare.

## Recursive Lambdas

Before C++23, recursive lambdas needed `std::function` (type-erased, allocates) or a Y-combinator trick. Deducing this lets a lambda name itself.

```cpp
auto fib = [](this auto self, int n) -> int {
    return n < 2 ? n : self(n - 1) + self(n - 2);
};
```

`self` is the closure type. Calling `self(...)` recurses. The closure has no captures, no allocations, and inlines fully.

A worked example: depth-first traversal with a lambda.

```cpp
struct Node { int v; std::vector<Node> kids; };

int sum(const Node& root) {
    auto rec = [](this auto self, const Node& n) -> int {
        int total = n.v;
        for (auto& k : n.kids) total += self(k);
        return total;
    };
    return rec(root);
}
```

This compiles to the same code a hand-written function would. No virtual call, no allocation.

### Fluent APIs

Fluent builders chain calls that return `*this`. With deducing this, the chain works correctly for rvalue temporaries.

```cpp
struct Request {
    std::string url;
    std::vector<std::pair<std::string, std::string>> headers;

    template <typename Self>
    auto&& with_url(this Self&& self, std::string u) {
        std::forward<Self>(self).url = std::move(u);
        return std::forward<Self>(self);
    }

    template <typename Self>
    auto&& with_header(this Self&& self, std::string k, std::string v) {
        std::forward<Self>(self).headers.emplace_back(std::move(k), std::move(v));
        return std::forward<Self>(self);
    }
};

auto req = Request{}
    .with_url("https://api.example.com/v1/things")
    .with_header("Authorization", "Bearer ...")
    .with_header("Accept", "application/json");
```

Each call returns the same reference category as its caller. If the chain starts on an rvalue (the temporary `Request{}`), every `with_*` returns an rvalue reference, and the moves go all the way through. If the chain starts on an lvalue, lvalue references propagate. The builder is move-friendly without writing two versions of every method.

### Mixing with Concepts

Constraints attach to `Self` like any other template parameter.

```cpp
struct Container {
    std::vector<int> data;

    template <typename Self>
        requires std::is_same_v<std::remove_cvref_t<Self>, Container>
    auto size(this Self&& self) {
        return self.data.size();
    }
};
```

You can also constrain on which qualifier is allowed.

```cpp
template <typename Self>
    requires std::is_lvalue_reference_v<Self&&>
void modify(this Self& self, int n);
```

Useful for methods that should not be callable on temporaries.

### Caveats

`this Self` parameters cannot have default arguments. Virtual functions cannot use deducing this. Constructors and destructors cannot. Inside the body, `this` (the keyword) is not available, so any code that historically used `this` must use `&self` instead.

Because the deduction happens through normal template machinery, two member functions with the same name and different `Self` constraints participate in overload resolution like any function template. This is more flexible than the old `&`/`const&`/`&&` overload set but also a new vector for ambiguity. Apply concepts to disambiguate.

ABI: a deducing-this member function is implemented like a static member function that takes the object as its first argument. It does not enter the vtable. Calls to it from a base-class pointer go through the deduced-`Self` mechanism, which means they are statically resolved. This is what makes CRTP-style mixins efficient.

## Adoption

GCC 14, Clang 18, and MSVC 17.10 all ship complete deducing-this support. Production usage in 2026 is climbing rapidly because the feature is high-value and its compile-time cost is low.

## Junior to FAANG / Senior at FAANG

A junior should recognize `this Self&& self` syntax, use it to write a single getter that handles all qualifier combinations, and write recursive lambdas with `[](this auto self, ...)`. They should know that `this` (the keyword) is unavailable inside such a function and that `self` replaces it.

A senior is expected to retire CRTP from new code, design fluent APIs that move correctly through chains of temporaries, replace overload matrices on `&`/`const&`/`&&` with deducing-this templates, and reason about which call sites actually monomorphise. They should know that virtual functions cannot use deducing this, that the implicit object parameter rules differ from regular `this`-pointer rules, and how the deduced type interacts with concepts and `std::forward_like` for forwarding member access.
