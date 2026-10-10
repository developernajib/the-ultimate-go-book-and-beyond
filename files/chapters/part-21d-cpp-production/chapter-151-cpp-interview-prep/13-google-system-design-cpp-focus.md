## Google System Design with C++ Focus

The Google system design round is 45 to 60 minutes. The interviewer presents a problem like "design a feature flag service" and watches you build it from requirements to deployment. For C++ infrastructure roles, the design has a specific texture: storage choice matters, RPC framing matters, memory layout matters, and you are expected to argue at the level of bytes and nanoseconds when relevant. This file covers three canonical questions and what L5 vs L6 answers look like.

### The Standard Frame

Every design starts with the same frame:

1. Clarify requirements (functional, non-functional).
2. Estimate scale (QPS, data size, growth rate).
3. Define the API.
4. Sketch the high-level architecture.
5. Drill into one or two components in depth.
6. Discuss failure modes, scaling, and operations.

The interviewer steers depth. If they want to discuss storage, you discuss storage. If they want to drill into the C++ implementation of a hot path, you drop down to memory layout.

### Question 1: Design a Feature Flag Service

Functional: clients (other services) ask "is feature X on for user Y?". Operators flip flags on or off, ramp percentages, target by attribute.

#### Clarifying questions

- Read QPS? Across all client services, easily 1M+ QPS at a large company.
- Latency budget? Sub-millisecond p99, since flags are evaluated on every request.
- Number of flags? Tens of thousands, growing.
- Targeting complexity? Boolean, percentage, attribute-based (country, app version, internal/external)?
- Consistency? When an operator flips a flag, how soon must all clients see the change? Seconds is fine.

#### Scale estimate

- 10M QPS peak read across all services.
- 10k flags, each ~1 KB of config (rules, percentages). 10 MB total.
- The full flag set fits in memory on every client. This shapes the design.

#### API

Clients embed a library that holds the flag set in memory. The library provides:

```cpp
class FlagClient {
 public:
  bool IsEnabled(absl::string_view flag, const Context& ctx) const;
  std::optional<std::string> Variant(absl::string_view flag, const Context& ctx) const;
};
```

Evaluation is a pure local computation. No RPC on the read path. This is the L5 insight that beats every "let me design a Redis-backed flag service" answer.

#### Architecture

```
+-----------+      +-----------+      +------------+
| Operator  |----->| Admin API |----->| Storage    |
| UI        |      | Service   |      | (Spanner)  |
+-----------+      +-----------+      +------------+
                                            |
                                            v
                                     +------------+
                                     | Distrib.   |
                                     | (PubSub or |
                                     |  push RPC) |
                                     +------------+
                                            |
                                            v
                       +------+------+------+------+------+
                       |      |      |      |      |      |
                  +--------+ ... thousands of client SDKs in services
                  | Client |
                  | SDK    |
                  | (C++)  |
                  +--------+
```

The admin path is low-QPS. The distribution path is fan-out. The client path is in-process.

#### C++ Client SDK Internals

The SDK is the interesting part. It needs:

- A snapshot of the flag set, atomically swappable.
- Sub-microsecond evaluation (no syscalls, no allocation).
- A background thread that polls or subscribes for updates.
- Graceful handling of distribution failures (keep the last known state).

```cpp
class FlagSet {
 public:
  bool Evaluate(absl::string_view flag, const Context& ctx) const;
 private:
  absl::flat_hash_map<std::string, FlagRule> rules_;
};

class FlagClient {
 public:
  bool IsEnabled(absl::string_view flag, const Context& ctx) const {
    auto snap = std::atomic_load(&snapshot_);
    return snap->Evaluate(flag, ctx);
  }

  void Update(std::shared_ptr<const FlagSet> new_set) {
    std::atomic_store(&snapshot_, std::move(new_set));
  }

 private:
  std::shared_ptr<const FlagSet> snapshot_;  // atomic_load / atomic_store
};
```

`std::atomic_load` on a `shared_ptr` is the key trick. Readers do an atomic ref-count bump. Writers swap in a new snapshot. No reader blocks. The old snapshot is freed when the last in-flight reader drops it.

(In C++20, `std::atomic<std::shared_ptr<T>>` is the cleaner spelling.)

#### L5 Answer Highlights

- Local evaluation. No RPC on read.
- Atomic snapshot swap. No reader-writer lock.
- Background distribution thread.
- Last-known-good cache on disk for cold start before the distribution layer is up.

#### L6 Answer Highlights

L5 plus:

- Discusses the rollout path. How do we change the SDK without forcing every client to redeploy? Thin SDK, bumped via a non-binary-breaking mechanism. Versioned protocol.
- Multi-region. Distribution is per-region. Operators write to a primary region. Replication to others within seconds.
- Targeting hash stability. If the SDK uses a hash to bucket users into "10% rollout", the hash must be stable across SDK versions and across regions. Concretely: which hash function, why, what happens when an operator changes targeting attributes.
- Observability. Per-flag evaluation counts (sampled), exposure logging for A/B test analysis, but with privacy controls on PII in the context.
- Migration story. The flag service replaces some legacy config system. How do we migrate without disruption? Shadow mode, dual-read, audit, cutover.
- Cost. 10M QPS times a hash-table lookup is 10M ops/sec across the fleet. Negligible. Distribution costs are dominated by fan-out.

### Question 2: Design a Metric Ingestion Pipeline

Functional: services emit time-series data points (metric name, labels, timestamp, value). The pipeline ingests, stores, and serves queries.

#### Clarifying questions

- Write QPS? 100M to 1B data points per second at the company level.
- Query QPS? Lower, ~10k QPS for dashboards plus alerting.
- Cardinality (unique label combinations)? Tens of millions.
- Retention? 1 day at high resolution, 1 year at downsampled.

#### Architecture

```
Service --> Local Agent --> Aggregator --> TSDB (sharded) --> Query Service
              (batches)     (per-region)
```

The local agent batches points in-process, flushes every second. The aggregator pre-aggregates within a time window per region. The TSDB stores aggregated samples. Query service fans out to TSDB shards and merges.

#### C++ Local Agent

The local agent is in-process with the service. Hot path: emit a sample. The contention is between the service's many threads writing samples and the agent's flusher thread reading them.

```cpp
struct Sample { uint64_t metric_id; int64_t timestamp_us; double value; };

class LocalAgent {
 public:
  void Emit(uint64_t metric_id, double value) {
    auto now = absl::ToUnixMicros(absl::Now());
    auto& shard = shards_[Hash(metric_id) % kShards];
    shard.lock();
    shard.buffer.push_back({metric_id, now, value});
    shard.unlock();
  }

  void Flush();  // Called periodically by the flusher thread.

 private:
  static constexpr int kShards = 16;
  struct Shard {
    std::mutex mu;
    std::vector<Sample> buffer;
    void lock() { mu.lock(); }
    void unlock() { mu.unlock(); }
  };
  std::array<Shard, kShards> shards_;
};
```

Sharded buffers reduce contention. For the absolute hot path, use thread-local buffers and reconcile periodically.

#### Storage Layer (TSDB)

Sharding key: hash of (metric_name, label_set). Per-shard storage is a write-optimized format: chunked column store with delta-encoded timestamps and gorilla-encoded float values (Facebook Gorilla paper). One chunk per metric per few hours. Old chunks are compacted and downsampled.

Bigtable is a reasonable backing store. Row key: `metric_hash#bucket_start_ts`. Column family: chunks. This gives good locality for time-range scans.

#### L5 Answer

The pipeline above. Good understanding of write path optimization, sharding, query fan-out.

#### L6 Answer

L5 plus:

- High cardinality is the hard problem. New label combinations are an enemy. Discusses cardinality enforcement (drop labels that explode), per-tenant limits, alerts on cardinality growth.
- Backpressure. When the TSDB is overloaded, the aggregator drops oldest data, not newest. Why? Newest data is what alerting sees.
- Exactly-once vs at-least-once. Metrics are typically at-least-once with idempotent aggregation (sum of duplicate count is wrong, but min/max/last are robust). Discusses the trade-off.
- Cost. 1B writes/sec at \$X per million writes is a real budget. Compaction and downsampling are the only knobs that keep storage cost bounded over time.
- Multi-tenancy isolation. One bad tenant must not starve others. Per-tenant quotas, dedicated shards for hot tenants.

### Question 3: Design a Sharded Key-Value Store

Functional: `Put(key, value)`, `Get(key) -> value or null`, `Delete(key)`. Strong durability. Replication. No transactions across keys.

#### Clarifying questions

- Value size? Up to 1 MB.
- QPS? 100k writes, 1M reads.
- Latency? p99 5 ms read, 10 ms write.
- Consistency? Read-your-writes within a single client. Across clients, eventually consistent OK? Or linearizable?

The consistency model drives everything else. Linearizable means consensus per shard (Raft or Paxos). Eventually consistent means leaderless replication (Dynamo-style).

#### Pick: linearizable, Raft per shard

```
Client --> Router --> Shard Leader --> Followers (Raft replication)
                          |
                          v
                       Local LSM-tree
```

Sharding: consistent hash on key. 256 virtual shards initially, capable of resplitting.

Each shard is a Raft group of 5 replicas (3 minimum for fault tolerance, 5 for read scale via follower reads).

Storage on each replica: an LSM-tree (RocksDB). MemTable absorbs writes, SSTables are flushed and compacted on disk.

#### C++ Implementation Sketch

```cpp
class ShardServer {
 public:
  absl::Status Put(absl::string_view key, absl::string_view value) {
    if (!IsLeader()) return absl::FailedPreconditionError("not leader");
    LogEntry e{Op::kPut, std::string(key), std::string(value)};
    return ProposeAndWait(e);  // Raft: append, replicate, commit, apply.
  }

  absl::StatusOr<std::string> Get(absl::string_view key) {
    if (!IsLeader() && !AllowFollowerRead()) {
      return absl::FailedPreconditionError("not leader");
    }
    // Linearizable read on the leader: read after a no-op log barrier.
    // Or: bounded staleness on a follower.
    return db_->Get(key);
  }

 private:
  RaftNode raft_;
  std::unique_ptr<rocksdb::DB> db_;
};
```

#### L5 Answer

Sharding scheme, Raft replication, RocksDB storage, router with consistent hashing, basic failure handling (leader failover, reshard on capacity).

#### L6 Answer

L5 plus:

- Resharding without downtime. Live key migration between shards. Source serves until the target catches up, then a brief read-only window flips ownership.
- Hot key handling. A single key receiving 100k QPS overwhelms one shard. Detect, replicate the value into a read cache, possibly split the key into versioned variants.
- Cost vs durability. 5-replica Raft is expensive. Discuss EC (erasure coded) tier for cold data, full replication for hot.
- Backup and disaster recovery. Periodic snapshots to object storage, point-in-time recovery via log replay.
- Operator interface. How do operators inspect a shard's state, force a leader transfer, drain a node? CLI or RPC tools that integrate with the deployment system.
- Migration strategy. The team has an existing KV system. We are not building this in isolation, we are replacing something. Dual-write, shadow-read, validate, cut over per shard.
- Multi-region. Cross-region Raft is high latency. Per-region clusters with async replication, or geo-partitioned where each key has a home region.

### What L5 Misses That L6 Catches

| Topic | L5 | L6 |
|-------|----|----|
| Day-2 operations | Mentions monitoring | Designs the runbook, defines on-call rotation, writes the incident playbook |
| Migration | Acknowledges legacy exists | Sequences the migration, defines rollback points, estimates risk |
| Cost | Implicit | Explicit dollar estimate, knobs to reduce |
| Multi-region | "We can replicate" | Picks a topology with a defensible reason, discusses split-brain |
| Capacity planning | Single point estimate | Headroom for 2x growth, alarms before capacity is exhausted |
| Failure budgets | "It should be reliable" | Defines SLOs, error budgets, what we do when budget is exhausted |

### Communication Patterns That Score Well

- Restate the problem in your own words. "So we are designing X for Y users at Z scale."
- Surface assumptions. "I am assuming we need linearizability across keys, please correct me if not."
- Whiteboard structure. Boxes for services, arrows for traffic, annotations for QPS and latency.
- Time-box. "I will spend 5 minutes on the high-level architecture, then drill into the storage layer."
- Acknowledge gaps. "I have not designed a global ID generator before, here is how I would approach it from first principles."

### Senior at FAANG: Design Comes from Building

System design interview answers reflect what you have actually built. A candidate who has shipped a sharded service with reshard tooling answers the resharding question crisply. A candidate who has only read about it answers vaguely. The way to prepare is not to memorize answers, it is to build (or read deeply about) one or two real systems and own the details.
