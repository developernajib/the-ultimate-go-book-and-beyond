## Distributed Systems Interview Questions (C++ Specific)

Twenty deep questions you should be able to answer at a senior or staff level for any FAANG distributed-systems interview. The questions are deliberately C++ specific: the answer often hinges on memory model, lifetime, or low-level concurrency details that a Java or Go engineer would not have to address.

### 1. Design Spanner's transaction protocol. Walk through commit-wait and explain why it gives external consistency.

The committer reads a TrueTime interval `[earliest, latest]` for the commit timestamp. It picks `s = latest`. It then *waits* until `TT.now().earliest > s` before reporting commit. After the wait, every TT reading anywhere in the system has `earliest > s`, so any subsequent transaction's chosen timestamp will be greater than `s`. Wall-clock time order matches commit-timestamp order: external consistency. The wait is typically the TrueTime uncertainty (~7 ms), so cross-region transactions pay an extra commit-wait on top of consensus.

### 2. Design a Chubby-equivalent coordination service in C++. What does it expose and how is it implemented?

Five replicas, Multi-Paxos for replication, lease-based locks, file-tree namespace. Expose: open/close, lock acquisition with timeout, watch/notify on changes, read/write of small values. Implementation: each Paxos peer is a C++ process holding the namespace in memory, persisted to disk as a snapshot plus log. Sessions hold leases, lease expiry releases all locks held by that session. Cache invalidation by master broadcast. Choose Multi-Paxos over Raft only if integrating with existing Paxos infrastructure, otherwise Raft via braft.

### 3. Design a config service that pushes updates to 10,000 C++ clients within 1 second.

Coordinator holds the config in a Raft group. Use gossip among clients for fanout: a tree of relays organized via HyParView, configs propagated via Plumtree. Each level of the tree adds ~50 ms, a tree of fanout 10 reaches 10K clients in 4 levels (~200 ms). Alternative: every client subscribes via a long-poll RPC to a regional aggregator, aggregator receives once from coordinator and fans out. Pick based on whether you need at-most-once-per-update delivery or eventual consistency.

### 4. Walk through the C++ memory model implications of a Raft implementation.

Raft state (current_term, voted_for, log) is mutated on multiple threads (RPC handler, election timer, apply loop). Use `std::atomic` for individual counters, `std::mutex` plus condition variables for compound state. Memory orderings matter: term changes must be `seq_cst` (visible to all threads in program order), apply-loop reads of commit_index can be `acquire`. Avoid `std::atomic_thread_fence` unless you have measured contention, usually `acquire`/`release` on a shared variable suffices. The `voted_for` write must happen-before the `RequestVoteReply` send, otherwise a peer can vote twice on a partition rejoin.

### 5. How do you implement zero-copy RPC payloads in C++ for a high-throughput service?

Allocate payload buffers in a pool of `std::shared_ptr<Buffer>` where Buffer wraps a region of an `mmap`'d arena. Pass shared_ptrs through the RPC call chain, never copy. For send: scatter-gather `writev` directly from the buffer. For receive: place into a buffer of the right size before parsing. Cap'n Proto and Flatbuffers do this natively. Protobuf's `Arena` and `MessageLite::ReleaseLast` allow similar patterns. The win is roughly 2x throughput on payloads above 1 KB.

### 6. Why is std::shared_mutex a bad choice for a Raft state lock?

`shared_mutex` adds the cost of read-lock contention on a hot path that does not benefit. Raft state mutations are short and fast, the leader's apply loop is the main hot reader, but it runs on a single thread and has no need for shared semantics. A plain `std::mutex` is faster. Use `shared_mutex` only when measurement shows readers vastly outnumber writers and the critical section is large.

### 7. How do you avoid an ABA bug in a lock-free request queue between an Asio io_context thread and a worker thread?

Use `std::atomic<uint64_t>` packing a generation counter with the pointer (16-byte CAS via `__atomic_compare_exchange_16` or `std::atomic<__int128>`). Or use a moodycamel ConcurrentQueue, which solves ABA internally. Or use a lock-protected queue with a condition variable, the lock cost is dwarfed by the RPC latency. Profile before going lock-free.

### 8. Design serialization for a 10 MB Raft snapshot that must transfer in under 100 ms.

Stream the snapshot in 1 MB chunks over a dedicated TCP connection (separate from the heartbeat path). Use `sendfile` if the snapshot is on disk to avoid user-space copies. At 10 Gbps NIC, 10 MB transfers in 8 ms wire time, serialization dominates. Serialize with a deterministic flat format (LSM SSTables work directly) so the receiver can mmap on arrival. Checksum per chunk for corruption detection. Pipeline send: do not wait for ack between chunks.

### 9. How would you implement a deterministic event loop for simulation testing in C++?

A min-heap of `(time, callback)` pairs. The clock advances to the next event's time before firing it. All I/O (socket, disk, timer) goes through interfaces, the simulation implementation queues operations onto the heap with simulated delays. Random number generation from a single seeded `std::mt19937_64`. No threading, no real I/O. Section 17 of this chapter has the full design.

### 10. Why is `std::chrono::system_clock` dangerous for distributed timeout logic?

NTP corrections can step it backward (a timeout deadline becomes unreachable) or forward (a timeout fires immediately). Use `std::chrono::steady_clock` for all interval-based logic. Use `system_clock` only when you need to communicate a human-meaningful timestamp to another system, and never as the source of truth for state-machine timing.

### 11. How does a C++ Raft leader handle the case where one follower is consistently 100ms slower than the others?

The leader must not gate on the slow follower. AppendEntries pipelines: commit advances when *majority* (not all) have acknowledged. The slow follower's `match_index` lags but does not block. If it lags past the WAL truncation point, the leader sends a snapshot. If it consistently fails to keep up, it should be removed via membership change.

### 12. You have a 5-replica Raft cluster, two replicas in zone A, three in zone B. Zone A partitions from B. What happens?

Zone B has the majority and continues to accept writes. Zone A's two replicas form a minority, cannot elect a leader, and refuse client writes. Reads from zone A go stale (or fail, depending on read consistency level). When the partition heals, A's replicas rejoin and replay from B's leader. Lesson: in a 5-replica cluster, place replicas to ensure no single zone's failure leaves you without a majority. Three zones with 2-2-1 is more resilient than two zones with 2-3.

### 13. Implement a per-key serialization point in a sharded service so that two writes to the same key never race, but writes to different keys run in parallel.

Use a hash-bucketed array of mutexes (e.g., 1024 mutexes, bucket by `hash(key) % 1024`). The bucket count is a tunable: too few and unrelated keys serialize, too many and memory grows. Alternatively, a `folly::ConcurrentHashMap<Key, std::shared_ptr<std::mutex>>` allocates a mutex per active key. The bucket-array is simpler and faster for most workloads.

### 14. How do you implement linearizable read with a lease in C++ on top of an etcd client?

Acquire a lease with TTL T. While the lease is valid (verified via local monotonic clock minus a safety margin S), serve reads directly from local cache. Renew lease at T/3 intervals. On lease loss, fall back to round-trip etcd reads. The lease's revision number is a fence token, pass it to any downstream that observes the lease.

### 15. A C++ service has p50 latency of 1 ms and p99 of 50 ms. What patterns reduce p99?

Hedge reads after p95 (e.g., 10 ms): send a duplicate to a second replica. Apply the Tail at Scale paper's tied requests. Tune the GC (if any), per-thread arena allocators to avoid memory allocator contention, lock-free or sharded data structures on the hot path, and NUMA-aware thread pinning. Profile with `perf` and `bpftrace` to find the actual stalls. p99 is rarely about CPU, usually it is about lock contention, queue depth, or syscall latency.

### 16. Design a vector clock library in C++23 that handles dynamic node membership.

Use `std::map<NodeId, uint64_t>` where NodeId is a stable string. Adding a node: no-op until that node ticks. Removing a node: leave the entry (necessary for compare-historic-vectors). Garbage-collect entries known to be unobservable (their counter value matches every other replica's recorded value for them). Provide `Compare` returning Before/After/Concurrent/Equal as a four-way enum. Implement Merge as elementwise max followed by self-tick.

### 17. How do you implement exactly-once delivery between two C++ services connected via gRPC?

Exactly-once does not exist over a fault-tolerant network. The closest you get is at-least-once + idempotency. Each request carries a unique idempotency key (UUID). The receiver maintains a dedup table indexed by key, on duplicate, return the cached result. Garbage-collect dedup entries after a TTL longer than any retry window. Combined with end-to-end ack, this gives the *effect* of exactly-once.

### 18. Write a C++ class that implements a fence token check on writes to an LSM-backed KV store.

```cpp
class FenceableLsm {
public:
    absl::Status Put(uint64_t fence, std::string k, std::string v) {
        std::lock_guard lock(mu_);
        if (fence < highest_fence_) return absl::FailedPreconditionError("stale leader");
        highest_fence_ = fence;
        lsm_.Put(std::move(k), std::move(v));
        return absl::OkStatus();
    }
private:
    std::mutex mu_;
    uint64_t highest_fence_ = 0;
    Lsm lsm_;
};
```

The fence is persisted alongside LSM state so crash-recovery preserves the highest_fence.

### 19. Why does C++ make it easier than Go to write a deterministic distributed simulator?

Two reasons. First, no garbage collector means no nondeterministic GC pauses to wrap. Second, no goroutines means scheduling is in your control: a single-threaded event loop is the natural pattern. Go programs have implicit nondeterminism in the goroutine scheduler that requires significant effort to remove (see TigerBeetle's experiences).

### 20. Spanner uses Paxos and 2PC. CockroachDB uses Raft and 2PC. What is the practical difference for an L5 engineer building on top?

Operationally, almost identical. Both give you serializable transactions across shards. The difference shows up in tail latency: Spanner pays a TrueTime uncertainty wait per cross-region commit (~7 ms), CockroachDB does not (it uses HLC, which avoids the wait at the cost of a weaker consistency guarantee, *serializability* rather than *external consistency*). For most applications, serializability is enough, for applications that need to observe wall-clock order across regions (audit logs, regulatory ordering), external consistency matters.

---

These questions are at the bar an L5 candidate should clear at any FAANG distributed systems team, and the bar an L6 should answer with the specificity of someone who has shipped each. Practice them out loud, with a whiteboard, and with a peer who will push back on every shortcut.

---
