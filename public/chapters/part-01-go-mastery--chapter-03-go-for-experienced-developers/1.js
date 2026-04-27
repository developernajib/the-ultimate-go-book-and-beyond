export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Translate Mental Models**: Map your existing programming knowledge from Java, Python, JavaScript, or C++ to Go's paradigms
2. **Master Package Management**: Understand Go modules, import paths, and dependency management at an expert level
3. **Avoid Common Pitfalls**: Recognize and sidestep the gotchas that trip up experienced developers
4. **Write Idiomatic Go**: Apply Go conventions from day one instead of writing "Java in Go" or "Python in Go"
5. **Migrate Codebases**: Plan and execute migrations from other languages to Go using proven strategies
6. **Understand Trade-offs**: Know when Go is the right choice and when it is not

This chapter is designed for developers who already know how to program. It does not explain what a variable is or how loops work. Instead, it focuses on where Go differs from what you are used to and the mental shifts required to write idiomatic Go.

### Detailed Outcomes

**Mid-level engineer crossing into Go (FAANG-entry track)**

- Translate three concrete patterns from your previous language into idiomatic Go without producing "Java with goroutines": class hierarchies become composition with embedding plus interfaces, exception propagation becomes explicit error returns with \`%w\` wrapping, and Promise chains or Future composition become goroutines coordinated by channels, \`sync.WaitGroup\`, or \`errgroup.Group\`.
- Read a 200-line idiomatic Go file written by a Go-fluent engineer and identify which design choices reflect Go's preferences versus which would have been written differently in your previous language.
- Write a small REST API service from a blank file in under an hour, using only the standard library plus one routing dependency, with structured logging via \`log/slog\`, contextual cancellation via \`context.Context\`, and graceful shutdown.
- Recognise on sight the top five anti-patterns experienced developers import from other languages: getter and setter methods that simply read and write a field, \`interface{}\` parameters used as a generic Object type, panic-and-recover used as exception handling, init functions used for runtime configuration, and singleton patterns implemented with \`sync.Once\`.
- Articulate the trade-off when answering "should we rewrite this Java service in Go?" with concrete criteria (CPU profile, JVM tuning cost, deployment-image size, cold-start latency, team familiarity) rather than ideology.

**Senior engineer leading or reviewing a migration**

- Defend the architectural choice to use Go for a new service against the standard objections (no exceptions, generics added only in 1.18 and still maturing, garbage-collected so it cannot replace Rust, no sum types, no built-in immutability) with specific 2026-current data and the team's own profile of the workload.
- Design a Go module layout for a 50-service monorepo that makes the team boundaries visible in the directory structure, uses \`internal/\` to enforce encapsulation at the package level, and avoids the multi-module-per-repo trap that Go workspaces (1.18+) only partially solves.
- Write the team's "Go from your background" onboarding doc, calibrated to the dominant background of the team's recent hires (likely Java, Python, or TypeScript in 2026), with the explicit list of patterns to unlearn rather than just the syntax mapping.
- Specify the team's error-handling discipline (sentinel vs typed vs opaque, when to wrap, when to log, when to escalate) and write the linter rules that enforce it in CI.
- Identify in a code review when an engineer has imported a pattern from their previous language without realising it (the pattern is not always wrong, but the reviewer should ask whether the engineer has chosen it deliberately or by reflex).

**Staff or Principal engineer setting Go-adoption strategy**

- Frame the Go-adoption decision as a multi-year cost-of-ownership argument, not a syntax-preference argument, with explicit comparisons against the JVM-tuning cost, the GIL-contention cost, the Node-event-loop cost, or the C++ memory-safety cost that the org is currently paying.
- Identify which org-wide patterns Go encourages (small services with explicit dependencies, statically linked binaries deployable as single artifacts, consistent formatting that survives engineer turnover) and which it discourages (deep inheritance hierarchies, complex framework-driven runtimes, magic-string-based configuration), and tie those to the org's own architectural goals.
- Articulate the limits of Go's suitability for the org's workloads (tight numerical loops where Rust or C++ wins, GPU-bound ML serving where Python's ecosystem wins, JVM-heavy data pipelines where the cost of moving is greater than the benefit) so that the adoption decision is bounded rather than dogmatic.
- Anticipate and pre-empt the org-political objections to Go adoption (engineers who do not want to learn it, teams that have built reusable libraries in the incumbent language, the legitimate question of whether the org has the operational maturity to add another language) and have answers that survive a quarterly review.
- Identify the two or three "Go-adoption is finished" milestones for the org (e.g. all new control-plane services are Go by default, the central platform team supports Go-first toolchains, the on-call rotation has Go runbooks) and chart the multi-quarter path to reach them.

---
`;
