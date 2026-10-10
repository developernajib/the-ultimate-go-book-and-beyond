## 37D.17 Exercises

**Exercise 1: Social Media Schema**

Design and implement a MongoDB schema for a Twitter-like application supporting:
- Users, tweets, follows, likes, retweets
- Timeline feed with pagination (cursor-based)
- Hashtag trending (top 10 hashtags last 24 hours)
- Full-text search on tweets

Requirements:
- Handle users with 10M+ followers using the hybrid fan-out pattern
- Implement change stream processor to update trending hashtags
- Write aggregation pipeline for trending hashtags
- All reads < 20ms at p99

**Exercise 2: Real-Time Analytics Dashboard**

Build a MongoDB-backed analytics system for an e-commerce platform:
- Track page views, product clicks, add-to-cart events as individual documents
- Implement bucket pattern to aggregate events into hourly buckets
- Build aggregation pipeline for conversion funnel analysis
- Use change streams to push real-time metrics via WebSocket

Requirements:
- Support 100K events/second ingestion
- Dashboard queries < 500ms for 30-day range
- Implement TTL to auto-expire raw events after 7 days
- Keep hourly aggregates for 1 year

**Exercise 3: Multi-Tenant SaaS**

Design a MongoDB schema for a multi-tenant project management SaaS:
- Tenants, users, projects, tasks, comments with RBAC
- Enforce tenant isolation at the application and database level
- Implement audit log with change streams
- Schema validation per collection

Requirements:
- Support 10K tenants with up to 100K tasks each
- Cross-tenant queries for platform admin only
- Shard by `{tenant_id: "hashed"}` for scalability
- Full-text search within tenant scope
- Soft deletes with 30-day retention

### Junior to FAANG: Exercise Scaffolding and Entry-Point Worked Examples

The three exercises are realistic but too open for a first-year engineer. Below is the scaffolding a junior should follow to ship each one, with a worked example for Exercise 1 to anchor the pattern.

Exercise 1 scaffolding. Ship in this order.
1. Collections. `users`, `tweets`, `follows`, `timelines`, `hashtag_trends`. Draw the field list for each before coding.
2. Indexes. `users` on `{username: 1}` unique, `tweets` on `{authorId: 1, createdAt: -1}`, `follows` on `{followerId: 1}` and `{followeeId: 1}`, `timelines` on `{userId: 1, createdAt: -1}` with a partial filter on non-deleted entries, hashtag text index on `tweets.hashtags`.
3. Write path. Post a tweet. For each follower with follower count under the celebrity threshold (say ten thousand), insert into their timeline. For celebrity authors, mark the tweet with a celebrity flag and skip fan-out.
4. Read path. For a user, union the fan-out timeline with a fan-in pull of recent tweets from celebrity accounts they follow. Merge in Go by `createdAt` descending, limit to the page size, cursor on the last `{_id, createdAt}`.
5. Trending. Aggregation pipeline over the last twenty-four hours: `$match` by `createdAt`, `$unwind` hashtags, `$group` by hashtag with count, `$sort` descending, `$limit` ten, `$merge` into `hashtag_trends`. Schedule every five minutes.
6. Change stream consumer. Listens on `tweets` for inserts, updates a real-time approximate counter in Redis for the current hour, reconciles against the scheduled aggregation.

Worked example. You are asked to implement the post-a-tweet endpoint. The junior-correct code.
- Generate `_id` with `bson.NewObjectID()` (retryable).
- Insert into `tweets` with `w:"majority"` because losing a user tweet on failover is a customer incident even if not financial.
- Look up follower count. If under the threshold, use an unordered bulk write into `timelines` with `ordered=false` so a single failure does not stop the fan-out. Chunk at one thousand per bulk to stay under the BSON 48 MB command size.
- If over the threshold, emit a "celebrity-tweet" event to Kafka for an out-of-band fan-out worker.
- Return 201 with the tweet id.

"Why did this fail?" reflex. If reads are over twenty ms p99 the junior checklist is: projection present, index used (check `explain`), timeline document size bounded, no `$lookup` on the hot path, read preference is primary or a causally-consistent secondary. If all pass the issue is infrastructure (cache pressure, replication lag, or network).

Exercise 2 and 3 scaffolding (compact).
- Exercise 2. Start with the bucket pattern. One bucket per `{site, hour}`. Bounded array of event counters. Raw events in a separate TTL collection for seven days. Aggregations run against buckets not raw. Change stream on buckets pushes deltas to the WebSocket gateway. Ingestion path uses `findAndUpdate` with `$inc` so each event is a single atomic write.
- Exercise 3. Start with the tenant isolation primitive. Every collection has a `tenantId` field and every query goes through a repository that injects it. Enforce with a Go middleware that refuses to run a query without a tenant predicate. Shard on `{tenantId: "hashed"}`. Schema validators per collection. Audit log derived from change streams, never from application code.

Interview entry point. If asked "implement exercise one on a whiteboard" the junior-acceptable answer starts by writing the collections and indexes, not the code. Candidates who start coding before sketching schema almost always fail the interview.

### Senior at FAANG: Staff Extensions, ADRs, and the L5 Deliverables

At staff or principal level each exercise becomes a platform deliverable, not a service. Below are the extensions and the artifacts a senior engineer is expected to produce.

Extension to Exercise 1. "Productionise Twitter-at-scale on MongoDB, end-to-end."
- Write the shard-key ADR for `tweets` and `timelines`. Defend the choice against three alternatives. Include a write-histogram simulation.
- Capacity model. At fifty million daily tweets with an average fan-out of one thousand, the timeline insert rate is five hundred million per day. Document the host count, shard count, and disk IOPS required. Include a ninety-fifth-percentile day, not an average.
- Celebrity threshold tuning. The threshold is a dial with a cost curve. Produce the curve (threshold vs fan-out write IOPS vs read latency for non-celebrity feeds) and defend the chosen point.
- Disaster recovery runbook. Region failover in under fifteen minutes. Validated quarterly.
- Cost model. Unit economics per DAU including Atlas cost, Kafka cost, Redis cost, egress, and SRE on-call. Attach the spreadsheet.

Extension to Exercise 2. "Build a schema lint for MongoDB telemetry pipelines."
- CLI tool written in Go that ingests: a directory of Go structs with bson tags, a manifest of collections and their `$jsonSchema` validators, and a sample of production documents from a non-production replica.
- Rules. Bounded arrays, required fields, `createdAt` and `updatedAt` present, PII tagging, index coverage for declared query patterns, document size ninety-fifth percentile budget, shard-key presence.
- Integration. Pre-commit hook, CI check, and a nightly cluster scan that raises Jira tickets on drift. Publish rule overrides as ADRs in `docs/adr/`.
- Maturity contract. At L4 the lint is advisory. At L5 the lint is a deploy gate enforced by the platform.

Extension to Exercise 3. "Design a multi-region MongoDB SaaS for GDPR."
- Zone sharding with `regionTag` per zone. Each tenant has a `homeRegion` attribute that pins their data.
- Private endpoints per region. Encryption at rest with customer-managed keys per region. TLS 1.3 in transit.
- Audit log per region pinned to a region-local SIEM. A data transfer impact assessment for every cross-region read. Schrems II posture documented.
- Right-to-erasure workflow. A request triggers a Kafka event that fan-outs to Mongo deletes plus Kafka tombstones plus downstream consumer replays. End-to-end latency ninety-five percent under seventy-two hours (to beat the GDPR thirty-day floor comfortably). Audit trail of the erasure itself preserved for seven years.
- Cross-region outage playbook. If the EU primary region is down, no fail-over to US. Read-only mode until EU capacity returns. Document the trade-off with legal.

Extension to Exercise 3 continued. "Write a Debezium-to-Kafka pipeline for MongoDB change streams."
- Connector choice. Kafka Connect MongoDB Source connector (official, 2026 feature parity). Document why over Debezium Mongo connector (historically a lag in 6.0 and 7.0 features).
- Offset persistence. Kafka-managed plus a checkpoint collection for quick recovery beyond Kafka retention.
- Schema registry. Avro per collection, versioned. Every `$jsonSchema` change triggers an Avro evolution with compatibility rules (backward preferred).
- Exactly-once. Kafka transactional producer, idempotent consumers, dedup on `{_id, clusterTime}`.
- Observability. Lag metric per connector. Alert on lag greater than five minutes. Alert on oplog window shrinking below twice the maximum observed lag.
- ADR. Document the alternatives (application-level dual-write, polling, outbox pattern) and why change streams plus Kafka Connect wins for this workload.

ADR checklist for each extension. Every L5 deliverable ships with an ADR that covers: context, decision, alternatives, consequences, rollout, revisit date, and a kill switch. No exceptions. The revisit date is typically twelve months with an earlier trigger on MongoDB release events (a major version like 9.0, a compliance event, or a cost event above twenty percent of plan).

Maturity model exit criteria. An org completes Exercise 1 through 3 at L5 when: (a) all three services are running in production with SLOs met for ninety days, (b) each service has an ADR bundle reviewed by a principal, (c) the schema lint is a deploy gate, (d) the Debezium pipeline has been tested against a primary step-down and a region failure, and (e) the on-call rotation has run a game-day on each scenario in the last six months. Below this, the org is at L4 regardless of the dashboards it publishes.

---
