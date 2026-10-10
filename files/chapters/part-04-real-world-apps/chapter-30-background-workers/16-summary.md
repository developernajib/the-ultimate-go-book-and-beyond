## Summary

Background worker essentials:

1. **Worker Pools**: Manage concurrent job processing with graceful shutdown
2. **Job Queues**: Database or Redis-backed queues with visibility timeouts
3. **Scheduling**: Cron-style job scheduling with distributed locking
4. **Dead Letters**: Handle permanently failed jobs for inspection and replay
5. **Monitoring**: Track metrics, processing times, and failure rates
6. **Locking**: Distributed coordination prevents duplicate execution

### Junior to FAANG: summary as a study checklist

Re-read each bullet and ask, can I build this from scratch. If no, return to the section. If yes, can I explain its failure modes. If no, return to the section. If yes, can I teach it to someone else. If no, return to the section. Only then move on.

Specific exit criteria for a junior claiming competency.

- Can write a Postgres queue with `SKIP LOCKED` from memory.
- Can explain why visibility timeout exists and how to tune it.
- Can distinguish efficiency locks from correctness locks.
- Can name the three failure modes of a DLQ (black hole, no categorization, no rate alerting).
- Can describe when to use Temporal versus a queue.
- Can write a graceful shutdown that does not lose jobs.

### Senior at FAANG: summary as a platform checklist

For staff engineers, the summary becomes a platform maturity checklist. For each bullet, rate your platform on a 0 to 5 maturity scale.

- Worker pools. 0 means teams hand-roll pools. 5 means all async work uses a shared SDK with mandatory middleware for tracing, metrics, idempotency, panic recovery, and graceful shutdown.
- Job queues. 0 means teams pick their own storage ad hoc. 5 means tiered platform with documented SLOs, transactional enqueue, and auto-provisioned dashboards.
- Scheduling. 0 means cron in every service. 5 means centralized scheduler service with etcd leader election, UI for manual trigger, audit log, and quarter-year DST drill.
- Dead letters. 0 means DLQ is a table. 5 means DLQ product with RBAC, triage SLA, replay tooling, per-tier retention policies, and quarterly game-days.
- Monitoring. 0 means teams build their own dashboards. 5 means auto-generated SLO dashboards per job_type with burn-rate alerts wired to owning team's on-call.
- Locking. 0 means Redlock sprinkled through code. 5 means lease-based coordination via etcd or consensus store, with fencing tokens for correctness-critical work, and lock-free alternatives chosen wherever possible.

A mature platform scores 4 to 5 across all six. Most orgs score 1 to 2 and never invest. The staff-level deliverable is to get the org to 4+ over a 3-year roadmap.

**Multi-year vision document outline.** Title, "Async work at our company, a 3-year platform plan". Chapters. Current state (inventory of team-owned queues and incidents). Target state (mature platform scored 4+ on all axes). Milestones per quarter. Investment (FTE, infra spend). Risks. Organizational changes (team formation, on-call rotation). Success metrics (adoption rate, SEV rate reduction, cost per million jobs). This document gets reviewed by eng leadership and funded or denied. If denied, the staff engineer refines and resubmits. If funded, the staff engineer executes.

**Legacy of this chapter for a staff engineer.** The chapter is a reference. In practice, the work is politics, prioritization, and incremental migration. Technical content is table stakes. The differentiator is the ability to convince 30 teams to adopt your SDK, to negotiate with SRE for on-call support, to justify budget for 3 FTE for 12 months, and to maintain momentum through leadership changes. This is not in the chapter. This is what gets you to principal.

---
