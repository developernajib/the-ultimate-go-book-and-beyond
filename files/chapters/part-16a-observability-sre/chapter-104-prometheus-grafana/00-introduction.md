# Chapter 104: Prometheus & Grafana Mastery

> *"In God we trust. All others must bring data."* (attributed to W. Edwards Deming)

Metrics are the heartbeat of a production system. They tell you, in near real-time, whether your service is healthy, whether a deployment degraded performance, and whether you are on track to meet your reliability commitments for the month. Among the many metrics systems available today, Prometheus has become the de facto standard for cloud-native infrastructure: its pull-based architecture, multi-dimensional data model, and powerful query language make it uniquely suited to the dynamic, ephemeral nature of Kubernetes workloads where hosts come and go continuously and IP addresses are meaningless.

The Prometheus ecosystem in Go is exceptionally mature. The official `prometheus/client_golang` library integrates directly with the `net/http` standard library and with popular frameworks like Gin and Chi. Exposing a `/metrics` endpoint and registering a counter is a matter of a few lines. The real craft lies in choosing the right metric types (counters, gauges, histograms, and summaries), applying the right labels without blowing up cardinality, and writing PromQL queries that surface meaningful signals rather than noise. Poor metric design is one of the most common causes of Prometheus performance problems, and this chapter addresses it head-on with concrete guidelines and anti-patterns.

Grafana transforms Prometheus data into actionable dashboards and ties the metrics story together with alerting via Alertmanager. Building dashboards that actually help on-call engineers, dashboards organized around the RED method (Rate, Errors, Duration) and the USE method (Utilization, Saturation, Errors), requires understanding Grafana's variable system, templating, and annotation mechanics. Alertmanager's routing tree, inhibition rules, and silences give teams surgical control over how alert noise is reduced during incidents and maintenance windows. By the end of this chapter you will have a full observability stack running locally and understand how to tune it for large-scale production deployments.

**What you'll learn in this chapter:**
- Prometheus architecture: the pull model, service discovery, scrape configuration, and remote write
- Instrumenting Go services with counters, gauges, histograms, and summaries using `client_golang`
- Writing custom `Collector` implementations for metrics that require external state
- PromQL fundamentals: selectors, range vectors, aggregation operators, and subqueries
- Cardinality management: label best practices, metric naming conventions, and avoiding high-cardinality explosions
- Recording rules and alerting rules: pre-aggregating expensive queries and defining SLO burn-rate alerts
- Building Grafana dashboards with variables, templating, and the RED/USE methodology
- Configuring Alertmanager routing trees, receivers (Slack, PagerDuty, email), inhibition, and silencing

**Why this matters at scale:**
GitLab runs one of the world's largest self-managed Prometheus deployments, scraping millions of time series across its SaaS infrastructure to enforce its public SLA. SoundCloud, Prometheus's birthplace, adopted the system to gain visibility into their streaming pipeline after outgrowing StatsD. Cloudflare uses Prometheus with Thanos for long-term metric storage, retaining years of data to perform capacity planning across its global edge network. At any organization with Kubernetes in production, Prometheus is virtually always already present. Mastering it means mastering the primary language your platform team speaks.

**Prerequisites:** Chapter 20 (logging and observability concepts) and Chapter 103 (OpenTelemetry), basic familiarity with Docker Compose for running a local Prometheus and Grafana stack.

### Junior → FAANG: Why Prometheus and Grafana Are Non-Negotiable Skills

Prometheus is the de facto metrics standard in Kubernetes environments. If you are applying to any company that runs Kubernetes workloads (which is essentially every FAANG and FAANG-adjacent company), you will encounter Prometheus in production. The `prometheus/client_golang` library is straightforward to use, but the conceptual gaps around metric types, PromQL operators, and cardinality are where junior engineers struggle.

Start with the four golden signals: latency (use a histogram), traffic (use a counter), errors (use a counter, split by error type), saturation (use a gauge for current usage, a histogram for queue depth). These four metrics, properly instrumented, cover the majority of production incident detection scenarios.

Grafana fluency is equally expected. Interviewers will ask you to describe a production dashboard and what operational decisions it supports. If you cannot point to a specific dashboard with specific panels and explain the PromQL behind each one, you have a gap to close before interviewing.

### Senior @ FAANG: Prometheus as Platform Infrastructure

At senior level, Prometheus is not just a tool you configure for your service. It is a shared platform that requires capacity planning, federation design, retention policy governance, and multi-tenancy support as the engineering organization grows.

**Scalability architecture.** A single Prometheus instance handles a few million active time series on commodity hardware before ingestion and query performance degrade. At FAANG scale, that ceiling is reached by a single large service, let alone hundreds. The standard solutions are Thanos or Grafana Mimir for horizontally scalable metric storage, with a federated Prometheus topology that splits scrape load across multiple instances and aggregates via recording rules. An L6 engineer designs this topology, documents it in an ADR, and owns the capacity model that predicts when the current topology needs to scale.

**Metric lifecycle governance.** Metrics accumulate over time. Services are deprecated, metric names are changed, labels are added and removed. Without governance, the Prometheus database fills with stale series that inflate storage cost and pollute query results. An L6 engineer implements a metric lifecycle process: new metrics require documentation and a cardinality estimate in the PR, deprecated metrics are marked with a `deprecated` label for 30 days before removal, and a periodic audit identifies unused metrics for cleanup.

---
