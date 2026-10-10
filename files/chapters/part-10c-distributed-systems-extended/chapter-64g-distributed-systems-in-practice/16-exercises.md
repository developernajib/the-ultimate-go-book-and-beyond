## Exercises with Complete Solutions

### Exercise 1: Partition-Tolerant Cache Service

**Task**: Build a cache service that:
1. Uses Redis as the backing store
2. During Redis unavailability: serve stale cached values for up to TTL, then return 503
3. Uses an in-memory LRU as the local cache (library: `github.com/hashicorp/golang-lru`)
4. Circuit breaker: after 5 consecutive Redis failures, open circuit (skip Redis, use memory only)
5. Write integration tests using testcontainers-go that simulate Redis unavailability

**Expected behavior documentation**:
```go
package exercises

import "time"

type CachePartitionBehavior struct {
    RedisDown struct {
        InMemoryHit  string // "Return stale value from memory cache"
        MemoryMiss   string // "Return 503 - no data available"
    }
    RedisSlowResponse struct {
        Timeout     time.Duration // 500ms
        Fallback    string // "Use memory cache if available"
    }
}
```

### Exercise 2: Hybrid Logical Clock Library

**Task**: Implement a production-grade HLC library:
1. `type Clock struct { ... }` with `Now() HLC` and `Update(received HLC) (HLC, error)`
2. Configurable max drift (reject received HLCs too far in future)
3. Thread-safe implementation
4. Encode/decode HLC as 8 bytes (6 bytes physical, 2 bytes logical) for efficient wire format
5. Test: verify HLC ordering is consistent with causality in concurrent operations
6. Benchmark: measure overhead vs `time.Now()` - should be <1µs

### Exercise 3: Saga Pattern Implementation

**Task**: Implement an order placement saga with compensation:
1. Steps: `ReserveInventory → ChargePayment → CreateShipment`
2. Compensation: `CancelShipment → RefundPayment → ReleaseInventory`
3. State machine: each saga has states (STARTED, RESERVE_DONE, PAYMENT_DONE, COMPLETE, COMPENSATING, COMPENSATED, FAILED)
4. Persistent saga state in PostgreSQL (so saga survives process restart)
5. Test: simulate payment failure mid-saga, verify inventory is correctly released

### Exercise 4: Distributed Systems Design Review

**Task**: Apply the design review checklist to an existing Go service in your organization (or a sample service provided):
1. Audit: does every downstream call have a timeout? Are they configured correctly (cascade budget)?
2. Identify missing circuit breakers
3. Document partition behavior for each dependency
4. Verify idempotency of all retried operations
5. Write 3 new tests that simulate failure modes not currently tested

### Junior → FAANG: Making the Most of Each Exercise

The four exercises in this section are ordered by learning value for interview preparation. Exercise 2 (HLC library) is the single most useful exercise for interviews: implementing HLC from the description in this chapter, without copying the provided code, builds the deep understanding needed to explain it fluently under interview pressure. Time yourself: can you implement a correct, thread-safe HLC in 45 minutes? That is the interview time constraint.

Exercise 1 (partition-tolerant cache) is the most impactful exercise for first-job production readiness. Building a service that degrades gracefully (stale cache, then 503) and recovers automatically (circuit breaker reset) covers the most common distributed systems scenario you will encounter in your first year.

For Exercise 3 (saga pattern): before implementing, draw the state machine on paper. Identify every state transition and every failure mode. The state machine is the design artifact that prevents incomplete implementations. Candidates who implement sagas without an explicit state machine tend to miss the compensation path for failures that occur during compensation itself (a compensating transaction that fails requires its own retry strategy).

Exercise 4 is the most directly applicable to a first job: applying the checklist to a real service surfaces gaps that affect real users. Start with the timeout audit (Exercise 4, step 1) because missing timeouts are the most common cause of cascading failures and the easiest to fix.

### Senior @ FAANG: Extending the Exercises for Staff-Level Impact

The exercises as written target L4/L5 skill development. Staff engineers can extend each exercise to produce platform-level artifacts with broader organizational impact.

**Exercise 1 extension: make it a reusable library.** Rather than building a partition-tolerant cache service for one use case, extract the graceful degradation pattern (stale-on-partition, circuit breaker, automatic recovery) into a reusable Go library that any service can wrap around any dependency. Define a `DegradableClient[T]` interface that handles the degradation logic generically. The library becomes an internal platform artifact, reducing the per-service implementation burden and ensuring consistent partition behavior documentation across all services that use it.

**Exercise 2 extension: integrate HLC into the shared SDK.** A standalone HLC library is useful. An HLC library integrated into the team's HTTP client (automatically included in request and response headers), gRPC interceptor, and message producer/consumer is transformative. Extend Exercise 2 to include these integrations, with tests that verify end-to-end causal ordering across two services communicating via HTTP and a Kafka topic. This integration is the platform artifact that makes correct clock handling the default rather than the exception.

**Exercise 3 extension: add a saga orchestrator with persistence.** The exercise as written specifies PostgreSQL persistence for saga state. Extend it to include a saga orchestrator service: a central component that drives saga execution, handles step timeouts, and triggers compensations. The orchestrator makes the saga state observable (every saga has a queryable status), adds retry semantics per step (some steps should retry, some should not), and provides a clean separation between saga definition (what the business process is) and saga execution (how it is driven). This is the architecture used by Temporal and Cadence, and understanding it at the implementation level is a significant staff-level capability.

**Exercise 4 extension: produce a team capability report.** Rather than auditing one service, apply the checklist to all services the team owns and produce a capability report: how many services pass each checklist item, what are the top three gaps across the portfolio, and what is the minimum investment to close each gap? Present the report in the team's next engineering review. This exercise converts an individual learning activity into an organizational improvement input, which is the correct scope for staff-level engineering work.

---
