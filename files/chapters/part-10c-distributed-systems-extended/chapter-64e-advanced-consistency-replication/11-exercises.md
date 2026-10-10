## Exercises with Complete Solutions

1. **Vector Clock Causality**: Implement a message board where posts must be displayed in causal order (replies after parents). Use vector clocks to enforce this.

2. **Raft Leader Election**: Implement the Raft leader election algorithm in isolation. Write tests that simulate split votes, network partitions, and term updates.

3. **G-Counter Cluster**: Deploy 3 GCounter nodes and simulate network partitions. Verify that all counters converge after healing.

4. **OR-Set Conflicts**: Demonstrate the concurrent add/remove scenario with ORSet. Show that after merge, the element is present (add wins semantics).

5. **Read Repair Test**: Implement a 3-node replica set with intentional staleness (inject old values into one replica). Verify that reads trigger repair and that subsequent reads return the correct value.

6. **Merkle Tree Diff**: Build two Merkle trees with 80% identical and 20% different entries. Measure how many nodes need to be compared to identify the differing keys.

7. **Linearizability Violation**: Write a buggy concurrent key-value store that has a linearizability violation (e.g., double read that returns non-monotonic values). Run it through the JepsenStyleTest to detect the violation.

8. **HLC Ordering**: Implement a distributed log where entries are ordered by HLC timestamp. Simulate clock skew (sleep one node's clock forward). Verify that causal ordering is preserved.

### Junior → FAANG: Getting Maximum Value from Each Exercise

The exercises are sequenced from foundational (vector clock causality) to integrative (HLC ordering with fault injection). For interview preparation, exercises 2, 6, and 7 are the highest-yield.

Exercise 2 (Raft leader election in isolation) is the exercise that reveals the most implementation complexity per line of code. Simulating split votes requires running multiple concurrent candidates in the same term, verifying that none of them receives a majority, and then verifying that the cluster eventually elects exactly one leader. A test that does not explicitly verify "exactly one leader" (not "at least one leader") is missing the most important invariant.

Exercise 6 (Merkle tree diff) teaches the efficiency argument concretely. Before implementing, calculate: if the two trees have 1,000 differing keys out of 100,000 total, how many hash comparisons does the Merkle diff require? (Approximately 1,000 multiplied by log2(100,000), which is about 17,000 comparisons.) Compare to the naive approach of comparing all 200,000 key-value pairs. The ratio (17:1 advantage here) is the answer you give when an interviewer asks why Cassandra uses Merkle trees for anti-entropy.

Exercise 7 (linearizability violation) is the exercise where you build the adversarial mindset required for distributed systems testing. A simple bug to introduce: have the key-value store return the value from a local buffer that is updated before the write is acknowledged, while the write confirmation arrives only after a delay. Under concurrent reads and writes, a reader may see the updated value, then a subsequent reader may see the old value (if it hits a different replica). The JepsenStyleTest should catch this as a non-monotonic read.

A useful addition to any exercise: add a deliberate bug, run the test, verify it fails, then fix the bug and verify the test passes. Exercises that only test the happy path do not build the debugging skills that distributed systems require.

### Senior @ FAANG: Designing Exercises That Build Team Competency

At the staff level, these exercises are templates for onboarding exercises and internal distributed systems workshops. The design question is: which exercises build the skills that your specific team needs most, given your production stack?

For a team operating a Raft-based system (etcd, CockroachDB): Exercise 2 (Raft leader election) should be extended to include pre-vote, log compaction, and snapshot installation. A team that has never implemented Raft from scratch does not understand the failure modes of the production system they are operating. Running a simplified Raft implementation and then deliberately injecting the failure modes that the production system handles (leader crash during replication, follower with stale log rejoining, snapshot installation racing with normal replication) builds the intuition required for effective on-call response.

For a team operating eventually consistent storage: Exercises 3 (CRDT cluster with partitions), 5 (read repair), and 8 (HLC ordering) form a coherent workshop. The key addition is measuring the convergence time: after healing a partition, how long does it take for all replicas to agree? This measurement should be compared to the convergence SLA in your service's SLO.

For a team building a new distributed primitive: Exercise 7 (linearizability violation detection) should be the acceptance gate for any new distributed data structure. No distributed primitive should be deployed to production without a Jepsen-style history test that has been run with at least three fault injection profiles.

Workshop facilitation note: the most valuable learning happens when engineers implement a primitive incorrectly, observe the test failing, debug the failure, and fix the bug. The exercises should be designed with intentional difficulty rather than complete scaffolding. An exercise where the test passes on the first attempt teaches nothing about the failure modes. Budget two hours per exercise for a workshop session, not one.

---
