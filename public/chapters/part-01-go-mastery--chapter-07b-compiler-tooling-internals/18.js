export default `## 7B.16 Complete Tool: go-complexity

This section presents a complete cyclomatic complexity analyzer for Go source code. Cyclomatic complexity measures the number of linearly independent paths through a function. Each \`if\`, \`for\`, \`case\`, and logical operator adds a decision point. Functions with high complexity are harder to test and maintain. This tool walks Go source files using the AST, counts decision points in each function, and reports any that exceed a configurable threshold. It can run in CI to enforce complexity limits across a codebase.

\`\`\`go
// cmd/go-complexity/main.go
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"sort"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type ComplexityResult struct {
	File       string
	Function   string
	Line       int
	Complexity int
}

func main() {
	threshold := flag.Int("over", 10, "report functions with complexity over this threshold")
	sortBy := flag.String("sort", "complexity", "sort by: complexity, name, file")
	flag.Parse()

	paths := flag.Args()
	if len(paths) == 0 {
		paths = []string{"."}
	}

	var results []ComplexityResult

	for _, path := range paths {
		err := filepath.Walk(path, func(fp string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if !strings.HasSuffix(fp, ".go") || strings.HasSuffix(fp, "_test.go") {
				return nil
			}
			fileResults, err := analyzeFile(fp)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: %s: %v\\n", fp, err)
				return nil
			}
			for _, r := range fileResults {
				if r.Complexity > *threshold {
					results = append(results, r)
				}
			}
			return nil
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\\n", err)
			os.Exit(1)
		}
	}

	// Sort results
	switch *sortBy {
	case "name":
		sort.Slice(results, func(i, j int) bool {
			return results[i].Function < results[j].Function
		})
	case "file":
		sort.Slice(results, func(i, j int) bool {
			if results[i].File != results[j].File {
				return results[i].File < results[j].File
			}
			return results[i].Line < results[j].Line
		})
	default: // complexity
		sort.Slice(results, func(i, j int) bool {
			return results[i].Complexity > results[j].Complexity
		})
	}

	// Print results
	for _, r := range results {
		fmt.Printf("%s:%d: %s complexity %d\\n", r.File, r.Line, r.Function, r.Complexity)
	}

	if len(results) > 0 {
		os.Exit(1) // signal to CI
	}
}

func analyzeFile(filename string) ([]ComplexityResult, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, nil, 0)
	if err != nil {
		return nil, err
	}

	var results []ComplexityResult

	ast.Inspect(f, func(n ast.Node) bool {
		var funcDecl *ast.FuncDecl
		switch node := n.(type) {
		case *ast.FuncDecl:
			funcDecl = node
		default:
			return true
		}

		name := funcDecl.Name.Name
		if funcDecl.Recv != nil && len(funcDecl.Recv.List) > 0 {
			var recv string
			switch t := funcDecl.Recv.List[0].Type.(type) {
			case *ast.StarExpr:
				if ident, ok := t.X.(*ast.Ident); ok {
					recv = "*" + ident.Name
				}
			case *ast.Ident:
				recv = t.Name
			}
			name = recv + "." + name
		}

		complexity := cyclomaticComplexity(funcDecl)
		results = append(results, ComplexityResult{
			File:       filename,
			Function:   name,
			Line:       fset.Position(funcDecl.Pos()).Line,
			Complexity: complexity,
		})

		return true
	})

	return results, nil
}

// cyclomaticComplexity computes McCabe's cyclomatic complexity
// Complexity = number of decision points + 1
func cyclomaticComplexity(fn *ast.FuncDecl) int {
	complexity := 1 // base complexity

	ast.Inspect(fn, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.IfStmt:
			complexity++
		case *ast.ForStmt:
			complexity++
		case *ast.RangeStmt:
			complexity++
		case *ast.CaseClause:
			complexity++
		case *ast.CommClause:
			complexity++
		case *ast.BinaryExpr:
			// Logical operators add branches
			if be, ok := n.(*ast.BinaryExpr); ok {
				if be.Op == token.LAND || be.Op == token.LOR {
					complexity++
				}
			}
		}
		return true
	})

	return complexity
}
\`\`\`

### Using Complexity as a Team Signal

Cyclomatic complexity thresholds are blunt instruments but useful as a team signal. The discipline:

1. **Set a threshold that most functions clear.** 10-15 is typical. A function above that deserves review.
2. **Do not enforce mechanically.** Some functions are legitimately complex (parsers, dispatchers). Allow overrides with justification.
3. **Track the distribution over time.** A codebase where the 95th percentile is rising indicates accumulating complexity.
4. **Review the top N complex functions quarterly.** Pick three for refactoring each quarter. The codebase stays manageable.

---
`;
