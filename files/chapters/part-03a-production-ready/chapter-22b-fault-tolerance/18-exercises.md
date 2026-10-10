## Exercises

1. **Bulkhead sizing**: 200 RPS to a DB with P99 150ms. Calculate the correct limit, then implement it with Prometheus metrics and a `promtool test rules` case proving your rejection-rate alert actually fires.
2. **Timeout budget**: Implement `TimeoutBudget` that logs a warning when >80% of budget is consumed in one operation.
3. **Fallback chain**: Weather API with 3 providers + cached historical data fallback. Metric each tier's hit rate.
4. **Jitter benchmark**: Implement full, equal, and decorrelated jitter strategies. Plot timing distributions with a benchmark test.
5. **Fault injection**: Add middleware injecting 20% errors + 200ms latency at 30%. Write tests verifying your retry logic handles this.
6. **Partial results**: Product API fetching from 4 sources (inventory, pricing, reviews, recommendations). Return partial with missing-fields metadata.
7. **Error budget calculator**: Read Prometheus error rate, calculate remaining monthly budget, alert via Slack at <25%.
8. **Adaptive LIFO**: Implement a queue that serves FIFO normally and flips to LIFO once depth exceeds a threshold. Benchmark both under overload AND under normal load, and report where LIFO helps and where it hurts.
9. **Adaptive bulkhead**: Auto-adjust the limit from observed latency, in the style of Netflix's gradient limiter. Seed the limit above zero, clamp the gradient, and round rather than truncate. Write a test proving a healthy service grows the limit and a sustained latency spike shrinks it.
10. **Integration test**: Wire all patterns into one gateway. Simultaneously inject: slow auth (500ms), DB 10% errors, cache fully down. Verify valid partial response within 2s.

### Staff / Principal Track

11. **Fault-tolerance audit.** For one service, assess every external call against the pattern checklist (timeout, retry, fallback). Close gaps.

12. **Chaos engineering program.** Pilot chaos testing on one service. Identify gaps. Drive org-wide adoption.

13. **Availability measurement.** Define SLOs per service. Measure availability. Report monthly to engineering leadership.

14. **Production readiness gate.** Add fault-tolerance criteria to the production readiness checklist.

15. **Incident-driven improvement.** For the last five incidents, extract fault-tolerance gaps. Close each with a documented improvement.
