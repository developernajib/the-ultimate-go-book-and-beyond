## FAANG Interview Q&A: Go Compiler and Tooling

These questions come up in performance-engineering and platform-engineering loops at Google, Uber, Cloudflare, and Discord, where candidates are expected to reason about the compiler pipeline as an engineering tool.

### 1. Walk through the Go compiler pipeline from source to machine code.

Expected phases: lexer and parser producing an AST, type checker annotating the AST, lowering to a typed intermediate representation, conversion to SSA form, optimization passes (escape analysis, inlining, common subexpression elimination, dead-code elimination, bounds-check elimination, devirtualization), and code generation targeting amd64, arm64, or WASM. Mention that each stage has a stable public API (`go/ast`, `go/types`, `go/analysis`) that tooling can hook without forking the compiler.

### 2. A function is allocating unexpectedly on the hot path. Walk through how you would diagnose and fix it.

Start with `go build -gcflags="-m -m"` to read escape analysis output, then write a benchmark with `-benchmem` to confirm the allocation count, then identify the escape reason (interface boxing, closure capture, size exceeds stack limit, passed to unknown function). Common fixes: pass by pointer to avoid copies that force heap promotion, use `sync.Pool` for transient allocations, avoid `any` parameters on the hot path, and use generics instead of interface boxing where applicable.

### 3. How do you decide when to write a custom `go/analysis` linter versus addressing the pattern in code review?

Code review catches patterns a human reviewer sees. Static analysis catches patterns that will recur hundreds of times across a codebase and that no reviewer can reliably see. Write a linter when the pattern is mechanically detectable, the false-positive rate is below 1%, and the cost of the pattern (security, correctness, performance) justifies the enforcement. Google's published Tricorder platform runs custom analyzers across a monorepo with hundreds of millions of lines of Go.

### 4. Design a custom `go/analysis` analyzer that flags context.Context values stored in struct fields.

A staff-level answer describes the AST walk: visit every `*ast.StructType`, inspect each field's type, and emit a diagnostic when the field type resolves through `go/types` to `context.Context`. Discuss the facts propagation system for cross-package analysis, the `Suggested Fixes` output for auto-remediation, and the integration path through `golangci-lint` so the analyzer runs in every CI pipeline without per-team adoption cost.

### 5. A Go service has a critical function that is not being inlined. How would you diagnose and fix this?

Read the inlining decision with `go build -gcflags="-m=2"`, which prints the inlining budget and the reason a function exceeded it. Common blockers are `recover` calls, `go` statements in the function body, and excessive complexity relative to the budget. Fixes include splitting the function into a small inlinable hot path and a cold path marked `//go:noinline`. Validate the change with a benchmark and with the updated inlining output.

### Junior → FAANG: How to Prepare with These Questions

Questions 1 and 2 are the most commonly asked in Go performance engineering interviews at junior and mid-level. Practice answering question 2 without looking at notes: identify the tool, name the flag, describe the output format, name three escape causes, and name two fixes. If you can do that fluently, you are prepared.

### Senior @ FAANG: Questions 3 Through 5 as Bar-Raiser Signals

Questions 3 and 4 are explicitly L6-scoped. Question 3 requires you to articulate the investment decision framework for static analysis, not just how to write an analyzer. Question 4 (context.Context in struct fields) probes whether you understand `go/types` well enough to check the resolved type of a field rather than its string name. A candidate who says "I would check if the field name contains Context" is demonstrating string-matching thinking. A candidate who walks through the `go/types` resolution path is demonstrating production tooling experience.

Question 5 is a staff-level performance investigation question because it requires knowing the inlining budget system, not just that inlining exists. The mention of PGO-guided inlining (Profile-Guided Optimization in Go 1.21+) as an alternative when the static budget is insufficient is a bar-raiser signal at L7 scope.
