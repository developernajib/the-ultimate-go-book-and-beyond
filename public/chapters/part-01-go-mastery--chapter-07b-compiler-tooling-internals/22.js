export default `## Summary

| Topic | Key Point |
|-------|-----------|
| Compilation pipeline | Scan → Parse → Type-check → IR → SSA → Codegen → Link |
| \`go/ast\` | Tree representation. Walk/Inspect for traversal |
| \`go/types\` | Full type info. Implements interface checks. Scope analysis |
| \`go/analysis\` | Framework for linters. Facts enable cross-package analysis |
| SSA | Single-assignment form. Enables constant folding, inlining, BCE |
| Escape analysis | \`-gcflags="-m"\` shows decisions. Interfaces and large values escape |
| PGO | \`-pgo=cpu.pprof\`; inlining + devirtualization. 2-7% speedup |
| \`go generate\` | Code generation via special comments. Use \`text/template\` |
| Build tags | \`//go:build expr\`; OS/arch/custom. Conditional compilation |
| Linker flags | \`-ldflags="-s -w -X main.Version=..."\` |
| Module system | \`go.mod\`, \`go.sum\`, GOPROXY, GOPRIVATE |

### What you should be able to do now

- Write a small \`go/analysis\` pass that catches a team-specific anti-pattern.
- Read \`-gcflags="-m"\` output fluently.
- Debug a slow build using the build cache and timing flags.
- Sequence a new lint-rule rollout without revolting the team.
- Evaluate whether CGo, PGO, or a custom linter is the right investment for a specific problem.

### For the senior-at-FAANG track

The tooling leverage in this chapter compounds. A custom linter that catches one class of bugs saves engineering time forever. A code generator that produces boilerplate from a schema saves engineering time forever. A remote build cache that halves CI time saves engineering time forever. Invest in the toolkit. The compounding interest is real.

---
`;
