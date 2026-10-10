## Abstract Syntax Trees

The parser produces an AST: a tree where each node represents a language construct with irrelevant syntax stripped away (parentheses, semicolons, commas). The AST is the canonical representation of the program's meaning. Every subsequent stage, type checking, optimization, code generation, operates on the AST.

### AST Node Design: `std::variant` vs. Virtual Dispatch

Two approaches dominate AST design in C++:

**Virtual dispatch** (OOP style): a base `Expr` class with virtual `accept()` or `eval()`. Used by old compilers and JVM. Downsides: heap allocation per node, pointer indirection on every access, no exhaustiveness checking (the compiler does not tell you when you forget a case), vtable overhead.

**`std::variant`** (algebraic sum type): `std::variant<NumberExpr, IdentExpr, BinaryExpr, ...>`. Visited with `std::visit`. Advantages: exhaustiveness enforcement (compiler warns on missing cases with `-Wswitch`), data locality, no per-node vtable, pattern-matching style code. This is the approach used by modern C++ compilers and matches Rust's `enum`, Haskell's ADT, and Go's `interface{}` + type switch.

### Complete AST Definition

The AST uses `std::variant` to represent both expression and statement kinds without a virtual base class, which avoids vtable overhead and enables exhaustive `std::visit` dispatch at compile time. `ExprPtr = std::unique_ptr<Expr>` and `StmtPtr = std::unique_ptr<Stmt>` carry ownership semantics through the tree. Forward declarations of the struct variants allow recursive node types like `BinaryExpr` to hold `ExprPtr` children before the variant type is fully defined.
```cpp
#include <memory>
#include <variant>
#include <vector>
#include <string>
#include <optional>

// Forward-declare Expr and Stmt so recursive nodes can hold ExprPtr/StmtPtr
struct NumberExpr;
struct IdentExpr;
struct BinaryExpr;
struct UnaryExpr;
struct IfExpr;
struct FnExpr;
struct FnCall;
struct AssignExpr;

// Expression: a construct that produces a value
using Expr = std::variant<
    NumberExpr,
    IdentExpr,
    BinaryExpr,
    UnaryExpr,
    IfExpr,
    FnExpr,
    FnCall,
    AssignExpr
>;
using ExprPtr = std::unique_ptr<Expr>;

struct NumberExpr {
    double value;
    // Source position for error messages
    int line = 0, col = 0;
};

struct IdentExpr {
    std::string name;
    int line = 0, col = 0;
};

struct BinaryExpr {
    std::string op;           // "+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">="
    ExprPtr     lhs;
    ExprPtr     rhs;
};

struct UnaryExpr {
    std::string op;           // "-"
    ExprPtr     operand;
};

// Forward declarations for statement types
struct LetStmt;
struct ReturnStmt;
struct ExprStmt;
struct BlockStmt;

using Stmt    = std::variant<LetStmt, ReturnStmt, ExprStmt, BlockStmt>;
using StmtPtr = std::unique_ptr<Stmt>;
using StmtList = std::vector<StmtPtr>;

struct IfExpr {
    ExprPtr   cond;
    StmtList  then_body;
    StmtList  else_body;     // empty if no else branch
};

struct FnExpr {
    std::vector<std::string> params;
    StmtList                 body;
};

struct FnCall {
    std::string          callee;
    std::vector<ExprPtr> args;
    int line = 0, col = 0;
};

struct AssignExpr {
    std::string name;
    ExprPtr     value;
};

// Statement types
struct LetStmt {
    std::string name;
    ExprPtr     value;
    int line = 0, col = 0;
};

struct ReturnStmt {
    ExprPtr value;
};

struct ExprStmt {
    ExprPtr expr;
};

struct BlockStmt {
    StmtList stmts;
};
```

### Why `unique_ptr` for Recursive Nodes

`Expr` contains `BinaryExpr` which contains two `ExprPtr`s which are `unique_ptr<Expr>`. This is the standard way to make recursive sum types work in C++: the recursion is broken by pointer indirection. The `unique_ptr` also communicates ownership clearly, the parent node owns its children.

An alternative: use `std::vector` of nodes stored in an arena allocator and refer to children by index. This gives better cache locality and avoids heap fragmentation. Clang uses exactly this approach with its `ASTContext` memory pool.

### AST Pretty Printer

Visiting the entire tree with `std::visit` gives exhaustiveness, if you add a new node type and forget to handle it in the printer, the compiler emits an error.

```cpp
#include <iostream>
#include <string>

struct PrettyPrinter {
    std::ostream& out;
    int           indent = 0;

    void print_indent() {
        for (int i = 0; i < indent; ++i) out << "  ";
    }

    void print(const Expr& e) {
        std::visit(*this, e);
    }

    void print(const Stmt& s) {
        std::visit(*this, s);
    }

    void print_stmts(const StmtList& stmts) {
        ++indent;
        for (const auto& s : stmts) print(*s);
        --indent;
    }

    // --- Expr visitors ---

    void operator()(const NumberExpr& n) {
        print_indent();
        out << "Number(" << n.value << ")\n";
    }

    void operator()(const IdentExpr& id) {
        print_indent();
        out << "Ident(" << id.name << ")\n";
    }

    void operator()(const BinaryExpr& b) {
        print_indent();
        out << "Binary(" << b.op << ")\n";
        ++indent;
        print(*b.lhs);
        print(*b.rhs);
        --indent;
    }

    void operator()(const UnaryExpr& u) {
        print_indent();
        out << "Unary(" << u.op << ")\n";
        ++indent;
        print(*u.operand);
        --indent;
    }

    void operator()(const IfExpr& ie) {
        print_indent();
        out << "If\n";
        ++indent;
        print_indent(); out << "Cond:\n";
        ++indent; print(*ie.cond); --indent;
        print_indent(); out << "Then:\n";
        print_stmts(ie.then_body);
        if (!ie.else_body.empty()) {
            print_indent(); out << "Else:\n";
            print_stmts(ie.else_body);
        }
        --indent;
    }

    void operator()(const FnExpr& fn) {
        print_indent();
        out << "Fn(";
        for (size_t i = 0; i < fn.params.size(); ++i) {
            if (i) out << ", ";
            out << fn.params[i];
        }
        out << ")\n";
        print_stmts(fn.body);
    }

    void operator()(const FnCall& fc) {
        print_indent();
        out << "Call(" << fc.callee << ")\n";
        ++indent;
        for (const auto& arg : fc.args) print(*arg);
        --indent;
    }

    void operator()(const AssignExpr& a) {
        print_indent();
        out << "Assign(" << a.name << ")\n";
        ++indent;
        print(*a.value);
        --indent;
    }

    // --- Stmt visitors ---

    void operator()(const LetStmt& ls) {
        print_indent();
        out << "Let(" << ls.name << ")\n";
        ++indent;
        print(*ls.value);
        --indent;
    }

    void operator()(const ReturnStmt& rs) {
        print_indent();
        out << "Return\n";
        ++indent;
        print(*rs.value);
        --indent;
    }

    void operator()(const ExprStmt& es) {
        print(*es.expr);
    }

    void operator()(const BlockStmt& bs) {
        print_indent();
        out << "Block\n";
        print_stmts(bs.stmts);
    }
};

// Example: print AST for "let x = 1 + 2 * 3;"
void demo_pretty_printer() {
    // Build the AST manually for illustration
    // BinaryExpr("*", 2, 3)
    auto mul = std::make_unique<Expr>(BinaryExpr{
        "*",
        std::make_unique<Expr>(NumberExpr{2}),
        std::make_unique<Expr>(NumberExpr{3})
    });
    // BinaryExpr("+", 1, mul)
    auto add = std::make_unique<Expr>(BinaryExpr{
        "+",
        std::make_unique<Expr>(NumberExpr{1}),
        std::move(mul)
    });
    // LetStmt("x", add)
    auto stmt = std::make_unique<Stmt>(LetStmt{"x", std::move(add)});

    PrettyPrinter pp{std::cout};
    pp.print(*stmt);
    // Output:
    // Let(x)
    //   Binary(+)
    //     Number(1)
    //     Binary(*)
    //       Number(2)
    //       Number(3)
}
```

### Go Comparison

Go's `go/ast` package uses interface-based nodes: `ast.Expr`, `ast.Stmt`, `ast.Decl` are interfaces. Concrete types like `*ast.BinaryExpr`, `*ast.CallExpr`, `*ast.Ident` implement them. Visitors use a type switch:

```go
switch e := node.(type) {
case *ast.BinaryExpr:
    // e.Op, e.X, e.Y
case *ast.Ident:
    // e.Name
}
```

The downside vs. C++ `std::variant`: Go's type switch is not exhaustive, the compiler does not warn if you forget a case. Tools like `staticcheck` add exhaustiveness checking as a lint rule. The `go/ast` `Inspect` function provides a generic tree-walk callback:

```go
ast.Inspect(f, func(n ast.Node) bool {
    if id, ok := n.(*ast.Ident); ok {
        fmt.Println(id.Name)
    }
    return true // continue walking
})
```

The equivalent in C++ with `std::visit` is more verbose but gives compile-time guarantees.

---
