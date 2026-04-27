export default `## 7B.7 Compiler Optimization Passes

Understanding the compiler's optimization passes helps you write code that the compiler can optimize effectively, and diagnose performance problems when it cannot.

### Escape Analysis

Escape analysis is the compiler's process of deciding whether a variable can live on the stack (fast, automatically freed) or must be allocated on the heap (slower, requires garbage collection). When a variable's address is returned from a function, stored in an interface, sent on a channel, or otherwise outlives its declaring function's scope, the compiler "escapes" it to the heap. Understanding escape analysis lets you write code that minimizes heap allocations and reduces GC pressure in performance-critical paths. You can see the compiler's escape decisions by passing \`-gcflags="-m"\` to \`go build\`.

\`\`\`go
package main

// go build -gcflags="-m -m" to see escape analysis decisions

// Does NOT escape to heap
func noEscape() *int {
	x := 42 // stack-allocated
	return &x // wait, this DOES escape!
}

// Actually escapes
func escapes() *int {
	x := 42
	return &x // x escapes to heap
}

// Does NOT escape (inlined, value returned)
func noEscapeValue() int {
	x := 42
	return x
}

// Large values may escape
func largeValue() []byte {
	// Small slices often stay on stack
	buf := make([]byte, 64)
	return buf // escapes if returned/stored
}

// Interface conversion causes escape
func interfaceEscape(w io.Writer, msg string) {
	fmt.Fprintf(w, msg) // msg may escape through interface
}
\`\`\`

\`\`\`bash
# See escape analysis decisions
go build -gcflags="-m" ./...

# More verbose
go build -gcflags="-m -m" ./...

# Output example:
# ./main.go:6:6: moved to heap: x
# ./main.go:12:6: x does not escape
\`\`\`

### Inlining

Inlining is when the compiler replaces a function call with the actual body of the called function. This eliminates the overhead of the function call itself (pushing/popping stack frames) and often enables further optimizations like constant folding and dead code elimination. The Go compiler decides whether to inline a function based on a cost budget of roughly 80 AST nodes. Small, simple functions are inlined automatically, while complex ones are not. You can control this behavior with the \`//go:noinline\` and \`//go:inline\` directives.

\`\`\`go
// Inlining budget: ~80 AST nodes (Go 1.20+)
// Use -gcflags="-m" to see inlining decisions

// This WILL be inlined (simple, small)
func add(a, b int) int {
	return a + b
}

// This won't be inlined (too complex or has //go:noinline)
//go:noinline
func complexFunc(n int) int {
	// ...
	return n
}

// Force inlining suggestion (Go 1.21+)
//go:inline
func hotPath(x int) int {
	return x * 2
}

// Mid-stack inlining: inner call is inlined even when called from non-inlineable function
func outer(n int) int {
	// inner will be inlined here even if outer is not inlineable
	return inner(n) + inner(n+1)
}

func inner(n int) int { return n * n }
\`\`\`

### Bounds Check Elimination (BCE)

Every time you access a slice or array element by index, the Go runtime normally checks that the index is within bounds to prevent buffer overflows. These checks are safe but add a small cost. The compiler can eliminate redundant bounds checks when it can prove at compile time that the index is always valid. Using \`range\` loops automatically eliminates bounds checks because the loop variable is always in range. You can also "hoist" a bounds check by accessing the last element early, which tells the compiler the entire slice is at least that long.

\`\`\`go
package bce

// Bounds check NOT eliminated
func sumNaive(s []int) int {
	sum := 0
	for i := 0; i < len(s); i++ {
		sum += s[i] // bounds check on each access
	}
	return sum
}

// Bounds check eliminated (range form)
func sumRange(s []int) int {
	sum := 0
	for _, v := range s {
		sum += v // no bounds check: range guarantees in-bounds
	}
	return sum
}

// Manual BCE: hoist bounds check
func sumBCE(s []int) int {
	if len(s) == 0 {
		return 0
	}
	_ = s[len(s)-1] // hoist: compiler knows s has at least len(s) elements
	sum := 0
	for i := 0; i < len(s); i++ {
		sum += s[i] // bounds check eliminated
	}
	return sum
}

// Use //go:nosplit to see BCE in action
//go:nosplit
func access(s []int, i int) int {
	return s[i]
}
\`\`\`

\`\`\`bash
# See bounds check eliminations
go build -gcflags="-d=ssa/check_bce/debug=1" ./...
\`\`\`

### Optimisation Debugging Workflow

When a function refuses to inline or a bounds check does not eliminate as expected:

1. **Inspect the inlining decision.** \`go build -gcflags="-m=2"\` shows inlining decisions with explanations. Look for "cannot inline: ..." messages.
2. **Check the function's complexity score.** The inliner has a budget. Functions past the budget will not inline. Breaking into smaller helpers often fixes it.
3. **Verify bounds-check elimination.** \`-d=ssa/check_bce/debug=1\` shows each bounds check and whether it was eliminated. Often the elimination fails because the compiler cannot prove the index is in range.
4. **Consider PGO.** For borderline cases, PGO's hot-function bias pushes inlining budget higher on paths that matter.

The discipline: optimisation is a negotiation with the compiler. Profile first, then adjust, then measure.

---
`;
