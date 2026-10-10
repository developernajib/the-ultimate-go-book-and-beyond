## Interview Questions and Answers

**Q1: How does the Strangler Fig pattern differ from a blue-green deployment?**

Blue-green deploys the entire new system at once and switches all traffic atomically. If it fails, you roll back all traffic. Strangler Fig migrates incrementally: specific routes are moved one by one to the new system, coexisting with legacy. There is no single switchover event. Strangler Fig is safer for large systems because the blast radius of any regression is limited to the migrated routes, but it requires maintaining two systems in parallel for longer.

**Q2: What are the failure modes of dual-write and how do you handle them?**

There are three main failure modes. First, the primary write succeeds but the secondary fails: this creates divergence. Fix with an async retry queue and a reconciliation job that detects and heals mismatches. Second, both writes succeed but with a race condition where old and new receive writes in different orders: fix with optimistic locking (version fields) and last-write-wins semantics defined explicitly. Third, the async queue overflows: implement backpressure, circuit breakers, and persistent queuing (Kafka or SQS) rather than an in-memory channel. Always treat the primary store as source of truth during migration.

**Q3: How do you implement online schema changes on a table with 500 million rows?**

Use the expand-contract pattern. Phase 1 (Expand): Add the new column as nullable. This is a metadata-only change in modern databases and completes in milliseconds. Phase 2 (Migrate): Backfill data in batches of 1000 rows using keyset pagination, with 50-100ms sleep between batches to avoid I/O saturation. For 500M rows at 1000/batch, expect 5-10 hours at conservative rate. Run the application in dual-write mode (writing both columns) throughout. Phase 3 (Verify): Run a COUNT query to confirm zero NULL rows in the new column. Phase 4 (Switch): Deploy code that reads from the new column. Monitor for one traffic cycle. Phase 5 (Contract): Drop the old column. For MySQL, use pt-online-schema-change or gh-ost for large tables to avoid locking.

**Q4: How do you measure migration progress?**

Track five signals: (1) Traffic split percentage - what fraction of requests go to the new service. (2) Error rate delta - new service error rate minus legacy error rate, which should be ≤ 0. (3) Latency delta - P99 new minus P99 legacy, with regression alert at +10%. (4) Shadow match rate - percentage of shadow responses that exactly match legacy, with target ≥ 99.9%. (5) Data reconciliation mismatch rate - percentage of entities with divergent state between old and new stores, with target 0%. These metrics are tracked on a dashboard and drive automated rollback decisions.

**Q5: How do you handle API versioning when clients cannot be forced to upgrade?**

Support multiple versions simultaneously for a defined sunset period. Each version is registered with the router and served from the same binary. Use request transformation middleware to normalize old request shapes into the new canonical form before hitting the service layer, and response transformation to serialize old shapes for v1 clients. Send `Deprecation` and `Sunset` headers on all v1 responses so clients have machine-readable warning. After the sunset date, return `410 Gone`. Never remove a version without at least 6 months of deprecation notice for external APIs. Internal APIs can move faster.

**Q6: What is the difference between shadow mode and canary deployment?**

In canary deployment, a percentage of real users receive responses from the new service. Their experience is affected. In shadow mode, all users get responses from the legacy service, and the new service receives a copy of every request but its response is discarded. Shadow mode has zero user impact, making it safe for correctness validation before any traffic shift. The trade-off is that shadow mode requires spare compute capacity (the new service handles full production load silently) and does not test user-facing behavior. Use shadow mode first for correctness, then canary for performance and operational validation.

**Q7: How do you design a rollback strategy that completes in under one minute?**

There are three requirements: flag updates must propagate without a deployment, the rollback action must be a single command, and the system must handle in-flight requests gracefully. Implementation: store feature flags in a low-latency config store (Redis with sub-10ms reads). The proxy checks flags on every request - no caching beyond a 1-second TTL to balance performance and reactivity. Rollback is a single API call that sets the flag to 0% and all processes pick up the change within one TTL cycle. In-flight requests to the new service complete normally (they are not killed). Write a runbook with the single command and test it in staging quarterly.

### Junior → FAANG: Using Interview Questions as a Migration Knowledge Checklist

The seven questions above are not trivia. They are the practical knowledge surface that distinguishes engineers who can participate in a migration from engineers who can lead one. Before any technical interview for a role that involves distributed systems or service modernization, you should be able to answer all seven questions without notes, with specific implementation details, and with trade-off analysis.

The pattern in how these questions are answered at an interview-passing level: they all include a concrete failure mode, a specific implementation decision with a reason, and a measurement criterion for success. "Use gradual rollout" is not an answer. "Ramp from 1% to 5% to 25% to 100%, measure error rate delta and shadow match rate at each step, and trigger automated rollback if error rate delta exceeds 0.5% for more than 10 minutes" is an answer.

For Go engineers entering interviews: Q3 (online schema changes) and Q7 (sub-minute rollback) are the most likely to be asked in system design rounds for backend roles. Prepare a whiteboard walkthrough for both, including the specific tools you would use (pt-online-schema-change for MySQL, a Redis-backed feature flag store for rollback).

### Senior @ FAANG: Interview Questions as Bar-Raiser Evaluation Signals

At senior level, these seven questions are entry-level prompts. A bar-raiser evaluating an L6 or L7 candidate will extend each question into a governance and organizational design problem.

Extended versions that distinguish L5 from L6 candidates: for Q2 (dual-write failure modes), an L6 answer must address the consistency model decision (is eventual consistency acceptable, what is the maximum staleness window, who defines the SLO for secondary write lag?) and the organizational alert routing (primary store errors route to on-call, secondary store errors route to migration team). For Q3 (online schema changes), an L6 answer must address the governance process (who approves the migration plan, what is the rollback protocol for each phase, how is the backfill rate set and adjusted during peak traffic periods?). For Q5 (API versioning with uncooperative clients), an L6 answer must address the client tracking governance (how do you know which clients are still using v1, what is your escalation process for clients who miss the sunset date, how do you handle external clients versus internal clients differently?).

The bar-raiser signal at L7: the candidate is not answering the question as a technical implementer but as the person responsible for the migration program across multiple teams. They discuss stakeholder alignment, migration milestones as organizational commitments, risk communication to leadership, and the post-migration operational model (when does the old system get decommissioned, who owns the new system, how does the on-call rotation change). This shift from technical depth to organizational scope is the defining characteristic of L7 interview performance in migration and modernization contexts.

---
