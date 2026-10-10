## Canary Deployments and Staged Rollouts

A canary is the small share of traffic you deliberately point at the new binary, before you commit to global rollout, in order to find the bugs that only manifest at scale. Done well, a canary catches regressions while the blast radius is bounded. Done poorly, it is theater that adds deploy time without catching anything.

This chapter is about the well-done version.

### What a Canary Is For

Three classes of bugs that unit tests, integration tests, and load tests cannot catch:

1. **Bugs that depend on real traffic distribution.** Your synthetic load is uniform, real traffic has heavy hitters, adversarial users, and a long tail.
2. **Bugs that depend on real dependencies.** Test environments mock the database. Production has connection pools, replica lag, slow queries, and the occasional dropped packet.
3. **Bugs that only appear at scale.** Lock contention at 10K QPS, heap fragmentation after seven days, file-descriptor exhaustion under traffic spikes.

A canary catches these by routing a small fraction of real traffic to the new binary on real production infrastructure with real dependencies.

### Blast Radius Math

The math:

```
blast_radius = traffic_share * impact_per_request * exposure_duration
```

A bad release with a 100% error rate:

- 1% canary for 10 minutes: 0.01 * 1.0 * 600s = 6 errors per 1000 QPS-second.
- 100% rollout, caught after 10 minutes: 1.0 * 1.0 * 600s = 600 errors per 1000 QPS-second.

The canary reduced impact by 100x. That is the entire point.

Two parameters control the math:

- **Traffic share.** Smaller is safer but slower to detect regressions (you need more canary-time to get statistical signal).
- **Exposure duration.** Longer detects more bugs (some only manifest after the canary has run for hours) but extends the window of risk.

A standard schedule:

```
1% for 30 minutes
5% for 1 hour
25% for 2 hours
50% for 1 hour
100%
```

Total deploy time: 4.5 hours per region, run sequentially across regions for global services. A FAANG-tier deploy of a critical binary takes a full day.

### Picking the Canary Population

Three patterns:

**Random sampling.** Pick a fixed percentage of incoming requests at the load balancer. Simple. Risk: high-value tenants are over-represented in errors when the canary breaks.

**Tenant-isolated.** Pick a list of tenants (often internal teams or test accounts) for the canary. Lower risk. Cost: the canary tenants are not representative of real load distribution.

**Geographic.** Pick one cluster in one region for the canary. Bounds blast radius to one geographic area. Common for global services.

A senior choice combines them: deploy first to internal tenants in one region (zero external blast radius), then to 1% random sampling in that region, then expand.

### Automated Rollback

Manual rollback is too slow. By the time a human reads the dashboard, decides, and types the rollback command, the canary has run for ten minutes longer than necessary. Automated rollback runs in under one minute.

The signal:

- **Latency regression.** p99 of the canary is X% higher than the control.
- **Error rate regression.** 5xx rate is X% higher.
- **Crash rate.** The canary is restarting at a higher rate than control.
- **Custom SLI.** Cache hit rate, queue depth, anything specific to your service.

The decision rule: a sustained regression on any signal for N minutes triggers automated rollback to the previous version.

Pseudocode in a deploy controller:

```python
def evaluate_canary(canary, control, window=300):
    canary_p99 = percentile(canary.latency_samples(window), 99)
    control_p99 = percentile(control.latency_samples(window), 99)
    if canary_p99 > control_p99 * 1.10:
        return "rollback: p99 regression"

    canary_err = canary.error_rate(window)
    control_err = control.error_rate(window)
    if canary_err > control_err + 0.005:
        return "rollback: error rate regression"

    if canary.restart_count(window) > control.restart_count(window) * 2:
        return "rollback: elevated restarts"

    return "healthy"
```

The 10% threshold and 0.5% absolute threshold are typical. Tighter thresholds catch more regressions but produce more false rollbacks.

### Bake Time

Even after the metrics look healthy, the canary should bake. Some bugs only appear after sustained load:

- Memory leaks become visible after hours.
- Heap fragmentation after days.
- Connection-pool exhaustion after a slow client buildup.
- Time-of-day effects (a query pattern that only appears during peak).

A common rule: between rollout stages, hold for a "bake time" equal to or longer than the longest periodic signal you care about. For most services, 30 minutes is enough, for services with day-of-week effects, the canary may need to run for a full week before global rollout.

### A/B Exposure for Regression Detection

A canary at 1% has 1% of the statistical signal of a full deploy. For subtle regressions (2% latency change), this means a long observation window before the test is significant.

A trick from search and ads experimentation: serve canary and control responses to the same user (1% are picked to receive both, with one as the live response and one as a shadow). The paired test has dramatically more power than independent samples, because user-level variance is removed.

This pattern is called "paired-canary" or "shadow-A/B." It requires the new binary to either be idempotent (safe to call twice) or the shadow path to discard the result. It is what Google uses for ranking changes in search.

### A Concrete Deploy Controller

The shape of a real C++ deploy:

```yaml
# rollout.yaml
strategy:
  - target: 1
    duration: 30m
    rollback_on:
      - p99_latency > control * 1.10 for 5m
      - error_rate > control + 0.005 for 5m
      - restart_rate > control * 2 for 3m
  - target: 5
    duration: 1h
    # ... same conditions
  - target: 25
    duration: 2h
  - target: 50
    duration: 1h
  - target: 100
```

The deploy controller (Spinnaker, Argo Rollouts, internal tooling) walks the strategy, monitors signals, and rolls back automatically. Human override available, but the default is hands-off.

### Real Postmortem Flavor

A C++ ranking service shipped a new tokenizer. All tests passed. Canary at 1% looked healthy for 30 minutes. The team promoted to 25%. Two hours in, p99 latency drifted up by 8%. The deploy controller did not roll back (threshold was 10%), but the dashboard tripped a human alert. Investigation showed the new tokenizer had different cache locality, costing two extra L2 misses per token. At 1% canary the effect was hidden by query-mix noise. At 25%, the effect became measurable. The rollback was manual, took 12 minutes, and 25% of users saw the regression for three hours.

The lesson the team adopted: tighten the p99 threshold to 5%, and add a 1% threshold for hour-long windows. False rollbacks went up slightly. Real regressions caught earlier went up by an order of magnitude.

### What Goes Wrong

- **The canary is on different hardware.** A canary that gets newer machines or different NUMA topology than control is not a canary. Pin canary instances to the same hardware tier.
- **The canary gets unrepresentative traffic.** An L7 load balancer that picks canary by user-agent hash will route bot traffic disproportionately. Pick canary by request hash, not by anything correlated with traffic shape.
- **The signal is too noisy.** A small canary with high variance can fail a healthy build half the time. Pick metrics with low variance (rate metrics aggregated over windows, not individual request latencies) and pick threshold sizes calibrated to baseline variance.
- **The bake time is too short.** A 5-minute bake catches none of the slow-burn bugs. Be generous, 30 minutes is the floor.

### Senior at FAANG: The Reliability Investment

A senior engineer designs the canary process before they ship the first feature. The deploy controller, the signal definitions, the rollback thresholds, the bake-time policy: all of these are infrastructure that pays back across hundreds of future deploys. A team that ships canary infrastructure once will spend the next decade benefiting from it. A team that does not will spend the next decade explaining outages.

---
