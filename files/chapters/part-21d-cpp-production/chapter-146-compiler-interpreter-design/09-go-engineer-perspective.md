## The Go Engineer's Perspective

Go ships a complete compiler toolkit in its standard library and extended packages. Everything built in this chapter has a direct Go equivalent, and in many cases, you do not need to build it from scratch because the Go toolchain exposes its own internals.

### Concept Mapping Table

| Compiler concept | C++ (this chapter) | Go package / tool |
|------------------|--------------------|-------------------|
| Lexer / scanner | `Lexer` class, `string_view` | `go/scanner`, `text/scanner` |
| Token types | `enum class TokenKind` | `go/token.Token` |
| Parser | `Parser` class, recursive descent | `go/parser.ParseFile()` |
| AST nodes | `std::variant<NumberExpr, ...>` | `go/ast.Expr`, `go/ast.Stmt` (interfaces) |
| AST walker | `std::visit` + `PrettyPrinter` | `go/ast.Inspect()`, `go/ast.Walk()` |
| Type checker | `TypeChecker`, `SymbolTable` | `go/types.Check()`, `types.Info` |
| SSA IR | LLVM IR, `IRBuilder<>` | `golang.org/x/tools/go/ssa` |
| LLVM backend | LLVM C++ API | TinyGo (`tinygo.org`) |
| Tree-walking interpreter | `Interpreter` class | `github.com/traefik/yaegi` |
| Optimization passes | LLVM `PassBuilder` | `go/analysis` framework |
| Linter / static analysis | Clang-Tidy custom check | `go/analysis` + `staticcheck` |

### Using Go's Built-In Tooling

#### Parsing Go Source

Go's `go/parser` package parses a source string directly to an `*ast.File` using `parser.ParseFile` with a `token.FileSet` that tracks source positions for error reporting. The resulting AST is inspectable with `ast.Inspect`, which walks the tree and calls a visitor function on each node, a built-in capability that takes three lines to set up versus the multi-file infrastructure needed for the equivalent operation with LLVM's AST APIs.
```go
package main

import (
    "go/parser"
    "go/token"
    "go/ast"
    "fmt"
)

func main() {
    src := `package main

func fib(n int) int {
    if n <= 1 { return n }
    return fib(n-1) + fib(n-2)
}
`
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, "fib.go", src, parser.AllErrors)
    if err != nil {
        panic(err)
    }

    // Walk every identifier in the AST
    ast.Inspect(f, func(n ast.Node) bool {
        if id, ok := n.(*ast.Ident); ok {
            pos := fset.Position(id.Pos())
            fmt.Printf("%s: %s\n", pos, id.Name)
        }
        return true
    })
}
```

This is the equivalent of building a `Lexer` + `Parser` + `PrettyPrinter` in C++, all in 30 lines.

#### Type-Checking Go Source

Go's `go/types` package type-checks a parsed AST against a resolved import graph using `types.Config.Check`, which populates a `types.Info` struct with the resolved type of every expression in the file. This capability, querying `info.TypeOf(expr)` for any node in the AST, is what tools like `staticcheck`, `gopls`, and `go vet` use internally to perform semantic analysis without running the compiler's full pipeline.
```go
package main

import (
    "go/importer"
    "go/parser"
    "go/token"
    "go/types"
    "fmt"
)

func type_check_example() {
    src := `package p; func add(a, b int) int { return a + b }`

    fset := token.NewFileSet()
    f, _ := parser.ParseFile(fset, "p.go", src, 0)

    conf := types.Config{Importer: importer.Default()}
    info := &types.Info{
        Types: make(map[ast.Expr]types.TypeAndValue),
        Defs:  make(map[*ast.Ident]types.Object),
        Uses:  make(map[*ast.Ident]types.Object),
    }
    pkg, err := conf.Check("p", fset, []*ast.File{f}, info)
    if err != nil {
        fmt.Println("type error:", err)
        return
    }
    fmt.Println("package:", pkg.Name())

    // Every expression now has an inferred type in info.Types
    for expr, tv := range info.Types {
        fmt.Printf("  expr: %v  type: %v\n", expr, tv.Type)
    }
}
```

The `types.Info` struct is the annotated AST, exactly what the `TypeChecker` in section 05 produces.

### Writing Language Tools in Go

The `go/analysis` framework is Go's analogue of LLVM's pass framework. An `analysis.Analyzer` defines a single check that can be composed with others:

```go
package unusedvars

import (
    "go/ast"
    "go/types"
    "golang.org/x/tools/go/analysis"
)

var Analyzer = &analysis.Analyzer{
    Name: "unusedvars",
    Doc:  "reports unused variables",
    Run:  run,
}

func run(pass *analysis.Pass) (interface{}, error) {
    for _, file := range pass.Files {
        ast.Inspect(file, func(n ast.Node) bool {
            id, ok := n.(*ast.Ident)
            if !ok { return true }
            obj := pass.TypesInfo.Uses[id]
            if obj == nil { return true }
            if v, ok := obj.(*types.Var); ok && !v.Used() {
                pass.Reportf(id.Pos(), "variable %s declared but not used", id.Name)
            }
            return true
        })
    }
    return nil, nil
}
```

`staticcheck`, `golangci-lint`, and `gopls` are all built on this framework. `clang-tidy` custom checks use the LLVM pass framework shown in section 07.

### Writing Language Tools in C++

Clang provides `clang-tidy` with a plugin API for custom checks. The entry point is a `clang::ast_matchers::MatchFinder`, a pattern-matching system over Clang's AST:

```cpp
// clang-tidy custom check: warn on raw new/delete
#include "clang/ASTMatchers/ASTMatchFinder.h"
#include "clang/ASTMatchers/ASTMatchers.h"
#include "clang-tidy/ClangTidy.h"
#include "clang-tidy/ClangTidyCheck.h"

using namespace clang;
using namespace clang::ast_matchers;

class NoRawNewCheck : public tidy::ClangTidyCheck {
public:
    NoRawNewCheck(StringRef name, tidy::ClangTidyContext* ctx)
        : ClangTidyCheck(name, ctx) {}

    void registerMatchers(MatchFinder* finder) override {
        finder->addMatcher(
            cxxNewExpr().bind("newexpr"),
            this
        );
    }

    void check(const MatchFinder::MatchResult& result) override {
        if (const auto* expr = result.Nodes.getNodeAs<CXXNewExpr>("newexpr")) {
            diag(expr->getBeginLoc(),
                 "prefer std::make_unique over raw new");
        }
    }
};
```

This is structurally identical to the `go/analysis.Analyzer` above: register a pattern, receive matches, emit diagnostics.

### When to Use Go vs C++ for Compiler Work

| Scenario | Recommendation |
|----------|---------------|
| Language tooling for Go code (linters, formatters, IDEs) | Go, `go/ast` + `go/types` + `go/analysis` |
| A small DSL embedded in a Go application | Go, `go/parser` or a hand-rolled recursive descent parser |
| A standalone language runtime targeting native code | C++, LLVM API, full control over memory and codegen |
| Extending Clang or the LLVM toolchain | C++, it is the only interface |
| A JIT for a hot-path expression language in a server | C++ with LLVM OrcJIT, or Cranelift via Go/CGo |
| A bytecode VM for scripting in a game or embedded system | C++ for performance. Go is viable for moderate throughput |

The go-to rule: use Go for tools that analyze Go programs. Use C++ when you need LLVM-quality code generation or the lowest possible overhead in a language runtime.

---
