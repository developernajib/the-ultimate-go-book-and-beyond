## 90F.11 Interview Questions

**Q1: What phases does the Go compiler go through, and what does each phase produce?**

A: Six main phases:
1. **Lexing/Scanning**: source text → tokens (identifiers, keywords, operators, literals)
2. **Parsing**: tokens → Abstract Syntax Tree (AST). Validates syntax
3. **Type Checking**: AST + imported packages → type-annotated AST. resolves identifiers, infers types, checks assignability, verifies interface satisfaction
4. **IR Generation**: type-checked AST → internal IR (intermediate representation). Desugars language constructs
5. **SSA + Optimizations**: IR → Static Single Assignment form. runs optimization passes (escape analysis, inlining, CSE, DCE, bounds check elimination, nil check elimination, devirtualization)
6. **Code Generation + Linking**: SSA → machine code for target architecture. link with runtime

---

**Q2: What is SSA form and why does the Go compiler use it?**

A: Static Single Assignment (SSA) form is an IR where every variable is assigned exactly once (multiple assignments get different names: x₁, x₂, x₃). Properties: data flow is explicit (use always follows definition), phi nodes merge values from different control flow paths.

Why compilers use SSA:
1. Simplifies optimization passes - each value has one definition, making data flow analysis straightforward
2. Dead Code Elimination: value defined but never used → remove definition
3. Common Subexpression Elimination: same computation appears multiple times → compute once
4. Constant propagation: all uses of a constant-defined value can be replaced with the constant
5. Register allocation: SSA's lifetime information makes register allocation more precise

View Go's SSA: `GOSSAFUNC=FuncName go build ./...` - generates `ssa.html` showing each pass.

---

**Q3: What are the main reasons a variable escapes to the heap in Go?**

A:
1. **Returned pointer**: `func f() *int { x := 1; return &x }` - x's address outlives the frame
2. **Interface conversion**: `fmt.Println(x)` - `x` is boxed into `any`, must be on heap
3. **Stored in escaping container**: pointer stored in map, slice, channel that escapes
4. **Closure capture**: variable captured by a closure outlives the enclosing function
5. **Too large for stack**: typically ~10MB threshold. Large arrays/structs go to heap
6. **reflect usage**: reflection forces heap allocation of reflected values
7. **`go` statement**: goroutine arguments must be on heap (goroutine may outlive caller)
8. **`chan` operations**: values sent through channels may escape

Verify with `go build -gcflags="-m=2" ./...` - shows reason for each escape.

---

**Q4: How does inlining work in Go and how can you influence it?**

A: Inlining replaces a call to a small function with the function body at the call site, eliminating call overhead and enabling further optimizations (constant folding, escape analysis improvement).

The compiler assigns each function an "inlining budget" (AST node count, default ~80). Functions exceeding the budget aren't inlined.

Control via directives:
- `//go:noinline`: prevents inlining (for benchmarking, debugging, or intentional call overhead)
- There is no `//go:inline` directive in Go. To encourage inlining, split the hot path into a small function and mark the cold path `//go:noinline`.

Verify: `go build -gcflags="-m" ./...` shows "can inline X" and "inlining call to X". Measure impact with benchmarks: compare `//go:noinline` version against normal version to quantify call overhead.

---

**Q5: What is the go/analysis framework and how does it enable custom linters?**

A: `go/analysis` is a framework for writing Go static analysis tools. It provides: type-checked AST access (no need to re-parse or re-typecheck), `Inspector` for efficient AST traversal with type filtering, `Facts` for cross-package analysis communication, `Diagnostic` for reporting issues with suggested fixes, and parallel execution support.

An `analysis.Analyzer` specifies: name, documentation, required other analyzers (e.g., `inspect.Analyzer`), fact types exported/imported, and a `Run` function. The framework handles package loading, parallelism, and result caching.

Custom analyzers run via `multichecker.Main(analyzers...)` to build a standalone tool, or integrate with `golangci-lint` via their plugin system.

---

**Q6: What is the difference between go/ast and go/types, and when do you need both?**

A: `go/ast` provides the parsed syntax tree - program structure without semantic meaning. You can see that `x := 5` is an assignment, but not what type `x` is or which declaration `x` refers to.

`go/types` provides semantic information: what type each expression has, which declaration each identifier refers to, whether values satisfy interfaces, what is in each scope. Type information is only available after type-checking.

You need both when: (1) you want to find specific syntax patterns (AST) but need type information to confirm the pattern (e.g., find `fmt.Println` calls - AST finds the call shape, types confirms it's the `fmt` package's `Println`). (2) you're rewriting code (AST manipulation + format.Node for output). (3) you're doing cross-package analysis (types provides imported package information).

---

**Q7: How do you write a protoc plugin in Go?**

A: A protoc plugin is a binary that reads a `CodeGeneratorRequest` protobuf from stdin and writes a `CodeGeneratorResponse` to stdout. The `protogen` package simplifies this.

Steps:
1. Import `google.golang.org/protobuf/compiler/protogen`
2. Call `protogen.Options{}.Run(func(gen *protogen.Plugin) error { ... })`
3. Inside Run: iterate `gen.Files`, access `file.Services`, `service.Methods`, `method.Comments`
4. Create output files with `gen.NewGeneratedFile(filename, importPath)`
5. Write content with `g.P(...)` or template execution
6. Build: `go build -o protoc-gen-myname ./cmd/protoc-gen-myname`
7. Use: `PATH=$PATH:./bin protoc --myname_out=. service.proto`

The plugin receives the full parsed `.proto` file with all type information - no need to parse `.proto` files manually.

---

**Q8: What is devirtualization and when does it happen?**

A: Devirtualization replaces an indirect interface method call (dispatch through vtable) with a direct call to the concrete method. Benefits: direct calls can be inlined. eliminates vtable lookup overhead.

When it happens: (1) the compiler can prove only one concrete type implements the interface at a specific call site (type propagation through SSA). (2) using generics - `func f[T Stringer](t T)` knows the concrete type T at compile time. (3) PGO-guided devirtualization - using a production profile, the compiler devirtualizes the most frequently occurring concrete type at each interface call site.

When it doesn't happen: the interface variable might hold any of multiple concrete types (typical in application code). Use generics or concrete types in hot paths for guaranteed devirtualization.

---

**Q9: How do you structure a go/analysis pass to check cross-package invariants?**

A: Use `Facts` - typed values exported by one pass and imported by another.

Steps:
1. Define a fact type: `type IsValidated struct{}; func (*IsValidated) AFact() {}`
2. Export fact: `pass.ExportObjectFact(obj, &IsValidated{})` - marks an object
3. Import fact in another pass (or same pass on different package): `pass.ImportObjectFact(obj, &fact)` - checks if object is marked

Example: `IsAuthMiddleware` fact exported by authfinder pass, imported by routechecker pass to verify handlers are wrapped. Facts are per-object and propagate across packages when packages are analyzed in dependency order.

Key requirement: `FactTypes` field in `analysis.Analyzer` must list all fact types the analyzer exports or imports.

---

**Q10: What are the escape analysis implications of using sync.Pool?**

A: `sync.Pool` stores objects on the heap (they're accessed from multiple goroutines). When you `pool.Put(x)`, x is stored in the pool (heap). When you `pool.Get()`, you get a heap-allocated object.

The escape analysis impact: objects retrieved from `sync.Pool` are always on the heap (they were stored there by `Put` or allocated by `New`). However, using `sync.Pool` can reduce total GC pressure by reusing allocations - the GC doesn't need to allocate new objects on each request, and the pool objects may survive GC cycles if the pool is active.

Practical: if `go build -gcflags="-m"` shows `pool.Get()` return value "does not escape," it means the *pointer* stays local - but the *object* it points to is on the heap. The benefit of pool is reducing allocation rate (less GC work), not eliminating heap allocation.

---

**Q11: How do you make go generate reliable and idempotent?**

A: Five practices:
1. **Always add "DO NOT EDIT" header**: `// Code generated by [tool]. DO NOT EDIT.` - IDE and tools recognize this, reduces review noise
2. **Check generated files into source control**: teammates can build without the generator tool installed. CI can verify generated files are up-to-date
3. **CI verification**: run `go generate ./...` in CI and `git diff --exit-code` to catch uncommitted generated code
4. **Idempotent generation**: running `go generate` twice should produce identical output (use sort for maps, stable ordering for all output)
5. **Make generation fast**: if generation is slow, developers skip it. Keep generators simple. Cache expensive operations

Example CI check:
```bash
go generate ./...
if ! git diff --quiet; then
    echo "Generated files are out of date. Run 'go generate ./...' and commit."
    git diff
    exit 1
fi
```

---

**Q12: What happens during bounds check elimination in Go?**

A: The compiler analyzes SSA to determine if array/slice index accesses are provably within bounds, eliminating the runtime bounds check (which branches and potentially panics).

When BCE fires: the compiler can prove `0 <= i < len(slice)` holds before the access. Common cases: (1) loop `for i := range slice { _ = slice[i] }` - i is always in [0, len(slice)), so bounds check eliminated. (2) explicit length check before access: `if i < len(s) { return s[i] }` - after the check, s[i] is safe. (3) constant index: `s[0]` where s is known non-empty.

Force BCE: check length once before a tight loop: `if len(slice) > 0 { for i := range slice { _ = slice[i] } }` - compiler knows i is valid. Verify BCE fired: `go build -gcflags="-d=ssa/check_bce/stats"` reports eliminated bounds checks.

---

**Q13: What's the performance difference between interface calls and direct calls in Go?**

A: Interface method calls (indirect via vtable):
- Load type pointer from interface value
- Index into method table to get function pointer
- Indirect call through function pointer
- Prevents inlining (can't inline through indirect call)

Direct calls:
- Single call instruction
- Eligible for inlining

Measured overhead: ~1-5 ns per call for the dispatch itself. The larger impact is preventing inlining - inlining a 5-instruction function saves not just the call overhead but also enables constant folding and other optimizations at the call site. Total speedup from devirtualization: 5-20% in interface-heavy code.

Mitigation: use generics for performance-critical code paths (eliminates virtual dispatch while preserving polymorphism) and use concrete types in hot loops so the compiler can devirtualize and inline the call.

---

**Q14: How do you debug an incorrect escape analysis decision?**

A: Four-step approach:
1. Identify the allocation with `go build -gcflags="-m=2" ./...` - look for "escapes to heap" on variables you expect to be stack-allocated
2. Read the escape reason - `-m=2` gives verbose reasons like "leaking param content" or "interface conversion"
3. Simplify the reproducer - create a minimal Go file that demonstrates the escape without all the production code complexity
4. Apply fixes based on reason: return value instead of pointer, use concrete type instead of interface, pass buffer as parameter instead of returning allocation, use `sync.Pool` if allocation is unavoidable

Verification: `testing.AllocsPerRun(N, fn)` counts allocations per invocation. Zero allocations = no heap escapes in the measured code path.

---

**Q15: What is the role of the AST Inspector in go/analysis?**

A: `golang.org/x/tools/go/ast/inspector.Inspector` provides efficient, pre-ordered AST traversal with node type filtering. Without the Inspector, you'd write an `ast.Inspect` function that visits every node. With the Inspector:

1. Pre-computed: the Inspector traverses the AST once at startup and indexes nodes by type
2. Filtered traversal: `insp.Preorder([]ast.Node{(*ast.CallExpr)(nil)}, ...)` visits only call expressions - skips function declarations, identifiers, etc.
3. `WithStack` variant: provides the parent node chain (useful for context-aware analysis)

Performance: for analyzers that only care about a few node types, filtered traversal is significantly faster than visiting every node. Required by most production analyzers as part of `inspect.Analyzer` dependency.

### Junior → FAANG: Interview Questions as a Study Guide

Questions Q1 through Q6 cover the knowledge expected at a strong L5 level for Go tooling. Read each question, formulate your own answer before reading the provided one, and identify the gaps. If you cannot explain escape analysis (Q2, Q3) without looking at the answer, spend a week running `-gcflags="-m"` on real code before your interview.

### Senior @ FAANG: Questions Q7 Through Q15 as a Staff Assessment

Questions Q7 (protoc plugins), Q9 (cross-package facts), and Q11 (reliable `go generate`) are staff-level questions because they probe production-grade tooling design, not just API familiarity. A bar-raiser interviewer asking Q9 is assessing whether you understand how analysis results propagate across package boundaries (the facts system is the only mechanism for this) and whether you have used this mechanism in practice. If your only experience is single-package analyzers, you are presenting below L6 scope for a tooling-focused role.

The Q14 four-step escape analysis debug methodology is the kind of systematic answer that distinguishes L6 from L5. The L5 answer might identify the problem. The L6 answer names the exact flag, reads the exact output, isolates a minimal reproducer, and applies the fix with a verification step.

---
