## Error Handling

Carbon's error handling model is one of the design areas most explicitly marked "still being designed" in the project's documents. What follows is the stated direction, with the caveat that the specifics will change.

### What Carbon Has Decided

The decisions that look stable:

1. **No exceptions by default**. Carbon does not adopt C++'s exception model. The reasoning is the standard set of complaints against exceptions: invisible control flow, ABI cost, unpredictable performance, the long-running argument inside the C++ community about whether exceptions are appropriate for systems code (Google's internal C++ has banned exceptions for years).
2. **Errors are values**. Errors are returned through the type system, not thrown. The expected pattern is some form of result or expected type, similar to Rust's `Result<T, E>`, Swift's `Result`, or C++23's `std::expected`.
3. **Panics for unrecoverable conditions**. Things like arithmetic overflow in checked builds, out-of-bounds array access, or assertion failures terminate the program through a panic mechanism. These are not catchable in normal code paths.

This is the same shape Rust and Swift settled on, with C++ moving slowly in the same direction through `std::expected`.

### What Is Not Decided

What the syntax, library types, and ergonomics look like is still being worked out. Open questions include:

- The exact spelling of result types and whether they are a built-in or library construct.
- Whether there is operator-level error propagation (Rust's `?`, Swift's `try`).
- How errors compose across module boundaries.
- How errors interact with the C++ interop layer when C++ code throws.
- Whether panics can be caught at process boundaries (the "panic = abort" versus "panic = unwind" debate).

The carbon-lang repository has design discussions on each of these and they are worth reading if you want a real picture of the live debate.

### Why Not Exceptions

Google's internal C++ style has banned exceptions since 2003. The reasons given:

- Existing code was not exception-safe and retrofitting was unrealistic.
- Exception-safe code requires discipline (the Strong/Basic guarantee) that is hard to enforce.
- Exception ABI imposes costs on every translation unit, even ones that do not throw.
- Stack unwinding interacts poorly with C-compatible APIs at the boundary.

Carbon inherits this position. A language whose target user is Google's C++ codebase cannot ship with default exceptions, because that codebase has spent two decades not using them.

### Why Not C-Style Error Codes

The other obvious option, C-style integer error codes returned through out-parameters, is rejected for the standard reasons:

- Out-parameters are awkward and easy to misuse (you can ignore the return value).
- There is no type-level guarantee that you handled the error before using the result.
- Composing errors through call chains becomes verbose.

Result types address both: the caller cannot use the value without checking for the error first (the type system enforces it), and composition is straightforward.

### Hypothetical Syntax

Illustrative direction, not commit-locked:

```carbon
fn Parse(s: String) -> Result(i32, ParseError) {
  // ...
}

fn Process(input: String) -> Result(i32, AppError) {
  let n: i32 = try Parse(input);
  return Ok(n * 2);
}
```

A `Result` type wraps a success value and an error value. The `try` operator (or whatever spelling Carbon settles on) propagates errors up the call stack. If `Parse` returns an error, `Process` returns that error. If `Parse` succeeds, `n` is bound and execution continues.

This is the pattern Rust uses with `Result<T, E>` and `?`, the pattern Swift uses with `throws` and `try`, and a pattern C++23 is moving toward with `std::expected`. Carbon is converging on the same place.

### Interop with C++ Exceptions

This is the thorny part. C++ code in the codebase throws exceptions. Carbon code does not. What happens when a C++ function called from Carbon throws?

The design intent, as far as has been documented, is that exceptions thrown across the boundary are treated as undefined or as panics. The exact semantics are part of the live design debate. The pragmatic answer is that codebases adopting Carbon will likely also be codebases that already do not use C++ exceptions, because Google's C++ style is the target of Carbon's design.

For codebases that do use C++ exceptions, Carbon adoption requires either retrofitting the C++ side to not throw, or accepting that the boundary is exception-hostile and writing wrappers.

### Panics

Panics are for conditions that should never happen in correct code: integer overflow in a checked build, division by zero, out-of-bounds array access, internal consistency assertions. The model is similar to Rust's `panic!` macro: stop the program, optionally with a message, optionally with stack trace, in a way that is not catchable except possibly at the top of a thread.

The cost of panics is that they are a coarse error mechanism. The benefit is that they make broken code fail loudly rather than silently corrupting data.

### Junior at FAANG

You should know that Carbon does not use exceptions, that errors are values, and that panics exist for conditions that should never happen. That is enough.

### Senior at FAANG

You should be able to discuss the trade between exceptions and result types in the context of large codebases, identify the migration cost of moving exception-using code to a result-based model, and articulate why Google's specific historical stance on exceptions makes the Carbon design fit naturally for Google's codebase but possibly less well for codebases that depend on exceptions.

---
