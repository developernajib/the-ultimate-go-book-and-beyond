## Exercises

Eight hands-on exercises. Each is a multi-day project for a senior engineer. The point is not to land on a polished implementation, the point is to encounter the production gotchas in your own code and build the muscle for the real systems.

### Exercise 1: Implement a Raft Heartbeat Loop

Build a minimal Raft node with three roles (Follower, Candidate, Leader) and a heartbeat. Skip log replication and snapshots, focus on the timer and election logic.

Requirements:
- Three peers communicate via in-process channels (no real network).
- Randomized election timeout (150-300 ms).
- A leader elected within 1 second of cluster start.
- Kill the leader, a new leader is elected within 500 ms.
- Persistent state (current_term, voted_for) survives a restart.

Stretch: add the pre-vote optimization. Verify that a partitioned, then-rejoined node does not disrupt the live leader.

### Exercise 2: Simulate Split-Brain in a Lease-Based Leader Election

Build a lease server (Raft-replicated or in-memory) and two leader clients. Inject a process pause into one client (sleep on the leader thread for 2x the lease duration). Show that without fence tokens, both clients believe they are leader simultaneously and both write to a shared resource. Add fence tokens and show that the stale leader's writes are rejected.

The deliverable is a test that demonstrates the bug, then demonstrates the fix. Save the test as a regression check.

### Exercise 3: Build a Vector Clock Library

Implement `VectorClock` and `DottedVersionVector` in C++23. Provide:
- `Tick()`, `Merge(other)`, `Compare(other) -> Before/After/Equal/Concurrent`.
- Serialize/deserialize via Protobuf.
- Property tests: 10K random operation sequences, verify causality is preserved across all permutations.

Stretch: implement garbage collection of entries unanimously observed.

### Exercise 4: Implement a SWIM Failure Detector on Asio

Three or more nodes, periodic random ping plus indirect ping. UDP transport. Mark a peer Suspect after a missed ping, Failed after a Suspect timeout. Gossip membership changes. Run with five processes, kill one, verify the others detect within 2 seconds.

Stretch: add the Lifeguard refutation extension. A node that is wrongly marked Suspect can refute by sending an `Alive` with an incremented incarnation number.

### Exercise 5: Build a Merkle Tree Anti-Entropy Protocol

Two replicas of a 1 GB key-value dataset. Inject 100 random divergences (a key with different values on the two replicas). Implement a merkle-tree comparison that finds all divergences in O(log N) bandwidth plus the actual diff. Measure: how many bytes of network traffic does the protocol use, compared to a full key-by-key comparison?

Stretch: implement *incremental* merkle maintenance, so the tree updates on every write rather than rebuilding.

### Exercise 6: Implement a Skip-List Memtable with Concurrent Reads

Single writer, multiple concurrent readers. Atomic pointer next-references. Insert and lookup operations both work correctly under concurrent execution. Use ThreadSanitizer to verify no data races. Measure read throughput at 1, 4, 16 reader threads.

Stretch: support concurrent writers via a per-bucket lock or a lock-free CAS-based insert.

### Exercise 7: Build a Token Bucket Rate Limiter and Test Its Behavior Under Burst

Implement `TokenBucket(rate=100/s, burst=200)`. Send 1000 requests in a 100 ms burst. Verify that the first 200 succeed (burst capacity), the next 10 succeed (refill rate over 100 ms), and the rest fail. Then send 1 request per second for 1000 seconds, verify all succeed.

Stretch: extend to a *distributed* rate limiter using Redis. Compare local-bucket and Redis-bucket latency at 10K QPS.

### Exercise 8: Write a Deterministic Simulator Harness

Build a single-threaded event-loop simulator that wraps a small distributed protocol of your choice (a 3-node leader election, a 2-node ping/pong with fault injection). Drive it with a seeded RNG. Inject random message drops and delays. Run 100,000 seeds in CI. When a bug surfaces, reproduce from the seed alone.

Stretch: add support for partitioning the network into two groups for a configurable duration, then healing. Verify the protocol's behavior under all partition patterns.

---

Solutions for each exercise are intentionally not provided. The senior-engineer experience is in encountering the specific bug, debugging it, and earning the lesson. Completing all eight yields the complete components of a production-grade distributed system from scratch.

---
