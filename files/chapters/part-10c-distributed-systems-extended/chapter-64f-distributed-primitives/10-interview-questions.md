## Interview Questions

### Q1: Why are fencing tokens necessary for distributed locks, even when using a correct distributed lock implementation?

**What FAANG expects:** Kleppmann's canonical example: GC pause longer than TTL, lock expires, new holder acquires, old holder resumes and corrupts state. Correct distributed lock != safe without fencing at the storage layer. Bonus for naming etcd's CreateRevision / lease ID as the canonical fencing token, and for noting that this is why Redlock alone is considered unsafe.

**Answer:** Even a correctly implemented lock (e.g., backed by Raft) doesn't protect against the scenario where a lock holder pauses for longer than the lock TTL. Consider: Process A holds a lock with TTL=10s. GC pause, page fault, or OS scheduling delay keeps A paused for 15s. The lock expires. Process B acquires the lock. A wakes up and thinks it still holds the lock, proceeding to write to the shared resource. Both A and B are now "holding" the lock from their perspective. A fencing token (monotonically increasing number, e.g., etcd revision) solves this: the storage system rejects writes with a lower token than the last accepted write. B's token is higher than A's → B's writes succeed, A's writes are rejected.

**Follow-ups:**
- *What does the storage layer actually do with the token?* On write, compare the incoming token against the highest previously seen. Reject if lower. Implementable in S3 via conditional writes on `If-Match` ETags, in Postgres via a check against a `version` column, in DynamoDB via ConditionExpression.
- *Can you fence S3 writes?* Yes, via conditional PUT with `If-Match` on ETag, or by prepending the token to the key path and enforcing ordering at a higher layer.
- *Why not just make the lock TTL longer?* Longer TTL means longer unavailability window after a real crash (nobody can re-acquire until it expires). Fencing tokens let you keep TTL short and still be safe against delayed processes.

### Q2: What is the split-brain problem in leader election, and how does Raft prevent it?

**What FAANG expects:** Partition into two groups, both elect leaders, both accept writes, state diverges. Raft prevents it by requiring majority quorum for election *and* for write commit. The minority-side leader cannot commit anything. Bonus for explaining that terms being monotonically increasing ensures a stale leader, when it reconnects, sees a higher term and steps down before doing damage.

**Answer:** Split-brain occurs when two nodes simultaneously believe they are the leader. In a 3-node cluster during a network partition (1-2 split), both sides may elect a leader and start writing. Raft prevents this by requiring majority (quorum) for any write to proceed. With 3 nodes, majority = 2. The partition side with 2 nodes can elect a leader. The side with 1 node cannot elect a leader. All writes go through the majority side. After healing, the minority node catches up. The term number (monotonically increasing per election) ensures the new leader's term > old leader's term, so stale leaders that wake up after a pause will see they have an old term and step down.

**Follow-ups:**
- *What happens in an even-sized cluster (4 nodes)?* Quorum = 3, so you can survive 1 failure. Odd sizes are strictly better for the same tolerance. 5 nodes tolerate 2 failures (quorum=3), while 4 nodes also tolerate only 1 (quorum=3). Never run 4 or 6.
- *Can a stale leader write before it notices the higher term?* It can try, but its followers have already moved to the new term and reject its AppendEntries. The stale leader discovers the higher term from the rejection and steps down.
- *How does this interact with disk sync?* Raft writes must be `fsync`ed before acknowledging. A leader that forgets to fsync a write can survive a crash as a stale node, missing committed entries and violating safety. etcd fsyncs every batch.

### Q3: How does the Redis sliding window rate limiter differ from the token bucket, and when would you choose each?

**What FAANG expects:** Token bucket = burst allowance + steady-state rate. Sliding window = strict per-window count, smoother boundary behavior. The decision rule: legitimate burstiness tolerated → token bucket. Strict enforcement (anti-scrape, protect weak backends) → sliding window. Bonus for noting that sliding-window-log is exact but O(N) memory, and sliding-window-counter is a weighted approximation that is nearly always good enough.

**Answer:** Token bucket: a bucket fills up at a constant rate. Requests consume tokens. Allows bursts up to bucket capacity. After a burst, requests are smoothed to the refill rate. Sliding window: count requests in the last N seconds. Reject if count exceeds limit. More accurate for burst control - a burst at the end of one window + beginning of next is correctly counted. Token bucket can allow 2× the rate at window boundaries. Choose token bucket when: legitimate workloads need occasional bursts (e.g., batch API uploads). Choose sliding window when: strict burst control is needed (e.g., prevent scraping, protect weak backends from any burst).

**Follow-ups:**
- *Why is the fixed-window counter disasterous under the boundary case?* Two windows (00:00-01:00 and 01:00-02:00), limit = 100. A client sends 100 at 00:59 and 100 at 01:01. The server saw 200 requests in 2 seconds, but each window's counter says "100, within limit".
- *What is the memory cost of sliding-window-log?* One entry per request in the window. At 1k req/sec with a 1-minute window per user, that is 60k entries per active user. Use log only when strict accuracy matters (billing), and use counter elsewhere.
- *How do you implement sliding window in Redis without a Lua round-trip per request?* Sorted set: `ZADD key now now`, `ZREMRANGEBYSCORE key 0 (now - window)`, `ZCARD key`. Pipelined, that is a single round-trip. For extreme throughput, local approximation + periodic sync.

### Junior → FAANG: Structuring Answers That Survive Follow-Up Pressure

The three questions in this section share a structural pattern: an opening question that tests whether you know the concept, followed by follow-ups that test whether you understand why. The opening question answer is the easy part. The follow-ups are where interviews are won or lost.

For Q1 (fencing tokens): the opening answer covers the GC-pause scenario. The follow-up about implementing fencing at the storage layer is where you should be able to describe at least two concrete mechanisms: Postgres version column with a conditional update (`UPDATE resource SET value = X WHERE fencing_token >= Y`), and DynamoDB ConditionExpression (`attribute_not_exists(fencing_token) OR fencing_token <= :incoming`). Saying "the storage layer rejects stale writes" without naming a concrete mechanism is incomplete.

For Q2 (split-brain and Raft): the opening answer covers the quorum requirement. The follow-up about even-sized clusters is a classic trap. The correct answer is that 4 nodes provide no more fault tolerance than 3 nodes (both require quorum of 3), but 4 nodes require one extra machine and add complexity to the network. This is why 3 and 5 are standard Raft cluster sizes and 4 is never used. Knowing this rule and being able to explain the math (quorum = floor(N/2) + 1) distinguishes candidates who have read the theory from those who have memorized talking points.

For Q3 (token bucket vs sliding window): the follow-up about the fixed-window boundary case is a standard distributed systems interview question. Preparing the concrete example (100 requests at 00:59, 100 at 01:01, 200 requests in 2 seconds but each window counter says "under limit") is the answer to memorize. It also motivates why the sliding window log approach exists and why the sliding window counter approximation (weighted average of current and previous window) is almost always sufficient without the memory cost.

For each question: after practicing the opening answer, have a friend ask the three follow-ups in sequence and time your responses. If any follow-up takes more than 30 seconds to answer, that is a preparation gap.

### Senior @ FAANG: Extending These Questions to the L6 Depth Bar

The three questions as written test L5 (senior engineer) depth. At L6 and above, the same topics are probed with an additional layer of design and consequence reasoning.

For Q1 at L6: after explaining fencing tokens, the interviewer will ask "design the fencing enforcement for a system where the storage layer is S3, which does not support conditional writes on arbitrary fields." The answer requires deriving a solution: use S3 object versioning (ETag-based conditional PUT with `If-Match`), or use a serializing layer in front of S3 (a lightweight service that serializes writes and enforces fencing by comparing the incoming token against the last written token in a small database). The ability to design around the limitations of a specific storage system demonstrates L6 breadth.

For Q2 at L6: after explaining Raft split-brain prevention, the interviewer will ask "what happens in a 5-node Raft cluster during a [2-3] network partition where both partitions have an active leader from before the partition?" The answer: the 2-node partition leader cannot commit any new entries (needs 3 votes) but may continue processing reads if it is using leader leases or linearizable reads without a quorum refresh. The 3-node partition elects a new leader and commits new entries. After healing, the old 2-node leader discovers the higher term and steps down. The 2-node leader's uncommitted entries are overwritten. This scenario requires understanding both the election safety rule and the uncommitted-entries behavior, which is the L6-level detail.

For Q3 at L6: after explaining the rate limiter algorithms, the interviewer will ask "design a rate limiting system for a globally distributed API with 10 regions that must enforce a global per-customer rate limit with at most 10% error margin." The answer involves the local pre-filtering architecture (each region maintains a local counter using each region's fair share, plus margin), periodic synchronization across regions (gossip or centralized aggregation every 100ms), and the tradeoff analysis (10% margin means the per-region allocation is 110% of per-region fair share, accepting up to 10% global overrun during synchronization windows). This is the architecture used by Cloudflare and Fastly for their global rate limiting and requires thinking about the problem at distributed fleet scale, not single-datacenter scale.

---
