export default `## Summary

You have learned the mental shifts required for Go:

- **Structs + interfaces** replace classes + inheritance
- **Error values** replace exceptions
- **Goroutines + channels** replace threads + locks
- **Composition** replaces inheritance
- **Explicit** replaces implicit

You understand Go's package system, module management, and common gotchas that trip up newcomers. You've seen how companies like Google, Uber, Netflix, Stripe, and Cloudflare use Go, and you have a complete migration example you can adapt for your projects.

**For senior and staff readers leading a migration.** The mental-model section and the anti-pattern list are the artifacts worth taking back to your team. Paste the "accept interfaces, return structs" rule, the typed-nil pitfall, the \`context.Context\` threading rule, and the channel-vs-mutex guidance into your team's review guide. Migration success correlates with how quickly the team stops writing Pythonic or Java-ish Go and starts writing idiomatic Go. The RFC-length version of each rule lives in the interview-questions file, written in the format you can adapt for an internal onboarding doc.

The next chapter covers Go's type system in detail, the foundation for writing correct, type-safe code.

### What you should be able to do now

- Read a 200-line Go file written by a Go-fluent engineer and identify which design choices reflect Go's preferences versus what your previous language would have done.
- Write a small REST API service from a blank file in under an hour, including module init, dependency injection, structured logging, graceful shutdown, and at least one test.
- Spot the top five anti-patterns experienced developers import from other languages on a code review pass.
- Articulate the architectural argument for each of Go's deliberate omissions (no inheritance, no exceptions, no enums in the Java sense, generics only since 1.18 and still maturing, no built-in DI framework) without sliding into "my old language was better" defensiveness.
- Name the migration trade-offs honestly. Go is the right answer for most backend and infrastructure work in 2026, and the wrong answer for tight numerical loops, GPU-bound ML serving, and JVM-deep data pipelines where the cost of moving exceeds the benefit.

### What this chapter intentionally did not teach

The full Go type system, including generics and interface satisfaction edge cases, is Chapter 4. Concurrency primitives beyond a brief introduction (goroutines, channels, \`select\`, \`sync.Mutex\`, \`errgroup\`) are Chapter 7. The runtime, scheduler internals, and garbage collector are Chapters 13 through 15. The full taxonomy of error-handling patterns at scale is Chapter 9. The toolchain (\`go test\`, \`go vet\`, \`golangci-lint\`, \`pprof\`, \`trace\`) gets its own treatment in Chapter 5 and Chapter 14. If this chapter felt fast, that is by design. The goal here was the mental-model shift, not the engineering depth.

### For the FAANG-entry track

Spend the next two weeks rewriting a service you already know in idiomatic Go. The "service you already know" can be small: a CSV processor, a CLI tool, a scheduled job. The discipline is to write it the Go way, not the Python or Java way you originally wrote it. When you find yourself reaching for a familiar pattern that is wrong in Go (a class hierarchy, an exception handler, a Promise chain), stop and find the Go-idiomatic replacement. The fluency you build in those two weeks is the fluency a Go-team interview at Google, Meta, or Stripe expects.

### For the senior-at-FAANG track

The structural lesson of this chapter is that mental-model shifts are the bottleneck in every language migration, not syntax. The team's onboarding doc, the team's review guide, and the team's "from X to Go" cheatsheet are the artifacts that compound across hires. Write them once. Update them every quarter. The single highest-leverage change a senior Go engineer can make in their first quarter at a new team is to author or revise the team's "from X to Go" doc and put it where the next hire can find it on day one.

---
`;
