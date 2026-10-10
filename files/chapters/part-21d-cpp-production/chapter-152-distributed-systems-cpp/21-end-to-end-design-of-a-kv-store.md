## End-to-End Design of a Sharded Replicated KV Store in C++23

This section walks through a complete design for a sharded, replicated, persistent key-value store. The target is something between RocksDB and TiKV: per-shard Raft replication, LSM storage, range sharding, online resharding, snapshots, and recovery. The implementation language is C++23. The components below are the same as those in production systems like Apache Kudu, TiKV (predecessor codebases), and CockroachDB's storage layer.

The goal is not to build the entire system in one chapter. The goal is to walk a senior engineer through the architecture with enough code to see how the pieces fit, with the discipline that makes the design correct.

### High-Level Architecture

```
              ┌─────────────────────────────────────────────────┐
              │                   Clients                       │
              └────────────────┬────────────────────────────────┘
                               │ gRPC
              ┌────────────────▼────────────────────────────────┐
              │            Coordinator (Raft group)             │
              │   Routing table, shard assignment, schema       │
              └────────────────┬────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼────┐            ┌────▼────┐            ┌────▼────┐
   │ Shard 1 │            │ Shard 2 │            │ Shard 3 │  ...
   │ (Raft)  │            │ (Raft)  │            │ (Raft)  │
   │ N=3     │            │ N=3     │            │ N=3     │
   └─────────┘            └─────────┘            └─────────┘
   each Raft peer = a tablet server with its own LSM
```

Coordinator is small (config and routing). Shards do the data work. Each shard is a Raft group of three replicas, each replica is a tablet server with its own LSM tree.

### Component 1: API

```cpp
namespace kv {

class Client {
public:
    absl::Status Put(std::string_view key, std::string_view value,
                     std::chrono::milliseconds deadline);
    absl::StatusOr<std::string> Get(std::string_view key,
                                    std::chrono::milliseconds deadline);
    absl::Status Delete(std::string_view key,
                        std::chrono::milliseconds deadline);
    absl::StatusOr<std::vector<std::pair<std::string, std::string>>>
        Scan(std::string_view start, std::string_view end, size_t limit,
             std::chrono::milliseconds deadline);
};

}  // namespace kv
```

Linearizable reads and writes within a key. Range scans are read-committed snapshot isolation (each read sees a consistent snapshot, range scan does not block writes).

### Component 2: Sharding

Range sharding by key. The coordinator maintains a routing table: a sorted list of (start_key, shard_id) entries. A key's shard is the entry whose start_key is the largest <= key.

```cpp
class RoutingTable {
public:
    ShardId Lookup(std::string_view key) const {
        auto it = std::upper_bound(ranges_.begin(), ranges_.end(), key,
            [](std::string_view k, const Range& r) { return k < r.start; });
        if (it == ranges_.begin()) return kNoShard;
        return std::prev(it)->shard;
    }

    void Split(ShardId src, std::string_view at, ShardId new_shard) {
        // Insert new range at split point. Coordinator-side, replicated.
    }

    void Merge(ShardId left, ShardId right) {
        // Range-adjacent shards combine. Coordinator-side, replicated.
    }

private:
    struct Range { std::string start; ShardId shard; };
    std::vector<Range> ranges_;
};
```

The routing table is stored in the coordinator's Raft log. Clients cache it with a TTL plus invalidation on stale-routing errors.

### Component 3: Shard (Raft + LSM)

Each shard is a Raft group of N replicas (N=3 for the default). Every Raft peer is a tablet server with its own LSM.

```cpp
class TabletServer {
public:
    void Start() {
        wal_ = std::make_unique<Wal>(data_dir_ / "wal");
        lsm_ = std::make_unique<Lsm>(data_dir_ / "lsm");
        raft_ = std::make_unique<RaftNode>(node_id_, peers_, wal_.get(),
                                           [this](const auto& e) { Apply(e); });
        raft_->Start();
    }

    absl::Status HandleClientPut(const PutRequest& req) {
        if (!raft_->IsLeader()) return absl::FailedPreconditionError("not leader");
        return raft_->Propose(SerializePut(req)).get();
    }

private:
    void Apply(const RaftLogEntry& e) {
        auto cmd = ParseCommand(e.data);
        switch (cmd.kind) {
            case CommandKind::Put: lsm_->Put(cmd.key, cmd.value); break;
            case CommandKind::Delete: lsm_->Delete(cmd.key); break;
        }
        last_applied_ = e.index;
        if (e.index - last_snapshot_ > snapshot_interval_) MaybeSnapshot();
    }

    NodeId node_id_;
    std::vector<NodeId> peers_;
    std::filesystem::path data_dir_;
    std::unique_ptr<Wal> wal_;
    std::unique_ptr<Lsm> lsm_;
    std::unique_ptr<RaftNode> raft_;
    uint64_t last_applied_ = 0;
    uint64_t last_snapshot_ = 0;
    uint64_t snapshot_interval_ = 100'000;
};
```

The Raft log is the single source of truth for command order. The LSM is the materialized state. Both must survive a crash, the WAL fsync discipline applies.

### Component 4: LSM (per-shard storage)

Reuse the implementation from chapter 16: skip-list memtable, SSTable file format with bloom filters, level compaction. Per-shard, so a tablet server hosting K shards has K independent LSMs.

```cpp
class Lsm {
public:
    void Put(std::string key, std::string value) {
        std::lock_guard lock(mu_);
        memtable_->Insert(std::move(key), std::move(value));
        if (memtable_->ApproxBytes() > kMemtableThreshold) FlushAsync();
    }

    void Delete(std::string key) {
        std::lock_guard lock(mu_);
        memtable_->Insert(std::move(key), kTombstone);
    }

    std::optional<std::string> Get(std::string_view key) {
        std::shared_lock lock(mu_);
        if (auto v = memtable_->Lookup(key)) {
            if (*v == kTombstone) return std::nullopt;
            return *v;
        }
        for (auto& sst : sstables_) {
            if (!sst->BloomMaybeContains(key)) continue;
            if (auto v = sst->Lookup(key)) {
                if (*v == kTombstone) return std::nullopt;
                return *v;
            }
        }
        return std::nullopt;
    }

private:
    void FlushAsync() {
        // Move current memtable to immutable, allocate new mutable.
        // Schedule background flush to disk SSTable.
    }

    std::shared_mutex mu_;
    std::unique_ptr<SkipList<std::string, std::string>> memtable_;
    std::vector<std::shared_ptr<SSTable>> sstables_;
    static constexpr size_t kMemtableThreshold = 64 * 1024 * 1024;
    static constexpr std::string_view kTombstone = "\xFF\xFF\xFF\xFF";
};
```

### Component 5: Snapshots

Each Raft group periodically snapshots its LSM. The snapshot is a consistent point-in-time image: all SSTables plus the last_applied index. New replicas catch up by transferring the snapshot.

```cpp
struct ShardSnapshot {
    uint64_t last_applied_index;
    uint64_t last_applied_term;
    std::vector<std::filesystem::path> sstable_files;
    std::string sha256;
};

ShardSnapshot TakeSnapshot(Lsm* lsm, uint64_t idx, uint64_t term) {
    auto snap_dir = data_dir_ / ("snap-" + std::to_string(idx));
    lsm->FlushMemtable();  // ensure all state is on disk.
    auto files = lsm->HardlinkSstablesTo(snap_dir);  // immutable file refs.
    auto checksum = ComputeChecksum(files);
    return {idx, term, files, checksum};
}
```

Hardlinking is the production trick: SSTables are immutable, so a snapshot can hardlink them rather than copying. The snapshot's storage cost is metadata-only until compaction deletes the original SSTables.

### Component 6: Snapshot Transfer

A new replica or a far-behind follower receives the snapshot via a streaming RPC.

```cpp
// Sender (the leader).
class SnapshotSender {
public:
    void Send(NodeId target, const ShardSnapshot& snap, RpcStream* out) {
        for (const auto& f : snap.sstable_files) {
            std::ifstream in(f, std::ios::binary);
            char buf[64 * 1024];
            while (in.read(buf, sizeof(buf)) || in.gcount() > 0) {
                out->Write(SnapshotChunk{f.filename(), in.gcount(), buf});
            }
        }
        out->Write(SnapshotComplete{snap.last_applied_index, snap.sha256});
    }
};

// Receiver.
class SnapshotReceiver {
public:
    absl::Status Receive(RpcStream* in) {
        while (auto msg = in->Read()) {
            if (auto* c = std::get_if<SnapshotChunk>(&*msg)) {
                AppendChunk(*c);
            } else if (auto* d = std::get_if<SnapshotComplete>(&*msg)) {
                if (ComputeChecksum() != d->sha256) return absl::DataLossError("");
                lsm_->LoadFrom(staging_dir_);
                last_applied_ = d->last_applied_index;
                return absl::OkStatus();
            }
        }
        return absl::AbortedError("stream ended early");
    }
};
```

### Component 7: Resharding

A shard whose data exceeds a threshold splits. Procedure:

1. Coordinator picks a split key (median of the shard's keyspace, computed from the LSM).
2. Coordinator proposes a split through its own Raft.
3. Each replica of the source shard creates two new Raft groups for the halves, populated by hardlinking SSTables and re-routing memtable entries.
4. Routing table updates atomically (committed via coordinator Raft).
5. Old shard is decommissioned once all replicas confirm.

The atomicity of step 4 is what prevents split-brain during the transition. Clients with stale routing get a `WrongShard` error and refresh.

### Component 8: Recovery

On startup, a tablet server replays its WAL into the memtable to recover unflushed data, then loads its SSTables, then rejoins its Raft groups. Raft handles log replay from peers if the node was offline for a snapshot interval.

```cpp
void TabletServer::Recover() {
    lsm_->LoadSstablesFromDisk();
    wal_->Replay([this](const Entry& e) { lsm_->Apply(e); });
    raft_->RejoinGroups();
    if (raft_->LogIndex() < raft_->Leader()->LogIndex() - kSnapshotThreshold) {
        raft_->RequestSnapshotInstall();
    }
}
```

### Component 9: GC

Tombstones and old versions are dropped during compaction. The compaction process scans all SSTables in a level, writes one consolidated SSTable, and removes the inputs. A tombstone older than the GC grace period (e.g., 7 days) and not visible from any live snapshot can be physically dropped.

```cpp
void CompactLevel(int level) {
    auto inputs = PickInputsForCompaction(level);
    SSTableBuilder builder(level + 1);
    Iterator merged = MergeIterator(inputs);
    auto gc_horizon = OldestVisibleSnapshot();
    while (merged.Valid()) {
        if (merged.IsTombstone() && merged.SequenceNum() < gc_horizon) {
            merged.Next();  // drop.
            continue;
        }
        builder.Add(merged.Key(), merged.Value());
        merged.Next();
    }
    builder.Finish();
    AtomicallySwapInputsForOutput(inputs, builder.Output());
}
```

### Component 10: End-to-End Write Path

1. Client computes shard from routing table cache.
2. Client sends Put RPC to that shard's leader.
3. Leader's RaftNode appends to its log, fsyncs, sends AppendEntries to followers.
4. Followers fsync, ack.
5. When majority has ack'd, commit_index advances, leader applies via state-machine callback.
6. State-machine callback calls Lsm::Put.
7. Lsm::Put inserts into memtable. If memtable is full, schedule a background flush.
8. Background flush writes a new SSTable, updates the LSM file list, fsyncs the manifest.
9. Leader replies OK to client.

### End-to-End Read Path

1. Client computes shard from routing.
2. Client sends Get RPC to any replica (with read-your-writes preferred to leader).
3. For linearizable reads on the leader: read-index optimization (record commit_index, send heartbeat round, serve once that index is applied).
4. For lease-bounded reads: serve from the leader without heartbeat round if lease is still valid.
5. For follower reads: serve at most last-applied-on-leader-as-of-recent-heartbeat. Acceptable for read-eventually-consistent or read-bounded-staleness clients.
6. Lsm::Get checks memtable, then SSTables in order (newest first), short-circuiting on bloom filter negatives.

### Performance Targets

For commodity hardware (NVMe SSD, 100 GbE, 32 cores, 128 GB RAM):
- Per-shard write throughput: 50K-200K writes/sec.
- Per-shard read throughput (linearizable): 100K-500K reads/sec.
- Per-shard read throughput (stale): 500K-2M reads/sec.
- p99 write latency: under 5 ms intra-zone, under 20 ms cross-zone.
- p99 linearizable-read latency: under 2 ms intra-zone.

These are achievable numbers for a well-engineered C++ implementation. TiKV, RocksDB-as-a-service products, and ScyllaDB hit them in production.

### Key Design Decisions

1. **Per-shard Raft** over global Raft: scales horizontally, isolates failures.
2. **Range sharding** over hash: range scans, splits, and locality-aware placement.
3. **LSM** over B-tree: write throughput, sequential I/O.
4. **Hardlink-based snapshots** over copy: amortized snapshot cost.
5. **Replicated coordinator** over a leader-elected coordinator: same Raft pattern as shards, no special case.
6. **Routing-table caching with stale-correction** over per-request lookup: latency.

### Open Production Concerns Not Detailed Here

- Backup and restore (point-in-time recovery).
- Cross-region replication for DR.
- Multi-tenancy and quota enforcement.
- Encryption at rest and in transit.
- Online schema changes if the data model is richer than KV.

Each of these is a multi-month project on top of the design above. A senior engineer scopes them as separate work, a staff engineer designs the architecture so they integrate cleanly.

### Junior at FAANG: The Design Question

When asked "design a distributed KV store on a whiteboard", the senior answer is the architecture above: routing in a coordinator, Raft per shard, LSM per replica, range sharding with online split, snapshot transfer for new replicas, fence tokens for split-brain prevention, and a clear separation between control plane (coordinator) and data plane (shards). The L6 candidate also discusses the operational story: how reshards happen, how a node recovers, how a region failover works.

That is a complete answer. Practice it.

---
