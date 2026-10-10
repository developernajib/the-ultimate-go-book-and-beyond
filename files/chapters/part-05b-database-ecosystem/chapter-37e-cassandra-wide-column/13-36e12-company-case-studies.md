## 37E.12 Company Case Studies

### Netflix: Play History at Scale

Netflix uses Cassandra to store 100+ billion play history events. Key decisions:
- **Partition design**: `(account_id, content_id)` as partition key ensures co-location of user's history for a title - enables quick "have you watched this?" lookups
- **TTL**: raw play events expire after 1 year. Pre-aggregated watch history (total minutes, completion %) kept indefinitely
- **Global replication**: 3 DCs worldwide (us-east, eu-west, ap-southeast) with `NetworkTopologyStrategy`, RF=3 per DC
- **Consistency**: reads at `LOCAL_ONE` for recommendations (eventual fine), writes at `LOCAL_QUORUM` for durability
- **Scale**: 30+ petabytes across 10,000+ Cassandra nodes

### Apple: iCloud Device Sync

Apple runs one of the world's largest Cassandra fleets for iCloud services. Representative patterns for that workload shape:
- **Conflict resolution**: last-write-wins (LWW) using `TIMESTAMP` column for device sync conflicts - client timestamps resolve conflicts
- **Lightweight transactions**: LWT for initial device registration (`IF NOT EXISTS`) to prevent duplicate registration
- **Wide rows**: device capabilities stored as sparse columns in a wide row - each device type has different keys in a `MAP<TEXT, BLOB>`
- **Scale**: billions of devices, millions of sync operations per second

### Discord: Message Storage

Discord migrated from Cassandra to ScyllaDB (Cassandra-compatible, C++ rewrite) for trillions of messages, documented in their famous migration post:
- **Schema**: `(channel_id, message_id)` partition key where `message_id` is a time-ordered UUID (Snowflake ID) - enables "load last N messages" efficiently
- **Compaction**: TWCS aligned to the time buckets embedded in the partition key. Discord retains messages indefinitely, so bucketing (not TTL) is what bounds partition size
- **Read repair**: set `read_repair_chance = 0` for write-heavy tables to avoid background repair overhead
- **Hot partitions**: popular channels with millions of messages per day - mitigated with a Rust data service that coalesces concurrent requests to the same partition (the fix their migration post describes)

### Uber: Surge Pricing Computation

Uber uses Cassandra for supply/demand position tracking. Key patterns:
- **Geospatial partitioning**: city+geohash as partition key clusters nearby drivers in same partition
- **TTL**: driver positions expire after 60 seconds - ensures stale data auto-cleaned
- **Write throughput**: 100,000+ position updates/second globally - Cassandra's write path (commit log + memtable) handles this efficiently
- **Counter tables**: request counts per geohash for surge multiplier computation

### Junior → FAANG: Reading Case Studies as a Junior

Case studies are a shortcut to senior intuition, but only if you read them actively. As a junior you should pull three things from each: the access pattern, the partition key choice, and the operational tradeoff they accepted. Do not memorize node counts. Those are marketing. Memorize why the key is shaped that way.

Worked example on the Discord entry. The partition key is `(channel_id, bucket, message_id)` in the real production schema, where `bucket` is a derived value that caps partition size at roughly 10 million messages. The book snippet above simplifies it. Ask yourself on a whiteboard: why is `bucket` there? Because a Discord channel like a popular Minecraft server can receive a billion messages in a year. A single partition at that size would blow past the soft 100MB and hard 100 million cell limits, and every read would stream a compaction-sized blob across the network. Adding `bucket = floor(message_id / 10_000_000)` shards the logical channel into partitions that stay in the 100MB sweet spot. This is the single most important wide-column pattern you will meet in interviews, and Discord's engineering blog is where it was popularized.

First-job reflex: "why did this fail?" When a senior points to a case study and says the design failed, walk the same three-column audit. For Uber's pre-2016 Schemaless-on-Cassandra design the access pattern was OLTP trip state, the partition key was `trip_uuid`, and the tradeoff was operational complexity. The failure mode was secondary indexes. Schemaless bolted MySQL-backed indexes on top of Cassandra because Cassandra's native secondary indexes do not scale. That hybrid broke during multi-region failover. The lesson: if your access pattern needs arbitrary secondary lookups at scale, wide-column is not enough on its own. Either denormalize into query-specific tables or put a search index (Elasticsearch, OpenSearch) in front.

Entry-point interview question. "Design Discord's message storage from scratch." Start with access patterns: load last N messages in a channel, jump to a message by id, search by user across a server. Then propose the schema. Then explain TWCS aligned to the roughly 10-day time buckets Discord embeds in the partition key, so each SSTable window matches one bucket and compaction never rewrites a closed window. Then volunteer the bucketing trick before the interviewer asks. That sequence is exactly what an L4 panel scores you on.

### Senior @ FAANG: Case Studies as ADR Material and the Discord Migration Decision

At staff and principal level the job is to read these case studies as ADRs and to write your own when you propose something similar. The Discord 2022 migration from Cassandra to ScyllaDB is the most-cited wide-column ADR of the last five years, and it is worth reconstructing.

Decision drivers Discord published. Latency p99 on the hottest partitions was drifting up as channel volume grew. Node count was approaching 177 Cassandra nodes for the messages service and operational overhead was dominated by GC pauses on the JVM, repair coordination, and compaction backlogs. ScyllaDB offered a thread-per-core shard-nothing architecture in C++ with no JVM, tablet-based sharding that rebalanced hot partitions automatically, and a claimed 10x to 40x cost efficiency on equivalent hardware.

Decision criteria ADR template. When you propose Cassandra versus ScyllaDB at staff level, your ADR must cover at least these axes.

1. Protocol compatibility. Both speak CQL. Driver changes are minimal. Migration risk is real but bounded.
2. Operational model. Cassandra needs Reaper for repair and careful JVM tuning. ScyllaDB Manager handles repair natively and has no JVM. If your SRE org already owns JVM expertise Cassandra stays cheaper to run. If not, ScyllaDB's operational surface is smaller.
3. Consistency semantics. Both support tunable consistency. ScyllaDB's LWT implementation is faster but still Paxos-based and still a hot-path antipattern. Neither buys you real transactions.
4. Feature parity. Cassandra 5.0 adds vector search, storage-attached indexes (SAI), and UCS. ScyllaDB 6.0 ships tablets GA, Raft-managed topology, and Alternator (DynamoDB API). If you need SAI today, Cassandra. If you need DynamoDB-compatible API plus tablet rebalancing, ScyllaDB.
5. Cost model. Include hardware cost, support contract (DataStax versus ScyllaDB Enterprise), and migration engineering cost. Discord's migration took roughly 10 months of a dedicated team and moved trillions of messages with dual-write and checksum reconciliation.
6. Exit strategy. Always include a rollback plan. Dual-write with idempotent keys gives you a clean rollback for at least the first quarter after cutover.

Other case studies worth mining for ADR patterns.

Netflix on Cassandra at petabyte scale. The ADR here is "stay on Cassandra and invest in tooling." Netflix wrote Priam for backups, Raigad and Atlas for metrics, and contributed heavily upstream. At 10,000+ nodes, the cost of migrating dwarfs the cost of owning the operational surface. Lesson: at petabyte scale migration itself is the risk, not the destination.

Instagram messaging. Ran on HBase, migrated toward a Cassandra-style store for Direct Messages with per-user sharding plus write-through Redis caching. The ADR pattern: wide-column is the durable tier, a cache tier absorbs hot reads, and the partition key is always a user or conversation id that bounds fan-out.

Apple's Cassandra fleet. Runs one of the largest known Cassandra deployments (160,000+ instances disclosed at a Cassandra Summit). ADR pattern: heavy investment in tooling, a dedicated fork for internal patches, and LWT used extensively for Keychain but isolated to small partitions. Lesson: LWT is not forbidden, it is a scalpel.

eBay, Reddit, Spotify, Crunchyroll. Common thread is time-series on TWCS plus a search index in front for anything non-key-based. Reddit specifically uses Cassandra for vote storage with per-post partitioning and a separate Postgres store for canonical post metadata. The ADR pattern: use wide-column for the high-write append-y surface, use a relational store for anything that needs joins, transactions, or admin UI.

Uber Schemaless to Docstore. Uber's later migration from Schemaless (MySQL-backed) to Docstore (in-house on top of its own storage) is the counter-case. They concluded that neither Cassandra nor ScyllaDB gave them the transactional semantics they needed for trip state, and built their own. Lesson for staff engineers: "build vs buy vs adopt open source" is a real three-way decision, and at Uber's scale build occasionally wins. At your scale it almost never does. Document why you are not building your own.

Maturity model for case-study adoption.

L1 Copy-paste. Team reads a blog post, ships the same schema, discovers the blog omitted the bucket column, gets paged.
L2 Adapted. Team reads the blog, adapts the schema to their access pattern, ships with the documented operational footprint.
L3 Evaluated. Team writes a short internal doc comparing two or three published designs, picks one, records the tradeoff.
L4 ADR-grade. Team writes a full ADR with decision criteria, cost model, rollback plan, and exit strategy, reviewed by a bar-raiser.
L5 Contributing back. Team publishes its own case study, upstreams patches, and influences future architectural designs.

---
