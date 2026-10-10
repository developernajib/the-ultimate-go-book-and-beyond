## 37C.8 Data Modeling Anti-Patterns

### God Table

The "god table" is a single table that stores everything, distinguished by a `type` column:

```sql
-- Anti-pattern
CREATE TABLE entities (
    id           uuid PRIMARY KEY,
    type         text,          -- 'user', 'product', 'order', 'payment'
    field1       text,
    field2       text,
    field3       numeric,
    field4       timestamptz,
    field5       jsonb,
    -- ... 50 more generic fields
    created_at   timestamptz
);
```

Problems:
- Most columns are NULL for most rows (sparse, wasteful)
- No type-specific constraints or validations
- Query performance degrades as the table grows to billions of rows across all entity types
- Schema changes affect all entity types
- Impossible to understand from the schema alone

**Fix**: Separate tables per entity type.

### Status Field with 50 Values

Status columns start simple but grow unchecked over time. Without database-level enforcement, the set of valid values sprawls as different developers add ad-hoc statuses, creating an implicit state machine that no one fully understands.

```sql
-- This seems fine at 5 values
CREATE TABLE orders (
    id     uuid PRIMARY KEY,
    status text NOT NULL  -- 'pending', 'confirmed', 'processing', ...
);

-- 2 years later: 50 values, complex state machine, no enforcement
-- status can be: 'pending', 'pending_payment', 'awaiting_payment',
--                'payment_failed', 'payment_processing', 'payment_complete',
--                'confirmed', 'partially_confirmed', ...
```

**Fix**: Use PostgreSQL enum or a separate status transitions table:

```sql
-- Use an enum type for enforced values
CREATE TYPE order_status AS ENUM (
    'draft', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'canceled', 'refunded'
);

ALTER TABLE orders ADD COLUMN status order_status NOT NULL DEFAULT 'draft';

-- Adding new values (non-breaking, no table rewrite):
ALTER TYPE order_status ADD VALUE 'partially_refunded' AFTER 'refunded';
```

### String Everywhere

Storing every value as `text` eliminates the database's ability to validate, sort, and index data correctly. This pattern often appears in codebases where the schema was generated from a dynamic language without strong types, or where developers treated PostgreSQL as a key-value store.

```sql
-- Anti-pattern: everything is text
CREATE TABLE orders (
    id          text,           -- should be uuid
    user_id     text,           -- should be uuid with FK
    total       text,           -- should be numeric
    status      text,           -- should be enum
    is_express  text,           -- should be boolean
    created_at  text            -- should be timestamptz
);
```

Problems: No type validation, no referential integrity, terrible query performance (cannot use integer indexes), subtle bugs (`'2024-01-10' < '2024-01-9'` is true for text sort).

**Fix**: Use the right type for every column. PostgreSQL's type system is your first line of data validation.

### Missing Indexes

The most common performance anti-pattern:

```sql
-- Foreign keys without indexes - every join is a full table scan
CREATE TABLE order_items (
    id         uuid PRIMARY KEY,
    order_id   uuid REFERENCES orders(id),  -- missing index!
    product_id uuid REFERENCES products(id) -- missing index!
);

-- The query that kills production:
SELECT * FROM order_items WHERE order_id = $1;
-- Full table scan on millions of rows
```

**Fix**: Always index foreign keys. Use `pg_stat_user_indexes` and `pg_stat_user_tables` to find unused and missing indexes:

```sql
-- Find tables with sequential scans (potential missing indexes)
SELECT relname, seq_scan, idx_scan,
       seq_scan::float / NULLIF(seq_scan + idx_scan, 0) AS seq_ratio
FROM pg_stat_user_tables
WHERE seq_scan > 1000
ORDER BY seq_ratio DESC;

-- Find slow queries (requires pg_stat_statements)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 100  -- ms
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### JSONB When the Schema Is Known

JSONB is the right tool for *genuinely* variable attributes - a product catalog where each category has its own attribute set, user preferences that evolve rapidly, or third-party webhook payloads. It is the wrong tool when the fields are known, queried frequently, and stable. Storing `{"email": "...", "name": "...", "age": 34}` in a `user_data jsonb` column instead of typed columns sacrifices every database-level validation, breaks B-tree indexes on individual fields (you need expression indexes per queried path), loses referential integrity, and makes schema evolution harder not easier (renaming a JSONB key requires a rewrite, just like renaming a column).

```sql
-- Anti-pattern: known fields hidden inside JSONB
CREATE TABLE users (
    id        uuid PRIMARY KEY,
    user_data jsonb NOT NULL  -- contains email, name, created_at, is_active, ...
);

-- Every query now needs casts and expression indexes
SELECT * FROM users WHERE (user_data->>'email') = $1;
CREATE INDEX ON users ((user_data->>'email'));  -- per field!
```

**Fix**: Use typed columns for known fields. Use JSONB *only* for the genuinely variable tail.

```sql
CREATE TABLE users (
    id         uuid PRIMARY KEY,
    email      citext UNIQUE NOT NULL,
    name       text NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Only preferences are genuinely open-ended
    preferences jsonb NOT NULL DEFAULT '{}'
);
```

### Overusing EAV

The EAV (Entity-Attribute-Value) pattern - storing each attribute as its own row in a generic `(entity_id, attribute_name, value)` table - is the database equivalent of a `map[string]string` masquerading as a schema. It surfaces in systems that wanted "infinite flexibility" and ended up with queries that require N self-joins to reconstruct a single logical row, no type safety (everything is text), no referential integrity on attribute values, and optimizer plans that are consistently catastrophic. JSONB does everything EAV does with one-tenth the query complexity. The only remaining legitimate use of EAV is in systems that predate JSON type support and cannot be migrated.

### Circular Foreign Keys

Circular foreign keys occur when two tables each reference the other, creating a chicken-and-egg problem: neither row can be inserted first because each depends on the other already existing.

```sql
-- Circular dependency: teams.lead_id → users.id AND users.team_id → teams.id
CREATE TABLE teams (
    id      uuid PRIMARY KEY,
    name    text,
    lead_id uuid REFERENCES users(id)  -- team lead
);

CREATE TABLE users (
    id      uuid PRIMARY KEY,
    name    text,
    team_id uuid REFERENCES teams(id)  -- user's team
);

-- Problem: you can never INSERT either row first
-- Solution: make one FK deferrable or use a separate relationship table
```

**Fix**: Use a deferrable constraint or restructure the relationship:

```sql
-- Deferrable: constraint checked at transaction end, not statement end
ALTER TABLE teams
    ADD CONSTRAINT teams_lead_fk
    FOREIGN KEY (lead_id) REFERENCES users(id)
    DEFERRABLE INITIALLY DEFERRED;

-- Now you can insert in a transaction without constraint violations
BEGIN;
INSERT INTO teams (id, name) VALUES ('team-1', 'Engineering');
INSERT INTO users (id, name, team_id) VALUES ('user-1', 'Alice', 'team-1');
UPDATE teams SET lead_id = 'user-1' WHERE id = 'team-1';
COMMIT;  -- constraints checked here
```

### Anti-Pattern: Random UUIDv4 Primary Keys and B-Tree Page Fragmentation

Using random 128-bit UUIDv4 values as primary keys causes acute performance degradation once a table exceeds memory cache boundaries, as analyzed in production by [The Thread Whisperer (July 2026), "Stop Using UUIDv4 as Keys - UUIDv7 Cut Our Index Bloat 30%"](https://medium.com/@thethreadwhisperer/stop-using-uuidv4-as-keys-uuidv7-cut-our-index-bloat-30) and [Sarveshkhamkar (May 2026), "After 3 Years and 200M Rows, I Finally Stopped Using UUIDs as Primary Keys"](https://medium.com/@sarveshkhamkar/after-3-years-and-200m-rows-i-finally-stopped-using-uuids-as-primary-keys).

#### The Failure Mechanics

A PostgreSQL B-tree index orders entries continuously across 8KB leaf pages. When rows are inserted with incrementing IDs or time-ordered keys, new entries append neatly to the rightmost leaf page, maintaining a 90% to 95% leaf fill factor.

In contrast, a UUIDv4 key is uniformly random across the entire 128-bit address space. Every insert targets a random leaf page in the tree:
1. **Frequent Page Splits**: When an 8KB index leaf page fills up, PostgreSQL splits it into two half-empty pages (50% fill factor) to accommodate the random insert.
2. **Buffer Pool Eviction**: As tables scale into tens or hundreds of millions of rows (200M+), the B-tree index exceeds available `shared_buffers` RAM. Every random insertion forces the database engine to perform random disk I/O reads to pull cold index leaf pages into RAM, immediately evicting active cache lines.
3. **Write Amplification & Bloat**: Indexes consume 30% to 40% more disk space than necessary, and background `VACUUM` operations must scan scattered dead tuples across the entire address space rather than contiguous time-windowed clusters.

#### The Production Solution: UUIDv7

RFC 9562 formalizes UUIDv7, which combines a 48-bit millisecond Unix timestamp with 74 bits of cryptographically secure random entropy and 6 version/variant bits.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           unix_ts_ms                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          unix_ts_ms           |  ver  |       rand_a          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|var|                        rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            rand_b                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Empirical production measurements on an 11-million row dataset demonstrated:
- **31% reduction in total primary key index footprint** due to contiguous leaf fills.
- **20% drop in write latency** under high concurrency by eliminating 50/50 page splits.
- **Cache Locality**: Warm buffer pool pages consistently service recent records.

#### Zero-Allocation Go Implementation

In Go services, UUIDv7 can be generated without third-party dependencies using the standard library:

```go
package identity

import (
	"crypto/rand"
	"fmt"
	"io"
	"time"
)

type UUID [16]byte

// NewV7 generates a monotonically time-ordered UUIDv7 conforming to RFC 9562.
func NewV7() (UUID, error) {
	var u UUID
	_, err := io.ReadFull(rand.Reader, u[6:])
	if err != nil {
		return u, fmt.Errorf("reading random bytes: %w", err)
	}

	// 48-bit millisecond timestamp
	ms := uint64(time.Now().UnixMilli())
	u[0] = byte(ms >> 40)
	u[1] = byte(ms >> 32)
	u[2] = byte(ms >> 24)
	u[3] = byte(ms >> 16)
	u[4] = byte(ms >> 8)
	u[5] = byte(ms)

	// Version 7: set bits 4-7 of byte 6 to 0111
	u[6] = (u[6] & 0x0f) | 0x70
	// Variant 1: set bits 6-7 of byte 8 to 10
	u[8] = (u[8] & 0x3f) | 0x80

	return u, nil
}

func (u UUID) String() string {
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		u[0:4], u[4:6], u[6:8], u[8:10], u[10:16])
}
```

*Security Tradeoff*: Because the upper 48 bits encode the creation millisecond, UUIDv7 reveals the approximate generation timestamp and operational creation velocity. For public-facing IDs where creation rate must remain confidential, generate an opaque public identifier or random slug while retaining UUIDv7 internally for database indexing performance.

### Junior → FAANG: Anti-Pattern Recognition as a First-Job Reflex

If you are joining your first backend team in April 2026, the interview signal that separates L3 from L4 is not knowing normal forms by heart. It is the reflex of asking "why did this fail?" the moment you see a schema smell. The anti-patterns above each have a failure mode that shipped somebody a pager at 3 AM, and the junior who can articulate that failure mode out loud is the junior who gets offers.

Prerequisite gap most juniors have. You were taught `CREATE TABLE` but never taught what a `NULL` actually costs. A nullable foreign key on a hot path means every reader has to branch on "is it set, is it valid, is it dangling because the referenced row was soft-deleted, is it sentinel-meaning-something?". Four meanings collapsed into one tri-state. The rule to internalize: every `NULL`-able column needs a sentence in the PR description explaining what `NULL` means semantically. If you cannot write that sentence, the column should be `NOT NULL` with a default, or split into a separate table.

Worked example, the polymorphic foreign key. You are asked to let `comments` reference either a `post`, a `photo`, or a `video`. The tempting first draft:

```sql
CREATE TABLE comments (
    id           uuid PRIMARY KEY,
    parent_id    uuid NOT NULL,
    parent_type  text NOT NULL,  -- 'post' | 'photo' | 'video'
    body         text NOT NULL
);
```

Why this fails. No foreign key constraint can point at `parent_id` because the referenced table is dynamic. A `post` deletion will silently leave orphan comments. A typo in `parent_type` ships to prod and no constraint catches it. Queries that join comments to their parents need a `CASE` expression and the planner cannot use an index-only path. The fix at junior level is a comment table per parent type, or a `commentable` table that every parentable entity inserts into and that `comments` foreign-keys to. The fix at senior level involves a check constraint that validates `parent_type` against a whitelist and a trigger that enforces referential integrity across the union, but you need the junior fix in your pocket first.

First-job context, the "string-concat key" trap. You will inherit a table where the primary key is something like `user_id || '_' || tenant_id || '_' || '2026-04'`. The previous engineer thought this was clever because it "encodes everything in the key". It is a disaster. You cannot index the components independently. You cannot cascade-update one component. You cannot type-check the parts. And when marketing asks "how many rows for tenant X in April", you are doing `LIKE '%_tenant-x_%'` which is a sequential scan. The junior fix is a composite primary key `(user_id, tenant_id, period)` with each part its own typed column. Say that out loud in the interview.

The "why did this fail?" reflex, applied to Boolean flag accumulation. You see a table with `is_active`, `is_verified`, `is_premium`, `is_deleted`, `is_suspended`, `is_shadow_banned`, `is_trial`, `is_legacy`. Eight Booleans is 256 states. Most combinations are illegal. Nobody documented which. The failure mode is that somebody flips `is_deleted = true` but forgets to flip `is_active = false`, and the user keeps receiving notifications after they closed their account. The fix is a single `status` enum plus a state transition table, not more Booleans.

Interview entry-point, the 15-minute loop. When an interviewer says "design the data model for X", the junior approach is to jump to tables. The better approach is five minutes of anti-pattern inoculation first: "Before I draw tables, let me state what I will not do. I will not use polymorphic FKs without a discriminator table. I will not store timestamps without a timezone. I will not use `text` for values that have a constrained domain. I will not accumulate Booleans. With that out of the way, here are my entities." That preamble buys you a full letter grade of signal before you have drawn a single ERD box.

### Senior @ FAANG: Anti-Patterns as an Organizational Maturity Problem

At staff and principal level in April 2026, anti-patterns are no longer individual mistakes. They are organizational entropy. Every anti-pattern in this section exists at scale because some team had a deadline, some PR got rubber-stamped, some schema review board either did not exist or did not have teeth. Your job is not to spot bad schemas. Your job is to build the mechanism that prevents bad schemas from reaching production.

ADR template for schema changes. Every non-trivial schema change at L6+ should land with an Architecture Decision Record that answers eight questions. What is the access pattern this change enables? What is the write amplification and read amplification? What is the rollback plan if this migration corrupts data? Which consumer contracts break? What is the blast radius if we choose the wrong cardinality? Does this introduce a new hot shard key? What is the query-per-second budget we are committing to? Who owns this table and what is the SLA for schema-change reviews? An ADR without those eight sections is not ready for review. The ADR is the artifact that survives the engineer who wrote it.

Maturity model L1 through L5 for data modeling.

- L1 Ad hoc. Engineers create tables in shared databases with no review. Columns appear via ORM auto-migrate. No one owns any table. Every query is a full scan waiting to happen. This is where most startups live until the first outage.
- L2 Reviewed. Schema changes go through pull requests. A senior engineer looks at them. No tooling enforces anything. Reviewers rely on memory and vibe.
- L3 Linted. A schema lint tool runs in CI. It flags nullable FKs, missing indexes on FKs, `text` columns that should be `citext` or enums, tables without `created_at`/`updated_at`, timestamps without timezone, primary keys that are not UUID or bigint. The lint tool is the floor, not the ceiling.
- L4 Contracted. Every table has a declared owner, a declared consumer set, and a declared SLA. Breaking changes require a deprecation window. A schema review board meets weekly for changes that cross team boundaries. Data contracts are versioned artifacts in a registry.
- L5 Self-service with lineage. Engineers propose schema changes through a platform that automatically computes downstream lineage, runs impact analysis against every consuming pipeline, proposes a migration path, and routes the change to the right approvers. Lineage is machine-readable. Governance is a platform, not a meeting.

Most FAANG data infrastructure organizations in April 2026 sit at L3 on OLTP and L4 on warehouse. Moving OLTP from L3 to L4 is the single most useful staff project available because every downstream pipeline depends on it.

Governance, the schema review board. A working board has five properties. It has a charter that lists which changes require review and which do not (rule of thumb: anything touching a table with more than ten consumers, or any table in the top-100 by QPS). It has a rotating chair so that no single person bottlenecks. It has a documented decision log so that "why did we pick bigint over UUID for this table in 2024" is answerable in 2026. It has an escape hatch for incident-driven changes with a mandatory retro. And it publishes a weekly digest so that non-members can see what is changing.

Data contract SLA template. A contract for a table exposed to consumers specifies: schema stability window (minimum 90 days between breaking changes), freshness SLO (p95 replication lag under 30 seconds), completeness SLO (no more than 0.01 percent missing rows per day), dual-write guarantee during migration windows, deprecation notice period (minimum 180 days for cross-org consumers), and on-call rotation for contract violations. Contracts without SLAs are wishes.

Bar-raiser question, migrating 3NF to query-first. A healthy OLTP schema is 3NF. A scaled read path at 100k QPS is query-first, often denormalized, frequently duplicated across a materialized read-store. The staff-level answer is not "denormalize everything". It is: keep 3NF as the source of truth, emit change events via logical replication or CDC, project those events into query-shaped read models with idempotent consumers, version each read model independently, and own the consistency model explicitly (read-your-writes via sticky routing, or eventual with a bounded lag SLO). The ADR documents the bounded-staleness guarantee and the consumer behavior when the lag SLO is breached.

Bar-raiser question, event-sourcing versus classic CRUD. Event sourcing earns its complexity in three situations. Regulatory audit requirements where every state transition must be provable. Temporal queries where "what did the system look like at time T" is a first-class use case. Multi-consumer projection where the same stream feeds analytics, search, ML features, and operational UI. Outside those three, classic CRUD with an append-only audit log is the right answer. The staff-level failure mode is picking event sourcing for its novelty and then discovering that the team does not have the discipline to evolve event schemas across five years of archived events. Events are forever. Columns are not. Pick accordingly.

Bar-raiser question, hierarchical data at 100M nodes. Adjacency list breaks at read time (recursive CTEs are linear in depth). Nested sets break at write time (every insert rewrites half the tree). Materialized path is acceptable if depth is bounded and paths are short. Closure table is the general-purpose answer at 100M nodes, with the understanding that it is `O(depth^2)` space. The truly scalable answer when depth is unbounded and writes are hot is a graph store (Neptune, Dgraph, a custom RocksDB layer) with the relational system kept as a projection for reporting. Name the tradeoff, do not pretend one answer covers all cases.

Bar-raiser question, bitemporal audit for compliance. Regulated systems need two time axes. Valid time (when was this fact true in the real world) and transaction time (when did the system learn about it). A single `updated_at` gives you neither. The staff-level schema pattern is a history table with `(valid_from, valid_to, transaction_from, transaction_to)` and a view that exposes "current truth" as the filter where both `valid_to` and `transaction_to` are infinity. Compliance queries like "what did we believe about customer X on date D, as of knowledge date K" then become exact range predicates. Most teams fake this with an `audit_log` JSONB column and it collapses the first time legal asks a bitemporal question.

Interview signal ladder on anti-patterns, L3 through L7.

- L3. Recognizes specific anti-patterns when named. Can fix `text` columns and missing FK indexes.
- L4. Spots anti-patterns unprompted during design. Articulates the failure mode in terms of query plans.
- L5. Proposes preventative tooling. Writes the lint rule, not just the fix. Understands migration cost of retrofitting.
- L6. Designs the schema review process. Weighs organizational cost of governance against entropy cost of no governance. Knows when to skip a board for velocity.
- L7. Owns the maturity model roadmap across the organization. Negotiates data contract SLAs with peer-org VPs. Decides when to invest in a self-service platform versus extending the review board.

If you cannot place yourself on that ladder honestly, you are not ready for the level you are interviewing for. Calibrate first, then practice the level above.

---
