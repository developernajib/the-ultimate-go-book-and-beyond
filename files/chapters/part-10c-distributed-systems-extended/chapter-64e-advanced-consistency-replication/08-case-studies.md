## Case Studies

### Case Study 1: Amazon DynamoDB Consistent Reads

**Design**: DynamoDB offers both eventual consistency and strong consistency for reads.
- **Eventual**: Read from any replica (~1ms, cheaper). May see stale data.
- **Strong**: Read from the leader replica only (~3ms, costs 2× RCUs). Always up-to-date.

**Implementation**: DynamoDB uses a variant of Multi-Paxos for leader election within each shard (partition). Strong reads contact the shard leader, eventual reads contact any replica.

**Key insight**: 99% of DynamoDB applications use eventual consistency. The 1ms latency difference is imperceptible but the 2× cost difference is significant at scale. Only use strong consistency when reads must reflect immediately prior writes (e.g., after a write, read-your-own-writes).

### Case Study 2: CockroachDB's Hybrid Logical Clocks

**Problem**: Google Spanner uses atomic clocks (TrueTime) for commit wait - waiting until the uncertainty window passes (~7ms). CockroachDB couldn't afford hardware atomic clocks.

**Solution**: Hybrid Logical Clocks (HLC) provide causal ordering with physical time closeness (~few ms) using only software. CockroachDB ensures: if transaction A commits before transaction B starts (in real time), A's HLC timestamp < B's.

**Implementation in Go**:
- Each node maintains an HLC
- On transaction start: `ts = hlc.Now()`
- On cross-node communication: include `ts` in request headers. Receiver calls `hlc.Receive(ts)`
- Commit timestamps are assigned as `max(HLC.Now(), max_received_ts)` ensuring causality

**Result**: Full serializable isolation without atomic hardware. CockroachDB tolerates clock skew up to a configured maximum offset (500ms by default) and handles timestamp uncertainty with transaction restarts rather than Spanner's commit-wait, trading occasional retries for the ability to run on commodity clocks.

### Case Study 3: Redis Cluster Replication Tradeoffs

**Architecture**: Redis Cluster uses asynchronous replication. Writes are acknowledged to clients BEFORE being replicated to replicas.

**CAP choice**: Availability over consistency. During a partition:
- If master is lost, a replica is promoted
- But un-replicated writes (acknowledged to clients) are lost
- This violates linearizability: client was told "success", but data doesn't survive the failure

**Use cases where this is acceptable**: Shopping cart (losing a cart item < losing the order), session data (user re-logs in), rate limiting (slightly higher rate briefly).

**Use cases where this is NOT acceptable**: Financial balances, inventory counts, user ID uniqueness.

**Lesson**: Choose your consistency model based on the business requirements, not the database's marketing. Always ask: "What happens if a replica is promoted and loses the last N writes?"

### Junior → FAANG: Extracting Transferable Lessons from Case Studies

Each case study in this section follows the same structure: a design decision, its tradeoff, and the context that made it the right choice. For interview preparation, the goal is to extract the decision pattern so you can apply it to new scenarios.

From the DynamoDB case: the lesson is not "use DynamoDB." It is "99% of reads in many systems can tolerate eventual consistency, and strong consistency should be reserved for the cases where it is genuinely required." In an interview, this translates to: "I would use eventually consistent reads for the product catalog (high read volume, can tolerate 1-second staleness) and strongly consistent reads for inventory counts (must reflect the latest reservations)."

From the CockroachDB HLC case: the lesson is "you do not need GPS-synchronized atomic clocks to achieve serializable distributed transactions." HLCs are the right answer to the system design question "how would you implement serializable transactions across data centers without Google's hardware?" The HLC algorithm is small enough to implement from scratch in an interview if asked.

From the Redis case: the lesson is "understand your database's failure mode before declaring your SLA." The Redis asynchronous replication means that the last N acknowledged writes can be lost on leader failure, which makes Redis unsuitable as the primary store for financial balances or inventory counts despite its high throughput. The correct use of Redis is as a cache or as a best-effort rate limiter, not as the source of truth for correctness-critical data.

Practice: for each case study, write two sentences describing the failure mode that is acceptable and two sentences describing the failure mode that is not acceptable. This forces you to internalize the tradeoff rather than memorizing the outcome.

### Senior @ FAANG: Case Studies as ADR Templates for Your Own Systems

At the senior level, case studies from production systems at Amazon, Google, and Redis Labs are templates for the architecture decision records you need to write when making similar choices in your own systems. Each case study answers the same five questions that a good ADR must answer: what problem is being solved, what options were considered, what was chosen and why, what tradeoffs were accepted, and what are the conditions under which this decision should be revisited.

DynamoDB's strong/eventual read split maps to the ADR question: "Under what conditions should a service use strongly consistent reads?" The DynamoDB answer is "when the read must reflect a write that the caller just performed (read-your-own-writes) or when the read determines the correctness of a subsequent write." Everything else uses eventual consistency. Encoding this as an organization standard (rather than leaving it as per-team judgment) prevents engineers from defaulting to strong consistency out of caution and paying the performance cost everywhere.

CockroachDB's HLC design addresses the ADR question: "How do we achieve serializable isolation across geographically distributed data centers without proprietary hardware?" The answer is HLCs with bounded clock skew. The bounded skew requirement translates to an operational dependency: the team must run NTP with monitoring and set alerts when clock skew on any node exceeds 250ms. Without the operational commitment, the architectural choice is invalid. This is a pattern in distributed systems: the correctness of the algorithm depends on an operational invariant that must be enforced separately.

The Redis case study is the most important for platform governance because Redis misuse is extremely common. The ADR for Redis usage should explicitly list: what Redis may be used for (cache, rate limiting, session storage, pub/sub, best-effort queues) and what it may not be used for (source of truth for financial data, inventory counts, anything requiring durability guarantees stronger than "best effort"). This ADR should be enforced at the service review level, not just documented.

Bar-raiser indicator: a senior candidate discussing Redis or DynamoDB in a system design interview who can immediately articulate the specific failure mode under which acknowledged writes can be lost, name the conditions that trigger it, and propose a specific mitigation (for Redis: use a Raft-backed store for correctness-critical data and Redis as a write-through cache, and for DynamoDB: use conditional writes to ensure idempotency on retry) is demonstrating the depth expected at L6.

---
