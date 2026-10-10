## 37.6 Consistent Hashing

### Why Consistent Hashing: The Resharding Problem

Naive `hash(key) % N` sharding has a catastrophic failure mode: changing `N` re-maps approximately `(N-1)/N` of all keys. Go from 4 shards to 5, and 80% of your data must move. For a 10 TB cluster, that is a multi-day outage or a multi-week online migration with dual-writes, backfill, and verification.

Consistent hashing, introduced by Karger et al. (1997) and popularized by Amazon's Dynamo paper, reduces this to `~K/N` keys moved when one shard is added or removed - for 4→5 shards, only ~20% of keys re-map, and they all come from the *new* neighbors of the added node. Memcached clients, Cassandra, DynamoDB, Riak, and every serious distributed cache use it.

**Virtual nodes are essential, not optional.** With one ring position per physical shard, 4 shards give 4 arcs on the ring, and FNV/md5 hashing will typically produce arcs of wildly different sizes - one shard might own 40% of the keyspace while another owns 10%. Giving each physical shard 100-200 virtual positions (vNodes) smooths the distribution by the law of large numbers. Cassandra uses 256 vNodes per physical node by default. Dynamo uses a similar scheme. A good default for your own implementation is 150.

**Performance:** the ring is a sorted slice of `uint32` (or `uint64`) hashes, and lookup is `sort.Search` - `O(log(N*vNodes))`. For 100 shards with 150 vNodes each, that is 14 comparisons per lookup - negligible.

**Two gotchas:**
1. **Hash function choice**: FNV-1a is fast but has known distribution weaknesses at small scale. For production, prefer xxHash or murmur3. md5 is fine for correctness but slower than necessary.
2. **Weight/heterogeneity**: if shards have different capacities (bigger VMs for hotter tenants), give them proportionally more vNodes. 2x capacity = 2x vNodes.

### Consistent Hash Ring

Consistent hashing places both shard nodes and keys on a virtual ring by hashing their identifiers. A key is assigned to the first node clockwise from its position on the ring, so adding or removing a node rebalances only the fraction of keys adjacent to that node. The Go implementation maintains a sorted slice of ring positions and uses binary search to find the successor node for a given key, giving O(log n) lookup time.

```go
package sharding

import (
    "fmt"
    "hash/fnv"
    "sort"
    "sync"
)

// ConsistentHash implements consistent hashing
type ConsistentHash struct {
    mu       sync.RWMutex
    ring     []uint32          // Sorted hash values
    nodes    map[uint32]string // Hash to node mapping
    replicas int               // Virtual nodes per physical node
}

func NewConsistentHash(replicas int) *ConsistentHash {
    return &ConsistentHash{
        nodes:    make(map[uint32]string),
        replicas: replicas,
    }
}

func (ch *ConsistentHash) hash(key string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(key))
    return h.Sum32()
}

// AddNode adds a node with virtual replicas
func (ch *ConsistentHash) AddNode(node string) {
    ch.mu.Lock()
    defer ch.mu.Unlock()

    for i := 0; i < ch.replicas; i++ {
        virtualKey := fmt.Sprintf("%s-%d", node, i)
        hash := ch.hash(virtualKey)
        ch.ring = append(ch.ring, hash)
        ch.nodes[hash] = node
    }

    sort.Slice(ch.ring, func(i, j int) bool {
        return ch.ring[i] < ch.ring[j]
    })
}

// RemoveNode removes a node and its virtual replicas
func (ch *ConsistentHash) RemoveNode(node string) {
    ch.mu.Lock()
    defer ch.mu.Unlock()

    for i := 0; i < ch.replicas; i++ {
        virtualKey := fmt.Sprintf("%s-%d", node, i)
        hash := ch.hash(virtualKey)
        delete(ch.nodes, hash)

        // Remove from ring
        for j, h := range ch.ring {
            if h == hash {
                ch.ring = append(ch.ring[:j], ch.ring[j+1:]...)
                break
            }
        }
    }
}

// GetNode returns the node for a key
func (ch *ConsistentHash) GetNode(key string) string {
    ch.mu.RLock()
    defer ch.mu.RUnlock()

    if len(ch.ring) == 0 {
        return ""
    }

    hash := ch.hash(key)

    // Binary search for first hash >= key hash
    idx := sort.Search(len(ch.ring), func(i int) bool {
        return ch.ring[i] >= hash
    })

    // Wrap around if needed
    if idx >= len(ch.ring) {
        idx = 0
    }

    return ch.nodes[ch.ring[idx]]
}

// GetNodes returns N nodes for a key (for replication)
func (ch *ConsistentHash) GetNodes(key string, n int) []string {
    ch.mu.RLock()
    defer ch.mu.RUnlock()

    if len(ch.ring) == 0 {
        return nil
    }

    hash := ch.hash(key)
    idx := sort.Search(len(ch.ring), func(i int) bool {
        return ch.ring[i] >= hash
    })

    seen := make(map[string]bool)
    var nodes []string

    for len(nodes) < n && len(seen) < len(ch.nodes)/ch.replicas {
        if idx >= len(ch.ring) {
            idx = 0
        }

        node := ch.nodes[ch.ring[idx]]
        if !seen[node] {
            seen[node] = true
            nodes = append(nodes, node)
        }
        idx++
    }

    return nodes
}
```

### Consistent Hash Router

The `ConsistentHashRouter` wraps the hash ring with a map of shard names to `*sql.DB` connections, providing a single `GetShard(key)` call that returns the database handle for any string key. Adding or removing a shard updates both the name-to-DB map and the ring. `GetShardWithReplicas` returns multiple nodes for a key, which is useful when you want to replicate writes to N shards for durability.

```go
package sharding

import (
    "database/sql"
)

// ConsistentHashRouter uses consistent hashing for shard selection
type ConsistentHashRouter struct {
    hash   *ConsistentHash
    shards map[string]*sql.DB
}

func NewConsistentHashRouter(replicas int) *ConsistentHashRouter {
    return &ConsistentHashRouter{
        hash:   NewConsistentHash(replicas),
        shards: make(map[string]*sql.DB),
    }
}

func (r *ConsistentHashRouter) AddShard(name string, db *sql.DB) {
    r.shards[name] = db
    r.hash.AddNode(name)
}

func (r *ConsistentHashRouter) RemoveShard(name string) {
    delete(r.shards, name)
    r.hash.RemoveNode(name)
}

func (r *ConsistentHashRouter) GetShard(key string) *sql.DB {
    node := r.hash.GetNode(key)
    return r.shards[node]
}

// GetShardWithReplicas returns primary and replica shards
func (r *ConsistentHashRouter) GetShardWithReplicas(key string, n int) []*sql.DB {
    nodes := r.hash.GetNodes(key, n)
    dbs := make([]*sql.DB, len(nodes))
    for i, node := range nodes {
        dbs[i] = r.shards[node]
    }
    return dbs
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Example

The mental model every junior should hold. A ring is a circle from 0 to 2^32 minus 1. Each node gets several points on that circle (virtual nodes). Each key also lands on a point. To find the key's owner, walk clockwise from the key until you hit a node point. That is the owner. When a new node joins, only the keys that now land between the new node's point and its counter clockwise predecessor move. Nothing else moves. That property is the whole reason consistent hashing exists.

A worked example. Four shards, 150 vnodes each, so 600 points on the ring. You add a fifth shard. Roughly 150 new points are inserted into random positions on the ring. Each of those 150 points steals a slice of keyspace from whatever node used to own that arc. In aggregate, the fifth shard takes about one fifth of the keys, pulled proportionally from the four existing shards. No key moves between two existing shards. That is the property that makes online migration tractable. Without consistent hashing, the same operation would remap 80 percent of keys.

Entry level interview questions. Why do we need virtual nodes. Because with one point per shard, hash function variance gives you arcs of wildly different sizes, and one shard ends up with 40 percent of the keyspace. Virtual nodes smooth this via the law of large numbers. How do you handle heterogeneous nodes. Give bigger nodes more virtual points in proportion to capacity. What is the lookup cost. Binary search over the sorted ring, O(log N times vnodes). For 100 shards with 150 vnodes that is 14 comparisons, under a microsecond. Why is FNV a questionable choice. Because FNV has known distribution biases at small input sizes. Use xxhash or murmur3 in production. Why does the code wrap around at the end of the ring. Because the ring is circular, a key whose hash is larger than every node's hash belongs to the first node (smallest hash).

When you first see the code in this section, the two lines to study are `sort.Search` and the wrap around. Everything else is bookkeeping.

### Senior @ FAANG: Consistent Hashing Variants, Load Balancing, and Production Footguns

The 1997 Karger paper describes the ring algorithm you see implemented above. That algorithm has been superseded for many use cases by newer variants that senior engineers must be able to reach for correctly. Picking the wrong variant for the workload is a common staff level mistake.

Jump consistent hash (Lamping and Veach, Google 2014) computes `jumpHash(key, numBuckets)` in roughly 5 nanoseconds with zero memory and zero ring data structure. It guarantees exactly `K/N` keys move when you go from N to N plus 1 buckets, which is provably optimal. It cannot handle node removal mid range (you can only shrink the bucket count from the top), and it cannot handle weighted nodes, so it is ideal for a homogeneous fleet where the shard count is the only state and shards are only added. Google uses it internally for sharding stateless services. The implementation is a 7 line function, no ring required.

Rendezvous hashing (also called Highest Random Weight or HRW, Thaler and Ravishankar 1996) computes `hash(node, key)` for every node and picks the node with the highest hash. It is O(N) per lookup but supports arbitrary weights trivially (multiply the hash by the weight), handles node removal cleanly, and gives you the top K nodes for free by picking the K highest scores. For small N (under 100 nodes) it is often faster than ring lookup in practice because of cache locality. It is what Oracle Coherence and some CDN layers use internally.

Maglev hashing (Eisenbud et al., Google 2016) precomputes a large lookup table (typically 65537 entries) where each entry points at a backend. Lookup is O(1) via a single memory access. It trades a small amount of balance (within 1 percent of ideal) for lookup speed, and it is what powers Google Cloud Load Balancer and the Envoy proxy's Maglev mode. Use Maglev when lookup latency is on the critical path of every request and the backend set changes rarely.

Bounded load consistent hashing (Mirrokni, Thorup, Zadimoghaddam, Google 2017) solves a specific production problem. Pure consistent hashing says key X always goes to node Y. But if node Y is already overloaded, you want to spill to node Y plus 1. Bounded load adds a cap: no node may receive more than `(1 plus epsilon)` times average load, where epsilon is typically 0.25. When a node hits the cap, the algorithm walks the ring to the next node with capacity. This is what Envoy uses for sticky session balancing and what Vimeo described in their 2016 blog post. It is the correct variant whenever you are load balancing to stateful workers where work has cost but cache locality matters.

Virtual node design at scale has its own subtleties. Cassandra's default of 256 vnodes per physical node was chosen before heterogeneous clusters were common, and the Cassandra community moved to 16 vnodes as the recommended default in 4.0 because 256 vnodes caused repair and streaming overhead to explode on large clusters. The right vnode count is a trade off between distribution smoothness (more is better) and operational cost during rebalance and repair (fewer is better). For an application level consistent hash router with hundreds of shards, 100 to 200 vnodes is fine. For a distributed database with thousands of nodes, 16 to 64 vnodes is better.

Hash function choice matters more than most engineers realize. FNV 1a has known weaknesses on short keys and clusters near powers of two. Murmur3 is the de facto standard for non cryptographic hashing in distributed systems and is what Cassandra and ScyllaDB use. xxhash (xxh64, xxh3) is faster than Murmur3 on modern hardware with better distribution properties and is what ClickHouse uses internally. Never use md5 or sha1 for sharding, they are slow and their cryptographic properties are wasted. Never use Go's map hash (runtime.memhash), it is randomized per process and will give you different shard assignments on every restart.

Production footguns that cause incidents. First, reshaping the vnode assignment is a full remap. If you change replica count from 100 to 150, every key potentially moves. Pick the vnode count once and never change it. Second, hash collisions in the ring. Two different virtual node keys hashing to the same `uint32` is rare but not impossible at scale, and the naive implementation above silently overwrites `ch.nodes[hash]`, corrupting the ring. Production implementations either use `uint64` hashes or handle collisions explicitly. Third, the `RemoveNode` path above is O(R times N) where R is replicas and N is ring size, because of the inner linear scan. At 10000 vnodes this is slow enough to starve other readers under the write lock. Use a sorted structure or batch rebuild. Fourth, concurrent reads during `AddNode` see the ring in an inconsistent state while `sort.Slice` runs because the write holds the lock and readers are blocked, but any bug that leaks a ring slice to a reader outside the lock creates a data race. The right pattern is copy on write, build the new ring, atomic swap the pointer.

Real world deployments. Amazon DynamoDB uses consistent hashing internally over a 128 bit keyspace with virtual nodes, originally described in the 2007 Dynamo paper. Cassandra and ScyllaDB both use Murmur3 partitioner with vnodes. Memcached clients (ketama, libmemcached) use MD5 based consistent hashing with 160 vnodes per server, a convention that dates to 2007 and is still the interop standard. Envoy supports ring hash, Maglev, and bounded load and you choose per cluster via configuration. Discord's 2017 migration from Redis to Cassandra used consistent hashing at the Redis layer to let them shrink the Redis fleet online. Cloudflare uses Rendezvous hashing for some internal load balancing because of its weighted node support. Knowing which algorithm is in which system is a routine staff plus interview expectation at FAANG infrastructure teams, so memorize the mapping.

---
