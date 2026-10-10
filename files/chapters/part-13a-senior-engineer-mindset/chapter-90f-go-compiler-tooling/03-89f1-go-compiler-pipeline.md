## 90F.1 Go Compiler Pipeline

### Phase 1: Lexing and Parsing

The compiler's first phase reads source text and produces an Abstract Syntax Tree (AST).

```
Source: func Add(a, b int) int { return a + b }

Tokens: FUNC, IDENT(Add), LPAREN, IDENT(a), COMMA, IDENT(b), IDENT(int), RPAREN, IDENT(int), LBRACE, RETURN, IDENT(a), ADD, IDENT(b), RBRACE

AST:
FuncDecl
├── Name: Ident{Add}
├── Type: FuncType
│   ├── Params: FieldList
│   │   ├── Field{Names: [a,b], Type: int}
│   └── Results: FieldList
│       └── Field{Type: int}
└── Body: BlockStmt
    └── ReturnStmt
        └── BinaryExpr{Op: +, X: Ident{a}, Y: Ident{b}}
```

### Phase 2: Type Checking

The type checker resolves identifiers to their declarations, infers types, checks assignability, and verifies interface satisfaction. After type checking, every AST node has an associated type.

```go
// See what the type checker produces using go/types directly
package main

import (
    "fmt"
    "go/ast"
    "go/importer"
    "go/parser"
    "go/token"
    "go/types"
)

func main() {
    src := `
package main

func Add(a, b int) int {
    return a + b
}
`
    fset := token.NewFileSet()
    f, _ := parser.ParseFile(fset, "example.go", src, 0)

    conf := types.Config{Importer: importer.Default()}
    info := &types.Info{
        Types: make(map[ast.Expr]types.TypeAndValue),
        Defs:  make(map[*ast.Ident]types.Object),
        Uses:  make(map[*ast.Ident]types.Object),
    }

    pkg, err := conf.Check("main", fset, []*ast.File{f}, info)
    if err != nil {
        panic(err)
    }

    fmt.Println("Package:", pkg.Name())
    for ident, obj := range info.Defs {
        if obj != nil {
            fmt.Printf("Def: %s → %s (type: %s)\n", ident.Name, obj.Type(), fset.Position(ident.Pos()))
        }
    }
}
```

### Phase 3: Mid-end (SSA and Optimizations)

After type checking, the compiler converts to Static Single Assignment (SSA) form - the intermediate representation used for optimizations.

**SSA Properties:**
- Every variable is defined exactly once (subscript versioning: `x`, `x₁`, `x₂`)
- Uses of a variable always follow its definition (dominance property)
- Makes data flow explicit - enables many classical optimizations

```bash
# View SSA for a function
GOSSAFUNC=Add go build main.go
# Opens ssa.html in browser (or saves to ssa.html)
# Shows each SSA pass: start → opt → lower → final

# Command-line version (no browser needed)
GOSSAFUNC=Add GOARCH=amd64 go build -gcflags="-S" main.go 2>&1 | head -50
```

### Understanding SSA Output

SSA output is dense but follows a predictable structure: each block (`b1`, `b2`, ...) represents a basic block of control flow, each `v` variable is an SSA value defined exactly once, and `Phi` nodes merge values from multiple predecessor blocks. Reading the SSA for a loop reveals how the compiler models loop-carried state through Phi nodes, a critical concept for understanding how range loops and induction variables are optimized. The example below shows a simple summation loop so you can map Go source constructs directly to their SSA counterparts.

```go
// Example function to analyze
package main

func sumSlice(nums []int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}
```

```text
# GOSSAFUNC=sumSlice output (simplified):
# Pass "start":
b1:                        # entry block
  v1 = InitMem mem         # memory state
  v2 = SP ptr              # stack pointer
  v3 = Arg <[]int> nums    # function argument

b2:                        # loop condition
  v7 = Phi <int> [b1:0, b3:v12]  # total = phi(0, total+n)
  v8 = Phi <int> [b1:0, b3:v13]  # i = phi(0, i+1)
  v9 = SliceLen v3         # len(nums)
  v10 = Less64 v8 v9       # i < len(nums)
  If v10 → b3, b4          # if i < len: goto loop body; else goto exit

b3:                        # loop body
  v11 = SliceIndex v3 v8   # nums[i]
  v12 = Add64 v7 v11       # total + n
  v13 = Add64 v8 1         # i + 1
  Goto b2

b4:                        # exit
  Ret v7                   # return total
```

### Key SSA Optimizations

The compiler applies a series of named SSA passes, each performing a specific class of optimization. Common Subexpression Elimination (CSE) eliminates redundant computation, Dead Code Elimination (DCE) removes unreachable code, and bounds check elimination removes provably-safe array index checks that would otherwise add a conditional branch per access. Understanding which passes apply to your code helps you write code that the compiler can optimize most aggressively, and helps you diagnose why a hot loop contains unexpected branches or comparisons.

```bash
# See which optimizations fire on your code
GOSSAFUNC=YourFunc go build -gcflags="-d=ssa/generic_cse/stats,ssa/lower/stats" .

# Optimizations that transform SSA passes:
# generic_cse    - Common Subexpression Elimination: compute (a+b) once, reuse
# generic_dce    - Dead Code Elimination: remove code that can't be reached
# opt            - Various peephole optimizations
# bound_check    - Bounds check elimination: remove proven-safe array bounds checks
# nilcheckelim   - Nil check elimination: remove proven-non-nil pointer checks
# loopbce        - Loop-based bounds check elimination
# regalloc       - Register allocation (assign SSA values to CPU registers)
```

### Junior → FAANG: SSA as a Debugging and Interview Tool

Most candidates have never seen SSA output and cannot discuss it. If you run `GOSSAFUNC` on any function in your codebase and can describe what the output shows, you have a concrete differentiator. Focus on one specific insight you gained: "I noticed the loop was generating a Phi node for the loop counter and that helped me understand why the compiler was not eliminating a bounds check." One specific observation is worth more than abstract description.

### Senior @ FAANG: SSA Passes as a Performance Investigation Methodology

At L6, SSA pass inspection is a systematic methodology, not a curiosity. When a benchmark regresses after a Go version upgrade, the first diagnostic step is to compare the SSA output of the hot function before and after the upgrade to determine which optimization pass changed behavior. This is a concrete, reproducible investigation technique that produces a precise root cause rather than a guess. Document the investigation in the incident report so the team builds this capability rather than reinventing it.

The optimization flags listed above are not exhaustive. The full list of SSA passes is available in the Go source under `src/cmd/compile/internal/ssa`. At staff level, having read portions of the compiler source is a signal of genuine depth rather than surface familiarity.

---
