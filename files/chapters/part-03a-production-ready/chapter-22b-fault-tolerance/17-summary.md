## Summary

Fault tolerance keeps systems functional *during* failure. The patterns form a layered defense:

| Layer | Pattern | Protects Against |
|-------|---------|-----------------|
| Entry | Load shedding, admission control | Overload |
| Isolation | Bulkheads, tenant isolation | Cascading failures |
| Timing | Timeout hierarchy, budget | Latency amplification |
| Behavior | Graceful degradation | Partial dependency failure |
| Results | Fan-out with partial success | Non-critical data unavailability |
| Recovery | Fallback chains | Complete dependency failure |
| Retry | Full jitter + idempotency keys | Transient failures |
| Measurement | Error budgets, burn rates | Invisible degradation |

No single pattern is sufficient. Layer them, add metrics to all of them, and test every path with fault injection.

### For the Senior-at-FAANG Track

Review every external call for timeout, retry, and fallback. Reject PRs without these. Consistent application prevents most production incidents.

### For the Staff and Principal Track

Drive the org's fault-tolerance standards. Chaos engineering program. Production readiness checks. Measure availability per service, aligned with business SLOs. Treat every incident as improvement opportunity.

---
