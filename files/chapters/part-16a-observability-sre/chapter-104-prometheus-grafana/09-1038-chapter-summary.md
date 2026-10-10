## 104.9 Mid-Chapter Synthesis: Prometheus Core Concepts Recap

### Prometheus Best Practices

Effective Prometheus usage requires discipline at the metric design level because mistakes, particularly unbounded label cardinality from values like `user_id` or `request_id`, compound into TSDB memory exhaustion and query timeouts that are difficult to remediate without data loss. Naming conventions (the `_total` suffix on Counters, `_seconds` or `_bytes` unit suffixes) are checked by `promtool check metrics` (the promlint linter) and make PromQL expressions self-documenting. Histogram bucket boundaries should be derived from your SLOs: placing bucket edges at the target latency thresholds (e.g., 50ms, 100ms, 250ms) makes `histogram_quantile` estimates accurate precisely where accuracy matters most.

```
┌──────────────────────────────────────────────────────────────────┐
│               PROMETHEUS BEST PRACTICES                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  METRIC DESIGN:                                                  │
│  □ Use meaningful metric names                                   │
│  □ Include units in names (_seconds, _bytes, _total)             │
│  □ Use appropriate metric types                                  │
│  □ Keep cardinality under control                                │
│                                                                  │
│  LABELS:                                                         │
│  □ Use labels for dimensions, not values                         │
│  □ Avoid high-cardinality labels (user_id, request_id)           │
│  □ Keep label sets consistent                                    │
│  □ Use labels that aid debugging                                 │
│                                                                  │
│  HISTOGRAMS:                                                     │
│  □ Choose buckets based on SLOs                                  │
│  □ Include buckets around target latencies                       │
│  □ Use exponential bucket growth                                 │
│                                                                  │
│  ALERTING:                                                       │
│  □ Alert on symptoms, not causes                                 │
│  □ Include runbook URLs                                          │
│  □ Set appropriate severity levels                               │
│  □ Avoid alert fatigue                                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Chapter Summary as a Pre-Interview Checklist

Before an observability-focused interview, verify you can do these five things without notes: register a counter, gauge, and histogram in Go. Write a `rate()` PromQL query over a counter. Write a `histogram_quantile()` query over a histogram. Write an alert rule with a `for` clause and annotations. And describe the difference between a recording rule and an alerting rule.

These are the baseline mechanics that interviewers assume you have before moving to system design questions.

### Senior @ FAANG: Summary as a Platform Maturity Benchmark

Use this checklist as a maturity assessment for your organization's Prometheus platform. A maturing platform has: metric naming standards enforced by CI. Cardinality budgets enforced by Prometheus configuration. Alert rules tested with `promtool`. Dashboards stored in version control. Recording rules for all high-cost queries used in alerts. And a quarterly metric lifecycle audit that removes unused series. An organization that has all six is operating Prometheus as a mature platform asset, not just as a monitoring tool.

---
