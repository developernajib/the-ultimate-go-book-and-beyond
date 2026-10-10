## Visitor with std::variant and std::visit

The classic Visitor pattern, double dispatch through a virtual `accept(Visitor&)` on every node type, is one of the most verbose patterns in OOP C++. Adding a new visitor requires no changes to node types. Adding a new node type requires updating every visitor. `std::variant` inverts the trade-off and adds exhaustiveness checking at compile time.

### The Problem with Classic Visitor

The classic OOP visitor requires every node type to declare `accept(Visitor&)` and every visitor to declare a `visit` overload for each node type, creating a tight coupling that forces recompilation of the entire hierarchy when either dimension changes. The code below shows how this double-dispatch boilerplate accumulates even for a trivial expression tree with just three node types.
```cpp
// Classic OOP Visitor: boilerplate-heavy, double dispatch via vtables
struct Expr;
struct NumberExpr;
struct AddExpr;
struct MulExpr;

struct ExprVisitor {
    virtual ~ExprVisitor() = default;
    virtual void visit(const NumberExpr&) = 0;
    virtual void visit(const AddExpr&)    = 0;
    virtual void visit(const MulExpr&)    = 0;
    // Adding BinaryExpr later requires updating ALL visitors -- fragile
};

struct Expr {
    virtual void accept(ExprVisitor&) const = 0;
    virtual ~Expr() = default;
};

struct NumberExpr : Expr {
    double value;
    void accept(ExprVisitor& v) const override { v.visit(*this); }
};
// ... multiply boilerplate for each node type ...
```

Every node type needs `accept()`. Every visitor needs a `visit()` overload for every node. The compiler will not tell you if you missed a case unless you implement the pure virtual correctly.

### std::variant: Type-Safe Tagged Union

`std::variant<A, B, C>` is a type-safe union that holds exactly one of its alternative types at a time. The active type is tracked internally. Unlike `union`, it properly constructs and destructs the active member.

```cpp
#include <variant>
#include <string>

std::variant<int, double, std::string> v = 42;
v = 3.14;
v = std::string("hello");

// Index-based check
std::size_t idx = v.index();  // 2 (string is at index 2)

// Type-based check
if (std::holds_alternative<std::string>(v)) {
    const auto& s = std::get<std::string>(v);  // Safe
}

// std::get throws std::bad_variant_access on type mismatch
// std::get_if returns pointer or nullptr -- preferred for conditional access
if (auto* p = std::get_if<double>(&v)) {
    // use *p
}
```

### The "Overload" Trick for Inline Visitors

The key to ergonomic `std::visit` is the `overload` helper, which composes multiple lambdas into a single callable with multiple `operator()` overloads:

```cpp
// Overload: combine multiple lambdas into one object with all their operator()s
template <typename... Ts>
struct overload : Ts... {
    using Ts::operator()...;
};

// C++17 deduction guide (not needed in C++20)
template <typename... Ts>
overload(Ts...) -> overload<Ts...>;
```

This is one of the shortest and most useful utilities in modern C++. Two lines. No macros.

### Full Example: AST with Variant Visitor

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```cpp
#include <variant>
#include <memory>
#include <string>
#include <stdexcept>
#include <cmath>

// Forward declaration for recursive variant
struct Expr;

struct NumberExpr {
    double value;
};

struct VariableExpr {
    std::string name;
};

struct AddExpr {
    std::unique_ptr<Expr> left;
    std::unique_ptr<Expr> right;
};

struct MulExpr {
    std::unique_ptr<Expr> left;
    std::unique_ptr<Expr> right;
};

struct NegateExpr {
    std::unique_ptr<Expr> operand;
};

// The variant holds the complete set of node types.
// Adding a new type here breaks all std::visit calls that don't handle it.
// This is the intentional trade-off: easy to add visitors, hard to add types.
using ExprVariant = std::variant<
    NumberExpr,
    VariableExpr,
    AddExpr,
    MulExpr,
    NegateExpr
>;

struct Expr {
    ExprVariant data;
};

// Evaluator: a visitor implemented as a set of lambdas
struct Environment {
    double lookup(const std::string& name) const {
        if (name == "pi") return 3.14159265358979;
        throw std::runtime_error("undefined variable: " + name);
    }
};

double evaluate(const Expr& expr, const Environment& env) {
    return std::visit(overload{
        [](const NumberExpr& n) -> double {
            return n.value;
        },
        [&env](const VariableExpr& v) -> double {
            return env.lookup(v.name);
        },
        [&env](const AddExpr& a) -> double {
            return evaluate(*a.left, env) + evaluate(*a.right, env);
        },
        [&env](const MulExpr& m) -> double {
            return evaluate(*m.left, env) * evaluate(*m.right, env);
        },
        [&env](const NegateExpr& n) -> double {
            return -evaluate(*n.operand, env);
        }
    }, expr.data);
}

// Pretty-printer: a second visitor, adding no changes to Expr types
std::string to_string(const Expr& expr) {
    return std::visit(overload{
        [](const NumberExpr& n)    { return std::to_string(n.value); },
        [](const VariableExpr& v)  { return v.name; },
        [](const AddExpr& a)       {
            return "(" + to_string(*a.left) + " + " + to_string(*a.right) + ")";
        },
        [](const MulExpr& m)       {
            return "(" + to_string(*m.left) + " * " + to_string(*m.right) + ")";
        },
        [](const NegateExpr& n)    {
            return "-" + to_string(*n.operand);
        }
    }, expr.data);
}
```

Adding a new visitor (`evaluate`, `to_string`, a type-checker) requires no changes to `Expr`. Adding a new node type to `ExprVariant` causes compilation errors at every visitor that doesn't handle it, exhaustiveness checking for free.

### if constexpr in Visitors

For visitors where most cases share logic but a few require special treatment, `if constexpr` avoids duplicating the lambda:

```cpp
// Single lambda that dispatches at compile time based on type
auto size_visitor = []<typename T>(const T& node) -> std::size_t {
    if constexpr (std::is_same_v<T, NumberExpr> || std::is_same_v<T, VariableExpr>) {
        return 1;
    } else if constexpr (std::is_same_v<T, NegateExpr>) {
        return 1 + size(*node.operand);
    } else {
        // AddExpr, MulExpr -- binary nodes
        return 1 + size(*node.left) + size(*node.right);
    }
};
```

### Go Comparison: Type Switches

Go's type switches are the closest equivalent:

```go
func evaluate(expr Expr, env Environment) float64 {
    switch e := expr.(type) {
    case NumberExpr:
        return e.Value
    case VariableExpr:
        return env.Lookup(e.Name)
    case AddExpr:
        return evaluate(e.Left, env) + evaluate(e.Right, env)
    // Missing a case? No compile error in Go -- silent default behavior
    default:
        panic("unknown expr type")
    }
}
```

The critical difference: Go's type switch does not enforce exhaustiveness. If you add a new `Expr` implementation and forget to add a case, you get a runtime panic, not a compile error. `std::variant` + `std::visit` fails at compile time if any alternative is unhandled (unless you provide a default lambda).

---
