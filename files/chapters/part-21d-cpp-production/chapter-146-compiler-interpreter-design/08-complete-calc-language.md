## Putting It All Together: The Complete Calc Language

Each stage up to this point has been a standalone component. Now we wire them into a single pipeline. The `Compiler` class owns the stages, propagates errors between them, and exposes a single `compile_and_run` entry point.

### Pipeline Architecture

The Calc compiler pipeline is a linear sequence of transformation stages: source string to token vector (Lexer), token vector to AST (Parser), AST to typed AST (TypeChecker), typed AST to LLVM IR (CodeGen). Each stage is a separate class that owns no persistent state across compilations, making the pipeline reusable for a REPL by simply re-running all stages on each input line.
```
Source (std::string)
     │
     ▼
  Lexer                   → std::vector<Token>
     │
     ▼
  Parser                  → StmtList (AST)
     │
     ▼
  TypeChecker             → annotated AST + error list
     │
     ▼
  Interpreter / Codegen   → Value / LLVM Module
```

### Error Propagation with `std::expected`

C++23 introduces `std::expected<T, E>`, a value that is either a result or an error, like Rust's `Result<T, E>`. Under C++17/20, a simple equivalent:

```cpp
#include <variant>
#include <string>
#include <vector>

template<typename T>
struct Result {
    std::variant<T, std::string> data;

    static Result ok(T v)              { return Result{std::variant<T,std::string>(std::in_place_index<0>, std::move(v))}; }
    static Result err(std::string msg) { return Result{std::variant<T,std::string>(std::in_place_index<1>, std::move(msg))}; }

    bool     is_ok()  const { return data.index() == 0; }
    bool     is_err() const { return data.index() == 1; }
    const T& value()  const { return std::get<0>(data); }
    T&       value()        { return std::get<0>(data); }
    const std::string& error() const { return std::get<1>(data); }
};

using ValueResult = Result<Value>;  // Value from section 06
```

### The Compiler Class

`CalcCompiler` stores the source string as a member because `Lexer` holds a `std::string_view` into it, the source must outlive all tokens. The `compile()` method runs the full pipeline and returns LLVM IR as a string, capturing diagnostics from each stage and returning an error string if any stage fails rather than throwing exceptions across the pipeline boundary.
```cpp
#include <string>
#include <sstream>
#include <iostream>

class CalcCompiler {
    // All stages share the source string (tokens hold string_views into it)
    std::string source_;

public:
    struct RunResult {
        bool                     success;
        Value                    value;           // if success
        std::vector<std::string> errors;          // if !success
    };

    RunResult compile_and_run(std::string source) {
        source_ = std::move(source);
        RunResult result;
        result.success = false;

        // Stage 1: Lex
        Lexer lexer(source_);
        std::vector<Token> tokens;
        try {
            tokens = lexer.tokenize();
        } catch (const std::exception& e) {
            result.errors.push_back(std::string("lex error: ") + e.what());
            return result;
        }

        // Check for Error tokens
        for (const auto& tok : tokens) {
            if (tok.kind == TokenKind::Error) {
                result.errors.push_back(
                    "lex error[" + std::to_string(tok.line) + ":" +
                    std::to_string(tok.col) + "]: unexpected character '" +
                    std::string(tok.text) + "'"
                );
            }
        }
        if (!result.errors.empty()) return result;

        // Stage 2: Parse
        Parser parser(std::move(tokens));
        StmtList ast;
        try {
            ast = parser.parse_program();
        } catch (const ParseError& e) {
            result.errors.push_back(e.what());
            return result;
        }

        // Stage 3: Type check
        TypeChecker checker;
        checker.check_stmts(ast);
        if (checker.has_errors()) {
            for (const auto& e : checker.errors()) {
                result.errors.push_back(
                    "type error[" + std::to_string(e.line) + ":" +
                    std::to_string(e.col) + "]: " + e.message
                );
            }
            return result;
        }

        // Stage 4: Interpret
        Interpreter interp;
        try {
            Value last = double(0);
            for (const auto& s : ast) {
                interp.exec_stmt(*s);
            }
            // The last expression statement's value is the program result
            // Re-evaluate the last expression if it's an ExprStmt
            if (!ast.empty()) {
                if (auto* es = std::get_if<ExprStmt>(ast.back().get())) {
                    last = interp.eval(*es->expr);
                }
            }
            result.success = true;
            result.value   = last;
        } catch (const std::exception& e) {
            result.errors.push_back(std::string("runtime error: ") + e.what());
        }
        return result;
    }
};
```

### Running a Complete Calc Program

The Fibonacci demo uses a recursive function definition and verifies that the compiler correctly handles mutual recursion, integer arithmetic, and early return through `if/return` statements. Compiling and evaluating `fib(10)` end-to-end is the standard integration test for a new language implementation because it exercises the full stack: closures, conditional branches, recursive function calls, and return value propagation.
```cpp
void demo_fib() {
    CalcCompiler compiler;

    std::string program = R"(
        let fib = fn(n) {
            if n <= 1 { return n; }
            return fib(n - 1) + fib(n - 2);
        };
        fib(10)
    )";

    auto result = compiler.compile_and_run(program);

    if (result.success) {
        if (auto* d = std::get_if<double>(&result.value)) {
            std::cout << "fib(10) = " << *d << "\n";  // → 55
        }
    } else {
        for (const auto& e : result.errors) {
            std::cerr << e << "\n";
        }
    }
}
```

### A Simple REPL

The REPL loops over `std::getline` calls, compiles each line through `CalcCompiler::compile`, and prints either the resulting LLVM IR or the compilation error. Because `CalcCompiler` is stateless across calls, each REPL line is compiled in isolation, adding persistent variable scope across REPL entries would require accumulating definitions and recompiling the growing program on each new line.
```cpp
void run_repl() {
    CalcCompiler compiler;
    std::string  line;
    std::cout << "Calc REPL (Ctrl+D to exit)\n";

    while (true) {
        std::cout << "> ";
        if (!std::getline(std::cin, line)) break;
        if (line.empty()) continue;

        auto result = compiler.compile_and_run(line);
        if (result.success) {
            std::visit([](const auto& v) {
                using T = std::decay_t<decltype(v)>;
                if constexpr (std::is_same_v<T, double>)
                    std::cout << v << "\n";
                else if constexpr (std::is_same_v<T, bool>)
                    std::cout << (v ? "true" : "false") << "\n";
                else
                    std::cout << "<fn>\n";
            }, result.value);
        } else {
            for (const auto& e : result.errors) std::cerr << e << "\n";
        }
    }
}
```

### What's Missing from a Production Compiler

| Feature | Complexity | Notes |
|---------|-----------|-------|
| Garbage collection | Very high | Tracing GC, reference counting, or Boehm GC |
| Closures (captured variables) | High | Upvalue lifting, heap-allocated environments |
| Modules and imports | High | Dependency graph, separate compilation |
| Generics / parametric types | Very high | Hindley-Milner, constraint solving |
| Tail-call optimization | Medium | Detect self-tail-calls, convert to loop |
| Strings, arrays, structs | Medium | Memory management, layout, GC roots |
| Error recovery in parser | Medium | Synchronize and continue after errors |
| Incremental compilation | Very high | Dependency tracking, cache invalidation |

### How to Extend Calc

**Adding strings**: add `StringExpr` to the AST, a `StringType` to the type system, and a `std::string` branch to `Value`. The lexer needs to handle `"..."` with escape sequences.

**Adding arrays**: add `ArrayLiteral`, `IndexExpr`, and a `ArrayType(element_type)`. The interpreter stores arrays as `std::vector<Value>`.

**Adding structs**: add `StructDef` (a named list of field name/type pairs), `FieldAccess`, and `StructLiteral`. The type checker maintains a struct registry.

### Go Comparison

Go's own compiler pipeline (`cmd/compile`) mirrors this chapter exactly:

1. `src/cmd/compile/internal/syntax`, lexer and parser
2. `src/cmd/compile/internal/typecheck`, type checker and name resolver
3. `src/cmd/compile/internal/noder`, AST → internal IR conversion
4. `src/cmd/compile/internal/ssa`, SSA construction and optimization passes
5. `src/cmd/compile/internal/amd64` (and other arch packages), code generation

The Go compiler is written in Go and is roughly 100,000 lines. The Calc compiler above is roughly 700 lines and covers every stage at a conceptual level. The gap between them is mostly features, error handling, and performance engineering, the architectural blueprint is the same.

---
