## Part IV: C++26 Preview - The Next Frontier

The C++26 feature set was frozen at the Sofia committee meeting in June 2025, and the standard is in its final balloting stages. The two headline features, static reflection and contracts, are formally in. Compiler support is still rolling out, so treat the code in this part as "standardized but not yet everywhere": the syntax is stable, but you may need an experimental compiler branch to run it today.

### Static Reflection

Reflection allows programs to inspect their own types, members, and properties at compile time. This has been the most requested C++ feature for decades, and P2996 was voted into C++26 at the Sofia meeting.

The reflection operator is `^^` (two carets, informally called the "cat ears" operator). Earlier drafts used a single `^`, but that conflicted with Apple's blocks extension, so P3381 changed it. If you see single-caret reflection code in older blog posts, it is pre-adoption syntax.

```cpp
// C++26 (adopted syntax, compiler support still experimental)
#include <meta>
#include <iostream>

struct Employee {
    std::string name;
    int id;
    long long salary_cents;
};

// Automatic serialization via reflection
template<typename T>
void print_fields(const T& obj) {
    // ^^T lifts the type into a std::meta::info value.
    // Member queries take an access context so private members
    // are only visible where the language says they should be.
    constexpr auto ctx = std::meta::access_context::current();
    template for (constexpr auto member :
                  std::meta::nonstatic_data_members_of(^^T, ctx)) {
        std::cout << std::meta::identifier_of(member) << " = "
                  << obj.[:member:] << "\n";
    }
}

// Automatic enum-to-string (the most demanded use case)
template<typename E>
    requires std::is_enum_v<E>
std::string enum_to_string(E value) {
    template for (constexpr auto e : std::meta::enumerators_of(^^E)) {
        if (value == [:e:]) {
            return std::string(std::meta::identifier_of(e));
        }
    }
    return "<unknown>";
}

enum class Color { Red, Green, Blue };

int main() {
    Employee emp{"Alice", 42, 12000000};
    print_fields(emp);
    // Output:
    // name = Alice
    // id = 42
    // salary_cents = 12000000

    std::cout << enum_to_string(Color::Green) << "\n";  // "Green"
    return 0;
}
```

The building blocks: `^^X` produces a `std::meta::info` describing X, the splice syntax `[:refl:]` turns a reflection back into an entity you can use in code, and `template for` (expansion statements, also new in C++26) iterates over reflection query results at compile time.

Reflection will eliminate entire categories of boilerplate: serialization, ORM mapping, enum-to-string, automatic hashing, comparison operators, and more. It is arguably the most impactful C++ feature since templates.

### Contracts

Contracts add preconditions, postconditions, and assertions as language features rather than library macros. P2900 was adopted into C++26.

```cpp
// C++26 (adopted syntax)
#include <cmath>
#include <string>
#include <vector>

class BankAccount {
    // Money is integer minor units (cents), never floating point.
    // This also keeps contract predicates exact: comparing doubles
    // for equality in a postcondition would be meaningless.
    long long balance_cents_ = 0;
public:
    void deposit(long long amount_cents)
        pre(amount_cents > 0)
        post(balance_cents_ >= amount_cents)
    {
        balance_cents_ += amount_cents;
    }

    // Precondition: sufficient funds, positive amount
    void withdraw(long long amount_cents)
        pre(amount_cents > 0)
        pre(amount_cents <= balance_cents_)
        post(balance_cents_ >= 0)
    {
        balance_cents_ -= amount_cents;
    }

    long long balance_cents() const { return balance_cents_; }
};

// Contracts on free functions
int safe_divide(int a, int b)
    pre(b != 0)
    post(r: b == 0 || r * b <= a)  // named result in the postcondition
{
    return a / b;
}

double sqrt_checked(double x)
    pre(x >= 0)
    post(r: r >= 0)
{
    return std::sqrt(x);
}
```

Two things the C++26 MVP deliberately leaves out, because both were planned as future extensions:

1. There is no `old()` operator. A postcondition cannot directly reference the value a variable had on entry, so "balance increased by exactly amount" is not expressible yet. You write the weaker invariant that is expressible, as `deposit` does above.
2. There are no per-assertion checking levels like the `audit` and `axiom` labels from the abandoned C++20 contracts design. Instead, every contract assertion is evaluated under one of four evaluation semantics chosen by the build, not the source: `ignore` (not checked), `observe` (check, report, continue), `enforce` (check, report, terminate), and `quick_enforce` (terminate immediately, minimal code size). Compilers expose this as a flag such as `-fcontracts-semantic=enforce`, so the same source can be fully checked in debug and unchecked in release.

Contracts replace the ad-hoc pattern of `assert()` macros and manual validation, and the build-configurable semantics are exactly what `NDEBUG` never gave you: a supported way to keep checks in production at `observe` level while CI runs `enforce`.

### Pattern Matching

Pattern matching did not make C++26. The `inspect` proposal (P2688) is still under active design and is now targeting a future standard, realistically C++29. The direction is worth knowing because it will eventually replace `std::visit` boilerplate, but the syntax below is a proposal snapshot, not something to learn by heart.

```cpp
// Proposal syntax (P2688, NOT in C++26, may change)
#include <variant>
#include <string>
#include <iostream>

using JsonValue = std::variant<
    std::nullptr_t,
    bool,
    int,
    double,
    std::string
>;

std::string describe(const JsonValue& val) {
    return inspect(val) {
        <std::nullptr_t> _ => "null";
        <bool> b           => b ? "true" : "false";
        <int> i if (i > 0) => std::format("positive int: {}", i);
        <int> i            => std::format("int: {}", i);
        <double> d         => std::format("double: {:.2f}", d);
        <std::string> s    => std::format("string: \"{}\"", s);
    };
}

// Structured pattern matching
struct Point { int x; int y; };

std::string classify(Point p) {
    return inspect(p) {
        [0, 0]       => "origin";
        [0, auto y]  => std::format("y-axis at {}", y);
        [auto x, 0]  => std::format("x-axis at {}", x);
        [auto x, auto y] if (x == y) => "diagonal";
        [auto x, auto y] => std::format("({}, {})", x, y);
    };
}
```

Pattern matching will simplify variant visitors, replace complex `if-else` chains, and make C++ code significantly more expressive when working with algebraic data types, once it lands.

---

### Junior → FAANG: Tracking C++26 Without Getting Distracted

Calibrate your effort to adoption status. Reflection and contracts are standardized: the syntax you learn now is the syntax you will use, even though your day job's compiler probably does not support them yet. Pattern matching is still a proposal: read the one-paragraph summary, understand the problem it solves, and do not memorize syntax that may change.

The highest-value item is reflection. It will change how serialization, ORM, and RPC code is written, and understanding the problem it solves (currently handled with macros, code generators, and `if constexpr` tricks) helps you appreciate why every large codebase will eventually migrate toward it.

### Senior @ FAANG: C++26 and Standards Committee Participation

At the L7/principal level, C++26 features are migration-planning work, not just future reading. Reflection eliminates code generators (protobuf, flatbuffers, Thrift) for many use cases. Contracts formalize the `assert`-based precondition checking that every codebase already does informally, and the evaluation-semantic model means you now own a real decision: which services run `observe` in production and which run `enforce`.

A principal engineer who understands these features can: (1) evaluate compiler readiness and set an adoption timeline per toolchain, (2) submit feedback through WG21 on the planned extensions (the `old()` postcondition operator, reflection-based code generation) while they are still being shaped, (3) plan the migration from current code-generation tools to reflection-based alternatives. This proactive engagement is what distinguishes L7 from L6 in language ecosystem participation.
