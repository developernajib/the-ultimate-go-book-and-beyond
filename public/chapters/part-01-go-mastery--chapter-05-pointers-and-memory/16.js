export default `## Summary

This chapter covered:

- **Pointer basics**: The \`&\` and \`*\` operators, nil safety, and the absence of pointer arithmetic in Go
- **When to use pointers**: Mutation, large struct efficiency, optional values, and shared state across goroutines
- **Stack vs heap**: Stack allocations are free at function return. Heap allocations require garbage collection
- **Escape analysis**: The compiler decides allocation location. \`go build -gcflags="-m"\` reveals those decisions
- **Nil semantics**: Nil pointers panic on dereference, nil slices work with \`append\`, nil maps panic on write, nil channels block forever, and nil interfaces have a non-obvious two-word representation
- **Receiver types**: Value receivers copy the struct. Pointer receivers share it. Consistency within a type matters
- **Memory layout**: Field ordering affects struct size through alignment padding. Largest-first ordering minimizes waste
- **Profiling**: pprof captures heap profiles and GC statistics from running services
- **Object pooling**: sync.Pool amortizes allocation cost on hot paths but requires resetting objects before reuse

Key points:
1. Prefer value semantics for small, immutable types
2. Use pointer semantics for large types or when mutation is needed
3. Run escape analysis on hot code paths to find unnecessary heap allocations
4. Profile memory with pprof before optimizing, measure, then change
5. Use sync.Pool when benchmarks confirm allocation pressure, not preemptively
6. Order struct fields from largest to smallest alignment to minimize padding
7. Reach for \`unique.Make\` before a hand-rolled intern pool, and \`weak.Pointer[T]\` before a hand-rolled cache-eviction scheme (Go 1.23 and 1.24)
8. Prefer \`runtime.AddCleanup\` over \`runtime.SetFinalizer\` (Go 1.24)
9. Wire a \`runtime/trace\` Flight Recorder into on-call for hard-to-reproduce incidents (Go 1.25)
10. Green Tea GC (default in Go 1.26) is free performance, escape analysis and allocation patterns still dominate what you actually pay for

**Senior-track note.** The production-grade knob set for Go memory in 2026 is \`GOMEMLIMIT\` + PGO + \`unique\` + \`weak.Pointer\` + Flight Recorder + continuous profiling via Pyroscope/Parca. Each piece is cheap to adopt individually. Bundled, they retire most of the justification for bespoke memory-tracking services that were common a few years ago.

### What you should be able to do now

- Predict the output of \`go build -gcflags="-m"\` for small functions on inspection.
- Diagnose a heap profile with \`pprof\` and identify the top three allocation sites.
- Write a \`sync.Pool\` correctly with \`Get\`, \`Put\`, and a reset discipline.
- Choose value vs pointer receiver for a new method with a justification you can defend.
- Identify the typed-nil-interface bug on sight in code review.

### What this chapter intentionally did not teach

The full GC internals (write barriers, the tri-color invariant, the pacer algorithm) are Chapter 14. Concurrency primitives (goroutines, channels, scheduler interactions with the GC) are Chapter 7. The runtime's escape-analysis algorithm in detail is beyond the scope of any current Go book and changes per release. The code-review-relevant behaviour is what we covered. The full taxonomy of \`unsafe\` use cases is Chapter 12 (low-level Go).

### For the FAANG-entry track

The single highest-impact follow-up is to take a Go service you have written and run pprof against it. The first pprof output is almost always surprising. The discipline of "measure then optimise" is built by repeated practice with the tool, not by reading about it.

### For the senior-at-FAANG track

The single highest-impact follow-up is to write the team's memory-discipline document and wire the lint rules into CI. \`fieldalignment\`, \`goleak\`, \`errcheck\`, and the \`runtime\` metrics integration with the team's observability stack. The bugs you catch with the tooling are the bugs you do not have to debug at 3 AM.

---
`;
