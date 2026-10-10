## Concepts (C++20)

Concepts are C++20's answer to the question "how do I constrain template parameters cleanly?" They replace SFINAE, `enable_if`, and tag dispatch with readable, declarative syntax.

### Defining Concepts

C++20 concepts provide first-class syntax for expressing template constraints, replacing the SFINAE idiom with readable, compiler-enforced requirements. Constraints are checked at the call site, producing clear error messages when a type does not satisfy the required interface.
```cpp
#include <concepts>

// A concept is a named set of constraints
template <typename T>
concept Numeric = std::is_arithmetic_v<T>;

template <typename T>
concept Addable = requires(T a, T b) {
    { a + b } -> std::convertible_to<T>;
};

template <typename T>
concept Hashable = requires(T t) {
    { std::hash<T>{}(t) } -> std::convertible_to<std::size_t>;
};

template <typename T>
concept Printable = requires(T t, std::ostream& os) {
    { os << t } -> std::same_as<std::ostream&>;
};

template <typename T>
concept Container = requires(T c) {
    typename T::value_type;
    typename T::iterator;
    { c.begin() } -> std::same_as<typename T::iterator>;
    { c.end() } -> std::same_as<typename T::iterator>;
    { c.size() } -> std::convertible_to<std::size_t>;
};
```

### The `requires` Expression in Detail

A `requires` expression can contain four kinds of requirements:

```cpp
template <typename T>
concept FullyFeatured = requires(T a, T b) {
    // 1. Simple requirement: expression must be valid
    a + b;
    a.size();

    // 2. Type requirement: associated type must exist
    typename T::value_type;
    typename T::iterator;

    // 3. Compound requirement: expression valid + return type constraint
    { a + b } -> std::convertible_to<T>;
    { a.size() } noexcept -> std::same_as<size_t>;  // also requires noexcept

    // 4. Nested requirement: arbitrary boolean constraint
    requires sizeof(T) >= 4;
    requires std::is_default_constructible_v<T>;
};
```

### Using Concepts

There are four ways to apply a concept:

```cpp
// 1. Requires clause after template parameter list
template <typename T>
    requires Numeric<T>
T Square(T x) {
    return x * x;
}

// 2. Trailing requires clause
template <typename T>
T Cube(T x) requires Numeric<T> {
    return x * x * x;
}

// 3. Constrained template parameter (cleanest syntax)
template <Numeric T>
T Double(T x) {
    return x + x;
}

// 4. Abbreviated function template with auto
Numeric auto Half(Numeric auto x) {
    return x / 2;
}

int main() {
    std::cout << Square(5) << "\n";    // 25
    std::cout << Double(3.14) << "\n"; // 6.28
    // Square(std::string("hi")); // compile error: string is not Numeric
    return 0;
}
```

### Combining Concepts

Concepts compose with `&&` and `||`:

```cpp
template <typename T>
concept OrderedNumeric = Numeric<T> && std::totally_ordered<T>;

template <typename T>
concept Serializable = Printable<T> && requires(T t) {
    { t.Serialize() } -> std::convertible_to<std::string>;
};

template <typename T>
concept SmallNumeric = Numeric<T> && (sizeof(T) <= 4);
```

### Concept Subsumption and Overload Resolution

When multiple constrained overloads match, the compiler picks the most constrained one. This is called **subsumption**: concept A subsumes concept B if A implies B.

```cpp
template <typename T>
concept Drawable = requires(T t) { t.Draw(); };

template <typename T>
concept ResizableDrawable = Drawable<T> && requires(T t, int w, int h) {
    t.Resize(w, h);
};

// Less constrained
template <Drawable T>
void Render(T& obj) {
    obj.Draw();
    std::cout << " (basic render)\n";
}

// More constrained -- preferred when both match
template <ResizableDrawable T>
void Render(T& obj) {
    obj.Resize(800, 600);
    obj.Draw();
    std::cout << " (resized render)\n";
}

struct Circle {
    void Draw() { std::cout << "Drawing circle"; }
};

struct Window {
    void Draw() { std::cout << "Drawing window"; }
    void Resize(int w, int h) { std::cout << "Resized to " << w << "x" << h << " "; }
};

int main() {
    Circle c;
    Render(c);   // calls Drawable version: "Drawing circle (basic render)"

    Window w;
    Render(w);   // calls ResizableDrawable version: "Resized to 800x600 Drawing window (resized render)"
    return 0;
}
```

This is dramatically cleaner than the SFINAE equivalent, which would require careful `enable_if` conditions to avoid ambiguity.

### Concepts vs Go Type Constraints

This is a critical comparison point. Both languages constrain generic type parameters, but they do it very differently.

**Go type constraints (interface-based type sets):**

```go
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
    ~float32 | ~float64
}

func Sum[T Numeric](values []T) T {
    var total T
    for _, v := range values {
        total += v
    }
    return total
}
```

**C++ concepts (structural/expression-based):**

```cpp
template <typename T>
concept Numeric = requires(T a, T b) {
    { a + b } -> std::convertible_to<T>;
    { a - b } -> std::convertible_to<T>;
    { a * b } -> std::convertible_to<T>;
    { a / b } -> std::convertible_to<T>;
    { a < b } -> std::convertible_to<bool>;
};

template <Numeric T>
T Sum(const std::vector<T>& values) {
    T total{};
    for (const auto& v : values) {
        total += v;
    }
    return total;
}
```

| Aspect | Go Constraints | C++ Concepts |
|---|---|---|
| Basis | Explicit type sets (union of types) | Structural (required expressions/operations) |
| Checked at | Compile time | Compile time |
| Can require methods | Yes (interface methods) | Yes (requires clause) |
| Can require operators | Indirectly (via type sets) | Directly (expression-based) |
| Can require associated types | No | Yes (`typename T::value_type`) |
| Error messages | Clear, but limited | Much improved in C++20 |
| Composability | Embedding interfaces | `&&` and `\|\|` on concepts |
| Subsumption/overloading | No | Yes (most-constrained overload wins) |

---

### Junior → FAANG: Concepts as the Readable Face of Template Constraints

For Go engineers learning C++, concepts are the best entry point into template constraints because they read like Go interface constraints. `template<std::ranges::range T>` communicates "T must be a range" the same way `[T constraints.Ordered]` in Go communicates "T must be orderable." Start with the standard library concepts (`std::integral`, `std::floating_point`, `std::ranges::range`, `std::invocable`) before writing your own.

The interview signal: knowing that concepts improve error messages (the constraint violation is reported at the call site, not deep in instantiation) and that they enable overload resolution between constrained overloads (the most constrained overload wins). These two properties are the practical arguments for concepts over SFINAE.

### Senior @ FAANG: Concepts as an API Contract Tool and Subsumption in Overload Design

At the staff level, concepts are an API design tool: they express the semantic requirements of a template parameter in a verifiable, documentable form.

**Semantic vs. syntactic concepts.** A syntactic concept checks that operations compile (`requires { t.size(); }`). A semantic concept additionally requires that the operations have specific meaning (e.g., `std::ranges::range` requires not just that `begin(t)` compiles, but that it returns an iterator that satisfies `std::input_iterator`). A staff engineer designs concepts at the semantic level, not just the syntactic level, and documents semantic requirements in the concept's comment.

**Concept subsumption for overload design.** When two overloads are distinguished by concepts, the compiler picks the most constrained one. `template<std::integral T>` and `template<std::signed_integral T>` can coexist, and a call with a `signed int` picks the more constrained `std::signed_integral` overload. A staff engineer uses subsumption to design layered generic APIs: a general overload for the broadest concept, and specialized overloads for progressively more constrained concepts, each providing better performance or behavior for its specific case.

