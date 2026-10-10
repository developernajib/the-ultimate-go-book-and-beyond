## 90F.5 Writing Go Tools with go/analysis

### The Analysis Framework

`go/analysis` is the framework powering `go vet` and most third-party linters. It provides: type-checked AST access, multi-pass analysis with facts, suggested fix generation, and parallel analysis.

```go
// Minimal analyzer: find all calls to fmt.Println with more than 3 arguments
package printlimit

import (
    "go/ast"
    "go/types"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

var Analyzer = &analysis.Analyzer{
    Name: "printlimit",
    Doc:  "check that fmt.Println calls have at most 3 arguments",
    Requires: []*analysis.Analyzer{
        inspect.Analyzer, // Pre-computed AST inspector
    },
    Run: run,
}

func run(pass *analysis.Pass) (any, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    // Filter to only call expressions
    nodeFilter := []ast.Node{
        (*ast.CallExpr)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        call := n.(*ast.CallExpr)

        // Check if this is a call to fmt.Println
        sel, ok := call.Fun.(*ast.SelectorExpr)
        if !ok {
            return
        }

        // Use type information to identify the package
        obj := pass.TypesInfo.Uses[sel.Sel]
        if obj == nil {
            return
        }

        fn, ok := obj.(*types.Func)
        if !ok {
            return
        }

        // Check package path (not name - avoids false positives from renamed imports)
        pkg := fn.Pkg()
        if pkg == nil || pkg.Path() != "fmt" {
            return
        }

        if fn.Name() != "Println" {
            return
        }

        if len(call.Args) > 3 {
            pass.Reportf(call.Pos(),
                "fmt.Println called with %d arguments (max 3 allowed); consider using fmt.Printf or splitting the call",
                len(call.Args),
            )
        }
    })

    return nil, nil
}
```

### Analyzer with Facts

Facts allow analyzers to communicate results across package boundaries. An analyzer can export facts about packages it analyzes, and other analyzers can import them.

```go
// Analyzer that checks: HTTP handlers must be authenticated
// Uses a Fact to mark which functions are "auth middleware"

package authrequired

import (
    "go/ast"
    "go/types"
    "strings"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// IsAuthMiddleware is a fact exported by this analyzer
// Marks a function as an authentication middleware
type IsAuthMiddleware struct{}
func (*IsAuthMiddleware) AFact() {}
func (*IsAuthMiddleware) String() string { return "is auth middleware" }

var Analyzer = &analysis.Analyzer{
    Name:      "authrequired",
    Doc:       "check that all HTTP handlers are wrapped with authentication middleware",
    Requires:  []*analysis.Analyzer{inspect.Analyzer},
    FactTypes: []analysis.Fact{(*IsAuthMiddleware)(nil)},
    Run:       run,
}

func run(pass *analysis.Pass) (any, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    // Find functions that contain "Auth" in name or have the auth comment
    // Mark them as auth middleware (export fact)
    insp.Preorder([]ast.Node{(*ast.FuncDecl)(nil)}, func(n ast.Node) {
        fn := n.(*ast.FuncDecl)
        if fn.Name != nil && strings.Contains(fn.Name.Name, "Auth") {
            obj := pass.TypesInfo.Defs[fn.Name]
            if obj != nil {
                pass.ExportObjectFact(obj, &IsAuthMiddleware{})
            }
        }
    })

    // Find http.HandleFunc calls and check if handler is wrapped in auth middleware
    insp.Preorder([]ast.Node{(*ast.CallExpr)(nil)}, func(n ast.Node) {
        call := n.(*ast.CallExpr)

        // Check if this is http.HandleFunc or http.Handle
        if !isHTTPRegister(pass, call) {
            return
        }

        // Get the handler argument (second arg for HandleFunc)
        if len(call.Args) < 2 {
            return
        }

        handler := call.Args[1]

        // Check if handler is a call that wraps with auth
        handlerCall, ok := handler.(*ast.CallExpr)
        if !ok {
            pass.Reportf(call.Pos(), "HTTP handler should be wrapped with authentication middleware")
            return
        }

        // Check if the wrapping function is an auth middleware
        fn := pass.TypesInfo.Uses[getFuncIdent(handlerCall)]
        if fn == nil {
            return
        }

        var fact IsAuthMiddleware
        if !pass.ImportObjectFact(fn, &fact) {
            pass.Reportf(call.Pos(),
                "HTTP handler '%s' is not wrapped with authentication middleware",
                fn.Name(),
            )
        }
    })

    return nil, nil
}

func isHTTPRegister(pass *analysis.Pass, call *ast.CallExpr) bool {
    sel, ok := call.Fun.(*ast.SelectorExpr)
    if !ok {
        return false
    }
    obj := pass.TypesInfo.Uses[sel.Sel]
    if obj == nil {
        return false
    }
    fn, ok := obj.(*types.Func)
    if !ok {
        return false
    }
    return fn.Pkg() != nil &&
        fn.Pkg().Path() == "net/http" &&
        (fn.Name() == "HandleFunc" || fn.Name() == "Handle")
}

func getFuncIdent(call *ast.CallExpr) *ast.Ident {
    switch f := call.Fun.(type) {
    case *ast.Ident:
        return f
    case *ast.SelectorExpr:
        return f.Sel
    }
    return nil
}
```

### Analyzer with Suggested Fixes

An analyzer can go beyond reporting diagnostics by providing machine-applicable `SuggestedFix` entries. When the fix is unambiguous, such as replacing a deprecated API with its modern equivalent, attaching a suggested fix allows tools like `gopls` and `go fix` to apply the correction automatically. The `ioutil` deprecation is an ideal case: the replacement mapping is 1-to-1 and the edit is a simple token substitution, making this a safe automatic fix with zero semantic risk.

```go
// Analyzer that suggests fixes: replace deprecated ioutil.ReadFile with os.ReadFile
package ioutilfix

import (
    "fmt"
    "go/ast"
    "go/types"
    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

var Analyzer = &analysis.Analyzer{
    Name:     "ioutilfix",
    Doc:      "replace deprecated ioutil functions with their os/io equivalents",
    Requires: []*analysis.Analyzer{inspect.Analyzer},
    Run:      run,
}

var replacements = map[string]string{
    "ioutil.ReadFile":  "os.ReadFile",
    "ioutil.WriteFile": "os.WriteFile",
    "ioutil.ReadDir":   "os.ReadDir",
    "ioutil.ReadAll":   "io.ReadAll",
    "ioutil.Discard":   "io.Discard",
}

func run(pass *analysis.Pass) (any, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    insp.Preorder([]ast.Node{(*ast.SelectorExpr)(nil)}, func(n ast.Node) {
        sel := n.(*ast.SelectorExpr)

        ident, ok := sel.X.(*ast.Ident)
        if !ok || ident.Name != "ioutil" {
            return
        }

        obj := pass.TypesInfo.Uses[ident]
        if obj == nil {
            return
        }
        pkg, ok := obj.(*types.PkgName)
        if !ok || pkg.Imported().Path() != "io/ioutil" {
            return
        }

        fullName := "ioutil." + sel.Sel.Name
        replacement, ok := replacements[fullName]
        if !ok {
            return
        }

        // Report with suggested fix
        pass.Report(analysis.Diagnostic{
            Pos:     sel.Pos(),
            Message: fmt.Sprintf("%s is deprecated, use %s instead", fullName, replacement),
            SuggestedFixes: []analysis.SuggestedFix{
                {
                    Message: fmt.Sprintf("Replace with %s", replacement),
                    TextEdits: []analysis.TextEdit{
                        {
                            Pos:     sel.Pos(),
                            End:     sel.End(),
                            NewText: []byte(replacement),
                        },
                    },
                },
            },
        })
    })

    return nil, nil
}
```

### Running Custom Analyzers with go vet

The `multichecker` package from `golang.org/x/tools` is the standard way to bundle multiple analyzers into a single executable that integrates with `go vet` and `golangci-lint`. Building a standalone binary makes it easy to run your custom linters in CI pipelines alongside the standard vet checks. Once published, the linter can be referenced by `golangci-lint` using the `--vettool` flag, giving you first-class integration with the rest of your toolchain.

```go
// cmd/myvet/main.go - standalone linter binary
package main

import (
    "golang.org/x/tools/go/analysis/multichecker"
    "yourmodule/linters/authrequired"
    "yourmodule/linters/ioutilfix"
    "yourmodule/linters/printlimit"
)

func main() {
    multichecker.Main(
        authrequired.Analyzer,
        ioutilfix.Analyzer,
        printlimit.Analyzer,
    )
}

// Usage:
// go build -o myvet ./cmd/myvet
// ./myvet ./...
// Or via go vet:
// go vet -vettool=./myvet ./...

// In CI:
// golangci-lint run --no-config --disable-all --enable=myvet ./...
```

### Junior → FAANG: Static Analysis as a First Interview Signal

Building even a simple `go/analysis` analyzer demonstrates that you understand Go tooling at a depth most engineers never reach. For a junior candidate, "I built a custom linter that detects X pattern and integrated it with `go vet`" is a concrete technical achievement that stands out. The auth-middleware checker pattern in this section is a realistic example you can implement in a weekend and describe in an interview.

The key interview point is the `facts` system: an analyzer can propagate information across package boundaries, which is what distinguishes a production-grade linter from a simple AST grep. Understanding why facts exist and when you need them separates candidates who have read the API from those who have used it.

### Senior @ FAANG: Analyzer Governance at Organizational Scale

At L6, the governance question for a custom analyzer is as important as the implementation. Who maintains it? How is it versioned? What happens when a Go upgrade changes the AST structure it depends on? How do false positives get reported and suppressed without the suppression mechanism itself becoming unmaintained? These questions should be answered in the ADR before the analyzer is merged into your org's linter suite.

The suggested-fixes pattern deserves special attention at staff level. An analyzer with auto-fix capability reduces the review-and-fix cycle from days to seconds for mechanical changes. At FAANG scale (hundreds of engineers, thousands of files), an auto-fix analyzer for a deprecated API can migrate an entire codebase in a CI run. This is the kind of leverage that shows up in a principal engineer promotion packet as "eliminated a class of API misuse across the entire platform."

---
