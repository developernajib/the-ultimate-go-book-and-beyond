## Summary

DynamoDB and NewSQL databases represent two distinct approaches to scaling beyond traditional RDBMS. Key takeaways include:

- **DynamoDB architecture**: partition model, throughput capacity, consistency levels, item size limits
- **Single-table design**: PK/SK patterns, entity prefixes, hierarchical relationships, access pattern mapping
- **Go AWS SDK v2**: PutItem, GetItem, Query, BatchGetItem, UpdateItem with condition expressions
- **Transactions**: TransactWriteItems (up to 100 items), TransactGetItems for consistent multi-item reads
- **DynamoDB Streams**: CDC with Lambda, entity detection from PK prefix, event-driven architecture
- **CockroachDB**: PostgreSQL-compatible distributed SQL, geo-partitioning, serialization retry pattern
- **Google Spanner**: TrueTime external consistency, interleaved tables, stale reads, HTAP
- **Database selection**: decision matrix for DynamoDB vs CockroachDB vs Spanner vs TiDB vs YugabyteDB
- **Case studies**: Amazon DynamoDB origin, CockroachDB in financial services, Spanner for Google Ads, PlanetScale Vitess

Key insight: **DynamoDB rewards query-first thinking** - know your access patterns before designing. NewSQL databases **extend SQL familiarity to distributed scale** at the cost of operational complexity or cloud lock-in.

### Junior to FAANG: What to Internalize Before Your First On-Site

Five non-negotiables to carry into your first database interview. First, access patterns come before schema. Second, a partition key that concentrates traffic is a production incident waiting to happen. Third, eventually consistent is a feature, not a bug, and you must name which reads in your design require strong consistency. Fourth, cost scales with writes and with GSI fan-out, so every GSI is a tax you keep paying. Fifth, capacity math is arithmetic, not opinion, and you should be able to do it on a whiteboard for any workload described to you.

Prerequisite gaps to close if you are coming from a Postgres-only background. The idea that schema changes are cheap (true in Postgres online DDL, false in DynamoDB single-table where a new access pattern often means a new GSI plus a backfill). The idea that SELECT with a WHERE clause is always efficient (false, because Scan-with-FilterExpression is SELECT with a WHERE clause and it reads the whole table). The idea that transactions are free (false, TransactWriteItems costs double and has a 100 item cap). The idea that "the database will figure it out" (false, DynamoDB has no query planner, your keys are your plan).

Worked reflection. If you could only memorize one number in this chapter, memorize 3000 RCU and 1000 WCU per partition. Every hot-partition postmortem bottoms out at that number. If you could only memorize one rule, memorize "a Query is O(items with this PK), a Scan is O(table)." If you could only memorize one anti-pattern, memorize "reading your own write from a GSI in the same request."

### Senior at FAANG: The Platform Owner's Checklist and Maturity Snapshot

A senior engineer leaves a chapter like this with a written checklist they can apply to any database review next Monday morning.

Platform owner checklist. One, every production table has a documented access-pattern catalog stored next to the schema in source control. Two, every GSI has a projection justification and a cost note. Three, capacity mode is chosen by arithmetic, not by default, and re-reviewed monthly. Four, PITR is on and the restore runbook has been exercised in the last 90 days. Five, Streams consumers have DLQs and age alarms. Six, cross-region topology is chosen by a written ADR that names the consistency and availability trade. Seven, data classification is tagged on every attribute and export jobs honor it.

Maturity snapshot that you can score your team against today. L1 ad-hoc: we use DynamoDB because someone started it. L2 reactive: we add a GSI when a query is slow, we add capacity when CloudWatch screams. L3 documented: every table has an owner, an access-pattern catalog, a capacity model, and a cost budget. L4 proactive: we chaos-test region failover, we review schemas at a bar, we retire unused GSIs on a cadence, we migrate legacy workloads with documented ADRs. L5 platform: we publish internal golden paths, we own a schema lint, we run cost optimization as a quarterly program, and our SLOs are met for 95 percent of tables with 99 percent of their remaining error budget.

Decision framework recap in one paragraph. DynamoDB for single-digit-millisecond key-value at any scale where you can name every access pattern up front and you can accept last-write-wins across regions. Aurora for a single-primary workload under roughly 50K writes per second where SQL feature depth matters and a single region is fine. Spanner for globally consistent transactions when you are on or near Google Cloud and you want managed. CockroachDB for Spanner semantics on any cloud or on-prem with Postgres wire compatibility, when you are willing to pay the operational or managed-service cost and to handle 40001 retries in code. TiDB or YugabyteDB for niche fits where you specifically want dual API or HTAP on the same storage. Never pick a database because it is trendy. Pick it because the access pattern, the scale, the consistency requirement, and the geography demand it, and write down the reasoning in an ADR that a successor can audit in 2031.

Governance artifacts that should live in every senior-owned database platform. A schema review board with a documented bar. A capacity and cost review cadence with a per-team budget. A data classification register. A migration playbook template. A chaos experiment schedule. An on-call runbook library. A postmortem corpus that is searchable and cross-referenced to ADRs. If any of these seven artifacts is missing, that is your next quarter of work.
