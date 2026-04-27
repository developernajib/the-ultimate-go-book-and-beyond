export default `## 7B.5 Writing Static Analysis Tools

The \`golang.org/x/tools/go/analysis\` framework provides a structured way to write linters and analysis passes. Each analyzer declares its name, documentation, dependencies on other analyzers, and a \`Run\` function that receives a \`*analysis.Pass\` containing the parsed files, type information, and a reporting function. This is the same framework that powers \`go vet\` and tools like \`staticcheck\`, so anything you build plugs directly into the existing ecosystem.

The following analyzer checks for unchecked errors, meaning function calls whose error return value is silently discarded. It uses the \`inspect\` pass to efficiently filter for expression statements (where return values are thrown away), then checks whether the called function returns an \`error\`.

\`\`\`go
package errcheck

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
)

// Analyzer checks for unchecked errors from function calls
var Analyzer = &analysis.Analyzer{
	Name: "errcheck",
	Doc:  "checks for unchecked errors from function calls",
	Run:  run,
	Requires: []*analysis.Analyzer{
		inspect.Analyzer,
	},
}

func run(pass *analysis.Pass) (any, error) {
	insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

	// Only visit expression statements (where return values are discarded)
	nodeFilter := []ast.Node{
		(*ast.ExprStmt)(nil),
	}

	insp.Preorder(nodeFilter, func(n ast.Node) {
		exprStmt := n.(*ast.ExprStmt)

		// Check if it's a function call
		call, ok := exprStmt.X.(*ast.CallExpr)
		if !ok {
			return
		}

		// Get the function's return type
		sig, ok := pass.TypesInfo.TypeOf(call.Fun).(*types.Signature)
		if !ok {
			return
		}

		// Check if any return value is an error
		results := sig.Results()
		for i := 0; i < results.Len(); i++ {
			if isErrorType(results.At(i).Type()) {
				pass.Reportf(call.Pos(), "unchecked error from call to %v", call.Fun)
				return
			}
		}
	})

	return nil, nil
}

func isErrorType(t types.Type) bool {
	named, ok := t.(*types.Named)
	if !ok {
		return false
	}
	return named.Obj().Name() == "error" && named.Obj().Pkg() == nil
}
\`\`\`

### Structured Analyzer with Facts

The analysis framework supports "facts," which are pieces of information that one analyzer can export and another can import. Facts allow cross-package analysis: for example, one pass can mark a type as immutable, and a later pass in a different package can check whether code tries to mutate that type. Facts are serialized and cached alongside the package's analysis results, so they work efficiently even in large codebases. The example below demonstrates marking types with an \`//immutable\` comment and then detecting assignments to their fields.

\`\`\`go
package immutable

import (
	"go/ast"
	"go/types"

	"golang.org/x/tools/go/analysis"
)

// ImmutableFact marks a type as immutable
type ImmutableFact struct{}

func (*ImmutableFact) AFact() {}
func (*ImmutableFact) String() string { return "immutable" }

var Analyzer = &analysis.Analyzer{
	Name:      "immutable",
	Doc:       "checks that immutable types are not mutated",
	Run:       run,
	FactTypes: []analysis.Fact{(*ImmutableFact)(nil)},
}

func run(pass *analysis.Pass) (any, error) {
	// Export facts for types annotated with //immutable comment
	for _, file := range pass.Files {
		for _, decl := range file.Decls {
			genDecl, ok := decl.(*ast.GenDecl)
			if !ok {
				continue
			}
			for _, spec := range genDecl.Specs {
				typeSpec, ok := spec.(*ast.TypeSpec)
				if !ok {
					continue
				}
				if hasImmutableComment(genDecl.Doc) {
					obj := pass.TypesInfo.Defs[typeSpec.Name]
					if obj != nil {
						pass.ExportObjectFact(obj, &ImmutableFact{})
					}
				}
			}
		}
	}

	// Check that immutable types are not assigned to
	for _, file := range pass.Files {
		ast.Inspect(file, func(n ast.Node) bool {
			assign, ok := n.(*ast.AssignStmt)
			if !ok {
				return true
			}
			for _, lhs := range assign.Lhs {
				if sel, ok := lhs.(*ast.SelectorExpr); ok {
					xType := pass.TypesInfo.TypeOf(sel.X)
					if xType == nil {
						continue
					}
					named := getNamedType(xType)
					if named == nil {
						continue
					}
					obj := named.Obj()
					var fact ImmutableFact
					if pass.ImportObjectFact(obj, &fact) {
						pass.Reportf(assign.Pos(),
							"assignment to field of immutable type %s", named.Obj().Name())
					}
				}
			}
			return true
		})
	}

	return nil, nil
}

func hasImmutableComment(doc *ast.CommentGroup) bool {
	if doc == nil {
		return false
	}
	for _, comment := range doc.List {
		if comment.Text == "//immutable" {
			return true
		}
	}
	return false
}

func getNamedType(t types.Type) *types.Named {
	switch t := t.(type) {
	case *types.Named:
		return t
	case *types.Pointer:
		return getNamedType(t.Elem())
	}
	return nil
}
\`\`\`

### Running Analyzers

Once you have written one or more analyzers, you need a \`main\` function to wire them together and run them against your codebase. The \`multichecker\` package makes this easy: you pass your analyzers to \`multichecker.Main\`, and it handles command-line flags, package loading, and result reporting for you. You can then build this into a standalone binary and invoke it on your project just like \`go vet\`. For a single analyzer, \`singlechecker\` provides an even simpler entry point.

\`\`\`go
package main

import (
	"golang.org/x/tools/go/analysis/multichecker"

	"myproject/internal/analysis/errcheck"
	"myproject/internal/analysis/immutable"
)

func main() {
	multichecker.Main(
		errcheck.Analyzer,
		immutable.Analyzer,
	)
}
\`\`\`

\`\`\`bash
# Build and run
go build -o mylinter ./cmd/mylinter
./mylinter ./...

# Or use singlechecker for a single analyzer
go run golang.org/x/tools/go/analysis/singlechecker ./...
\`\`\`

### Rolling Out a New Lint Rule Without Revolt

For a senior engineer proposing a new team-wide lint rule, the rollout sequence matters:

1. **Start as a warning in CI, not a blocker.** Let engineers see the rule fire on their PRs without blocking merges. Collect data on the failure rate.
2. **Fix existing violations before enforcement.** Scan the codebase, file a single large PR that fixes all current violations, get it merged. Then flip the CI rule to blocking.
3. **Document the rule with a before-and-after example.** Engineers need to know why, not just what. The doc is the artifact that survives team turnover.
4. **Be prepared to reverse.** If the rule produces false positives at a rate engineers find unacceptable, loosen or remove it. A bad lint rule wastes more time than it saves.

The senior-track discipline is "one new lint rule per quarter, with full rollout". More than that and the team feels the friction. Fewer and the tooling does not compound.

---
`;
