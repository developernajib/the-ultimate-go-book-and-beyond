## Common Mistakes

The table below lists the most frequent errors teams make during legacy modernization, along with the consequences and the correct approach. Each mistake has been observed repeatedly in real-world migrations. Review this list before starting your migration and revisit it at each phase transition to make sure you are not falling into a known trap.

| Mistake | Consequence | Correct Approach |
|---|---|---|
| Big-bang rewrite without incremental routing | single point of failure, months of hidden risk land at once | Use Strangler Fig with feature flags to shift traffic gradually: 1% → 5% → 25% → 100% |
| Dual-write without ordering guarantees | Last-write-wins races corrupt data in both stores | Write to primary first synchronously, and use optimistic locking with version fields |
| Skipping shadow mode | Behavioral differences discovered in production under real load | Run shadow mode at 10-20% traffic for at least one full business cycle before shifting |
| Removing old columns immediately | Breaking legacy service still reading old columns | Always follow expand-contract: add new column → backfill → verify → switch reads → then drop old column |
| Feature flags that can't be toggled without deploy | Rollback requires a new deployment, adding MTTR | Store flag state in a fast external store (Redis/config service) that updates without deploy |
| Not rate-limiting backfill jobs | Backfill consumes all DB I/O, causing production latency spikes | Use batch sizes of 500-1000 rows with configurable sleep between batches |
| Propagating auth tokens to shadow service | Credentials replayed to an untested service leak into logs | Strip all Authorization headers, and only copy safe, non-sensitive headers to shadow |
| Forgetting to purge shadow traffic from SLOs | Shadow errors inflate error rates and burn alert budget | Tag shadow requests with a header and exclude them from SLO calculations |
| No reconciliation step after dual-write | Silent data divergence discovered weeks later when legacy is removed | Run continuous reconciliation jobs, and alert on any mismatch rate above 0.01% |
| API versioning only in the URL | clients hardcode URLs, and version negotiation breaks downstream tooling | Support both URL path versioning and `API-Version` header, and send `Deprecation` headers |
| Rollback is manual and undocumented | Incident response delays while engineers figure out the rollback procedure | Automate rollback to a single CLI command or feature flag toggle, and run drills quarterly |
| No canary analysis before ramp | Silent correctness bugs (wrong totals, missing data) missed by error rate alone | Add automated canary analysis comparing P50/P99 latency, error rate, and shadow match rate |

### Junior → FAANG: Reading the Mistake Taxonomy Before You Write Code

The table above is not a post-mortem collection. It is a checklist of constraints that must be satisfied before any migration step is considered complete. The pattern connecting most of these mistakes is the same: a team optimizes for moving fast in the short term and pays the cost in production incidents that take far longer to resolve than the original shortcut saved.

The two mistakes that catch early-career engineers most consistently are big-bang rewrites and skipping shadow mode. Big-bang rewrites feel faster because they avoid the complexity of incremental routing. They are not faster: they accumulate hidden risk until a single deployment event releases it all at once. Shadow mode feels like overhead. It is not overhead: it is the only mechanism that validates the new service against real production traffic patterns before users are exposed to it.

For Go engineers entering their first production migration: commit the expand-contract sequence to memory (add column, backfill, verify, switch reads, drop old column) and the feature flag requirement (external store, no deploy required for toggle) before touching any migration code. Violations of either constraint are the most common source of migration-related production incidents.

### Senior @ FAANG: Using the Mistake Taxonomy as a Governance Checklist

At senior level, the mistake table is an input to the migration review process. Before approving a migration plan, a senior engineer should verify that the plan explicitly addresses each mistake category: Is there a gradual traffic ramp plan? Is dual-write ordering guaranteed? Is shadow mode scheduled for at least one full business cycle? Is there an expand-contract schema migration plan? Can feature flags be toggled without a deployment? Is backfill rate-limited? Are auth tokens stripped from shadow traffic? Are shadow requests excluded from SLOs? Is reconciliation automated with alerting? Does API versioning support both URL and header negotiation? Is rollback automated and drilled?

If any of these questions cannot be answered yes before the migration begins, the migration plan is incomplete and should not be approved. This is the bar-raiser function of a senior engineer during migration planning: not to design the migration, but to verify that the team has thought through all known failure modes before they begin.

The two mistakes most commonly underestimated by mid-level engineers who have not yet been on-call for a major migration incident: forgetting to purge shadow traffic from SLOs (which produces alert fatigue during the migration period and desensitizes the team to real alerts) and no canary analysis before ramp (which allows silent correctness bugs to reach a significant fraction of users before error rates signal a problem). Both mistakes are invisible until they cause an incident. Catching them in planning is the difference between a smooth migration and one that requires a 2 AM rollback.

---
