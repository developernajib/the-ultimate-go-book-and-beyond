## Memory and Ownership Story

This is Carbon's most controversial design area. Anyone reading the project for the first time wants to know one thing: is it memory safe. The answer, today, is no, with an asterisk and a roadmap.

### The Honest Status

Carbon at 1.0 will not be memory safe in the way Rust is memory safe. There will be no borrow checker enforcing aliasing rules at the type level. There will be no compile-time guarantee that you cannot dereference a dangling pointer. The language will have hardening features (bounds checks, null checks where appropriate, debug-build sanitizer integration) but the core type system will not prove safety.

This is a deliberate choice and the team has been blunt about it. The reasoning chain goes:

1. The whole point of Carbon is that you can interop with C++ at zero friction.
2. A borrow-checked safe subset cannot interop with C++ at zero friction, because C++ has no borrow checker and references in C++ have looser semantics.
3. Therefore the day-one Carbon language must accept C++-like aliasing semantics.
4. Safety is added later, evolutionarily, by tightening defaults and introducing safer primitives, in a path the design intends to leave open.

If you find this reasoning unconvincing, you are in good company. Many people do. The Rust community in particular has pushed back hard on the claim that safety can be retrofitted.

### What "Evolutionary" Means

The design intent is that Carbon will evolve through phases:

- **Phase 1 (current)**: C++-like memory model with cleaner defaults. Manual memory management, references, pointers, but with sharper edges (explicit nullability, less implicit conversion, no most-vexing-parse).
- **Phase 2 (planned)**: Add safer constructs (smart pointers as first-class, owned types, lifetime annotations) without breaking interop. Engineers can opt in.
- **Phase 3 (aspirational)**: Make the safer subset the default and the unsafe subset opt-in, similar to Rust's `unsafe` blocks. This may require breaking changes for old code.

The path from phase 1 to phase 3 is the open research problem. No one has shipped it on a real codebase. Carbon is betting that it can be done. Skeptics bet that any language that ships unsafe-by-default cannot retrofit safety without becoming a different language.

### Comparison with Rust

Rust's borrow checker is a static analysis pass that runs on the program's lifetime annotations and aliasing graph. It rejects programs that would have undefined behavior under Rust's aliasing rules. The cost of this is twofold: the rules are sometimes restrictive (the borrow checker rejects some programs that would actually be safe), and the language has to track lifetimes everywhere, which adds notational overhead.

Carbon does not have this. A Carbon function that takes a reference does not annotate the lifetime of the reference. The compiler does not verify that the reference is still valid. This is the C++ memory model.

The interop benefit is direct: a C++ function returning a reference and a Carbon function returning a reference behave the same way at the boundary, with no lifetime annotation impedance mismatch.

### Comparison with Hylo

Hylo (formerly Val) takes a different approach to safety: mutable value semantics. Every value is owned by exactly one variable at a time, and references are temporary borrows that are statically scoped. Hylo can prove safety without lifetime annotations because the language guarantees that mutable aliases never exist at the same time. This is mathematically elegant and deserves attention.

Hylo is in early stages, much earlier than Carbon, and is an academic-flavored project led by Dimi Racordon and others. It is not aiming at C++ interop and is not a Carbon competitor. But it is a useful third point in the design space: Rust uses lifetimes, Carbon uses C++-style references, Hylo uses mutable value semantics.

### What This Means in Practice

If you are evaluating Carbon today, you should expect:

- Use-after-free is possible, the same way it is in C++.
- Buffer overruns are possible unless you use bounds-checked containers.
- Data races are possible without explicit synchronization.
- ASan, MSan, TSan, and the rest of the sanitizer family are still your friends.
- Carbon's static analysis catches some classes of bugs better than C++ (clearer ownership intent, no most-vexing-parse, fewer implicit conversions) but does not catch the categories Rust catches.

This is not a value judgment about whether Carbon's approach is right. It is what the language does today.

### The Migration Argument

The Carbon team's strongest argument is the migration math. If a 30-million-line C++ codebase migrates to Rust, the migration takes a decade and the entire time, all the unmigrated code is still as unsafe as it was. If the same codebase migrates to Carbon, the migration is faster (because of free interop), and the migrated code is no worse than the original C++. Then, if Carbon's evolutionary safety story works out, the codebase tightens defaults file by file over the following years, ending up at a safer state faster than the Rust path would have reached it.

If the evolutionary safety story does not work out, the codebase ends up at a slightly cleaner C++ with no safety improvement. That is the downside.

The bet is that the expected value of the Carbon path is higher than the expected value of the Rust path for this specific class of codebase. Reasonable people disagree.

### What to Watch

The signal that Carbon's evolutionary safety story is working will be a concrete safe subset specification, with a defined safe-only mode, and at least one production codebase reporting that it has used the safe mode at scale. Until that signal arrives, Carbon's safety story is design intent, not delivered fact.

### Junior at FAANG

You should be able to state honestly that Carbon is not memory safe today and explain why. Do not oversell the project.

### Senior at FAANG

You should be able to articulate the bet Carbon is making, identify what evidence would update your belief in either direction, and translate that into a position your team can adopt: track Carbon, or wait for the safety signal, or invest in Rust now.

---
