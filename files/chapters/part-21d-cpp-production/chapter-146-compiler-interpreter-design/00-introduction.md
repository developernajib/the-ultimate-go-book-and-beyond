# Chapter 146: Compiler and Interpreter Design

> "A language that doesn't affect the way you think about programming is not worth knowing.", Alan Perlis

---

Compilers are the most intellectually demanding programs a software engineer can build. They touch every layer of computer science simultaneously: formal language theory, data structures, algorithms, type theory, memory models, and code generation. When a FAANG interviewer says "write an interpreter," they are not asking for a toy. They are asking whether you understand how programs come to life.

This chapter builds a complete, working language called **Calc**, a small but non-trivial language with variables, arithmetic, comparisons, if/else, and first-class functions. Every stage is real and correct:

```
Source text → Lexer → Token stream → Parser → AST → Type checker → Code generator
```

By the end, you will have written a lexer, a recursive-descent parser, a Pratt expression parser, an AST using `std::variant`, a type checker with scoped symbol tables, a tree-walking interpreter, a bytecode virtual machine, and an LLVM IR emitter. The code compiles under C++17 and C++20.

### Why C++ for a Compiler?

Most production compilers are written in C++: Clang, GCC, MSVC, the V8 JavaScript engine, the SpiderMonkey engine, the Lua interpreter's JIT (LuaJIT), and Julia's LLVM-based backend. C++ gives you explicit control over memory layout, zero-cost abstractions for the hot paths (lexer inner loops, VM dispatch), and direct access to the LLVM C++ API, LLVM's own interface is C++, and the C wrapper loses type safety and usability.

Go has excellent compiler tooling in its standard library: `go/scanner`, `go/parser`, `go/ast`, `go/types`, and `golang.org/x/tools/go/ssa`. The Go compiler itself (`cmd/compile`) is written in Go. This chapter maps every C++ concept to its Go counterpart so you can apply what you learn in both worlds.

### The Calc Language

Calc looks like a stripped-down Go:

```
let x = 10;
let y = 20;
let add = fn(a, b) {
    return a + b;
};
let result = add(x, y);   // 30

let fib = fn(n) {
    if n <= 1 { return n; }
    return fib(n - 1) + fib(n - 2);
};

fib(10)   // evaluates to 55
```

It has: integer and floating-point literals, arithmetic operators (`+`, `-`, `*`, `/`), comparison operators (`==`, `!=`, `<`, `>`, `<=`, `>=`), `let` bindings, `if`/`else` expressions, anonymous functions (`fn`), recursion, and `return` statements.

### Chapter Map

| File | Topic |
|------|-------|
| 01 | Lexer: characters → tokens |
| 02 | Recursive descent parser: tokens → AST |
| 03 | Pratt parsing: elegant operator precedence |
| 04 | AST design with `std::variant` |
| 05 | Type checking and semantic analysis |
| 06 | Tree-walking interpreter and bytecode VM |
| 07 | LLVM IR and the pass framework |
| 08 | Complete Calc pipeline wired together |
| 09 | Go engineer's perspective and concept mapping |
| 10 | Exercises |
| 11 | Interview questions |
| 12 | Key takeaways |

Every technique in this chapter is used in real production systems. The lexer structure appears verbatim in Clang's `Lexer.cpp`. The Pratt parser powers `gopls` and Prettier. The bytecode VM pattern underlies CPython, the Lua VM, and early V8. LLVM IR is the compilation target for Clang, Rust, Swift, and Julia.

---
