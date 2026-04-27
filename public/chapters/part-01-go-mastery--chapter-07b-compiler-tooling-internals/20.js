export default `## 7B.18 Common Pitfalls and Interview Questions

### Common Mistakes

The following table lists mistakes that engineers frequently make when working with Go's compiler tooling and AST packages. Most of these issues are subtle and only surface in specific scenarios, such as modifying the AST while walking it or relying on internal linknames that break across Go versions. Understanding these pitfalls upfront will save you significant debugging time.

| Mistake | Problem | Solution |
|---------|---------|----------|
| Mutating AST during Walk | Concurrent modification | Use separate pass for modifications |
| Relying on \`go/types\` for build-tagged files | Tag-excluded files not parsed | Use \`go/packages\` with \`LoadAllSyntax\` |
| Using \`//go:linkname\` on stdlib internals | Breaks on version update | Use public API |
| Disabling escape analysis (\`//go:noescape\`) incorrectly | GC corruption | Only use with asm-backed functions |
| Over-using \`//go:noinline\` | Prevents optimization | Only for benchmarking/profiling |
| Not calling \`format.Node()\` after AST modification | Malformed output | Always format generated code |
| Ignoring \`go.sum\` verification errors | Supply chain risk | Never bypass sum checks |
| Hardcoding \`GOPATH\` in tools | Multi-module breakage | Use \`go/packages\` for module-aware loading |

### Interview Questions

**Q: What is SSA and why does the Go compiler use it?**

A: Static Single Assignment form ensures every variable is assigned exactly once. This simplifies optimization passes: constant folding, dead code elimination, and strength reduction become straightforward graph traversals. The Go compiler converts code to SSA after type-checking, performs ~40 optimization passes, then converts to machine code.

**Q: How does escape analysis work, and when does a variable escape to the heap?**

A: The compiler performs data flow analysis to determine if a pointer could outlive the function's stack frame. A variable escapes when: its address is returned, it is stored in an interface value, it is sent on a channel, it is stored in a heap-allocated object, or it is too large to fit on the stack. Use \`-gcflags="-m"\` to see escape decisions.

**Q: What is PGO and what does it optimize?**

A: Profile-Guided Optimization uses CPU profiles from real workloads to guide compilation decisions. It optimizes: (1) inlining, hot functions get higher budget, (2) devirtualization, interface calls that usually dispatch to the same type get a type guard for direct dispatch, (3) branch prediction hints. Typical speedup: 2-7%.

**Q: How do build tags interact with the type checker?**

A: Files excluded by build tags are not parsed or type-checked. This means types, functions, and constants defined in excluded files are not in scope. Use \`go/packages\` with \`NeedSyntax | NeedTypesInfo\` to load all files respecting current build tags.

**Q: What is the difference between \`go vet\` and a custom analysis pass?**

A: \`go vet\` runs a curated set of built-in analyzers. Custom analysis passes use the same \`golang.org/x/tools/go/analysis\` framework but are user-defined and run via \`go analysis run\` or tools like \`staticcheck\`, \`golangci-lint\`. Both can share facts (findings) between analyzers.

**Q (Senior track): How would you evaluate whether a team should build a custom linter?**

A: Three signals suggest building a custom linter: (1) a recurring bug class that surfaces in code review or production repeatedly, (2) an architectural rule that is easy to state ("package X cannot import package Y") but hard to enforce without tooling, (3) a pattern migration that affects many files and is mechanical. Other cases, code review catches better.

The cost of a custom linter is ongoing maintenance, not the initial implementation. A linter that has no owner rots. Before building, identify the owner and the refresh cadence.

**Q (Senior track): When is PGO worth the operational complexity?**

A: PGO is worth it for services where (1) CPU is a measurable cost center, (2) workload is stable enough that a profile from last week is representative of this week, and (3) the team has capacity to own the profile-collection and refresh pipeline. For the top hot services in a fleet, PGO pays back within a quarter. For less hot services, the engineering cost exceeds the benefit.

---
`;
