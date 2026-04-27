export default `## Summary

Common anti-patterns and their solutions:

| Anti-Pattern | Detection | Fix |
|--------------|-----------|-----|
| Data Race | \`go run -race\` | Mutex, atomic, channels |
| Deadlock | Runtime panic, timeout | Lock ordering, timeouts |
| Goroutine Leak | NumGoroutine, goleak | Context, done channels |
| Starvation | Profiling, metrics | Fair scheduling |
| Live Lock | Monitoring, CPU usage | Random backoff |
| Channel Misuse | Panic, code review | Protocol design |
| Context Misuse | Code review | Follow guidelines |

**Debugging tools:**
- Race detector (\`-race\`)
- Goroutine dumps (\`runtime.Stack\`)
- pprof (\`/debug/pprof/goroutine\`)
- Trace tool (\`go tool trace\`)
- Delve debugger (\`dlv\`)
- Scheduler tracing (\`GODEBUG=schedtrace\`)

**Prevention strategies:**
1. Always run tests with \`-race\`
2. Use \`goleak\` in test suites
3. Monitor goroutine count in production
4. Code review for lock ordering
5. Design with "share by communicating" principle
6. Use higher-level primitives when possible

### For the Senior-at-FAANG Track

The leverage is review discipline: recognising anti-patterns on sight, citing them by name, and providing the fix in the PR comment. Consistent application prevents the vast majority of concurrency incidents from reaching production.

### For the Staff and Principal Track

The deliverables are the tooling and culture: \`-race\` and \`goleak\` in CI as blocking gates, mutex and goroutine profiles available in production, postmortem discipline that treats every concurrency incident as teaching material. Over years, this culture compounds into dramatically lower incident rates and faster diagnosis when incidents do happen.

### Mental Model to Take Away

Concurrency bugs are expensive to find in production and cheap to catch at review or CI time. The teams that ship reliable concurrent Go invest in the cheap layers. The teams that skimp pay the expensive costs repeatedly. The difference is cultural, not technical. Make prevention the default. Every anti-pattern in this chapter has a preventable signature. Catch them early; save the company dollars, hours, and sanity.

---
`;
