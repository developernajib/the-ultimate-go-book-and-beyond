## Replicated State Machines

The state machine replication (SMR) approach, formalized by Fred Schneider in 1990, is the foundation of every consensus-replicated system. The principle is simple: if every replica starts in the same state and applies the same sequence of deterministic commands in the same order, every replica ends in the same state. Consensus solves the ordering problem. Determinism is the responsibility of the application.

This section walks through what determinism actually means in C++, how to enforce it, and how to handle log compaction and snapshot installation.

### The Schneider Recipe

1. Start replicas in identical state.
2. Use consensus (Raft, Paxos) to agree on a sequence of commands.
3. Apply commands deterministically and in order on each replica.
4. The state of every non-faulty replica matches.

If any of these properties fails, the replicas diverge silently. The eventual consistency check (compare hash of state across replicas) will fire much later, possibly after corrupt data has propagated to clients.

### Sources of Nondeterminism in C++

The single most common reason a C++ state machine diverges is unintentional nondeterminism in what looks like deterministic code.

#### Wall Clock Reads

```cpp
// BUG: each replica reads a different wall-clock time.
void Apply(const SetCommand& cmd) {
    state_[cmd.key] = {cmd.value, std::chrono::system_clock::now()};
}

// FIX: the timestamp must be in the command, set by the leader.
void Apply(const SetCommand& cmd) {
    state_[cmd.key] = {cmd.value, cmd.timestamp};
}
```

The leader stamps the time before consensus. Every replica sees the same value.

#### Random Numbers

```cpp
// BUG: each replica has a different RNG state.
void Apply(const ShuffleCommand&) {
    std::shuffle(deck_.begin(), deck_.end(), std::mt19937{std::random_device{}()});
}

// FIX: seed in the command.
void Apply(const ShuffleCommand& cmd) {
    std::shuffle(deck_.begin(), deck_.end(), std::mt19937{cmd.seed});
}
```

#### Hash Map Iteration Order

```cpp
// BUG: std::unordered_map iteration order is implementation-defined and
// can differ between replicas if they have different load factors.
std::vector<std::string> ListKeys() {
    std::vector<std::string> r;
    for (auto& [k, v] : map_) r.push_back(k);
    return r;
}

// FIX: use std::map for deterministic iteration, or sort the result.
std::vector<std::string> ListKeys() {
    std::vector<std::string> r;
    for (auto& [k, v] : map_) r.push_back(k);
    std::sort(r.begin(), r.end());
    return r;
}
```

This bug bites every team that writes their first replicated state machine. Three replicas, three identical command sequences, three different `ListKeys()` results. The fix is mechanical: never expose iteration order of an unordered container in observable state.

#### Threading

```cpp
// BUG: applying commands across multiple threads.
void Apply(const std::vector<Command>& batch) {
    std::for_each(std::execution::par, batch.begin(), batch.end(),
                  [this](const Command& c) { ApplyOne(c); });
}
```

Even if individual commands are deterministic, parallel application allows races. A single-threaded apply is the only safe pattern. If throughput requires parallelism, partition state into independent shards and apply each shard's commands serially within that shard.

#### Memory Address Ordering

```cpp
// BUG: comparing or hashing pointers.
void Apply(const SortCommand&) {
    std::sort(items_.begin(), items_.end(),
              [](const Item* a, const Item* b) { return a < b; });
}
```

Pointer values differ across replicas because addresses are randomized by ASLR. Compare by value or by deterministic ID.

#### Floating Point

Most floating-point operations are deterministic on the same hardware, but transcendental functions (`std::sin`, `std::log`) can vary across libc versions and CPU vendor (Intel vs AMD vs ARM). For state machines, prefer integer arithmetic. If you must use floats, use a vetted deterministic library.

### Side Effect Ordering

A state machine command often has side effects beyond mutating in-memory state: writing to a downstream service, sending a notification, billing a customer. These side effects must happen *after* the log entry is committed, not before.

```cpp
// WRONG: side effect before commit. If the leader crashes, the side effect
// happened but the command was not committed - replicas will commit a
// different command, producing an inconsistent external view.
absl::Status Charge(const ChargeRequest& req) {
    auto status = stripe_client_.Charge(req);  // external side effect.
    if (!status.ok()) return status;
    return raft_.Propose(MakeCommand(req));
}

// RIGHT: propose first, side effect happens during apply on the leader only.
absl::Status Charge(const ChargeRequest& req) {
    return raft_.Propose(MakeCommand(req));  // returns when committed.
}

void Apply(const ChargeCommand& cmd) {
    state_.RecordCharge(cmd);
    if (raft_.IsLeader()) {
        // Idempotent retry of the side effect, keyed on cmd.idempotency_key.
        stripe_client_.ChargeIfNotAlready(cmd.idempotency_key, cmd);
    }
}
```

The leader-only side effect is the standard pattern. Followers update in-memory state but skip external calls. The side effect's idempotency key (typically the command's unique ID) ensures that if leadership changes mid-apply, the new leader either skips the call (already done) or retries (not yet done) without double-charging.

### Log Compaction

Logs grow without bound. Periodically, the state machine takes a snapshot of its current state, persists it, and the consensus log is truncated up to the snapshot's index. New replicas can be brought up by installing the snapshot and replaying only the suffix of the log.

```cpp
struct SnapshotMetadata {
    uint64_t last_included_index;
    uint64_t last_included_term;
    std::string snapshot_file_path;
    std::string sha256;
};

class StateMachine {
public:
    SnapshotMetadata TakeSnapshot() {
        std::lock_guard lock(mu_);
        auto idx = last_applied_;
        auto term = last_applied_term_;
        auto path = "snap-" + std::to_string(idx) + ".bin";

        // Serialize state. Use a deterministic format (sorted keys, fixed-width).
        std::ofstream out(path, std::ios::binary);
        SerializeDeterministic(state_, out);
        out.close();

        return {idx, term, path, ComputeSha256(path)};
    }

    void RestoreSnapshot(const std::string& path) {
        std::lock_guard lock(mu_);
        state_.clear();
        std::ifstream in(path, std::ios::binary);
        DeserializeDeterministic(in, state_);
    }

private:
    std::mutex mu_;
    std::map<std::string, std::string> state_;
    uint64_t last_applied_ = 0;
    uint64_t last_applied_term_ = 0;
};
```

The serialization must be deterministic: sorted keys, fixed-width integers, no implementation-defined ordering. This lets you compare snapshots across replicas by hash to detect divergence (Cassandra calls this the "Merkle tree comparison". Raft systems often do it as a periodic audit).

### Snapshot Installation Protocol

A slow follower may have fallen so far behind that the leader has discarded the relevant log entries. The leader sends an `InstallSnapshot` instead of `AppendEntries`.

For multi-gigabyte snapshots, sending in a single RPC is impractical. The streaming pattern is:

```cpp
struct SnapshotChunk {
    uint64_t snapshot_id;
    uint64_t offset;
    std::vector<uint8_t> data;
    bool done;
    std::optional<std::string> sha256;  // present only on done=true
};

class SnapshotReceiver {
public:
    absl::Status Receive(const SnapshotChunk& c) {
        std::lock_guard lock(mu_);
        if (!file_) {
            file_ = std::ofstream("snap-recv-" + std::to_string(c.snapshot_id) + ".bin",
                                  std::ios::binary);
            expected_offset_ = 0;
        }
        if (c.offset != expected_offset_) {
            return absl::FailedPreconditionError("out of order chunk");
        }
        file_->write(reinterpret_cast<const char*>(c.data.data()), c.data.size());
        expected_offset_ += c.data.size();
        if (c.done) {
            file_->close();
            file_.reset();
            if (ComputeSha256(/*path*/) != *c.sha256) {
                return absl::DataLossError("snapshot checksum mismatch");
            }
            state_machine_->RestoreSnapshot(/*path*/);
        }
        return absl::OkStatus();
    }

private:
    std::mutex mu_;
    std::optional<std::ofstream> file_;
    uint64_t expected_offset_ = 0;
    StateMachine* state_machine_;
};
```

The checksum on the final chunk is what catches the case where bytes were silently corrupted in transit (rare with TCP, more common over UDP-based transports or in the presence of malicious actors).

braft uses a separate file-transfer service for snapshots, etcd-raft uses streaming RPCs. Either pattern is acceptable, the key is that the consensus heartbeat does not block on snapshot transfer.

### Apply Loop Architecture

The apply loop is the heart of the state machine. A typical structure:

```cpp
void ApplyLoop() {
    while (running_) {
        auto entries = raft_.WaitForCommitted();  // blocks until new committed entries
        for (const auto& e : entries) {
            ApplyOne(e);  // single-threaded
            last_applied_ = e.index;
            last_applied_term_ = e.term;
            NotifyClient(e);  // resolve client futures
        }
        if (last_applied_ - last_snapshot_index_ > snapshot_interval_) {
            ScheduleSnapshot();  // run on a background thread.
        }
    }
}
```

Two production discipline points. First, `ApplyOne` must not hold the consensus lock, it operates on a queue handed off by the consensus thread. Second, snapshots run on a separate thread to avoid stalling apply, and they operate on a copy-on-write or MVCC-snapshot of state to avoid mutating during serialization.

### Junior at FAANG: The Determinism Question

When asked "how do you ensure all replicas in your replicated state machine end in the same state?", do not say "we use Raft." Say: "Raft gives us the same input order. Determinism of apply is the application's responsibility. We ban wall-clock reads inside apply, ban unseeded RNG, ban iteration over unordered containers, ban parallel apply, and stamp all timestamps and randomness in the command before consensus. We audit by periodically hashing replica state and comparing across the quorum."

That answer demonstrates you understand consensus is necessary but not sufficient.

---
