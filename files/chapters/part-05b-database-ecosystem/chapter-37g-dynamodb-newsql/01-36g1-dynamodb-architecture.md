## 37G.1 DynamoDB Architecture

### The DynamoDB Model

DynamoDB stores items in partitions identified by a hash of the partition key. All items with the same partition key are co-located and sorted by the sort key. Capacity is provisioned (or auto-scaled) as read and write capacity units, and every operation must hit the partition key to avoid a costly full-table scan.

```
DynamoDB Architecture
═══════════════════════════════════════════════════════════════════

  Table Design:
  ┌────────────────────────────────────────────────────────────┐
  │  Primary Key = Partition Key (PK) + Sort Key (SK) (opt)    │
  │                                                            │
  │  PK: USER#123          SK: PROFILE          → user info    │
  │  PK: USER#123          SK: ORDER#2024-01    → order 1      │
  │  PK: USER#123          SK: ORDER#2024-02    → order 2      │
  │  PK: PRODUCT#abc       SK: METADATA         → product      │
  │  PK: PRODUCT#abc       SK: REVIEW#usr123    → review       │
  └────────────────────────────────────────────────────────────┘

  Single-Table Design: ALL entities in ONE table
  → Eliminates cross-table JOINs (they don't exist in DynamoDB)
  → Co-locates related data for efficient reads
  → Uses hierarchical PK/SK patterns

  Storage Model:
  ┌──────────────────────────────────────────────────────────┐
  │  Partition Key → consistent hash → partition (10GB max)  │
  │  Sort Key → sorts items within partition (range queries) │
  │                                                          │
  │  Storage Node (partition):                               │
  │  Leader   →  3x replication  →  Followers                │
  │             (Multi-AZ)                                   │
  └──────────────────────────────────────────────────────────┘

  Capacity Modes:
  ┌──────────────────┬────────────────────────────────────┐
  │  Provisioned     │  On-Demand                         │
  │  - Fixed RCU/WCU │  - Auto-scales                     │
  │  - Cheaper       │  - Pay per request                 │
  │  - Auto Scaling  │  - Good for unpredictable traffic  │
  │  available       │  - ~7x pricier at full use         │
  └──────────────────┴────────────────────────────────────┘

  Consistency:
  - Eventually Consistent Reads (default): may return stale
  - Strongly Consistent Reads: reads from leader (2x RCU cost)
  - Transactional Reads/Writes: ACID, uses 2x RCU/WCU
```

> **Senior track**: A single DynamoDB partition supports up to 3,000 RCU and 1,000 WCU before throttling. Adaptive capacity (now automatic and sub-second since 2019, further refined in 2025) silently rebalances heat, but it cannot save a table whose partition key has low cardinality. The mental model that survives production: `partition_key_cardinality * even_distribution = headroom`. If a single celebrity user, tenant, or product can dominate traffic, write-shard the key (append `#0`, `#1`, ..., `#N`) and fan out reads, or move hot items to a dedicated cache tier.

### DynamoDB vs Cassandra vs MongoDB

DynamoDB is not the only option for distributed NoSQL workloads. Cassandra offers a self-managed wide-column store with multi-datacenter replication, while MongoDB provides a document model with flexible querying. The table below compares their key characteristics to help you pick the right tool for a given workload.

| Feature | DynamoDB | Cassandra | MongoDB |
|---------|----------|-----------|---------|
| Managed | Fully (AWS) | DIY or Astra | Atlas or DIY |
| Data model | Key-value + document | Wide-column | Document |
| Max item size | 400KB | 16MB row | 16MB doc |
| Transactions | ✓ (single region) | LWT only | ✓ |
| Global tables | ✓ (multi-region) | Multi-DC replication | Atlas Global |
| Pricing | Per RCU/WCU | Infra cost | Infra or Atlas |
| Query flexibility | Low (access pattern driven) | Low | High |
| Full-text search | External (OpenSearch) | External | Atlas Search built-in |

### Junior to FAANG: reading the architecture diagram without hand-waving

The diagram above hides three numbers that matter more than all the boxes. A partition is capped at roughly 10GB of storage, 3000 RCU per second, and 1000 WCU per second. When any of those limits is hit, DynamoDB splits the partition, but the split takes minutes and only helps if the load is spread across multiple sort keys, not concentrated on one. Juniors who memorize these three numbers diagnose 80 percent of real DynamoDB incidents without opening the AWS console.

Worked example. You are on-call and alarms fire: `UserErrors` metric shows `ProvisionedThroughputExceededException` on a table with 20000 provisioned RCUs. The table is averaging 4000 RCU. How is it throttling? Because throughput is allocated per partition, not per table. If the table has 10 partitions, each gets 2000 RCU on average, and if one partition key is receiving 5000 RCU of traffic, it throttles regardless of the table-level budget. The fix is not more RCU. The fix is to find the hot key. Use Contributor Insights or a sampled Streams consumer to identify the offending `PK`, then write-shard it.

Consistency, junior lens. Default reads are eventually consistent, meaning they read from any of the three replicas and can return data up to a few hundred milliseconds stale. A strongly consistent read costs 2x RCU and routes to the leader. Do not sprinkle `ConsistentRead=true` everywhere as a reflex. Read-your-writes on the session owner is a legitimate use case. Rendering a public product page is not. Interview entry point: be ready to explain why a GSI cannot be strongly consistent (the GSI is asynchronously replicated from the base table, so there is no leader to read from that has guaranteed latest data) and why LSIs can (an LSI lives in the same partition as the base table and can be read from the same leader).

Capacity mode, first-job rule of thumb. On-demand costs roughly 7x provisioned at full utilization and roughly 1x at low utilization. The break-even point is around 14 percent utilization. For prototypes, dev environments, and spiky batch jobs, on-demand is correct. For steady-state production tables where p99 traffic is within 3x of the median, provisioned with auto-scaling is correct. Switching between modes is allowed once every 24 hours per table.

### Senior at FAANG: partition internals, adaptive capacity, and the physics of DynamoDB

The partition is the unit of everything in DynamoDB. Understanding it at the physical level is the difference between designing a table that scales to a billion items and designing one that falls over at 10 million. A partition is a B-tree shard stored on a single storage node, replicated synchronously to two additional nodes in other availability zones using a Paxos-like protocol. The leader serves all writes and strongly consistent reads. Followers serve eventually consistent reads. When a partition is split (because it crossed 10GB, 3000 RCU, or 1000 WCU for a sustained period), DynamoDB picks a midpoint in the sort key space and copies half the data to a new partition. The split is transparent to clients but briefly reduces available throughput on the old partition during the copy.

Adaptive capacity, in its current 2026 form, is a soft rebalancing layer that lets a single partition temporarily exceed its nominal 3000/1000 RCU/WCU allocation by borrowing unused capacity from sibling partitions on the same node. It kicks in within single-digit seconds and can absorb short bursts, but it cannot create capacity that does not exist on the underlying hardware. If your workload pins a single partition at 10000 WCU sustained, adaptive capacity will fail and you will see throttling. The only remedy is write sharding the partition key, which distributes the load across multiple physical partitions. Common shard count is 10 to 100 for celebrity-user style workloads, chosen by measuring the fan-out cost on read (you must query all N shards and merge).

Burst capacity is a separate mechanism. Each partition accumulates up to 300 seconds of unused capacity as a burst bucket. A partition provisioned at 1000 WCU that has been idle for 5 minutes can briefly sustain roughly 6000 WCU until the bucket drains. This is why load tests that ramp from zero to peak often pass while production workloads that run at steady state with spikes still throttle. The production failure mode: the bucket was empty when the spike arrived. Staff engineers design load tests that pre-warm tables and then issue spikes after steady-state is reached, which is the only realistic signal.

Auto-scaling versus on-demand, deeper. Auto-scaling uses CloudWatch alarms plus Application Auto Scaling to adjust provisioned capacity every few minutes toward a target utilization (typically 70 percent). It has two failure modes. First, it reacts in minutes, which is slower than most real spikes. Second, it has a floor and ceiling, and aggressive lower bounds can starve burst capacity. On-demand removes these concerns and instantly scales up to twice the previous peak observed in the last 30 minutes. For tables that routinely exceed this doubling (flash sales, viral events, cron stampedes), pre-warming on-demand by issuing synthetic load in the minutes before the event is a real technique used at FAANG retailers. AWS has a `UpdateTable` API that lets you pre-provision a known peak on on-demand tables, introduced in late 2024 and stable by 2026.

LSI versus GSI at the physics level. An LSI (Local Secondary Index) shares the partition of its base table and therefore shares RCU/WCU. You can only declare LSIs at table creation, you are limited to five per table, and an LSI forces the partition to stay under 10GB including all indexes. In exchange you get strongly consistent reads on the LSI and the LSI commits synchronously with the base item. A GSI (Global Secondary Index) is physically a separate table with its own partitions and its own provisioned throughput. Writes to the base table asynchronously propagate to the GSI, which means GSI reads are eventually consistent and GSI throttling can silently back-pressure base table writes (a condition called "GSI backpressure" where base table writes are throttled to protect the GSI from falling further behind). This is the single most common cause of mysterious write throttling in production DynamoDB. Monitor `ReturnedItemCount` and `ConsumedWriteCapacityUnits` per GSI, and size GSI capacity at 1.2 to 1.5x the base table write rate.

DynamoDB versus Cassandra versus ScyllaDB versus BigTable, staff-level. Cassandra and ScyllaDB expose the partition explicitly and let operators tune partition size, compaction strategy, and replication factor. This is more flexible but shifts operational burden to the team. ScyllaDB is Cassandra rewritten in C++ with a shard-per-core architecture, delivering 3 to 10x better throughput per node at the cost of a smaller ecosystem. BigTable (the internal Google system exposed via Cloud Bigtable) uses a single lexicographically sorted key space rather than partition plus sort key, which makes range scans across large key ranges first-class but eliminates the single-partition hot-key protection DynamoDB provides. AWS Keyspaces is managed Cassandra with DynamoDB-like pricing. It is an escape hatch for teams that want to decouple from DynamoDB without running Cassandra themselves, but it diverges on LWT semantics and secondary index support.

Strong consistency cost, revisited. A strongly consistent read is routed to the leader and charged at 2x. Under a partition where the leader is unreachable, strongly consistent reads fail. Under a partition where the follower-to-leader replication lag has spiked, eventually consistent reads return stale data for the duration of the lag (typically tens of milliseconds, occasionally seconds under AZ brownouts). Design read paths that default to eventual and opt into strong only when the caller can tolerate the failure mode. Transactional reads via `TransactGetItems` are strongly consistent and atomic across up to 100 items, at 2x cost plus a small transaction overhead. They are the right primitive for read-modify-write workflows, not a default read path.

Staff ADR checklist for a new DynamoDB table. List every access pattern with expected QPS and p99 latency target. Compute the RCU and WCU per pattern and sum. Identify the partition key and estimate cardinality and uniformity. Enumerate GSIs with their own projections and sizing. Document hot-key mitigation (sharding or cache). Specify capacity mode with a break-even calculation. Define TTL policy for cold data. Specify Streams consumers if any, with expected lag. Define PITR requirements. Document the migration exit plan even if it is "we will not migrate". If any section is blank, the design is not production ready.

---
