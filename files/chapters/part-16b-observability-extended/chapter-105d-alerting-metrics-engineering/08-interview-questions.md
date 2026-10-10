## 105D.8 Interview Questions

**Q: What is an error budget and how does burn rate alerting work?**

**What FAANG expects:** 99.9% SLO = 43.2 min/month of allowable unreliability. Burn rate = rate of budget consumption. Multi-window multi-burn-rate alerts (Google SRE Workbook Ch. 5). Canonical burn rates: 14.4 (exhausts a 30d budget in ~2 days = page), 6 (5 days = page), 3 (10 days = ticket). Bonus for naming Sloth or OpenSLO for spec-driven SLO definitions.

A: An error budget is the allowable amount of unreliability defined by your SLO. For a 99.9% SLO over 30 days, you have 0.1% × 30 days × 24h × 60m = 43.2 minutes of allowable downtime. Burn rate indicates how fast you're consuming this budget. A burn rate of 1.0 means you'll exactly exhaust it at the end of the window, and 14.4 means you'd exhaust it in 1/14.4 of the window (~2 days). Multi-window alerting requires both a long window (for sensitivity) and a short window (for recency) to exceed the threshold, reducing false positives.

**Q: Why is alerting on percentiles (p99) better than alerting on averages for latency?**

**What FAANG expects:** Averages hide the tail. Medians miss outliers. P99 captures worst 1% user experience. Bonus for explaining that p99 over a 5-minute window is unstable at low traffic (few samples), and the fix is either longer windows or the ratio-based SLI formulation (`good_events / total_events` where "good" = under threshold).

A: Averages hide tail behavior. If 1% of requests take 10 seconds and 99% take 100ms, the average is about 200ms, seemingly acceptable. But 1% of users experience terrible performance. P99 (99th percentile) shows the worst latency experienced by 1% of your users. For many services, SLOs are defined in terms of percentiles specifically because they capture user experience better than averages.

**Q: What is the difference between alerting on symptoms vs causes?**

**What FAANG expects:** Page on symptoms (user-visible: error rate, latency SLO breach). Dashboards for causes (CPU, memory, GC, connection pool). The symptom rule is Rob Ewaschuk's philosophy note from Google, required reading. Bonus for recognizing that cause-based alerts are fine for capacity-planning ticket generation, just not for paging someone at 3 AM.

A: Symptom-based alerting fires when users are affected (high error rate, slow responses). Cause-based alerting fires on infrastructure metrics (high CPU, memory pressure, GC pause time). Alert on symptoms because (1) high CPU might not impact users if the service is still fast, (2) low CPU might still have high latency due to external dependencies, and (3) symptom alerts are actionable: you know users are affected. Use cause-based metrics in dashboards for diagnosis, not as primary alerts.

**Q: (Amazon) You are paged at 3 AM for a CPU-based alert but the service appears healthy. How do you redesign the alert to respect the "Dive Deep" and "Customer Obsession" LPs?**

A: The alert violates symptom-based alerting principles because CPU is a cause, not a user-visible signal. Redesign by defining the SLI that maps to customer experience, typically request success rate and p99 latency on the public API. Compute multi-window, multi-burn-rate alerts against an explicit SLO (for example, 99.9% success over 30 days). Page only when the short window (5m at 14.4x burn) AND long window (1h at 14.4x burn) both breach. Retain the CPU metric as a dashboard panel linked from the runbook so the on-call can dive deep into root cause after the symptom alert fires. This eliminates 3 AM pages when no customer is affected.

**Q: (Netflix) How do you prevent high-cardinality label explosion in Prometheus while still supporting per-tenant SLO tracking for 50,000 tenants?**

A: Do not use `tenant_id` as a Prometheus label at that cardinality: the active series count will OOM the server. Instead, export per-tenant counters via a dedicated remote-write path into a columnar store like Mimir or VictoriaMetrics that tolerates millions of series, or aggregate tenants into bucketed tiers (`tier="gold"|"silver"|"bronze"`) for Prometheus while streaming raw per-tenant events to ClickHouse for ad-hoc SLO queries. Keep only the bucketed series in the alerting path and reserve per-tenant SLO dashboards for the columnar backend. Always validate cardinality in CI by scraping a representative sample and failing if `count by (__name__)` exceeds the service's budget.

### Junior → FAANG: These Questions Have a Known Structure

Each interview question above follows the same structure: a common problem, the Google/Amazon/Netflix context that makes it FAANG-specific, and the correct answer that demonstrates operational maturity. Prepare for this structure: know the canonical answer, then practice adding the context that shows you have operated the system rather than just read about it.

The Netflix per-tenant cardinality question is the hardest and most differentiating. The answer requires knowing that Prometheus cannot handle 50,000 label values, knowing the alternatives (Mimir, VictoriaMetrics, ClickHouse), and knowing when to use each. This is senior-level knowledge that requires experience with high-scale metric systems.

### Senior @ FAANG: Bar-Raiser Signals in Alerting and Metrics Interviews

A bar-raiser for an L6 candidate looks for answers that go beyond implementation to governance. For the error budget question, does the candidate mention Sloth or OpenSLO for declarative SLO definitions? For the cardinality question, does the candidate propose a CI enforcement mechanism (not just a guideline)? For the symptom vs. cause question, does the candidate mention the operational model for cause-based metrics (dashboards linked from runbooks, not alert rules)?

The distinguishing signal is organizational thinking: the candidate proposes not just a solution for the specific problem but a mechanism that prevents the problem class from recurring across all services. This is the difference between an L5 answer (solve this specific problem) and an L6 answer (design the system that prevents this class of problem).

---
