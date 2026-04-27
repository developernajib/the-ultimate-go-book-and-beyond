export default `# Chapter 8: Generics (Go 1.18+ through 1.26)

*"Generics are the most significant change to Go since Go 1 was released. They solve real problems, but they come with real costs. Use them where they clearly help. Do not use them to be clever."* - Go Team

For the first decade of Go's existence, the language had no generics, and Go's designers insisted this was deliberate. Rob Pike and the team were skeptical that the complexity of a generic type system was worth the cost: harder-to-read error messages, more complex language specification, and the temptation to over-abstract that generics inevitably invite. The Go community worked around the absence through three approaches, each with serious trade-offs: code generation (\`go generate\` + templates), the empty interface (\`interface{}\` / \`any\`) with runtime type assertions, and copy-paste duplication. When a function had to work with both \`[]int\` and \`[]string\`, you either generated two copies, lost type safety by using \`any\`, or literally duplicated the function body. None of these are acceptable at scale.

Go 1.18 introduced generics in February 2022 after years of design iteration, most notably the type parameters proposal by Robert Griesemer and Ian Lance Taylor. The implementation uses a novel approach called GCShape stenciling with dictionaries, different from both C++'s full monomorphization (one compiled copy per type instantiation) and Java's type erasure (one copy at runtime with casts). Go's approach is a pragmatic middle ground that avoids the binary size explosion of full monomorphization while preserving more type information than erasure, though the performance characteristics are not always what developers expect coming from C++ template metaprogramming. Understanding the implementation model helps you predict when generics will have zero overhead and when they will be slower than a concrete implementation, a distinction that matters on hot paths.

The most important skill generics require is restraint. Go's existing interface system solves a different but overlapping problem, runtime polymorphism where the concrete type is not known at compile time. Generics solve compile-time polymorphism where you want a single implementation to work with multiple concrete types that are all known before the program runs. The two mechanisms are not interchangeable, but they overlap enough that many developers reach for generics when interfaces would serve better, or reach for interfaces when generics would be cleaner. This chapter spends as much time on when not to use generics as on how to use them, because the failure mode of over-applying generics, deeply nested type constraints, type parameters that propagate through every layer of an API, generic interfaces that confuse callers, is a real risk in production codebases.

**What you will learn in this chapter:**

- The pre-generics landscape, how code generation, \`interface{}\`, and duplication each solved the problem and at what cost, to understand what problem generics actually solve
- Type parameter syntax and semantics, the \`[T constraint]\` notation, multiple type parameters, type parameter lists on functions vs types, and method constraints
- Constraints in depth, the built-in \`any\` and \`comparable\`, the \`cmp.Ordered\` union type, writing custom constraints with type sets, and the \`~T\` underlying type syntax
- Type inference, how Go infers type arguments from function arguments, where inference succeeds and where explicit instantiation is required, and the rules that govern inference
- Generic data structures, implementing type-safe stacks, queues, sets, ordered maps, priority queues, and graphs, contrasted with their pre-generics equivalents
- The \`slices\`, \`maps\`, and \`cmp\` standard library packages (Go 1.21+), the generic standard library and how to use it effectively in production code
- Performance characteristics, GCShape stenciling, when generics compile to the same code as concrete functions, when they introduce dictionary overhead, and how to benchmark the difference
- When to use generics vs interfaces vs code generation, a decision framework with concrete examples from real codebases, including anti-patterns to avoid

**Why this matters at scale:**

Since Go 1.21 shipped the generic standard library packages (\`slices\`, \`maps\`, \`cmp\`), adoption of generics in production Go codebases has accelerated sharply. Google's internal Go teams use generics extensively for infrastructure utilities, generic retry libraries, generic result types wrapping RPC responses, generic batch-processing pipelines, where the alternative was either unsafe \`interface{}\` casts or maintaining separate typed implementations for each use case. Uber's \`uber-go/generics\` open-source repository provides generic collection utilities that are now used across their microservices platform, replacing hand-rolled slice utilities that existed in dozens of service repositories. The Go standard library itself has been incrementally adopting generics in new APIs since 1.21, meaning every Go developer writing idiomatic code against the standard library will encounter and use generic functions regularly. Understanding generics is no longer optional for production Go development. It is the path to reading and writing contemporary Go fluently.

**Prerequisites:** Chapters 1-6. Solid understanding of interfaces (Chapter 6) is particularly important, as distinguishing when to use generics versus interfaces is a central theme of this chapter.

> **For readers new to programming:** generics feel abstract at first. Start with the "why" material in Section 8.1, then work through concrete examples in Section 8.4. The constraints and internals material (8.3, 8.8) pays off once you have written a generic function or two yourself.
>
> **For readers already senior at a FAANG-equivalent company:** the when-not-to-use-generics material is the central lesson. Pattern-match on the anti-patterns in Sections 8.9 and 8.13. The team that reaches for generics by default accumulates complexity. The team that reaches for generics only when the alternatives are worse stays maintainable.

**Chapter navigation by career stage.**

- **Junior or self-taught engineer (targeting FAANG-entry):** your goal is to read and use generic code from the standard library fluently. Sections 8.1-8.4 plus the \`slices\` and \`maps\` packages are the core. Writing your own generic types is a stretch goal for the first year.
- **Mid-level engineer:** focus on when generics replace interfaces or \`any\` and when they do not. The decision framework in Section 8.10 and the common mistakes in 8.9 are what you apply in code review.
- **Senior engineer:** the performance, migration, and team-discipline framing. Generics have real costs (GCShape dictionaries, slower inlining, compile-time explosion) that interact with the team's workload.
- **Staff or Principal:** the architectural question is "when does our team reach for generics, and when do we not?". Set the policy. Default to "use generics only when they clearly replace a worse alternative", and defend the discipline in review.

**What the senior track gets in this chapter that most generics material skips.** Most generics content stops at "here is the syntax, here are examples". This book adds the anti-pattern framing (when generics make code worse), the performance framing (GCShape stenciling and when it costs), the migration framing (when to replace \`any\` with generics and when not), and the code-review framing (what to flag when a PR introduces a new generic type).

---
`;
