## Exercises

**Exercise 1 - Raft Leader Election Trace:**
Draw a sequence diagram showing what happens when a 5-node Raft cluster experiences a network partition that isolates the current leader (node 1) from nodes 2, 3, 4, 5. Show all messages, term changes, and state transitions.

**Exercise 2 - Implement Raft Snapshot:**
Extend the Raft implementation in Section 64C.4 with:
- A `Snapshot(index int, snapshot []byte)` method that discards log entries up to `index`
- An `InstallSnapshot` RPC for the leader to send snapshots to lagging followers
- Modify `readPersist` to restore snapshot metadata
- Write a test that verifies a newly joined node can catch up via snapshot

**Exercise 3 - etcd Watch Application:**
Build a simple distributed configuration manager using etcd:
- A writer that stores service configuration as JSON values under `/config/{service-name}`
- A reader that watches the prefix `/config/` and maintains an in-memory cache
- The cache should be automatically updated within 100ms of a configuration change
- Handle watch channel closure and re-establish watches after etcd leader elections

**Exercise 4 - Fencing Token Validation:**
Implement a simple HTTP storage service that:
- Accepts PUT requests with a `X-Fencing-Token` header
- Stores the value only if the fencing token is strictly greater than the last seen
- Returns 409 Conflict with the current highest fencing token if the write is rejected
- Write an integration test that simulates a stale leader trying to write after a new leader has taken over

**Exercise 5 - Distributed Rate Limiter:**
Using etcd, implement a distributed rate limiter:
- A token bucket with a configurable rate and burst size, shared across N service instances
- Each service instance atomically decrements the token count using etcd transactions
- Token count is refilled by a single leader node (use leader election from Section 64C.6)
- The system should handle leader failure and elect a new refiller within 30 seconds

**Exercise 6 - Chaos Testing:**
Write a test harness that:
- Starts a 3-node Raft cluster (from Section 64C.4 or using a real etcd cluster)
- Submits 1000 sequential commands
- Randomly kills and restarts nodes during command submission
- At the end, verifies that all committed commands appear in the same order in all node logs
- Verifies that no committed command was lost

**Exercise 7 - Raft Paper Questions:**
Read sections 5 (The Raft consensus algorithm) and 6 (Cluster membership changes) of "In Search of an Understandable Consensus Algorithm" by Ongaro and Ousterhout. Then answer:
1. Why can a Raft leader only count replicas for entries from its current term?
2. What is the "leader completeness property" and how is it guaranteed?
3. In joint consensus, why must `C_{old,new}` be committed before `C_new` is proposed?

### Junior → FAANG: Getting the Most from These Exercises

Exercises 1 and 2 (sequence diagram and snapshot implementation) are the highest-value exercises in this chapter for interview preparation. Here is how to approach them.

For Exercise 1 (partition sequence diagram), draw the full diagram by hand, not from memory. Include: the initial state (who is leader, what term), the partition event, the election timer firing on each follower, the RequestVote messages with term numbers, the vote responses, the leader transition, and the partition heal with the stepped-down leader discovering the higher term. The act of drawing forces you to reason about message ordering and timing. After drawing it, verify that at no point do two nodes both believe they are leader for the same term.

For Exercise 2 (snapshot implementation), the critical invariant is that after installing a snapshot, the node's `lastSnapshotIndex` and `lastSnapshotTerm` must be updated before any log operations, and the log must be trimmed to start at `lastSnapshotIndex + 1`. Getting this wrong creates an off-by-one error in the log offset calculation that manifests as log entries being applied twice or skipped entirely.

Exercise 6 (chaos testing) is the exercise that teaches the most about correctness. Run it with `go test -race` to catch concurrency bugs that only appear under parallel execution. Run it for 30 seconds with randomly timed kills and restarts: correctness bugs that pass in 5-second tests often fail in 30-second tests when message ordering becomes more adversarial.

### Senior @ FAANG: Exercises as Team Engineering Investments

**Exercise 6 as a team investment, not a solo exercise.** The chaos testing harness in Exercise 6 is a foundation for ongoing regression testing. Once built, it should run in CI on every change to the consensus implementation. At FAANG scale, consensus implementations change infrequently, but when they do change (e.g., upgrading the etcd client library version), the chaos test suite is the only reliable way to verify that the change does not introduce correctness regressions. Invest in making this test suite deterministic (seed the random number generator with a fixed value for reproducible runs) and fast enough to run in CI (under 60 seconds).

**Exercise 5 (distributed rate limiter) as a design exercise, not just a coding exercise.** Before implementing, answer: what happens if the etcd cluster is unavailable when the rate limiter tries to decrement the token count? Should it fail open (allow all requests) or fail closed (deny all requests)? Fail open is safer for availability but unsafe for rate limiting under DDoS. Fail closed is safer for rate limiting but causes service unavailability during etcd downtime. The choice depends on whether the rate limiter is protecting a downstream service (fail closed) or providing a best-effort throttle (fail open). Documenting this decision in a comment above the rate limiter implementation is the senior habit.

**Exercise 7 (Raft paper questions) as a code review preparation.** The three questions in Exercise 7 are the invariants that a code reviewer must verify in any Raft implementation. After answering them from the paper, translate each into a code review checklist item: (1) `maybeAdvanceCommitIndex` must check `rf.logAt(n).Term == rf.currentTerm`. (2) `RequestVote` must check log up-to-dateness before granting. (3) joint consensus log entries must transition through C_old,new before C_new. If you can map each paper property to a specific line of code that enforces it, you understand the implementation deeply enough to review it reliably.

---

*Next: Chapter 64D - Capacity Planning and Back-of-Envelope Calculations*
