# Chapter 64D: Capacity Planning and Back-of-Envelope Calculations

*The goal of capacity planning is not to predict the future with perfect accuracy but to avoid being surprised by it.*

Many production outages at scale are not caused by bugs, they are caused by traffic that exceeds what the system
was sized to handle. A database whose connection pool was sized for 500 concurrent queries receives 2,000 and
begins rejecting requests. An in-memory cache that holds 48 hours of data grows to hold 96 hours and triggers
OOM kills across a fleet. A batch job that ran in 10 minutes at 10 GB runs for 14 hours at 400 GB and blocks
every downstream pipeline. Each of these failures was predictable weeks in advance with basic capacity planning.

In the Go ecosystem, capacity planning is particularly actionable. Go's `pprof` profiler exposes CPU, memory,
goroutine, and block profiles with negligible overhead in production. The `expvar` package and Prometheus client
library make it trivial to export utilization metrics. The `testing.B` benchmark infrastructure provides
repeatable throughput measurement under controlled conditions. A Go engineer who understands capacity planning
can instrument their service, measure its limits under synthetic load, project future resource needs from growth
trends, and implement auto-scaling triggers - all within the standard toolchain, with no external dependencies.

This chapter covers the capacity planning toolkit: latency and throughput numbers you should know from memory,
a repeatable estimation framework for traffic, storage, bandwidth, and compute, worked capacity estimates for
Twitter, YouTube, and Uber, production techniques for headroom targeting and auto-scaling, and Go-based load
testing and monitoring tooling.

**What you'll learn in this chapter:**
- The latency number table every engineer must know: L1 cache, RAM, SSD, network round-trip, and disk seek
  times, and how to use them to reason about bottlenecks before writing a single line of architecture
- A structured back-of-envelope framework: start with active users, derive requests per second, calculate
  storage growth rate, estimate bandwidth requirements, and size server fleets step by step
- Complete worked capacity estimates for Twitter (read-heavy timeline fanout), YouTube (video storage and
  transcoding pipelines), Uber (geospatial indexing and ride matching), and a URL shortener service
- How to translate capacity estimates into architecture decisions: when to shard, when to introduce a cache
  layer, when a CDN changes the math entirely, and when a single database remains sufficient
- Production capacity planning techniques: load testing with realistic traffic distributions, setting headroom
  targets at 30-50% utilization ceiling, and configuring auto-scaling limits that prevent runaway spend
- Writing Go load testers using `net/http` with goroutine worker pools and interpreting results against the
  theoretical capacity model to validate or revise estimates
- Capacity monitoring in Go: exporting utilization metrics with Prometheus, setting predictive alerts on growth
  trend extrapolation, and building capacity dashboards in Grafana
- The most common capacity planning mistakes that derail system design interviews and cause production incidents,
  with concrete remediation patterns for each

**Why this matters at scale:**
Google's SRE practice requires every production service to maintain a capacity plan projecting time-to-failure at
current growth rates. Back-of-envelope estimation is a standard expectation in system design interviews at senior
and staff levels.

**Prerequisites:** Chapter 58 (system design fundamentals), Chapter 59 (distributed system patterns), Chapter 20 (observability and metrics)

### Junior → FAANG: Why Capacity Planning Feels Unfamiliar and How to Fix That

Most engineers learn to code in environments where capacity is not a concern: a laptop, a single-node database, a test cluster. Moving to FAANG-scale production requires building a new mental model where every design decision has a resource cost, and ignoring resource costs causes outages.

**The estimation reflex.** When you hear "design a system that handles X," your first instinct should be: what is X? 10 users or 10 million? What does "handle" mean? Serve a request in under 100ms, or process a batch job in under 24 hours? Before drawing a single box in an architecture diagram, write down the scale parameters. Interviewers notice when you skip this step: it signals that you design without understanding the problem.

**The numbers you must memorize.** You cannot estimate in an interview if you have to derive every number from scratch. Commit to memory: seconds per day (100K), NVMe IOPS (700K), HDD IOPS (100), Go HTTP server throughput (50-100K RPS without DB, 5-20K RPS with DB), Redis throughput (500K ops/sec), and PostgreSQL throughput (50K simple QPS). These numbers are the vocabulary of capacity estimation. Without them, your estimates will be orders of magnitude off.

**The biggest junior mistake: working in the wrong units.** "100 million users times 10 KB equals 1,000,000,000 KB." Before you can use that number, you must convert it to a useful unit. 1,000,000,000 KB = 1,000,000 MB = 1,000 GB = 1 TB. Practice the conversion chain until it is automatic. An estimate that stops at "1 billion KB" is useless in an interview.

### Senior @ FAANG: Capacity Planning as a Staff Engineering Discipline

At senior and staff level, capacity planning is not an interview skill. It is a continuous operational practice that the team owns, and it requires formalized process, not ad-hoc intuition.

**The Google SRE capacity planning framework.** Google's Site Reliability Engineering book defines capacity planning as a mandatory practice: every service must have a documented capacity plan that specifies current utilization, the utilization level at which the service will fail, the growth rate, and the projected time to failure at that rate. The plan is updated quarterly. Staff engineers own this process for their team's services and are expected to present it in quarterly reviews.

**ADR: capacity planning for new services.** When a new service is launched, the launch ADR should include a capacity plan: what traffic do we expect at launch, what traffic do we expect in six months, what resources have been provisioned, and what is the headroom? Services that launch without a capacity plan frequently trigger capacity emergencies within three months, when organic traffic growth consumes the headroom that the engineering team assumed would last a year.

**Platform thinking: capacity as a shared resource.** In a large organization, capacity is a shared resource across teams. A service that unexpectedly doubles its RPS does not just exhaust its own resources: it may exhaust shared infrastructure (the etcd cluster, the database connection pool, the network bandwidth on a shared peering link). Staff engineers define capacity isolation boundaries: each service gets a dedicated resource quota, and exceeding the quota triggers an alert and a conversation, not a silent degradation of other services.

**Maturity model: from "we'll scale when we need to" to "we know our runway."** Level 1: no capacity planning, scaling happens reactively after incidents. Level 2: basic monitoring with utilization alerts. Level 3: capacity plans for tier-1 services, headroom targets enforced. Level 4: capacity plans for all services, automated runway calculation, capacity reviews in launch processes, load testing as part of the deployment pipeline. Driving your team from level 2 to level 4 is a multi-quarter staff engineering project.

---
