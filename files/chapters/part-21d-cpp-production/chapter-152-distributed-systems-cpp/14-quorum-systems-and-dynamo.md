## Quorum Systems and Dynamo-Style Replication

Quorum-based replication is the alternative to consensus for replicated storage. Instead of one leader serializing all writes, every write goes to W replicas and every read goes to R replicas. As long as `R + W > N`, every read intersects every write and observes the latest value. Amazon Dynamo (2007) popularized this design. Cassandra, Riak, ScyllaDB, and Voldemort all use it.

### The R + W > N Invariant

With N replicas:
- Write quorum W: minimum replicas that must acknowledge a write.
- Read quorum R: minimum replicas that must respond to a read.
- If `R + W > N`, the write set and read set always intersect.

A read with R replicas will always include at least one replica that participated in the most recent write. The reader picks the value with the latest timestamp, this is *last-write-wins* if you trust wall-clock or vector clock comparison.

```cpp
struct ReplicaResponse {
    std::optional<Value> value;
    HLC timestamp;
};

absl::StatusOr<Value> Read(Key k, int R) {
    std::vector<std::future<ReplicaResponse>> futures;
    for (auto* r : ReplicasFor(k)) {
        futures.push_back(r->ReadAsync(k));
    }
    std::vector<ReplicaResponse> responses;
    auto deadline = std::chrono::steady_clock::now() + 200ms;
    for (auto& f : futures) {
        if (f.wait_until(deadline) == std::future_status::ready) {
            responses.push_back(f.get());
            if (responses.size() >= static_cast<size_t>(R)) break;
        }
    }
    if (responses.size() < static_cast<size_t>(R)) {
        return absl::DeadlineExceededError("read quorum not met");
    }
    auto latest = std::max_element(responses.begin(), responses.end(),
        [](const auto& a, const auto& b) { return a.timestamp < b.timestamp; });
    return latest->value.value_or(Value{});
}
```

### Configuring R, W, N

| Profile | N | W | R | Property |
|---------|---|---|---|----------|
| Strong consistency, balanced | 3 | 2 | 2 | R+W=4>3 |
| Strong, write-fast | 3 | 1 | 3 | R+W=4>3 (slow reads) |
| Strong, read-fast | 3 | 3 | 1 | R+W=4>3 (slow writes) |
| Eventual, fastest | 3 | 1 | 1 | R+W=2 not >3 |
| Five-replica strong | 5 | 3 | 3 | R+W=6>5 |

The latency-vs-durability axis: increasing W reduces the probability of data loss after `f` simultaneous replica failures, at the cost of write latency dominated by the slowest of W replicas.

Cassandra exposes these as per-query consistency levels (`ONE`, `QUORUM`, `ALL`). DynamoDB exposes only two: eventually consistent (R=1) and strongly consistent (R=majority, fronted by Paxos for the write side).

### Sloppy Quorums and Hinted Handoff

Strict quorums fail when a replica is unavailable. A *sloppy quorum* relaxes this: the W writes go to *any* W reachable nodes, even if some are not the canonical replicas. The non-canonical nodes hold the data temporarily as *hints* for the canonical replica.

```cpp
class HintedHandoffQueue {
public:
    void StoreHint(NodeId target, Key k, Value v, HLC ts) {
        std::lock_guard lock(mu_);
        hints_[target].push_back({k, v, ts});
    }

    void OnReachable(NodeId n) {
        std::lock_guard lock(mu_);
        auto it = hints_.find(n);
        if (it == hints_.end()) return;
        for (const auto& h : it->second) replicator_.SendAsync(n, h);
        hints_.erase(it);
    }
};
```

Sloppy quorums increase availability at the cost of strict quorum guarantees. A read after a sloppy write may not see the write if it queries only canonical replicas. Anti-entropy (merkle-tree comparison, see chapter 11) fills this gap eventually.

### Read Repair

When a read sees stale values from some replicas, the coordinator updates them in-line. This is *read repair*.

```cpp
absl::StatusOr<Value> ReadWithRepair(Key k, int R) {
    auto responses = QueryReplicas(k, R);
    auto latest = MaxBy(responses, &ReplicaResponse::timestamp);
    for (const auto& r : responses) {
        if (r.timestamp < latest->timestamp) {
            // async write back the latest value to this replica.
            replicator_.WriteAsync(r.replica_id, k, latest->value, latest->timestamp);
        }
    }
    return latest->value;
}
```

Cassandra and Riak both implement this. The cost is extra write load on the read path, the benefit is that hot keys converge quickly without waiting for active anti-entropy.

### Active Anti-Entropy

Read repair fixes only keys that are read. Cold keys can drift undetected. Active anti-entropy (AAE) periodically compares replicas using merkle trees (chapter 11) and reconciles. The cost is constant background bandwidth, the benefit is bounded staleness.

Cassandra's `nodetool repair` runs AAE on demand. Riak's AAE runs continuously. ScyllaDB's repair is a redesigned, more efficient successor.

### Comparison with Raft

| Property | Raft | Quorum (Dynamo) |
|----------|------|-----------------|
| Consistency | Linearizable | Eventual to strong (configurable) |
| Latency on write | 1 RTT (leader to majority) | 1 RTT (coordinator to W) |
| Latency on read | 1 RTT or local-lease | 1 RTT to R |
| Availability under partition | Minority side blocks | Both sides accept (sloppy) |
| Operational complexity | Lower | Higher (anti-entropy, repair, hints) |
| Throughput per shard | Limited by leader | Distributed across replicas |

The honest summary: Raft is simpler to operate and reason about. Dynamo-style is more available and has higher per-shard throughput (no leader bottleneck). Choose Raft for transactions and small-coordination workloads, choose Dynamo-style for large key-value stores with eventual consistency tolerance.

Spanner, CockroachDB, TiKV, and FoundationDB all chose Raft/Paxos. Cassandra, ScyllaDB, DynamoDB chose quorum-style. Both designs scale to enormous workloads, the choice is about consistency model.

### Implementation Notes

A C++ Dynamo-style coordinator is structurally similar to a load balancer that fans out to replicas. The components:

1. **Partitioner**: maps key to replica set. Consistent hashing or rendezvous (chapter 13).
2. **Coordinator**: per-request state machine that fans out, collects, and resolves.
3. **Replicator**: per-node connection pool and write log.
4. **Anti-entropy service**: periodic merkle-tree exchange.
5. **Hint queue**: for sloppy quorum overflow.
6. **Conflict resolution**: vector clock comparison or LWW.

```cpp
class DynamoCoordinator {
public:
    absl::Status Write(Key k, Value v, int W) {
        auto ts = hlc_.Now();
        auto replicas = ring_.OwnersFor(k, replication_factor_);
        std::atomic<int> acks{0};
        std::promise<absl::Status> result;
        for (auto* r : replicas) {
            r->WriteAsync(k, v, ts, [&, W](auto status) {
                if (status.ok() && ++acks >= W) result.set_value(absl::OkStatus());
            });
        }
        if (result.get_future().wait_for(timeout_) == std::future_status::timeout) {
            return absl::DeadlineExceededError("write quorum not met");
        }
        return result.get_future().get();
    }
};
```

This is the structural skeleton. Production code adds backpressure on the per-replica queue, connection pooling, retry on transient errors, and integration with the hint queue for sloppy quorums.

### Junior at FAANG: The Quorum Question

When asked "Dynamo-style or Raft for a new data store?", do not say "Raft because it is consistent." Say: "Raft if the workload is transactional and operational simplicity matters. Dynamo-style if availability under partition trumps consistency, throughput per shard is limiting, and you have the engineering to operate anti-entropy correctly. Most green-field systems pick Raft today, the operational debt of Dynamo-style is real."

That answer demonstrates you understand the trade-offs without parroting one or the other.

---
