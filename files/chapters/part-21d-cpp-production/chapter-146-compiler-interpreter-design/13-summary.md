## Key Takeaways

- **A compiler is a pipeline of transformations**, not a monolithic program. Each stage, lexer, parser, type checker, code generator, has a single, well-defined input and output. This makes each stage independently testable, replaceable, and composable. The same architecture appears in GCC, Clang, Go's `cmd/compile`, and the Calc toy compiler built in this chapter.

- **The lexer's job is character-to-token translation, nothing more.** Using `std::string_view` for token text avoids all heap allocation during lexing. Every token carries a source location (line and column) so that every downstream error message can point to the exact character in the source.

- **Recursive descent is the right default for parsers.** One function per grammar rule mirrors the grammar directly. The call stack is the parse stack. Error messages are easy to produce because each function knows what it is parsing. Use Pratt parsing specifically for binary expressions where the precedence table would otherwise require a cascade of grammar functions.

- **Pratt parsing reduces operator precedence to a binding-power table.** Left-associative operators use `rbp = lbp + 1`. Right-associative operators use `rbp = lbp`. Adding a new operator is a one-line change. This is why `gopls`, Prettier, and many modern parsers use Pratt parsing for their expression layers.

- **`std::variant` with `std::visit` is the correct AST representation in modern C++.** It gives compile-time exhaustiveness checking (the compiler warns if you forget a case), no per-node vtable overhead, and pattern-matching style code. Virtual dispatch is only appropriate for open extension points where node types are added by external code.

- **The type checker is the most valuable stage of a compiler.** It eliminates an entire class of runtime errors before the program runs. A well-designed type checker uses a scope stack for symbol resolution, accumulates all errors instead of stopping at the first, and produces error messages that name the expected and actual types with source locations.

- **Tree-walking interpreters and bytecode VMs serve different points on the simplicity/performance trade-off.** A tree-walker can be correct and complete in ~100 lines. A bytecode VM reaches ~20x that throughput by eliminating pointer chasing and enabling a tight dispatch loop. Most production scripting languages use bytecode (Python, Lua, Ruby 3+, Go).

- **LLVM IR is the lingua franca of modern compiled languages.** Understanding SSA form, `phi` nodes, and the LLVM pass framework makes you able to understand how Clang, Rust, Swift, and Julia compile to native code. Writing a custom LLVM pass is how production teams implement compiler-level sanitizers, profiling, and domain-specific optimizations.

- **Go ships a complete compiler toolkit in its standard library.** `go/scanner`, `go/parser`, `go/ast`, `go/types`, and `go/analysis` cover every stage built in this chapter. A Go engineer writing language tooling, a linter, a code formatter, an IDE language server, should reach for these packages before writing a parser from scratch.

- **The gap between a toy compiler and a production compiler is features, not architecture.** Garbage collection, closures, modules, generics, tail-call optimization, and incremental compilation each add significant complexity. But the core pipeline, lex, parse, type-check, generate, is the same. Understanding the toy compiler gives you the mental model to read and contribute to real compiler codebases.

---

| [◀ Chapter 145: Database Engine Internals](../chapter-145-database-engine-internals/00-introduction.md) | [Chapter 146: Compiler and Interpreter Design](00-introduction.md) | [Chapter 147: High-Frequency Trading Systems](../chapter-147-hft-systems/00-introduction.md) ▶ |
