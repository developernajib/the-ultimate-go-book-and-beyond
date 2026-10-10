## Summary

Advanced consistency and replication involves navigating the fundamental tension between consistency, availability, and partition tolerance:

- **Vector Clocks**: Track causality without global clocks. O(N) per message, but pruning and HLCs solve practical issues.
- **HLC**: Combines physical and logical time for causal ordering with real-time closeness. Used in CockroachDB, YugabyteDB.
- **Raft Consensus**: Strong consistency via leader election and majority log replication. Raft provides linearizability at the cost of availability during partitions.
- **CRDTs**: Mathematical structures that merge without coordination. Ideal for counters, sets, registers where eventual convergence is acceptable.
- **Read Repair**: Lazy consistency maintenance during reads. Efficient but only triggered by reads.
- **Anti-Entropy (Merkle Trees)**: Proactive consistency maintenance via hash trees. O(k log N) diff detection.
- **Linearizability Testing**: Use operation histories with intent-result matching to formally verify correctness.

The right consistency model depends on the application: financial systems need linearizability, shopping carts can tolerate eventual consistency with CRDT merge, and collaborative editing needs causal consistency.

### Junior → FAANG: Turning the Summary into a Mental Model for Interviews

The summary's bullet list maps directly to interview question categories. For each bullet, practice constructing a 2-minute verbal answer that covers: what the mechanism is, what problem it solves, what its primary limitation is, and one real-world database or system that uses it.

Vector Clocks: mechanism is per-node timestamp propagation, problem solved is causal ordering without synchronized clocks, limitation is O(N) size, real-world use is Riak and Cassandra's conflict detection.

HLC: mechanism is max(physical, logical) timestamp, problem solved is causal ordering that stays close to wall time, limitation is bounded by max clock skew, real-world use is CockroachDB and YugabyteDB.

Raft: mechanism is single-leader majority-quorum log replication, problem solved is strongly consistent distributed state machine, limitation is availability during leader election, real-world use is etcd and CockroachDB.

CRDTs: mechanism is semilattice merge functions, problem solved is coordination-free eventual consistency, limitation is cannot model operations that require coordination (uniqueness, overdraft prevention), real-world use is Redis (HLL), Riak, and Figma's collaborative canvas.

Read Repair and Anti-Entropy: mechanisms are lazy and proactive convergence, problem solved is replica divergence in eventually consistent storage, limitation is convergence time and repair write amplification, real-world use is Cassandra and DynamoDB.

Linearizability Testing: mechanism is history analysis against sequential specifications, problem solved is correctness verification of concurrent systems, limitation is NP-complete in general, real-world use is Jepsen and Elle.

For the final interview summary statement: "The right consistency model is determined by the operation's correctness requirement and the performance budget. I apply the weakest model that satisfies the correctness requirement, and I verify the model holds using history-based testing with fault injection."

### Senior @ FAANG: The Summary as a Governance Framework

The summary in its current form describes the tools. At the staff level, the summary should be read as the basis for a governance framework: which tool is mandatory for which class of operation, who is responsible for verifying that the chosen model holds, and how is that verification integrated into the delivery process.

Mandatory consistency model assignments by data class: financial transaction commits require linearizability (verified by Jepsen-style testing in CI). User-generated content state (posts, edits) requires causal consistency (verified by causal delivery unit tests and end-to-end ordering tests). Analytics aggregates allow eventual consistency (no correctness test required, but convergence SLA must be defined and monitored). Configuration and coordination (feature flags, leader state) require linearizability (stored in etcd, tested via etcd's own linearizability guarantees).

Verification responsibilities: the team that owns a storage system owns the linearizability tests for it. The platform team provides the test framework (the JepsenStyleTest implementation and Elle analyzer), but the application team owns the model (which operations must be linearizable, which may be eventually consistent) and the test suite (which fault profiles to test, what the correctness predicate is for their specific data types).

Delivery process integration: linearizability tests run in the nightly CI pipeline (not per-PR, because they take 10+ minutes with fault injection). A failure in the nightly pipeline blocks the next release. CRDTs that use tombstones require a GC design document approved by a staff engineer before merge. Anti-entropy repair intervals are set in the IaC configuration and require a capacity review when changed (because repair write amplification affects cluster throughput SLOs).

The maturity model for an organization's consistency governance: Level 0 is no explicit consistency decisions (whatever the database default provides). Level 1 is per-team consistency decisions documented in service READMEs. Level 2 is consistency requirements encoded in a service manifest and validated by tooling. Level 3 is automated correctness testing for all consistency-sensitive systems as a CI gate. Level 4 is continuous correctness monitoring in production with automated incident creation on violations. Most organizations are at Level 0 or Level 1. Moving to Level 2 requires staff engineering investment. Level 3 and 4 require principal engineering and platform investment.
