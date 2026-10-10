## Summary

This chapter built a production-grade multi-region system in Go from first principles:

- **Topology choice** (active-active vs active-passive) is driven by RPO/RTO requirements and data conflict tolerability, not by infra cost alone.
- **GeoDNS and Anycast** route users to nearby regions. The application layer mirrors this with haversine distance scoring and EWMA latency tracking.
- **Traffic shifting** must be gradual - abrupt cut-overs spike error rates. Linear weight ramps over minutes let in-flight requests drain safely.
- **Health scoring** is composite: HTTP liveness, replication lag, queue depth, and error rate all feed a weighted score that drives the failover controller.
- **CRDTs** (G-Counter, PNCounter, LWW Register) provide mathematically guaranteed convergence for data that must remain writable during partitions.
- **Vector clocks** distinguish causal ordering from concurrency, enabling precise conflict detection. Hybrid Logical Clocks extend this to handle NTP skew in production.
- **The replication engine** publishes mutations with vector clock annotations and resolves conflicts via pluggable strategies (LWW, vector-clock-aware, domain-specific merge).
- **Multi-region PostgreSQL** uses Patroni for intra-region HA and logical replication (or Citus) for cross-region distribution. The Go pool layer handles primary election and replica preference transparently.
- **Global sessions** are read locally and replicated asynchronously. Cache warming on miss prevents cascading cross-region reads.
- **The failover controller** is a pure control-loop: observe health scores, compare against thresholds, drain failing regions, notify on-call, restore on recovery.
- **Chaos engineering** is not optional. The `Injector` framework lets you inject latency, packet loss, and full partition faults in controlled experiments, confirming your failure-handling code actually works before a real incident does.

The key insight threading all of this together is that **multi-region correctness is a spectrum, not a binary**. Every design choice - consistency model, conflict resolution strategy, failover threshold - is a dial, and your job as a senior engineer is to understand exactly what each dial controls and set it deliberately for your system's specific requirements.

### Junior -> FAANG: Consolidating the Chapter into Interview-Ready Concepts

The eight bullet points in this summary are your flashcard set for FAANG system design interviews. Each one is a concept cluster that an interviewer can probe with follow-up questions. Know not just the definition but the trade-off and the failure mode for each.

The two clusters that generate the most follow-up questions in interviews are CRDTs (because they are mathematically interesting and interviewers can easily probe depth) and the failover controller (because it is operationally concrete and candidates can be asked to walk through the failure scenario step by step). For both, practice explaining them to someone with no distributed systems background. If you can explain CRDTs in terms a product manager can understand, you can explain them to any interviewer.

The final sentence of this chapter is worth memorizing: multi-region correctness is a spectrum, not a binary. Every design choice is a dial. This framing prevents the common interview mistake of presenting a single architecture as "the answer" rather than one point on a trade-off continuum.

### Senior @ FAANG: From Chapter Mastery to Platform Ownership

This chapter's content represents the technical depth of a strong L5 system design performance and the breadth of an L6 principal-candidate. At L7/principal level, the transition is from "can implement these components" to "can design the organizational structures that make these components sustainable at scale."

**What L7 ownership looks like.** A principal engineer who owns multi-region architecture at FAANG does not spend most of their time implementing traffic shifters or replication engines. They spend time on: reviewing the ADRs of other teams to catch topology decisions that violate the organizational standard, writing the reference implementation that teams fork rather than reinventing, running the quarterly chaos engineering review where team chaos experiment results are presented and organizational learning is extracted, and negotiating SLA contracts with product leadership that reflect the actual capabilities of the current infrastructure.

**The maturity gap between this chapter and production.** This chapter provides the correct patterns and demonstrates them with clean implementations. Production reality adds: operational runbooks for every component, on-call training for every engineer on the team, SLA violation postmortems, and quarterly DR tests that measure actual RTO against the contract. The code is the easier part. Building the organizational practices that keep the code correct under real-world pressure is the L6+ challenge.

**Platform thinking applied to this chapter.** An engineer who reads this chapter and asks "how do I implement a region registry for my service?" is thinking at L4/L5. An engineer who reads it and asks "how do I build a region registry service that 50 teams in my organization can consume without each building their own?" is thinking at L6/L7. The second framing is the FAANG principal-level instinct: multiply impact by building platforms, not by writing individual service implementations.

