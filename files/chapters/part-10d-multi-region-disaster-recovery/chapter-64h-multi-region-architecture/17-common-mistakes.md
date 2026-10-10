## Common Mistakes and How to Avoid Them

| Mistake | Why It Fails | Correct Approach |
|---|---|---|
| Hard-coding region endpoints | Breaks during failover and requires redeployment | Use a dynamic registry backed by a control plane (Consul, etcd, or AWS Route 53 health checks) |
| Using wall-clock LWW without tie-breaking | Clock skew causes non-deterministic winners when two events arrive within milliseconds | Add a secondary tie-break: node ID lexicographic order or Hybrid Logical Clocks (HLC) |
| Synchronous cross-region replication on the write path | Turns a local 5ms write into a 200ms+ operation, destroying throughput | Replicate asynchronously, surface lag as a metric, and set SLOs around acceptable lag |
| Not draining before a failover | In-flight requests get hard-dropped, causing 5xx spikes | Always ramp weight to zero over a configurable drain period before marking a region offline |
| Single global Redis for sessions | Cross-region latency on every authenticated request, plus SPOF | Multi-region Redis with local-first reads and async replication to remote clusters |
| Ignoring CAP theorem under partition | Assuming strong consistency everywhere across regions | Explicitly choose CP or AP per data type, and use CRDTs for AP data, Paxos/Raft for CP |
| Treating replication lag as binary (ok/not-ok) | Misses gradual degradation and allows stale reads to accumulate unnoticed | Expose lag as a continuous metric and feed it into the composite health score |
| Running chaos tests only in staging | Production has different traffic shapes, timing, and dependencies | Run chaos experiments in production during low-traffic windows with automated rollback |
| Using float64 for traffic weights | Rounding errors cause weights to diverge from 100% | Use integer weights (0-100) and enforce the sum invariant at write time |
| No circuit breaker on cross-region calls | One slow remote region causes cascading latency across the fleet | Wrap every cross-region call in a circuit breaker (Sony gobreaker or go-kit/circuit) |

---

### Junior -> FAANG: Turning Common Mistakes Into Interview Talking Points

Each row in the common mistakes table is a miniature incident report. The mistake column describes an implementation decision that seemed reasonable at the time. The "why it fails" column describes the production incident it caused. The "correct approach" column describes the lesson learned. Studying this table prepares you to answer interview questions of the form "tell me about a time you found a bug in a distributed system."

For your first job, memorize the top three mistakes that cause on-call pages: synchronous cross-region replication on the write path (latency spikes), not draining before failover (5xx error spikes), and single global Redis for sessions (single point of failure). These three appear in real incidents at companies of all sizes.

The float64 traffic weight mistake is subtle and worth understanding deeply. Floating-point arithmetic is not associative: `0.1 + 0.2 != 0.3` in IEEE 754. If you represent weights as floats and add them up after several shifts, you may get `99.99999999997` instead of `100.0`, and your invariant check fails even though the weights are conceptually correct. Integer arithmetic does not have this problem, which is why the `WeightMap` uses `int32`.

### Senior @ FAANG: Mistake Patterns as System Design Anti-Pattern Catalog

**Hard-coding region endpoints is a change management failure.** Every hard-coded endpoint is a future configuration change that requires a code deployment. At FAANG scale, where services deploy dozens of times per day, coupling configuration to deployments is an operational antipattern. The correct pattern (dynamic registry) is described in section 1. At L6, you recognize hard-coded endpoints in code review and require their extraction before merge, not as a later cleanup task.

**The replication lag as binary signal failure is a monitoring maturity issue.** A team that treats replication lag as a binary ok/not-ok signal has not instrumented their replication pipeline as a continuous metric. At L6+, replication lag in seconds (or milliseconds) should be a named metric in Prometheus, visible in Grafana, with alerts at multiple thresholds (warn at 5 seconds, critical at 30 seconds, page at 60 seconds). Without this, a gradual lag accumulation (1 second, then 5, then 15, then triggering failover) is invisible until the failover fires.

**No circuit breaker on cross-region calls is an error budget risk.** Cross-region calls are inherently higher-latency and less reliable than intra-region calls. Without a circuit breaker, a slow remote region causes connection pool exhaustion in the local service, cascading to failures across all requests (not just those that touch the remote region). At L6, cross-region calls are never made without a circuit breaker, a timeout, and a fallback. This is a code review gate, not a suggestion.

**Running chaos tests only in staging.** The mistake table notes that production has different traffic shapes, timing, and dependencies. This is understating the problem. Staging environments at most companies are an order of magnitude smaller than production, have different connection pool sizes, different cache hit rates, and different latency distributions. An experiment that validates an RTO of 30 seconds in staging may achieve 3 minutes in production because staging has 10x fewer instances to absorb the failover traffic. The bar for chaos engineering maturity is: do your experiments run in production, with real traffic, and are the results meaningful?

**Float64 for weights as a systemic numerical hygiene issue.** This mistake extends beyond traffic weights. Any system that uses floating-point arithmetic to track values that must satisfy exact invariants (sums to 100, probability distributions sum to 1.0, resource allocations fill exactly N slots) will eventually exhibit numerical drift. The senior-level rule: use integer arithmetic for counts, sums, and percentages. Use floating-point only for continuous physical measurements (latency in seconds, distance in kilometers) where tiny rounding errors have no business consequence.
