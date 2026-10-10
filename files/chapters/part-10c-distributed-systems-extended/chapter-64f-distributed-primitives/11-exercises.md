## Exercises with Complete Solutions

1. **Fencing Token Demo**: Build a shared counter that uses a distributed lock. Simulate a paused process (sleep > TTL) and show that without fencing tokens, the counter is corrupted. Then add fencing tokens and show the stale write is rejected.

2. **Leader Election Failover**: Deploy a 3-node leader election system. Kill the leader and measure: (a) how long before a new leader is elected, (b) are any writes lost during failover?

3. **Rate Limiter Burst Test**: Configure a token bucket (capacity=100, rate=10/s). Send 200 requests in 1 second. Record which requests succeed and which are throttled. Verify that exactly 100 succeed in the first second.

4. **Circuit Breaker State Machine**: Implement the circuit breaker and write a test that: opens it (inject failures), verifies requests fail immediately, waits for timeout, verifies half-open allows test calls, verifies recovery to closed state.

5. **Distributed Barrier**: Start 5 goroutines simulating different stages of a distributed job. Each stage should wait at a barrier until all 5 have completed the stage before proceeding to the next.

6. **Service Registry Watch**: Register 3 service instances. Add a watch. Deregister one instance. Verify the watch receives the update within 1 second.

7. **Redlock Analysis**: Implement Redlock with 3 Redis nodes. Simulate one Redis node going down during lock acquisition. Verify: (a) lock is still acquired on the remaining 2, (b) quorum is maintained, (c) lock is released correctly.

8. **Retry with Circuit Breaker**: Chain a retry policy with a circuit breaker: retry up to 3 times with exponential backoff, but skip retries if the circuit is open. Measure how long recovery takes after the circuit opens.

### Junior → FAANG: Getting the Most from Each Exercise

The exercises are ordered from foundational (fencing tokens, leader election) to integrative (retry with circuit breaker). For interview preparation, exercises 1, 2, and 4 are the highest priority because they force you to confront the failure scenarios that appear most frequently in FAANG system design interviews.

Exercise 1 (Fencing Token Demo) is the exercise that most concretely demonstrates why fencing tokens are necessary, not just theoretical. To make it educational: first implement the shared counter without fencing tokens and verify that the simulated GC pause (a `time.Sleep` longer than the lock TTL) does corrupt the counter. Then add fencing token enforcement and verify the stale write is rejected. The "demonstrate the bug first" approach builds intuition that cannot come from reading about the bug in the abstract.

Exercise 2 (Leader Election Failover) teaches the operational reality of leader election by forcing you to measure two things: (a) the failover duration (should be approximately equal to the lease TTL) and (b) whether any writes are lost. For (b), the correct answer with etcd-backed leader election is: no committed writes are lost, because etcd's Raft guarantees that committed writes survive leader failure. Writes that were in flight at the moment of failure may not have been committed. Those are the writes to account for. Measuring this with a real etcd cluster (not a mock) produces the numbers you can quote in interviews.

Exercise 4 (Circuit Breaker State Machine) is the exercise that requires the most careful test design. The state transitions to test are: inject enough failures to trip the circuit (count matters: must meet `MaxFailures` within `WindowSize`), verify subsequent calls fail immediately without invoking the downstream, wait exactly `Timeout` seconds, verify the next call is allowed through (half-open probe), inject a success, verify the circuit closes. Writing a test that verifies all five transitions in sequence without relying on real time (use a mock clock) is the exercise that produces a reusable pattern for testing any state machine implementation.

For all exercises: record the time it takes to implement each one. The first time through, most engineers take 2-3 hours per exercise. If you find exercises taking much longer, that is a signal that the underlying concept needs more study before the implementation.

### Senior @ FAANG: Adapting These Exercises for Team Onboarding and Competency Development

At the staff level, these exercises are the raw material for a distributed systems workshop that builds measurable competency in your team. The adaptation from self-study exercises to team workshop requires two modifications: adding an explicit failure-injection requirement and adding a measurement requirement.

Exercise 1 (Fencing Token Demo): for a workshop, extend this to require implementing the `FencedStorage` on top of a real database (Postgres or DynamoDB) rather than an in-memory map. The Postgres version uses `UPDATE ... WHERE fencing_token < incoming_token RETURNING fencing_token` as the atomic check-and-update. The DynamoDB version uses `ConditionExpression`. Implementing against a real storage backend reveals production subtleties (what happens when the fencing token column does not exist yet, how to handle the initial write when there is no prior token) that the in-memory version hides.

Exercise 2 (Leader Election Failover): for a workshop with a team that operates a production Kubernetes cluster, extend this to instrument the Kubernetes controller leader election (using `client-go/tools/leaderelection`) and measure the actual failover time in staging. Comparing the measured failover time to the configured lease TTL reveals whether the network and etcd latency in your specific environment match the theoretical bounds. Teams that have done this exercise have discovered that their etcd p99 latency is much higher than expected, causing actual failover times of 30+ seconds despite a 5-second TTL.

Exercise 8 (Retry with Circuit Breaker) is the highest-value exercise for teams building microservices. The key extension for a workshop: implement the retry-circuit-breaker composition three ways (retry outside breaker, retry inside breaker, breaker with fallback and no retry) and measure the recovery time and error count for each configuration during a 30-second simulated downstream outage. The comparison of the three configurations concretely demonstrates why the composition order and fallback design matter. This exercise, run once as a team, permanently improves how team members think about outage response patterns.

For workshop facilitation: budget 90 minutes per exercise pair, with the first 45 minutes for individual implementation and the second 45 minutes for group discussion of the bugs found and the design decisions made. The bugs are the most valuable part: document every bug discovered during the workshop and convert it into a code review checklist item.

---
