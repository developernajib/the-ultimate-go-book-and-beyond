## Exercises

### Exercise 1: Implement Weighted Round-Robin Traffic Splitting

Extend the `StranglerProxy` to support weighted round-robin splitting (independent of entity ID), where a configurable percentage of all requests go to the new service regardless of feature flags. This is useful for load testing the new service at a known traffic fraction.

**Hint:** Use an atomic counter that increments on every request. Modulo the counter by 100 and compare against the configured weight. Ensure the counter rolls over gracefully using `atomic.Int64`.

### Exercise 2: Persist Shadow Comparison Results

The current `ShadowRunner` logs divergences but discards them after processing. Implement a `PostgresResultSink` that stores all `ComparisonResult` records in a `shadow_comparisons` table for offline analysis.

Schema:
```sql
CREATE TABLE shadow_comparisons (
    id            BIGSERIAL PRIMARY KEY,
    request_id    TEXT NOT NULL,
    path          TEXT NOT NULL,
    method        TEXT NOT NULL,
    legacy_status INT NOT NULL,
    new_status    INT NOT NULL,
    status_match  BOOL NOT NULL,
    body_match    BOOL NOT NULL,
    diffs         JSONB,
    legacy_latency_ms BIGINT,
    new_latency_ms    BIGINT,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_shadow_path_match ON shadow_comparisons (path, body_match, captured_at DESC);
```

### Exercise 3: Implement Circuit Breaker for Dual-Write Secondary

The current `Coordinator` retries failed secondary writes but has no circuit breaker. If the new service is down, the retry queue fills and goroutines stack up. Implement a circuit breaker that opens after 5 consecutive failures, half-opens after 30 seconds, and closes after 3 successes in the half-open state.

### Exercise 4: Canary Analysis Automation

Build a `CanaryAnalyzer` that compares two time windows of metrics (baseline vs. canary) and returns a recommendation: `PASS`, `WARN`, or `FAIL`. Compare: error rate, P99 latency, shadow match rate. A `FAIL` should trigger automatic rollback via the `rollback.Controller`.

Thresholds:
- Error rate: FAIL if canary > baseline * 1.5
- P99 latency: WARN if canary > baseline * 1.1, FAIL if > baseline * 1.25
- Shadow match rate: FAIL if < 99.0%

### Exercise 5: Distributed Flag State with etcd

Replace the file-based `featureflags.Engine` config loading with a live etcd watch. The engine should update flags within 1 second of a change in etcd, with no restart required. Implement graceful handling of etcd unavailability: fall back to the last known good state and log an alert.

### Exercise 6: Migration Progress Dashboard Endpoint

Implement a `/admin/migration/progress` HTTP endpoint that returns a JSON report including: current traffic split percentages per flag, shadow match rates per endpoint over the last 1 hour, dual-write error rates, and reconciliation mismatch counts. The endpoint must be secured with a pre-shared token in the `Authorization: Bearer <token>` header.

### Junior → FAANG: Choosing Exercises as a Skill Gap Diagnostic

The six exercises above are not equally difficult. Exercises 1 and 2 are implementation exercises: they require translating a clear specification into working Go code. Exercises 3 and 4 require understanding state machine design (circuit breaker) and statistical analysis (canary analysis). Exercises 5 and 6 require integrating external systems (etcd, HTTP auth) correctly.

For early-career engineers, the recommended order is 1, 2, 6, 3, 4, 5. Start with the two exercises that translate a clear specification into code. Exercise 6 adds an authentication requirement that is common in real systems (bearer token validation). Exercise 3 introduces the circuit breaker state machine, which is one of the most important reliability patterns in distributed systems. Exercise 4 requires defining quantitative thresholds for automated decisions, which is a skill that bridges implementation and system design. Exercise 5 introduces distributed state and failure handling, which is the most complex of the six.

For Go engineers specifically: Exercise 5 (etcd watch) is the exercise most likely to expose gaps in your understanding of Go's context cancellation and channel-based lifecycle management. An implementation that does not correctly handle etcd disconnection, reconnection, and graceful shutdown will fail under network partition conditions. This is exactly the kind of failure mode that appears in FAANG on-call scenarios.

### Senior @ FAANG: Extending Exercises as System Design Interview Preparation

At senior level, these exercises are starting points for system design conversations, not end states. Each exercise can be extended into a full system design question by adding constraints that require architectural trade-offs.

Extended versions for senior preparation: Exercise 3 (circuit breaker) can be extended to a distributed circuit breaker where all instances of the proxy share circuit state via Redis, which requires answering questions about consistency (is it acceptable for one instance to see open state while another sees closed?), performance (how often do instances synchronize state?), and failure handling (what happens when Redis is unavailable?). Exercise 4 (canary analysis) can be extended to an automated progressive delivery system where the canary analyzer result triggers the next traffic ramp step, which requires answering questions about the automation governance model (who can override an automated FAIL decision, how are automated rollbacks audited, what is the escalation path when the analyzer produces inconsistent results across consecutive windows?). Exercise 5 (etcd integration) can be extended to a multi-region flag distribution system where flag state must propagate to all regions within a defined SLO, which requires answering questions about consistency models (is eventual consistency acceptable for feature flags, or do you need read-your-writes guarantees?) and the failure mode for network partitions between regions.

Completing these exercises in their extended forms and being able to explain the trade-offs at a whiteboard is the bar for passing system design rounds at L6 for distributed systems roles.

---
