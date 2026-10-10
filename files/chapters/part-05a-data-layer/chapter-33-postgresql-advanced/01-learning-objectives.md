## Learning Objectives

After completing this chapter, you will be able to:

1. **Master the pgx driver** - Use PostgreSQL's native Go driver for optimal performance and full feature support
2. **Work with JSONB** - Store, query, and index semi-structured data efficiently
3. **Implement full-text search** - Build powerful search features using PostgreSQL's built-in capabilities
4. **Use advanced SQL features** - Apply window functions, CTEs, and recursive queries
5. **Build real-time systems** - Implement LISTEN/NOTIFY for event-driven architectures
6. **Apply distributed locking** - Use advisory locks for coordination across services
7. **Design for FAANG scale** - Apply patterns used by Uber, Stripe, and Instagram

### Junior → FAANG: What "Able To" Actually Means in Review

Each objective above hides an expected depth that juniors routinely underestimate. "Master the pgx driver" does not mean you can run `pgx.Connect` and call `QueryRow`. It means you can explain why `pgxpool.Pool` is the correct primitive for a long-running service, what the `MaxConns`, `MinConns`, `MaxConnLifetime`, `MaxConnIdleTime`, and `HealthCheckPeriod` knobs do to PgBouncer-fronted deployments, and when `conn.Prepare` plus named statements is harmful rather than helpful (hint: through PgBouncer older than 1.21 in transaction pooling mode, pgx v5's default prepared-statement caching breaks, so you set `DefaultQueryExecMode` to `QueryExecModeExec` or `QueryExecModeSimpleProtocol` - PgBouncer 1.21+ added prepared-statement support so the `cache_statement` mode works again). "Work with JSONB" in a FAANG review means you can draw on a whiteboard which GIN operator class supports which operator, explain when jsonb is worse than a typed column, and show a migration path. "Implement full-text search" means you know why the language config matters, why you store `tsvector` as a generated column, and why you still need `pg_trgm` for typo tolerance.

For each objective, write yourself a three-sentence "what would fail my self-review" statement before you start the section. If you cannot, you are not ready to move on. The interview bar for a backend role at a FAANG in 2026 is no longer "can you use feature X" but "can you defend the choice of feature X over its two nearest alternatives."

### Senior @ FAANG: Objectives Reframed as Deliverables

At staff level the objectives above are not personal skills. They are team-wide deliverables you are accountable for driving. "Master pgx" becomes: the Go platform team ships a sanctioned internal module wrapping `pgxpool` with correct defaults (lifetime caps, tracing hooks via `pgx.QueryTracer`, OTEL span propagation, PII-safe query logging, mandatory `context.Context` with deadline), and every new service is blocked at CI if it imports `database/sql` with a Postgres driver directly. "Work with JSONB" becomes: there is a registered schema-per-column registry in the repo, CI validates migrations declare whether a JSONB column is schema-governed or free-form, and schema-governed columns have a gojsonschema or CUE validator referenced in the ORM layer. "Implement full-text search" becomes: there is an ADR on record that declares the FTS crossover trigger (p99 latency, document count, or query feature gap) at which the team migrates to `pg_search` or an external tier, and a dashboard tracks the leading indicators.

"Apply distributed locking" becomes the most politically loaded objective. Advisory locks across service instances are tempting because they are cheap and require no new infrastructure, but they silently assume a single primary. In any architecture with read replicas, logical replication lag, or multi-region failover, advisory locks held on the old primary vanish on failover with no notification to the lock holder. Your staff-level deliverable is a written guardrail: advisory locks are allowed only for (a) intra-request coordination within a single transaction, (b) idempotent leader election where double-execution is safe, or (c) short critical sections with a defense-in-depth idempotency key. Anything else goes to a real lock service (etcd, Consul, or a Postgres table with a fencing token).

"Design for FAANG scale" becomes: you own the reversal triggers document. Every Postgres feature the team leans on has a named condition under which you pull it back out. No feature is load-bearing without an exit plan. That is the difference between a senior who uses Postgres well and a staff engineer who keeps the company from repeating the 2015-era "add another datastore" spiral.

---
