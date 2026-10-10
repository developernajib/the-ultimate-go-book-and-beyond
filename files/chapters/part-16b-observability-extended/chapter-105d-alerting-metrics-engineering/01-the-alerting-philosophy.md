## 105D.1 The Alerting Philosophy

Effective alerting follows a strict hierarchy: only page an engineer when a user-visible symptom is occurring or an SLO burn rate is high enough to exhaust the error budget within hours. Alerting directly on causes (CPU utilization, GC pause duration, thread counts) produces alert fatigue because these metrics fluctuate constantly without necessarily impacting users. The Google SRE model captured in this pyramid reserves paging for the top two tiers and redirects the bottom tier entirely to dashboards consulted during post-mortems and capacity planning.

```
┌───────────────────────────────────────────────────────────────────────┐
│                    ALERTING PYRAMID                                   │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│                    ┌──────────────┐                                   │
│                    │  Business    │ ← Alert when users are impacted   │
│                    │  SLOs breach │   (customer-facing metrics)       │
│                   /└──────────────┘\                                  │
│                  /                  \                                 │
│                 /  ┌──────────────┐  \                                │
│                /   │  Symptoms    │   \  ← Alert on symptoms not      │
│               /    │  (latency,   │    \   causes (e.g. high p99      │
│              /     │  errors)     │     \  not "CPU is 80%")          │
│             /      └──────────────┘      \                            │
│            /                              \                           │
│           /      ┌──────────────────┐      \                          │
│          /       │ Causes (CPU, GC, │       \  ← NOT alerts,          │
│         /        │ memory, threads) │        \   use dashboards       │
│        /         └──────────────────┘         \                       │
│       ────────────────────────────────────────                        │
│                                                                       │
│  Google SRE Rule: Alert on user impact, not system metrics            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: The Google SRE Rule Is a Decision Filter

"Alert on user impact, not system metrics" is a filter you apply to every alert you consider adding. Before adding any alert, ask: "If this alert fires, is a user experiencing a degraded service?" If yes, add it. If no (for example, "CPU is at 70%" when users are not affected), do not add it as a page-worthy alert. Put it on a dashboard instead.

The practical test: simulate the alert condition in staging and verify that it would have fired during real past incidents while not firing during routine operational events. If you cannot run this test, you do not have enough data to calibrate the alert correctly.

### Senior @ FAANG: Alerting Philosophy as a Platform Policy

At L6, the alerting philosophy is not a guideline: it is a platform policy with enforcement teeth. Alert rules that page on system metrics (CPU, memory, disk) without a correlated user impact metric are rejected in the CI review. Alert rules without a `for` clause are rejected. Alert rules without a `runbook_url` annotation are rejected. These rejections are automated: a custom Prometheus rule linter runs in CI and blocks merges that violate the policy. An L6 engineer writes and maintains this linter as part of the platform toolchain.

---
