## 90G.12 System Design Principles Extracted from Failures

Every incident in this chapter violated one or more fundamental system design principles. This table maps each
incident to the specific principles it violated and the defensive patterns that would have prevented it.

| Incident | Principle Violated | Defensive Pattern |
|---|---|---|
| Kinetic-attack tabletop (fictional) | "Blast radius containment" - AZs are not independent under kinetic attack | Multi-region with geopolitical risk scoring, cable corridor diversity |
| AWS Drone Strike | "Assume network partitions happen" - submarine cables are physical SPOF | Multiple network paths through different geographic corridors |
| CrowdStrike | "Progressive delivery" - all-at-once deployment has max blast radius | Canary → staged → full deployment with automated rollback |
| CrowdStrike | "Rollback independence" - recovery must work when system is down | Out-of-band rollback mechanism, recovery boot path |
| Meta/Facebook | "Recovery tool independence" - recovery tools on same infra as failure | Out-of-band monitoring, management, and communication systems |
| Meta/Facebook | "Defense in depth" - audit tool was single point of verification | Multiple independent safety checks for destructive operations |
| Anthropic/Claude | "Output quality monitoring" - health checks miss quality degradation | Continuous output quality sampling with anomaly detection |
| Anthropic/Claude | "Isolation between platforms" - bugs on one platform affect others | Independent monitoring per hardware platform, synthetic probes |
| Discord (Go→Rust) | "Know your runtime overhead" - GC cost grows with heap objects | GOMEMLIMIT, off-heap storage, or language change for cache-heavy workloads |
| Grab (Go→Rust) | "Right tool for the job" - Go's 55% runtime overhead was unacceptable | Benchmark against language alternatives for CPU-critical paths |
| Cloudflare BGP | "Config validation" - rule ordering not validated before deployment | Automated policy validation, unreachable rule detection |
| Cloudflare Power | "N+1 is not enough" - all generators disabled simultaneously | Verify backup systems work BEFORE relying on them |
| GitHub Database | "Automated systems need guardrails" - failover triggered cascading issues | Circuit breakers on automated actions, retry budgets |
| Twitter/X | "Institutional knowledge must be externalized" - people leave | Runtime dependency discovery, mandatory documentation, bus factor > 1 |
| Uber Goroutines | "Resources must be bounded" - goroutine leaks grow unboundedly | Leak detection, buffered channels, context propagation |
| Twitch GC | "Tune your runtime" - default GC settings for cache-heavy services | GOMEMLIMIT. memory ballast (legacy). GC telemetry |

### Junior → FAANG: Principles Table as a Design Interview Cheat Sheet

This table is interview preparation gold. Each row is a "why do we do X?" question with its incident-grounded answer. "Why use multi-region instead of multi-AZ?" Answer: the AWS drone strike demonstrated that multi-AZ is not blast-radius-independent under a regional kinetic or geopolitical event. "Why are circuit breakers required?" Answer: GitHub's three-day database nightmare was caused by a retry storm that a circuit breaker with a retry budget would have prevented. Grounding design decisions in real incidents is the difference between a candidate who knows the patterns and a candidate who understands why the patterns exist.

### Senior @ FAANG: Principles as a Maturity Assessment

At L6, this table is a maturity assessment framework for your org's systems. For each principle, ask: do all our production services implement the defensive pattern? If not, which ones are missing it, and what is the risk exposure? The answer to that question is a risk register, and the gaps are items for your technical roadmap. Staff engineers at FAANG use this kind of structured gap analysis to prioritize resilience investments across a portfolio of services, rather than reacting to individual incidents after they occur.

---
