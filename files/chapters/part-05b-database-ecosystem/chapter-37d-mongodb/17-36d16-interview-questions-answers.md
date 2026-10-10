## 37D.16 Interview Questions & Answers

**Q1: When would you choose MongoDB over PostgreSQL?**

A: Choose MongoDB when: (1) schema is highly variable or evolving rapidly - different record types need different fields. (2) you're storing deeply nested objects that are always read/written together. (3) horizontal write scaling is required beyond what Postgres can provide with partitioning. (4) you need flexible document querying without complex JOIN chains. Choose PostgreSQL when: you need strong ACID transactions across multiple tables, complex reporting with arbitrary JOINs, or when your data is naturally relational with clear foreign key relationships. Note that Postgres' `jsonb` closes some of the flexibility gap but does not match MongoDB on horizontal sharding or aggregation pipeline composition, and MongoDB closed most of the transaction gap in 4.0+.

**What FAANG expects:** a decision grounded in access patterns and cardinality, not opinion. Senior candidates are expected to probe the workload before recommending either database, and to reject premature "MongoDB is web-scale" or "Postgres can do everything with jsonb" framings. Knowing the licensing posture (SSPL vs. PostgreSQL License) is a plus for architecture interviews.

*Follow-ups:*
- Your colleague says "we'll use Postgres jsonb and get document flexibility for free." What are the operational differences at 500 GB and 10 TB?
- Walk me through a hybrid where Postgres holds the system of record and MongoDB powers a denormalized read model synced via CDC.
- When would you pick neither and reach for a columnar store or a key-value store instead?

**Q2: Explain the CAP theorem in context of MongoDB.**

A: MongoDB replica sets prioritize Consistency and Partition tolerance (CP). During network partition, MongoDB will stop accepting writes if it can't reach a majority of nodes (preventing split-brain/divergent data). With `w: majority` write concern, you won't read your own writes until majority acknowledges - this ensures consistency. MongoDB Atlas Global Clusters can be configured for eventual consistency reads from other regions for lower latency, trading C for A. The more precise framing is PACELC: under a Partition, MongoDB chooses Consistency (PC), and Else (normal operation), you can tune the read/write concern to trade latency for consistency (EL or EC).

**What FAANG expects:** Fluency with PACELC (not just CAP), awareness that write concern and read concern are independent dials, and the ability to draw the actual acknowledgment path across primary and secondaries for `w:majority` + `readConcern:majority`.

*Follow-ups:*
- A secondary lags by 30 seconds. With `readPreference:secondaryPreferred`, what anomalies can a user observe in the UI, and how do you mitigate them?
- Why does `w:majority` not, by itself, give you read-your-writes? What does?
- Compare linearisable read concern to majority and explain when the 10x latency penalty is worth it.

**Q3: How does MongoDB handle transactions? What are the limitations?**

A: MongoDB 4.0+ supports multi-document ACID transactions using snapshot isolation. Transactions work across collections, databases, and shards (4.2+). Limitations: (1) performance overhead - transactions hold locks and consume oplog space. (2) 60-second default timeout (`transactionLifetimeLimitSeconds`). (3) transactions can't create collections or indexes (with narrow exceptions in recent versions). (4) in sharded clusters, transactions require two-phase commit which adds latency. (5) require a replica set or sharded cluster - standalone `mongod` cannot start a transaction. (6) not a replacement for proper schema design - if you need transactions constantly, your data model might need revision toward embedding.

**What FAANG expects:** the candidate reaches for single-document atomic operations (`FindOneAndUpdate`, `$inc`) first and uses multi-doc transactions only when the invariant truly spans documents. They also know to retry on `TransientTransactionError` and `UnknownTransactionCommitResult` and never hold a transaction across network I/O.

*Follow-ups:*
- Your transaction callback does a HTTP call to a payment processor. Why is this an anti-pattern and how do you refactor?
- What is the difference between `TransientTransactionError` and `UnknownTransactionCommitResult`, and how does driver retry logic treat each?
- How would you implement a transfer-funds API with idempotency keys so retries never double-debit?

**Q4: How would you design a schema for a social media feed?**

A: Use the **fan-out on read** vs **fan-out on write** pattern choice:
- Fan-out on write: when user posts, write post reference to each follower's feed collection. Reads are fast (indexed by userId + timestamp), but high write amplification for users with millions of followers.
- Fan-out on read: store posts in one collection, aggregate at read time by fetching posts from all followed users. Works for users with few follows, but O(followed_users) queries per feed load.
- Hybrid: fan-out on write for normal users (<1000 followers), fan-out on read for celebrities. Feed document: `{userId, postId, authorId, createdAt}` with TTL to auto-expire old feed items.

**What FAANG expects:** Twitter's actual "timeline service" architecture: precomputed timelines for ordinary users, pulled merges for celebrity sources. Candidates should also size the write-amplification math aloud ("10M followers x 100 posts/day = 1B inserts/day") and acknowledge Redis / fan-out infrastructure rather than pretending MongoDB alone solves it.

*Follow-ups:*
- A celebrity gains 20M followers overnight. Walk me through the hot-spotting risk and the capacity plan.
- How do you bound storage for each user's feed collection, and how do you evict old entries?
- A user unfollows someone at 12:00. By what time must entries from that author disappear from their feed, and how do you implement the guarantee?

**Q5: What is the difference between $lookup and manual application-side joins?**

A: `$lookup` executes the join server-side in a single round-trip, using indexes on the foreign collection and reducing network overhead. Manual joins require multiple round-trips (N+1 problem) - one query for parents, then N queries for related documents. Use `$lookup` when you need to join frequently. However, if the related collection is tiny and changes rarely (e.g., country codes, category tables), cache it in application memory and do the join in Go - this avoids `$lookup` overhead and allows caching. In sharded clusters, `$lookup` against a sharded foreign collection is supported from 5.1 onwards but with performance considerations.

**What FAANG expects:** awareness that `$lookup` is not free - it streams documents from the foreign collection through the pipeline and can blow up working-set memory if the foreign collection is large or the match is unselective. Seniors reach for the Extended Reference pattern (denormalize read-time fields) before defaulting to `$lookup`.

*Follow-ups:*
- The foreign collection has 500M documents. What index must exist, and what happens if it does not?
- When would you replace `$lookup` with an application-level BatchGet, and how would you batch?
- Compare `$lookup` with a sub-pipeline (5.0+) against the simple form - when is the sub-pipeline worth the extra syntax?

**Q6: How do you prevent hotspot shards?**

A: (1) Use hashed shard keys for write-heavy collections - distributes writes evenly. (2) Avoid monotonic shard keys (ObjectID, timestamps) that cause sequential writes to one shard. (3) Use compound shard keys `{tenantId: 1, createdAt: 1}` to distribute within a tenant while keeping tenant data co-located. (4) Monitor chunk distribution with `db.collection.getShardDistribution()` and trigger manual balancing if needed. (5) Since 5.0 you can `reshardCollection` online, but it is an expensive operation, so get the key right first.

**What FAANG expects:** the ESR-equivalent for shard keys: **high cardinality + even distribution + query targeting**. Candidates should identify that a shard key distributing writes perfectly but forcing scatter-gather reads is usually a worse choice than a slightly less-even key that keeps queries single-shard.

*Follow-ups:*
- Your shard key is `{user_id: "hashed"}`. A feature requires "latest 100 events across all users ordered by time" - how does this query execute?
- What is the jumbo chunk problem and how do you remediate it?
- Walk me through live resharding from `{_id: "hashed"}` to `{tenant_id: 1, _id: 1}` for a 5 TB collection.

**Q7: Explain change streams and their use cases.**

A: Change streams use MongoDB's replication oplog to stream real-time document changes. Use cases: (1) event-driven microservices - replace polling with push notifications. (2) cache invalidation - update Redis when MongoDB changes. (3) audit logging - capture every change for compliance. (4) real-time dashboards - stream metrics to WebSocket clients. (5) CDC pipeline - replicate MongoDB to data warehouse or Kafka. Resume tokens enable at-least-once delivery with exactly-once processing achieved by idempotent handlers keyed on `_id` + `clusterTime`.

**What FAANG expects:** the candidate knows delivery is at-least-once, not exactly-once, and designs the consumer accordingly (idempotent handler, dedup cache, or outbox pattern). They persist the resume token *after* processing, not before, and understand the oplog retention window is a hard deadline for lagging consumers.

*Follow-ups:*
- Your change-stream consumer crashes and loses its in-memory resume token. How do you guarantee no events are dropped?
- A high-priority event gets stuck behind a slow handler. How do you prevent head-of-line blocking?
- Compare change streams to Debezium CDC against MongoDB - when would you pick one over the other?

**Q8: How does WiredTiger's cache eviction work?**

A: WiredTiger uses an LRU-like eviction policy. Cache defaults to 50% of (RAM - 1 GB) or 256 MB, whichever is larger. Pages are evicted when cache reaches 80% occupancy (eviction server kicks in) or 95% (application threads forced to help evict, latency spikes). B-tree pages that are dirty (modified but not checkpointed) must be reconciled before eviction. Checkpoint happens every 60 seconds, writing all dirty pages to disk. If cache fills up faster than eviction (write storm), operations may block - monitor `wiredTiger.cache.pages evicted by application threads` and `wiredTiger.cache.bytes currently in the cache` metrics.

**What FAANG expects:** the candidate knows eviction is a background process that can become foreground under pressure, and correlates that transition to user-visible latency. They recognize that cache tuning is rarely the right first lever - working-set reduction via indexes and projection usually dominates.

*Follow-ups:*
- Your p99 write latency just jumped from 5 ms to 200 ms. Which WiredTiger metrics do you inspect first and in what order?
- How does the `wiredTigerCache.size` tunable interact with the OS page cache? Why is oversubscribing dangerous?
- Describe how a long-running aggregation with `allowDiskUse: false` interacts with cache pressure.

**Q9: What is the oplog and how large should it be?**

A: The oplog (operations log) is a capped collection in the `local` database that records all write operations for replication. Secondaries tail the oplog to replicate changes. Size determines replication window - if a secondary is offline longer than the window, it needs initial sync. Rule of thumb: oplog should retain at least 24-72 hours of operations to tolerate planned maintenance. For high-write workloads, calculate: `expected_daily_writes_GB * 3` for a 3-day window. Default is 5% of disk or 1 GB minimum. Set via `replication.oplogSizeMB` in config (or dynamically via `replSetResizeOplog` since 3.6). From 4.4+, `oplogMinRetentionHours` lets you pin retention time instead of size.

**What FAANG expects:** the candidate sizes the oplog against *write volume* and *recovery window*, not against total data size. They also link oplog size to change-stream resume-token horizon - a small oplog breaks lagging CDC consumers.

*Follow-ups:*
- Your oplog is 50 GB but the replication window is only 4 hours under peak load. What changed, and what do you do?
- How does the oplog differ between a replica set primary and a `mongos`?
- Explain why shrinking the oplog can silently break change-stream resume even if the consumer only lags by minutes.

**Q10: How do you handle schema migrations in MongoDB?**

A: MongoDB's flexible schema means you don't need to run migrations for additive changes. Strategies: (1) **Lazy migration**: add a `schema_version` field, on read detect old version and migrate in application code, then write back. (2) **Background migration**: run a script that reads old format docs in batches and writes new format, throttled to avoid overwhelming replication. (3) **Dual-write**: write both old and new format during transition period, read both during cutover, then remove old. (4) **$jsonSchema validator updates**: add new required fields *after* migrating existing docs, not before - otherwise old docs fail validation. Always test migrations on a staging replica set first, and back up before destructive changes.

**What FAANG expects:** the candidate names an online strategy (lazy or dual-write) as default, and reserves blocking background migrations for small collections or scheduled maintenance windows. They version their documents explicitly and treat the application code as part of the schema.

*Follow-ups:*
- You need to rename a field on a 2 TB collection with 100k writes/sec. Describe a zero-downtime plan.
- How do you roll back a schema change after 10% of production traffic has hit the new code path?
- Compare MongoDB's implicit migrations to Postgres' explicit `ALTER TABLE` - what operational habits must Mongo teams adopt to compensate for the lack of a migration ledger?

**Q11: What is index intersection and when does MongoDB use it?**

A: MongoDB can combine two single-field indexes to satisfy a query that filters on both fields - called index intersection. However, it's usually less efficient than a compound index because intersection requires fetching and merging two index scans. MongoDB uses intersection when no single compound index satisfies the query. Best practice: create compound indexes for your frequent query patterns rather than relying on intersection. Use `explain("executionStats")` to verify which indexes are being used and check the winning plan stage.

**What FAANG expects:** the candidate reads `explain` output fluently, identifies `AND_SORTED` vs `IXSCAN` stages, and knows the ESR rule cold. They prefer one deliberate compound index over several single-field indexes.

*Follow-ups:*
- Show me how the winning plan differs between an IXSCAN on a compound index and an AND_SORTED intersection.
- How does the query planner cache winning plans, and when is the cache invalidated?
- Walk me through designing the minimal index set for a collection with 6 distinct query patterns.

**Q12: How does MongoDB handle time zones in Date fields?**

A: MongoDB stores dates as UTC milliseconds since epoch (BSON Date type, 64-bit signed integer). The driver converts Go `time.Time` to UTC automatically. For display, convert on application side. For time-zone-aware queries (e.g., "all orders placed on Monday in Tokyo"), either: (1) store dates in UTC and convert in `$project` with `$dateToString {timezone: "Asia/Tokyo"}`. (2) store a local date string separately for simple bucket lookups. (3) use the aggregation `$dateTrunc` stage (5.0+) with a `timezone` argument. Never store timezone-ambiguous strings as dates.

**What FAANG expects:** the candidate always normalizes to UTC at write time, treats the application's zone as a display concern, and knows that BSON Date has no timezone component at all.

*Follow-ups:*
- A report "orders placed on a specific Monday in New York" must be correct across DST transitions. How do you query it?
- Why is `time.Time{}.IsZero()` subtly broken in MongoDB round-trips, and how do you avoid the gotcha?
- When would you store times as seconds-since-epoch integers instead of BSON Dates?

**Q13: Describe the aggregation pipeline's execution model.**

A: The pipeline executes stages sequentially. Each stage transforms its input documents and passes results to the next. Key optimizations: (1) `$match` at the start uses indexes. (2) `$sort` + `$limit` together can use top-K optimization (heap of size limit). (3) `$match` followed by `$sort` on the same field combination is optimized into a single index scan with sort. (4) The planner moves stages forward when possible (e.g., `$match` after `$project` that doesn't reference projected fields gets moved before). (5) `$lookup` with a `pipeline` sub-pipeline runs the inner pipeline against the foreign collection. Use `explain("executionStats")` on aggregation to inspect execution. For pipelines that exceed 100 MB of intermediate state, pass `allowDiskUse: true` to spill to temp files.

**What FAANG expects:** the candidate reads aggregation `explain` output, knows the 100 MB in-memory stage limit, and recognizes which stages can use indexes (`$match`, `$sort`, `$group` on shard key) vs. which force full-collection work.

*Follow-ups:*
- Why should `$match` come before `$project`, and when does the planner reorder them automatically?
- A pipeline with `$group` on a high-cardinality field is OOMing. What are your mitigation options?
- When would you use `$merge` or `$out` instead of returning results to the application?

**Q14: How would you implement soft deletes in MongoDB?**

A: Add `deleted_at` field (null for active, timestamp for deleted). Create a partial index: `{deleted_at: 1}` with filter `{deleted_at: {$ne: null}}` for querying deleted docs, and ensure every production query filters on `deleted_at: null` (a shared query helper prevents omissions). For better performance, add a TTL index on `deleted_at` with `expireAfterSeconds: 2592000` (30 days) to automatically hard-delete old soft-deleted records - this combines audit window with storage reclamation. Alternatively, move deleted documents to an archive collection via change stream for clean separation.

**What FAANG expects:** the candidate treats soft deletes as a per-query invariant enforced by a repository layer, not something individual callers remember to add. They also raise GDPR "right to be forgotten" and compliance constraints - soft deletes of PII may need to become hard deletes on a regulated timeline.

*Follow-ups:*
- A developer forgets the `deleted_at: null` filter in one query. How do you prevent this at the type system or linter level?
- A GDPR erasure request arrives for a user with soft-deleted data still in the 30-day window. What is the correct action?
- How do soft deletes interact with unique indexes on `email`?

**Q15: What are the trade-offs of MongoDB Atlas vs self-hosted?**

A: Atlas: fully managed, automated backups, point-in-time restore (PITR), built-in monitoring, auto-scaling, Atlas Search, vector search, zero-downtime upgrades, compliance certifications (SOC2, HIPAA, PCI DSS). Cost: 2-4x more expensive than self-hosted at comparable capacity. Self-hosted: full control, lower cost at scale, can tune WiredTiger/OS parameters, co-locate with other services, more flexible networking. Use Atlas for startups and teams without dedicated DBA expertise, for regulated workloads where compliance certifications are table stakes, or when time-to-value dominates. Use self-hosted for cost-sensitive very-large deployments with an experienced ops team, or when you need features Atlas does not expose (custom server parameters, specific Linux tuning). Remember: Atlas Search and Atlas Vector Search are *only* available on Atlas. If you self-host you integrate Elasticsearch or pgvector separately.

**What FAANG expects:** the candidate does the TCO math (Atlas cost vs. SRE headcount + infra + license risk) rather than picking by vibe, and understands the licensing context - the SSPL limits third-party managed offerings, which is why DocumentDB is a *wire-compatible subset*, not a real MongoDB.

*Follow-ups:*
- You need Atlas Vector Search but your data must stay in a specific region for regulatory reasons. What are your options?
- Why is DocumentDB not a drop-in replacement for MongoDB, and where will a migration break?
- Atlas bills on compute + storage + egress. Design a workload whose total cost would be dominated by each of those three lines.

### Junior to FAANG: The L3 to L4 Entry Ladder and How to Study for It

The fifteen questions above cover the L4 to L5 working set. Juniors preparing for a first MongoDB interview need a tighter entry-point drill. Below is the L3-to-L4 ladder, with the minimum signal each rung expects.

L3 screen. Goal: can the candidate talk about documents, collections, indexes, and the difference between `find` and `aggregate`. Sample questions and the answer shape interviewers want.
- "What is a document in MongoDB?" A BSON blob up to 16 MB with an `_id` that is unique per collection. Mention that `_id` defaults to an `ObjectId` which encodes a four-byte timestamp, a five-byte random, and a three-byte counter.
- "How do you find all users with email ending in `@gmail.com`?" Use `{email: {$regex: /@gmail\.com$/}}`. A junior who adds "this will not use a standard index unless the pattern is anchored" moves to L4.
- "How do you paginate?" Skip and limit works for small offsets. For large offsets use a range filter on the sort key (keyset pagination) because `skip` is O(offset).
- "Name one index type other than a single-field index." Compound, multikey (array), text, geo (2dsphere), hashed, partial, TTL, wildcard. Name three.

L4 screen. Goal: can the candidate design a small schema, pick an index, and reason about writes.
- "Design the data model for Instagram's feed on MongoDB." Two collections: `posts` (authorId, media, caption, createdAt) and `timelines` (userId, entries array bounded to e.g. five hundred with TTL). Fan-out on write for normal accounts, fan-out on read (pull merge) for celebrity accounts above a threshold. Shard `posts` on `{authorId: "hashed"}` and `timelines` on `{userId: "hashed"}`. Mention the write-amplification math.
- "A query is slow. What do you do?" Run `explain("executionStats")`, read `totalDocsExamined` and `totalKeysExamined`, look for COLLSCAN, then build the minimal compound index following the ESR rule (Equality, Sort, Range).
- "Describe retryable writes." Driver setting on by default. On a transient network error or primary step-down the driver resends the write with the same `lsid` and `txnNumber`. The server deduplicates. This is why ObjectIDs should be generated client-side.

Worked example for a junior. The interviewer says "we have a collection of one billion orders, the query `find({customerId: X}).sort({createdAt: -1}).limit(20)` takes two seconds." Walk through: (1) we need a compound index `{customerId: 1, createdAt: -1}`. (2) `explain` should show IXSCAN with `stage: LIMIT` and no SORT stage because the index order satisfies the sort. (3) projection to only needed fields to enable a covered query. (4) if `customerId` cardinality is low, consider a partial index. This is the ninety-second answer that earns the L4 signal.

"Why did this fail?" reflex for juniors. If an interviewer hands you a broken query, the three things to check in order are: index existence (`db.coll.getIndexes()`), index selectivity (`explain`), and read preference (secondary lag). Nine out of ten interview fails are in this triangle.

Interview entry point checklist. Before you walk into an L3 or L4 Mongo round, be able to say out loud in under thirty seconds: ESR rule, write concern and read concern dials, oplog retention window, change-stream delivery semantics (at-least-once), and the 16 MB document limit. This is the starter pack.

### Senior at FAANG: Bar-Raiser Questions, System Design, and the Principal-Level Rubric

At L5 and above the interview shifts from "do you know MongoDB" to "can you own a MongoDB fleet across a business". The bar raiser is usually an experienced principal engineer from a different org who probes for failure modes, blast radius reasoning, and migration maturity. Below are the canonical bar-raiser questions with the expected answer shape.

Bar-raiser question one. "Migrate from Postgres to MongoDB for a 3 TB customer profile table. Zero downtime. Ninety-day deadline." Expected answer covers: (1) target schema design, embedding versus referencing decision documented in an ADR. (2) Debezium Postgres connector streaming to Kafka, sink connector writing to MongoDB with idempotent upserts keyed by the Postgres primary key. (3) backfill via a chunked read-replica snapshot, throttled to stay under replication lag SLO. (4) dual-read shadow phase where the application reads Postgres as truth and MongoDB in shadow, comparing results and emitting a drift metric. (5) cut over when drift is below a threshold for seven consecutive days. (6) keep Postgres in read-only mode for thirty days as rollback insurance. (7) a documented kill switch. Bonus: discuss when you would NOT migrate, for example if the access pattern is heavily relational or the team lacks Mongo on-call expertise.

Bar-raiser question two. "Shard a 10 TB collection currently on a single replica set." Expected answer: (1) choose the shard key with a histogram of writes over the last thirty days simulated against candidate keys. (2) prefer a compound key `{tenantId: 1, _id: 1}` for multi-tenant workloads since it supports tenant-targeted queries and distributes writes. (3) avoid monotonic keys. (4) run `sh.reshardCollection` (5.0 plus) with a coordinator that tracks progress. (5) expect temporary two-times IOPS and plan capacity accordingly. (6) keep the balancer off during backfill windows, then on. (7) validate chunk distribution with `db.coll.getShardDistribution()` and verify query targeting via `explain` on a representative query set. The signal interviewers look for is the candidate mentioning the reshard duration (days to weeks at 10 TB) and the cost profile.

Bar-raiser question three. "p99 on a production MongoDB service spiked from 20 ms to 600 ms. You have thirty minutes. Walk me through." Expected answer follows a deterministic sequence. (1) Is the primary stepping down or oplog lag spiking, check `rs.status()`. (2) Is the WiredTiger cache saturated, check `serverStatus().wiredTiger.cache` and `pages evicted by application threads`. (3) Is there a new slow query in the profiler, sort by duration descending. (4) Is a shard balancer migration running, check `sh.isBalancerRunning()`. (5) Is there a traffic anomaly, check request rate per collection. (6) If none, is there a CPU or disk saturation on a host, check the node exporter. The bar raiser scores on the order of the checklist, not the answer content, because order reveals reasoning.

Bar-raiser question four. "Design a multi-region MongoDB for GDPR." Zone sharding with a region prefix shard key, `regionTag` on each zone, Atlas private endpoints per region, encryption at rest with customer-managed keys per region, audit log piped to a region-local SIEM, and a documented data transfer impact assessment for any cross-region read. Discuss `readPreference` with `tagSets` that pin reads to the region of the user. Mention Schrems II and the DPA obligations. This question is scored on regulatory fluency as much as technical fluency.

Bar-raiser question five. "Build a schema lint for MongoDB." Spec the tool. Parse Go structs with bson tags, parse collection validators, run against a sample of production documents. Rules: required fields present, no unbounded arrays without an ADR exemption, every collection has `createdAt` and `updatedAt`, PII fields tagged with a `pii` bson option, index coverage for every named query pattern declared in a repository file. Integration: runs in CI on every PR touching a repository file. Failure: PR blocked. Exception path: file an ADR in `docs/adr/` and link it in the PR description. The tool itself is an L5 deliverable.

Bar-raiser question six. "Write a Debezium to Kafka pipeline for MongoDB change streams." Expected answer names the Kafka Connect Mongo Source connector (the official MongoDB-maintained connector, not the Debezium one for production use in 2026 given feature parity), the resume token persistence strategy (Kafka-managed offset plus a periodic checkpoint in a metadata collection), the schema registry integration (Avro or Protobuf schemas versioned on every collection evolution), exactly-once by Kafka transactional producer plus idempotent consumers, and the backpressure plan if Kafka is down (pause the connector, let the oplog grow, alert if the oplog window drops below the SLO threshold).

Principal-level rubric. When interviewing a staff candidate for MongoDB ownership, score across five axes, each on a one-to-five scale: (1) schema design fluency. (2) operational maturity (oplog, WiredTiger, replication, sharding, resharding). (3) observability and incident response. (4) migration and cross-store strategy (when to leave Mongo). (5) governance (ADRs, lints, platform gates). A candidate must score four plus on three axes and at least three on the rest. A five on one axis does not compensate for a one on another. This rubric is itself an artifact a principal engineer should produce for their org.

Maturity model question. "Where is your organization on the MongoDB maturity ladder, and what is the next step?" The answer should reference L1 through L5 (single replica set to self-service Atlas governance), name one or two artifacts the candidate has shipped that moved the org up a rung, and name one currently blocked by staffing, funding, or politics. This is the question that distinguishes a senior from a principal engineer.

---
