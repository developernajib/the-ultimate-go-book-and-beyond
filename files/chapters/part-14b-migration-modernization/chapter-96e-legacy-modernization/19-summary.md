## Summary

Legacy modernization is not a single event - it is a controlled, instrumented, reversible process that unfolds over weeks or months. The techniques in this chapter form a complete migration toolkit:

**Strangler Fig + Feature Flags** give you the ability to route traffic incrementally between legacy and new without any user impact and with instant rollback. The feature flag engine uses deterministic hashing to ensure sticky assignment, preventing users from seeing inconsistent behavior as they cross traffic boundaries.

**Branch-by-Abstraction** decouples the service layer from the data access layer at compile time, enabling a clean runtime switch between implementations without touching business logic. This is the SOLID Dependency Inversion Principle applied at architectural scale.

**Dual-Write with async retry** keeps both data stores synchronized during the transition period. The old store remains the system of record until migration is complete, and the new store is built up in parallel. The choice of mode (old primary, new primary, or synchronous) depends on the risk tolerance and data criticality of each entity type.

**Shadow Mode** is the safest validation tool in the toolkit. It lets you run the new service against 100% of real production traffic with zero user impact, revealing behavioral differences before a single user sees the new service. Shadow match rate is the most important metric during the pre-traffic phase.

**Expand-Contract** is the only safe pattern for online schema changes on large production tables. Skipping any phase - especially skipping the verification step between expand and contract - risks breaking the legacy service. Always measure backfill progress and never drop columns without confirming all application code has been deployed and is no longer reading the old column.

**Automated rollback** closes the loop. A migration system without automated rollback is a system where MTTR is bounded by human reaction time during an incident. With automated rollback triggered by error rate, latency, or shadow divergence thresholds, the system heals itself before users notice.

The overarching principle: **at every stage of the migration, the system must be in a state where you can roll back to the previous stage in under one minute.** This constraint drives all architecture decisions in this chapter - from flag store latency to dual-write ordering to the contract phase trigger conditions. Move slowly, measure everything, and never remove the safety net before you are certain you no longer need it.

### Junior → FAANG: Migration Toolkit as a Portable Engineering Skill

The techniques in this chapter are not specific to the user service example used throughout. They are a portable toolkit that applies to any stateful service migration: migrating a monolith to microservices, replacing a legacy database, extracting a bounded context, or modernizing an API contract. The specific implementations change, but the sequence (interface first, dual-write, shadow validation, gradual traffic shift, reconciliation, expand-contract schema change, automated rollback) applies across all of these contexts.

For early-career engineers, the most important takeaway from this chapter is the relationship between reversibility and confidence. Every technique in the toolkit exists to make the migration reversible at each step. Reversibility is not a constraint on speed: it is the mechanism that makes speed safe. A team that can roll back any step in 60 seconds can move faster than a team that cannot, because they can iterate without fear of irreversible damage.

The skill that this chapter builds is not Go-specific. It is the ability to decompose a large, risky operation into a sequence of small, individually safe steps, each of which is measurable and reversible. This is one of the most transferable engineering skills at any career level.

### Senior @ FAANG: The Migration Program as an Organizational Discipline

At senior level, legacy modernization is an organizational program, not a technical project. The technical toolkit in this chapter is necessary but not sufficient. The organizational disciplines that make the difference between a migration that succeeds and one that stalls halfway through: stakeholder alignment on migration milestones and success criteria before any code is written, a communication plan that keeps dependent teams informed without requiring them to participate in every technical decision, a governance model that defines who can approve traffic split increases and who can trigger rollbacks, and a decommission plan that defines the conditions under which the legacy system is actually shut down and the timeline for doing so.

The most common failure mode for legacy migrations at large organizations is not technical. It is organizational: the migration reaches 80-90% traffic on the new service and then stalls because the remaining 10-20% requires coordination across teams that do not prioritize the migration, because the business case for completing the migration is less urgent than the next feature, or because the engineering team that started the migration has changed personnel. At senior level, the job is to structure the migration program so that completion is the path of least resistance, not a heroic effort.

The final measure of a successful migration: the legacy system is decommissioned, the dual-write infrastructure is removed, the feature flags are deleted, and the new system is the only system. Until all four of these conditions are met, the migration is not done and the team is carrying the operational cost of two systems. This is the commitment that distinguishes a migration program with senior ownership from one that stops at "the new system handles most traffic."

### Key Takeaways

1. **Incremental Strangling Beats Big-Bang Rewrites:** Avoid single-cutover failure modes by placing a Go reverse proxy in front of legacy services to strangle routes gradually.
2. **Reversibility Is Speed:** Maintain sub-minute rollback capability at every stage using dynamic feature flags and decoupled routing rules without redeployments.
3. **Dual-Write Ordering & Idempotency:** Guarantee deterministic writes by writing primary synchronously, streaming secondary asynchronously with retries, and resolving races via optimistic locking.
4. **Shadow Mode Correctness:** Validate parity on production traffic silently before shifting any user-facing requests; isolate shadow metrics from production SLOs.
5. **Expand-Contract Schema Evolution:** Execute online database migrations by adding nullable columns, running rate-limited backfills, verifying data consistency, switching reads, and only then dropping deprecated columns.

---

*Next: [Part XV-A: Cloud Infrastructure](../../part-15a-cloud-infrastructure/00-part-intro.md)*

