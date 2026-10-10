## CRDTs in C++

Conflict-free Replicated Data Types are the alternative to consensus for workloads that tolerate eventual consistency. A CRDT is a data structure with a merge operation that is *commutative*, *associative*, and *idempotent*. Replicas can apply updates in any order, lose messages, receive duplicates, and still converge to the same final state without coordination. Marc Shapiro's INRIA group formalized them in 2011. Riak, Redis CRDTs, Automerge, Yjs, and Phoenix Channels run on them in production.

This section implements the canonical CRDTs in C++23 and covers when to choose each one.

### Two Flavors

**State-based (CvRDT)**. Replicas exchange complete state. Merge is a join in a partial order (a least-upper-bound). Easy to reason about, expensive on the wire for large states.

**Operation-based (CmRDT)**. Replicas exchange operations. The transport layer must guarantee at-least-once delivery in causal order. Cheaper on the wire, harder to operate (requires reliable causal broadcast).

Modern systems typically use *delta-CRDTs*: a state-based design that ships only the delta since the last sync. Best of both worlds for most workloads.

### G-Counter (Grow-Only Counter)

A counter that only increments. Each replica has its own per-node counter, the value is the sum.

```cpp
class GCounter {
public:
    explicit GCounter(std::string node) : node_(std::move(node)) {}

    void Increment() { ++counts_[node_]; }

    uint64_t Value() const {
        uint64_t s = 0;
        for (const auto& [k, v] : counts_) s += v;
        return s;
    }

    void Merge(const GCounter& other) {
        for (const auto& [k, v] : other.counts_) {
            counts_[k] = std::max(counts_[k], v);
        }
    }

    auto Serialize() const { return counts_; }

private:
    std::string node_;
    std::map<std::string, uint64_t> counts_;
};
```

Merge takes the elementwise max because each entry only grows monotonically. Two replicas that have seen different increments will, after merging both ways, agree.

### PN-Counter

Increments and decrements. Two G-Counters: one for additions, one for subtractions. Value is the difference.

```cpp
class PNCounter {
public:
    explicit PNCounter(std::string node) : pos_(node), neg_(std::move(node)) {}

    void Increment() { pos_.Increment(); }
    void Decrement() { neg_.Increment(); }
    int64_t Value() const { return static_cast<int64_t>(pos_.Value()) - neg_.Value(); }

    void Merge(const PNCounter& o) { pos_.Merge(o.pos_); neg_.Merge(o.neg_); }

private:
    GCounter pos_, neg_;
};
```

Used by Riak DT, Akka Distributed Data, and Redis CRDB. The trade-off is that the structure can never *truly* decrement past zero, the counter is the difference of two monotonic counters, which can grow without bound even if the value stays at zero.

### OR-Set (Observed-Remove Set)

A set with add and remove. The challenge is that an add and a remove can race: if you blindly merge, you do not know whether the remove should win. The OR-Set tags each add with a unique identifier, remove only removes the IDs that the removing replica has *observed*.

```cpp
class ORSet {
public:
    void Add(const std::string& v) {
        auto id = NewUuid();
        elements_[v].insert(id);
    }

    void Remove(const std::string& v) {
        auto it = elements_.find(v);
        if (it == elements_.end()) return;
        for (auto id : it->second) tombstones_[v].insert(id);
        it->second.clear();
    }

    bool Contains(const std::string& v) const {
        auto it = elements_.find(v);
        if (it == elements_.end()) return false;
        const auto& live = it->second;
        const auto tit = tombstones_.find(v);
        if (tit == tombstones_.end()) return !live.empty();
        // present iff there is a live ID not in tombstones.
        for (auto id : live) if (!tit->second.contains(id)) return true;
        return false;
    }

    void Merge(const ORSet& o) {
        for (const auto& [k, ids] : o.elements_) elements_[k].insert(ids.begin(), ids.end());
        for (const auto& [k, ids] : o.tombstones_) tombstones_[k].insert(ids.begin(), ids.end());
    }

private:
    std::map<std::string, std::set<std::string>> elements_;
    std::map<std::string, std::set<std::string>> tombstones_;
};
```

The semantic guarantee is "an add wins over a concurrent remove." If you add `x` at replica A and remove `x` at replica B simultaneously, after merge `x` is in the set. This matches user intuition for a shopping cart, a tag list, or a presence set.

The cost is that tombstones grow. Production OR-Sets garbage collect tombstones that have been observed by all replicas, which requires a global metadata exchange.

### RGA (Replicated Growable Array)

A list/sequence CRDT used for collaborative text editing. Each character has a unique ID, insertions reference a predecessor ID, deletions tombstone by ID. Merging is correct because IDs are immutable.

```cpp
struct RgaNode {
    std::string id;            // globally unique, e.g. "<lamport>:<replica>"
    std::optional<std::string> predecessor;
    char value;
    bool deleted = false;
};

class RGA {
public:
    void Insert(std::optional<std::string> after_id, char v) {
        auto id = NewId();
        nodes_[id] = {id, after_id, v, false};
        children_[after_id.value_or("")].push_back(id);
        SortChildren(after_id.value_or(""));
    }

    void Delete(const std::string& id) {
        if (auto it = nodes_.find(id); it != nodes_.end()) it->second.deleted = true;
    }

    std::string Materialize() const {
        std::string out;
        Walk("", out);
        return out;
    }

private:
    void Walk(std::string parent, std::string& out) const {
        auto it = children_.find(parent);
        if (it == children_.end()) return;
        for (const auto& cid : it->second) {
            auto& n = nodes_.at(cid);
            if (!n.deleted) out.push_back(n.value);
            Walk(cid, out);
        }
    }

    void SortChildren(const std::string& parent) {
        auto& v = children_[parent];
        std::sort(v.begin(), v.end());  // total order on IDs => deterministic
    }

    std::map<std::string, RgaNode> nodes_;
    std::map<std::string, std::vector<std::string>> children_;
};
```

Yjs and Automerge implement variations of RGA. The performance challenge is that materializing the visible sequence costs O(N) where N includes tombstones, production implementations use various tree structures (Yata, the AST in Automerge) to amortize this.

### LSEQ

LSEQ is a position-identifier CRDT for ordered sequences. Each character has a position that is a fractional address (think Dewey decimal), inserting between two characters generates an address strictly between theirs.

The advantage over RGA is that position lookups and range queries are O(log N) on a balanced tree of positions, without the tombstone overhead. The disadvantage is that the addresses can grow unboundedly under adversarial insertion patterns, production LSEQ uses heuristic strategies to bound growth.

The original LSEQ paper (Nédelec et al., 2013) and the LogootSplit follow-up describe the trade-offs.

### Delta-CRDTs

A delta-CRDT is a state-based CRDT that supports a *delta* operation: given the current state, produce the smallest piece that, when merged, captures the recent change. Replicas exchange deltas instead of full state.

```cpp
struct GCounterDelta {
    std::string node;
    uint64_t new_count;
};

class DeltaGCounter {
public:
    GCounterDelta Increment() {
        ++counts_[node_];
        return {node_, counts_[node_]};
    }

    void Apply(const GCounterDelta& d) {
        counts_[d.node] = std::max(counts_[d.node], d.new_count);
    }
};
```

Delta-CRDTs are the production-ready flavor. Riak Core, Akka Distributed Data, and CRDT.tech all converged on delta-state designs.

### When to Choose CRDTs Over Consensus

| Workload | Choose |
|----------|--------|
| Money, inventory, anything where double-spending is unacceptable | Consensus (Raft) |
| Shopping cart, tag lists, presence | CRDT (OR-Set) |
| Collaborative document editing | CRDT (RGA, LSEQ) |
| Counters that tolerate eventual consistency | CRDT (PN-Counter) |
| Configuration with strict ordering | Consensus |
| User profile fields with last-write-wins | LWW-Register CRDT |

The senior-engineer answer is: CRDTs replace consensus for workloads where the application can absorb concurrent updates with a principled merge. They do not replace consensus for workloads where order matters semantically.

### Production Concerns

**Garbage collection**. Tombstones, observed IDs, and old deltas accumulate. Most production CRDT systems run a background GC that requires global agreement on what has been seen by all replicas. ZooKeeper or etcd is often used for this metadata.

**Replication topology**. State-based CRDTs can use unreliable broadcast, operation-based require causal order. Choose based on what your transport layer provides.

**Schema evolution**. CRDT data structures embed metadata (UUIDs, vector clocks) into their state. Migrating from a single-replica `std::set` to an OR-Set requires a careful one-time conversion.

**Compactness**. A 1 KB JSON document represented as an RGA can balloon to 100 KB of CRDT metadata. Yjs's clever encoding (run-length compression, delete sets) brings this back down to roughly 2-3x of the original.

### Junior at FAANG: The CRDT Question

When asked "would you use a CRDT for this?", do not say yes reflexively. Say: "CRDTs are the right answer when concurrent updates can be merged without semantic conflict. They are the wrong answer when order matters. For a collaborative document, yes, RGA. For a bank balance, no, consensus. The wrong choice has real consequences: a CRDT-replicated balance will eventually let a customer overdraw."

That answer separates engineers who have actually run CRDTs in production from those who learned about them from a blog post.

---
