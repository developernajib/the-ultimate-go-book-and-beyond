## Consistent Hashing and Sharding

A distributed system must decide which node owns which piece of data. Naive hashing (`hash(key) % N`) breaks the moment N changes: every key remaps and every node has to read every other node's data. Consistent hashing, rendezvous hashing, jump hash, and Maglev hashing all solve this problem in different ways. Choose carefully because the choice determines the resharding story for the lifetime of the system.

### Naive Modulo Hashing

```cpp
size_t Owner(const std::string& key, size_t n) {
    return std::hash<std::string>{}(key) % n;
}
```

When N changes from 4 to 5, roughly 80 percent of keys remap. Every shard has to ship most of its data to a neighbor. Operationally catastrophic. Used only for static cluster sizes (memcached pools that never resize, for instance).

### Consistent Hashing (Karger et al., 1997)

Hash each key onto a ring of `[0, 2^32)`. Hash each node onto the same ring. A key's owner is the next node clockwise on the ring. Adding or removing a node only remaps the keys between the new node and its predecessor.

```cpp
class ConsistentHashRing {
public:
    void AddNode(const std::string& node, int virtual_nodes = 256) {
        for (int i = 0; i < virtual_nodes; ++i) {
            auto h = Hash(node + ":" + std::to_string(i));
            ring_[h] = node;
        }
    }

    void RemoveNode(const std::string& node, int virtual_nodes = 256) {
        for (int i = 0; i < virtual_nodes; ++i) {
            auto h = Hash(node + ":" + std::to_string(i));
            ring_.erase(h);
        }
    }

    std::string Owner(const std::string& key) const {
        if (ring_.empty()) return "";
        auto h = Hash(key);
        auto it = ring_.lower_bound(h);
        if (it == ring_.end()) it = ring_.begin();
        return it->second;
    }

private:
    static uint32_t Hash(const std::string& s) {
        return static_cast<uint32_t>(std::hash<std::string>{}(s));
    }
    std::map<uint32_t, std::string> ring_;
};
```

The `virtual_nodes` parameter (also called *vnodes* or *shards*) addresses the load-balance problem of plain consistent hashing. Without virtual nodes, the load distribution depends on the random hash positions of N nodes and can be wildly uneven. With 256 virtual nodes per physical node, the standard deviation of load drops to a few percent.

Used by Cassandra, DynamoDB, Riak, memcached's libketama. The standard reference.

### Rendezvous Hashing (Highest Random Weight)

Instead of a ring, hash each (key, node) pair and pick the node with the highest hash. No ring, no virtual nodes, exactly balanced load on average.

```cpp
class RendezvousHash {
public:
    void AddNode(std::string n) { nodes_.push_back(std::move(n)); }
    void RemoveNode(const std::string& n) {
        std::erase(nodes_, n);
    }

    std::string Owner(const std::string& key) const {
        std::string best;
        uint64_t best_hash = 0;
        for (const auto& n : nodes_) {
            auto h = std::hash<std::string>{}(key + "|" + n);
            if (best.empty() || h > best_hash) { best = n; best_hash = h; }
        }
        return best;
    }

private:
    std::vector<std::string> nodes_;
};
```

The cost is O(N) per lookup, fine for N up to a few thousand. The advantage: no virtual nodes, perfect load balance, deterministic output.

Used by Akamai's CDN, Google's caches. When your N is small (under 100), rendezvous beats consistent hashing on simplicity and balance.

### Jump Hash (Lamping & Veach, 2014)

A two-line algorithm that maps a key to one of N buckets with O(log N) work and *zero* memory:

```cpp
int32_t JumpHash(uint64_t key, int32_t num_buckets) {
    int64_t b = -1, j = 0;
    while (j < num_buckets) {
        b = j;
        key = key * 2862933555777941757ULL + 1;
        j = static_cast<int64_t>((b + 1) * (double((1LL << 31)) / double((key >> 33) + 1)));
    }
    return static_cast<int32_t>(b);
}
```

The trick: a deterministic random walk that converges to one bucket. Adding bucket N+1 only remaps `1/(N+1)` of keys. The downside: there is no notion of *which* node is at position N. You can only add or remove buckets at the *end* of the range. This is fine for stateless caches that map onto any of N nodes, it does not fit cases where specific nodes have specific identities.

Used by Google's caches and Tindex.

### Maglev Hashing (Eisenbud et al., 2016)

Google's Maglev load balancer uses a different hash: a precomputed permutation table per node, combined into a lookup table of size M (typically a prime, like 65537). Each entry of the lookup is the node owning that slot.

The table-construction algorithm gives each node a fair share of the lookup, and the permutation structure means that adding or removing a node disturbs only `1/M` of the entries. Lookups are O(1): `lookup_table[hash(key) % M]`.

```cpp
class MaglevHash {
public:
    explicit MaglevHash(size_t lookup_size = 65537) : table_(lookup_size, -1) {}

    void Build(const std::vector<std::string>& nodes) {
        size_t M = table_.size(), N = nodes.size();
        // Precompute permutation table for each node.
        std::vector<std::vector<size_t>> perm(N, std::vector<size_t>(M));
        for (size_t i = 0; i < N; ++i) {
            auto offset = std::hash<std::string>{}(nodes[i] + "_offset") % M;
            auto skip = std::hash<std::string>{}(nodes[i] + "_skip") % (M - 1) + 1;
            for (size_t j = 0; j < M; ++j) perm[i][j] = (offset + j * skip) % M;
        }
        std::vector<size_t> next(N, 0);
        size_t filled = 0;
        std::fill(table_.begin(), table_.end(), -1);
        while (filled < M) {
            for (size_t i = 0; i < N && filled < M; ++i) {
                size_t c = perm[i][next[i]];
                while (table_[c] != -1) { next[i]++; c = perm[i][next[i]]; }
                table_[c] = i;
                next[i]++;
                filled++;
            }
        }
        nodes_ = nodes;
    }

    const std::string& Owner(uint64_t hash) const {
        return nodes_[table_[hash % table_.size()]];
    }

private:
    std::vector<int32_t> table_;
    std::vector<std::string> nodes_;
};
```

Maglev's combination of perfect balance, O(1) lookup, and minimal disruption is why Google uses it for L4 load balancing of public services. The downside is that the table must be rebuilt on membership change, which costs O(M log M).

### Range Sharding vs Hash Sharding

The choice of hash family is orthogonal to the choice of *sharding scheme*.

**Hash sharding** distributes keys across nodes by hash. Adjacent keys (alphabetically) end up on different nodes. Good for uniform load, bad for range queries.

**Range sharding** distributes keys by sorted range. Adjacent keys live together. Good for range queries (`SCAN FROM x TO y`), bad for hot ranges (a sequential ID generator pins all writes to one shard).

Bigtable, Spanner, HBase use range sharding. Cassandra, Dynamo, ScyllaDB use hash sharding. CockroachDB started with range sharding and added hash-bucketing to mitigate hotspots.

### Resharding: The Hard Part

Adding or removing a node forces data movement. The challenge is to do it online without breaking consistency.

The standard pattern (Cassandra-style):

1. New node joins, hash ring assigns it a token range.
2. Old node ships its data for that range while still serving reads.
3. Once the new node has caught up, the ring switches: writes go to the new node, old node retains a hinted-handoff queue for any in-flight writes.
4. Old node drops its copy.

Bigtable's pattern (range sharding):

1. Tablet server splits a tablet at a chosen midpoint.
2. The two halves are independently rebalanceable.
3. Master can move a tablet to a different server by updating Chubby, the new server reads the SSTable files from GFS.

Spanner uses a similar tablet-move primitive, with the additional twist that Paxos groups can be reconfigured online via joint consensus.

The implementation of each pattern in C++ is a multi-month project. The lesson for the senior engineer: pick the sharding scheme that matches your workload, and budget time for the resharding code path proportional to its operational importance.

### Junior at FAANG: The Sharding Question

When asked "how would you shard a 100 TB key-value store?", do not say "use consistent hashing." Say: "Hash sharding with virtual nodes if range queries are not needed, range sharding if they are. Within hash sharding, prefer rendezvous for small clusters, Maglev for load balancers, consistent hashing with virtual nodes for storage clusters with hundreds of nodes. Build the resharding protocol from day one because it is invariably under-budgeted."

That answer separates engineers who have lived through a reshard from those who have only read about hashing.

---
