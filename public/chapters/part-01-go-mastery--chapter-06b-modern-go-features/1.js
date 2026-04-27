export default `## Learning Objectives

By the end of this chapter, you will:
- Master Go 1.23+ range-over-function iterators and the \`iter\` package (experimental in 1.22, stable in 1.23)
- Understand Swiss Tables map implementation and its performance implications
- Configure and tune the Green Tea garbage collector for production workloads
- Apply Profile-Guided Optimization (PGO) to achieve 10-15% performance gains
- Use \`encoding/json/v2\` for high-performance, correct JSON processing
- Apply SIMD acceleration patterns via assembly and \`golang.org/x/sys\`
- Detect and prevent goroutine leaks with modern tooling
- Use \`unique.Handle\` for value interning to reduce memory and enable O(1) comparisons
- Apply \`os.Root\` for secure, sandboxed file system access that prevents path traversal

### Detailed Outcomes

**Mid-level engineer keeping current**

- Read code that uses range-over-function iterators (\`iter.Seq[T]\`) and write a small custom iterator without reference.
- Use \`slices.Sorted(maps.Keys(m))\` instead of the older "collect then sort" pattern.
- Recognise the \`min\`, \`max\`, and \`clear\` builtins on sight and use them where appropriate.
- Adopt \`log/slog\` for new services without falling back on \`log\` or third-party loggers.
- Articulate which of your current patterns become obsolete with each new release.

**Senior engineer leading platform adoption**

- Decide quarterly whether each new Go release is worth adopting now, deferring, or skipping. Document the decision.
- Evaluate the performance impact of Swiss Tables (1.24), Green Tea GC (1.26), and PGO on your services with measurements rather than guesses.
- Identify the patterns in your codebase that should change to take advantage of new features, and the patterns that should stay the same because the change is not worth it.
- Wire the version upgrade into CI such that the team gets the new release the day it is GA and any regressions are caught before they reach production.
- Maintain the team's "from old Go to current Go" cheatsheet so engineers do not write 1.20-style code in 1.26.

**Staff or Principal engineer setting language policy**

- Set the org-wide Go version policy and defend it against the "we should pin to LTS" pushback (Go has no LTS. The policy must address that explicitly).
- Sequence the rollout of major features (PGO, json/v2, Green Tea GC) across the org so that learning compounds rather than each team rediscovering the same lessons independently.
- Build the operational support model for new features: who owns adoption, who answers questions, who handles regression triage.
- Identify the two or three features per release that move the needle for the org's specific workload profile, and let the rest land naturally.
- Maintain the org's institutional knowledge of which Go patterns have been tried and rejected, so that engineers do not relitigate the same decisions every quarter.

---
`;
