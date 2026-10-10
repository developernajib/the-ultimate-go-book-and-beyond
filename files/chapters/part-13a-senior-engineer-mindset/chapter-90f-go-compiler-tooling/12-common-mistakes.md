## 90F.10 Common Mistakes

### 1. Trusting Escape Analysis Without Verification

A common mistake is assuming that a local variable stays on the stack because it is not returned or stored in a field. In practice, passing a value to a function accepting `any`, such as `fmt.Println`, forces an interface boxing that escapes to the heap. The only reliable way to confirm allocation behavior is to run the compiler with `-gcflags="-m"` and verify with benchmark `AllocsPerOp` counts. Mental models alone are not sufficient.

```go
func processKey(key string) string {
    return key
}

// Assumed: this is stack-allocated
func process(key string) {
    result := processKey(key)
    fmt.Println(result) // result may escape due to fmt.Println's any param!
}

// Verify with: go build -gcflags="-m" ./...
// Never assume - measure with benchmarks and allocation counts
```

### 2. Using -gcflags Across All Packages Incorrectly

Passing `-gcflags="-m"` without a package qualifier applies the flag to every package in the build graph, including the standard library. This produces thousands of output lines from packages you do not own and makes it nearly impossible to find the decisions for your own code. Always scope `gcflags` to the specific package under investigation using the `package=-flag` syntax, or use `all=-flag` only when you genuinely need to inspect the entire dependency tree.

```bash
# Wrong: -gcflags="-m" applies to ALL packages including stdlib
# This produces enormous output and may be misinterpreted
go build -gcflags="-m" ./...

# Correct: apply to specific package only
go build -gcflags="yourpackage=-m" ./...
# Or:
go build -gcflags="all=-m" ./... # If you really want all packages
```

### 3. go/analysis Analyzer Missing Required Passes

The `go/analysis` framework resolves analyzer dependencies at runtime by looking up pass results in `pass.ResultOf`. If you access `pass.ResultOf[inspect.Analyzer]` without listing `inspect.Analyzer` in your analyzer's `Requires` slice, the map key will be absent and the type assertion will panic. Every pass that depends on another analyzer's output must declare that dependency explicitly so the framework can schedule passes in the correct order.

```go
package mylinter

import (
    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// Wrong: accessing inspect.Analyzer results without declaring dependency
var BadAnalyzer = &analysis.Analyzer{
    Name: "myanalyzer",
    // Missing: Requires: []*analysis.Analyzer{inspect.Analyzer},
    Run: func(pass *analysis.Pass) (any, error) {
        insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector) // PANIC!
        _ = insp
        return nil, nil
    },
}

// Correct: declare all dependencies
var GoodAnalyzer = &analysis.Analyzer{
    Name:     "myanalyzer",
    Requires: []*analysis.Analyzer{inspect.Analyzer}, // Declare dependency
    Run: func(pass *analysis.Pass) (any, error) {
        insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)
        _ = insp
        return nil, nil
    },
}
```

### 4. Modifying AST Nodes Directly

The AST produced by `go/parser` is an in-memory representation of the source file. Mutating node fields, such as renaming an `ast.Ident`, changes the tree but does not automatically update the source text. To produce modified source, you must serialize the changed tree back to text using `go/format.Node`, which renders the AST into properly formatted Go source that can be written to disk.

```go
package astutils

import (
    "bytes"
    "go/ast"
    "go/format"
    "go/token"
    "os"
)

// Wrong: modifying AST nodes changes the parsed tree but doesn't produce output
func mutateAST(file *ast.File) {
    ast.Inspect(file, func(n ast.Node) bool {
        if ident, ok := n.(*ast.Ident); ok {
            ident.Name = "renamed" // Modifies AST in memory but doesn't rewrite source!
        }
        return true
    })
}

// Correct: use go/format and text edits for source transformation
func saveAST(fset *token.FileSet, modifiedFile *ast.File) error {
    var buf bytes.Buffer
    if err := format.Node(&buf, fset, modifiedFile); err != nil { // Serialize modified AST to source
        return err
    }
    return os.WriteFile("output.go", buf.Bytes(), 0644)
}
```

### 5. Code Generation Without Build Tags

Generated files that lack the standard `// Code generated ... DO NOT EDIT.` header are treated as hand-written source by IDEs, code review tools, and linters, causing reviewers to spend time analyzing machine-generated code and linters to flag style issues in files that should be excluded. The `go` toolchain, `gofmt`, and `gopls` all recognize the exact phrase "Code generated" at the start of a comment on the first or second line and adjust their behavior accordingly.

```go
// Wrong: generated file without "DO NOT EDIT" header
// Reviewers waste time reviewing generated code

// Correct: all generated files should start with:
// Code generated by [tool]. DO NOT EDIT.
// Source: [original source]
// Command: [generation command]

// The standard header that tools like `gofmt` and IDEs recognize:
// "// Code generated ... DO NOT EDIT." (exactly this format)
// This causes IDEs to treat the file as generated and reduce review noise
```

### 6. Using go/ast without go/types for Type Checks

Checking types by inspecting the string name of an `ast.Ident` is fragile: it breaks when users import a package under an alias, define a type alias, or use an unexported type from another package. The `go/types` package resolves these cases correctly because it works with canonical type objects rather than source-level names. Always use `info.TypeOf(expr).Underlying()` with `*types.Basic`, `*types.Named`, or other type structs to write checks that are reliable across all valid Go code.

```go
package typecheck

import (
    "go/ast"
    "go/types"
)

// Wrong: checking type by name string (brittle)
func isIntTypeByName(expr ast.Expr) bool {
    ident, ok := expr.(*ast.Ident)
    return ok && ident.Name == "int" // Misses type aliases, imported types
}

// Correct: use type information
func isIntType(info *types.Info, expr ast.Expr) bool {
    t := info.TypeOf(expr)
    if t == nil {
        return false
    }
    basic, ok := t.Underlying().(*types.Basic)
    return ok && basic.Kind() == types.Int
}
```

### Junior → FAANG: Common Mistakes as an Interview Checklist

Each mistake in this section maps to an interview question an interviewer might use to probe tooling depth. "What is the difference between modifying an AST node and producing modified source?" (mistake 4) separates candidates who have actually used `go/ast` from those who have only read about it. Before your interview, make sure you can explain each mistake in one sentence and name the correct approach.

### Senior @ FAANG: Mistakes as Linting Rule Opportunities

Three of these six mistakes can themselves be detected by a `go/analysis` analyzer: incorrect `Requires` declarations (analyzers that don't declare their dependencies fail non-deterministically under parallel analysis), missing `DO NOT EDIT` headers (AST check on the first file comment), and type-string matching (heuristic detection of `ident.Name == "int"` patterns). At staff level, the instinct to turn recurring mistakes into automated detections is the difference between a team that learns from mistakes individually and one that learns from them once and prevents them permanently.

---
