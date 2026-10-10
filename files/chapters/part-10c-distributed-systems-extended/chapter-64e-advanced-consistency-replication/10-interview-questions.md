## Interview Questions

### Q1: What is the difference between linearizability and serializability?

**What FAANG expects:** Linearizability = real-time ordering of single-object operations. Serializability = some sequential ordering of multi-object transactions. Strict serializability = both (Spanner, CockroachDB). Most SQL defaults are snapshot isolation or read-committed, *not* serializable. Bonus for citing Jepsen's formal definitions and for knowing which DBs default to what (Postgres read-committed, Oracle read-committed, CockroachDB serializable).

**Answer:** Linearizability is a property of individual operations on a single object - each operation appears to take effect instantaneously at some point between its invocation and return. It's about real-time ordering of operations. Serializability is a property of transactions over multiple objects - there exists some sequential execution of concurrent transactions that produces the same result. Combining both gives **strict serializability** (Spanner's guarantee). Most SQL databases provide serializability without linearizability (operations within a transaction are atomic, but the timestamp may not respect real-time order).

**Follow-ups:**
- *What does "strict serializability" buy over plain serializability?* Real-time causality: if T1 completes before T2 starts (from any observer), T1 < T2 in the serial order. Without it, a reader might see T2's writes before T1's even though T1 actually finished first.
- *Why is snapshot isolation weaker than serializable?* Write skew: two transactions read the same snapshot, modify different rows, and commit without conflict, but the combined result violates an invariant. Postgres SSI catches this with predicate tracking. plain SI does not.
- *What is the performance cost of going from SI to serializable?* Postgres SSI: 5-20% overhead typically, more under heavy conflict. CockroachDB: built-in serializable at ~2x the cost of SI. Pay it if your invariants require it.

### Q2: How do CRDTs achieve conflict-free merging, and what are their limitations?

**What FAANG expects:** Mathematical framing: CRDTs form a join-semilattice where merge is commutative, associative, idempotent. State-based (CvRDT) vs operation-based (CmRDT) distinction. Name concrete types: G-Counter, PN-Counter, OR-Set, LWW-Register, RGA/YATA. Limitations: cannot model coordination-requiring operations (unique IDs, overdraft protection), tombstone GC is hard, semantics may surprise users.

**Answer:** CRDTs exploit mathematical properties: they form a join-semilattice where the merge operation is commutative, associative, and idempotent. G-Counter: each node has its own counter → merge is max → sum is total → no conflicts. OR-Set: unique tags per add → concurrent add and remove preserves the add → no conflicts. Limitations: (1) Some operations can't be modeled without coordination (e.g., unique ID assignment, bank account with overdraft protection). (2) Tombstone accumulation (removed elements must be retained indefinitely in the removed set). (3) The "right" semantics may not match user expectation (OR-Set semantics for concurrent add/remove is "add wins", which may be surprising).

**Follow-ups:**
- *When does tombstone accumulation become a real problem?* Long-running OR-Sets (collaborative documents edited for years) can accumulate gigabytes of tombstones for deleted items. Yjs handles it with periodic garbage collection coordinated across peers. Not a solved problem in general.
- *Are CRDTs always the right answer for collaboration?* No. Central-server OT (Google Docs) has lower metadata overhead and clearer undo semantics. CRDTs win for offline-first and peer-to-peer. Pick per workload.
- *What about "OR-Set add-wins" vs "remove-wins" semantics?* OR-Set is add-wins by default. Remove-wins (two-phase sets, tombstone-remove) is also conflict-free but feels surprising to users expecting "last-writer-wins". The choice is a product decision, not a technical one.

### Q3: In Raft, why can a leader only commit entries from its current term?

**What FAANG expects:** The Leader Completeness Property safety rule. Explain with the canonical counterexample (Figure 8 in the Raft paper): old-term entry can appear committed but then be overwritten during a leadership change. The fix: commit new entries from current term, which transitively commits older entries via Log Matching. Bonus for drawing out why this rule is *necessary* (not just a defensive overcomplication).

**Answer:** This is the Raft Leader Completeness Property safety rule. Consider: Leader A commits an entry from term 2 at index 5. A crashes. B becomes leader in term 3 and has an entry at index 5 from term 3 (different). B won the election because it had a majority vote, meaning it was up-to-date. If B then overwrites index 5 with its term-3 entry, the committed term-2 entry is lost. The fix: B can only commit entries from its own term (term 3). But Raft's election safety guarantees that any majority that elected B must contain at least one node with the committed term-2 entry, so B's log is at least as long as A's. By committing a new term-3 entry, B indirectly commits all earlier entries including the term-2 one at index 5.

**Follow-ups:**
- *What is the "no-op" entry at leader startup?* A new leader appends a no-op so it can commit something from its current term immediately, which implicitly commits the tail of the previous term's log. Without this, a low-traffic cluster could leave old-term entries uncommitted indefinitely.
- *Where does this rule appear in etcd's code?* In `raft.go`, `maybeCommit()` only advances commit index for entries where `term == currentTerm`. The safety invariant is explicit in the comment.
- *Is this rule unique to Raft?* No, Multi-Paxos has an equivalent constraint (leaders can only commit proposals from their current ballot) but it is less visible because Paxos's model is more flexible about which node proposes.

### Junior → FAANG: Preparing Answers That Satisfy the Follow-Up Loop

FAANG interviews for distributed systems roles follow a consistent pattern: the interviewer asks the opening question, evaluates whether the candidate can give a correct high-level answer, and then immediately probes with follow-ups to find the depth boundary. Preparing for the follow-ups is more important than perfecting the opening answer.

For Q1 (linearizability vs serializability): the opening answer is in the section. The follow-up loop to prepare for is: "What isolation level does Postgres use by default?" (Read Committed, not Serializable). "What does that mean for a banking application that reads a balance and then writes a conditional debit?" (Write skew is possible under Read Committed, so you need either Serializable SSI or explicit locking). "What does CockroachDB provide by default?" (Serializable, the strongest standard isolation level). Being able to name the default isolation level of at least three common databases is the depth signal the interviewer is looking for.

For Q2 (CRDTs): the follow-up loop around tombstone accumulation is particularly deep. The interviewer wants to know whether the candidate has actually thought about the garbage collection problem. The answer: tombstones in OR-Sets cannot be deleted until you know every replica has seen and processed the remove operation. If you have offline replicas that have been disconnected for months, you cannot safely GC tombstones without first either waiting for them to reconnect or giving up on eventual consistency for that replica. This is the core tension in CRDT GC.

For Q3 (Raft commit rule): the follow-up about the no-op entry is the most important preparation item. A new Raft leader cannot commit any entries from previous terms directly, so if the cluster has low write traffic, old entries can remain "committed according to majority" but "not yet officially committed" in Raft's sense indefinitely. The no-op entry solution is described in the Raft paper's Section 8 and appears verbatim in etcd's implementation. Knowing this detail distinguishes candidates who read the paper from those who only read summaries.

### Senior @ FAANG: Calibrating Interview Answers to the L6/L7 Bar

The interview questions in this section are calibrated for L5/senior candidates. At L6 and above, the same questions are asked with a different expected depth, and the follow-up loops are longer and more adversarial.

For Q1 at L6: the interviewer will likely extend from the standard "linearizability vs serializability" into territory like "how would you design a globally distributed database that provides strict serializability without TrueTime?" This requires the candidate to independently derive the HLC approach (bounded uncertainty window instead of hardware clocks), identify the commit-wait analog (reads must wait until the uncertainty window passes), and quantify the latency cost (HLC uncertainty is typically 10-50ms vs Spanner's TrueTime 7ms uncertainty). The candidate who says "I'd use Spanner" is not answering the question. The candidate who derives the HLC solution is at L6 depth.

For Q2 at L6: the CRDT follow-up will probe whether the candidate can design a CRDT GC protocol. The correct answer involves two-phase coordination: a GC coordinator broadcasts a GC intent, waits for all replicas to acknowledge (with a timeout for offline replicas), and then broadcasts a GC commit. Offline replicas that miss the GC commit and reconnect later must detect the gap (by noticing that the tombstone epoch advanced without their acknowledgment) and either download the current state from a live replica or acknowledge that their local state for that key range is invalid. This is the design of Yjs's GC protocol.

For Q3 at L6: the Raft commit rule follow-up will extend into "how does etcd's implementation handle the case where a new leader's no-op AppendEntries is dropped by the network before any follower acknowledges it?" The answer requires understanding that Raft's election safety guarantee means the new leader already has the highest log, so even if the no-op is never delivered (e.g., the new leader crashes before any follower acknowledges), the next leader will also have a log at least as long as this one, and will also commit a no-op from its own term. Safety is preserved across multiple consecutive leader failures. This is the kind of argument that requires understanding the invariant, not just the happy path.

The bar-raiser's job in a panel interview is to find the depth limit of the candidate. When a candidate's answer is correct, the bar-raiser immediately asks a harder follow-up. Preparing for this means not just knowing the correct answer but being able to reason from first principles when the questions go beyond what you have memorized. The three questions in this section are starting points for that preparation, not the finish line.

---
