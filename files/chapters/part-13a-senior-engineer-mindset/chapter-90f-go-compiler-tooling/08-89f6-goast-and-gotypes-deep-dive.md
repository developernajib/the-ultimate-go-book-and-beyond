## 90F.6 go/ast and go/types Deep Dive

### AST Traversal

The `go/ast` package represents a parsed Go source file as a tree of nodes, where each node corresponds to a syntactic construct such as a function declaration, expression, or statement. The primary traversal mechanism is `ast.Inspect`, which performs a depth-first walk and invokes a callback for each node, returning `true` continues into child nodes, returning `false` prunes the subtree. The following example uses this approach to locate all HTTP handler functions by inspecting parameter types of function declarations, demonstrating structural AST pattern matching without type information.

```go
// Walk the AST to find all HTTP handler functions
package main

import (
    "go/ast"
    "go/parser"
    "go/token"
)

func findHTTPHandlers(src string) []string {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, "example.go", src, 0)
    if err != nil {
        panic(err)
    }

    var handlers []string

    ast.Inspect(f, func(n ast.Node) bool {
        // Look for function declarations
        fn, ok := n.(*ast.FuncDecl)
        if !ok {
            return true // Continue traversal
        }

        // Check if function has the signature: func(http.ResponseWriter, *http.Request)
        if fn.Type.Params == nil || len(fn.Type.Params.List) != 2 {
            return true
        }

        params := fn.Type.Params.List
        // Simplified: check param names (real check uses type info)
        if isHTTPHandlerSig(params) {
            handlers = append(handlers, fn.Name.Name)
        }

        return true
    })

    return handlers
}

func isHTTPHandlerSig(params []*ast.Field) bool {
    // This is a simplified check - real implementation uses type info
    // to verify the actual types, not just names
    if len(params) != 2 {
        return false
    }
    // Check if second param is *http.Request
    starExpr, ok := params[1].Type.(*ast.StarExpr)
    if !ok {
        return false
    }
    sel, ok := starExpr.X.(*ast.SelectorExpr)
    if !ok {
        return false
    }
    ident, ok := sel.X.(*ast.Ident)
    return ok && ident.Name == "http" && sel.Sel.Name == "Request"
}
```

### go/types: Type Information

Structural AST matching is fragile, it breaks when users rename imports or use type aliases. The `go/types` package provides fully resolved type information, allowing you to check the canonical package path and type name rather than relying on string matching of identifier names. By passing a populated `types.Info` struct to `conf.Check`, you gain access to the type of every expression and the declaration of every identifier, enabling reliable cross-package analysis that handles aliasing, embedding, and interface satisfaction correctly.

```go
// Using go/types for type-aware analysis
package authfinder

import (
    "go/ast"
    "go/importer"
    "go/parser"
    "go/token"
    "go/types"
    "strings"
)

// FindHTTPHandlersMissingAuth finds HTTP handlers not wrapped in auth middleware
func FindHTTPHandlersMissingAuth(pkgDir string) ([]string, error) {
    fset := token.NewFileSet()
    pkgs, err := parser.ParseDir(fset, pkgDir, nil, 0)
    if err != nil {
        return nil, err
    }

    var files []*ast.File
    for _, pkg := range pkgs {
        for _, f := range pkg.Files {
            files = append(files, f)
        }
    }

    conf := types.Config{
        Importer: importer.ForCompiler(fset, "gc", nil),
    }
    info := &types.Info{
        Types: make(map[ast.Expr]types.TypeAndValue),
        Uses:  make(map[*ast.Ident]types.Object),
        Defs:  make(map[*ast.Ident]types.Object),
    }

    _, err = conf.Check(".", fset, files, info)
    if err != nil {
        return nil, err
    }

    var missingAuth []string

    for ident, obj := range info.Defs {
        fn, ok := obj.(*types.Func)
        if !ok {
            continue
        }

        sig, ok := fn.Type().(*types.Signature)
        if !ok {
            continue
        }

        // Check if function has http.Handler signature
        if !isHTTPHandlerSignature(sig) {
            continue
        }

        // Check if function name indicates it's a handler (heuristic)
        if strings.HasSuffix(ident.Name, "Handler") || strings.HasSuffix(ident.Name, "Handle") {
            // Check if any call sites wrap it with auth
            // (simplified - real implementation traverses call graph)
            missingAuth = append(missingAuth, ident.Name)
        }
    }

    return missingAuth, nil
}

func isHTTPHandlerSignature(sig *types.Signature) bool {
    params := sig.Params()
    if params.Len() != 2 {
        return false
    }

    // First param: http.ResponseWriter (interface)
    firstParam := params.At(0).Type()
    firstNamed, ok := firstParam.(*types.Named)
    if !ok {
        return false
    }
    if firstNamed.Obj().Pkg().Path() != "net/http" {
        return false
    }
    if firstNamed.Obj().Name() != "ResponseWriter" {
        return false
    }

    // Second param: *http.Request (pointer to struct)
    secondParam := params.At(1).Type()
    ptr, ok := secondParam.(*types.Pointer)
    if !ok {
        return false
    }
    named, ok := ptr.Elem().(*types.Named)
    if !ok {
        return false
    }
    return named.Obj().Pkg().Path() == "net/http" && named.Obj().Name() == "Request"
}
```

### Scope Analysis

Variable shadowing is a common source of subtle bugs in Go, particularly in error-handling code where `:=` in an inner scope silently shadows an outer `err` variable. The `go/types` package tracks each variable's parent scope through `obj.Parent()`, which makes it possible to detect shadowing by building a map from variable names to their scope chain and checking whether any name appears in multiple nested scopes. The following analyzer flags these cases with both the outer and inner declaration positions, giving developers precise location information to audit.

```go
// Analyze variable scoping to find unintentional shadowing
package shadowfinder

import (
    "fmt"
    "go/token"
    "go/types"
)

type ShadowedVar struct {
    Name     string
    Outer    token.Pos
    Inner    token.Pos
    File     string
}

func FindShadows(info *types.Info, fset *token.FileSet) []ShadowedVar {
    var shadows []ShadowedVar

    // Map from variable name → stack of scopes where it's defined
    type scopeEntry struct {
        obj types.Object
    }
    varsByName := make(map[string][]scopeEntry)

    for ident, obj := range info.Defs {
        if obj == nil || obj.Parent() == nil {
            continue
        }

        name := ident.Name
        if name == "_" {
            continue
        }

        // Check if any outer scope already has this variable
        if previous, ok := varsByName[name]; ok {
            for _, prev := range previous {
                // Check if outer scope encloses inner scope
                if prev.obj.Parent() != obj.Parent() {
                    shadows = append(shadows, ShadowedVar{
                        Name:  name,
                        Outer: prev.obj.Pos(),
                        Inner: obj.Pos(),
                        File:  fset.Position(obj.Pos()).Filename,
                    })
                    fmt.Printf("Shadow: %s at %v shadows %v\n",
                        name,
                        fset.Position(obj.Pos()),
                        fset.Position(prev.obj.Pos()),
                    )
                }
            }
        }

        varsByName[name] = append(varsByName[name], scopeEntry{obj: obj})
    }

    return shadows
}
```

### Junior → FAANG: AST and Types as a Tooling Foundation

Most junior engineers interact with ASTs only through IDE tooling and never directly. Understanding that `go/ast` gives structural shape while `go/types` gives resolved semantic information is the key conceptual distinction. In an interview, "I used `go/types` to distinguish a function that returns an HTTP handler from one that merely has the same signature shape" demonstrates that you understand why the type system matters for analysis, not just the AST structure.

### Senior @ FAANG: Type-Aware Analysis as a Correctness Guarantee

At L6, the difference between AST-based and type-aware analysis is a correctness question, not just a sophistication one. An AST-based check that looks for `ioutil.ReadFile` will miss cases where the function is assigned to a variable and called through the variable. A type-aware check using `go/types.Uses` finds every call regardless of how the function is referenced. For a correctness-critical linter (security, auth, data access), the type-aware approach is not optional.

The scope analysis / shadowing checker is a concrete example of where type information prevents false negatives. A string-matching approach would miss shadowing across package imports. The `types.Object.Parent()` approach catches all cases regardless of naming or import style. At staff level, choosing the right analysis layer for each class of bug is part of the tool design, and the choice should be documented so maintainers understand why the implementation is more complex than a regexp.

---
