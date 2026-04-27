export default `# Chapter 10: Composition & Go Idioms

*"Don't communicate by sharing memory. Share memory by communicating."* - Go Proverb

Go takes a fundamentally different approach from every object-oriented language that preceded it. Where Java and C++ lean on inheritance hierarchies to express "is-a" relationships, Go bets everything on composition, the idea that complex behavior emerges from assembling small, focused pieces rather than descending from monolithic base classes. This is not a limitation. It is a deliberate design choice that makes Go code easier to read, refactor, and test at scale. The difference between writing Go that compiles and writing Go that your teammates will actually want to maintain comes down to internalizing this philosophy.

Idiomatic Go is a body of knowledge accumulated over more than a decade of production use. It encompasses patterns like functional options, a technique that lets you build flexible APIs without breaking backward compatibility or resorting to sprawling config structs. It includes middleware chains that compose HTTP behaviors cleanly without framework lock-in, struct embedding that provides zero-cost interface promotion, and the builder pattern adapted to Go's idioms for constructing complex objects safely. Behind all of these lies a set of Go proverbs, short, dense aphorisms distilled by Rob Pike and the Go community from hard-won engineering experience. "A little copying is better than a little dependency." "Clear is better than clever." These are not platitudes. They are load-bearing principles in codebases that must survive years of team turnover.

Composition and Go idioms mark the inflection point where developers stop fighting the language and start working with it. At Google, Go services are expected to expose clean, minimal APIs that evolve without churn. At Uber, middleware stacks handle authentication, tracing, and rate-limiting as composable layers rather than tangled interceptors. At Stripe, the functional options pattern lets internal platform teams add configuration knobs to shared libraries without forcing every caller to update. This chapter gives you the vocabulary and the patterns to write Go at that level, code that is not merely correct but unmistakably idiomatic.

**What you will learn in this chapter:**

- **Functional options pattern** - designing flexible, self-documenting APIs that extend without breaking callers
- **Struct embedding and promotion** - achieving interface satisfaction and code reuse through composition rather than inheritance
- **Interface composition** - assembling narrow interfaces into broader contracts while preserving testability
- **Middleware and decorator patterns** - chaining HTTP handlers, gRPC interceptors, and function wrappers cleanly
- **Builder pattern in Go** - constructing complex objects with validation, default values, and fluent syntax
- **Higher-order functions** - using functions as first-class values to express strategies, policies, and transformations
- **Go proverbs applied** - turning the community's collected wisdom into concrete coding decisions
- **Anti-patterns to avoid** - recognizing overuse of embedding, leaky abstractions, and premature generalization

**Why this matters at scale:**

Google's internal Go style guide mandates functional options for any API that may gain configuration over time, avoiding the "config struct sprawl" that plagues older services. Uber's \`fx\` dependency injection framework is itself a masterclass in interface composition, enabling hundreds of services to wire themselves together without hard-coded dependencies. Stripe's Go platform libraries use middleware chains to enforce security policies (authentication, audit logging, rate limiting) across thousands of internal RPC calls transparently. Netflix applies the decorator pattern to instrument service calls with circuit breakers and bulkheads without modifying business logic. In every case, the underlying technique is the same: small, composable pieces assembled into powerful, maintainable systems.

**Prerequisites:** Chapters 1-8 (Go fundamentals, interfaces, error handling, generics). Familiarity with HTTP handlers and basic struct usage is assumed.

> **For readers new to programming:** the idioms in this chapter feel subtle on first pass. Come back after you have written Go for a few months and have felt the friction of the wrong approach. The patterns make more sense once you have tried the alternatives.
>
> **For readers already senior at a FAANG-equivalent company:** this is the chapter you use to push back on Java-shaped Go in review. Functional options, composition over inheritance, and small-interface discipline are the patterns the team accumulates or loses based on review-time attention.

**Chapter navigation by career stage.**

- **Mid-level engineer:** the core material. Sections 9.1-9.4 are the patterns you apply daily. Internalise the functional options pattern especially, as it replaces config structs in almost every case.
- **Senior engineer:** the anti-patterns section (9.14) and the proverbs section (9.5) are the code-review ammunition. The team that applies these consistently stays readable for years.
- **Staff or Principal:** the architectural question is "what patterns does the team use by default, and what patterns does it avoid?". Write the team's idioms guide based on this chapter.

**What the senior track gets that most Go idioms material skips.** The code-review framing (what to flag when a pattern is misused), the migration framing (when to refactor existing code to idiomatic patterns), and the team-discipline framing (how to roll out a new convention without revolt).

**Staff and Principal lens: idioms as the team's contract with itself.** At scale, idioms are not aesthetic. They are the shared vocabulary that lets a reviewer skim a 400-line diff in ten minutes because every pattern fits a familiar shape. The staff-level work is not picking the "best" idioms. It is writing them down, linking them from CONTRIBUTING.md, and training the senior pool to apply them in reviews without your involvement. A Go codebase of two hundred engineers where every service reinvents the functional options pattern in a slightly different shape is a codebase that costs more in reviews than it should. The same codebase where every service uses the same three-line Options-plus-apply pattern is one where a new engineer reads one example and recognises the shape everywhere. Idiomatic consistency is a compounding asset. It is also one of the few engineering artifacts that a principal engineer can build once, maintain lightly, and still be paying dividends four years later. Pick the ten idioms that matter most. Document them. Enforce them. That is the deliverable.

**Go 1.26 note.** Most of the idioms in this chapter predate generics and remain correct in their pre-generics form. Generics (Go 1.18+) add a second expression of several patterns. A type-parameterised option type is sometimes cleaner than a function-based one. A generic constructor can replace a family of type-specific ones. The chapter notes both where it matters. The staff-track rule is the same as always: prefer the simpler version that compiles, whether that is the pre-generics shape or the generic one.

---
`;
