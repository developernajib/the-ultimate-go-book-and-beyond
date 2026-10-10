## Exercises

These exercises extend the Calc compiler built throughout this chapter. Each one touches a different stage of the pipeline.

---

### Exercise 1: Add String Literals to the Lexer

**Goal**: Extend the `Lexer` to handle double-quoted string literals with basic escape sequences: `\"`, `\\`, `\n`, `\t`.

**Requirements**:
- Add `TokenKind::String` to the `TokenKind` enum.
- When the lexer encounters `"`, consume characters until the closing `"`, handling escape sequences.
- Store the string value (with escapes resolved) somewhere, since `string_view` cannot own data, the lexer needs an internal buffer for processed string values.
- Emit a `Token` with `kind = String` and `text` pointing to the unescaped value.
- If the string is unterminated (EOF before `"`), emit a `TokenKind::Error` token with a message like `"unterminated string literal"`.

**Test case**:
```cpp
Lexer lex(R"(let s = "hello\nworld";)");
auto tokens = lex.tokenize();
// tokens[3].kind == TokenKind::String
// tokens[3].text == "hello\nworld"  (with actual newline)
```

**Hint**: Add a `std::string processed_value_` member to `Token`, and populate it only for string tokens where escape processing changes the value.

---

### Exercise 2: Add `while` Loops to the Parser

**Goal**: Add a `while` loop construct to Calc:

```
while cond { body }
```

**Requirements**:
- Add `TokenKind::While` to the lexer keyword table.
- Add a `WhileStmt` node to the AST:
  ```cpp
  struct WhileStmt { ExprPtr cond; StmtList body; };
  ```
- Extend `Stmt` (the `std::variant`) to include `WhileStmt`.
- Add `parse_while_stmt()` to the `Parser`, called from `parse_stmt()` when `check(TokenKind::While)`.
- Implement `exec_node(const WhileStmt&)` in the `Interpreter`: evaluate the condition before each iteration, execute the body if true, stop when false.
- Add a `check_stmt_node(const WhileStmt&)` to the `TypeChecker`: condition must be `Bool`.

**Test case**:
```
let i = 0;
let sum = 0;
while i < 10 {
    sum = sum + i;
    i = i + 1;
}
sum   // should evaluate to 45
```

---

### Exercise 3: Call Stack Depth Check in the Interpreter

**Goal**: Prevent stack overflow for infinitely recursive Calc programs.

**Requirements**:
- Add a `call_depth_` counter to `Interpreter`, initialized to 0.
- In `eval_node(const FnCall&)`, increment `call_depth_` on entry and decrement on exit (use RAII or a `scope_guard`).
- If `call_depth_` exceeds a configurable limit (e.g., 1000), throw:
  ```cpp
  throw std::runtime_error(
      "stack overflow: call depth exceeded 1000 in '" + fc.callee + "'"
  );
  ```
- Ensure the counter is decremented even if the body throws (use `std::unique_ptr` with a custom deleter or a local RAII guard struct).

**Test case**:
```cpp
// Infinite recursion
std::string program = "let loop = fn() { return loop(); }; loop()";
auto result = compiler.compile_and_run(program);
assert(!result.success);
assert(result.errors[0].find("stack overflow") != std::string::npos);
```

---

### Exercise 4: Constant Folding Optimization Pass

**Goal**: Implement a constant folding pass that runs over the AST before interpretation.

**Constant folding**: if both operands of a `BinaryExpr` are `NumberExpr` literals, replace the entire `BinaryExpr` with a single `NumberExpr` whose value is the computed result.

**Examples**:
- `2 + 3` → `NumberExpr{5}`
- `10 * (2 + 3)` → `NumberExpr{50}`  (bottom-up)
- `x + 2` → unchanged (x is not a constant)

**Requirements**:
- Write a free function `ExprPtr constant_fold(ExprPtr expr)` that takes ownership of an expression node and returns a (potentially simplified) new node.
- Apply recursively: fold children first, then try to fold the parent.
- Apply the pass to every `ExprStmt`, `LetStmt`, and `ReturnStmt` in the `StmtList` before interpretation.
- Add a test that verifies `2 * 2 * 2 * 2` reduces to a single `NumberExpr{16}` before any interpreter code runs.

**Hint**: Since `ExprPtr` is `unique_ptr<Expr>`, you can move the folded child back into the parent's slots.

---

### Exercise 5: Emit x86-64 Assembly Directly for Simple Arithmetic

**Goal**: Bypass LLVM and emit x86-64 System V ABI assembly for a single arithmetic expression.

**Target**: generate valid `.s` (GAS syntax) assembly for expressions containing only `NumberExpr` and `BinaryExpr` with `+`, `-`, `*`, `/` (floating-point, using SSE2 `addsd`, `subsd`, `mulsd`, `divsd`).

**Requirements**:
- Write a `class X86Emitter` that takes a `StmtList` and emits to a `std::ostream`.
- Emit a function `_calc_main` with a standard prologue/epilogue.
- Use the x87 floating-point stack or SSE2 `xmm` registers (SSE2 is simpler to reason about).
- For a `NumberExpr`, emit `movsd xmm0, [rip + .LC<n>]` and store the constant in the `.rodata` section.
- For a `BinaryExpr`, emit the left operand into `xmm0`, push it to the stack or a free register, emit the right operand into `xmm1`, then the operation instruction.
- Emit the result in `xmm0` (x86-64 System V ABI: floating-point return value in `xmm0`).
- Write the output to a `.s` file and verify it assembles with: `as output.s -o output.o && nm output.o | grep _calc_main`.

**Test expression**: `1.0 + 2.0 * 3.0` should produce a function returning `7.0`.

---
