## Interview Questions

---

**Q1: What are the trade-offs between recursive descent parsing and Pratt parsing? When would you use each?**

Recursive descent encodes operator precedence in the grammar itself: each precedence level is a separate function that calls the next. This is easy to read and produces excellent error messages because each function knows exactly what it is trying to parse. The downside is rigidity: a language with 18 precedence levels needs 18 chained functions. Adding a new operator may require restructuring the grammar.

Pratt parsing centralizes precedence into a binding-power table. Adding a new operator is a one-line change. The parse loop is short and uniform. The downside is that the code is less readable to someone unfamiliar with the technique, and error messages require more care to keep informative.

In practice: use recursive descent for statements and declarations (which have complex, irregular structure), and Pratt parsing for expressions (which are repetitive and benefit from a clean precedence table). This is exactly what Go's `go/parser` and most modern parsers do.

---

**Q2: What is SSA form and why do optimizers prefer it?**

Static Single Assignment (SSA) is an IR property where each variable is defined (assigned) exactly once in the text of the program. When a value can arrive from multiple control-flow paths, for example, after an `if/else`, a `phi` instruction selects between the possible values.

SSA makes many analyses trivial. Dead code elimination: if a variable has no uses, remove its definition. Constant propagation: if a variable's sole definition is a constant, replace all uses with the constant. They become single-pass, local analyses. Without SSA, you would need dataflow analysis (iterative fixpoints over the control-flow graph) to answer the same questions.

LLVM IR, GCC's GIMPLE, and Go's `cmd/compile/internal/ssa` are all SSA-form IRs. The conversion from a conventional IR to SSA requires computing dominance frontiers (the classic Cytron et al. algorithm).

---

**Q3: Compare a tree-walking interpreter and a bytecode VM in terms of performance. What accounts for the difference?**

A tree-walking interpreter spends most of its time on pointer chasing: each `eval` call takes a `unique_ptr<Expr>`, dereferences it, `std::visit`s the variant (one level of dispatch), and recursively calls eval on children. For a simple `1 + 2 * 3`, this is five function calls, three heap dereferences, and three variant dispatches.

A bytecode VM represents the same computation as four instructions (`PUSH 1`, `PUSH 2`, `PUSH 3`, `MUL`, `ADD`). The main dispatch loop is a single `switch` on a `uint8_t`. Modern CPUs learn this branch pattern. The value stack is a contiguous vector, cache-friendly. No heap dereferencing on the hot path.

Empirically: tree-walkers run at roughly 5-10M operations per second. Bytecode VMs run at 100-300M ops/sec. CPython is a bytecode VM. JavaScript engines that hit JIT thresholds can reach ~10B ops/sec.

---

**Q4: Sketch how Hindley-Milner type inference works.**

Hindley-Milner (HM) is the type inference algorithm used by ML, Haskell, and Rust (for its non-trait portions). The key insight: instead of requiring explicit type annotations, assign fresh type variables to unknown types and collect constraints as you walk the AST.

1. **Constraint generation**: traverse the AST. At a function definition `fn(x) { x + 1 }`, assign `x` the type variable `α`. `1` has type `Int`. The `+` operator has type `Int → Int → Int`. This generates the constraint `α = Int`.

2. **Unification**: run Robinson's unification algorithm on the constraint set. Unification tries to make two types equal by substituting type variables. `α = Int` means substitute `Int` for `α` everywhere. If constraints are contradictory (`Int = Bool`), report a type error.

3. **Generalization**: if a type variable remains unconstrained after unification (it appears in a let binding), it becomes a **type scheme**, a universally quantified polymorphic type. `identity = fn(x) { x }` gets type `∀α. α → α`.

The algorithm runs in nearly linear time for most practical programs (worst case is exponential due to exponentially typed programs, but these are contrived). Go does not use HM, it requires explicit type parameters for generics, but Rust's type inference is HM-based.

---

**Q5: How does a compiler handle nested scopes and variable shadowing?**

A scope is a mapping from name to declaration. The compiler maintains a scope stack (a `vector<unordered_map<string, Info>>`). Entering a block pushes a new scope. Leaving pops it. Variable lookup walks the stack from top (innermost) to bottom (outermost), stopping at the first match.

Shadowing is a natural consequence: if `x` is defined in an outer scope and `let x = ...` appears in an inner scope, the inner definition is pushed onto the stack and shadows the outer. Lookup finds the inner one first. When the inner scope is popped, the outer `x` is visible again.

Some languages (Rust, Swift) intentionally allow shadowing within the same scope (`let x = 5. let x = x + 1;`) as a convenience. The Calc type checker uses `defined_in_current_scope()` to distinguish "same scope redefinition" (an error) from "shadowing an outer scope" (allowed).

---

**Q6: What is dead code elimination and how is it implemented?**

Dead code is code that cannot be reached or whose result is never used.

**Unreachable code**: after a `ret` or unconditional `jmp`, any following instructions are unreachable. DCE removes them by marking reachable basic blocks via a CFG traversal (DFS from the entry block), then removing unmarked blocks.

**Unused values** (in SSA form): an SSA value is dead if it has no uses. An optimizer performs a reverse post-order traversal and marks all values reachable from the function's return value. Any instruction that produces an unmarked value and has no side effects (no memory writes, no function calls) is removed. This is iterated to fixpoint.

LLVM's `DeadCodeEliminationPass` and `AggressiveDeadCodeEliminationPass` implement both levels. The aggressive variant also removes conditional branches where one successor is provably unreachable.

---

**Q7: What is register allocation and why is graph coloring used?**

A compiler's code generator produces IR with an unlimited number of virtual registers. Real CPUs have a fixed number of physical registers (16 general-purpose on x86-64). Register allocation assigns virtual registers to physical ones or spills them to the stack.

Graph coloring is the classical approach: build an **interference graph** where each virtual register is a node, and two nodes are connected by an edge if their live ranges overlap (they are both live at the same program point). Two interfering registers cannot share a physical register. Register allocation becomes graph coloring with `k` colors (where `k` = number of physical registers).

Chaitin's algorithm: try to color the interference graph with `k` colors. If a node has fewer than `k` neighbors, it can always be colored, push it onto a stack. If all nodes have `k`+ neighbors, pick a node to spill (move to memory), mark it, and continue. Pop nodes off the stack, assigning colors greedily. Spilled nodes are rewritten as loads/stores.

Modern compilers use Linear Scan register allocation (faster, used by LLVM's fast regalloc), or LLVM's greedy algorithm (better quality, used at `-O2`).

---

**Q8: What is the difference between LLVM IR and native machine code? When does each exist in the compilation pipeline?**

LLVM IR is a platform-independent, typed, infinite-register SSA program representation. It is the output of the Clang front-end (after parsing and type-checking C++) and the input to LLVM's optimization passes. IR is human-readable (`.ll` files) and serializable (bitcode `.bc` files). It has no notion of physical registers, calling conventions, or instruction encoding.

Machine code is the final, architecture-specific binary: x86-64 opcodes, ARM instructions, or WebAssembly bytecodes. It uses physical registers (or stack slots for spills), encodes immediate values in fixed-size bit fields, and can be directly executed by the CPU.

The pipeline: source → front-end → LLVM IR → optimization passes → LLVM IR (optimized) → instruction selection → machine IR (with virtual registers) → register allocation → machine IR (with physical registers) → instruction scheduling → machine code emission.

LLVM IR can also be JIT-compiled at runtime using the OrcJIT or MCJIT frameworks, the IR is lowered to machine code in memory and called as a function pointer, which is how Julia and the `lli` tool work.

---
