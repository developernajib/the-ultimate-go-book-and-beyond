## 104.13 Interview Questions: Prometheus & Grafana

### Q1: How would you set up monitoring for a new Go microservice?

**What FAANG expects:** RED (Rate, Errors, Duration) for request-driven services, USE (Utilization, Saturation, Errors) for resources. Native `prometheus/client_golang` with `promhttp.Handler()` exposing `/metrics`. Histograms (prefer native histograms, available since Prometheus 2.40 behind the `native-histograms` feature flag, client_golang 1.14+ via `NativeHistogramBucketFactor`) for latencies. Counters for events. Define SLIs/SLOs before wiring any dashboards. Bonus for naming exemplars (trace IDs attached to samples) and OpenMetrics format.

**Answer:**

Four steps, in order:

1. **Instrument the golden signals** with `prometheus/client_golang`:
   - `http_requests_total` (counter, labels: method, route, status)
   - `http_request_duration_seconds` (native histogram, label: route)
   - `http_requests_in_flight` (gauge)
   - One counter per business event you care about (logins, orders, etc.)

2. **Define SLIs/SLOs before dashboards**:
   - Availability SLI: `sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`
   - Latency SLI: `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`
   - SLO: 99.9% availability, p99 < 300ms. Error budget: 0.1% per 30-day window.

3. **Wire alerts on burn rate, not absolute thresholds**: multi-window multi-burn-rate alerts (1h+5m fast burn, 6h+30m slow burn) per the Google SRE workbook.

4. **Dashboards last**: one RED dashboard per service, one USE dashboard per host/pod, one SLO status dashboard for stakeholders.

**Follow-ups:**
- *Why native histograms over classic ones?* Classic histograms require fixed buckets (cardinality tax, wrong buckets = wrong quantiles). Native histograms (exponential buckets) adapt automatically, covering many orders of magnitude at substantially lower series cost.
- *What cardinality footguns will bite you?* Labels like `user_id`, `request_id`, raw URLs with IDs. Normalize to route templates (`/users/:id`), drop user/trace IDs from metrics (put them in traces + logs instead).
- *How do you ship metrics from ephemeral jobs (CronJobs, one-shot tools)?* Prometheus scrapes, so it cannot see jobs that die. Push to a Prometheus Pushgateway (for batch jobs only, not for services) or expose an endpoint the scheduler scrapes before tear-down.

### Q2: How do you scale Prometheus past a single instance?

**What FAANG expects:** Single Prometheus tops out around 1-5M active series depending on scrape interval. Scale via functional sharding (one Prometheus per team/region/service class), then federation for aggregate queries. For true horizontal scale, name **Mimir** (Grafana), **Thanos**, or **Cortex** as the production options. Bonus for explaining remote-write (Prometheus pushes to long-term store) vs remote-read trade-offs and for mentioning that VictoriaMetrics is the leaner single-binary alternative.

**Answer:**

Scaling strategy in order of complexity:

1. **Functional sharding**: one Prometheus per team/namespace/region. Scrape only what you own. Federation (`/federate` endpoint) aggregates upward for cross-team queries. Cap: ~1-5M series per shard.
2. **Remote write to long-term storage**: Prometheus pushes samples to Mimir/Thanos/Cortex/VictoriaMetrics. Local retention shrinks to a few hours. Long-term store keeps months/years and is horizontally sharded.
3. **Global query layer**: Mimir's query-frontend / Thanos Querier federates across sharded stores, presenting one logical view.
4. **Downsample older data**: 5m and 1h rollups for long-term queries cut the samples scanned for long-range queries by orders of magnitude.

Production default for new deployments in 2026: **Grafana Mimir** (actively maintained, Apache 2.0, no Cassandra dep like original Cortex) or **VictoriaMetrics** (smaller ops footprint, single binary).

**Follow-ups:**
- *Remote-write vs remote-read, when do you use each?* Remote-write is the ingestion path (Prometheus → long-term store). Remote-read lets Prometheus query the long-term store transparently, but the hop is slow and rarely used in practice. Prefer Mimir/Thanos querier for cross-store reads.
- *Mimir vs Thanos, how do you choose?* Mimir if you want a single maintained project (Grafana Labs) with built-in multi-tenancy. Thanos if you already run object storage and want to keep Prometheus-native architecture. Both converge on similar feature sets.
- *What is the cardinality ceiling per shard?* Rule of thumb: 1-5M active series per single Prometheus at 15s scrape. Above that, memory pressure and compaction pauses dominate. Split before you hit it.

### Q3: How do you design dashboards that operators actually use?

**What FAANG expects:** Start with USE/RED per level, layer in SLO burn-rate, exclude vanity metrics. Every panel answers a specific operational question. Annotate with deploy events so spikes correlate with releases. Bonus for citing the "Four Golden Signals" (Google SRE) and for knowing that Grafana's dashboard-as-code (Jsonnet, Grizzly, grafonnet, Terraform provider) is how mature teams manage dashboard drift.

**Answer:**

Three dashboard tiers:

1. **Service RED** (per service): request rate, error rate, duration p50/p95/p99. Annotate deploys. This is the first thing oncall opens.
2. **Infrastructure USE** (per pod/host): CPU utilization, memory saturation, network/disk errors. Answers "is the box healthy?"
3. **SLO status** (per product): error budget burn rate, remaining budget, fast/slow burn alerts. For product owners.

Principles:
- Every panel answers a specific question. Delete vanity charts.
- Template variables for service/cluster/env so one dashboard serves many instances.
- Annotations for deploys, config changes, incidents, link directly to runbook.
- Dashboards-as-code (Jsonnet/Grafonnet/Terraform), never hand-edit in UI for production dashboards.

**Follow-ups:**
- *Why not one "god dashboard" per team?* Operators open dashboards under stress. A 40-panel dashboard hides the one panel that matters. Three focused dashboards beat one sprawling one.
- *How do you keep dashboards in sync across environments?* Dashboards-as-code. Store JSON/Jsonnet in git, apply via Grafana API in CI. Manual UI edits get overwritten on next apply, intentionally.
- *What is the right refresh rate?* Match the scrape interval (typically 15s) or longer. Auto-refresh under 5s hammers Prometheus and rarely improves visibility. 30s is fine for most dashboards.

### Junior → FAANG: Interview Question Strategy for Prometheus Roles

Prometheus interview questions fall into three tiers. Tier 1 (all candidates): metric type selection, `rate()` vs. `irate()`, `histogram_quantile()` syntax, alert rule structure. Tier 2 (mid-level): recording rules, federation, cardinality management, Alertmanager routing. Tier 3 (senior): Thanos/Mimir architecture, multi-tenancy, query performance optimization, SLO alert design.

Prepare a concrete story about a metric or alert you designed and the operational impact it had. "I added a `db_connections_waiting_total` gauge and alerted on it, which caught a connection pool exhaustion issue before it caused a user-facing outage" is more compelling than a theoretical answer about what Prometheus does.

### Senior @ FAANG: Bar-Raiser Signals in Prometheus and Grafana Interviews

A bar-raiser evaluating an L6 candidate on Prometheus asks questions that probe platform ownership thinking:

**"How would you design a Prometheus deployment for 500 services across 10 Kubernetes clusters?"** This question tests whether the candidate understands the scaling limits of a single Prometheus instance, the trade-offs between federation and remote write, and how to design for operational safety (no single point of failure, graceful degradation under load).

**"A team's metric caused a cardinality explosion that affected Prometheus availability for all teams. How do you prevent this from happening again?"** This question tests whether the candidate thinks about prevention (cardinality budget enforcement, CI linting), detection (Prometheus cardinality alerts), and remediation (per-metric limits, series dropping). A junior candidate fixes the specific incident. A senior candidate designs the governance system.

**"How do you ensure SLO alerts are always accurate?"** This question tests awareness of the `for` clause, multi-window burn rates, alert rule testing with `promtool`, and the operational discipline of reviewing alerts after each production incident to verify they fired (or did not fire) as expected. An L6 candidate describes all four elements without prompting.

---
