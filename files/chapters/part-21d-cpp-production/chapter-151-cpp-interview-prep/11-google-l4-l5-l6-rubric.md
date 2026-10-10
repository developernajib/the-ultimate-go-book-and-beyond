## Google L4 / L5 / L6 Rubric for C++ Engineers

Google's leveling for software engineers (SWE) ranges from L3 (new grad) to L11 (Senior Fellow). For a C++ infrastructure engineer, the relevant levels in interviews are L4 (SWE II), L5 (Senior SWE), and L6 (Staff SWE). The rubric is not public in detail, but the public levels.fyi data, the SRE Workbook, and the Google interview guide give a clear picture. This file maps each dimension to concrete C++ behaviors.

### The Four Dimensions

Every Google interview is scored on four dimensions:

1. General Cognitive Ability (problem solving).
2. Role-Related Knowledge (RRK).
3. Communication.
4. Googliness and Leadership.

Coding rounds emphasize 1, 2, and 3. System design emphasizes 1, 2, and 3 with a heavier RRK component. Behavioral emphasizes 4. Each dimension is rated on a 4-point scale (Poor, Mixed, Good, Excellent). Hiring committee weighs the bundle.

The level you are leveled to depends on the bar, not the rating. L4 needs Good across the board. L5 needs Good with some Excellent (especially in RRK and design). L6 needs Excellent with leadership signal in behavioral.

### L4: SWE II

The expectation: you write production C++ for a feature without much hand-holding. You own a component within a service. You participate in design reviews but do not drive them.

#### L4 Coding Behaviors

- Modern C++ fluency. Range-for loops, structured bindings, `std::optional`, `std::variant`, lambdas with captures, `std::move`, smart pointers used correctly.
- Implements correct solutions to standard problems (graph BFS/DFS, two pointers, intervals, hashing, common DP) in 25 minutes.
- Writes code that compiles. Edge cases (empty input, single element, overflow on `int`) are checked.
- Explains time and space complexity clearly. Knows when to use `std::unordered_map` vs `std::map`.

#### L4 Design Behaviors

- Can design a single service: pick a storage layer, define an API, sketch deployment.
- Knows the difference between SQL and NoSQL stores at a basic level.
- Identifies the obvious failure modes (downstream timeout, retries).

#### L4 Communication

- Asks clarifying questions before coding.
- Walks through the approach before typing.
- Does not go silent for 5 minutes.

#### L4 Disqualifiers

- Cannot write code without a syntax reference.
- Reaches for `goto` or raw `new` / `delete` for object lifetime.
- Confused about reference vs pointer semantics.
- Uses `std::endl` everywhere thinking it is the only newline (a tell that they have not looked at perf, since `std::endl` flushes).

### L5: Senior SWE

The expectation: you own a substantial component or feature area. You drive design. You mentor L4s. You are trusted with shipping decisions that affect the team.

#### L5 Coding Behaviors

L4 fluency plus:

- Lock-free patterns: knows when an `std::atomic<T>` flag suffices, when a `compare_exchange_weak` loop is needed, when to drop to a real lock.
- Memory ordering: can explain `std::memory_order_relaxed`, `acquire`, `release`, `seq_cst` and pick the right one with a defensible reason.
- Performance instincts: avoids quadratic where linear is possible, knows when a hashmap costs more than a sorted vector for small N, profiles before guessing.
- Ownership semantics: knows when to take by `unique_ptr&&`, when by const reference, when by value. Does not allocate where the caller's lifetime suffices.
- Templates: can write a small generic algorithm, knows when SFINAE vs `if constexpr` vs concepts (C++20) applies.

#### L5 Design Behaviors

- Designs a system across services: sharding scheme, replication, caching layers, failure boundaries.
- Picks the right consistency model. Eventually consistent for analytics counters, strong for financial state.
- Discusses trade-offs explicitly: throughput vs latency, cost vs durability, consistency vs availability.
- Identifies non-obvious failures: thundering herd on cold cache, retry amplification, hotspot keys.
- Knows the storage hierarchy: register, L1/L2/L3 cache, RAM, NVMe, SATA SSD, network, disk, tape. Within an order of magnitude on latencies.

#### L5 Communication

- Drives the conversation, does not just respond.
- Pushes back on the interviewer's prompts when warranted ("we could shard by user, but the access pattern is by org, so let me design around that").
- Recognizes when to simplify ("for the prototype, single instance is fine, here is the plan to scale later").

#### L5 Behavioral

- Tells stories of mentoring junior engineers.
- Conflict resolution: a recent disagreement with a senior peer, how it was resolved.
- Has driven a project that affected multiple teams.

### L6: Staff SWE

The expectation: you own a system that spans multiple teams. You are a technical leader. You drive multi-quarter strategy. Your impact is measured in business outcomes, not features.

#### L6 Coding Behaviors

L5 fluency plus:

- Can design and implement primitives that other engineers build on: a thread pool, a lock-free queue, a custom allocator.
- Knows when to write 100 lines of careful code vs 1000 lines of obvious code, and articulates the choice.
- Writes code with the next reviewer in mind. Names, comments, and structure communicate intent.

The L6 coding round is often the same problem as L5, but the bar is higher: cleaner code, fewer bugs, deeper analysis of trade-offs, more thoughtful test cases.

#### L6 Design Behaviors

- Designs a multi-service system at planet scale: 100k QPS sustained, regional failover, multi-tenant isolation.
- Discusses migration strategy: how to roll out a new design while the old one is serving traffic, with no user-visible downtime.
- Anticipates the next two years: what changes, what holds, where the design must be flexible vs rigid.
- Knows the cost model: rough order-of-magnitude dollars per month for the proposed architecture.
- Pushes back on requirements that drive over-engineering. "We do not need 5 nines, 4 nines is enough at this scale, here is what that saves."

#### L6 Communication

- Frames the problem before solving. "What is the user-visible outcome we are optimizing for?"
- Distills complex trade-offs into 1-page summaries.
- Pushes for clarity when a question is fuzzy.

#### L6 Behavioral and Leadership

This is where L6 differs most from L5.

- Has led a team (formal or informal) through a multi-quarter project.
- Has set technical direction: picked a technology, built consensus, shipped it.
- Has hired or mentored multiple engineers to senior level.
- Has navigated organizational complexity: re-orgs, conflicting priorities, deprecated dependencies.
- Speaks in terms of business impact, not feature lists.

The behavioral round at L6 is two stories deep. The interviewer asks about a project, the candidate gives the headline, then drills into a specific decision, then drills into how the candidate built consensus around that decision, then asks what they would do differently. The depth is the differentiator.

### What Each Level Looks Like in a Coding Round

Same problem: "Implement an LRU cache with thread-safe access."

#### L4 Answer

Uses `std::list` and `std::unordered_map`. Wraps the data structure operations in a `std::mutex`. Correct, 30 lines, handles eviction. Discusses time complexity (O(1) get, O(1) put). Mentions "we could shard the lock for concurrency" if asked.

#### L5 Answer

Same data structure. Discusses lock contention up front. Offers two implementations: simple mutex (start here) and sharded version (N stripes, hash the key to pick a stripe). Correctly identifies that even sharded, the LRU ordering is across the whole cache, so eviction with strict global LRU loses scalability. Proposes per-shard LRU as a trade-off, explains the staleness window. Writes the simple version, leaves stubs for the sharded one.

#### L6 Answer

Frames first: "What are the access patterns? What is the working-set size? Is strict LRU required, or is approximate LRU acceptable?" Picks approximate LRU (CLOCK or W-TinyLFU) because at high QPS strict LRU is the bottleneck. Discusses memory cost of metadata, tail latency under contention, and how this cache integrates with a broader caching tier (in-process plus a distributed Memcached). Sketches the API, the eviction policy, and the metrics. Writes 50 lines, all the right ones.

### Senior at FAANG: Self-Assessing

Honest self-assessment is the prerequisite for moving up. The questions:

- L4 to L5: am I trusted to design a feature without supervision? Do I push back on bad designs? Have I shipped something that another team depends on?
- L5 to L6: have I led a project that shipped on schedule and met its goals? Do other engineers seek my technical opinion? Have I set direction that the team followed?

If the answer is no, the work is to find that scope, not to interview for the next level. The interview reflects the work. Faking it is detected by the rubric.
