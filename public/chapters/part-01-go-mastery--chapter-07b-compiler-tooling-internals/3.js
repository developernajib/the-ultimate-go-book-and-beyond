export default `## 7B.1 The Go Compilation Pipeline

### From Source to Binary

Understanding the compilation pipeline matters when you need to reason about inlining decisions, escape analysis output, or why a particular optimization did or did not fire. Go's compiler processes each package independently: it reads source files, produces tokens via the scanner, builds an AST, runs the type checker to resolve identifiers and verify constraints, lowers to an internal IR, converts to SSA form for dataflow analysis, applies optimization passes (constant folding, function inlining, escape analysis), and finally emits machine code for the target architecture. The linker then resolves cross-package symbols and produces the final executable, a distinct step from compilation but invoked transparently by \`go build\`.

\`\`\`
Source (.go files)
       │
       ▼
   Scanner/Lexer     → tokens (IDENT, INT, STRING, LBRACE, ...)
       │
       ▼
    Parser           → AST (Abstract Syntax Tree)
       │
       ▼
  Type Checker       → typed AST + symbol tables + package info
       │
       ▼
  IR Generation      → internal representation (cmd/compile/internal/ir)
       │
       ▼
  SSA Construction   → Static Single Assignment form
       │
       ▼
  Optimization       → constant folding, inlining, escape analysis, ...
       │
       ▼
  Code Generation    → architecture-specific machine code (amd64/arm64/...)
       │
       ▼
  Linker (cmd/link)  → ELF/Mach-O/PE binary
\`\`\`

The Go compiler (\`cmd/compile\`) is a single-pass compiler, each package is compiled independently with full type information from its dependencies. There is no separate linking step for type resolution like C/C++.

### Key Compiler Packages

| Package | Role |
|---------|------|
| \`cmd/compile/internal/syntax\` | Lexer + parser → CST |
| \`cmd/compile/internal/types2\` | Type checker |
| \`cmd/compile/internal/ir\` | Internal representation (nodes) |
| \`cmd/compile/internal/ssa\` | SSA construction and optimization |
| \`cmd/compile/internal/amd64\` | amd64 backend |
| \`cmd/link\` | Linker |
| \`go/scanner\` | Public-facing lexer |
| \`go/parser\` | Public-facing parser |
| \`go/ast\` | AST node types |
| \`go/types\` | Public type checker |
| \`go/token\` | Token/position types |

### Why the Two-Implementation Split Matters

Go maintains two parallel implementations in a sense: the internal compiler (\`cmd/compile\`) used by \`go build\`, and the public \`go/*\` packages used by tools. They share design heritage but are not the same code. Senior-track implications:

1. **Tools cannot directly call internal optimisation passes.** If you want SSA-level analysis, you either use the internal packages (risky, unstable API) or run the compiler and parse its output.
2. **The public API is stable.** \`go/ast\`, \`go/parser\`, \`go/types\` are part of the Go 1 compatibility promise. Build tooling on them.
3. **The internal API shifts per release.** Tools that depend on \`cmd/compile/internal/*\` break with each Go version. Avoid unless necessary.

The canonical tool architecture: parse with \`go/parser\`, type-check with \`go/types\`, run your analysis with \`go/analysis\`. This stack is stable across releases.

---
`;
