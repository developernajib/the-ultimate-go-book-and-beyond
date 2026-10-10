# Chapter 25B: Advanced Go Tooling - go generate, Plugins, embed, Dependency Injection, and Serialization

*Code generation is Go's way of saying: if you're writing boilerplate, you're doing it wrong.*

Go's tooling ecosystem extends far beyond `go build` and `go test`. This chapter covers five interconnected advanced topics that production Go engineers encounter constantly: using `go generate` to eliminate boilerplate, the `plugin` package for dynamic loading, the `embed` package for bundling assets into binaries, dependency injection patterns that keep Go code testable and maintainable, and a practical comparison of Go's serialization formats.

Each section covers enough for you to apply it immediately in production, understand the trade-offs, and avoid the common pitfalls.

**What you'll learn:**

- **go generate** - running code generators, stringer, mockgen, protoc, sqlc, and writing custom generators
- **Plugin system** - loading Go plugins at runtime, limitations, and better alternatives
- **embed package** - bundling files, templates, and entire directory trees into Go binaries
- **Dependency injection** - manual DI, Google Wire, Uber Dig/Fx, and when each is appropriate
- **Serialization deep dive** - JSON advanced patterns, encoding/gob, Protocol Buffers, MessagePack, and a format comparison

**Staff and Principal lens: advanced tooling is eliminating-boilerplate leverage.** `go generate` plus mockgen plus embed saves hundreds of hours per year across a team. The investment is configuring them once. The payoff is every future PR.

---
