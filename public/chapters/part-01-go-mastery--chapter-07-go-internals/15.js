export default `## Summary

This chapter covered Go's execution model from compilation to runtime behavior:

- **Compilation pipeline**: Source passes through lexing, parsing, type checking, SSA optimization, and linking, with each stage inspectable with standard tooling
- **Runtime architecture**: The initialization sequence, TCMalloc-variant allocator, and the \`sysmon\` background thread
- **GMP scheduler**: Goroutines (G) multiplexed onto OS threads (M) through logical processors (P), with work-stealing for load balance
- **Memory management**: Stack growth mechanics, size classes, tiny allocation packing, and large-object allocation paths
- **Garbage collector**: Concurrent tri-color mark-and-sweep with write barriers, tunable via \`GOGC\` and \`GOMEMLIMIT\`
- **Data structure internals**: Channel \`hchan\` structure, map bucket layout, and their implications for concurrent access

Key lessons for production systems:
1. Profile before optimizing. Use \`pprof\`, \`go tool trace\`, and \`GODEBUG\` environment variables
2. Understand escape analysis to keep hot-path allocations on the stack
3. Tune GC with \`GOGC\` and \`GOMEMLIMIT\` based on measured behavior, not guesswork
4. Prefer bounded worker pools over unbounded goroutine spawning
5. Channel buffer sizing affects both throughput and goroutine scheduling
6. Runtime tracing (\`go tool trace\`) reveals scheduling and contention issues invisible in CPU profiles

### What you should be able to do now

- Read \`go tool trace\` and \`GODEBUG=gctrace=1\` output fluently.
- Diagnose a goroutine leak, GC pressure, or scheduler gap using the right tool for each.
- Tune \`GOGC\` and \`GOMEMLIMIT\` with evidence from the trace.
- Explain the GMP model and the tri-colour invariant at interview depth.
- Recognise the three or four runtime-pathology shapes that cause the majority of Go production incidents.

### For the senior-at-FAANG track

The most valuable artifact from this chapter is the team's incident playbook. Each runtime pathology documented here becomes a section in the playbook: symptom, diagnosis path, fix, prevention. Build it once. Update after each incident. The playbook is the difference between "we figured it out last time but cannot remember how" and "we fixed it in ten minutes because the runbook is current".

---
`;
