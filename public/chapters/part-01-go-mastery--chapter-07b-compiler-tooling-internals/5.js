export default `## 7B.3 Parsing and the AST

The parser produces an Abstract Syntax Tree (AST) from the token stream. An AST is a tree-shaped data structure where each node represents a syntactic element of your program, such as a function declaration, a variable assignment, or a binary expression like \`a + b\`. The tree captures the hierarchical structure of your code: a file contains declarations, a function declaration contains a body, and a body contains statements. Go's \`go/parser\` package lets you parse any Go source code into an AST that you can then inspect, analyze, or transform programmatically.

\`\`\`go
package main

import (
	"go/ast"
	"go/parser"
	"go/token"
)

func main() {
	src := \`package main

func add(a, b int) int {
	return a + b
}\`

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "add.go", src, parser.AllErrors)
	if err != nil {
		panic(err)
	}

	// Print AST
	ast.Print(fset, f)
}
\`\`\`

### AST Node Hierarchy

The AST is organized as a tree of typed nodes. At the top level, an \`ast.File\` node represents an entire Go source file. It contains the package name, import declarations, and top-level declarations like functions, types, and variables. Each function declaration (\`ast.FuncDecl\`) contains its name, parameters, return types, and body. The body itself is a block of statements, each of which may contain expressions. The diagram below shows how a simple \`add\` function is represented in this tree structure.

\`\`\`
ast.File
├── Name: *ast.Ident ("main")
├── Imports: []*ast.ImportSpec
└── Decls: []ast.Decl
    └── *ast.FuncDecl
        ├── Name: *ast.Ident ("add")
        ├── Type: *ast.FuncType
        │   ├── Params: *ast.FieldList
        │   │   ├── *ast.Field (a, b int)
        │   └── Results: *ast.FieldList
        │       └── *ast.Field (int)
        └── Body: *ast.BlockStmt
            └── *ast.ReturnStmt
                └── *ast.BinaryExpr (+)
                    ├── X: *ast.Ident (a)
                    └── Y: *ast.Ident (b)
\`\`\`

### AST Visitor Pattern

Walking the AST means visiting every node in the tree to collect information or check for patterns. Go provides the \`ast.Walk\` function, which accepts a \`Visitor\` interface. Your visitor's \`Visit\` method is called once for each node in the tree, allowing you to inspect or record whatever you need. This pattern is the foundation of almost every Go code analysis tool, from linters to refactoring utilities. The example below collects the names and line numbers of all functions in a source file.

\`\`\`go
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
)

// FuncCollector collects all function names and their line numbers
type FuncCollector struct {
	fset  *token.FileSet
	funcs []FuncInfo
}

type FuncInfo struct {
	Name string
	Line int
	Recv string // receiver type for methods
}

func (fc *FuncCollector) Visit(node ast.Node) ast.Visitor {
	if fn, ok := node.(*ast.FuncDecl); ok {
		info := FuncInfo{
			Name: fn.Name.Name,
			Line: fc.fset.Position(fn.Pos()).Line,
		}
		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			info.Recv = fmt.Sprintf("%v", fn.Recv.List[0].Type)
		}
		fc.funcs = append(fc.funcs, info)
	}
	return fc
}

func collectFunctions(src string) []FuncInfo {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "", src, 0)
	if err != nil {
		return nil
	}

	collector := &FuncCollector{fset: fset}
	ast.Walk(collector, f)
	return collector.funcs
}

func main() {
	src := \`package example

func TopLevel() {}

type Server struct{}

func (s *Server) Start() error { return nil }
func (s *Server) Stop() {}

func helper(x int) int { return x * 2 }
\`
	for _, fn := range collectFunctions(src) {
		if fn.Recv != "" {
			fmt.Printf("Line %d: (%s).%s\\n", fn.Line, fn.Recv, fn.Name)
		} else {
			fmt.Printf("Line %d: %s\\n", fn.Line, fn.Name)
		}
	}
}
\`\`\`

### AST Inspection with ast.Inspect

When you only need to read the AST without controlling the traversal state, \`ast.Inspect\` is a simpler alternative to \`ast.Walk\`. Instead of implementing a \`Visitor\` interface, you pass a single function that receives each node and returns a boolean indicating whether to continue descending into that node's children. This is ideal for quick searches, such as finding all string literals or all function calls in a file.

\`\`\`go
// ast.Inspect is simpler than ast.Walk for read-only traversal
func findStringLiterals(node ast.Node) []string {
	var literals []string
	ast.Inspect(node, func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok {
			if lit.Kind == token.STRING {
				literals = append(literals, lit.Value)
			}
		}
		return true // continue traversal
	})
	return literals
}
\`\`\`

### AST Mutation Is Rarely the Right Answer

Tools that rewrite Go source code (migration tools, refactoring tools, code formatters) often mutate the AST directly. The pitfalls:

1. **Comment positions do not follow nodes.** The AST holds comments in a separate structure keyed by file position. Moving nodes around breaks comment attachment.
2. **Formatting is lost.** \`go/printer\` re-emits code from the AST, which loses the original formatting. Run \`gofmt\` on the output.
3. **Some node types are easy to mutate, others are not.** Expressions are easy. Declarations and statements with complex surrounding context are hard.

For most mutation tasks, the \`github.com/dave/dst\` package (which preserves comment positions correctly) is the right tool. Pure \`go/ast\` mutation is powerful and unforgiving.

---
`;
