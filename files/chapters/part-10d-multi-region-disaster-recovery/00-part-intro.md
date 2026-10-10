# Part 10D: Multi-Region & Disaster Recovery

*"Everything fails, all the time."* - Werner Vogels, CTO of Amazon

When your system serves users across continents, a single-region deployment is a single point of failure. Multi-region architecture addresses this by distributing compute, state, and traffic across geographies so that no single data center failure can take down the service.

Multi-region design goes beyond deploying your application to multiple data centers. You must reason about data consistency across regions, handle network partitions gracefully, design intelligent routing that minimizes latency, and plan for failure scenarios that can cascade across your infrastructure. Go's concurrency model and networking capabilities make it well-suited for building the control planes, routing layers, and replication systems that power these deployments.

Disaster recovery is the other side of this coin. Having a backup strategy is insufficient, you must regularly test that your recovery procedures work under realistic failure conditions. Chaos engineering, GameDay exercises, and automated failover testing are practices that validate recovery before a real incident occurs.

**What this part covers:**
- Chapter 64H: Multi-Region Architecture - Active-active and active-passive deployments, data replication strategies, global load balancing, conflict resolution, and latency-aware routing
- Chapter 64I: Disaster Recovery & Resilience - RPO/RTO planning, backup and restore strategies, GameDay exercises, chaos engineering, data sovereignty considerations, and automated failover

**How to use this part:**
Start with Chapter 64H to understand the architectural patterns for multi-region deployments, then proceed to Chapter 64I for disaster recovery and resilience testing. The chapters build on each other - you need to understand how multi-region systems are structured before you can effectively plan for their failure modes and recovery procedures.

**FAANG relevance:**
Multi-region architecture is a staple of senior-level system design interviews. Interviewers expect you to discuss trade-offs between active-active and active-passive configurations, explain CAP theorem implications for cross-region replication, and design failover mechanisms with specific RPO/RTO targets. On the job, large-scale services operate across multiple regions, and engineers participate in incident response, chaos engineering exercises, and disaster recovery planning as part of their regular responsibilities.

---

### Junior -> FAANG: Understanding the Multi-Region Problem Space

Before writing a single line of multi-region code, close the prerequisite gap in distributed systems vocabulary. The three terms that come up in every FAANG screen are RTO, RPO, and CAP. RTO is how long the system can be down before the business is damaged. RPO is how much data can be lost measured in time. CAP theorem says that during a network partition, you must choose between consistency and availability. You cannot have both. Most candidates memorize the definitions but cannot apply them. Practice by explaining which choice AWS S3 makes (AP) versus Google Spanner (CP) and why.

The active-active versus active-passive decision is your first system design anchor. In an active-passive setup one region handles all writes, and others are warm standby. In an active-active setup all regions accept writes simultaneously. The trade-off is complexity: active-active requires conflict resolution logic because two users in Tokyo and Virginia might update the same record at the same time without knowing about each other.

A worked example for interviews: you are designing a user-profile service for a social app with users in the US and EU. EU data residency rules (GDPR) mean European user data must stay in EU data centers. This immediately constrains your topology. You need at minimum two regions with hard data-affinity routing, not a free-for-all active-active setup. Knowing that regulation shapes topology before code is what separates a prepared candidate from one who only knows patterns abstractly.

First-job habit: when joining a team that operates a multi-region system, read the runbooks and architecture decision records before touching code. The decisions made years ago about replication strategy and conflict resolution will constrain every feature you write.

### Senior @ FAANG: Platform Thinking and Governance for Multi-Region Systems

At the staff and principal level, multi-region architecture is not a single service decision, it is a platform decision. The questions you must answer are not "should this service be active-active?" but "what is our organization's topology standard, and how do we enforce it consistently across 200 services?"

**Architecture Decision Records for topology.** Every topology choice should be captured in an ADR with explicit business driver, RPO and RTO targets, trade-off analysis (latency vs. consistency vs. cost), and a named owner. Without written decisions, teams make incompatible choices and the next engineer inherits a system whose topology is a mystery. At L6+, your job is to write the reference ADR and socialize it so that new services start from a known baseline.

**Data sovereignty as a first-class constraint.** GDPR, CCPA, India's DPDP, and China's PIPL all impose data residency requirements that override pure performance optimization. A senior engineer designs the data routing layer to enforce residency rules at the write path, not as a post-hoc filter. This means each customer record carries a region affinity tag, and the routing layer rejects writes that would place data in a non-compliant region. Audit logging of routing decisions is non-negotiable for regulatory compliance.

**Maturity model for multi-region readiness.** At L7 level, you assess organizational readiness on four dimensions: (1) topology documentation, (2) automated failover with validated RTO, (3) regular DR tests with measured results, and (4) chaos engineering integrated into the release pipeline. A team that has not run a DR drill in six months has unknown actual RTO regardless of what the architecture diagram says.

**Cost governance.** Cross-region data transfer fees at FAANG scale are budget line items, not afterthoughts. Replication traffic, health check polling, and Kafka MirrorMaker throughput all generate egress cost. A principal engineer builds a cost model before proposing topology changes and presents it alongside the latency and availability improvements. The bar-raiser signal here is the ability to reason about cost, correctness, and latency simultaneously without collapsing to a single dimension.

**Bar-raiser interview signal.** When a candidate is asked to design a multi-region system and immediately starts drawing service boxes without asking about regulatory constraints, data model conflict tolerability, or cost envelope, that is a signal they have not operated these systems at real scale. The bar raiser wants to see the candidate ask at least three clarifying questions before proposing a topology.
