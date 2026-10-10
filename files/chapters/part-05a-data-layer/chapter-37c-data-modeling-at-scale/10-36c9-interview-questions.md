## 37C.9 Interview Questions

### Junior Level

**Q: What is the difference between 2NF and 3NF?**
A: 2NF eliminates partial dependencies - every non-key column must depend on the entire primary key, not just part of it (relevant for composite keys). 3NF eliminates transitive dependencies - non-key columns must not depend on other non-key columns. Example: a table with `zip_code`, `city`, and `state` violates 3NF because `city` and `state` are determined by `zip_code` (transitive dependency), not by the primary key directly. The fix is to extract `zip_codes (zip_code, city, state)` into a separate table.

**What FAANG expects:** Demonstrate that 3NF is a *starting point*, not an end goal. Senior candidates note that real production schemas often deliberately denormalize for read-heavy workloads (Instagram's feed, Netflix's viewing history) with explicit invariant enforcement (triggers, application-layer consistency checks). Normalization prevents update anomalies. denormalization trades write complexity for read speed. Know when each trade-off applies.

Follow-ups:
- When would you violate 3NF intentionally, and how would you keep the denormalized data consistent?
- What is BCNF, and why is it rarely needed in practice?
- If you denormalize `customer_email` into `orders`, how do you handle a customer email change?

**Q: What is the difference between soft delete and hard delete? When would you use each?**
A: Hard delete permanently removes the row. Soft delete marks it as deleted (e.g., `deleted_at = now()`). Use hard delete when you have no compliance/audit requirements and want clean data. Use soft delete when you need audit trails, undo capability, or when deleted data is referenced by other tables. The problem with soft delete is that every query must include `WHERE deleted_at IS NULL` - this is easy to forget. Consider archive tables as a hybrid: move deleted rows to a separate table, keeping the main table clean while preserving history.

**What FAANG expects:** Soft delete is a known footgun at scale. Interviewers want to hear about partial unique indexes (`UNIQUE (email) WHERE deleted_at IS NULL`), row-level security policies that auto-filter deleted rows, and GDPR/CCPA implications - soft-deleted PII is still PII under regulation and must be hard-deleted or anonymized on user request. Archive tables plus a scheduled hard-delete job is often the right production pattern.

Follow-ups:
- How does soft delete break unique constraints, and what is the fix?
- A user requests GDPR deletion. Your `users` table uses soft delete. What do you do?
- How would you implement "undelete" with referential integrity preserved for child rows?

**Q: What is a closure table and when would you use it over an adjacency list?**
A: A closure table stores all ancestor-descendant relationships in a separate table, including the depth. An adjacency list only stores direct parent-child relationships. Use a closure table when you frequently need to query entire subtrees or all ancestors of a node - operations that require recursive CTEs on an adjacency list but are simple indexed joins on a closure table. The cost is additional storage and more complex inserts. For read-heavy hierarchies with moderate depth (categories, org charts), closure table is the best balance.

**What FAANG expects:** Know the full taxonomy: adjacency list (simple, recursive queries), path enumeration/`ltree` (fast reads, cheap moves for small trees, rewrites on rename), nested sets (fastest reads, write-hostile), closure table (fast reads and reasonable writes). Senior candidates pick based on read:write ratio, maximum depth, and whether subtree moves are common. Amazon's product category tree uses closure-table-like structures precisely because reads dominate writes by 1000x.

Follow-ups:
- How does a closure table handle moving a subtree to a new parent?
- When would `ltree` be a better choice than a closure table?
- How do you prevent cycles in a closure table on insert?

### Mid Level

**Q: How would you add a NOT NULL column to a table with 100 million rows without downtime?**
A: Use the expand-and-contract pattern. First, add the column as nullable (this is instant in PostgreSQL 11+). Deploy the application code that writes to the new column. Backfill existing rows in batches with brief pauses between batches to avoid lock contention and replication lag. Once backfilled, add a `NOT VALID` check constraint (acquires a brief lock but doesn't scan the table). Validate the constraint separately (`VALIDATE CONSTRAINT` uses a weaker lock). Finally, convert to actual `NOT NULL`. The key is that each step is non-blocking and each step can be deployed independently.

**What FAANG expects:** Walk through the *deployment sequence* explicitly: migration 1 (add nullable column) → deploy code that dual-writes → migration 2 (backfill) → migration 3 (add `NOT VALID` check) → migration 4 (validate + `SET NOT NULL`). Senior candidates mention batch sizing based on replication lag (monitor `pg_stat_replication.replay_lag`), using `FOR UPDATE SKIP LOCKED` for parallel backfill workers, and that PostgreSQL 11+ allows `ADD COLUMN ... DEFAULT value NOT NULL` instantly when the default is constant (metadata-only change). Also mention that `pg_repack` exists for tables where bloat is a concern.

Follow-ups:
- What if the default value needs to be computed from other columns (non-constant)?
- How do you monitor replication lag during backfill, and what threshold triggers a pause?
- Walk through the exact same migration for MySQL 8 - what changes?

**Q: How do you handle data synchronization across microservices that each own their own database?**
A: The recommended approach is event-driven synchronization with the outbox pattern. When Service A updates data, it writes a change event to an outbox table in the same database transaction as the data change (atomic). A background worker reads the outbox and publishes events to a message broker (Kafka, etc.). Service B consumes these events and maintains a local projection of Service A's data. The projection uses idempotent upserts with a version field to handle out-of-order events. The local projection is eventually consistent - reads might lag by seconds, which is usually acceptable. For time-critical data, Service B can call Service A's API directly (and accept the coupling/latency).

**What FAANG expects:** The outbox pattern prevents the dual-write problem (write to DB + publish to Kafka fails half-way). Senior candidates contrast outbox with CDC (Debezium reading PostgreSQL WAL directly - no application code needed, but requires operational investment). They also mention idempotency keys, version fields for conflict resolution, the trade-off between per-service databases (pure) and logical schemas in one physical database (pragmatic at small scale), and that shared mutable schemas are a guaranteed production incident.

Follow-ups:
- Compare outbox pattern vs CDC (Debezium) - when would you pick each?
- What happens if the outbox worker crashes after publishing but before marking processed?
- How do you handle schema evolution of events (adding a field to `UserUpdated`)?

**Q: Describe the pros and cons of each approach to polymorphic associations.**
A: Three approaches: nullable foreign keys (one FK column per possible parent type, constrained to exactly one), generic foreign key (store parent type and ID as strings, no referential integrity), and abstract parent table (a shared parent table that both concrete types reference, with a FK from the child to the abstract parent). Nullable FKs have real referential integrity but require schema changes for new parent types. Generic FKs require no schema changes but orphan rows accumulate when parents are deleted. Abstract parent table gives real referential integrity and extensibility - adding a new parent type only requires adding a new concrete table that references the abstract parent. I prefer abstract parent table for new designs.

**What FAANG expects:** Generic polymorphic FKs (Rails' default `commentable_type`/`commentable_id`) are an anti-pattern at scale - interviewers want to hear this. Senior candidates know the abstract parent table pattern (sometimes called "exclusive arc" or "class table inheritance") and can sketch the DDL on a whiteboard. They also mention that PostgreSQL table inheritance is *not* the right tool here (it has indexing and constraint limitations).

Follow-ups:
- How would you migrate an existing system from generic polymorphic FKs to abstract parent table without downtime?
- What indexes do you need on the abstract parent table?
- How does this pattern interact with soft deletes on the parent types?

### Senior Level

**Q: Design a schema for a system that needs to track employee salary changes with the ability to answer: (1) What is Alice's current salary? (2) What was Alice's salary on a given past date? (3) What did we record as Alice's salary on that date (in case records were corrected)?**
A: This requires bi-temporal modeling. The schema has `valid_from`/`valid_to` (when the salary was effective in reality) and `recorded_at`/`recorded_until` (when this record existed in the database). To answer (1): WHERE employee_id = Alice AND valid_from <= today AND (valid_to IS NULL OR valid_to > today) AND recorded_until IS NULL. To answer (2): include `AND valid_from <= given_date AND (valid_to IS NULL OR valid_to > given_date)` and filter on the latest recorded_at for that date. To answer (3): `AND recorded_at <= given_date AND (recorded_until IS NULL OR recorded_until > given_date)`. Corrections are modeled by setting recorded_until on the old record and inserting a new record with the corrected data. The EXCLUDE USING GIST constraint prevents overlapping valid_time ranges for the same employee in current DB records.

**What FAANG expects:** Bi-temporal modeling is a senior-level skill that comes up in compliance-heavy domains (finance, healthcare, HR). Interviewers want to see the four timestamps clearly labeled (valid time vs transaction time), the EXCLUDE constraint using GiST with `daterange` to prevent overlaps, and an understanding that corrections never update rows - they append. Bonus points for mentioning SQL:2011 temporal tables, PostgreSQL's `tstzrange` + exclusion constraints, and that this pattern is what audit systems like Datomic use natively.

Follow-ups:
- How would you index this table for efficient point-in-time queries at 100M rows?
- What if the audit requirement is "who made each correction, with justification"?
- How do you handle retroactive salary changes that span multiple past records?

**Q: A product table has 50 million rows. A new business requirement needs a `category_path` column that stores the full hierarchical path (e.g., "Electronics > Phones > Smartphones"). How do you add this without downtime?**
A: Expand-and-contract. Phase 1: `ALTER TABLE products ADD COLUMN category_path text;` (instant in Postgres 11+ for nullable). Phase 2: Deploy code that writes `category_path` on new inserts/updates. Phase 3: Backfill in batches - iterate in batches of 1,000 using `WHERE category_path IS NULL ORDER BY id LIMIT 1000`, with 50ms pauses between batches. For 50 million rows at 1,000 rows/batch, this takes roughly 40 minutes if each batch takes 50ms - run this during low traffic. Use `FOR UPDATE SKIP LOCKED` to support parallel backfill workers safely. Phase 4: Add NOT VALID constraint, validate separately. Phase 5: `SET NOT NULL`. Add a GIN or B-tree index concurrently after the NOT NULL constraint. Monitor replication lag throughout.

**What FAANG expects:** Beyond the migration mechanics, senior candidates question the design: should `category_path` be stored denormalized at all? Alternatives include `ltree` (GiST-indexed path operations, atomic rename of ancestors via `ltree` subpath update) or a closure table joined at query time. If denormalized, how is it kept consistent when a category is renamed or moved? Options: trigger-based cascade update (simple but locks), application-layer dual-write, or CDC-driven reconciliation. Always name the consistency mechanism.

Follow-ups:
- A category is renamed. How do you update `category_path` on all affected products without a long lock?
- Would `ltree` be a better choice here than a denormalized `text` column? Why or why not?
- How do you validate that `category_path` stays consistent with the category hierarchy over time?

**Q: When would you choose ClickHouse over TimescaleDB, and when would you choose TimescaleDB over PostgreSQL with partitioning?**
A: PostgreSQL with partitioning is the starting point: no additional operational complexity, fully ACID, familiar tooling. It handles up to roughly 500 million rows before queries become noticeably slow even with partitioning. TimescaleDB adds automatic chunk management, compression policies, retention policies, and time-bucket query optimization on top of PostgreSQL. The data is still in PostgreSQL (so your existing tooling works), but writes are faster and chunk management is automatic. I'd choose TimescaleDB over raw PostgreSQL partitioning whenever time-series is a primary use case - the operational overhead is low and the benefits (compression, retention, continuous aggregates) are significant. ClickHouse is the choice when: dataset is in the billions to trillions of rows, the workload is overwhelmingly analytical reads (not transactional writes), you need sub-second response on GROUP BY across billions of rows, and you can accept weaker consistency guarantees. ClickHouse's columnar storage compresses dramatically better and executes analytical queries 10-100x faster than row-oriented databases. The trade-off: limited ACID support, no real UPDATE (use replace/version pattern), operational complexity, separate system to maintain.

**What FAANG expects:** Senior candidates articulate the decision in terms of workload characteristics: write volume (points/sec), query pattern (point lookups vs aggregations), retention window, and consistency requirements. They mention continuous aggregates in TimescaleDB (incrementally maintained materialized views), ClickHouse's `MergeTree` family of engines (SummingMergeTree, ReplacingMergeTree, AggregatingMergeTree) and when each applies, and that Druid/Pinot are alternatives for sub-second multi-dimensional OLAP. They also mention that many production systems use PostgreSQL + ClickHouse together - PostgreSQL for transactional data, CDC replicates to ClickHouse for analytics.

Follow-ups:
- How do TimescaleDB continuous aggregates differ from regular materialized views?
- When would you pick Druid or Pinot over ClickHouse?
- Describe the data flow for a system that needs both transactional updates and sub-second analytics on 10B events.

### Junior → FAANG: Interview Entry-Point for Data Modeling Rounds

The data modeling round is the round most juniors underprepare for because it feels "basic". It is not basic. It is the round where the interviewer decides whether you are an L3 who can execute a spec or an L4 who can own a schema. The difference between those two packets in April 2026 is roughly 40 percent of total comp. Treat this round with that weight.

Prerequisite gaps to close before the loop. You need to be able to sketch a primary key for any entity in under ten seconds without reaching for a surrogate by default. You need to know the difference between `bigint` and `uuid` and when each wins (bigint for insert throughput and index locality, UUIDv7 when you need client-generated IDs and want time-sortability). You need to recognize that `updated_at` without a trigger or an ORM hook is a lie because it only updates when the application remembers to. You need to have written at least one migration that failed on a table with more than a million rows so that the phrase "`ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock" means something visceral to you.

Worked example, "design the data model for a chat app". The junior answer is `users`, `messages`, `conversations`. The L4 answer adds: participants table because a conversation has many users and a user is in many conversations, ordering semantics (per-conversation monotonic sequence rather than global timestamp to avoid clock skew), read markers (per participant, pointing at the last seen sequence), soft delete on messages with a tombstone that preserves sequence, and the question "is this one-to-one, small-group, or large-broadcast" because the sharding strategy changes in each. If the interviewer says "large-broadcast like Twitch chat", the schema pivots entirely: no per-recipient storage, fan-out on read from an append-only log, aggressive retention. Articulating that pivot on the spot is what separates L3 from L4.

Worked example, "design the data model for an Instagram feed". The trap is to model `users`, `posts`, `follows`, and believe the feed is `SELECT * FROM posts WHERE user_id IN (SELECT followed_id FROM follows WHERE follower_id = me) ORDER BY created_at DESC LIMIT 50`. That query works for 10k users. It dies at 100M. The L4 answer introduces the fan-out decision: fan-out on write (precompute each follower's feed on post) for most users, fan-out on read (query at read time) for celebrity accounts above a follower threshold, and hybrid merge at read time. The data model becomes: `posts` (source of truth), `feed_entries` (per-user materialized feed, capped at N most recent), `celebrity_flags` on users, and a read-path that merges. That is one ladder rung of signal.

Worked example, "design the data model for ride-sharing". Entities: riders, drivers, rides, payments, driver locations. The L4 moment is recognizing that driver locations is a firehose and does not belong in the same store as rides. Locations go to a geospatial store (Redis with GEO or a dedicated geospatial DB) with short TTL. Rides go to OLTP. Payments go to a separate store with stricter consistency and audit. If you propose a single table for all four, you have capped yourself at L3.

Worked example, "design the data model for Uber Eats". Three entity clusters. Catalog (restaurants, menus, items) which is read-heavy and eventually consistent. Orders which is write-heavy and strongly consistent. Delivery state which is a firehose of driver location plus order status. The L4 insight is that catalog data does not live in the OLTP store that serves order writes, because catalog browsing traffic is 100x order traffic and would starve the write path. Catalog lives in a read-optimized projection fed by CDC from the canonical catalog store.

The "why did this fail?" reflex in interviews. When the interviewer proposes a schema and asks "what is wrong with this?", your default response should be to walk three failure modes out loud: concurrency (what happens with two writers), scale (what happens at 100x volume), and evolution (what happens when the schema needs to change). If you name those three dimensions, the interviewer will often hand you the angle they wanted you to probe.

Interview entry-point checklist. Five minutes before any modeling question ends. Restate the access patterns. Name the cardinality assumption. State the consistency model. Identify the hot key. Flag one thing you would want to benchmark before committing. Those five beats, in that order, lift a stumbling answer to a competent one.

### Senior @ FAANG: Staff and Principal Signal in Data Modeling Rounds

At L5 and above the interviewer is not checking whether you know normalization. They are checking whether you can run a schema review, negotiate a data contract across two orgs, and write an ADR that will survive five years of engineer turnover. The questions get vaguer on purpose because the signal lives in how you decompose ambiguity.

Interview signal ladder, L3 through L7, for the "design the data model for X" question.

- L3. Produces a reasonable 3NF schema. Names primary keys and foreign keys correctly. Misses scale considerations.
- L4. Identifies access patterns first. Picks keys based on queries. Names the indexes. Asks about read-to-write ratio.
- L5. Proposes a denormalization strategy with an explicit consistency mechanism. Separates OLTP from read-optimized projections. Names the CDC mechanism. Identifies the hot shard key risk.
- L6. Designs the migration path from the current state to the proposed state without downtime. Names the data contract with downstream consumers. Specifies the rollback plan. Proposes the schema review governance for ongoing evolution.
- L7. Frames the problem as a multi-year data platform investment. Weighs build versus buy. Discusses org-level impact, on-call cost, and the strategic decision of which datastore the organization will commit to operating. Names the one or two load-bearing decisions that cannot be reversed later.

Bar-raiser question one, migrate 3NF to query-first without downtime. The answer structure. Phase one, establish the CDC pipeline from the 3NF source to a staging projection. Phase two, build the query-shaped read model with idempotent consumers and version stamps. Phase three, dual-read from production with shadow traffic comparison, alerting on divergence above a defined threshold. Phase four, cut read traffic over behind a feature flag with a one-click rollback. Phase five, keep the 3NF source as the write path and deprecate direct reads against it over a 90-day window. The load-bearing detail is the shadow comparison. Skipping it turns the migration into a prayer.

Bar-raiser question two, event sourcing versus classic CRUD for a specific system. The staff-level answer names three yes-factors (regulatory audit, temporal query as first-class, multi-consumer projection) and three no-factors (unbounded event schema evolution, small team without event versioning discipline, storage cost of forever-retained events). Then apply to the specific system. Do not propose event sourcing as a default.

Bar-raiser question three, hierarchical data at 100M nodes. Structure the answer around four candidate structures (adjacency list, materialized path, nested sets, closure table) and one escape hatch (graph database). Name read cost, write cost, and move-subtree cost for each. Commit to one answer with a named threshold ("closure table up to 500M nodes at depth <= 20, graph store above that"). Refusal to commit is a downgrade signal.

Bar-raiser question four, bitemporal audit for compliance. Draw the four-timestamp schema. Name the exclusion constraint. Specify the "current truth" view. Walk through an example correction flow. Discuss storage growth and archival strategy. Discuss the query language problem (bitemporal SQL is hostile to write by hand, so the answer usually involves a small DSL or a repository layer).

Maturity model for interview self-assessment. If you cannot answer the bar-raiser questions above without notes, you are at L4 ceiling on data modeling regardless of your title. If you can answer them but cannot sketch the governance mechanism, you are at L5 ceiling. If you can answer them and sketch the governance but cannot name the organizational investment profile ("this requires two staff engineers for four quarters, a platform team buy-in, and a data contract migration across six consumer teams"), you are at L6 ceiling. L7 requires all three plus the ability to walk away from the proposal and pick a less ambitious path when the organization cannot absorb the investment.

ADR template for interview answers. When an interviewer asks "why this over that", structure a 90-second response in five beats. Context (what constraint forced the decision). Options considered (at least three). Decision (the choice). Consequences (what you lose by choosing this). Revisit trigger (what event would cause us to reopen the decision). That structure is the ADR template, compressed to a minute. Interviewers who sit on calibration committees recognize it immediately.

Governance question in the loop. "How would you prevent your team from shipping the data anti-patterns from section 37C.8?" The staff answer has four layers. CI lint rules as the floor. A schema review board for cross-team changes. A data contract registry with versioned artifacts. A maturity model roadmap with quarterly checkpoints. Name the cost of each layer. Name the org size where each becomes justified (lint at 10 engineers, board at 50, registry at 150, full roadmap at 500). That calibration is the signal.

Exercises with staff-level extensions that often appear as take-homes. Build a schema lint tool that parses migrations and flags nullable foreign keys without documented rationale. Design a data contract CLI that diffs schema versions and reports breaking changes against a declared contract. Write a postmortem for a real or hypothetical data-modeling mistake (polymorphic FK that caused a six-hour outage, EAV that caused a three-month migration, soft delete that caused a GDPR violation) with the five-whys, the preventative mechanism, and the detection signal that would have caught it earlier.

---
