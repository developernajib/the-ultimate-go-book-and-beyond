## PostgreSQL Advanced Features Architecture

This architectural overview shows how PostgreSQL-specific capabilities (JSONB storage, native arrays, full-text search, and change notifications) layer on top of the standard relational foundation. Choosing the right feature for each use case avoids unnecessary complexity while taking full advantage of the database engine's strengths.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                      PostgreSQL Advanced Features                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │                        Application Layer (Go)                         │    │
│  │                                                                       │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │    │
│  │  │   Search    │  │  Analytics  │  │   Events    │  │    Locks    │   │    │
│  │  │   Service   │  │   Service   │  │   Handler   │  │   Manager   │   │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │    │
│  │         │                │                │                │          │    │
│  └─────────┼────────────────┼────────────────┼────────────────┼──────────┘    │
│            │                │                │                │               │
│  ┌─────────┴────────────────┴────────────────┴────────────────┴──────────┐    │
│  │                        pgx Connection Pool                            │    │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Binary Protocol │ Type Registration │ Batch Operations         │  │    │
│  │  └─────────────────────────────────────────────────────────────────┘  │    │
│  └───────────────────────────────┬───────────────────────────────────────┘    │
│                                  │                                            │
│  ┌───────────────────────────────┴───────────────────────────────────────┐    │
│  │                      PostgreSQL Features                              │    │
│  │                                                                       │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │    │
│  │  │    JSONB     │  │  Full-Text   │  │   Window     │                 │    │
│  │  │   Storage    │  │   Search     │  │  Functions   │                 │    │
│  │  │              │  │              │  │              │                 │    │
│  │  │ • Indexing   │  │ • tsvector   │  │ • ROW_NUMBER │                 │    │
│  │  │ • Operators  │  │ • GIN Index  │  │ • RANK       │                 │    │
│  │  │ • Functions  │  │ • Ranking    │  │ • LAG/LEAD   │                 │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                 │    │
│  │                                                                       │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │    │
│  │  │    CTEs &    │  │   LISTEN/    │  │  Advisory    │                 │    │
│  │  │  Recursive   │  │   NOTIFY     │  │   Locks      │                 │    │
│  │  │              │  │              │  │              │                 │    │
│  │  │ • WITH       │  │ • Pub/Sub    │  │ • Session    │                 │    │
│  │  │ • Recursion  │  │ • Real-time  │  │ • Xact       │                 │    │
│  │  │ • Hierarchy  │  │ • Triggers   │  │ • Try/Wait   │                 │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                 │    │
│  │                                                                       │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘

JSONB Query Patterns:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  JSON Document: {"user": {"name": "Alice", "tags": ["go", "postgres"]}}      │
│                                                                              │
│  Access Operators:                                                           │
│  ┌──────────────┬─────────────────────┬──────────────────────────────────┐   │
│  │  Operator    │  Description        │  Example                         │   │
│  ├──────────────┼─────────────────────┼──────────────────────────────────┤   │
│  │  ->          │  Get JSON object    │  data->'user' → {"name":"Alice"} │   │
│  │  ->>         │  Get as text        │  data->>'user' → {"name":"Alice"}│   │
│  │  #>          │  Path to JSON       │  data#>'{user,name}' → "Alice"   │   │
│  │  #>>         │  Path to text       │  data#>>'{user,name}' → Alice    │   │
│  │  @>          │  Contains           │  data @> '{"user":{}}' → true    │   │
│  │  ?           │  Key exists         │  data->'user' ? 'name' → true    │   │
│  │  ?|          │  Any key exists     │  data ? | array['a','b']         │   │
│  │  ?&          │  All keys exist     │  data ? & array['a','b']         │   │
│  └──────────────┴─────────────────────┴──────────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Full-Text Search Pipeline:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   Document Text                                                              │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                        │
│   │  to_tsvector()  │ → Parse & normalize text                               │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │    Tokenize     │ → Split into lexemes                                   │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │   Stem Words    │ → "running" → "run"                                    │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │  Remove Stop    │ → Remove "the", "is", "a"                              │
│   │     Words       │                                                        │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │  Store Vector   │ → 'run':1 'fast':2 'dog':3                             │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │   GIN Index     │ → Fast search over lexemes                             │
│   └─────────────────┘                                                        │
│                                                                              │
│   Search Query: "running dogs"                                               │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────┐                                                        │
│   │ plainto_tsquery │ → 'run' & 'dog'                                        │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │  @@ operator    │ → Match against tsvector                               │
│   └────────┬────────┘                                                        │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                        │
│   │   ts_rank()     │ → Calculate relevance score                            │
│   └─────────────────┘                                                        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

LISTEN/NOTIFY Architecture:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   ┌──────────────┐    NOTIFY 'events'    ┌──────────────────────────────┐    │
│   │  Publisher   │ ──────────────────────►│       PostgreSQL            │    │
│   │  Service     │                        │                              │   │
│   └──────────────┘                        │   ┌────────────────────┐    │    │
│                                           │   │  Channel: events   │    │    │
│   ┌──────────────┐    NOTIFY 'events'    │   │  Payload: {...}    │    │     │
│   │  Publisher   │ ──────────────────────►│   └────────────────────┘    │    │
│   │  Service 2   │                        │              │              │    │
│   └──────────────┘                        └──────────────┼──────────────┘    │
│                                                          │                   │
│              ┌───────────────────────────────────────────┘                   │
│              │                                                               │
│              ▼                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐    │
│   │                     Subscriber Pool                                 │    │
│   │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐         │    │
│   │  │Subscriber │  │Subscriber │  │Subscriber │  │Subscriber │  ...    │    │
│   │  │  (conn)   │  │  (conn)   │  │  (conn)   │  │  (conn)   │         │    │
│   │  │ LISTEN    │  │ LISTEN    │  │ LISTEN    │  │ LISTEN    │         │    │
│   │  │ 'events'  │  │ 'events'  │  │ 'orders'  │  │ 'orders'  │         │    │
│   │  └───────────┘  └───────────┘  └───────────┘  └───────────┘         │    │
│   └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Architecture Diagram Like a Reviewer

The diagram above looks like it says "pgx sits above Postgres features." A reviewer reads it differently. Every box in the Postgres Features layer is a decision point where you either pick that feature or justify picking something outside Postgres. The JSONB box implicitly says "we chose Postgres document storage over Mongo/Firestore." The Full-Text Search box implicitly says "we chose `tsvector` over Elasticsearch/OpenSearch." The LISTEN/NOTIFY box implicitly says "we chose Postgres pub/sub over Kafka/NATS/Redis Streams." Each of these is a real architectural choice with tradeoffs, not a freebie.

The JSONB operator table is the most interview-relevant section in this chapter for a junior. You will be asked to write a query that finds all rows where a JSONB column contains a specific key-value pair. The idiomatic answer uses `@>` (containment) not `->>` equality, because `@>` is indexable by GIN with `jsonb_path_ops` and `->>` is not (without an expression index). Writing `WHERE data->>'status' = 'active'` when you could write `WHERE data @> '{"status":"active"}'` is the kind of mistake that shows up in a code review comment within hours, and knowing the difference before you hit the reviewer is what separates a passing from a failing first-month internship output.

The FTS pipeline shows the normalization stages. What it does not show is that every one of those stages is governed by a `regconfig` (language configuration), and choosing the wrong one silently destroys your search quality. A junior who stores `to_tsvector('english', description)` for a product description written in German will get unindexed German words mingled with incorrectly-stemmed English lexemes. The fix is a per-document `language` column feeding into `to_tsvector(lang::regconfig, description)`, usually as a stored generated column.

Worked example for the LISTEN/NOTIFY box. A publisher transactionally updates a row and calls `pg_notify('events', payload)`. The payload must be under 8000 bytes. The subscriber receives the notification on a dedicated long-lived connection. The trap juniors fall into is using a pooled connection to LISTEN, which means the LISTEN is attached to whatever connection the pool hands back, and the next query from another goroutine on a different connection does not see it. The correct pattern is `pool.Acquire` plus never release, or a dedicated `pgx.Conn` outside the pool, with a reconnect loop on error.

### Senior @ FAANG: The Architecture is a Defense, Not a Picture

Staff-level reading of this diagram is as a defense of a consolidated datastore. You should be able to walk any skeptical reviewer through each box and answer: what is the throughput ceiling, what is the latency floor, what is the reversal trigger. The concrete numbers from production observations at 2026 Postgres 17/18 scale.

JSONB storage. Single-row read p99 for a JSONB column under 2KB after TOAST inlining is in the sub-millisecond range with GIN `jsonb_path_ops` on containment queries. Above 2KB the value is TOASTed and detoast cost is visible. LZ4 is available as an opt-in TOAST compression from PG14 (though `pglz` stays the built-in default) and handles JSON well when enabled (roughly 3x compression ratios). The failure modes to watch: (1) deep key recursion with `jsonb_ops` blowing up index size to 5x the table size, (2) JSONB columns mutated on every request causing HOT-update failures and index write amplification, (3) array-of-object patterns where queries actually want a join table. Reversal trigger: any single JSONB column over 8KB average or updated more than once per second on hot rows.

`jsonb_path_ops` vs default `jsonb_ops` is the single most misunderstood JSONB choice. `jsonb_ops` indexes every key and every value separately, supporting `?`, `?|`, `?&`, and `@>`. `jsonb_path_ops` indexes only key paths plus values, supporting only `@>` but with an index that is typically 3x smaller and 2x faster on containment queries. If your workload is 95% containment (which it almost always is for document filtering), `jsonb_path_ops` is the right default. You pay the cost once, at index decision time, and it is the cheapest 2x wins in Postgres tuning.

FTS. `tsvector` with a GIN index scales to tens of millions of documents with sub-100ms p99 on typical keyword queries. The failure modes: (1) `fastupdate = on` (default) accumulates a pending list that slows down queries until VACUUM merges it, so set `fastupdate = off` for read-heavy indexes, (2) phrase queries with `<->` distance operators do not use the GIN index efficiently, (3) ranking (`ts_rank`, `ts_rank_cd`) is not indexable and requires a recheck, so do your filtering first, rank last. For fuzzy matching and typo tolerance, `pg_trgm` with GIN is the right extension, not a bolt-on to `tsvector`. The hybrid pattern for RAG workloads is `tsvector` for keyword recall, `pgvector` HNSW for semantic recall, then fuse with reciprocal rank fusion (RRF) in SQL. That pattern is the FAANG-default answer in 2026 system design for small to mid corpus retrieval.

LISTEN/NOTIFY vs logical replication. NOTIFY is best-effort fire-and-forget with an 8KB payload cap, delivered only to currently-connected listeners. It is never the correct primitive for an event log. The correct durable pattern is a transactional outbox table plus logical replication via `pgoutput` consumed through `pglogrepl` in Go, which gives ordered, persistent, replayable delivery. NOTIFY's legitimate use is a low-latency wakeup to signal "new row in outbox, poll now" so your outbox consumer does not need to poll aggressively. That reduces p50 event latency to the low tens of milliseconds without giving up durability.

Advisory locks. Session-level advisory locks survive across transactions on the same connection. Transaction-level advisory locks release at commit/rollback. In pgxpool the trap is that "same connection" means "same pooled conn handle" and returning the conn to the pool does not release a session lock, which can leak across requests. The safer default is transaction-level advisory locks (`pg_advisory_xact_lock`) because they release automatically. For any cross-process coordination beyond idempotent leader election, add a fencing token column and validate it on every write, because advisory locks do not protect you against a stale lock holder after a failover.

Staff ADR checklist for this architecture. For each box: what fails today without it (the null hypothesis), what the next tier of scale looks like, what single metric triggers migration, who owns the migration runbook. Without that grid, the architecture diagram is decoration.

---
