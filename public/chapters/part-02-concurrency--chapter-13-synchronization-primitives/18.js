export default `## Summary

Synchronization primitives in Go's \`sync\` package provide essential tools for protecting shared state:

| Primitive | Use Case | Key Considerations |
|-----------|----------|-------------------|
| \`Mutex\` | Protect shared state | Keep critical sections short |
| \`RWMutex\` | Read-heavy workloads | 10:1+ read/write ratio |
| \`Once\` | One-time initialization | Cannot retry on error |
| \`WaitGroup\` | Wait for goroutine completion | Add before goroutine starts |
| \`Cond\` | Complex waiting conditions | Use channels when possible |
| \`Pool\` | Object reuse | Not for connections! |
| \`Map\` | Concurrent read-heavy maps | Specific use cases only |
| \`atomic\` | Simple counters, flags | Lock-free, fastest option |

**Key Guidelines:**
1. Prefer channels for coordination, mutexes for state protection
2. Keep critical sections as short as possible
3. Always use \`defer\` for unlock
4. Never copy sync types after use
5. Maintain consistent lock ordering to prevent deadlocks
6. Use \`go vet\` to detect common mistakes
7. Benchmark before optimizing, simplicity often wins

The choice between primitives depends on access patterns, contention levels, and performance requirements. Start simple with \`sync.Mutex\`, then optimize based on profiling data.

### For the Senior-at-FAANG Track

The leverage is choosing the right primitive with profile evidence and pushing back in review on the wrong ones. RWMutex without evidence of concurrent-reader benefit, sync.Pool for stateful objects, sync.Map for balanced workloads, atomic for complex multi-field state. Each of these is a common mistake worth catching at review time.

### For the Staff and Principal Track

The deliverables are the org-wide synchronization conventions, the mutex-profile dashboards, and the incident-response process for contention problems. Principal engineers see the scaling ceiling of each primitive and drive the redesign before it becomes an incident. Staff engineers maintain the review discipline that keeps the team's synchronization code within the idiomatic lines. Both roles are unglamorous. Both pay compound dividends over years.

### Mental Model to Take Away

Synchronization is the necessary evil of shared state. The goal is not to use synchronization primitives cleverly. The goal is to design code that needs them less. Single-ownership goroutine-owned state, message-passing between goroutines, immutable data structures: each of these reduces the need for synchronization. The synchronization primitives in this chapter exist for the cases that remain. Use them correctly, but do not elevate them to the centerpiece of your concurrent design. The best synchronization is the one you did not need.

---
`;
