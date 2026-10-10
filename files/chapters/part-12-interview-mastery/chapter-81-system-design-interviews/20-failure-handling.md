## Failure Handling

1. **Timeline cache miss**: Rebuild from tweet store (slower)
2. **Fan-out lag**: Users see timeline eventually (acceptable)
3. **Celebrity fetch failure**: Show timeline without their tweets

### Junior → FAANG: Designing for Failure

Every system fails. The junior-to-FAANG gap on failure handling is moving from 'we will add retries' to actually designing for partial failure states. Know the core patterns: circuit breaker (stop sending requests to a failing downstream so it can recover), bulkhead (isolate failures to a subset of resources so they do not cascade), timeout (set explicit deadlines on all external calls), retry with exponential backoff and jitter (avoid thundering herd). For interviews, demonstrate that you think about failure at every component boundary: what happens when the cache is unavailable, when the database primary fails, when the message queue is full. The minimum bar is knowing that timeouts must be finite and that infinite retries are dangerous.

### Senior @ FAANG: Failure Mode Analysis and Resilience Governance

At the senior level, failure handling is a formal engineering discipline. The ADR for every new dependency should include a failure mode analysis: how does the system behave when this dependency is slow, when it is unavailable, and when it returns corrupted data. At L6, bar-raisers expect failure handling to be quantified: what is the SLO for the dependency, what is the SLO for your service, and how does a dependency breach affect your SLO budget. The error budget concept connects failure handling to organizational governance: teams that spend their error budget on avoidable incidents face change freeze periods. Staff-level concerns include cross-region failure planning: active-active versus active-passive strategies, data replication lag in a regional failover, and the operational runbook for declaring and executing a regional fail-over. Chaos engineering is the senior-level practice that validates failure assumptions: running GameDays or chaos experiments to ensure that the circuit breakers, bulkheads, and failover procedures actually work as designed.

---

### Exercise 2: Design a File Storage System - Complete Solution

**Requirements**:
- Upload/download files up to 10GB
- Sync across devices
- Share with permissions
- Version history

The reference solution follows, from capacity estimation through the trade-offs summary.
