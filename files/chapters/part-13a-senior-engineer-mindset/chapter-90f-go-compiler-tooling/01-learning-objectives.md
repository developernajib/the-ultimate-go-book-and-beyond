## Learning Objectives

1. **Trace the compiler pipeline** - Follow Go source code through parsing, type checking, SSA form, optimizations, and code generation. understand what each phase produces
2. **Read SSA output** - Use `GOSSAFUNC` to examine intermediate representation and understand which optimizations fired
3. **Master escape analysis** - Interpret `-gcflags="-m -m"` output, understand all escape reasons, and write code that avoids unnecessary heap allocations
4. **Understand inlining** - Know what gets inlined, use `//go:noinline` to pin cold paths, and measure the impact on hot paths
5. **Write custom linters** - Build `go/analysis` analyzers with facts, suggested fixes, and integration with `go vet`. Enforce team-specific rules at build time
6. **Navigate AST and types** - Use `go/ast` and `go/types` to traverse code structure, extract type information, and implement code transformation tools
7. **Implement code generation** - Use `go generate` effectively, write template-based codegen, and build a custom `protoc` plugin in Go
8. **Build production tooling** - Combine linter + code generator for a real use case that saves time and prevents bugs in large codebases

### Junior → FAANG: Selecting Your Depth Target

Not all eight objectives carry equal interview weight at the junior level. Objectives 3 (escape analysis) and 5 (custom linters) give the highest signal-to-effort ratio for early-career candidates. Escape analysis is a concrete skill that demonstrates profiling depth. Custom linters demonstrate that you think about enforcing team standards programmatically. Master these two before spending time on the SSA and devirtualization internals.

### Senior @ FAANG: Objectives 5 Through 8 as the Staff Differentiator

At L6, objectives 5 through 8 (analysis framework, AST traversal, code generation, combined tooling) are where the promotion-level work lives. The ability to write a `go/analysis` analyzer that propagates facts across package boundaries, integrates with `golangci-lint`, and provides auto-fix suggestions is a qualitatively different skill from reading escape analysis output. Staff engineers at FAANG are expected to create tooling that multiplies other engineers' effectiveness. Objective 8 (combining linter with codegen) is the closest this chapter comes to describing that work.

---
