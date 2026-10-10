# Chapter 64I: Disaster Recovery & Resilience Engineering - RTO/RPO, Chaos Engineering, Runbooks

*Hope is not a strategy. Neither is a backup you've never tested. Resilience engineering is the discipline of turning recovery from an event into a procedure, and then validating that procedure under controlled failure before the real failure arrives.*

Every system will eventually fail. The difference between a five-minute incident and a five-hour outage is not luck - it is the depth of preparation: whether recovery procedures are documented and rehearsed, whether backups are tested for restorability, whether automated failover triggers before on-call engineers are paged, and whether the system's observable state during failure is rich enough to drive confident decision-making. Recovery Time Objective (RTO) and Recovery Point Objective (RPO) are the contractual expression of this preparation: RTO defines how long users can tolerate unavailability, and RPO defines how much data loss is acceptable. Meeting these objectives under adversarial conditions requires that they be translated into concrete architectural requirements - backup frequency, replication lag thresholds, failover automation latency - and validated through regular DR drills.

Chaos engineering formalizes the practice of deliberately injecting failures into production-like environments to discover failure modes before they occur organically. Netflix's Chaos Monkey project popularized the concept, but the discipline has matured well beyond random instance termination. Modern chaos engineering targets specific failure hypotheses: what happens to request latency when the database's primary is killed during peak traffic? Does the circuit breaker trip before the connection pool exhausts? Does the runbook's failover procedure complete within the RTO when followed by a junior on-call engineer at 3am? These questions can only be answered empirically, through controlled experiments that measure real system behavior under real failure conditions.

Go is exceptionally well-suited for building DR and resilience tooling. The language's concurrency model makes it natural to write chaos injection agents that simultaneously inject latency, drop packets, and consume CPU while monitoring system health metrics. The `context` package provides first-class cancellation and timeout propagation that maps directly onto RTO requirements. Interfaces and generics allow circuit breakers, bulkheads, and retry policies to be composed around arbitrary service clients without modifying business logic. And Go's compilation to a single static binary simplifies deployment of DR automation tooling into environments where the primary orchestration layer may itself be degraded.

**What you'll learn in this chapter:**

- Translating RTO and RPO SLA commitments into concrete architectural requirements: backup frequency, replication lag budgets, and failover automation latency targets
- Implementing full, incremental, and WAL-based backup pipelines in Go with integrity verification and automated restore testing
- Building chaos engineering harnesses in Go: latency injection, packet drop simulation, service kill, CPU and memory pressure, and disk fault injection
- Circuit breaker and bulkhead patterns in Go using interfaces and generics: state machine implementation, half-open probe logic, and metrics instrumentation
- Automated regional failover: health-check-driven traffic shifting, DNS TTL management, and database promotion sequencing with rollback capability
- Encoding runbooks as executable Go programs: decision trees, automated remediation steps, escalation logic, and audit logging of every action taken
- Game-day simulation frameworks: defining failure hypotheses, measuring system behavior under injection, and producing structured reports for postmortems
- Blameless postmortem systems: structured data models, timeline reconstruction from distributed logs, contributing factor analysis, and action item tracking

**Why this matters at scale:**

Netflix's Chaos Engineering team runs thousands of fault injection experiments per week across their production fleet, and credits the practice with reducing major incident frequency by over 50% year-on-year. Google's SRE book codified the RTO/RPO contract model and the error budget framework that now drives reliability engineering at thousands of companies. Stripe's on-call runbooks are versioned, tested, and executed through tooling that records every action taken during an incident - enabling postmortems that reconstruct the complete decision timeline. Amazon's GameDay programme, which pre-dates Chaos Monkey, simulates regional outages twice a year across every critical service to validate that failover procedures remain current and correct.

**Prerequisites:** Chapter 64H (Multi-Region Architecture) establishes the infrastructure context that DR procedures operate against. Familiarity with PostgreSQL WAL-based replication and basic Kubernetes operations is helpful for the backup and failover sections.

---

### Junior -> FAANG: What Disaster Recovery Means for Your First Engineering Role

At your first job, disaster recovery is likely not your primary responsibility. But you will be asked to write code that participates in it: health check endpoints, graceful shutdown handlers, idempotent database writes, and structured error responses. Understanding DR prepares you to write these correctly rather than as an afterthought.

The most important prerequisite concept is idempotency. A function or operation is idempotent if running it multiple times produces the same result as running it once. In disaster recovery, systems are restarted, requests are replayed, and events are redelivered. Any operation that is not idempotent will produce incorrect results when retried. Before your first production deployment, ask your team: which of our API endpoints are not idempotent, and why?

For interview framing: when asked about system reliability, the weak answer is "we use load balancers and replicas." The strong answer covers the full reliability stack: how data is backed up and verified, how the system behaves during a partial failure, how recovery is tested, and what the actual measured RTO is. Knowing these answers demonstrates operational maturity that goes beyond coding ability.

### Senior @ FAANG: DR as Organizational Capability, Not Just Technical Architecture

At L6+, disaster recovery is an organizational discipline with technical implementation. The technical parts (backup engines, circuit breakers, runbook automation) are the minority of the work. The majority is: ensuring every engineer on the team understands the DR procedures, running GameDays that validate those procedures under realistic conditions, and producing postmortems that improve the procedures after incidents.

**DR program ownership.** At FAANG, DR programs are owned by SRE leads or principal engineers, not by individual product teams. The DR program sets the standards (minimum backup frequency, mandatory DR test cadence, RTO/RPO tier definitions), the product teams implement to those standards for their specific services, and the DR program validates compliance through audits and GameDay exercises. At L7, you may own the DR program for a product area.

**The "recovery" gap in most teams' DR posture.** Most teams have backup pipelines. Far fewer teams have tested restoring from those backups. An untested backup is not a recovery capability, it is a false sense of security. At L6+, the measure of DR maturity is not "do we have backups?" but "when did we last restore from backup and what was the actual restore time?" If the answer is "we have never tested a restore," that is a critical gap that belongs in the team's risk register with a P0 priority.

**Chaos engineering integration as a senior-level differentiator.** Most teams run chaos experiments in staging. Senior engineers at FAANG run chaos experiments in production during low-traffic windows. The gap between staging and production chaos is the gap between validating your hypothesis in a toy environment and validating it against real traffic, real connection pools, and real dependency graphs. A principal engineer's job is to design the safety gates (blast radius limits, automated rollback, steady-state monitoring) that make production chaos experiments safe enough to run regularly.
