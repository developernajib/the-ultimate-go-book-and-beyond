export default `## The Modern Go Landscape

Go has undergone a significant acceleration in capability since 1.21, shifting from a language of deliberate minimalism to one actively absorbing lessons from production at scale. Each release targets a concrete pain point: 1.21 introduced the \`slices\`, \`maps\`, and \`cmp\` packages to eliminate repetitive generic boilerplate. 1.22 fixed the long-standing loop variable capture bug that silently broke countless goroutines. 1.23 brought range-over-function iterators and the \`unique\` interning package. And 1.24 swapped the hash map implementation for Swiss Tables, cutting memory usage and improving cache locality without any API change. The roadmap through 1.26 continues this trajectory with a new garbage collector, post-quantum cryptography, and self-referential generics, making it essential to track which features are available in your minimum supported Go version.

\`\`\`
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           Modern Go Evolution                                    │
│                                                                                  │
│  Go 1.21          Go 1.22          Go 1.23          Go 1.24                      │
│  ─────────        ─────────        ─────────        ─────────                    │
│  log/slog         loop vars        iter package     Swiss Tables                 │
│  slices pkg       range int        range-over-fn    weak.Pointer                 │
│  maps pkg         min/max          unique pkg       os.Root                      │
│  cmp pkg          clear            timer reset      tool directive               │
│                                                                                  │
│  Go 1.25 (Aug 2025)                  Go 1.26 (Feb 2026)                          │
│  ─────────────────────               ─────────────────────                       │
│  testing/synctest (stable)           Green Tea GC → DEFAULT                      │
│  Green Tea GC (GOEXPERIMENT opt-in)  json/v2 in stdlib (GOEXPERIMENT=jsonv2)     │
│  Container-aware GOMAXPROCS          Self-referential generics                   │
│  sync.WaitGroup.Go                   crypto/hpke (post-quantum hybrid)           │
│  DWARF v5 debug info                 SIMD experimental pkg                       │
│  cgo overhead -30% start             Stack-allocated slice backing               │
└──────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Reading the Roadmap as a Senior Engineer

The release-by-release timeline above is a forecast of work for any team that takes language currency seriously. Three patterns to internalise:

1. **The standard library is doing what third-party libraries used to do.** \`slog\`, \`slices\`, \`maps\`, \`unique\`, \`weak\`, the \`iter\` package, the \`tool\` directive in \`go.mod\`, the rooted file-system access via \`os.Root\`. Each of these replaces a third-party dependency that teams previously imported, which means each upgrade reduces the team's dependency surface. The follow-up question is "which of our existing dependencies should we drop now that the standard library covers their use case?".
2. **The runtime is doing more, opaquely.** Swiss Tables, Green Tea GC, container-aware \`GOMAXPROCS\`, PGO. These all happen at the toolchain layer with no source changes required. The implication is that the upgrade itself is the work, and the payoff is measurable performance with no code review.
3. **The features have prerequisites in tooling, not code.** PGO requires a profile-collection pipeline. \`testing/synctest\` requires test discipline that uses it. \`os.Root\` requires path-handling code that uses it. The features are available the day you upgrade, but the team's adoption is what produces the value.

### Adoption Decision Framework

For each new feature, the senior-track decision is one of:

- **Adopt now.** The feature replaces a dependency or pattern with measurable benefit and low migration cost. Examples: \`slog\`, \`slices.Sort\`, \`min\`/\`max\`, \`clear\`, the \`tool\` directive. Adopt within one quarter of GA.
- **Adopt with discipline.** The feature is powerful but easy to misuse. Examples: range-over-function iterators (do not over-iteratorise), \`os.Root\` (do not use without understanding the symlink semantics), \`weak.Pointer[T]\` (do not replace explicit eviction without measuring). Adopt with explicit team guidance.
- **Adopt opportunistically.** The feature applies to specific workloads. Examples: PGO (only worth it for hot services), SIMD acceleration (only when pprof shows the relevant hot loop). Adopt when the workload justifies it.
- **Defer.** The feature is brand-new and the team should let it bake for one or two patch releases before betting on it. Default for any major runtime change in its first GA release.

The framework is the artifact. The specific decisions per feature are in the sections that follow.

---
`;
