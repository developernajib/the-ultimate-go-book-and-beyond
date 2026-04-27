export default `## Exercises

These exercises build on the synchronization primitives covered in this chapter. Each one targets a different primitive or combination, progressing from moderate to advanced difficulty.

1. **Thread-Safe Priority Queue** (Mutex, Cond): Implement a concurrent priority queue where \`Enqueue\` inserts items by priority and \`Dequeue\` blocks until an item is available using \`sync.Cond\`. Support context cancellation on \`Dequeue\` so callers can time out.

2. **Rate-Limited Pool** (Mutex, WaitGroup, atomic): Build a connection pool that enforces a per-second ceiling on new connection creation. Use a token bucket internally to throttle \`factory\` calls, and expose pool statistics via atomic counters.

3. **Read-Copy-Update (RCU)** (atomic.Pointer): Implement the RCU pattern for a routing table: readers load the current table via \`atomic.Pointer\` with zero locking, while writers build a complete replacement table and swap the pointer atomically. Verify with the race detector that no data race exists under concurrent read/write load.

4. **Sharded Counter** (atomic, runtime): Create a counter that distributes increments across \`runtime.GOMAXPROCS\` shards, each backed by its own \`atomic.Int64\`, to eliminate cache-line contention. \`Value()\` should sum all shards. Benchmark it against a single \`atomic.Int64\` under high core counts.

5. **Concurrent Trie** (RWMutex, fine-grained locking): Implement a thread-safe trie (prefix tree) for autocomplete. Use per-node \`sync.RWMutex\` locks so that lookups on disjoint prefixes proceed in parallel while insertions lock only the affected path from root to leaf.

### Senior at FAANG Track

6. **Mutex-profile workflow.** For one production service, enable mutex profiling. Capture profiles during a representative load period. Identify the top three contention sites. Propose and implement fixes. Measure impact. Write up as a case study for the team.

7. **Audit sync.Map usage.** Find every \`sync.Map\` in your codebase. For each, determine whether the access pattern fits its intended use (read-mostly, stable keys, disjoint-key writes). Convert the ones that do not to mutex-protected \`map[K]V\`. Benchmark before and after.

8. **Migrate to typed atomics.** For a codebase using the old \`atomic.LoadInt64(&x)\` / \`atomic.StoreInt64(&x, v)\` function forms, migrate to Go 1.19+ typed atomics (\`atomic.Int64\`). Document readability and type-safety improvements.

### Staff / Principal Track

9. **Synchronization convention guide.** Author the org's one-page guide on which primitive to use when. Include team-specific examples and pitfalls. Socialise with the senior pool. Publish and maintain.

10. **Contention dashboard.** Design a Grafana dashboard showing mutex contention per service. Set alerts on contention-event-rate trending upward. Pilot on three services. Document the incidents it catches.

11. **High-contention redesign case study.** Identify a historical service incident caused by mutex contention. Document the redesign that resolved it (sharding, lock-free structure, elimination of shared state). Turn into teaching material for the team.

12. **Shared synchronization helpers library.** If your org does not have one, design and ship a shared library with type-safe wrappers around common patterns: generic \`SyncMap[K, V]\`, sharded counter, atomic configuration holder, bounded semaphore. Drive adoption across services.

13. **Retire RWMutex.** In many codebases, \`sync.RWMutex\` is overused where \`sync.Mutex\` would be faster or equivalent. Audit and convert where appropriate. Measure the before-and-after. Write up the findings.
`;
