export default `## 7B.6 SSA: Static Single Assignment Form

SSA is a compiler intermediate representation where every variable is assigned exactly once. When a variable is updated, SSA creates a new version of it rather than overwriting the old one. This makes data flow explicit: you can trace exactly which definition reaches which use without ambiguity. The Go compiler converts its internal IR to SSA form before running optimization passes, and the \`golang.org/x/tools/go/ssa\` package exposes this representation for external analysis tools.

The example below parses a Go source file, type-checks it, and builds an SSA representation. It then walks through every function, printing the basic blocks and instructions that the compiler would operate on.

\`\`\`go
package main

import (
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/ssa"
)

func buildSSA(src string) (*ssa.Package, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "example.go", src, 0)
	if err != nil {
		return nil, err
	}

	// Type check
	info := &types.Info{
		Types: make(map[ast.Expr]types.TypeAndValue),
		Defs:  make(map[*ast.Ident]types.Object),
		Uses:  make(map[*ast.Ident]types.Object),
	}
	conf := types.Config{Importer: importer.Default()}
	pkg, err := conf.Check("example", fset, []*ast.File{f}, info)
	if err != nil {
		return nil, err
	}

	// Build SSA
	prog := ssa.NewProgram(fset, ssa.PrintPackages)
	ssaPkg := prog.CreatePackage(pkg, []*ast.File{f}, info, true)
	prog.Build()

	return ssaPkg, nil
}

func analyzeSSA(pkg *ssa.Package) {
	for _, member := range pkg.Members {
		fn, ok := member.(*ssa.Function)
		if !ok {
			continue
		}
		fmt.Printf("Function: %s\\n", fn.Name())
		for _, block := range fn.Blocks {
			fmt.Printf("  Block %d:\\n", block.Index)
			for _, instr := range block.Instrs {
				fmt.Printf("    %T: %v\\n", instr, instr)
			}
		}
	}
}
\`\`\`

### SSA Instructions

SSA represents code as a sequence of typed instructions. Each instruction produces at most one value, and every value is assigned exactly once, which makes data flow analysis straightforward. The instructions cover control flow (jumps, branches, returns), data operations (arithmetic, memory loads and stores, slice and map creation), function calls (including goroutine starts and defers), and type operations (conversions, type assertions). Understanding these instruction types helps you interpret SSA output and write analyses that reason about what your code actually does at the compiler level. Key instruction types:

\`\`\`go
// Control flow
*ssa.Jump        // unconditional branch
*ssa.If          // conditional branch
*ssa.Return      // function return
*ssa.Panic       // panic

// Data operations
*ssa.BinOp       // binary operation (a + b, a < b, ...)
*ssa.UnOp        // unary operation (!x, -x, *p, <-ch)
*ssa.Phi         // SSA φ-node: merges values from multiple predecessors
*ssa.Alloc       // heap/stack allocation
*ssa.Store       // memory store
*ssa.MakeSlice   // make([]T, n, m)
*ssa.MakeMap     // make(map[K]V)
*ssa.MakeChan    // make(chan T, n)
*ssa.MakeClosure // closure creation
*ssa.FieldAddr   // &s.f
*ssa.Field       // s.f (value)
*ssa.IndexAddr   // &s[i]
*ssa.Index       // s[i] (value)

// Calls
*ssa.Call        // function call
*ssa.Go          // goroutine start (go f())
*ssa.Defer       // defer f()
*ssa.Send        // ch <- v
*ssa.Select      // select statement

// Type operations
*ssa.Convert     // T(x)
*ssa.ChangeType  // type assertion (compile-time)
*ssa.TypeAssert  // x.(T)
*ssa.Slice       // s[a:b:c]
*ssa.Extract     // tuple element extraction
\`\`\`

### Callgraph Analysis

A call graph shows which functions call which other functions in your program. This is invaluable for understanding code dependencies, finding dead code, and tracing how data flows through your application. The \`golang.org/x/tools/go/callgraph\` package builds call graphs from SSA form using different algorithms: Rapid Type Analysis (RTA) is fast and works well for most programs, while pointer analysis is more precise but slower. The example below builds a call graph using RTA and prints it as an indented tree.

\`\`\`go
package main

import (
	"fmt"
	"strings"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/rta"
	"golang.org/x/tools/go/ssa"
)

// BuildCallGraph builds a call graph using Rapid Type Analysis
func BuildCallGraph(pkg *ssa.Package) *callgraph.Graph {
	// Find main function
	main := pkg.Func("main")
	if main == nil {
		return nil
	}

	// RTA is fast; CHA or pointer analysis is more precise
	result := rta.Analyze([]*ssa.Function{main}, true)
	return result.CallGraph
}

func PrintCallGraph(cg *callgraph.Graph, maxDepth int) {
	var visit func(node *callgraph.Node, depth int)
	visited := make(map[*callgraph.Node]bool)

	visit = func(node *callgraph.Node, depth int) {
		if depth > maxDepth || visited[node] {
			return
		}
		visited[node] = true

		indent := strings.Repeat("  ", depth)
		fmt.Printf("%s%s\\n", indent, node.Func.Name())

		for _, edge := range node.Out {
			visit(edge.Callee, depth+1)
		}
	}

	visit(cg.Root, 0)
}
\`\`\`

### When SSA-Level Analysis Is the Answer

Most linters work on the AST. SSA-level analysis is necessary when you need to reason about data flow (which values flow where) rather than syntax. Canonical use cases:

1. **Escape analysis extension.** Detecting whether a specific value escapes from user code.
2. **Security taint tracking.** Does user input flow into a dangerous sink without sanitisation?
3. **Dead-code detection across control flow.** Code that is syntactically reachable but semantically unreachable.

SSA tools are slower to build than AST tools because the data-flow reasoning is more involved. For team-authored linters, start with AST. Move to SSA only when the AST-level check cannot express the rule.

---
`;
