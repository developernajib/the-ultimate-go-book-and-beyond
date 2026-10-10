## Gossip and Anti-Entropy

Consensus is not the only way to disseminate information in a cluster. Gossip protocols (also called epidemic protocols) propagate state in O(log N) rounds with O(N log N) total messages, tolerate arbitrary failure patterns, and require no leader. Cassandra, Dynamo, Riak, Consul, Serf, and HashiCorp Vault all use gossip for membership and failure detection. This section implements SWIM and merkle-tree anti-entropy in C++ on Asio.

### What Gossip Is For

Gossip is *not* a replacement for consensus. You cannot gossip a sequence of writes in a meaningful order. What gossip is for:

- Membership: who is in the cluster.
- Failure detection: who is alive.
- Configuration dissemination: shared cluster-wide state that converges.
- Anti-entropy: detect and reconcile divergent replicas of the same data.

For all of these, gossip's O(log N) propagation latency is acceptable, and its tolerance for partitions is a feature.

### SWIM: Scalable Weakly-consistent Infection-style Process Group Membership

SWIM (Das et al., 2002) is the de facto standard for cluster membership. Three properties:

1. **Failure detection** uses random pings with indirect-ping fallback. Constant per-node bandwidth.
2. **Membership updates** ride alongside pings, no dedicated traffic.
3. **Consistency** is weak: within O(log N) rounds, every alive node learns of any membership change.

Hashicorp's Memberlist (Go) is the reference implementation. The C++ ports include parts of brpc and the now-archived libring.

#### SWIM Protocol

Each node maintains a list of members and their states (Alive, Suspect, Failed, Left). Periodically (`T` ms), the node:

1. Picks a random member M.
2. Sends a ping to M with a deadline.
3. If M responds, it is alive.
4. If M does not respond, picks K other random members and asks them to ping M (indirect ping).
5. If at least one indirect ping succeeds, M is alive.
6. Otherwise, M is marked Suspect. After a timeout in Suspect, M becomes Failed.

The state changes are gossiped piggyback on every ping. So every protocol period, each node sends one direct ping plus K indirect requests, total bandwidth is O(K).

#### C++ Sketch

```cpp
enum class MemberState { Alive, Suspect, Failed, Left };

struct Member {
    std::string id;
    asio::ip::udp::endpoint addr;
    MemberState state = MemberState::Alive;
    uint64_t incarnation = 0;
    std::chrono::steady_clock::time_point last_change;
};

class SwimNode {
public:
    SwimNode(asio::io_context& io, std::string self_id, asio::ip::udp::endpoint addr)
        : io_(io), socket_(io, addr), self_id_(std::move(self_id)) {
        members_[self_id_] = {self_id_, addr, MemberState::Alive, 0, {}};
        StartReceive();
        SchedulePeriod();
    }

private:
    void SchedulePeriod() {
        timer_.expires_after(period_);
        timer_.async_wait([this](auto) { RunPeriod(); SchedulePeriod(); });
    }

    void RunPeriod() {
        auto target = PickRandomLiveMember();
        if (!target) return;
        SendPing(*target);
        timer_indirect_.expires_after(direct_timeout_);
        timer_indirect_.async_wait([this, t = *target](auto) {
            if (!ack_received_for(t)) RequestIndirectPings(t);
        });
    }

    void RequestIndirectPings(const std::string& target_id) {
        auto helpers = PickKRandomLiveMembers(k_);
        for (const auto& h : helpers) SendPingReq(h, target_id);
        timer_suspect_.expires_after(indirect_timeout_);
        timer_suspect_.async_wait([this, target_id](auto) {
            if (!ack_received_for(target_id)) MarkSuspect(target_id);
        });
    }

    void MarkSuspect(const std::string& id) {
        auto& m = members_[id];
        m.state = MemberState::Suspect;
        m.last_change = std::chrono::steady_clock::now();
        ScheduleSuspectTimeout(id);
        BroadcastUpdate(m);
    }

    void OnReceivePing(const PingMsg& msg, asio::ip::udp::endpoint from) {
        SendAck(from, msg.seq);
        ApplyGossipPayload(msg.gossip);
    }

    asio::io_context& io_;
    asio::ip::udp::socket socket_;
    asio::steady_timer timer_{io_}, timer_indirect_{io_}, timer_suspect_{io_};
    std::unordered_map<std::string, Member> members_;
    std::string self_id_;
    std::chrono::milliseconds period_{1000};
    std::chrono::milliseconds direct_timeout_{300};
    std::chrono::milliseconds indirect_timeout_{1500};
    int k_ = 3;
};
```

This is enough scaffolding to demonstrate the structure, production SWIM implementations add the *Lifeguard* extensions (refuting suspicion via incarnation numbers), TCP fallback for large gossip payloads, and encryption.

### Cassandra Gossip

Cassandra's gossip is similar to SWIM in spirit but exchanges richer state. Every gossip round, three nodes are picked: one alive seed, one alive non-seed, and one unreachable. The exchange is a three-way handshake (SYN, ACK, ACK2) carrying *application state versioning*: each node's state is a map of `ApplicationState -> VersionedValue`, and the SYN includes only the digests, the ACK includes the values that the receiver does not have.

This is more than membership, it is also for status keys (load, schema version, tokens). The principle holds: gossip with version numbers, exchange diffs, converge in O(log N) rounds.

### HyParView and Plumtrees

HyParView (Leitão et al., 2007) maintains two views per node: a small *active view* (the gossip neighbors, typically 5) and a larger *passive view* (a fallback pool, typically 30). When an active link fails, the node picks a random passive peer to fill the slot. This produces a solid connectivity with bounded fanout.

Plumtree (Leitão et al., 2007) builds a *spanning tree* on top of HyParView for low-overhead broadcast. Most messages travel the tree (eager push), a periodic lazy-push round catches anything the tree missed. The result is broadcast latency comparable to a dedicated tree with the failure tolerance of gossip.

### Anti-Entropy with Merkle Trees

Two replicas of the same dataset can diverge silently if they each accept writes that do not propagate. Anti-entropy is the process of detecting and reconciling divergence. The naive method (compare every key) costs O(N) bandwidth. Merkle trees reduce this to O(log N) plus the size of the actual diff.

A merkle tree partitions the key space into ranges, hashes each range, and combines hashes pairwise into a tree. To compare two replicas:

1. Exchange root hashes. If equal, done.
2. If different, recurse into the children whose hashes differ.
3. At the leaf, exchange the actual keys in the differing ranges.

```cpp
class MerkleTree {
public:
    void Insert(const std::string& k, const std::string& v) {
        auto bucket = std::hash<std::string>{}(k) % buckets_.size();
        buckets_[bucket][k] = v;
        dirty_.insert(bucket);
    }

    std::vector<uint64_t> RootHashes() {
        Rehash();
        return level_hashes_.back();
    }

    std::vector<uint64_t> ChildHashes(size_t parent_idx) {
        // Return hashes one level down for divergence walk.
        return ...;
    }

private:
    void Rehash() {
        for (auto b : dirty_) {
            level_hashes_[0][b] = HashBucket(buckets_[b]);
        }
        for (size_t lvl = 1; lvl < level_hashes_.size(); ++lvl) {
            for (size_t i = 0; i < level_hashes_[lvl].size(); ++i) {
                level_hashes_[lvl][i] = level_hashes_[lvl-1][2*i] ^ level_hashes_[lvl-1][2*i+1];
            }
        }
        dirty_.clear();
    }

    std::vector<std::map<std::string, std::string>> buckets_;
    std::vector<std::vector<uint64_t>> level_hashes_;
    std::set<size_t> dirty_;
};
```

Cassandra runs anti-entropy via "repair", which is exactly this merkle comparison plus streaming of the differing ranges. Riak's active anti-entropy (AAE) is similar.

The cost is rebuilding the tree on every write. Production designs use *incrementally maintained* merkle trees (Cassandra's AAE rebuilds in the background, Riak's AAE persists the tree on disk and updates incrementally on writes).

### Push-Pull Gossip

A simple, robust gossip pattern is push-pull:

1. Node A sends its summary (version vector, merkle root, etc.) to a random peer B.
2. B compares against its own summary, computes the diff in both directions.
3. B sends back the parts A is missing.
4. A sends the parts B is missing.

This converges in O(log N) rounds. It requires symmetric exchange (more bandwidth than pure push) but reaches all nodes including those behind asymmetric NAT.

### Building a Gossip Service in C++

The structural pattern: an Asio io_context with a UDP socket for periodic pings, a TCP fallback for large payloads, a `std::unordered_map` of cluster state protected by a mutex, and a periodic timer that drives the protocol. Membership changes are surfaced as events to the application via a callback or a notification queue.

For production, prefer a vetted library:
- **Memberlist** (Go) is the reference. C++ services can talk to it via a shim.
- **brpc** ships with a built-in failure detector that uses similar patterns.
- **gossipy** is a small modern C++17 SWIM implementation suitable for embedding.

Rolling your own gossip is a multi-month project that is hard to test correctly. Prefer integration over reimplementation.

### Junior at FAANG: The Gossip Question

When asked "how would you handle membership in a cluster of 1000 C++ services?", do not say "we use ZooKeeper." Say: "ZooKeeper for the small set of authoritative state (leader identity, configuration). SWIM-style gossip for membership and failure detection, because ZooKeeper does not scale to 1000 nodes hammering the watch API. Anti-entropy via merkle trees for replicated data."

That answer demonstrates you understand that consensus and gossip are complementary, not competing.

---
