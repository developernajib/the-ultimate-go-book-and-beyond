## Summary

Advanced PostgreSQL features:

1. **pgx**: Use native driver for best performance
2. **JSONB**: Store and query structured data with GIN indexes
3. **Full-Text Search**: Built-in search with ranking and highlighting
4. **Window Functions**: Advanced analytics and reporting
5. **CTEs**: Complex queries and recursive hierarchies
6. **LISTEN/NOTIFY**: Real-time event notifications
7. **Advisory Locks**: Distributed coordination without external systems
8. **Upserts**: Efficient insert-or-update with ON CONFLICT

### Junior → FAANG: Summary as a Self-Assessment Checklist

Treat this summary as a list of claims you must be able to defend in an interview or on-call rotation. For each bullet, ask yourself two questions: can I demonstrate it in a live Postgres 18 session, and can I name the failure mode when it is misused?

Self-assessment checklist:
1. pgx: can you explain why `pgx` outperforms `database/sql` with the stdlib driver? Binary protocol, native type codecs, no reflection in the hot path, pool semantics tuned for pgbouncer. Failure mode: forgetting to release connections on LISTEN, leaking connections until the pool exhausts.
2. JSONB: can you pick between GIN with `jsonb_path_ops`, GIN with default `jsonb_ops`, expression indexes on `->>`, and generated columns? Failure mode: indexing JSONB with GIN when every query uses `->>`.
3. Full-text search: can you write a query that combines `ts_rank_cd`, phrase matching via `phraseto_tsquery`, and exact-name boosting? Failure mode: trusting `ts_rank` alone and shipping a bad relevance experience.
4. Window functions: can you write `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC)` for the "latest per group" pattern, and explain when `DISTINCT ON` is cheaper? Failure mode: using window functions when a lateral join would be faster.
5. CTEs: can you state the PG 12 inlining rule and force materialization? Failure mode: relying on pre-12 fence behavior and regressing on upgrade.
6. LISTEN/NOTIFY: can you explain why it is a hint, not a queue? Failure mode: treating it as durable and losing events during long transactions.
7. Advisory locks: can you distinguish session-scoped from transaction-scoped? Failure mode: using `pg_advisory_lock` in a handler that might panic.
8. Upserts: can you write `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` with `EXCLUDED.*` references and a `WHERE` clause on the DO UPDATE? Failure mode: using `ON CONFLICT DO NOTHING` when the caller needs to know it was a duplicate.

Interview entry-point: "Pick one of these eight features and tell me about a time you used it in production, including what went wrong." If you cannot answer that question for at least four of the eight, you are not yet at L4. If you can answer it for all eight with specific incident details, you are at L5.

### Senior @ FAANG: Summary as a Platform Maturity Map

At staff and principal level, this summary is a map of the Postgres capabilities your organization has adopted, to what maturity level, and with what governance. Every bullet is a potential platform investment or a potential source of incidents.

Platform maturity snapshot: for each feature in the summary, rate your org on a 1-to-5 scale.

| Feature | L1 Nascent | L3 Standardized | L5 Self-service |
|---------|-----------|-----------------|-----------------|
| pgx adoption | Each team picks a driver | Org mandates pgx v5+ with connection pool defaults | Golden-path template ships with pgx, observability hooks, and chaos-tested timeouts |
| JSONB governance | Ad-hoc | ADR required for JSONB columns > 1 KB | CI linter enforces index patterns, bloat dashboard per column |
| FTS platform | Hand-tuned per team | Shared tsvector helpers, weight profiles | Search relevance is measured, A/B tested, and gated on offline eval |
| Window functions | Informal | Training material and query style guide | Query review bot catches N+1 that could be window-function-ized |
| CTE usage | Informal | Pre-upgrade plan diffing on MATERIALIZED keyword | Automated plan regression detection on every deploy |
| LISTEN/NOTIFY | Used as queue | Used as hint, outbox table is source of truth | Deprecated in favor of managed event bus |
| Advisory locks | Unmanaged IDs | Namespace registry service | Replaced by row locks or managed workflow engine |
| Upserts | Common | Idempotency key discipline documented | Framework generates upsert paths with observability |

Where an L5 rating is unrealistic, aim for L3 as the floor. Below L3, every new team introduces its own failure modes.

ADR: retiring LISTEN/NOTIFY at scale. Postgres-heavy shops that publish their scaling decisions (Notion and Figma are the best-documented) all hit a variant of this call. The tradeoff is that LISTEN/NOTIFY is free and already in Postgres, while an event bus is a new platform commitment. The ADR typically decides: keep LISTEN/NOTIFY for low-volume, non-durable use cases (cache invalidation, real-time dashboards), move high-volume or durable cases to the outbox pattern, and migrate org-wide event flow to Kafka or NATS when the outbox pattern hits operational limits.

Managed Postgres summary for 2026 strategic planning:
- If you run on AWS, the default is Aurora Postgres with RDS Proxy. Aurora Limitless is maturing but not yet the default for new workloads above 10 TB.
- If you run on GCP, AlloyDB is the premium choice for mixed OLTP/OLAP. Cloud SQL for standard workloads.
- If you run on Azure, Cosmos DB for PostgreSQL (Citus) is the distributed option. Flexible Server for standard.
- If you run multi-cloud or on-prem, Crunchy Data Postgres or self-hosted with Patroni are the realistic options.
- For dev and preview environments, Neon's branching model has become the de facto standard. Supabase for product teams who want a full backend.

Staff-level commitments that flow from this summary:
1. Write the extension review ADR this quarter for the top three extensions your org wants (likely pgvector, TimescaleDB, and pg_partman).
2. Adopt a schema-change tool (pgroll recommended for most teams) and migrate existing migrations through it over two quarters.
3. Build or buy a query plan regression detector. Deploy it as a CI gate.
4. Commit to a major version upgrade cadence. PG 16 to PG 18 via logical replication switchover, rehearsed on a staging cluster, executed quarterly on production clusters over a year.
5. Publish the Postgres platform SLOs: provisioning time, failover RTO/RPO, schema change lead time, query plan stability. Measure against them.

Closing bar-raiser prompt: "If you had to bet the company on either Postgres 18 or a distributed SQL system for the next five years, which do you pick and why?" There is no right answer. There is only a right way to reason: write scale, geographic requirements, team operational maturity, lock-in cost, and the maturity of the destination ecosystem. Staff engineers answer confidently in either direction. Principal engineers answer with the migration plan already drafted.

---
