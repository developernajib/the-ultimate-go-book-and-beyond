## Common Mistakes and How to Avoid Them

| Mistake | Impact | Fix |
|---------|--------|-----|
| Confusing "eventual" with "correct eventually" | Data loss accepted as normal | Define convergence SLA. use CRDTs or conflict resolution |
| Vector clock without version pruning | Unbounded memory growth | Prune entries for nodes that have left the cluster |
| Raft leader writing before commit | Linearizability violation | Only acknowledge writes after majority commit |
| Read repair without versioning | Overwrites newer data with older | Compare versions before applying repair |
| HLC without uncertainty bounds | Stale reads appear current | Enforce max_clock_skew, reject large skews |
| Hinted handoff without TTL | Hints accumulate indefinitely | Expire hints after N days, manual repair instead |
| Quorum with RF=2 | No majority possible during partition | Always use odd replication factor (3, 5) |
| Optimistic locking without retry | High abort rate under contention | Exponential backoff retry with jitter |

### Junior → FAANG: Using the Mistakes Table to Build Defensive Intuition

Each row in this table describes a class of production incident. The goal for a junior engineer is to internalize each mistake as a pattern to recognize during code review, not just as trivia for interviews.

"Raft leader writing before commit" is the most operationally significant mistake on this list. It can appear in subtle forms: a leader that returns success to the client as soon as it appends the entry to its own log (before sending AppendEntries to peers), rather than waiting for majority acknowledgment. The fix (only acknowledge after majority commit) is what the `advanceCommitIndex` function implements. When reviewing any system that wraps a Raft library, verify that the client-facing acknowledgment is tied to the commit index, not the append index.

"Vector clock without version pruning" is the mistake that takes longest to manifest. Memory usage grows slowly as nodes join and leave the cluster, and the symptom (OOM crash) arrives months after the root cause. A good defensive practice: add a metric that tracks the maximum vector clock size in bytes, and alert when it exceeds a threshold.

"HLC without uncertainty bounds" is subtle. HLC timestamps are valid only if clock skew is bounded. If a node's clock drifts forward by 500ms and is then corrected backward by NTP, events that happened after the correction may receive timestamps earlier than events that happened before. The `max_clock_skew` enforcement rejects transactions from nodes whose timestamps deviate too far, preventing this from silently corrupting ordering.

Interview habit: when asked about a distributed system design, proactively mention the mistake table equivalent for your design: "We would need TTL on distributed locks with a fencing token mechanism, and we would use an odd replication factor (3 or 5) to guarantee a majority can always be formed."

### Senior @ FAANG: Systematizing Mistake Prevention at the Organizational Level

The mistakes in this table share a common pattern: each is a correctness assumption that holds in the test environment but fails in production under specific, rare conditions. The organizational challenge is building systems that prevent these mistakes from reaching production rather than relying on individual engineers to remember each one.

Systematic prevention strategies by category:

For Raft implementation mistakes (writing before commit, not persisting votedFor), the mitigation is: do not implement Raft yourself. Use etcd, CockroachDB, or TiKV. If you must implement Raft, use a property-based test (QuickCheck-style) that exhaustively tests the transition system against the formal Raft specification (TLA+ spec is available). For organizations that cannot use these databases, a formal verification step in the code review process for consensus code is appropriate.

For CRDT mistakes (tombstone accumulation, LWW without clock skew bounds), the mitigation is: include CRDT type and expected data lifecycle in the service design review. A CRDT that will accumulate tombstones for years requires a GC design in the architecture, not just in the implementation. This question should appear in a design review checklist.

For quorum configuration mistakes (RF=2, which can never form a majority under partition), the mitigation is: encode the constraint as an infrastructure policy. An IaC (Terraform, Pulumi) policy that rejects any Cassandra or Kafka configuration with an even replication factor prevents this mistake from reaching any environment.

For hinted handoff without TTL: build the TTL as a required configuration field, not an optional one. An API that requires a TTL value (defaulting to 3 days if omitted is acceptable, having no default is better) prevents the mistake more reliably than documentation.

Bar-raiser signal: a senior candidate discussing system reliability can move from "here is a list of things that can go wrong" to "here is how I would encode each of these as a testable invariant and prevent it from reaching production systematically." The shift from enumeration to prevention mechanisms is the L6-level answer.

---
