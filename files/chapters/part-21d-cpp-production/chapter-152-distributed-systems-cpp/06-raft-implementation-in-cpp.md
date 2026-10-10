## Raft Implementation in Modern C++

Raft is the consensus algorithm of choice for almost every C++ distributed system written after 2014. etcd, Consul, TiKV, CockroachDB, ScyllaDB Raft, and Apache Kudu all use Raft. Diego Ongaro's 2014 paper made consensus comprehensible in a way that the Paxos literature had failed to do for two decades. This section walks through a Raft implementation in C++23, with the production gotchas the paper does not emphasize.

The two reference C++ implementations to study alongside this section are **braft** (Baidu, used by BaikalDB and others) and the C++ port of **etcd-raft** found in TiKV's predecessor codebases. Both are open source.

### Roles and Terms

Every Raft server is in one of three states: Follower, Candidate, Leader. Time is divided into *terms*, monotonically increasing integers. Each term has at most one leader.

```cpp
enum class Role { Follower, Candidate, Leader };

struct PersistentState {
    uint64_t current_term = 0;
    std::optional<uint64_t> voted_for;  // candidate ID we voted for in current_term
    std::vector<LogEntry> log;          // 1-indexed in the paper; we use 0-indexed
};

struct VolatileState {
    uint64_t commit_index = 0;
    uint64_t last_applied = 0;
};

struct LeaderState {
    std::unordered_map<uint64_t, uint64_t> next_index;   // peer -> next log index to send
    std::unordered_map<uint64_t, uint64_t> match_index;  // peer -> highest replicated index
};
```

The persistent state must survive a crash. Use `fsync()` on the WAL file before responding to any RPC that mutated it. Skipping the fsync is the single most common Raft bug, it produces a system that passes all tests under non-faulty conditions and silently loses data under crash.

### The State Machine

```cpp
class RaftNode {
public:
    RaftNode(uint64_t id, std::vector<uint64_t> peers, Storage* storage);

    // RPC handlers (called by the RPC framework).
    AppendEntriesReply HandleAppendEntries(const AppendEntriesArgs& args);
    RequestVoteReply HandleRequestVote(const RequestVoteArgs& args);
    InstallSnapshotReply HandleInstallSnapshot(const InstallSnapshotArgs& args);

    // Client interface.
    std::future<absl::Status> Propose(std::string command);

private:
    void Tick();                  // called every heartbeat interval
    void StartElection();
    void BecomeFollower(uint64_t term);
    void BecomeLeader();
    void SendAppendEntries(uint64_t peer);
    void AdvanceCommitIndex();

    const uint64_t id_;
    std::vector<uint64_t> peers_;
    Storage* storage_;
    PersistentState ps_;
    VolatileState vs_;
    LeaderState ls_;
    Role role_ = Role::Follower;
    uint64_t leader_id_ = 0;
    std::chrono::steady_clock::time_point election_deadline_;
    std::mutex mu_;
};
```

### Leader Election

A follower with no recent heartbeat from a leader becomes a candidate, increments its term, votes for itself, and sends `RequestVote` to all peers.

```cpp
void RaftNode::Tick() {
    std::lock_guard lock(mu_);
    auto now = std::chrono::steady_clock::now();

    if (role_ == Role::Leader) {
        for (auto p : peers_) SendAppendEntries(p);  // heartbeats
        return;
    }
    if (now > election_deadline_) StartElection();
}

void RaftNode::StartElection() {
    role_ = Role::Candidate;
    ps_.current_term++;
    ps_.voted_for = id_;
    storage_->PersistState(ps_);

    ResetElectionTimer();  // randomize between 150-300 ms

    auto last_log_index = ps_.log.size();
    auto last_log_term  = last_log_index > 0 ? ps_.log.back().term : 0;
    auto term           = ps_.current_term;

    auto votes = std::make_shared<std::atomic<int>>(1);  // self-vote
    for (auto p : peers_) {
        rpc_.RequestVoteAsync(p, {term, id_, last_log_index, last_log_term},
            [this, votes, term](RequestVoteReply r) {
                std::lock_guard lock(mu_);
                if (term != ps_.current_term || role_ != Role::Candidate) return;
                if (r.term > ps_.current_term) { BecomeFollower(r.term); return; }
                if (r.vote_granted && ++(*votes) > (peers_.size() + 1) / 2) {
                    BecomeLeader();
                }
            });
    }
}
```

The randomized election timeout (uniform over 150-300 ms typically) is what prevents split votes from repeating indefinitely. Two candidates with the same timeout will collide forever, randomization breaks the symmetry.

### The Log Up-to-Date Check

A vote is only granted if the candidate's log is *at least as up-to-date* as the voter's. "Up-to-date" is defined precisely: a log with a higher last term wins, ties broken by length.

```cpp
RequestVoteReply RaftNode::HandleRequestVote(const RequestVoteArgs& a) {
    std::lock_guard lock(mu_);
    if (a.term < ps_.current_term) return {ps_.current_term, false};
    if (a.term > ps_.current_term) BecomeFollower(a.term);

    auto my_last_index = ps_.log.size();
    auto my_last_term  = my_last_index > 0 ? ps_.log.back().term : 0;
    bool up_to_date = a.last_log_term > my_last_term ||
                      (a.last_log_term == my_last_term && a.last_log_index >= my_last_index);

    if ((!ps_.voted_for || *ps_.voted_for == a.candidate_id) && up_to_date) {
        ps_.voted_for = a.candidate_id;
        storage_->PersistState(ps_);
        ResetElectionTimer();
        return {ps_.current_term, true};
    }
    return {ps_.current_term, false};
}
```

This check is what prevents a stale candidate (one that missed several committed entries) from becoming leader and overwriting committed state. Skipping it is a correctness bug, not a performance bug.

### Log Replication

The leader appends client commands to its log and sends `AppendEntries` to each peer with the new entries. When a majority has replicated an entry, it is *committed* and applied to the state machine.

```cpp
void RaftNode::SendAppendEntries(uint64_t peer) {
    auto next = ls_.next_index[peer];
    auto prev_index = next > 0 ? next - 1 : 0;
    auto prev_term  = prev_index > 0 ? ps_.log[prev_index - 1].term : 0;

    AppendEntriesArgs a{
        .term = ps_.current_term,
        .leader_id = id_,
        .prev_log_index = prev_index,
        .prev_log_term  = prev_term,
        .entries = std::vector(ps_.log.begin() + next - 1, ps_.log.end()),
        .leader_commit = vs_.commit_index,
    };

    rpc_.AppendEntriesAsync(peer, a, [this, peer, sent = a.entries.size(), next]
                                     (AppendEntriesReply r) {
        std::lock_guard lock(mu_);
        if (role_ != Role::Leader) return;
        if (r.term > ps_.current_term) { BecomeFollower(r.term); return; }
        if (r.success) {
            ls_.match_index[peer] = next - 1 + sent;
            ls_.next_index[peer]  = ls_.match_index[peer] + 1;
            AdvanceCommitIndex();
        } else {
            // Decrement next_index and retry. Production code uses
            // the conflict-index optimization (see paper Section 5.3).
            if (ls_.next_index[peer] > 1) ls_.next_index[peer]--;
        }
    });
}
```

### The Commit Rule

The leader advances `commit_index` to the highest `N` such that:
1. A majority of peers have `match_index >= N`.
2. `log[N].term == current_term`.

The second condition is critical. Committing entries from a *previous* term solely because they are replicated to a majority leads to the Figure-8 anomaly in the Raft paper, where a leader could commit a stale entry that a future leader then overwrites. The fix is the current-term restriction: commit only when at least one entry from your own term has been replicated to a majority.

```cpp
void RaftNode::AdvanceCommitIndex() {
    for (uint64_t n = ps_.log.size(); n > vs_.commit_index; --n) {
        if (ps_.log[n - 1].term != ps_.current_term) break;
        int matches = 1;  // self
        for (auto p : peers_) if (ls_.match_index[p] >= n) matches++;
        if (matches > (peers_.size() + 1) / 2) {
            vs_.commit_index = n;
            ApplyCommitted();
            return;
        }
    }
}
```

### Snapshots

Logs grow without bound. Periodically the leader takes a snapshot of the state machine, truncates the log up to the snapshot index, and ships the snapshot to slow followers via `InstallSnapshot`.

```cpp
struct Snapshot {
    uint64_t last_included_index;
    uint64_t last_included_term;
    std::vector<uint8_t> data;
};

InstallSnapshotReply RaftNode::HandleInstallSnapshot(const InstallSnapshotArgs& a) {
    std::lock_guard lock(mu_);
    if (a.term < ps_.current_term) return {ps_.current_term};
    if (a.term > ps_.current_term) BecomeFollower(a.term);

    state_machine_->Restore(a.data);
    // Truncate log up to last_included_index.
    if (a.last_included_index >= ps_.log.size()) ps_.log.clear();
    else ps_.log.erase(ps_.log.begin(), ps_.log.begin() + a.last_included_index);
    vs_.commit_index = std::max(vs_.commit_index, a.last_included_index);
    vs_.last_applied  = std::max(vs_.last_applied, a.last_included_index);
    storage_->PersistState(ps_);
    return {ps_.current_term};
}
```

For large snapshots (gigabytes), stream them in chunks rather than as a single RPC payload. braft uses a separate file-transfer service for this, etcd-raft splits the snapshot into a sequence of `InstallSnapshot` calls.

### Membership Changes: Joint Consensus

Adding or removing a server from a Raft cluster naively can produce two disjoint majorities at the same instant. The Raft paper's solution is *joint consensus*: a transitional configuration `C_old,new` requires majorities from both `C_old` and `C_new` for any decision. Once `C_old,new` is committed, the leader proposes `C_new`, once that commits, the change is complete.

In practice, single-server changes (one addition or removal at a time, never two simultaneous changes) avoid the joint consensus complexity. etcd-raft documents this preference. The cost is reduced flexibility (you cannot atomically swap two servers).

### Pre-Vote

A server that has been partitioned and rejoined will increment its term repeatedly while disconnected. When it rejoins, its higher term forces the live leader to step down, causing an unnecessary election even though the partitioned server cannot win one.

The fix is the *pre-vote* extension: before incrementing your term, send a `PreVote` RPC asking peers whether you would win an election. Only if you would, increment the term and start the real election.

```cpp
void RaftNode::StartElectionWithPreVote() {
    auto term = ps_.current_term + 1;
    auto last_log_index = ps_.log.size();
    auto last_log_term  = last_log_index > 0 ? ps_.log.back().term : 0;
    auto granted = std::make_shared<std::atomic<int>>(1);

    for (auto p : peers_) {
        rpc_.PreVoteAsync(p, {term, id_, last_log_index, last_log_term},
            [this, granted, term](RequestVoteReply r) {
                if (r.vote_granted && ++(*granted) > (peers_.size() + 1) / 2) {
                    StartElection();  // now safe to bump term.
                }
            });
    }
}
```

Production gotcha: the pre-vote handler must not persist any state. It is a query, not a vote. Persisting would defeat its purpose (preventing term inflation).

### Production Gotchas Beyond the Paper

1. **fsync()**. Already mentioned. Persist `current_term`, `voted_for`, and the log before responding.
2. **Apply ordering**. Apply committed entries in index order on a single thread. Concurrent application breaks state machine determinism.
3. **Read-only optimization**. Do not insert reads into the log. Instead, on receiving a read, the leader records its current commit index, sends a heartbeat round to confirm leadership, then serves the read once the index has been applied. This is the linearizable read protocol from the Raft paper Section 6.4.
4. **Lease-based reads**. Even faster: if the leader can prove via clock-skew bound that no other leader could have been elected in the last election timeout, it can serve reads without a heartbeat round. Used by etcd's "linearizable read with lease" mode.
5. **Batching and pipelining**. AppendEntries should batch multiple client commands per RPC. The leader should pipeline AppendEntries: send the next batch without waiting for the previous reply. Required for throughput beyond a few thousand ops per second.
6. **Flow control**. A slow follower can be overwhelmed by a fast leader pipelining unbounded AppendEntries. Use a credit window per follower.

### Junior at FAANG: When Asked to Implement Raft

Do not implement it on a whiteboard. Sketch the three states, the term mechanism, the log up-to-date check, and the commit rule with the current-term restriction. State that you would use braft or etcd-raft in production, not roll your own. Implementing Raft from scratch in production is a multi-engineer-year project, and the bugs you do not find in your test suite will appear at 3 AM during a region failover.

---
