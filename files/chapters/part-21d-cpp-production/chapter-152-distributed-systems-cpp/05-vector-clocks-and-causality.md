## Vector Clocks and Causality

Wall-clock time tells you when something happened. Causality tells you which events influenced which. In a distributed system you almost always need causality, because that is what determines whether two writes conflict, whether a read is fresh enough, and whether a state machine has converged. This section covers Lamport timestamps, vector clocks, version vectors, and dotted version vectors, with C++ implementations and guidance on which is sufficient for which workload.

### Happens-Before

Lamport defined the happens-before relation `a -> b` in 1978: `a` happens before `b` if `a` and `b` are events in the same process and `a` came first, or `a` is a send and `b` is the corresponding receive, or there exists `c` with `a -> c -> b`. Two events are *concurrent* if neither happens before the other.

Vector clocks give you exact happens-before detection. Lamport timestamps give you a total order that respects happens-before but cannot tell concurrent events apart.

### Lamport Timestamps

A single integer per process, incremented on every event. On send, attach the timestamp. On receive, set the local counter to `max(local, received) + 1`.

```cpp
class LamportClock {
public:
    uint64_t Tick() { return ++counter_; }

    uint64_t Update(uint64_t received) {
        counter_ = std::max(counter_.load(), received) + 1;
        return counter_;
    }

    uint64_t Value() const { return counter_; }

private:
    std::atomic<uint64_t> counter_{0};
};
```

Lamport timestamps are sufficient when you need a total order that respects causality and you do not need to detect concurrency. They are the right choice for log sequence numbers, transaction IDs in non-conflicting workloads, and any context where ties can be broken arbitrarily (typically by node ID).

The limitation: if you see two events with timestamps 7 and 9, you cannot tell whether the second causally depends on the first or whether they were concurrent and the network just delivered them in that order.

### Vector Clocks

A vector with one entry per process. On a local event, increment your own entry. On send, attach the entire vector. On receive, take the elementwise max and increment your own entry.

Two vector clocks `u` and `v` are ordered as follows:
- `u < v` iff `u[i] <= v[i]` for all `i` and `u[j] < v[j]` for at least one `j`.
- `u || v` (concurrent) iff neither `u < v` nor `v < u`.

```cpp
class VectorClock {
public:
    explicit VectorClock(size_t n, size_t self) : v_(n, 0), self_(self) {}

    void Tick() { v_[self_]++; }

    void Merge(const VectorClock& other) {
        for (size_t i = 0; i < v_.size(); ++i) v_[i] = std::max(v_[i], other.v_[i]);
        v_[self_]++;
    }

    enum Order { Before, After, Equal, Concurrent };

    Order Compare(const VectorClock& o) const {
        bool less = false, greater = false;
        for (size_t i = 0; i < v_.size(); ++i) {
            if (v_[i] < o.v_[i]) less = true;
            else if (v_[i] > o.v_[i]) greater = true;
        }
        if (less && greater) return Concurrent;
        if (less) return Before;
        if (greater) return After;
        return Equal;
    }

private:
    std::vector<uint64_t> v_;
    size_t self_;
};
```

Vector clocks were the basis of Amazon Dynamo's conflict detection: a write attached its vector clock, and the database stored sibling values for concurrent writes for the application to reconcile. Riak inherited the design.

The cost is O(N) per write where N is the number of clients. In the original Dynamo design, every client process counted as a clock entry, and the vectors grew unboundedly. Production deployments truncate the vector when it grows beyond a threshold, accepting false-positive conflicts.

### Version Vectors

A version vector is a vector clock used at the *replica* granularity rather than the client granularity. The dimension is the number of replicas, not the number of clients. This bounds the size at a constant.

For a key-value store with three replicas, the version vector is always three integers. A write at replica A increments A's entry, a sync from A to B copies the vector, a concurrent write at B before the sync produces vectors `(1,0,0)` and `(0,1,0)`, detected as concurrent.

Version vectors are the right tool for replication metadata. Vector clocks are the right tool when you need to detect concurrency between *user actions*, not just replica states.

### The Vector Clock Tombstone Problem

If a client disappears (machine death, process restart with new identity), its entry in the vector still exists forever. After years of operation a Riak vector could contain entries for thousands of dead clients. Riak introduced *dotted version vectors* (DVV) to fix this.

### Dotted Version Vectors

DVV separates the *summary* of seen versions (the vector clock part) from a *dot* identifying the specific event. A version is encoded as `((node, counter), summary)`. The summary contracts over time, the dot identifies the unique event that produced a particular value.

Concretely, when client C writes a value `v` at replica R, R produces dot `(R, n+1)` and summary equal to R's current vector clock. Two values are concurrent iff each value's dot is *not* in the other value's summary.

```cpp
struct Dot { std::string node; uint64_t counter; };

struct DVV {
    Dot dot;
    std::unordered_map<std::string, uint64_t> summary;

    bool DescendsFrom(const DVV& other) const {
        auto it = summary.find(other.dot.node);
        return it != summary.end() && it->second >= other.dot.counter;
    }

    bool ConcurrentWith(const DVV& other) const {
        return !DescendsFrom(other) && !other.DescendsFrom(*this);
    }
};
```

The Riak paper "Dotted Version Vectors: Logical Clocks for Optimistic Replication" by Preguiça et al. (2010) is the definitive reference.

### When Each Is Sufficient

| Need | Use |
|------|-----|
| Total order, ties broken arbitrarily | Lamport |
| Happens-before, total events | Vector clock |
| Replica-level conflict detection | Version vector |
| Client-level conflict detection without unbounded growth | Dotted version vector |
| External consistency with wall-clock semantics | TrueTime or HLC |

A common mistake is using a vector clock when a Lamport timestamp would do. If your protocol just needs a total order (Raft log indices, Bigtable's microsecond-resolution timestamp + tie-breaker), Lamport is enough and the wire format is 8 bytes instead of 8N.

### Causality in Read Operations

Causality matters on reads as well as writes. A client that reads its own write should see it (read-your-writes). A client that observes write A and then writes B should ensure that any subsequent reader of B also sees A (monotonic reads, writes-follow-reads).

The primitive that encodes this is a *causality token*. Spanner returns a TrueTime timestamp. CockroachDB returns an HLC. Cassandra has long had a per-session "consistency token" of sorts. The C++ pattern is to thread the token through your client library:

```cpp
class CausalSession {
public:
    Result Read(const Key& k) {
        auto r = backend_.Read(k, /*at_least=*/last_seen_);
        last_seen_ = std::max(last_seen_, r.token);
        return r;
    }

    void Write(const Key& k, const Value& v) {
        auto t = backend_.Write(k, v, /*after=*/last_seen_);
        last_seen_ = std::max(last_seen_, t);
    }

private:
    Token last_seen_{};
    Backend backend_;
};
```

`last_seen_` is the per-session causality token. The backend ensures that any read returning data older than `last_seen_` blocks or fails, and any write after `last_seen_` is timestamped accordingly. Read-your-writes is now a property of the session, not of the backend's consistency model.

### Junior at FAANG: The Causality Question

When asked "how would you detect two conflicting writes to the same key in a distributed database?", do not say "we use a timestamp and last-write-wins." Say: "we attach a version vector or DVV to each write. The replica detects concurrent writes by vector comparison. We surface siblings to the application for semantic reconciliation, or fall back to a CRDT structure that merges automatically." That demonstrates you understand the difference between *resolving* a conflict (LWW, arbitrary) and *detecting* one (vector clock, principled).

---
