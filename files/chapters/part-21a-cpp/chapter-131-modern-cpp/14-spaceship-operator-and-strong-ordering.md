## operator<=> and Strong Ordering

C++20 added the **three-way comparison operator**, `<=>`, often called the spaceship operator. A single declaration replaces six relational operators (`==`, `!=`, `<`, `>`, `<=`, `>=`) with a uniform comparison that returns an ordering category. The compiler synthesises the missing operators automatically. Cleaner code, fewer bugs, and a way to express partial vs total orderings that the language never had before.

### The Return Types

`<=>` returns one of three category types from `<compare>`.

| Type | Meaning | Examples |
|---|---|---|
| `std::strong_ordering` | total order, equality means substitutability | integers, strings |
| `std::weak_ordering` | total order, equal elements may differ | case-insensitive strings |
| `std::partial_ordering` | not all elements comparable | floating-point (NaN), DAG |

Each has named values.

```cpp
std::strong_ordering::less      // < 0
std::strong_ordering::equal     // == 0
std::strong_ordering::greater   // > 0

std::partial_ordering::less
std::partial_ordering::equivalent
std::partial_ordering::greater
std::partial_ordering::unordered   // NaN territory
```

A return value compares against literal `0`. `(x <=> y) < 0` means `x < y`. `(x <=> y) == 0` means equivalent. The literal-zero comparison is the public contract.

## Default <=>

Mark `operator<=>` defaulted, and the compiler does memberwise comparison.

```cpp
struct Point {
    int x, y;
    auto operator<=>(const Point&) const = default;
};

Point a{1, 2}, b{1, 3};
a < b;       // true (lexicographic by member order)
a == b;      // false, == is also synthesised
a != b;      // true
```

The default compares members in declaration order, lexicographically. The deduced return type is the **common comparison category** of all members. If every member's `<=>` returns `strong_ordering`, the aggregate's `<=>` returns `strong_ordering`. If any member returns `partial_ordering` (e.g., a `double` field), the aggregate's becomes `partial_ordering`.

## Synthesised Operators

Defining `<=>` (or defaulting it) gives you `<`, `>`, `<=`, `>=` for free. Defining `==` (or defaulting it) gives you `!=` for free. The two are independent: you can default `<=>` and the compiler also generates `==`.

```cpp
struct Money {
    int cents;
    auto operator<=>(const Money&) const = default;   // gives all six operators
};

Money a{100}, b{200};
a < b;    // true
a == b;   // false
a != b;   // true
```

If you write `<=>` by hand and want a custom `==` (often faster than `<=>`), define both.

```cpp
struct LongString {
    std::vector<char> data;

    bool operator==(const LongString& o) const {
        return data.size() == o.data.size() && data == o.data;   // size short-circuit
    }
    auto operator<=>(const LongString& o) const {
        return std::lexicographical_compare_three_way(
            data.begin(), data.end(), o.data.begin(), o.data.end());
    }
};
```

Without the custom `==`, equality would go through `<=>`, which compares the entire vector even when the sizes already differ. Always provide `==` explicitly when there is a fast inequality test.

## Custom <=>

Write a non-defaulted `<=>` when the comparison is non-trivial.

```cpp
struct Version {
    int major, minor, patch;
    std::string tag;   // "alpha", "beta", "rc", ""

    std::weak_ordering operator<=>(const Version& o) const {
        if (auto c = major <=> o.major; c != 0) return c;
        if (auto c = minor <=> o.minor; c != 0) return c;
        if (auto c = patch <=> o.patch; c != 0) return c;
        // tag ordering: "" > "rc" > "beta" > "alpha"
        return tag_rank(tag) <=> tag_rank(o.tag);
    }
    bool operator==(const Version&) const = default;
};
```

Returning `weak_ordering` is honest: two versions with different tags but same numeric components compare equivalent for ordering, while still being distinguishable by `==`.

## Heterogeneous Comparisons

`<=>` can compare across types if you write the appropriate overload.

```cpp
struct Money {
    int cents;
    auto operator<=>(const Money& o) const = default;
    auto operator<=>(int dollars) const { return cents <=> dollars * 100; }
    bool operator==(int dollars) const { return cents == dollars * 100; }
};

Money m{500};
m == 5;   // true
m < 10;   // true
```

Heterogeneous comparison is the historical pitfall. The synthesised `>=`, `<`, `>` derived from a single `<=>(T, U)` are well defined as long as the operator is consistent. If you provide `<=>` only one direction (`Money <=> int` but not `int <=> Money`), the compiler synthesises the reverse only when both `<=>` and `==` exist.

A subtle pitfall: synthesising `<` from `<=>` requires `<=>` to be a member function or a friend. A non-friend free `<=>` is found via ADL but does not participate in synthesis from a `<` syntax. Mark cross-type operators as `friend` inside the class to be safe.

### Partial Ordering

`double` is the textbook case. `NaN` is unordered against every value, including itself. `<=>` on `double` returns `partial_ordering`.

```cpp
double x = 1.0, n = std::nan("");
auto c = x <=> n;
c == std::partial_ordering::unordered;   // true
x < n;     // false
n < x;     // false
n == n;    // false
```

A struct with a `double` member that defaults `<=>` inherits `partial_ordering`. If the type is used as a key in `std::set` or `std::map`, the `<` you get may compare `equivalent` for two unordered values, which the container interprets as equality. To use such a type in an ordered container safely, write a custom comparator that handles NaN explicitly (e.g., sorting NaNs to the end).

## How std::tuple Generates <=>

`std::tuple<Ts...>` defines `<=>` lexicographically, returning the common comparison category of the elements.

```cpp
std::tuple<int, double> a{1, 2.0}, b{1, 3.0};
auto c = a <=> b;
// First component equal, second smaller, returns partial_ordering::less
```

The synthesis short-circuits on the first non-equivalent component, exactly like a defaulted `<=>` on a struct. This is why tuple-based comparison helpers compose cleanly.

```cpp
struct Reading {
    std::string sensor;
    double celsius;  // a measurement, where double is the right type
    int sequence;

    auto operator<=>(const Reading& r) const {
        return std::tie(sensor, celsius, sequence)
           <=> std::tie(r.sensor, r.celsius, r.sequence);
    }
    bool operator==(const Reading&) const = default;
};
```

`std::tie` returns a tuple of references, which then uses tuple's `<=>`. The result type is `partial_ordering` because of the `double`. Switch to `weak_ordering` by hand if you want NaN-safe ordering.

## Common Pitfalls

**Floating-point NaN.** Defaulted `<=>` on a struct with `double` fields gives `partial_ordering`. Ordered containers will misbehave on NaN inputs.

**Const-correctness.** Forget `const` on the parameter or function and you cannot compare temporaries. `auto operator<=>(const T&) const = default` is the canonical signature.

**Mixed comparison categories.** Returning `weak_ordering` from a `<=>` while members return `strong_ordering` is fine (you can always weaken). The reverse is not. You cannot return `strong_ordering` from a `<=>` whose comparison is genuinely weak. The compiler will not enforce this for you.

**Synthesised `==`.** Defaulting `<=>` defaults `==` only if every member is `==`-comparable. If a member has a custom `<=>` but no `==`, the aggregate's `==` is implicitly deleted. Define `==` explicitly when in doubt.

**Hidden cost of <=>.** A defaulted `<=>` does the full lexicographic walk for every comparison, including `==` if synthesised through it. Provide `==` explicitly to short-circuit on size/discriminator.

**Three-way returns inside templates.** `auto` deduction is essential. A hardcoded return type breaks if a member type changes.

## Junior to FAANG / Senior at FAANG

A junior should default `<=>` on value types, default `==` separately when there is a fast equality check, and know that the return type is one of `strong/weak/partial_ordering`. They should compare the return value against `0` rather than against named values.

A senior is expected to choose the comparison category deliberately, write heterogeneous `<=>` overloads as friends to ensure synthesis works, design generic algorithms against `std::three_way_comparable<T>` and `std::three_way_comparable_with<T, U>` concepts, and recognize that NaN-bearing types break ordered containers unless wrapped with a NaN-safe comparator. They should know how `std::lexicographical_compare_three_way` slots into custom container `<=>`, and how the synthesis rules differ between member, friend, and free operators.
