export default `## 7B.4 Type Checking with go/types

The type checker resolves identifiers, checks type compatibility, and infers types. Where the parser produces a syntax tree that only knows about structure, the type checker adds semantic meaning: it determines that \`x\` is an \`int\`, that a function call's arguments match the parameter types, and that a method receiver satisfies an interface. The \`go/types\` package exposes this same analysis to your own programs, giving you the ability to build tools that reason about code meaning rather than just code shape.

The following example parses a small Go source file, runs the type checker, and prints every definition it finds along with the resolved type. The \`types.Info\` struct is the central output of type-checking, and its maps connect AST nodes to their types, definitions, and usages.

\`\`\`go
package main

import (
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
)

func typeCheckPackage(src string) (*types.Package, *types.Info, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "example.go", src, 0)
	if err != nil {
		return nil, nil, err
	}

	info := &types.Info{
		Types:      make(map[ast.Expr]types.TypeAndValue),
		Defs:       make(map[*ast.Ident]types.Object),
		Uses:       make(map[*ast.Ident]types.Object),
		Implicits:  make(map[ast.Node]types.Object),
		Selections: make(map[*ast.SelectorExpr]*types.Selection),
		Scopes:     make(map[ast.Node]*types.Scope),
	}

	conf := types.Config{
		Importer: importer.Default(),
	}

	pkg, err := conf.Check("example", fset, []*ast.File{f}, info)
	if err != nil {
		return nil, nil, err
	}

	return pkg, info, nil
}

func main() {
	src := \`package example

import "fmt"

const Pi = 3.14159

func Area(r float64) float64 {
	return Pi * r * r
}

func main() {
	fmt.Println(Area(5.0))
}
\`
	pkg, info, err := typeCheckPackage(src)
	if err != nil {
		fmt.Println("Error:", err)
		return
	}

	fmt.Println("Package:", pkg.Name())
	fmt.Println("Scope:", pkg.Scope())

	// Print all definitions
	for ident, obj := range info.Defs {
		if obj != nil {
			fmt.Printf("Def: %s → %T: %s\\n", ident.Name, obj, obj.Type())
		}
	}
}
\`\`\`

### Type Traversal and Inspection

The \`go/types\` package gives you access to the full type information of a Go program after type-checking is complete. You can traverse package scopes to find all named types, inspect struct fields and their tags, check whether a type implements a particular interface, and build human-readable type signatures. This is essential for writing tools that need to understand the meaning of code, not just its syntax. The example below shows how to find exported struct fields that are missing JSON tags and how to check interface implementations.

\`\`\`go
package analysis

import (
	"fmt"
	"go/types"
	"strings"
)

// StructFieldAnalyzer analyzes struct types for JSON tags
type StructFieldAnalyzer struct {
	pkg *types.Package
}

func (a *StructFieldAnalyzer) FindUntaggedFields() []string {
	var issues []string

	scope := a.pkg.Scope()
	for _, name := range scope.Names() {
		obj := scope.Lookup(name)
		typeName, ok := obj.(*types.TypeName)
		if !ok {
			continue
		}

		structType, ok := typeName.Type().Underlying().(*types.Struct)
		if !ok {
			continue
		}

		for i := 0; i < structType.NumFields(); i++ {
			field := structType.Field(i)
			tag := structType.Tag(i)

			if field.Exported() && !strings.Contains(tag, "json:") {
				issues = append(issues, fmt.Sprintf(
					"%s.%s: exported field missing json tag",
					typeName.Name(), field.Name(),
				))
			}
		}
	}
	return issues
}

// InterfaceImplementationChecker verifies type implements interface
func ImplementsInterface(t types.Type, iface *types.Interface) bool {
	return types.Implements(t, iface) || types.Implements(types.NewPointer(t), iface)
}

// TypeSignature returns a human-readable type signature
func TypeSignature(t types.Type) string {
	switch t := t.(type) {
	case *types.Basic:
		return t.Name()
	case *types.Slice:
		return "[]" + TypeSignature(t.Elem())
	case *types.Map:
		return "map[" + TypeSignature(t.Key()) + "]" + TypeSignature(t.Elem())
	case *types.Pointer:
		return "*" + TypeSignature(t.Elem())
	case *types.Named:
		return t.Obj().Name()
	case *types.Interface:
		return "interface{...}"
	case *types.Struct:
		return "struct{...}"
	case *types.Signature:
		return "func(...)"
	default:
		return t.String()
	}
}
\`\`\`

### Type-Aware Analysis Is the High-Leverage Discipline

Most custom linters written by Go teams start syntactic (walk the AST looking for patterns). The high-leverage tools are type-aware (use \`go/types\` to resolve identifiers, match concrete types, understand interface satisfaction). Three examples:

1. **Detecting concrete types passed to \`any\` parameters in hot paths.** Requires knowing the parameter type, which requires \`go/types\`.
2. **Finding callers of a deprecated function.** Requires resolving the identifier at the call site to the specific function being called.
3. **Enforcing architectural invariants (no package X imports package Y).** Straightforward with \`types.Package\` information.

Invest the time to understand \`go/types\`. The tools it enables are qualitatively more valuable than syntactic-only linters.

---
`;
