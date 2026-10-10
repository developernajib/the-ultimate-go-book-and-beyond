## Exercises with Complete Solutions

**Exercise 1 - Implement a G-Set CRDT**

A G-Set (grow-only set) is the simplest CRDT: elements can be added but never removed. Implement `type GSet[T comparable] struct` with `Add(T)`, `Contains(T) bool`, `Merge(*GSet[T])`, and `Elements() []T` methods. Verify commutativity: for any two sets A and B, `A.Merge(B)` must equal `B.Merge(A)`.

**Exercise 2 - Latency-Weighted Region Selection**

Extend the `LatencyRouter` to use an Exponentially Weighted Moving Average (EWMA) instead of a windowed slice of samples. The EWMA should give more weight to recent observations. Use a smoothing factor α = 0.3. Benchmark the EWMA implementation against the slice-based P99 implementation using `go test -bench`.

**Exercise 3 - Chaos Experiment for Database Failover**

Write a Go test that:
1. Creates a `MultiRegionPool` with two nodes (use SQLite in-memory for the test, or mock `*sql.DB`).
2. Injects a `FaultPartition` fault on the primary region for 5 seconds using the `Injector`.
3. Verifies that reads automatically fall back to the replica.
4. Verifies that after the partition heals, reads can use either node.

**Exercise 4 - Traffic Weight Ramp with Circuit Breaker**

Integrate the `TrafficShifter.ShiftWeight` method with a circuit breaker. If the error rate on the target region exceeds 5% during the ramp, the circuit breaker should open and the shift should roll back to the original weights. Use the `sony/gobreaker` package or implement a minimal token-bucket circuit breaker from scratch.

**Exercise 5 - Implement HLC Timestamps**

Implement a `HybridLogicalClock` type with:
- `Now() HLCTimestamp` - returns the current HLC time, advancing the logical counter if the physical time has not advanced.
- `Update(remote HLCTimestamp) HLCTimestamp` - merges a remote timestamp on receive.
- `Compare(a, b HLCTimestamp) int` - returns -1, 0, or 1.

Replace the plain `time.Time` timestamps in `LWWRegister` with `HLCTimestamp` and re-run the merge tests. Verify the register remains correct when the test introduces 100ms of artificial clock skew between two nodes.

**Exercise 6 - End-to-End Multi-Region Smoke Test**

Wire up the full stack (registry, health loop, traffic shifter, replication engine, failover controller) using the in-memory stubs. Write a table-driven test that exercises each scenario in the `Common Mistakes` table, confirming the system behaves correctly in each case.

---

### Junior -> FAANG: Getting the Most from These Exercises

Exercises 1 and 2 are foundational and should be completed before a system design interview. Implementing a GSet and an EWMA LatencyRouter are small enough to complete in a few hours but require understanding the core properties (commutativity for GSet, the smoothing factor trade-off for EWMA). Implementing them and running your tests proves the understanding more deeply than reading about it.

Exercise 5 (HLC timestamps) is the highest-value exercise for interview preparation. Hybrid Logical Clocks appear frequently in FAANG system design questions about distributed databases and replication, and implementing one correctly demonstrates a level of understanding that very few candidates at the entry level possess. Complete this exercise and be ready to explain your implementation in an interview.

For any exercise where you are unsure how to start, begin with the test. Write a test that asserts the property you want (GSet commutativity, EWMA correctness) before writing the implementation. This is TDD applied to distributed systems, and it forces you to be precise about what you are building.

### Senior @ FAANG: Using These Exercises as Staff-Level Assessment Tools

These exercises can serve as take-home assessment prompts for engineers at L5+ level, and reviewing their solutions is a calibration tool for interviewers. When reviewing a candidate's solution to Exercise 1 (GSet CRDT), look beyond correctness: does the implementation use generics appropriately, does it use sync.RWMutex correctly (write lock for Add, read lock for Contains and Elements), and does the test suite verify commutativity with random inputs (property-based test) or just the happy path?

Exercise 4 (Traffic Weight Ramp with Circuit Breaker) is an L5/L6 boundary exercise. An L5 solution integrates an existing circuit breaker library (sony/gobreaker) with the `ShiftWeight` method. An L6 solution discusses why the circuit breaker state must be per-region (not global), how the open/half-open transition interacts with the ramp's step interval, and how the rollback behavior differs from a simple weight reversal (you cannot revert atomically because you do not know what the weights were at each step).

Exercise 6 (end-to-end smoke test) is the integration test exercise. Evaluating a candidate's solution to this exercise reveals how they structure test code: do they use a shared setup helper or repeat code in each case? Do they clean up state between cases? Do they use subtests (`t.Run`) for isolation? Do they check not just the error-free path but also error conditions from the common mistakes table? An L6 solution covers at least five of the eight mistake scenarios with testable assertions, not just the happy paths.

At L7, you would extend Exercise 3 (database failover chaos test) into a full GameDay scenario: define a hypothesis, measure steady state before injection, inject the partition, measure during injection, remove the partition, measure recovery, and produce a structured report. This is the organizational capability these exercises are building toward, not just the code.
