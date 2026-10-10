## Architecture Overview

Understanding the Go compiler pipeline is prerequisite knowledge for writing effective static analysis tools, code generators, and custom linters. The pipeline transforms source text through a series of well-defined intermediate representations (from raw tokens, through a typed AST, into Static Single Assignment form), and each stage exposes a stable public API (`go/ast`, `go/types`, `go/analysis`) that tooling authors can hook into without forking the compiler itself. Knowing where each optimization (escape analysis, inlining, dead-code elimination) occurs tells you which stage to target when a tool needs to reason about or transform Go programs.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Go Compiler Pipeline                                  │
│                                                                          │
│  Source (.go) → Lexer/Parser → AST → Type Checker → IR → SSA → Opt       │
│                                                                          │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌─────────┐  ┌──────────────┐       │
│  │Source  │→ │Lexer/  │→ │Type    │→ │ Mid-end │→ │ Backend      │       │
│  │.go     │  │Parser  │  │Checker │  │ (SSA)   │  │ (Asm/Obj)    │       │
│  └────────┘  └────────┘  └────────┘  └─────────┘  └──────────────┘       │
│                              │            │              │               │
│                          Packages    Optimizations   Machine Code        │
│                          Resolved    - Escape         - amd64            │
│                          Types       - Inlining       - arm64            │
│                          Checked     - CSE            - WASM             │
│                                      - DCE                               │
│                                      - Devirtualize                      │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │                  Tooling Ecosystem                             │      │
│  │                                                                │      │
│  │  go/ast    → AST traversal, transformation                     │      │
│  │  go/types  → Type information, scope analysis                  │      │
│  │  go/analysis → Pluggable analysis framework (go vet backbone)  │      │
│  │  go generate → Code generation orchestration                   │      │
│  │  protoc-gen-* → Protocol Buffer code generation plugins        │      │
│  └────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Why the Pipeline Diagram Matters in Interviews

When a FAANG interviewer asks "what happens between `go build` and the resulting binary?" most candidates say "it compiles." A candidate who names the lexer, AST, type checker, SSA form, and backend code generation is demonstrating that they understand the compiler as a system, not just a tool. You do not need to implement any of these stages. You need to know their names, what each one produces, and which public APIs expose each stage (`go/ast` for the AST, `go/types` for type information, `go/analysis` for the analysis framework).

### Senior @ FAANG: The Pipeline as a Decision Framework for Tooling

At L6, knowing the pipeline helps you answer the question "where should this enforcement live?" A naming convention check belongs at the AST layer because it requires no type information. A nil-dereference check belongs at the `go/types` layer because it requires type information to distinguish pointer and non-pointer types. A concurrency safety check may require the SSA layer because it needs data-flow information. Choosing the wrong layer wastes engineering effort or produces false positives.

At staff level, you are also evaluating the stability guarantee of each layer. The `go/ast` and `go/types` packages are stable public APIs. The SSA internal representation is not. Tooling that depends on SSA internals requires maintenance on every compiler update. This trade-off belongs in an ADR when you are deciding how to implement an org-wide linter.

---
