## 37D.8 Replica Sets & Sharding

### Replica Set Configuration

Replica sets provide high availability through automatic failover, while sharding distributes data across nodes to scale writes horizontally. The code below demonstrates how to configure read preferences for replica sets and route writes through a shard-aware client.

```go
package mongodb

// Replica set: 3-node configuration
// mongodb.conf for each node:
// replication:
//   replSetName: "rs0"
//   oplogSizeMB: 10240

// Initialize replica set (run once on primary):
// rs.initiate({
//   _id: "rs0",
//   members: [
//     { _id: 0, host: "mongo1:27017", priority: 2 },
//     { _id: 1, host: "mongo2:27017", priority: 1 },
//     { _id: 2, host: "mongo3:27017", priority: 1, hidden: false }
//   ]
// })

// Connection string for replica set
const replicaSetURI = "mongodb://mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&readPreference=secondaryPreferred&authSource=admin"

// ReadPreference strategies
// - primary: always read from primary (consistent)
// - primaryPreferred: primary unless unavailable
// - secondary: always read from secondary (lower latency, potentially stale)
// - secondaryPreferred: secondary when available (read scale-out)
// - nearest: lowest latency node (good for geo-distributed)

// Write concern levels:
// - 0: no acknowledgment (fire-and-forget)
// - 1: primary acknowledged (default)
// - majority: majority of voting members (durable)
// - "all": all nodes (highest durability, lower availability)
```

### Sharded Cluster Shard Key Design

Shard key selection is the most consequential decision in a sharded MongoDB deployment. Since MongoDB 4.4 you can *refine* a shard key by appending fields, and 5.0 introduced live `reshardCollection`, but both operations are expensive at scale and should not be relied on as a safety net. Pick the right key up front.

A good shard key has three properties - evaluate every candidate against all three:

1. **High cardinality** - many distinct values so chunks can be split finely. Booleans and low-cardinality enums make terrible shard keys because every value forms one unsplittable chunk.
2. **Even write distribution** - inserts should spread across shards, not concentrate on one. Monotonically increasing keys (`ObjectID`, timestamps, auto-increment IDs) route every new document to the same trailing chunk, creating a single-shard write bottleneck. Fix with a hashed shard key (`{user_id: "hashed"}`) or by leading the key with a high-cardinality non-monotonic field.
3. **Query targeting** - your most common queries should include the shard key so `mongos` can route to a single shard rather than broadcasting. A shard key that distributes writes beautifully but forces every read to scatter-gather across all shards is a net loss.

For multi-tenant SaaS workloads, `{tenant_id: 1, _id: 1}` (or `{tenant_id: "hashed"}` if tenants are similar-sized) typically dominates: tenant queries are single-shard, writes distribute by tenant hash, and one noisy tenant cannot drown out others. For time-series, lead with the metadata key (`{sensor_id: 1, ts: 1}`) rather than `ts` alone.

```go
// Shard key selection is critical - cannot be changed after sharding

// BAD shard key: monotonic (ObjectID) → all writes go to one shard
// db.orders.createIndex({ _id: "hashed" })
// sh.shardCollection("mydb.orders", { _id: "hashed" })

// GOOD shard key: compound with cardinality + write distribution
// sh.shardCollection("mydb.orders", { user_id: "hashed", created_at: 1 })

// Zone sharding for data locality
// sh.addShardToZone("shard01", "US")
// sh.addShardToZone("shard02", "EU")
// sh.updateZoneKeyRange("mydb.users",
//   { region: "US", _id: MinKey },
//   { region: "US", _id: MaxKey },
//   "US"
// )

// Sharding manager in Go
type ShardingManager struct {
	client *mongo.Client
}

func (m *ShardingManager) GetShardDistribution(ctx context.Context, collName string) (bson.M, error) {
	db := m.client.Database("admin")
	result := db.RunCommand(ctx, bson.D{
		{Key: "collStats", Value: collName},
		{Key: "verbose", Value: true},
	})

	var stats bson.M
	if err := result.Decode(&stats); err != nil {
		return nil, err
	}
	return stats, nil
}

func (m *ShardingManager) EnableSharding(ctx context.Context, database string) error {
	return m.client.Database("admin").RunCommand(ctx, bson.D{
		{Key: "enableSharding", Value: database},
	}).Err()
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

Junior engineers often arrive with two misconceptions. The first is that "replica set" and "cluster" mean the same thing. They do not. A replica set is a group of MongoDB nodes replicating the same data for availability. A sharded cluster is multiple replica sets (each called a shard) partitioning data for scale, fronted by `mongos` routers and backed by a config-server replica set holding the routing metadata. Most production MongoDB deployments are replica sets, not sharded clusters, because three nodes with good indexes handle a surprising amount of traffic.

The second misconception is that sharding is a knob you turn on when things get slow. It is not. Sharding is a schema decision. You pick a shard key, and that key determines every future read pattern. Adding sharding to a live collection requires `shardCollection` plus potentially `reshardCollection`, both of which move terabytes around the network. Entry-level engineers should never propose sharding without a migration plan approved at staff level.

A worked first-job example: your team has a three-node replica set `rs0`. A query dashboard is slow, and a senior tells you to "push analytics reads off the primary". You change the driver option to `readPreference=secondaryPreferred` and add `maxStalenessSeconds=90`. Reads now fan to the two secondaries, latency on the dashboard drops, and the primary has headroom for writes. The interview question attached to this pattern is "what are the five read preferences and when would you use each". Memorize `primary`, `primaryPreferred`, `secondary`, `secondaryPreferred`, and `nearest`, plus `maxStalenessSeconds` and the role of tag sets.

### Senior at FAANG: Staff and Principal Material

**Replica-set topologies: PSS versus PSA and why arbiters are an anti-pattern since 5.0.** A three-node Primary-Secondary-Secondary (PSS) set tolerates one node loss with full durability at `w:majority`. A Primary-Secondary-Arbiter (PSA) set looks cheaper because the arbiter stores no data, but after a secondary fails the primary cannot satisfy `w:majority` on a two-voter set without an arbiter vote, and historically this led to silent data loss on rollback. Since MongoDB 5.0 the server flags PSA as problematic and recommends PSS. The staff-level rule is: no arbiters in production. If cost is the concern, use a `priority: 0, hidden: true, votes: 1` data-bearing analytics node instead of an arbiter.

**Election math and priority.** The primary is elected by a majority of voting members. `priority` biases who wins the election. `votes: 0` means the node participates in replication but not in elections. `hidden: true` removes the node from driver discovery so clients never route reads there. For a geo-distributed deployment the pattern is often: three voting data-bearing nodes in the primary region, two `priority: 0` nodes in the DR region for disaster recovery without cross-region election latency. Know `electionTimeoutMillis` (default 10 seconds), `catchUpTimeoutMillis`, and the trade-off between fast failover and flapping under network partition.

**Tag sets for read routing.** Replica-set tags (`{ "region": "us-east", "purpose": "analytics" }`) let drivers target specific members with `readPreferenceTags`. This is how you pin an analytics workload to a dedicated hidden secondary without touching application routing logic. The driver composes the tag set with `maxStalenessSeconds` so stale or lagging tagged members fall out of the selection set.

**Shard-key selection: hashed versus ranged.** A hashed shard key gives uniform write distribution at the cost of range-query targeting. `find({ _id: { $gte: X, $lt: Y } })` on a hashed shard is a scatter-gather. A ranged key on a high-cardinality compound like `{ tenant_id: 1, created_at: 1 }` preserves range queries and keeps per-tenant data co-located, but demands that `tenant_id` be uniformly distributed across tenants, which is rarely true in SaaS. The senior compromise is often compound ranged with a leading hash bucket, for example `{ bucket: 1, tenant_id: 1, created_at: 1 }` where `bucket` is a derived field `hash(tenant_id) % 64`. This bounds hotspots while preserving tenant-scoped range reads.

**Jumbo chunks and chunk splits.** A chunk that cannot be split because all its documents share the same shard-key value is a jumbo chunk. Jumbos block the balancer, cause unbalanced storage, and eventually starve one shard of CPU. Prevent them by ensuring the trailing field of the shard key has high cardinality, for example adding `_id` to the end of a compound key. Monitor `sh.status()` for chunks flagged `jumbo: true` and plan a manual split or re-shard before they become operational.

**Balancer windows and chunk migrations.** Each chunk migration is an online copy plus a brief writer-blocking commit. On write-heavy clusters, balancer activity during business hours causes p99 latency spikes. Configure balancer windows to run at low-traffic times: `sh.setBalancerState(true)` with `activeWindow`. For reshardCollection and addShard operations, size the migration bandwidth against your replication lag budget.

**Zones and tags for geo-sharding.** `sh.addShardToZone` and `sh.updateZoneKeyRange` let you pin key ranges to specific shards. The canonical use case is data-residency compliance: `{ region: "EU", ... }` ranges go to EU-hosted shards only. Zones enforce this at the config-server level so a rogue client cannot route EU data to a US shard. Pair zones with TLS-enforced network segmentation so even a compromised app server cannot bypass the policy.

**When to shard.** The honest staff answer is "not until you have to". Indexes, read preferences, and right-sized hardware solve most problems. Shard when a single replica set's working set no longer fits in RAM, when write throughput cannot be absorbed by one primary, or when compliance requires geo-partitioning. Sharding adds operational complexity (balancer, config servers, cross-shard transactions, chunk migrations) that you pay for forever.

---
