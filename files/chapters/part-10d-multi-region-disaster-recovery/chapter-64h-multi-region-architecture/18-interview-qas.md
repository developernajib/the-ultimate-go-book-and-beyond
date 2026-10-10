## Interview Questions

**Q1: When would you choose active-passive over active-active?**

**What FAANG expects:** Active-passive when data model cannot tolerate conflicts (financial ledgers, unique inventory) or when the operational cost of multi-master outweighs the RTO savings. Active-active for lower latency and near-zero RTO. Bonus for naming CockroachDB/Spanner's range-lease hybrid (active-active for reads, single-leader per range for writes) as the 2026 pragmatic default.

Active-passive makes sense when your data model cannot tolerate any write conflicts, for example a financial ledger where double-spend prevention is non-negotiable. Active-active trades conflict-handling complexity for lower read/write latency for globally distributed users and eliminates the RTO (Recovery Time Objective) penalty of promoting a passive standby. In practice, most modern systems use active-active for reads and limit writes to a designated primary within each data partition. This is what Cockroach DB and Spanner do with their range-lease model.

**Q2: Explain vector clocks vs. Lamport timestamps. When does each break down?**

Lamport timestamps give a total ordering of events but cannot distinguish concurrent events from causally ordered ones. If two events have different Lamport timestamps you cannot tell whether one caused the other or they raced. Vector clocks assign a counter per node and support the `happened-before` relation precisely: `A → B` iff `A[i] ≤ B[i]` for all nodes `i` with at least one strict inequality. The cost is O(N) storage per event where N is the node count. At large scale (hundreds of nodes) this becomes expensive. Dotted Version Vectors and interval tree clocks offer compression strategies. Neither Lamport nor vector clocks handle Byzantine failures - for that you need PBFT or HotStuff.

**Q3: How do you guarantee exactly-once semantics for cross-region replication?**

You cannot guarantee exactly-once delivery at the network layer. You guarantee exactly-once *processing* through idempotent consumers. Each replication event carries a globally unique ID. The consumer maintains a deduplication table (keyed by event ID) with a TTL longer than the maximum redelivery window. Before applying an event, the consumer checks this table, and if present, it skips processing and acknowledges delivery. Kafka's transactional producer API combined with Kafka Streams checkpointing gives you effectively-once within the Kafka ecosystem. For cross-cluster replication, MirrorMaker 2 preserves offsets but you still need application-level idempotency.

**Q4: What is a Hybrid Logical Clock (HLC) and when should you use one over a plain wall clock?**

An HLC combines a physical wall clock with a logical counter to produce timestamps that are monotonically increasing, closely track real time (within NTP skew), and capture causality. The format is `(physical_time_ms, logical_counter)`. On every send/receive the HLC advances to `max(local_physical, remote_physical) + 1 logical`. This solves the primary failure mode of plain LWW: two events written milliseconds apart on machines with clock skew may be assigned the same or reversed wall-clock timestamps. HLC timestamps remain comparable to wall clock time, which makes them suitable for TTL expiry, audit logs, and user-visible "last modified" fields. Use HLC anywhere you need LWW semantics with correctness guarantees under NTP skew of up to a few hundred milliseconds.

**Q5: Walk me through the full sequence when a region's health score drops to zero.**

1. The `HealthLoop` updates the region's health score atomically.
2. On the next `evaluate` tick the `Controller` detects the score is below `HealthThreshold`.
3. The controller checks that at least `MinHealthyRegions` will remain after draining. If not, it logs a warning and skips.
4. `drainRegion` is called in a goroutine. It marks the region as `Draining` and calls `shifter.DrainRegion`, which linearly ramps the region's traffic weight from its current value to zero over `DrainDuration`.
5. The traffic shifter updates the in-process weight map on each step. The load balancer (Envoy, NGINX, or a service mesh sidecar) reads these weights via xDS or a control-plane API and updates its upstream pool.
6. Once the weight reaches zero the region is marked `Standby`. All new requests route elsewhere while in-flight requests complete naturally.
7. A `failover.Event` is appended to the audit history and the `Notifier` fires (Slack, PagerDuty).
8. The `HealthLoop` continues probing the drained region. When its score exceeds `RecoveryThreshold` the controller calls `restoreRegion`, marks it `Secondary`, and the next rebalance cycle redistributes traffic back.

**Q6: What is the difference between RPO and RTO, and how does active-active affect both?**

**What FAANG expects:** RPO = max acceptable data loss (time). RTO = max acceptable downtime. Active-passive RPO equals replication lag, RTO equals detect + promote time. Active-active drives both toward zero at the cost of write-path complexity. Bonus for citing AWS SLA numbers (Route 53 failover ~60s typical, RDS cross-region replica promotion minutes) and for knowing that truly zero-RPO requires synchronous replication, which means every write pays the cross-region latency.

RPO (Recovery Point Objective) is the maximum acceptable data loss measured in time: how old can the most recent backup/replica be when disaster strikes? RTO (Recovery Time Objective) is the maximum acceptable downtime before service is restored. Active-passive typically has an RPO equal to the replication lag (seconds to minutes) and an RTO equal to the time to detect failure and promote the standby (minutes). Active-active, when properly implemented, achieves near-zero RPO (async replication lag is milliseconds) and near-zero RTO (no promotion step, since other regions already serve traffic). The trade-off is the engineering cost of conflict resolution and the operational complexity of multi-master writes.

**Q7: How do you handle a split-brain scenario in an active-active deployment?**

Split-brain occurs when a network partition causes two regions to each believe the other is dead and both promote themselves to primary. Mitigations:

1. **Quorum writes**: require acknowledgment from a majority of regions before confirming a write. This sacrifices availability for consistency (CP under CAP).
2. **Fencing tokens**: every node holding a lock carries a monotonically increasing token. Any operation carrying a stale token is rejected by the storage layer.
3. **Epoch-based leases**: use a distributed consensus system (etcd, ZooKeeper) to issue time-limited leases. A node without a valid lease refuses writes.
4. **CRDT data models**: sidestep split-brain entirely by using data structures that merge deterministically. Conflicts become merges rather than errors.
5. **Tie-break by region priority**: configure a total ordering of regions. During a partition the lower-priority region demotes itself rather than allowing both to accept writes.

---

### Junior -> FAANG: Using These Q&As as Structured Practice

The seven questions in this section cover the core concepts that appear in FAANG system design interviews for senior engineer roles. For each question, practice answering out loud (not just reading the answer). Interviewers evaluate whether you can articulate trade-offs clearly, not whether you have memorized the correct answer.

The "what FAANG expects" callouts are your calibration signals. If your mental answer to Q1 included only the basic active-passive versus active-active distinction without mentioning the CockroachDB/Spanner range-lease hybrid, you have a gap to fill. If your answer to Q6 on RPO and RTO included AWS SLA numbers and the synchronous replication trade-off, you are in strong shape.

For Q5 (the full failover sequence), practice narrating the entire sequence as a story, connecting each step to the specific code in the chapter. Interviewers appreciate candidates who can ground abstract system design in concrete implementation details. Saying "on the next controller tick, the evaluator detects the score is below HealthThreshold and launches a drainRegion goroutine, which linearly ramps the weight to zero" is more credible than saying "the system automatically detects unhealthy regions and redirects traffic."

### Senior @ FAANG: Bar-Raiser Signals and L6/L7 Framing for These Questions

**Q1 (active-passive vs. active-active) at L6+.** The expected answer from a bar-raiser perspective goes beyond the basic trade-off. L6 signals: mention that the choice is per-entity-type, not per-system. The user profile table may be active-active while the payment ledger is active-passive, within the same service. L7 signals: discuss the organizational governance implications of making this choice per-table: who owns the conflict resolution strategy for each table, how is it documented, how do new engineers learn which tables use which strategy?

**Q2 (vector clocks vs. Lamport timestamps) at L6+.** L6 signals: name dotted version vectors and interval tree clocks as production-scale alternatives to naive vector clocks. L7 signals: discuss the clock GC problem (how do you reclaim entries for decommissioned nodes?) and the serialization stability problem (what happens when you rename a node?). These are operational concerns that only appear at large scale and distinguish staff-level thinking from implementation-level thinking.

**Q3 (exactly-once semantics) at L6+.** L6 signals: correctly identify that exactly-once *delivery* is impossible, but exactly-once *processing* is achievable via idempotent consumers. L7 signals: discuss the deduplication window TTL choice. Too short, and a redelivery after the window re-applies the event. Too long, and the deduplication store grows indefinitely. The correct TTL is the maximum redelivery window plus a safety margin, derived from the Kafka consumer group commit interval and the maximum broker retention period.

**Q4 (HLC) at L6+.** L6 signals: explain the `(physical_ms, logical_counter)` encoding and the merge rule. L7 signals: discuss HLC failure modes. If a machine's wall clock jumps forward 5 years (NTP misconfiguration), its HLC timestamps become invalid for 5 years and break the "closely tracks real time" guarantee. Production HLC implementations include a clock skew limit: if the remote physical time is more than N seconds ahead of local time, reject the event and alert, rather than adopting a timestamp that would make local events appear arbitrarily old.

**Q7 (split-brain) at L6+.** The five mitigations listed are correct. The bar-raiser follow-up is: "Can you implement fencing tokens in Go?" The answer demonstrates whether the candidate understands the mechanism, not just the name. A fencing token is a monotonically increasing integer issued by the lock server. Storage operations must include the token and reject requests with tokens lower than the current maximum. Implementing this requires atomic compare-and-swap in the storage layer, not just at the lock server.
