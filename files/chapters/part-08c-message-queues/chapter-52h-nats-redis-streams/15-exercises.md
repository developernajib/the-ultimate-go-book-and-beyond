## Exercises

### Exercise 1: Distributed Job Queue with JetStream Pull Consumers

Build a distributed job queue using NATS JetStream with work queue retention. Requirements:

- Stream `JOBS` with `WorkQueuePolicy` retention (messages deleted after acknowledgment)
- Job types: `image.resize`, `email.send`, `pdf.generate` (use `FilterSubject` per worker type)
- Pull consumer workers that process in batches of 10
- Retry with exponential backoff (`BackOff` configuration) up to 5 attempts
- Dead letter stream `JOBS-DEAD` for jobs exceeding `MaxDeliver`
- Job result publishing to `results.<job-type>.<job-id>`
- Prometheus metrics: job throughput per type, failure rate, p99 latency
- Graceful shutdown: drain in-flight jobs before exit
- Load test: demonstrate 3 workers processing a burst of 10,000 jobs

### Exercise 2: Event Sourcing Store with Redis Streams and Snapshot Optimization

Implement a complete event sourcing store using Redis Streams. Requirements:

- Aggregate: `BankAccount` (events: `AccountOpened`, `MoneyDeposited`, `MoneyWithdrawn`, `AccountClosed`; track all monetary amounts as `int64` minor units/cents)
- Event store: one stream per aggregate (`events:account:<id>`)
- Snapshot optimization: after N events (configurable, default 50), write a snapshot to a Redis Hash and record the snapshot's stream ID. On load, read snapshot then replay only events after snapshot ID
- Optimistic concurrency: use Redis MULTI/EXEC with a version check before appending events (prevent lost updates)
- Projection workers: consumer groups projecting balance and transaction history per account
- Full replay test: create account with 100 events, verify snapshot is taken at event 50, verify reconstitution from snapshot is faster than full replay
- Expiry policy: accounts inactive >1 year archived to a slow store (mock with logging)

### Exercise 3: Real-Time Leaderboard with Redis Streams

Build a real-time game leaderboard using Redis Streams and Sorted Sets. Requirements:

- Game score events published to stream `events:game:scores` (`XADD` with fields: `player_id`, `game_id`, `score`, `timestamp`)
- Consumer group `leaderboard-projector` reads score events and updates a Redis Sorted Set (`ZADD NX leaderboard:global <score> <player_id>`)
- Top-10 leaderboard query via `ZREVRANGE leaderboard:global 0 9 WITHSCORES`
- Per-game leaderboard: filtered XREADGROUP or separate stream per game (benchmark both approaches)
- Score history per player: XRANGE on the events stream filtered by player_id (discuss O(N) limitation)
- Window leaderboard: hourly leaderboard using time-based XRANGE queries and a temporary sorted set (`leaderboard:hourly:<hour_epoch>` with 2-hour TTL)
- Simulate 1,000 concurrent players publishing scores and verify leaderboard consistency

### Junior -> FAANG: Completing the Exercises for Maximum Learning

The three exercises above are ordered by increasing complexity. Exercise 1 is a JetStream fundamentals exercise. Exercise 2 introduces event sourcing with snapshot optimization. Exercise 3 adds a derived read model (the sorted set leaderboard).

For each exercise, follow this sequence: write the failing test first, implement the minimum code to make it pass, then run the load test specified in the requirements. The load test numbers (10,000 jobs, 100 events, 1,000 concurrent players) are not arbitrary. They expose behavior that does not show up at low volume: resource exhaustion, goroutine leak, contention on shared state.

The most common shortcut that entry-level engineers take is skipping the failure scenario requirements. For Exercise 1, "retry with exponential backoff up to 5 attempts" is not tested by a happy-path run. You must inject a failing handler and verify that the job appears in `JOBS-DEAD` after exactly 5 attempts, not 4 and not 6. For Exercise 2, "optimistic concurrency" is not tested by a single-writer run. You must run two goroutines that both try to append events to the same account simultaneously and verify that exactly one succeeds and the other gets a concurrency error.

### Senior @ FAANG: Extending the Exercises to Production Concerns

The three exercises cover implementation correctness. Extend them with the following production-readiness additions to practice staff-level engineering.

For Exercise 1: add a consumer lag dashboard using JetStream's `ConsumerInfo.NumPending` exported as a Prometheus gauge. Write a load test that creates a burst of 100,000 jobs and measures the time for `NumPending` to return to zero with 3 workers. Plot the lag curve and identify the batch size that minimizes time-to-zero without exceeding 80% of a single worker's CPU.

For Exercise 2: implement the snapshot optimization and measure the reconstitution time for accounts with 10, 100, 1,000, and 10,000 events, with and without snapshots. Plot the results and identify the event count at which snapshots become necessary (where "necessary" means reconstitution time exceeds your target read SLA). Write this threshold into the exercise as a configurable parameter with a default derived from your measurement.

For Exercise 3: add a multi-region dimension to the leaderboard. Assume two Redis clusters (us-east, eu-west) and a requirement that a player's score update in us-east appears in the eu-west leaderboard within 500ms. Evaluate whether Redis Streams with a cross-region consumer group, active-active Redis Cluster replication, or a separate event bus (NATS JetStream) is the right mechanism for cross-region propagation, and document the trade-offs in a one-page ADR as the final deliverable for the exercise.

---
