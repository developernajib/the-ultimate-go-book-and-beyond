## Summary

MongoDB's document model excels at representing hierarchical, heterogeneous data that maps directly to application objects. Key topics include:

- **Architecture**: WiredTiger B-tree storage, MVCC, BSON type system, compression
- **Go driver**: production client with connection pooling, TLS, OpenTelemetry, generic repository pattern
- **Schema design**: embedding vs referencing, bucket pattern, outlier pattern, relationship trade-offs
- **Aggregation**: $group, $lookup, $facet, $graphLookup, $unwind for complex analytics
- **Indexing**: compound, sparse, partial, TTL, text, 2dsphere, hashed indexes
- **Transactions**: multi-document ACID with snapshot isolation, optimistic locking, FindOneAndUpdate atomic patterns
- **Change streams**: real-time processing with resume tokens, exactly-once semantics
- **Sharding**: shard key design, zone sharding, hotspot avoidance
- **Atlas features**: $search with fuzzy + facets, vector search for semantic AI applications
- **Production patterns**: bulk writes, cursor streaming, optimistic locking, monitoring

### Junior to FAANG: What To Internalise From This Chapter Before Your First Production On-Call

A junior finishing this chapter should leave with a short list of non-negotiable habits. If you remember nothing else on the day you join a team that runs MongoDB, remember these.

- Generate `_id` client-side with `bson.NewObjectID()` so every write is retryable.
- Never ship a `Find` without a projection on a document larger than 2 KB average size.
- Never ship a write concern weaker than `w:"majority"` on any collection that holds money, identity, or audit data.
- Never write a sort without checking that a compound index supports it. The ESR rule (Equality, Sort, Range) is the one index-design mnemonic you must memorize.
- Never embed an unbounded array. If the cardinality is unknown, reference a second collection and cache a count.
- Always run `explain("executionStats")` at least once on every query you ship to production. Check `totalDocsExamined` versus `nReturned`.
- Always enable retryable writes. Grep your connection strings for `retryWrites=false` and delete it.
- Always capture the driver command monitor into OTEL spans. Slow queries without traces are debugging suicide.

Worked example of the first-week audit. Your new employer gives you repo access. In two hours you can: (a) grep for `w:1` and open tickets. (b) grep for `retryWrites=false` and open tickets. (c) list collections, check `stats.avgObjSize` against 2 KB and open tickets for missing projections on the heavy ones. (d) run `indexStats` and list indexes with zero accesses over thirty days. (e) check `serverStatus().metrics.queryExecutor.scannedObjects` trend over ninety days. This audit earns you credibility faster than any feature you could ship in the same two hours.

Interview entry point. The question "what is the first thing you do when you join a team running MongoDB" now has an answer that separates you from ninety percent of candidates. Say "I run a five-step audit" and list the above.

### Senior at FAANG: The Principal Engineer's MongoDB Operating Model

At staff and principal level, the summary of this chapter is not a bullet list of features. It is an operating model for running MongoDB as a platform capability across an organization. The model has five pillars.

Pillar one: fitness for purpose. MongoDB is not the default database. Postgres is. MongoDB earns its place when the workload is document-shaped, the query set is small and index-friendly, the transaction boundary is narrow, and the team has or will hire on-call expertise. The principal engineer owns the "when to choose MongoDB" ADR that every new service must consult. Uber famously evaluated MongoDB and then chose to build its MySQL-backed Schemaless store instead, and it is far from the only company whose datastore retrospective traces back to a fitness check done (or skipped) up front. Do not skip the check.

Pillar two: schema and data governance. A schema lint as a deploy gate. Shard-key ADRs as a review board output. Bounded arrays and explicit TTLs as a policy. PII tagging in bson options that feeds a data catalog. This pillar turns MongoDB from a schemaless database into a schema-governed one, which is what regulated enterprises actually need.

Pillar three: operational maturity. The L1-to-L5 ladder (single replica set to self-service Atlas governance) is the backbone. The principal engineer is accountable for moving the org up rungs, not for running any individual cluster. Each rung has specific artifacts: L2 ships backup verification, L3 ships shard-key ADRs, L4 ships CI lints and OTEL integration, L5 ships a self-service platform API.

Pillar four: observability and incident response. Atlas Performance Advisor, `mongostat`, `mongotop`, `db.currentOp`, `explain executionStats`, slow-query log, `serverStatus`, `mongodb_exporter`, OTEL command monitor, Datadog DBM integration. The principal engineer owns the signal taxonomy, the cardinality budget, the alert bar, and the postmortem template with a fixed root-cause taxonomy. Incidents without fixed taxonomy do not become fleet-level metrics and cannot be driven down.

Pillar five: exit strategy. Every storage choice has an exit cost. MongoDB's is bounded because change streams plus Debezium plus Kafka Connect provide a clean exit path. Document the exit plan for every business-critical collection at the ADR review. The plan names a target (Postgres for relational-shape, DynamoDB for key-value, Spanner for globally-consistent) and the migration playbook (dual-write via change stream, shadow-read, cutover, thirty-day rollback). This is what separates a platform from a lock-in.

Governance artifacts a principal engineer produces in their first six months. (1) The "when to choose MongoDB" ADR. (2) The shard-key review rubric. (3) The schema lint tool and its CI integration. (4) The observability signal taxonomy with cardinality budgets. (5) The maturity-model scoring rubric with a score for each existing service. (6) The incident root-cause taxonomy and postmortem template. (7) The cost model spreadsheet with chargeback tags. (8) The game-day playbook (primary step-down, region failure, oplog overflow, shard balancer stuck, hot shard). (9) The exit-strategy ADR per business-critical collection. These nine artifacts are the deliverable, not a set of dashboards.

Maturity model exit criteria at L5. Every new service ships with a MongoDB readiness score. Every cluster is provisioned by a platform API with private endpoints, customer-managed keys, TLS 1.3, auditing, tag-based chargeback, and a backup SLO. Every PR with a bson tag change runs the schema lint. Every incident writes a postmortem in the fixed taxonomy. Every quarter the org runs a game-day. If these five conditions hold for ninety consecutive days, the org is at L5. If any one fails, the org is at L4 regardless of what the CTO's slides say.

The operating model above is the real deliverable of reading this chapter at a senior level. The individual features (aggregation, change streams, sharding, Atlas Search) are means. The operating model is the end.

---
