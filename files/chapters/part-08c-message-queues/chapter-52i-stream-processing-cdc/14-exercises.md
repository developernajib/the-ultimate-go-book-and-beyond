## Exercises

### Exercise 1: CDC-Driven Cache Invalidation

**Task**: Build a system where:
1. PostgreSQL `products` table is the source of truth
2. Debezium publishes changes to `products-cdc` Kafka topic
3. Go consumer reads CDC events and invalidates Redis cache keys:
 - `product:{id}` (direct lookup)
 - `category:{category_id}:products` (list cache)
 - `search:*` (pattern-based wildcard if product metadata changed)
4. Metrics: cache invalidation rate, Redis errors, processing lag

**Key implementation points**:
- Use `SCAN` + `DEL` for pattern-based invalidation (not `KEYS *` in production)
- Handle snapshot events (`op: "r"`) by pre-warming cache instead of invalidating
- Circuit breaker: if Redis is unavailable, log events to a recovery queue

### Exercise 2: 10-Minute Sliding Window Click Aggregator

**Task**: Build a Go service that:
1. Reads click events from Kafka (`topic: page-clicks`, schema: `{user_id, page, timestamp}`)
2. Computes sliding window: 10-minute window, slides every 2 minutes
3. Output: per-page click count for each window, written to ClickHouse
4. Handles late events up to 1 minute

**Algorithm**:
```
Each event falls in ceil(10/2) = 5 windows:
  Event at t=10: windows [0,10), [2,12), [4,14), [6,16), [8,18)

Window key = (event_time / slide_interval) * slide_interval
Emit window [W, W+windowSize) when watermark > W + windowSize
```

### Exercise 3: Outbox Pattern with Integration Tests

**Task**: Implement the complete outbox pattern with testcontainers-go:
1. `OrderService.PlaceOrder()` writes order + outbox event in one transaction
2. `OutboxRelay` polls and publishes to Kafka
3. Integration test using `testcontainers-go`:
 - Start PostgreSQL container
 - Start Kafka container
 - Test that after `PlaceOrder`, the Kafka consumer receives the event
 - Test idempotency: if relay crashes after publish but before marking published, the event is not duplicated in Kafka (use idempotent producer with message key = outbox ID)

```go
func TestOutboxPattern(t *testing.T) {
    ctx := context.Background()

    // Start containers
    pg, _ := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "postgres:18",
            ExposedPorts: []string{"5432/tcp"},
            Env: map[string]string{
                "POSTGRES_DB":       "testdb",
                "POSTGRES_PASSWORD": "test",
            },
            WaitingFor: wait.ForListeningPort("5432/tcp"),
        },
        Started: true,
    })
    defer pg.Terminate(ctx)

    // ... setup db schema, create OutboxStore, run relay, verify kafka event
}
```

### Junior -> FAANG: Getting Maximum Value From These Exercises

The three exercises in this section are sequenced from simpler (cache invalidation consumer) to more involved (sliding window aggregator) to most complete (outbox with integration tests). For interview preparation, work through them in order, and for each one, ask yourself: what is the failure mode if this component crashes mid-operation?

For Exercise 1 (cache invalidation), the failure mode question is: what happens if the process crashes after deleting some keys but before deleting all keys for an order? The answer is that some cache keys are stale and some are fresh, which is an inconsistent state. The correct design uses a single `Del` call with all keys in one Redis command, which is atomic. Practice explaining why you would use `Del` with multiple keys in one call rather than multiple separate `Del` calls.

For Exercise 2 (sliding window), the algorithm note in the exercise description is the key insight: each event appears in `ceil(windowSize / slideInterval)` windows. For a 10-minute window with a 2-minute slide, that is 5 windows per event. Your implementation needs to compute all 5 window keys for each event and update all 5 accumulators. This is the primary performance difference from tumbling windows (1 window per event): each event costs more to process, but the output signal is smoother.

For Exercise 3 (outbox integration test), the most valuable test to write is the idempotency test: publish a batch, crash the relay before marking rows as sent, restart the relay, confirm that Kafka receives each event exactly once. This tests that the Kafka idempotent producer correctly deduplicates the second publish. Testcontainers-go makes this test hermetic and reproducible, which means you can run it in CI without depending on external infrastructure.

After completing each exercise, write down the list of things you would add before deploying it to production. This list becomes your mental checklist for code review in your first job.

### Senior @ FAANG: What These Exercises Test Beyond the Obvious

Each exercise tests a specific production capability that appears trivial in isolation but is the source of real incidents at scale.

**Exercise 1: Redis key space management.** The instruction to use `SCAN` rather than `KEYS *` for pattern-based invalidation is not a performance footnote. `KEYS *` blocks the Redis event loop for the duration of the scan, which on a large keyspace can take seconds. During those seconds, every Redis command from every other client in the application blocks. At FAANG scale, a `KEYS *` call in a production Redis instance is a P1 incident. The exercise teaches the correct pattern, but a senior engineer reviewing the implementation would also ask: what is the maximum keyspace size, and is `SCAN`-based iteration fast enough at that scale? For very large keyspaces, tagging cache keys with the entity ID and using a secondary index (a Redis Set containing all keys for an entity) is faster than pattern-based scanning.

**Exercise 2: sliding window memory usage.** The sliding window algorithm stores state for `ceil(windowSize / slideInterval)` active windows per key. For a 10-minute window with a 2-minute slide and 1 million active users, the memory footprint is 5 windows per user times 1 million users times the size of each accumulator. If the accumulator is a simple integer (8 bytes), that is 40 MB. If the accumulator is a complex struct (256 bytes), that is 1.28 GB. A senior engineer reviewing Exercise 2 would ask for the key cardinality estimate and the accumulator size before accepting the in-process state design. At 1 million active users, external state in Redis with a per-window key and a TTL of `windowSize + allowedLateness` is the correct design.

**Exercise 3: integration test design at platform level.** The testcontainers-go pattern in Exercise 3 is a starting point for a test that, at the platform level, should also test: connector restart after slot invalidation (does the consumer handle a burst of `op: r` events correctly?), consumer group rebalance during processing (does the consumer correctly commit offsets before rebalancing?), and schema evolution (does the consumer handle a new field in the Debezium envelope without panicking?). A senior engineer's contribution to a shared test framework for CDC consumers is a set of parameterized integration tests that any consumer can run against their implementation, covering these failure scenarios without each team reimplementing them.

---
