export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Master sync.Mutex and sync.RWMutex** for protecting shared state with appropriate lock granularity
2. **Implement sync.Once patterns** including retry-on-error and lazy initialization variants
3. **Coordinate goroutines with sync.WaitGroup** and understand common pitfalls
4. **Use sync.Cond** for complex waiting conditions and broadcast patterns
5. **Optimize memory with sync.Pool** for high-throughput applications
6. **Apply sync.Map** correctly for concurrent read-heavy workloads
7. **Use atomic operations** for lock-free counters, flags, and configuration
8. **Choose the right primitive** based on access patterns and performance requirements
9. **Build production systems** using synchronization primitives used at Google, Uber, and Netflix
10. **Debug synchronization issues** including deadlocks, race conditions, and contention

### Detailed Outcomes

**Junior to FAANG-entry track**

- Produce a mutex-protected counter from a blank file in two minutes.
- Use \`sync.WaitGroup\` correctly (Add before go, defer Done, Wait at the end).
- Recognise when \`sync.Once\` is the right answer for lazy initialisation.
- Diagnose a deadlock from a code snippet by tracing lock-acquisition order.

**Mid-level engineer**

- Choose between Mutex, RWMutex, and atomics with profile evidence.
- Use \`sync.Pool\` correctly (stateless-object recycling) and avoid its misuses.
- Understand when \`sync.Map\` wins (read-heavy, append-only) and when it loses.
- Write race-free concurrent code and run the race detector locally and in CI.

**Senior engineer**

- Push back in review on RWMutex used without profile evidence, sync.Pool misused for stateful objects, sync.Map used for balanced workloads.
- Diagnose contention with \`go tool pprof -block\` and \`-mutex\` profiling.
- Design lock hierarchies that prevent deadlocks at the architecture level.
- Own the team's rules for when to use each primitive and document them.

**Staff or Principal**

- Recognise when shared state has outgrown its synchronization strategy and drive the redesign (sharding, lock-free data structures, elimination of shared state).
- Own the org's conventions for atomic operations, memory-ordering reasoning, and performance-critical synchronization.
- Maintain the team's response to synchronization incidents (contention, deadlock, memory-ordering bugs).
- Stay current with language changes: \`sync.OnceFunc\` replacing hand-rolled Once patterns, \`atomic.Int64\` replacing function-based atomics, \`testing/synctest\` for deterministic tests.

---
`;
