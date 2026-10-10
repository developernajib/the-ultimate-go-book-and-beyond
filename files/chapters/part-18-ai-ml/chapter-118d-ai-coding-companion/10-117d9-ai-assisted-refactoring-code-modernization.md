## 118D.9 AI-Assisted Refactoring & Code Modernization

### Using AI to Identify Refactoring Opportunities

AI can scan your codebase and identify patterns that suggest refactoring opportunities: duplicated logic, god objects, feature envy, long parameter lists, and deeply nested control flow.

**Template: Refactoring Analysis Prompt**

````
Analyze this Go code for refactoring opportunities. Focus on:

1. Code duplication (similar logic in multiple places)
2. God objects (types with too many responsibilities)
3. Long functions (> 50 lines that could be decomposed)
4. Deep nesting (> 3 levels of if/for/switch)
5. Primitive obsession (using string/int where a type would be clearer)
6. Feature envy (a function that uses another type's data more than
   its own)
7. Interface segregation violations (large interfaces that should be
   split)

```text
[paste code]
```

For each finding:
- What's the problem?
- What refactoring pattern fixes it? (Extract Method, Extract Interface,
  Replace Conditional with Polymorphism, etc.)
- Show the refactored code.

Preserve existing behaviour exactly, including behaviour that looks
like a bug. If you spot something that appears wrong, call it out
separately rather than silently correcting it in the refactor.
````

### Migrating from Old Patterns to Modern Go

One of AI's best applications is modernizing Go code. It can systematically update patterns from older Go versions to current idioms.

**Template: Code Modernization Prompt**

````
Modernize this Go code to use current Go idioms. Specifically:
1. Replace interface{} with any
2. Replace ioutil.* with io.* and os.* equivalents
3. Use slices package functions instead of manual loops where applicable
4. Use maps package functions where applicable
5. Use for range N syntax where applicable
6. Use builtin min/max instead of custom implementations
7. Use log/slog instead of log where appropriate
8. Use errors.Join for combining errors where applicable

```text
[paste old code]
```

Show me the modernized version with comments explaining each change.
Flag any change that alters behaviour rather than just style.
````

### Example: Migrating a Go 1.18 Codebase to Current Idioms

The table below shows the eight most common modernization patterns. Each row shows the old pattern and its modern replacement.

```text
// BEFORE (Go 1.18)                          // AFTER (modern Go)

// 1. Type aliases
map[string]interface{}                        map[string]any

// 2. File I/O - ioutil is deprecated
data, err := ioutil.ReadFile(path)            data, err := os.ReadFile(path)
ioutil.WriteFile(path, data, 0644)            os.WriteFile(path, data, 0644)
ioutil.TempDir("", "prefix")                 os.MkdirTemp("", "prefix")

// 3. Logging - unstructured to structured
log.Printf("error: %v", err)                 slog.Error("operation failed",
                                                  "error", err,
                                                  "path", path)

// 4. Sorting - sort package to slices package
sorted := make([]string, len(names))          sorted := slices.Clone(names)
copy(sorted, names)                           slices.Sort(sorted)
sort.Strings(sorted)

// 5. Min/Max - manual to builtin
if a > b { return a }                         return max(a, b)
return b

// 6. Slice operations - manual to slices package
max := values[0]                              return slices.Max(values)
for i := 1; i < len(values); i++ { ... }

// 7. Iteration - C-style to range integer
for i := 0; i < count; i++ { ... }           for i := range count { ... }

// 8. Error combining - manual to errors.Join
msg := ""                                     return errors.Join(nonNilErrors...)
for _, err := range errs { msg += ... }
```

Here is a complete before/after showing these patterns in context:

```go
// AFTER: Modernized to current Go idioms.
package modern

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"
)

type Config struct {
	Values map[string]any // 'any' replaces 'interface{}'
}

func ReadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path) // os.ReadFile replaces ioutil.ReadFile
	if err != nil {
		slog.Error("config read failed", "path", path, "error", err)
		return nil, err
	}
	_ = data
	return &Config{Values: make(map[string]any)}, nil
}

func FindMax(values []int) int {
	if len(values) == 0 {
		return 0
	}
	return slices.Max(values) // slices.Max replaces manual loop
}

func SortNames(names []string) []string {
	sorted := slices.Clone(names) // slices.Clone replaces manual copy
	slices.Sort(sorted)           // slices.Sort replaces sort.Strings
	return sorted
}

func ProcessItems(count int) []string {
	results := make([]string, 0, count)
	for i := range count { // 'for range N' replaces C-style for
		results = append(results, fmt.Sprintf("item-%d", i))
	}
	return results
}

type SafeMap struct {
	mu   sync.RWMutex
	data map[string]any // 'any' replaces 'interface{}'
}

func (m *SafeMap) Get(key string) (any, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// The comma-ok form. `return m.data[key]` does not compile here:
	// a map index yields one value in a return statement, and the
	// signature promises two.
	v, ok := m.data[key]
	return v, ok
}

func MergeErrors(errs []error) error {
	nonNil := make([]error, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			nonNil = append(nonNil, err)
		}
	}
	return errors.Join(nonNil...) // errors.Join replaces manual string concat
}
```

### Go Code: AI-Powered Refactoring Suggestion Tool

The refactoring tool's core contribution is static analysis - calculating cyclomatic complexity and nesting depth using `go/ast`, then sending functions that exceed thresholds to an LLM for refactoring suggestions. The LLM call follows the same `LLMClient` pattern from Section 118D.2.

```go
package refactor

import (
	"go/ast"
	"go/parser"
	"go/token"
)

// CodeMetrics captures complexity metrics for a function.
type CodeMetrics struct {
	Name           string `json:"name"`
	File           string `json:"file"`
	Lines          int    `json:"lines"`
	CyclomaticComp int    `json:"cyclomatic_complexity"`
	NestingDepth   int    `json:"max_nesting_depth"`
	ParameterCount int    `json:"parameter_count"`
}

// CalculateCyclomaticComplexity computes McCabe's cyclomatic complexity for a
// function declaration by counting decision points in the AST.
func CalculateCyclomaticComplexity(fn *ast.FuncDecl) int {
	complexity := 1 // Start at 1 for the function itself.

	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.IfStmt:
			complexity++
		case *ast.ForStmt, *ast.RangeStmt:
			complexity++
		case *ast.CaseClause:
			complexity++
		case *ast.BinaryExpr:
			if be, ok := n.(*ast.BinaryExpr); ok {
				if be.Op.String() == "&&" || be.Op.String() == "||" {
					complexity++
				}
			}
		}
		return true
	})

	return complexity
}

// CalculateMaxNesting computes the deepest nesting level in a block.
func CalculateMaxNesting(block *ast.BlockStmt, depth int) int {
	if block == nil {
		return depth
	}

	maxDepth := depth
	for _, stmt := range block.List {
		switch s := stmt.(type) {
		case *ast.IfStmt:
			d := CalculateMaxNesting(s.Body, depth+1)
			maxDepth = max(maxDepth, d)
			if elseBlock, ok := s.Else.(*ast.BlockStmt); ok {
				d = CalculateMaxNesting(elseBlock, depth+1)
				maxDepth = max(maxDepth, d)
			}
		case *ast.ForStmt:
			maxDepth = max(maxDepth, CalculateMaxNesting(s.Body, depth+1))
		case *ast.RangeStmt:
			maxDepth = max(maxDepth, CalculateMaxNesting(s.Body, depth+1))
		case *ast.SwitchStmt:
			maxDepth = max(maxDepth, CalculateMaxNesting(s.Body, depth+1))
		}
	}
	return maxDepth
}

// AnalyzeFile extracts complexity metrics for all functions in a Go source file.
// Functions exceeding the threshold are returned for AI-assisted refactoring review.
func AnalyzeFile(path string, complexityThreshold int) ([]CodeMetrics, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return nil, err
	}

	var flagged []CodeMetrics
	for _, decl := range node.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}

		m := CodeMetrics{
			Name:           fn.Name.Name,
			File:           path,
			Lines:          fset.Position(fn.End()).Line - fset.Position(fn.Pos()).Line + 1,
			CyclomaticComp: CalculateCyclomaticComplexity(fn),
			NestingDepth:   CalculateMaxNesting(fn.Body, 0),
		}
		if fn.Type.Params != nil {
			m.ParameterCount = fn.Type.Params.NumFields()
		}

		if m.CyclomaticComp >= complexityThreshold || m.NestingDepth > 3 || m.Lines > 50 {
			flagged = append(flagged, m)
		}
	}
	return flagged, nil
}
```

The workflow: walk the project directory, call `AnalyzeFile` on each `.go` file, collect all flagged functions, serialize the metrics to JSON, and send them to the LLM with a prompt requesting specific refactoring suggestions (Extract Method, Extract Interface, Early Return, etc.). The LLM returns structured JSON with `file`, `function`, `pattern`, `severity`, and `description` fields.

> **What AI Gets Wrong**: AI refactoring suggestions sometimes over-abstract. It might suggest extracting an interface when a function only has one implementation, or suggest the Strategy pattern when a simple switch statement is clearer. The best refactoring is the simplest change that improves readability - not the most architecturally pure abstraction.

> **Pro Tip**: When modernizing a large codebase, do it in waves: first rename (`interface{}` to `any`), then replace deprecated packages (`ioutil` to `os`/`io`), then adopt new patterns (`slices` package, `for range N`). Each wave should be a separate PR that is easy to review.

### Junior → FAANG: Refactoring as Codebase Understanding Practice

AI-assisted refactoring is one of the best ways to develop deep understanding of an existing codebase. When you ask AI to identify refactoring opportunities in a Go file, the suggestions reveal which patterns the codebase uses inconsistently, which dependencies are tighter than they need to be, and which abstractions are missing or misaligned. Reading and evaluating these suggestions develops the code reading skill that is assessed in FAANG code review interviews.

The "waves" approach to codebase modernization (mechanical renames first, then deprecated package replacements, then new pattern adoption) is a risk management technique that junior engineers often skip in favor of making all changes simultaneously. The wave approach produces PRs that are easy to review (each PR has a clear, single purpose), easy to revert if the change causes issues (reverting one wave does not undo other unrelated changes), and easy to track (progress is visible as each wave of changes is completed). Practice this approach on any modernization project and describe it in FAANG interviews as evidence of engineering discipline.

The "over-abstraction" warning in "What AI Gets Wrong" is the Go-specific design principle to internalize: Go prefers explicit, clear code over abstract, "flexible" code. An interface with only one implementation adds complexity without benefit. A Strategy pattern replaces a three-line switch statement with a file of interfaces, structs, and constructors. Before accepting AI's abstraction suggestions, ask: does this abstraction have a concrete benefit (testability, extensibility, dependency inversion) or is it abstraction for its own sake? The default in Go should be concrete.

### Senior @ FAANG: AI-Assisted Refactoring as Technical Debt Management

At senior level, AI-assisted refactoring is the tool that makes technical debt management economically feasible at scale. A codebase with 200,000 lines of Go accumulated over 5 years has inconsistent patterns, deprecated package usage, and missed modernization opportunities throughout. Manually identifying and fixing all of these would take months of focused engineering time. AI-assisted analysis (identifying the categories of changes needed) plus AI-assisted implementation (generating the specific changes for each category) compresses this work significantly.

The wave approach for large codebase modernization also has organizational advantages: each wave's PR set (if there are 200 files to modernize, each wave might be 10-20 PRs of 10-15 files each) can be reviewed by multiple engineers in parallel, merged incrementally without creating a massive "modernization" branch that diverges from main for weeks, and tracked as a project with measurable progress rather than as an open-ended refactoring effort. Planning the modernization project in waves, estimating the effort for each wave, and tracking completion against the estimate is the project management discipline that senior engineers apply to large refactoring initiatives.

---
