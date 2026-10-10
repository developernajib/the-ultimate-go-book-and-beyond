## Exercises

1. **Consistent Hash Ring in Go**: Implement a consistent hash ring in Go with support for virtual nodes (configurable replication factor), node addition and removal with automatic key redistribution reporting, and a `Lookup(key string) Node` method with O(log n) complexity using binary search. Benchmark against a map-based implementation at 1M, 10M, and 100M keys. Write tests verifying that adding a node redistributes no more than `keys / (n+1)` keys on average.

2. **Cache Eviction Policies (LRU/LFU/ARC)**: Implement LRU, LFU, and ARC (Adaptive Replacement Cache) eviction policies in Go behind a common `Evictor` interface. Benchmark each policy against a Zipf-distributed access pattern (skew=1.2) with a cache size of 10,000 and a working set of 100,000 keys. Document the hit rate for each policy and explain why ARC outperforms both LRU and LFU on mixed workloads with shifting access patterns.

3. **Cache Stampede with Mutex and Singleflight**: Simulate a cache stampede scenario where 1,000 goroutines simultaneously request an expired key that takes 200ms to regenerate from the database. Implement three solutions - no protection (baseline), a per-key mutex, and `golang.org/x/sync/singleflight` - and measure the number of database calls, total latency, and goroutine contention for each. The singleflight solution must result in exactly one database call regardless of concurrent requestors.

4. **Write-Through vs Write-Back Cache**: Design and implement both write-through and write-back (write-behind) cache strategies in Go. The write-back implementation must batch writes into groups of 100 or flush after 500ms (whichever comes first), handle application crashes without data loss using a write-ahead log, and recover pending writes on restart. Benchmark write throughput for both strategies at 10K, 50K, and 100K writes/second and document the durability trade-offs of each approach.

5. **Distributed TTL Expiry System**: Design a distributed TTL expiry system for a cache cluster of 10 nodes where each node is responsible for expiring its own keys but expiry events must be broadcast to all nodes holding replicas. Implement lazy expiration (check on read) combined with an active expiration background sweep that processes no more than 100 keys per 100ms per node to avoid latency spikes. Measure and bound the maximum memory overhead of keys that have logically expired but not yet been physically removed.

6. **Cache Warming Strategy for Cold Starts**: Design a cache warming strategy for a distributed cache that must serve 95% of traffic from cache within 60 seconds of a cold start (all cache nodes empty). The strategy must support three warming sources - a recent snapshot dump, a replay of the last hour of read traffic, and a predictive pre-fetch based on access frequency rankings - and must not overload the origin database during warming (cap at 20% of normal database RPS). Implement the warming coordinator in Go and write an integration test that validates the 95% hit rate target.

### Junior -> FAANG: Turning Exercises into Interview Preparation

The six exercises above are ordered by implementation complexity, and you should approach them in order. Each one builds a skill that the next one depends on.

Exercise 1 gives you consistent hashing. Exercise 3 gives you stampede prevention. Exercise 4 gives you write semantics and durability tradeoffs. These three together cover roughly 70% of distributed cache interview questions.

For exercise 3, the benchmark result you want to cite in an interview is: "With no protection, 1,000 concurrent goroutines each hitting the same expired key generate 1,000 database calls and 1,000x latency under load. With `singleflight`, they generate exactly 1 database call. The latency for each goroutine is the fetch latency, not the fetch latency times 1,000." Being able to cite benchmark numbers from your own experiments, even approximate ones, signals that you have actually run the code and not just read about it.

For exercise 6, the cache warming problem teaches a design skill that extends beyond caching: how do you bring a stateful system to a ready state without overwhelming the systems it depends on? The rate limiting constraint (cap at 20% of normal database RPS) is the crux. The warming coordinator must implement a token bucket or leaky bucket rate limiter that controls the warming throughput, not just the number of concurrent fetches.

A first-job habit: for each exercise, write a one-paragraph post-mortem after completing it. What was harder than you expected? What assumption did you make that turned out to be wrong? This reflective practice is what turns exercise completion into genuine learning.

### Senior @ FAANG: Exercise Design as a Platform Thinking Skill

The exercises above are standalone implementations. At staff level, the question is not "can you implement a consistent hash ring?" but "what is the right abstraction boundary for a consistent hash ring in a caching platform, and how does it compose with the other components?"

**Exercise 1 extended: the hash ring as a platform primitive**

A consistent hash ring that is only usable internally to the cache client is limited in value. A platform-grade hash ring exposes a `Watcher` interface that notifies registered components when the ring topology changes. When a node is added or removed, the warming coordinator (exercise 6) subscribes to these events and pre-warms the new node with the keys that will be remapped to it. This composition between the hash ring and the warming coordinator is a platform design decision, not an implementation detail. The exercises teach the components in isolation. A staff engineer connects them.

**Exercise 4 extended: WAL design as a distributed systems contract**

The write-ahead log in exercise 4 is described as "handle application crashes without data loss." At FAANG, the WAL is also the foundation for replication (the replication log in the summary is a WAL variant), cross-datacenter synchronization (the WAL is shipped to remote regions), and audit trails (the WAL provides a complete history of writes). A WAL designed only for crash recovery is a missed opportunity. The correct platform WAL design includes: a sequence number per entry (enables log-based replication), a timestamp per entry (enables point-in-time recovery), and a checksum per entry (enables corruption detection). These are not premature optimizations. They are platform capabilities that cost nothing to add at design time and are very expensive to retrofit.

**Exercise 6 extended: cache warming SLO as a deployment gate**

The 95% hit rate within 60 seconds is a user-observable SLO. A principal engineer proposes making this SLO a deployment gate: the CI/CD pipeline must verify the warming SLO in a staging environment before promoting a new cache version to production. The integration test in exercise 6 becomes a deployment verification step. This is the difference between an exercise and a production-grade reliability practice. The exercise teaches you to write the test. The platform thinking teaches you where to run it.
