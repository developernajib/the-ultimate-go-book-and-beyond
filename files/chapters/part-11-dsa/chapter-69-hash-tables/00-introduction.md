# Chapter 69: Hash Tables

> *"Hash tables are arguably the single most important data structure known to mankind."* - Steve Yegge

A hash table is a data structure that maps keys to values using a hash function to compute a storage index, enabling average-case O(1) insertion, deletion, and lookup. The hash function converts a key of arbitrary type into an integer index into a backing array. When two keys hash to the same index (a collision), the table resolves the conflict via chaining (storing a linked list at each bucket) or open addressing (probing for the next available slot). The result is a structure that scales from a 10-element configuration store to a distributed key-value store spanning many machines while maintaining near-constant access time.

Hash tables are among the most frequently used data structures in coding interviews. The pattern is ubiquitous: whenever a brute-force O(n²) solution requires checking "have I seen this element before?" or "what is the complement of this value?", a hash table transforms the problem to O(n) with a single pass. Two-sum, group anagrams, longest substring without repeating characters, subarray sum equals k, find all duplicates: every one of these canonical problems reduces to a hash table lookup. Across large engineering organizations, proficiency with hash maps is treated as table stakes. If you cannot instinctively reach for a map to optimize a nested loop, you signal that your algorithmic intuition is underdeveloped.

Go's built-in `map` type is a production-grade hash table. Since Go 1.24 it is a Swiss Tables implementation: keys live in groups of 8 slots, and each group carries a 64-bit control word holding one 7-bit fingerprint (H2) per slot. A lookup compares all 8 fingerprints at once using SWAR arithmetic (SIMD-within-a-register: ordinary 64-bit integer operations that process 8 lanes in parallel), not vector SIMD instructions. The growth target is an average of 7 used slots per 8-slot group. Go maps are not safe for concurrent access, a deliberate design decision for performance, which is why the standard library also provides `sync.Map` for concurrent read-heavy workloads. In production Go services, maps appear everywhere: routing tables, cache layers, deduplication buffers, frequency counters, and configuration registries. Understanding when Go's built-in map is sufficient, when `sync.Map` is appropriate, and when to reach for a concurrent hash map from a third-party library is a mark of Go engineering maturity.

**What you'll learn in this chapter:**

- Hash function internals: what makes a good hash function, collision probability, and the avalanche effect
- Collision resolution strategies: separate chaining vs. open addressing (linear probing, quadratic probing, double hashing)
- Go map internals: Swiss Tables groups, control words and fingerprints, load factor, incremental growth, and why map iteration order is randomized
- The frequency counter pattern for anagram detection, character counting, and histogram problems
- Two-sum and k-sum patterns: transforming O(n²) nested loops into O(n) single-pass hash map lookups
- Designing a hash map from scratch in Go: implementing `Put`, `Get`, `Delete` with chaining
- `sync.Map` vs. `map` + `sync.RWMutex`: when to use each and the performance implications
- Advanced patterns: rolling hash for Rabin-Karp substring search, hash set for cycle detection, and consistent hashing in distributed systems

**Why this matters in interviews:**

Hash tables show up in a large fraction of coding interview rounds, rivalled only by arrays in frequency. Interviewers routinely test whether a candidate identifies the "use a hash map" optimization immediately, and missing it on a problem like two-sum reads as a serious gap. Common screening questions (find duplicates, group anagrams, first unique character) all have hash map solutions as the expected answer. "Implement a hash map from scratch" is a standard design probe for systems knowledge. Consistent hashing is a distributed systems interview staple that builds directly on hash table fundamentals. Difficulty: Easy to Medium for application problems, Hard for design-from-scratch variants. Expected solve time for medium problems: 10 to 15 minutes.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), Go map syntax and struct types (Chapters 4-8).

### Junior -> FAANG: Building the Hash Table Intuition from Zero

The first gap most junior candidates reveal is reaching for a nested loop when the problem screams "use a map." Practice until the two-sum reflex is automatic: whenever you think "I need to check if I have seen X before," a hash map is the answer. Before your first interview, solve these LeetCode problems until your hands write the map-based solution without thinking: LC 1 (Two Sum), LC 49 (Group Anagrams), LC 347 (Top K Frequent), LC 128 (Longest Consecutive Sequence), LC 560 (Subarray Sum Equals K).

The second gap is not knowing what is and is not a valid Go map key. Fixed-size arrays (`[26]int`) are comparable and can be keys. Slices cannot. Structs whose fields are all comparable can be keys. Memorize this rule because interviewers test it directly in "implement from scratch" questions.

The third gap is concurrency blindness. In your first job, you will eventually write something like `go func() { m[key] = val }()` in a goroutine and create a race. Learn the detection command: `go test -race ./...`. Know the three solutions in order of preference: `sync.RWMutex` wrapper (general case), `sync.Map` (read-heavy, stable keys), sharded map (high-throughput writes).

Entry-level interview framing: when asked "what is the time complexity of map lookup in Go?", the correct answer is "O(1) amortized average case, O(n) worst case due to hash collisions, though Go's randomized hash seed makes adversarial worst-case inputs effectively impossible in practice."

### Senior @ FAANG: Hash Table Architecture, Governance, and Platform Thinking

**Hash table selection as an architectural decision.** At the L6 and above level, the question is not "should I use a hash map?" but "which hash map implementation is appropriate for this service tier, traffic pattern, and failure mode?" Go's built-in `map` is a single-node, non-concurrent structure. `sync.Map` trades higher per-operation cost for concurrent safety in read-heavy, stable-key workloads. A sharded map spreads writes across N independent locks, so contention falls with the number of shards as long as keys distribute evenly, and a hot key still serializes on its own shard. A distributed hash table (Redis, Memcached, consistent-hashing cluster) adds network latency but enables horizontal scale and cross-process sharing. Writing an Architecture Decision Record (ADR) that explicitly eliminates each option with a stated reason is the bar-raiser behavior interviewers look for when asking "how would you design a distributed rate limiter?"

**Consistent hashing as a platform primitive.** When distributed systems interview questions reference hash tables, they almost always escalate to consistent hashing. The naive approach, `key % num_nodes`, causes O(n) key migration when a node is added or removed. A consistent hash ring with virtual nodes reduces migration to O(k/n) keys per change. Senior candidates should be able to whiteboard: ring construction, virtual node count tradeoffs (more virtual nodes = smoother distribution, higher memory overhead), weighted nodes for heterogeneous hardware, and the failure scenario of a hot ring segment under skewed key distributions.

**Hash flooding and security posture.** Go's runtime computes a fresh random hash seed for each individual map, precisely to defend against hash-flooding denial-of-service attacks: an adversary who knows the hash function can craft keys that all land in the same bucket, degrading O(1) operations to O(n) and starving CPU. At the platform level, a senior engineer asks: "Is there any code path where user-controlled input populates a map with unbounded size and no rate limiting?" If yes, that is a critical security finding. The fix combines input validation (bound key count), rate limiting at the API layer, and optionally a HMAC-keyed hash for maps whose keys come from untrusted external sources.

**Memory overhead and GC pressure.** A map whose keys or values contain pointers (a string key holds one) must be scanned by the garbage collector, and every entry adds to the mark phase's work. Go's collector is concurrent, so this shows up mainly as sustained CPU spent marking and more frequent cycles rather than as long stop-the-world pauses, but on a map with millions of string keys the cost is real. Note the flip side: a `map[int64]int64` is pointer-free, and the GC can skip scanning it entirely. Staff-level engineers measure this with `go tool pprof` heap profiles and consider alternatives: flat arrays with binary search for small, immutable lookup tables. `github.com/cornelk/hashmap` or `github.com/puzpuzpuz/xsync` for lock-free concurrent maps with better GC profiles. Or encoding keys as integers (`int64` instead of `string`) to reduce allocations. The maturity model question is: "Do you measure GC impact of your data structure choices, or do you only measure throughput?"

**Maturity model for map usage in production services:**
- Level 1: Uses `map[string]T` everywhere, no concurrency awareness, no capacity hints.
- Level 2: Uses `make(map[K]V, estimatedSize)` to pre-allocate, wraps with `sync.RWMutex` when concurrent.
- Level 3: Profiles GC impact, chooses key types to minimize allocations, documents capacity sizing rationale.
- Level 4: Owns the decision between in-process and distributed hash tables, writes ADRs, defines SLOs for cache hit rate and eviction policy, instruments map size as a metric with alerting.

**Bar-raiser interview signals for L6+ roles:** Candidates who are asked to "implement a distributed cache" and immediately ask about consistency models (strong vs. eventual), eviction policies (LRU vs. LFU vs. TTL), cache stampede mitigation (probabilistic early expiration, mutex on first miss), and hot key amplification problems are operating at the staff level. Candidates who only discuss the LRU doubly-linked-list implementation are operating at the mid-level.

---
