## 37I.9 Consistent Hashing for Cache Clusters

### Distributed Cache Routing

There are three consistent-hashing families in common production use, each with different trade-offs:

1. **Ring with virtual nodes** (classic Karger et al., 1997). Each physical node gets 150-200 positions on a sorted token ring. lookups do binary search in O(log V). Flexible - supports weighted nodes, replication, bounded-load variants - but needs an in-memory data structure that has to be kept in sync across processes. The code below implements this family, and `buraksezer/consistent` is the production-grade Go library (used by Olric, SeaweedFS, OpenTelemetry Operator) if you want bounded-load consistent hashing without rolling your own.
2. **Jump hash** (Lamping & Veach, 2014). A tiny closed-form function: given a key and the cluster size N, it returns a shard index in O(log N) time and uses zero memory. The catch is that nodes can only be added or removed from the **end** of the list, so it is a poor fit for arbitrary node failures - but perfect for stateless shard-count changes (e.g., growing a cache cluster from 16 to 32 shards).
3. **Rendezvous / Highest Random Weight (HRW)** (Thaler & Ravishankar, 1996). For each key, compute `hash(key, nodeID)` for every node and pick the node with the highest score. O(N) per lookup but needs no pre-built data structure, gives exact uniformity without virtual nodes, and handles arbitrary node adds/removes cleanly. Excellent for clusters under ~50 nodes. `nspcc-dev/hrw` is a solid Go implementation.

**Rule of thumb:** use jump hash when the shard count only grows and shrinks at the tail, use HRW for small clusters where O(N) is fine, and use a ring with vnodes (or `buraksezer/consistent`) for large dynamic clusters with per-key replication requirements.

`ConsistentHashRing` below maps each physical node to `vnodes` virtual positions on a sorted token ring by hashing `"node-address-N"` with SHA-256, ensuring that adding or removing a node only remaps a fraction `1/N` of keys rather than the full keyspace. `slices.Sort` keeps the ring ordered so that binary search can find the responsible node in O(log V) time per lookup. Setting `vnodes` to 150-200 per node provides sufficient ring uniformity for most production cluster sizes. The `GetNodes` method returns N distinct physical nodes for a given key, which is useful for replication. Store a cache entry on the primary node and one or two replicas to survive node failures. The `ShardedCacheClient` at the end ties the ring to actual Redis connections, routing each `Get` and `Set` to the correct shard.

```go
package cache

import (
	"context"
	"crypto/sha256"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ConsistentHashRing implements consistent hashing for cache sharding
// Distributes keys evenly across nodes with minimal remapping on add/remove
type ConsistentHashRing struct {
	mu       sync.RWMutex
	vnodes   int           // virtual nodes per physical node
	ring     []uint32      // sorted token ring
	nodes    map[uint32]string // token → node address
}

// NewConsistentHashRing creates a ring with vnodes virtual nodes per server
func NewConsistentHashRing(vnodes int) *ConsistentHashRing {
	return &ConsistentHashRing{
		vnodes: vnodes,
		nodes:  make(map[uint32]string),
	}
}

// AddNode adds a node to the ring
func (r *ConsistentHashRing) AddNode(addr string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := 0; i < r.vnodes; i++ {
		token := r.hash(fmt.Sprintf("%s#%d", addr, i))
		r.ring = append(r.ring, token)
		r.nodes[token] = addr
	}
	slices.Sort(r.ring)
}

// RemoveNode removes a node from the ring
func (r *ConsistentHashRing) RemoveNode(addr string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := 0; i < r.vnodes; i++ {
		token := r.hash(fmt.Sprintf("%s#%d", addr, i))
		delete(r.nodes, token)
	}

	// Rebuild sorted ring
	r.ring = r.ring[:0]
	for token := range r.nodes {
		r.ring = append(r.ring, token)
	}
	slices.Sort(r.ring)
}

// GetNode returns the node responsible for the given key
func (r *ConsistentHashRing) GetNode(key string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.ring) == 0 {
		return ""
	}

	hash := r.hash(key)

	// Binary search for first token >= hash
	idx, _ := slices.BinarySearch(r.ring, hash)

	// Wrap around
	if idx == len(r.ring) {
		idx = 0
	}

	return r.nodes[r.ring[idx]]
}

// GetNodes returns N nodes for replication
func (r *ConsistentHashRing) GetNodes(key string, n int) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.ring) == 0 {
		return nil
	}

	hash := r.hash(key)
	idx, _ := slices.BinarySearch(r.ring, hash)

	seen := make(map[string]bool)
	var result []string

	for i := 0; i < len(r.ring) && len(result) < n; i++ {
		token := r.ring[(idx+i)%len(r.ring)]
		node := r.nodes[token]
		if !seen[node] {
			seen[node] = true
			result = append(result, node)
		}
	}
	return result
}

func (r *ConsistentHashRing) hash(key string) uint32 {
	h := sha256.Sum256([]byte(key))
	return uint32(h[0])<<24 | uint32(h[1])<<16 | uint32(h[2])<<8 | uint32(h[3])
}

// ShardedCacheClient routes cache operations to correct shard
type ShardedCacheClient struct {
	ring    *ConsistentHashRing
	clients map[string]*redis.Client
}

func (s *ShardedCacheClient) Get(ctx context.Context, key string) (string, error) {
	node := s.ring.GetNode(key)
	client, ok := s.clients[node]
	if !ok {
		return "", fmt.Errorf("no client for node %s", node)
	}
	return client.Get(ctx, key).Result()
}

func (s *ShardedCacheClient) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	node := s.ring.GetNode(key)
	client, ok := s.clients[node]
	if !ok {
		return fmt.Errorf("no client for node %s", node)
	}
	return client.Set(ctx, key, value, ttl).Err()
}
```

### Jump Hash (Zero-Memory Alternative)

Lamping and Veach's jump hash is the simplest consistent-hashing variant to get right: no ring, no virtual nodes, no lock. Given a 64-bit key and a shard count `numBuckets`, it returns the bucket index that owns the key. Ideal for sharding a fixed or grow-only cluster.

```go
// JumpHash implements Lamping & Veach's consistent hash.
// Zero memory, O(log N) time, but only supports growth at the tail.
func JumpHash(key uint64, numBuckets int32) int32 {
    var b, j int64 = -1, 0
    for j < int64(numBuckets) {
        b = j
        key = key*2862933555777941757 + 1
        j = int64(float64(b+1) * (float64(int64(1)<<31) / float64((key>>33)+1)))
    }
    return int32(b)
}
```

For small clusters where you need to handle arbitrary node failures, rendezvous hashing is just as small and gives exact uniformity:

```go
// HRWPick returns the node with the highest score for the given key.
// O(N) per lookup - use for clusters with fewer than ~50 nodes.
func HRWPick(key string, nodes []string) string {
    var best string
    var bestScore uint64
    for _, node := range nodes {
        h := sha256.Sum256([]byte(key + "\x00" + node))
        score := binary.BigEndian.Uint64(h[:8])
        if score > bestScore {
            bestScore = score
            best = node
        }
    }
    return best
}
```

### Junior to FAANG: Why Modulo Sharding Breaks and Consistent Hashing Fixes It

Every engineer eventually writes `shard = hash(key) % N` and thinks they have solved sharding. Then the cluster grows from 4 shards to 5 and 80 percent of keys move to different shards overnight. Every cache entry on the old layout is useless on the new layout. The cache hit rate collapses to near zero for the duration of the warmup, the origin database sees a flood of cold-start traffic, and the service has a two-hour degraded-performance incident that will show up in the postmortem as "cache warm-up cost during scaling event."

That is the problem consistent hashing solves. The guarantee: when you add or remove a node, only `1/N` of the keys move to different nodes. With `N=4` growing to `N=5`, 20 percent of keys move instead of 80 percent. The hit rate stays mostly warm. The origin does not melt. Scaling becomes a routine operation instead of an incident. This is not an optimization. It is the minimum bar for any distributed cache tier that needs to scale in production.

Internalize the three families from the introduction above. Ring-with-vnodes is the general-purpose solution and what most production systems use. Jump hash is specialized and perfect when your cluster only grows by adding shards at the end. Rendezvous (HRW) is the simplest to implement correctly and ideal for small clusters. Know which to reach for.

Worked example. You have 100M cache entries distributed across 10 Redis nodes. You want to scale to 12 nodes during a traffic spike. With modulo sharding, 83 percent of keys (10/12 of the ratio difference) relocate. Your cache hit rate drops from 95 percent to 12 percent. Your origin sees an 83-percentage-point miss-rate increase, which at 1M QPS is an extra 830k QPS to the database. The database was sized for 50k QPS of misses. It falls over. With consistent hashing via ring-and-vnodes, only about 17 percent of keys move (2/12), the hit rate drops from 95 to about 79 percent, and the origin sees an extra 160k QPS. Still a spike, but survivable with the spare capacity most databases have.

Virtual nodes explained. A naive ring with one token per physical node produces uneven distribution. With 4 nodes, tokens land at arbitrary positions on the ring, and one node may own 40 percent of the keyspace while another owns 10 percent. The fix is virtual nodes: each physical node gets 150 to 200 token positions scattered around the ring. Load balances to within a few percent of uniform by the law of large numbers. More vnodes gives better balance but costs memory for the ring and CPU for sort operations. 150 to 200 is the accepted sweet spot. The code above uses a configurable `vnodes` parameter.

Interview entry-point. "How would you shard a distributed cache" is a system-design staple. Answer "consistent hashing" and then explain why modulo fails. Describe ring-with-vnodes as the default. Mention jump hash as a zero-memory alternative when shard count only grows. Mention HRW for small clusters. If asked about replication, explain that `GetNodes(key, N)` returns N distinct physical nodes by walking the ring, and the primary writes to all N replicas synchronously or asynchronously depending on the consistency model. This is how Dynamo and Cassandra route replicas. Then mention hot-key mitigation: even with perfect consistent hashing, a hot key lives on one node and can hotspot that node. The fix is replica read balancing or shard bursting, not more hashing.

Common junior mistakes. Using `%` or a weak hash for the ring. Use SHA-256 or xxhash, never `hash/fnv` at scale because short keys cluster in FNV. Forgetting to include the vnode index in the hash input, which gives every physical node the same position. Resorting the ring on every lookup instead of only on membership change. Holding a write lock for reads. The code above correctly uses `RWMutex` with `RLock` for `GetNode`. Assuming ring membership is global. In multi-region or multi-cluster deployments, each cluster has its own ring, and the key-to-cluster routing is a separate layer (often DNS or Anycast with sticky session routing).

### Senior at FAANG: Consistent Hashing Under Real Production Conditions

At staff and principal level, consistent hashing is a routing primitive and the interesting engineering is in the layers around it: bounded load, hot-key handling, replication-aware routing, rebalance scheduling, and the tradeoffs with centralized shard maps. The code in this file is a correct starting point but production systems add substantial machinery on top.

Bounded-load consistent hashing (Mirrokni, Thorup, Zadimoghaddam, Google 2017) is the algorithm Vimeo used in their Haruki proxy and Google uses in several internal systems. Plain consistent hashing guarantees `1/N` key remapping on membership change but does not bound the load imbalance between nodes under Zipfian access patterns. Hot keys cluster on whichever node owns them, and virtual nodes do not help because they balance keyspace, not access. The bounded-load variant adds a capacity constraint: each node accepts keys up to `c * avg_load` for some constant `c` (typically 1.25). When a key's primary node is at capacity, it spills to the next node on the ring. The theoretical guarantee is that no node exceeds `c * avg_load` while remapping is still `O(1/N)` on membership change. `buraksezer/consistent` implements this. Use it for any production cache tier where access is Zipfian, which is almost always.

Maglev (Eisenbud et al., Google 2016) is the consistent-hashing algorithm from Google's software network load balancer of the same name. It pre-computes a lookup table of size `M` (where `M` is a large prime, typically 65537 or 655373) mapping table slots to backend nodes. Each node fills the table according to a permutation derived from the node identity. Lookups are O(1) table index. Rebalance on node change remaps roughly `1/N` of table entries. The advantage over ring-with-vnodes is lookup speed (single array index instead of log N binary search) and cache-friendly memory access. The disadvantage is that the table must be rebuilt on membership change, which is O(M) but only happens on topology change, not per request. Envoy's Maglev load balancer uses this. For cache tiers at 100k QPS or more per client, Maglev's lookup speed is measurable. For lower QPS services, the ring is fine.

Hot-key detection and replication-aware routing. Even bounded-load hashing funnels all reads of a single hot key to one primary node. If one product page receives 100k QPS and the Redis node handles 50k QPS per core, you have a hotspot. Mitigations: replicate the hot key to K additional nodes and hash the key plus a random integer in `[0,K]` on read, spreading the reads across K+1 nodes. Writes still go to all K+1 replicas. This is shard bursting. Detection uses a count-min sketch or Redis 8.0 `TOPK` to identify hot keys in real time. Promotion happens automatically when a key crosses a QPS threshold. Meta's McRouter (a memcached proxy) and Netflix's EVCache both implement variants of this. The replication factor can be dynamic: 1 for cold keys, 3 for warm, 10 for celebrity. Tradeoff is write amplification.

Rebalance scheduling. When you add a node, the ideal case is that `1/N` of keys quietly move from other nodes to the new node with no downtime. In practice, the movement is a stampede: every client simultaneously observes the membership change and shifts traffic. The destination node sees a cold cache and hammers the origin to populate. Mitigate with data-hand-off: the existing owner streams the relevant key range to the new owner before clients switch. During the stream, clients route reads to both nodes (old owner returns the value, new owner builds the cache). After the stream completes, clients switch fully. Riak, Cassandra, and DynamoDB use variants of this. For cache tiers, a simpler mitigation is to trickle the membership change: do not add 1 node at a time, add with a soft TTL on the old mapping so the old owner still serves reads for a grace period while the new owner warms up. Netflix EVCache uses a "moneta" layer that keeps a RocksDB copy of hot keys per node, making the cold-start after rebalance much faster.

Centralized shard map versus distributed consistent hash. The tradeoff is famous. Distributed consistent hashing (every client computes the same ring independently) avoids a central coordinator and scales infinitely, but requires every client to agree on membership, which is a gossip or config-push problem. Centralized shard map (ZooKeeper, etcd, Consul holds authoritative mapping) makes arbitrary routing logic possible (for example, "all keys for tenant X go to cluster Y") but adds a failure dependency. At FAANG scale, both patterns coexist. Cache tier routing uses consistent hashing for stateless scalability. Database sharding uses centralized shard maps because the routing rules encode business logic. Choose based on whether routing needs to be programmable or just uniform.

Client-side proxy or server-side proxy. Two production architectures. Client-side: every application binary embeds the consistent hash ring and speaks directly to Redis nodes. Low latency, but every client must stay in sync with membership, and Redis auth and TLS become an N-to-M problem. Server-side: a proxy fleet (Twemproxy, mcrouter, Envoy with its Maglev filter, Pegasus) accepts connections from applications and routes to shards. Adds a hop (sub-millisecond), centralizes auth, hides topology changes, enables connection pooling and request coalescing. At FAANG scale, server-side is the norm. The proxy becomes a platform layer. In Go, you can build a thin server-side proxy using `net.Listen` with the go-redis protocol parser and the consistent hash code above. For production, prefer Envoy with Redis filter or mcrouter over a hand-rolled proxy.

Replication-aware routing. With replicas, a read can go to any of K nodes but a write must go to all (or a quorum). Route reads randomly across replicas for load distribution. Route writes to all replicas in parallel for durability. Failed writes require a reconciliation path: either retry until success, log to a dead-letter queue, or write to a durable store and replay asynchronously. For strong consistency, use quorum reads and writes (R + W > N). For eventual consistency, writes can proceed with just the primary and replicate asynchronously. The latter is the common cache model since cache staleness is already tolerated.

Cluster topology awareness. A naive consistent hash distributes keys uniformly across node identities but does not know about failure domains. If three replicas land in the same rack and the rack loses power, all three are gone. Fix with rack-aware (or zone-aware, or region-aware) hashing: the `GetNodes(key, N)` function walks the ring but skips nodes in the same failure domain as already-selected nodes. This costs a bit of balance but dramatically improves availability. Cassandra's NetworkTopologyStrategy, DynamoDB's multi-AZ placement, and Meta's regional cache tiering all do this. For a pure cache where replicas are optional, a simpler mitigation is to cap the replication factor by failure domain count.

Hash function selection. SHA-256 is safe but slow. xxhash (xxhash64) is 10x faster at the cost of cryptographic weakness, which is irrelevant for routing. Use xxhash or xxh3 for hot-path routing. Use SHA-256 only if you need collision resistance against adversarial keys (for example, user-controlled cache keys in a multi-tenant system). The 32-bit truncation in the code above is acceptable for the ring (no cryptographic need) but use 64-bit hashes for large clusters to avoid collisions between vnode positions. With 10 nodes and 200 vnodes each, 2000 positions on a 32-bit ring have a non-negligible birthday-probability collision. Use uint64 tokens for any cluster that might grow past 100 nodes.

Observability. Track: per-node key count (should converge to uniform under bounded-load), per-node request rate, request rate imbalance (max / mean), hot-key detector output, rebalance progress (bytes streamed, keys moved), and proxy latency percentiles. Alert on imbalance above 1.5x, which indicates the hash function is underperforming or hot keys need promotion. Alert on per-node saturation ahead of imbalance, because saturation is what matters to users. Rebalance should complete within a target time (typically an hour for a large cluster), and progress should be monotone.

Interview framing for staff. When asked "design a sharded cache," do not say "use consistent hashing." That is a junior answer. Describe the topology choice (client-side versus server-side proxy), the algorithm choice (ring-with-vnodes versus Maglev versus jump), the bounded-load extension, the hot-key mitigation with shard bursting, the rebalance protocol with data hand-off, and the failure-domain-aware replica placement. Mention that in 2026 a new service at FAANG would use Envoy with Maglev as the default, Redis cluster with rack-aware replica placement, and a TOPK-driven hot-key promoter. The candidate who names these components by reference demonstrates operator-level familiarity, which is the staff bar.

---
