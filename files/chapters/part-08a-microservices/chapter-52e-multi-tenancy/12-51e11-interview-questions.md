## 52E.11 Interview Questions

### Junior Level

**Q: What is multi-tenancy and what are the main data isolation approaches?**
A: Multi-tenancy means one software deployment serves multiple customers (tenants) with isolated data. The main isolation approaches - using AWS SaaS Factory terminology - are: (1) **Pool model** - shared table with a `tenant_id` column, simplest and cheapest, requires every query to filter by `tenant_id`. (2) **Schema-per-tenant** - shared database but each tenant has their own PostgreSQL schema, better isolation boundary and easier per-tenant drops, but migrations touch every schema. (3) **Silo model** - separate database per tenant, strongest isolation, highest cost and operational overhead. (4) **Bridge model (hybrid)** - shared app, tenant-aware data layer that routes free/pro to pool and enterprise to silo. Most SaaS companies start pool-only and add a bridge once they sign their first enterprise deal.

**What FAANG expects:** Name all three AWS SaaS Factory models (pool/silo/bridge) unprompted. Identify that "pool + Postgres RLS" is the most common production pattern at scale, not because it's simplest but because RLS turns the riskiest part (forgotten `WHERE tenant_id` filters) into a database-enforced invariant.

Follow-ups:
- *Why is pool-with-RLS preferred over schema-per-tenant for a SaaS with 50k tenants?* Schemas don't scale: Postgres system catalogs struggle past ~10k schemas, migrations become N-operations, and pg_dump/pg_restore get slow. RLS gives you the isolation story without the catalog explosion.
- *What breaks in the silo model at scale?* Connection-pool explosion (each tenant's pool holds idle conns), migration orchestration across N databases, and the operational cost of monitoring N Postgres instances. Silo is for compliance tiers, not the default.
- *When would you use schema-per-tenant over pool-with-RLS?* When you need per-tenant extensions, per-tenant backup/restore as first-class operations, or when regulators explicitly demand schema-level separation in a compliance audit.

**Q: How do you pass tenant context through a Go application?**
A: Using Go's `context.Context`. The HTTP middleware extracts the tenant identifier from the request (subdomain, header, JWT claim), looks up the tenant record (with caching), and stores the `TenantContext` struct in the context using `context.WithValue` with an unexported key type. Each layer calls `tenant.FromContext(ctx)` to get the current tenant. The database layer uses the tenant ID from context to add `WHERE tenant_id = $1` and/or to `SET LOCAL app.tenant_id` for RLS. This ensures tenant is available everywhere without passing it as a function parameter.

**What FAANG expects:** Call out that the context key must be unexported to prevent cross-package collisions, and that a `MustFromContext` helper that panics on missing tenant is a correctness net - internal code should never run without tenant context, and a panic is better than a silent cross-tenant leak.

Follow-ups:
- *What goes wrong if you pass `tenant_id` as a function parameter instead of through context?* Every function signature grows, background workers need to rebuild the parameter chain, and you get "I forgot to pass it here" bugs that are exactly the kind of bug that leaks tenant data.
- *How do you propagate tenant context to a background worker or Kafka consumer?* Embed it in the message envelope (not the payload), extract it in the consumer, and reconstruct the context at the start of message handling. Never inherit the publishing goroutine's context.
- *How do you prevent a developer from accidentally calling a repo method without tenant context?* `MustFromContext` panics. Unit tests that construct empty contexts and assert panic. A lint rule or analyzer that flags repo methods called with `context.Background()` in non-test code.

**Q: What is a "noisy neighbor" in multi-tenancy and how do you detect it?**
A: A noisy neighbor is a tenant whose workload consumes disproportionate shared resources (CPU, DB connections, network, locks), degrading the experience for other tenants. Detection: per-tenant request rates and durations written to a time-series store (ClickHouse/TimescaleDB, not Prometheus - `tenant_id` is too high-cardinality for Prometheus labels). Alert when a tenant exceeds N times the median. Mitigation: per-tenant rate limits, bulkheads (`semaphore.Weighted` per tenant), per-plan `statement_timeout`, and isolation-tier escalation for repeat offenders.

**What FAANG expects:** Separate detection from containment. Detection tells you which tenant is noisy. containment (bulkheads, timeouts, isolated pools) prevents the noise from affecting others in the first place. And they expect the cardinality nuance: `tenant_id` belongs in logs and traces, not in Prometheus metrics.

Follow-ups:
- *Why not put `tenant_id` as a Prometheus label?* Cardinality: 50k tenants x status x method x path blows past Prometheus's practical limit. Traces are sampled (bounded cardinality), and logs are indexed cheaply by Loki/ClickHouse. Metrics must stay low-cardinality.
- *What's the difference between a rate limiter and a bulkhead for noisy neighbors?* A rate limiter caps requests per unit time (RPS). A bulkhead caps concurrent in-flight work (concurrency). A tenant can be under their RPS budget but still hold 50 slow DB connections. You need both.
- *How do you handle a noisy neighbor running a legitimate bulk import?* Offer a bulk-import API endpoint with its own quota and a separate worker pool. Don't kill the request - route it to a path with higher latency budget and isolated resources.

### Mid Level

**Q: Describe the trade-offs between subdomain, path, and header-based tenant routing.**
A: Subdomain routing (`acme.app.com`) provides the best user experience and clear tenant identity, but requires wildcard SSL, DNS setup, and CORS care. Standard for user-facing SaaS. Path routing (`app.com/t/acme/`) is simpler to implement but changes every URL and leaks tenant in the path. Header routing (`X-Tenant-ID: acme`) is ideal for API-first products and internal service-to-service - clean URLs, explicit tenant identity, but requires clients to set the header. In practice: subdomain for the web UI, headers/JWT claim for the API, path for internal admin tools.

**What FAANG expects:** Acknowledge that custom domains (`crm.acme.com`) are table stakes for enterprise and require a verified-domain lookup table plus on-demand TLS (Let's Encrypt / ACME) per-domain. And: whichever transport you pick, the server-side tenant MUST come from a verified source (JWT claim or DNS-verified host), never from an unauthenticated header.

Follow-ups:
- *How do you issue TLS certs for thousands of custom domains?* On-demand TLS with Caddy or a Cloudflare for SaaS tier. ACME DNS-01 challenge automated per verified domain. Cache certs. Rotate before expiry.
- *What happens if the JWT says tenant A but the subdomain says tenant B?* Return 403 immediately. Don't pick one - the mismatch itself is the attack signal. Log it, alert on it.
- *How do you prevent subdomain takeover in a multi-tenant setup?* Never serve unknown subdomains. Explicit tenant registry check. If a tenant offboards, remove DNS and revoke their wildcard mapping before their domain can be re-registered by an attacker.

**Q: How do you implement zero-downtime tenant offboarding that complies with GDPR right to erasure?**
A: The process: (1) Mark tenant as `pending_deletion` immediately - stop new data ingestion, revoke sessions. (2) Export all tenant data as a zip to object storage (GDPR Article 20 - portability - also applies). (3) Delete in dependency order: child tables first, parents last. Batch large deletes with SKIP LOCKED to avoid long-running locks. (4) Purge external systems: S3/GCS files, search indexes, CDN, analytics backfills, warm replicas. (5) Record a deletion certificate (tables, row counts, timestamp, requester) for compliance. (6) Keep the deletion record itself for audit, with a cryptographic hash of what was deleted. Async backups may retain data for up to 30 days - document this in your DPA.

**What FAANG expects:** GDPR right-to-erasure has hard edges: backups, logs, analytics warehouses, and third-party processors (Segment, Mixpanel, Datadog). A credible answer enumerates all of them and explains the retention window for each. They also expect you to mention that deletion of the deletion record would itself violate the audit trail - you keep the ledger, not the data.

Follow-ups:
- *What about data in logs and traces?* Apply per-tenant log retention with a cutoff after deletion. For highly sensitive fields, use per-tenant encryption keys and "crypto-shredding" - delete the key and the data is unrecoverable everywhere.
- *How do you handle GDPR requests for a tenant on a silo database?* Easier: `DROP DATABASE` after export. The silo model earns its cost here.
- *How do you verify deletion actually happened?* Post-deletion audit query: `SELECT COUNT(*) FROM <table> WHERE tenant_id = ...` across every tenant-scoped table, plus checks against search indexes and blob storage listings. The verification run itself is logged.

**Q: How would you design per-tenant feature flags that are instantly effective when a plan is upgraded?**
A: Three layers with pub/sub invalidation: (1) PostgreSQL source of truth - `plan_features` matrix plus `tenant_feature_overrides` for custom enterprise deals. (2) Redis cache, 5-minute TTL. (3) Local in-memory cache per app instance, 30-second TTL. On plan upgrade: delete the Redis key and publish an invalidation event on a Redis channel. Every app instance subscribes and evicts its local cache. The local TTL is the recovery window if a pub/sub message is missed.

**What FAANG expects:** You call out the failure modes: pub/sub is not delivery-guaranteed, so the local TTL is your safety net. You explain cache stampede prevention (singleflight on the DB read). And you distinguish "feature on/off" from "feature quota" - flags gate availability, quotas need real-time enforcement and live in the rate limiter, not the flag cache.

Follow-ups:
- *What if Redis is down during a plan upgrade?* Local caches keep serving stale data until TTL expires (30s). Writes to the source-of-truth DB succeed. Redis gets reconciled on recovery. Users see correct state within 30s.
- *How do you A/B test features per tenant without plan-level flags?* Deterministic hashing: `hash(tenant_id + experiment_id) % 100 < rollout_pct`. Stable per tenant, no DB lookup, easy to unroll.
- *How do you prevent a developer from reading a flag before middleware has loaded tenant context?* `IsEnabled(ctx)` calls `tenant.MustFromContext` which panics if absent. Unit tests enforce.

### Senior Level

**Q: Design a multi-tenant architecture for a SaaS that must support free (100 tenants per host), pro, and enterprise (isolated database) tiers on the same codebase.**
A: A bridge-model `DataAccessLayer` that routes based on `TenantContext.IsolationTier`:
- **Shared (pool)**: free + pro share tables with `tenant_id` and Postgres RLS. One pool, one schema.
- **Schema (optional mid-tier)**: shared DB, dedicated schema via `SET search_path`.
- **Database (silo)**: enterprise gets a dedicated database - potentially on dedicated hardware or a compliance region. A `TenantDatabaseRouter` lazily initializes per-tenant `pgxpool.Pool`s with double-checked locking.

All three tiers share the same repository interfaces. The DAL's `GetConnection(ctx)` reads `IsolationTier` from context and returns the right pool and schema. Migrations run as three separate pipelines: one for shared tables (standard goose), one that iterates per-tenant schemas, one that iterates per-tenant databases. New enterprise tenant provisioning includes a migration-run step as part of the onboarding job.

**What FAANG expects:** The abstraction that makes this tractable is that business logic is oblivious to the isolation tier. They expect you to articulate what's hard: (1) migrations across N silo databases with partial-failure handling, (2) observability across heterogeneous backends, (3) cost of connection-pool explosion in silo mode (each silo needs a pool, and idle pools still hold conns), and (4) how you test cross-tenant isolation across all three modes in CI.

Follow-ups:
- *How do you handle a schema migration that takes 2 hours on the shared pool?* Expand/contract pattern: add new columns/tables (fast), dual-write (app), backfill in batches with `SKIP LOCKED`, cut reads over, remove old columns. Never block writes.
- *How do you prevent a silo tenant from running with a stale schema?* Provisioning job runs migrations synchronously on new silos. A background reconciler verifies schema version across all silos daily and alerts on drift.
- *What's the cost model you'd pitch to product?* Pool tier: ~$X/tenant/month marginal. Silo tier: ~$Y/tenant/month fixed. Sell silo as a line item (data residency, dedicated infrastructure) with an attached SLA.

**Q: A free-tier tenant is running a query that's causing table locks and affecting all other tenants. Walk me through how you'd detect, mitigate, and prevent this.**
A: **Detection**: `pg_stat_activity` for long-running queries, `pg_locks` + `pg_blocking_pids()` to find the blocker, per-tenant duration metrics in ClickHouse alerting before it cascades. **Immediate mitigation**: `pg_cancel_backend(pid)` first (graceful), `pg_terminate_backend(pid)` if it won't cancel. For repeat offenders: `ALTER ROLE tenant_free_user SET statement_timeout = '5s'`. **Prevention**: (1) per-plan `statement_timeout` (free 5s, pro 30s, enterprise 120s), and (2) per-tenant bulkheads on DB connections - free tier gets N concurrent slots, not unbounded. (3) separate connection pools for background jobs vs interactive traffic. (4) query-cost estimation at the app layer for known-expensive operations with early rejection. (5) persistent offenders migrate to isolated schemas or silo databases.

**What FAANG expects:** They're probing for containment-first thinking. The `pg_cancel_backend` story is fine, but the structural answer is: a free tenant should *never* have been able to hold a long-running lock that affects others. Bulkheads, statement timeouts, and per-tier connection pools make the incident impossible, not recoverable. They'll also expect you to mention `lock_timeout` and `idle_in_transaction_session_timeout` as well as `statement_timeout`.

Follow-ups:
- *What's the difference between `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`?* Statement caps any query duration. lock_timeout caps time waiting on a lock (fails fast if blocked). Idle-in-tx kills sessions that started a tx and walked away. All three are needed in a multi-tenant Postgres.
- *How would you build query-cost estimation at the app layer?* EXPLAIN before execution for known endpoints (reports, exports), then reject or route to an async worker if estimated rows exceed a threshold. Cache plan shapes.
- *What if the noisy tenant is running a legitimate heavy report?* They belong on a read replica with relaxed timeouts, or on an async export queue. Interactive traffic is never the right path for a 5-minute aggregation.

**Q: How would you migrate a running multi-tenant application from a shared-table (pool) model to a per-schema model for a specific set of enterprise tenants, with zero downtime?**
A: Live migration in six phases: (1) **Schema marker**: add `isolation_tier` to `organizations` defaulting to `'shared'`. (2) **Target schema**: create each migrating tenant's target schema with the same table definitions, empty. (3) **Dual-write**: application detects `'migrating'` tier and writes to both shared tables (with `tenant_id`) and target schema simultaneously - wrapped in a single transaction so partial writes are impossible. (4) **Backfill**: copy historical rows from shared tables into target schema in batches with `SKIP LOCKED` to avoid blocking dual-writes. (5) **Verification**: row counts, checksums, and a shadow-read period where reads go to shared, and a sampling of reads is compared against schema. (6) **Cutover**: single transaction flips `isolation_tier` from `'migrating'` to `'schema'`. App immediately routes to schema. After a verification period (24-72 hours), delete the tenant's rows from shared tables. The `DataAccessLayer` handles all three states (`shared`, `migrating`, `schema`) transparently.

**What FAANG expects:** They'll dig into consistency during dual-write. The disciplined answer: dual-writes must be atomic with the original write (same transaction), or the system is eventually inconsistent. They'll also expect you to mention a rollback plan: if verification fails, flip `isolation_tier` back to `'shared'`, truncate target schema, and investigate - the dual-write kept shared tables authoritative the whole time. And they want to hear how this is tested in staging before production, with synthetic enterprise tenants.

Follow-ups:
- *What if the target schema and shared tables diverge during backfill?* A reconciliation job runs alongside backfill, comparing row checksums. Divergence pauses cutover. Dual-write atomicity is the invariant that prevents divergence for new writes. backfill handles historical.
- *How do you handle foreign keys across the migrating boundary?* You don't - constrain the migration unit to a complete tenant graph. If there are cross-tenant FKs, you have a bigger design problem before you even start.
- *What's the rollback if the customer calls at 3am saying reports are wrong post-cutover?* Re-enable dual-write mode (isolation_tier = 'migrating'), flip reads back to shared, investigate the discrepancy. The shared data is still authoritative until you explicitly delete it.

### Junior → FAANG: How to Use This Question Set

The questions and answers in this section are a preparation scaffold, not a script. FAANG interviews reward structured reasoning over memorized answers. For each question above, practice answering it out loud in under three minutes, then defending each choice when the interviewer pushes back with a follow-up.

The highest-value preparation sequence for junior candidates:

1. Answer the junior-level questions first without looking at the answers. Write down your answer, then compare it to the model answer. The gaps are your study material.
2. For each follow-up question, identify whether you could answer it confidently. If not, re-read the relevant section of this chapter.
3. Practice the mid-level questions under the assumption that the interviewer will follow up with "what breaks at scale" for every answer. Anticipate the follow-up.
4. Know one concrete production system for each model: Salesforce for pool-with-RLS, Heroku for silo-per-customer, Shopify for the bridge model. Mentioning real systems signals you have studied the domain, not just the textbook.

First-job habits that reflect well in interviews:

- When discussing GDPR deletion, enumerate all the data stores, not just the primary database. Logs, search indexes, analytics warehouses, and CDN caches are all part of the correct answer.
- When discussing noisy neighbors, separate detection from containment. An interviewer who hears "I'd rate limit them" as the only answer knows you have not operated a production multi-tenant system.
- When discussing RLS, mention the `SET LOCAL` versus `SET` distinction. It is a specific, correct, operational detail that most candidates miss.

### Senior @ FAANG: Bar-Raiser Framing and L6/L7 Design Signals

The senior-level questions in this section are bar-raiser questions. They are not testing implementation knowledge. They are testing whether you can design a system that an engineering organization can build, operate, and evolve without your continued involvement.

**What bar-raisers look for in senior candidates:**

- Completeness of the failure mode analysis. A senior candidate describes not just the happy path but also the partial failure, the cascading failure, and the silent correctness failure. In the migration question above, the correct answer includes the rollback plan, the invariant that makes rollback safe, and the verification step before cutover.
- Separation of concerns. The bridge-model answer separates business logic (repository interfaces) from infrastructure routing (DataAccessLayer). A candidate who conflates these is operating at mid-level.
- Operational ownership. "How do you prevent a stale schema?" is an operational question. The correct answer includes a background reconciler, an alert, and a runbook, not just the provisioning step.
- Cost awareness. Enterprise SaaS architects must be able to price the isolation tier they are recommending. A candidate who proposes silo-per-tenant without acknowledging connection pool economics and infrastructure cost is not ready for L6.

**L7-level framing: the platform answer:**

At L7, every question about multi-tenancy is answered at the platform level, not the service level. "How do you enforce tenant isolation?" is answered with: "The platform injects the data access layer and tenant middleware into every service via the service scaffold. Services cannot opt out without an ADR. The control plane verifies compliance via automated scanning of deployed service configurations." This is a different order of thinking than "I add a WHERE clause to every query."

**Interview signals that separate L5 from L6:**

- L5: "I use RLS to enforce tenant isolation."
- L6: "I use RLS as a defense-in-depth layer, with application-layer WHERE clauses as the primary control and cross-tenant isolation tests in CI as the verification mechanism. I also know that SET LOCAL is required for RLS configuration in connection pools, and I have a test that validates this."

The difference is: L5 knows the pattern, L6 knows the failure modes, the operational constraints, and the verification strategy.

**Practical interview prep at senior level:**

Run each senior-level question through this filter: "If I were a new engineer joining a team that had just shipped this design, what would I find when I looked at the code, the tests, the monitoring, and the runbooks?" If any of those layers is empty or thin, the design is incomplete. Senior candidates describe all four layers as part of their answer.

---
