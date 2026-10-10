## SLOs and Error Budgets

A service without an SLO has no shared definition of "working." Engineers argue about whether a 50ms p99 latency is acceptable. Product managers argue about whether last week's outage was bad. Customers argue about whether their contract was met. Without a number to anchor the conversation, every conversation is rhetorical.

An SLO turns reliability from an opinion into a measurement. This chapter is about defining one well, and operating against it.

### The Vocabulary

**SLI** (Service Level Indicator): a metric. "Fraction of requests that completed within 200ms." A number between 0 and 1.

**SLO** (Service Level Objective): a target value of an SLI. "99.9% of requests complete within 200ms over the last 28 days." A promise the team makes to itself and to upstream customers.

**SLA** (Service Level Agreement): a contractual SLO. "If we fail the SLO, we owe the customer a service credit." Always weaker than the internal SLO (you want the internal target tighter than the contractual one).

**Error budget**: the inverse of the SLO. If the SLO is 99.9%, the error budget is 0.1%. Over a 28-day window, that is 40 minutes of downtime equivalent.

### What Makes a Good SLI

A good SLI is:

- **User-centric.** Measures what the user experiences, not internal mechanism. "Successful requests below 200ms," not "CPU below 80%."
- **Calculable.** Computable from existing telemetry. If you have to invent new instrumentation to measure it, the SLI is too clever.
- **Symmetric.** Both numerator and denominator are clear. "Requests completed within 200ms" / "Total requests." Not "Requests completed within 200ms" / "Some subset that we will define later."
- **Stable.** The metric does not change definition every quarter.

Bad SLIs:

- "CPU usage" (internal mechanism, not user impact).
- "Average latency" (the average is a poor proxy for the tail).
- "Number of errors" (without a denominator, the absolute count is meaningless).

Good SLIs:

- Availability: `successful_requests / total_requests`.
- Latency: `requests_below_threshold / total_requests`.
- Quality: `correct_responses / total_responses` (for ranking, search, recommendations).
- Freshness: `requests_with_data_younger_than_X / total_requests`.

### Defining an SLO

An SLO is a number plus a window. "99.9% over 28 days" is different from "99.9% per hour."

The window choice:

- Short windows (hours to days) catch acute failures fast but are noisy.
- Long windows (28+ days) smooth the noise and reflect the customer experience over a meaningful timeframe.
- Multi-window SLOs combine both.

The standard at most large shops: a 28-day rolling window for the headline SLO, plus shorter windows for alerting (which we will discuss below).

The number choice:

- 99% is two nines: 7 hours of error budget per month.
- 99.9% is three nines: 43 minutes per month.
- 99.99% is four nines: 4.3 minutes per month.
- 99.999% is five nines: 26 seconds per month.

Each "nine" is roughly 10x more engineering work than the previous. Setting an SLO too tight is expensive (the team spends all its time chasing the nines instead of shipping features). Too loose, and customers churn. Calibrate from data: what does the user actually experience, what do they complain about?

### The Error Budget Discipline

The error budget is the operational implication of the SLO. If you have 40 minutes of downtime equivalent per 28 days, you can spend it on:

- Real outages.
- Risky deploys.
- Performance regressions.
- Chaos experiments.

The discipline: when the budget is exhausted, the team's priority shifts from feature work to reliability work until the budget is restored. This is the SRE's use, it forces a conversation between product (who wants features) and engineering (who knows the service is fragile).

Some teams formalize this:

- Budget healthy: feature work normal.
- Budget approaching exhaustion: reduce risk on deploys, defer non-critical changes.
- Budget exhausted: only reliability and rollbacks until budget recovers.

The conversation that this triggers ("we cannot ship feature X this sprint because the service is over its error budget") is the entire point.

### Burn-Rate Alerting

The naive alert: page when monthly SLO is breached. By the time it fires, you are already over budget, there is no value in paging.

The better alert: page when the budget is being burned faster than it should be. If the budget is for 28 days and you are spending it 10x faster, you will be out of budget in 2.8 days.

Single-window burn-rate:

```
burn_rate = (1 - SLI) / (1 - SLO)
```

If SLO is 99.9%, then `1 - SLO = 0.001`. If SLI over the last hour is 0.99 (99%), then `1 - SLI = 0.01`, and burn_rate = 10. The budget is being consumed 10x faster than allocation.

Alert thresholds (Google's standard):

- Burn rate > 14.4 over 1 hour: page (consumes 1 month of budget in 2 days at this rate).
- Burn rate > 6 over 6 hours: page (consumes 1 month of budget in 5 days).
- Burn rate > 3 over 1 day: ticket (slower burn, less urgent).
- Burn rate > 1 over 3 days: ticket (steady but unsustainable).

### Multi-Window Multi-Burn-Rate (MWMBR) Alerts

Single-window alerts have two failure modes:

- A short window catches fast burns but flickers on noise.
- A long window catches sustained problems but is slow to alert.

The multi-window pattern: alert when both a short window and a long window are burning above threshold. The long window confirms the burn is sustained, the short window keeps detection fast.

```
alert: page if (1h burn rate > 14.4) AND (5m burn rate > 14.4)
alert: page if (6h burn rate > 6) AND (30m burn rate > 6)
```

The short windows act as a filter: they confirm the long window's signal is real, not noise. This combination has dramatically fewer false pages than either alone.

### A Real SLO Setup

For a search service with an availability SLO of 99.9% and a latency SLO of "99.5% of requests under 200ms," over 28 days:

```yaml
slos:
  availability:
    sli: rate(successful_requests) / rate(all_requests)
    target: 0.999
    window: 28d
    alerts:
      - severity: page
        condition: 1h burn > 14.4 AND 5m burn > 14.4
      - severity: page
        condition: 6h burn > 6 AND 30m burn > 6
      - severity: ticket
        condition: 24h burn > 3 AND 2h burn > 3

  latency:
    sli: rate(requests_under_200ms) / rate(all_requests)
    target: 0.995
    window: 28d
    alerts:
      # similar structure
```

The dashboard shows the budget remaining (in minutes-equivalent) and the trajectory (how fast it is being consumed). The on-call team's job is partly to keep the trajectory shallow.

### What an SRE Team Does With Budget Exhaustion

Three options:

1. **Pause feature deployment.** No new code shipped until reliability work pays down the budget.
2. **Reduce deploy risk.** Smaller canary percentages, longer bake times, more conservative rollback thresholds.
3. **Reliability-only sprint.** The next sprint or two is dedicated to fixing the underlying causes that consumed the budget.

The hardest part is socializing the policy with product partners before the budget exhausts. "When the budget is gone, we pause feature work" must be agreed in advance, when the team is not in crisis.

### Pitfalls

**SLOs that are too easy.** A 99% SLO that the service never breaches is not motivating. The SLO should be tight enough that it is occasionally challenged.

**SLOs that are too tight.** A 99.99% SLO that the service can never realistically meet creates a permanent budget exhaustion, and the policy loses meaning.

**SLI that does not measure what users care about.** A latency SLO based on the median misses the tail, which is what users actually feel.

**Budget that resets the wrong way.** A monthly reset (calendar month) is bad: a bad week early in the month leaves no slack for the rest. A rolling 28-day window is better: every day is a fresh edge.

**No follow-through.** The SLO exists, the budget is exhausted, nothing happens. The discipline lapses, engineers stop trusting the metric.

### SLO Hierarchy

A complex service has nested SLOs:

- A top-level user-facing SLO (e.g., search latency).
- Per-component SLOs (each backend in the fan-out).
- Per-dependency SLOs (the database, the auth service).

The math: if the top-level SLO requires 99.9% and the request fans out to 5 backends, each backend must be roughly 99.98% to leave any margin. The top-level SLO drives the per-component targets, not the other way around.

### Senior at FAANG: The Reliability Negotiator

The senior frame: SLOs are the negotiating mechanism between product and reliability. The senior engineer chairs the conversation. They translate "users complained about slowness" into a metric, define a target, set alert thresholds, and align the team behind the policy. Without this work, reliability is a vibe, with it, reliability is a measurable, negotiable engineering input.

---
