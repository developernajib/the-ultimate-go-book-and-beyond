## 37G.10 Company Case Studies

### Amazon: The DynamoDB Origin Story

DynamoDB was built from Amazon's internal Dynamo paper (2007). Amazon needed a database that could guarantee availability during peak shopping events (Black Friday) when relational database failures caused outages. Key insight: most Amazon services needed simple key-value patterns (get cart, update session, check inventory) - full SQL was unnecessary overhead. DynamoDB became the backbone for Amazon.com, handling millions of calls per second during peak events with guaranteed single-digit millisecond latency.

### Cockroach Labs: Financial Services Adoption

CockroachDB gained adoption in financial services (Bose, Comcast, JPMorgan Chase) for its combination of SQL familiarity and distributed ACID guarantees. Comcast migrated from PostgreSQL to CockroachDB with minimal code changes (PostgreSQL wire protocol compatibility). Key benefit: geo-partitioning allows them to keep EU customer data in EU regions for GDPR compliance while maintaining ACID transactions across regions.

### Google: Spanner for Ads

Google built Spanner to replace Bigtable+Chubby lock service for AdWords (now Google Ads). AdWords required ACID transactions across petabytes of data globally - advertisers in Tokyo needed to see consistent campaign spending that accounts for clicks happening in New York milliseconds ago. Spanner's TrueTime API (GPS + atomic clocks) provides external consistency without distributed locks. Spanner handles over 2 billion requests per second at peak across Google's internal services.

### PlanetScale: Vitess at Scale

PlanetScale offers a managed MySQL-compatible database built on Vitess (YouTube's database sharding middleware). Key pattern: horizontal sharding of MySQL without changing application code - Vitess intercepts queries and routes them to the correct shard. GitHub uses Vitess for its core database (billions of rows). PlanetScale adds non-blocking schema changes (no locking) which is critical at scale.

### Junior to FAANG: Reading Case Studies as a Learning Tool

When you read that Amazon has run the shopping cart on Dynamo since 2007 (the internal system described in the paper, later productized as DynamoDB in 2012), resist the urge to treat that as a branding detail. The load-bearing fact is that availability beat consistency for that workload. A cart that briefly shows two versions of itself after a network partition is a recoverable user experience. A cart that refuses to accept items during Black Friday is a lost sale. That single trade is the reason the Dynamo paper exists, and it is the reason your first-job answer to "why DynamoDB" should never be "because it scales."

Work the case studies as flashcards. Lyft models ride state (requested, matched, picked-up, dropped-off, paid) as a small finite state machine keyed by ride_id, which is why a single-partition key-value store works. Snap stores ephemeral messages keyed by recipient with a TTL attribute, which is why garbage collection is free. Airbnb review counts and aggregates sit behind a write-heavy key-value path with eventual read projections. Duolingo XP and streak counters are counter updates per user_id, which is a textbook hot-key shape solved with write sharding. For each of these, ask the same three questions. What is the access pattern. What is the consistency tolerance. What would break if you ran this on a single Postgres primary at their scale.

Worked example. Interviewer asks you to design a shopping cart for an e-commerce site that expects 50K writes per second at peak. Junior answer reaches for Postgres and a cart table. Better answer reaches for DynamoDB with pk = user_id, sk = item_id, a condition expression on AddItem to prevent duplicate adds, and a TTL on abandoned carts. The "why did this fail" reflex activates the moment you hear "50K writes at peak" and "single primary." A single Postgres writer caps around 10K to 20K simple writes per second before you are fighting WAL and vacuum. That is the gap the case study is illustrating.

Interview entry point. If you are asked "have you used DynamoDB," and you have not, the honest answer is "I have read the Dynamo paper and the AWS re:Invent talks on single-table design, and here is how I would model X." Do not fake production experience. Faking it is how you get caught on follow-ups about GSI throttling or RCU math.

### Senior at FAANG: Case Studies as ADR Inputs and Maturity Signals

At staff and principal level, case studies are not trivia. They are the corpus you mine when you write an Architecture Decision Record for a database choice that will outlive your tenure. The ADR template that survives scrutiny has six sections. Context (what workload, what scale, what SLO). Options considered (at least three, with honest weaknesses for each). Decision (one sentence). Consequences (what you are giving up, what you are locking in, what the reversal cost is in engineer-years). Validation plan (what load test, what chaos experiment, what canary). Review date (when do we revisit).

The reference set to internalize for 2026 interviews and design reviews. Amazon's shopping cart on the internal Dynamo (2007 paper, ancestor of DynamoDB) is the availability-over-consistency archetype. Google Ads on Spanner is the external-consistency-at-global-scale archetype and the reason TrueTime exists as a public API. DoorDash migrated core order and dispatch workloads to CockroachDB for multi-region active-active without rewriting to a NoSQL data model. Netflix runs most of its stack on Cassandra but moved specific tier-1 workloads onto CockroachDB for transactional semantics they did not want to reimplement in application code. DAZN uses Spanner for live sports metadata that must be globally consistent during a match. Capital One publicly discussed event sourcing on DynamoDB Streams plus Kinesis for audit-grade financial state. Thomson Reuters moved reference data platforms onto Spanner for cross-region strong reads. Disney+ uses DynamoDB for the watchlist and continue-watching catalog because the access pattern is pk = user_id with high fan-out reads.

Maturity model for a platform team owning one of these systems. L1 is "we chose DynamoDB because the tutorial said so" with no capacity model, no hot-partition monitoring, no cost budget. L2 is "we have provisioned capacity set by trial and error" with CloudWatch alarms on throttles. L3 is "we have a documented single-table schema, a published access-pattern catalog, and CDC via Streams into our search and analytics estates." L4 is "we run chaos drills on region failover, we have a tested restore-to-point-in-time runbook, and our capacity mode is justified by a written cost model per access pattern." L5 is "we publish internal golden paths, we own a schema-review bar, and we have retired at least one legacy relational system onto the new platform with a documented migration ADR."

Governance. Any database platform above a few terabytes needs three standing artifacts. A schema review board that gates new tables and new GSIs, because a careless GSI is a permanent tax. A capacity and cost review that runs monthly against a per-team budget, because pay-per-request is a footgun at steady state. A data classification register that maps every attribute to a sensitivity tier, because DynamoDB item exports to S3 are trivial and the blast radius of a misconfigured export is your entire customer base.

---
