## Type Checking and Semantic Analysis

Syntactic correctness is not enough. `let x = true + "hello";` parses without error but is meaningless. The type checker walks the AST and verifies that every operation is applied to the right kinds of values, every variable is declared before use, every function is called with the right number and types of arguments, and every branch of an `if` returns a consistent type.

### Type Representation

Calc has three base types: `Number` (a 64-bit float), `Bool`, and `Void` (the type of a `return` statement with no value, or an empty block). Functions carry their parameter types and return type.

```cpp
#include <memory>
#include <variant>
#include <string>
#include <unordered_map>
#include <vector>
#include <optional>
#include <sstream>
#include <stdexcept>

struct NumberType {};
struct BoolType   {};
struct VoidType   {};
struct FnType;

using Type = std::variant<NumberType, BoolType, VoidType, std::shared_ptr<FnType>>;

struct FnType {
    std::vector<Type> params;
    Type              return_type;
};

// Type equality
bool types_equal(const Type& a, const Type& b) {
    if (a.index() != b.index()) return false;
    // For functions, check param and return types recursively
    if (auto* fa = std::get_if<std::shared_ptr<FnType>>(&a)) {
        auto* fb = std::get_if<std::shared_ptr<FnType>>(&b);
        if (!fb) return false;
        if ((*fa)->params.size() != (*fb)->params.size()) return false;
        for (size_t i = 0; i < (*fa)->params.size(); ++i)
            if (!types_equal((*fa)->params[i], (*fb)->params[i])) return false;
        return types_equal((*fa)->return_type, (*fb)->return_type);
    }
    return true;
}

std::string type_name(const Type& t) {
    return std::visit([](const auto& v) -> std::string {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, NumberType>) return "Number";
        if constexpr (std::is_same_v<T, BoolType>)   return "Bool";
        if constexpr (std::is_same_v<T, VoidType>)   return "Void";
        if constexpr (std::is_same_v<T, std::shared_ptr<FnType>>)
            return "Fn(...)";
        return "?";
    }, t);
}
```

### Symbol Table with Scope Stack

Each variable binding lives in a scope. Entering a block (`{`) pushes a new scope. Leaving a block pops it. Variable lookup walks from the innermost to the outermost scope.

```cpp
class SymbolTable {
    // Each scope maps variable name → its type
    std::vector<std::unordered_map<std::string, Type>> scopes_;

public:
    SymbolTable() { push_scope(); }  // global scope

    void push_scope() { scopes_.emplace_back(); }
    void pop_scope()  { scopes_.pop_back(); }

    void define(const std::string& name, const Type& type) {
        scopes_.back()[name] = type;
    }

    // Returns nullopt if name is not in any scope
    std::optional<Type> lookup(const std::string& name) const {
        for (auto it = scopes_.rbegin(); it != scopes_.rend(); ++it) {
            auto found = it->find(name);
            if (found != it->end()) return found->second;
        }
        return std::nullopt;
    }

    bool defined_in_current_scope(const std::string& name) const {
        return scopes_.back().count(name) > 0;
    }
};
```

### Type Checker

The type checker walks the AST with `std::visit`. It returns the inferred type of each expression, and accumulates errors rather than throwing on the first one, so the user sees all errors in one compilation pass.

```cpp
struct TypeError {
    std::string message;
    int line, col;
};

class TypeChecker {
    SymbolTable            symbols_;
    std::vector<TypeError> errors_;
    // Current expected return type (for checking return statements)
    std::optional<Type>    current_return_type_;

    void error(const std::string& msg, int line = 0, int col = 0) {
        errors_.push_back(TypeError{msg, line, col});
    }

    void expect_type(const Type& got, const Type& want, const std::string& ctx,
                     int line = 0, int col = 0)
    {
        if (!types_equal(got, want)) {
            error("type mismatch in " + ctx + ": expected " + type_name(want)
                  + ", got " + type_name(got), line, col);
        }
    }

public:
    // Returns the type of this expression
    Type check_expr(const Expr& e) {
        return std::visit([this](const auto& node) -> Type {
            return check_node(node);
        }, e);
    }

    Type check_node(const NumberExpr&) {
        return NumberType{};
    }

    Type check_node(const IdentExpr& id) {
        auto t = symbols_.lookup(id.name);
        if (!t) {
            error("undefined variable '" + id.name + "'", id.line, id.col);
            return VoidType{};  // error recovery: assume void
        }
        return *t;
    }

    Type check_node(const BinaryExpr& b) {
        Type lhs_t = check_expr(*b.lhs);
        Type rhs_t = check_expr(*b.rhs);

        if (b.op == "+" || b.op == "-" || b.op == "*" || b.op == "/") {
            expect_type(lhs_t, NumberType{}, "left operand of " + b.op);
            expect_type(rhs_t, NumberType{}, "right operand of " + b.op);
            return NumberType{};
        }
        if (b.op == "==" || b.op == "!=" ||
            b.op == "<"  || b.op == ">"  ||
            b.op == "<=" || b.op == ">=")
        {
            if (!types_equal(lhs_t, rhs_t)) {
                error("comparison between incompatible types: "
                      + type_name(lhs_t) + " and " + type_name(rhs_t));
            }
            return BoolType{};
        }
        error("unknown binary operator '" + b.op + "'");
        return VoidType{};
    }

    Type check_node(const UnaryExpr& u) {
        Type t = check_expr(*u.operand);
        if (u.op == "-") {
            expect_type(t, NumberType{}, "operand of unary '-'");
            return NumberType{};
        }
        error("unknown unary operator '" + u.op + "'");
        return VoidType{};
    }

    Type check_node(const IfExpr& ie) {
        Type cond_t = check_expr(*ie.cond);
        expect_type(cond_t, BoolType{}, "if condition");

        // Check then branch in a new scope
        symbols_.push_scope();
        Type then_t = check_stmts(ie.then_body);
        symbols_.pop_scope();

        if (ie.else_body.empty()) {
            // No else: result is Void
            return VoidType{};
        }

        symbols_.push_scope();
        Type else_t = check_stmts(ie.else_body);
        symbols_.pop_scope();

        if (!types_equal(then_t, else_t)) {
            error("if/else branches have different types: "
                  + type_name(then_t) + " vs " + type_name(else_t));
        }
        return then_t;
    }

    Type check_node(const FnExpr& fn) {
        // Build a function type: all params are Number by default
        // A real compiler would have type annotations - Calc infers Number
        auto fn_type = std::make_shared<FnType>();
        for (size_t i = 0; i < fn.params.size(); ++i)
            fn_type->params.push_back(NumberType{});

        symbols_.push_scope();
        for (const auto& p : fn.params)
            symbols_.define(p, NumberType{});

        // Infer return type from body
        Type ret = check_stmts(fn.body);
        fn_type->return_type = ret;
        symbols_.pop_scope();

        return std::shared_ptr<FnType>(fn_type);
    }

    Type check_node(const FnCall& fc) {
        auto t = symbols_.lookup(fc.callee);
        if (!t) {
            error("undefined function '" + fc.callee + "'", fc.line, fc.col);
            return VoidType{};
        }
        auto* fn_t = std::get_if<std::shared_ptr<FnType>>(&*t);
        if (!fn_t) {
            error("'" + fc.callee + "' is not a function", fc.line, fc.col);
            return VoidType{};
        }
        if (fc.args.size() != (*fn_t)->params.size()) {
            error("wrong number of arguments for '" + fc.callee + "': expected "
                  + std::to_string((*fn_t)->params.size())
                  + ", got " + std::to_string(fc.args.size()),
                  fc.line, fc.col);
        }
        for (size_t i = 0; i < std::min(fc.args.size(), (*fn_t)->params.size()); ++i) {
            Type arg_t = check_expr(*fc.args[i]);
            expect_type(arg_t, (*fn_t)->params[i],
                        "argument " + std::to_string(i+1) + " of " + fc.callee);
        }
        return (*fn_t)->return_type;
    }

    Type check_node(const AssignExpr& a) {
        auto existing = symbols_.lookup(a.name);
        if (!existing) {
            error("assignment to undeclared variable '" + a.name + "'");
            return VoidType{};
        }
        Type val_t = check_expr(*a.value);
        expect_type(val_t, *existing, "assignment to '" + a.name + "'");
        return val_t;
    }

    // Check a list of statements - returns the type of the last expression
    Type check_stmts(const StmtList& stmts) {
        Type last = VoidType{};
        for (const auto& s : stmts) {
            last = check_stmt(*s);
        }
        return last;
    }

    Type check_stmt(const Stmt& s) {
        return std::visit([this](const auto& node) -> Type {
            return check_stmt_node(node);
        }, s);
    }

    Type check_stmt_node(const LetStmt& ls) {
        if (symbols_.defined_in_current_scope(ls.name)) {
            error("redefinition of '" + ls.name + "'", ls.line, ls.col);
        }
        Type t = check_expr(*ls.value);
        symbols_.define(ls.name, t);
        return VoidType{};
    }

    Type check_stmt_node(const ReturnStmt& rs) {
        Type t = check_expr(*rs.value);
        if (current_return_type_) {
            expect_type(t, *current_return_type_, "return statement");
        }
        return t;
    }

    Type check_stmt_node(const ExprStmt& es) {
        return check_expr(*es.expr);
    }

    Type check_stmt_node(const BlockStmt& bs) {
        symbols_.push_scope();
        Type t = check_stmts(bs.stmts);
        symbols_.pop_scope();
        return t;
    }

    const std::vector<TypeError>& errors() const { return errors_; }
    bool has_errors() const { return !errors_.empty(); }
};
```

### Reporting Errors

`report_type_errors` iterates the type checker's error list and formats each diagnostic with line and column numbers, matching the `file:line:col: message` convention that editors and CI tools parse to link diagnostics back to source locations. Accumulating all type errors before reporting, rather than throwing on the first error, gives users a complete picture of what needs to be fixed in a single compile cycle.
```cpp
void report_type_errors(const TypeChecker& tc) {
    for (const auto& e : tc.errors()) {
        std::cerr << "type error[" << e.line << ":" << e.col << "]: "
                  << e.message << "\n";
    }
}
```

### Go Comparison

Go's `go/types` package is a full-blown type checker for the Go language. It uses `types.Config` and `types.Check()` to type-check a package. The `types.Info` struct carries per-expression type annotations, resolved references, and inferred types for all identifiers, exactly what the `TypeChecker` above builds. The `golang.org/x/tools/go/ssa` package then transforms the typed AST into SSA form, analogous to what section 07 does with LLVM IR.

---
