## Paxos and Multi-Paxos

Paxos predates Raft by two decades and remains the consensus protocol of Spanner, Megastore, and Chubby. It is more flexible than Raft, harder to understand, and harder to implement correctly. The Lamport papers ("The Part-Time Parliament", 1998, and "Paxos Made Simple", 2001) are required reading. This section covers basic Paxos, Multi-Paxos, Fast Paxos, EPaxos, and the engineering trade-offs that determine when to choose Paxos over Raft.

### Basic Paxos: One Decision

Basic Paxos chooses one value among a set of proposed values, with the guarantee that all non-faulty learners eventually learn the same value. The roles are *proposer*, *acceptor*, and *learner*, in practice every node plays all three.

The protocol has two phases.

**Phase 1 (Prepare)**. The proposer chooses a proposal number `n` (globally unique, monotonically increasing per proposer) and sends `Prepare(n)` to a majority of acceptors. Each acceptor responds with the highest-numbered proposal it has accepted (if any), and promises not to accept any proposal numbered less than `n`.

**Phase 2 (Accept)**. If the proposer received responses from a majority and at least one acceptor reported a previously accepted value `v_prev` with number `n_prev`, the proposer must propose `v_prev` (the value with the highest `n_prev`). Otherwise it can propose its own value `v`. It sends `Accept(n, v)` to a majority. Each acceptor accepts iff it has not promised a higher number.

Once an acceptor accepts a proposal, it informs the learners.

```cpp
struct Proposal { uint64_t number; std::string value; };

struct AcceptorState {
    uint64_t promised_n = 0;
    std::optional<Proposal> accepted;  // highest-numbered accepted proposal
};

// On Prepare(n).
PrepareReply OnPrepare(uint64_t n, AcceptorState& s) {
    if (n > s.promised_n) {
        s.promised_n = n;
        Persist(s);
        return {true, s.accepted};
    }
    return {false, std::nullopt};
}

// On Accept(n, v).
AcceptReply OnAccept(const Proposal& p, AcceptorState& s) {
    if (p.number >= s.promised_n) {
        s.promised_n = p.number;
        s.accepted = p;
        Persist(s);
        return {true};
    }
    return {false};
}
```

The persistence requirement is identical to Raft's: `promised_n` and `accepted` survive a crash, fsynced before responding.

### Why Multi-Paxos

Basic Paxos chooses one value. To run a state machine, you need to choose a sequence of values: instance 1, instance 2, and so on. Naively running basic Paxos per instance costs two RTTs per command. Multi-Paxos amortizes this.

The insight: once a proposer has won Phase 1 for a high enough `n`, it has implicitly won Phase 1 for all future instances as well (assuming no competing proposer). So a stable leader pays one Phase 1 RTT at startup and one Phase 2 RTT per command.

This is the same property that makes Raft a single-leader protocol. Multi-Paxos with a stable leader and Raft are operationally similar. The differences come down to edge cases.

### Differences from Raft

Raft restricts the commit order: entries must be committed in log-index order. Paxos does not. A Multi-Paxos system can commit instance 7 before instance 5 if instance 5 happens to be slow. The state machine still applies in order, but commits can race ahead.

This is useful when commands are independent and the goal is throughput. It is harmful when you want a simple mental model.

Raft restricts who can become leader: only servers with the most up-to-date log. Paxos has no such restriction. A new Paxos leader may have to *fill in* uncommitted instances by running Phase 1 for each gap, learning what (if anything) was already chosen. This is the source of Paxos's reputation for complexity.

### Multi-Paxos Code Sketch

```cpp
class MultiPaxosNode {
public:
    void Propose(std::string command) {
        std::lock_guard lock(mu_);
        if (!is_leader_) { ForwardToLeader(command); return; }

        uint64_t instance = next_instance_++;
        Proposal p{leader_proposal_number_, command};
        instances_[instance].my_proposal = p;
        SendAcceptToAll(instance, p);
    }

    void OnAccepted(uint64_t instance, uint64_t from) {
        std::lock_guard lock(mu_);
        auto& st = instances_[instance];
        st.acks.insert(from);
        if (st.acks.size() > peers_.size() / 2 && !st.committed) {
            st.committed = true;
            Apply(instance, st.my_proposal->value);
        }
    }

private:
    uint64_t next_instance_ = 0;
    uint64_t leader_proposal_number_ = 0;
    bool is_leader_ = false;
    struct InstanceState {
        std::optional<Proposal> my_proposal;
        std::set<uint64_t> acks;
        bool committed = false;
    };
    std::unordered_map<uint64_t, InstanceState> instances_;
    std::vector<uint64_t> peers_;
    std::mutex mu_;
};
```

Real Multi-Paxos implementations include Phase 1 catchup on leader change, gap filling, snapshots, and reconfiguration. Google's Paxos library is internal but the open-source **paxos-cpp** and **libpaxos** projects illustrate the structure.

### Fast Paxos

Fast Paxos (Lamport, 2006) reduces the latency of an uncontended commit from two RTTs to one by allowing clients to send their proposals directly to acceptors, bypassing the proposer. The trade-off is that the quorum size grows: instead of `f+1` acceptors out of `2f+1`, Fast Paxos requires roughly `(3/4)(2f+1)`.

Fast Paxos is rarely used in production because the larger quorum eats most of the latency win, and contention recovery (when two clients send conflicting fast-path proposals) requires a fallback to classic Paxos. EPaxos largely supersedes it.

### EPaxos

Egalitarian Paxos (Moraru et al., 2013) eliminates the leader entirely. Any replica can commit any command. Commands carry *interference* metadata: command A interferes with command B if their order matters. Non-interfering commands commit in one RTT, interfering ones may need two.

EPaxos is the right choice when:
- The workload is geographically distributed, so per-region leader election would funnel traffic to one region.
- Most commands do not interfere (touch disjoint keys).
- You can pay the implementation complexity.

The TiDB SIG-Raft team studied EPaxos and chose Multi-Raft instead, citing implementation complexity. Spanner could have used EPaxos and chose not to. The lesson is that EPaxos is theoretically appealing but engineering-cost prohibitive for most teams.

### Comparison Table

| Property | Basic Paxos | Multi-Paxos | Raft | Fast Paxos | EPaxos |
|----------|-------------|-------------|------|------------|--------|
| Latency uncontended | 2 RTT | 1 RTT | 1 RTT | 1 RTT | 1 RTT |
| Quorum | majority | majority | majority | larger | majority |
| Leader required | no | typical | yes | optional | no |
| Out-of-order commit | n/a | yes | no | yes | yes |
| Implementation complexity | medium | high | medium | high | very high |

### When to Choose Paxos Over Raft

The honest answer in 2026 is *almost never*, unless one of the following applies.

1. You are extending an existing Paxos system (Spanner, Chubby, Megastore) and consistency with that codebase matters more than implementation simplicity.
2. You need EPaxos's leaderless property for geographically distributed writes and have the engineering depth to implement it.
3. Your workload genuinely benefits from out-of-order commit and you have measured that Raft's strict ordering is the bottleneck.

For new green-field systems, Raft via braft or etcd-raft is the senior-engineer default.

### Chubby-Style Usage

Chubby uses Multi-Paxos to replicate a small database (typically a few hundred megabytes) of locks, files, and small values across five replicas. The interesting design choice is that Chubby is *coarse-grained*: clients hold locks for hours, not milliseconds, and the load on the consensus group is low. This lets Chubby afford the Multi-Paxos overhead and prioritize availability over latency.

A C++ service that needs Chubby-like coordination (leader election, configuration, name resolution) typically does *not* implement Paxos itself. It uses a Chubby-equivalent (etcd, ZooKeeper, ClickHouse Keeper) and treats the coordination service as infrastructure.

### Junior at FAANG: The Paxos Question

When asked "Paxos or Raft?", do not say "Raft because it is simpler." Say: "Raft for new systems. Paxos when extending Spanner-class infrastructure or when EPaxos's leaderless property is worth the cost. The two protocols converge in production behavior with a stable leader. The main differentiators are out-of-order commit (Paxos), strict log order (Raft), and the cost of writing correct membership-change code (much harder in Paxos)."

That answer demonstrates you have read both papers and have an opinion grounded in implementation reality.

---
