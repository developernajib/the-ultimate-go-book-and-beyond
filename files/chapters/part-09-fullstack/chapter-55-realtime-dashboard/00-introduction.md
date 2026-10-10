# Chapter 55: Full-Stack Project - Real-Time Dashboard

*"You can't fix what you can't see. Observability isn't just logging - logs tell you what happened, but metrics tell you why."*

In 2018, a mid-sized e-commerce company with $50M ARR rewrote their "messy" legacy PHP system with pristine clean architecture. The senior engineer had eight years of experience, talked at conferences about code quality, and delivered a system with perfect separation of concerns and 100% testable code. Three months later, the new system collapsed under barely 1,000 concurrent users - less than one-eighty-fifth of the load their spaghetti legacy system had handled on Black Friday. The legacy system's secret was not its code quality: it was a 91% cache hit rate, 47 carefully tuned database indexes, and 240 custom metrics tracking every checkout step. The rewrite had none of these. This story illustrates why production systems rest on four pillars - code quality, infrastructure scaling, observability, and operational culture - and why focusing on only one will always fail.

A real-time analytics dashboard exercises all four pillars at once. It demands Go's goroutine-based concurrency to handle thousands of WebSocket connections without thread-per-connection overhead, multi-tier caching to serve frequently queried metrics without hammering the database on every client update, backpressure handling to prevent metric ingestion from overwhelming the system during traffic spikes, and a React frontend that reconciles a continuous stream of updates into a coherent, non-flickering visualization. Getting any one of these wrong produces a system that appears to work in development and falls apart under realistic load.

This chapter builds a monitoring dashboard from the ground up, measuring its behavior at each stage with load tests and real metrics. You will implement the four pillars explicitly: clean Go service architecture, Redis-backed multi-tier caching with tuned TTLs, Prometheus metrics with Grafana dashboards, and runbook-driven operational procedures. By the end, you will understand not just how to build the system, but how to reason about why it holds up when traffic spikes unexpectedly.

**What you'll learn in this chapter:**
- Designing WebSocket infrastructure in Go that handles thousands of concurrent connections with controlled goroutine lifecycles and fan-out broadcast
- Implementing the Four Pillars Framework for production systems: code quality, infrastructure and caching, observability, and operational culture
- Building multi-tier caching with L1 in-process maps and L2 Redis, including cache warming, TTL strategy, and invalidation on metric ingestion
- Creating batched metric ingestion pipelines with channel-based backpressure to absorb traffic spikes without blocking producers
- Integrating a React dashboard frontend with WebSocket-driven state updates, Redux time-series reducers, and non-blocking chart re-renders
- Instrumenting the Go backend with Prometheus histograms, counters, and gauges, and building Grafana dashboards for the metrics that matter
- Conducting structured load tests with `k6` to establish baseline capacity, identify bottlenecks, and verify that optimizations actually help
- Applying the lessons of real production post-mortems to anticipate failure modes before they occur in your own systems

**Why this matters at scale:**
Datadog's Go-based metrics ingestion pipeline processes over four trillion data points per day, where poorly designed backpressure in ingest workers causes cascading queue buildup that delays alerting during the exact incidents where customers need it most. Grafana Labs runs their real-time dashboard rendering infrastructure in Go, where WebSocket connection fan-out to tens of thousands of simultaneous viewers requires the goroutine lifecycle discipline covered in this chapter.

**Prerequisites:** Chapter 54 (task management app), Chapter 53 (frontend integration), Chapter 11 (Go concurrency), Chapter 20 (observability and metrics)

---

### Junior -> FAANG: Understanding What You Are Actually Building

Before writing any code, clarify what "real-time" means in the system you are joining. Many first-job engineers assume real-time means instant, but production dashboards almost always tolerate 1-5 second staleness to keep infrastructure costs manageable.

The gap that trips up junior candidates is thinking of each pillar in isolation. In an interview, you might describe a beautiful WebSocket hub, then get asked "what happens when Redis is down?" and have no answer because you never connected Pillar 2 (infrastructure) to Pillar 4 (operational culture).

Practical first-job habit: before touching any real-time feature, find the existing Grafana dashboard for it and ask what the current cache hit rate and P99 latency are. If those numbers don't exist, your first contribution should be adding them, not adding features.

Entry-level interview framing: when asked to design a dashboard, start by clarifying the number of clients, the update frequency, and whether updates need to be guaranteed or best-effort. Those three answers determine whether you need WebSocket vs SSE, Redis Pub/Sub vs Kafka, and how much buffer memory to budget per connection.

### Senior @ FAANG: Architectural Decision Records and Platform Framing for Real-Time Systems

At the senior and staff level, the introduction to a chapter like this is where architectural decisions must be made explicit and defended across an organization, not just within a team.

**ADR framing for WebSocket vs SSE:** A staff engineer writing an ADR for a real-time dashboard platform would note the following tradeoffs. WebSocket gives full-duplex at the cost of load-balancer complexity (sticky sessions or shared state via Redis), HTTP/2 incompatibility for some proxies, and per-connection goroutine overhead. SSE is unidirectional, works cleanly with HTTP/2 multiplexing, and is trivially reverse-proxied, but cannot receive commands from the client without a separate REST call. The decision is rarely "which is better in the abstract" but "which fits the existing infrastructure, security posture, and team operational capability."

**Four Pillars as a maturity model:** FAANG bar-raisers use frameworks like this to probe whether a candidate thinks at system level. The e-commerce cautionary tale in this introduction is precisely the kind of real-world failure mode that an L6/L7 engineer is expected to recognize before it happens, not after. A senior candidate should be able to explain which pillar is the riskiest to underinvest in for a given business context: for a startup doing 100 RPS, Pillar 1 (code quality) may be the constraint because the team is small, while for a team scaling to 100k RPS, Pillar 2 (infrastructure) and Pillar 3 (observability) become load-bearing.

**Platform thinking:** At FAANG scale, real-time infrastructure is not rebuilt per product. A staff engineer's job is to define the platform (connection management service, shared Redis cluster, standard metric naming conventions, baseline runbook templates) so that ten product teams can build dashboards without each independently rediscovering WebSocket connection leak patterns. The decision about which technology to standardize on, and what the migration path looks like for teams already using a different approach, is a staff-level concern that goes far beyond writing a good hub implementation.

**Bar-raiser interview signal:** A candidate who presents only one approach to a design question (e.g., "just use WebSocket") without discussing failure modes, operational cost, and team capability signals L4 thinking. A candidate who says "it depends on these three variables, here are the tradeoffs at each end of the spectrum, and here is how I would gather the data to decide" signals L6 thinking.
