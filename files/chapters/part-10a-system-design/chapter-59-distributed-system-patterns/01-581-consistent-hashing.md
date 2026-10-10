## 59.1 Consistent Hashing

Consistent hashing solves the fundamental problem of distributing data across multiple nodes while minimizing redistribution when nodes are added or removed.

### The Problem with Simple Hashing

The naive approach of computing `hash(key) % numNodes` works fine when the cluster is static, but falls apart the moment a node is added or removed. Because the modulus changes, virtually every key maps to a different node, which forces a full cache invalidation or data migration regardless of how small the cluster change was.

```go
// simple_hash.go
package main

import (
    "fmt"
    "hash/fnv"
)

// SimpleHash distributes keys across N nodes
// Problem: Adding/removing nodes redistributes almost all keys
func SimpleHash(key string, numNodes int) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32()) % numNodes
}

func main() {
    keys := []string{"user:1", "user:2", "user:3", "user:4", "user:5"}

    fmt.Println("With 3 nodes:")
    for _, key := range keys {
        fmt.Printf("  %s -> node %d\n", key, SimpleHash(key, 3))
    }

    fmt.Println("\nWith 4 nodes (added one node):")
    for _, key := range keys {
        fmt.Printf("  %s -> node %d\n", key, SimpleHash(key, 4))
    }
    // Almost all keys moved to different nodes!
}
```

### Hash Ring Implementation

The `HashRing` type places each physical node at multiple positions on a circular hash space using virtual nodes, which dramatically improves load distribution compared to a single-point placement. A read/write mutex guards all ring operations so the structure is safe for concurrent use, and a sorted slice of hash values enables O(log n) key lookups via binary search.

```go
// consistent_hash.go
package consistenthash

import (
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "sort"
    "sync"
)

// HashRing implements consistent hashing with virtual nodes
type HashRing struct {
    mu           sync.RWMutex
    ring         []uint32          // Sorted hash values
    nodes        map[uint32]string // Hash -> node mapping
    virtualNodes int               // Virtual nodes per physical node
    nodeSet      map[string]bool   // Set of physical nodes
}

// NewHashRing creates a new consistent hash ring
func NewHashRing(virtualNodes int) *HashRing {
    if virtualNodes <= 0 {
        virtualNodes = 150 // Default: 150 virtual nodes per physical node
    }
    return &HashRing{
        ring:         make([]uint32, 0),
        nodes:        make(map[uint32]string),
        virtualNodes: virtualNodes,
        nodeSet:      make(map[string]bool),
    }
}

// hash generates a consistent hash for a key
func (h *HashRing) hash(key string) uint32 {
    hasher := sha256.New()
    hasher.Write([]byte(key))
    hash := hasher.Sum(nil)
    return binary.BigEndian.Uint32(hash[:4])
}

// AddNode adds a node with virtual nodes to the ring
func (h *HashRing) AddNode(node string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if h.nodeSet[node] {
        return // Node already exists
    }

    h.nodeSet[node] = true

    // Add virtual nodes
    for i := 0; i < h.virtualNodes; i++ {
        virtualKey := fmt.Sprintf("%s#%d", node, i)
        hash := h.hash(virtualKey)
        h.ring = append(h.ring, hash)
        h.nodes[hash] = node
    }

    // Keep ring sorted for binary search
    sort.Slice(h.ring, func(i, j int) bool {
        return h.ring[i] < h.ring[j]
    })
}

// RemoveNode removes a node and its virtual nodes from the ring
func (h *HashRing) RemoveNode(node string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if !h.nodeSet[node] {
        return
    }

    delete(h.nodeSet, node)

    // Remove virtual nodes
    newRing := make([]uint32, 0, len(h.ring)-h.virtualNodes)
    for _, hash := range h.ring {
        if h.nodes[hash] != node {
            newRing = append(newRing, hash)
        } else {
            delete(h.nodes, hash)
        }
    }
    h.ring = newRing
}

// GetNode returns the node responsible for a key
func (h *HashRing) GetNode(key string) string {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if len(h.ring) == 0 {
        return ""
    }

    hash := h.hash(key)

    // Binary search for the first node with hash >= key hash
    idx := sort.Search(len(h.ring), func(i int) bool {
        return h.ring[i] >= hash
    })

    // Wrap around to the first node if we're past the end
    if idx >= len(h.ring) {
        idx = 0
    }

    return h.nodes[h.ring[idx]]
}

// GetNodes returns N nodes for replication
func (h *HashRing) GetNodes(key string, count int) []string {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if len(h.ring) == 0 {
        return nil
    }

    hash := h.hash(key)
    idx := sort.Search(len(h.ring), func(i int) bool {
        return h.ring[i] >= hash
    })

    if idx >= len(h.ring) {
        idx = 0
    }

    // Collect unique physical nodes
    seen := make(map[string]bool)
    result := make([]string, 0, count)

    for i := 0; len(result) < count && i < len(h.ring); i++ {
        nodeIdx := (idx + i) % len(h.ring)
        node := h.nodes[h.ring[nodeIdx]]

        if !seen[node] {
            seen[node] = true
            result = append(result, node)
        }
    }

    return result
}

// NodeCount returns the number of physical nodes
func (h *HashRing) NodeCount() int {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return len(h.nodeSet)
}

// Nodes returns all physical nodes
func (h *HashRing) Nodes() []string {
    h.mu.RLock()
    defer h.mu.RUnlock()

    nodes := make([]string, 0, len(h.nodeSet))
    for node := range h.nodeSet {
        nodes = append(nodes, node)
    }
    return nodes
}
```

### Weighted Consistent Hashing

Not all nodes in a cluster have equal capacity, a node with twice the memory and CPU should absorb twice the key space. `WeightedHashRing` implements this by multiplying the base virtual node count by each node's weight, so heavier nodes occupy proportionally more positions on the ring without any changes to the key-lookup logic.

```go
// weighted_hash.go
package consistenthash

import (
    "fmt"
    "strings"
    "sync"
)

// WeightedHashRing supports nodes with different capacities
type WeightedHashRing struct {
    mu              sync.RWMutex
    ring            *HashRing
    weights         map[string]int
    baseVirtualNodes int
}

// NewWeightedHashRing creates a weighted consistent hash ring
func NewWeightedHashRing(baseVirtualNodes int) *WeightedHashRing {
    return &WeightedHashRing{
        ring:             NewHashRing(1), // We'll manage virtual nodes manually
        weights:          make(map[string]int),
        baseVirtualNodes: baseVirtualNodes,
    }
}

// AddNode adds a node with a specific weight
// Weight represents relative capacity (e.g., weight=2 gets 2x the keys)
func (w *WeightedHashRing) AddNode(node string, weight int) {
    w.mu.Lock()
    defer w.mu.Unlock()

    if weight <= 0 {
        weight = 1
    }

    w.weights[node] = weight

    // Add proportional number of virtual nodes
    virtualNodes := w.baseVirtualNodes * weight
    for i := 0; i < virtualNodes; i++ {
        w.ring.AddNode(fmt.Sprintf("%s#%d", node, i))
    }
}

// RemoveNode removes a node and all its virtual nodes
func (w *WeightedHashRing) RemoveNode(node string) {
    w.mu.Lock()
    defer w.mu.Unlock()

    weight, exists := w.weights[node]
    if !exists {
        return
    }

    delete(w.weights, node)

    virtualNodes := w.baseVirtualNodes * weight
    for i := 0; i < virtualNodes; i++ {
        w.ring.RemoveNode(fmt.Sprintf("%s#%d", node, i))
    }
}

// GetNode returns the node for a key (strips virtual node suffix)
func (w *WeightedHashRing) GetNode(key string) string {
    w.mu.RLock()
    defer w.mu.RUnlock()

    virtualNode := w.ring.GetNode(key)
    if virtualNode == "" {
        return ""
    }

    // Strip the "#i" suffix at the last separator. Prefix matching
    // against the weights map would be wrong here: "cache-1" is a
    // prefix of "cache-10", and map iteration order is random, so a
    // virtual node of cache-10 could be misattributed to cache-1.
    if i := strings.LastIndex(virtualNode, "#"); i >= 0 {
        return virtualNode[:i]
    }
    return virtualNode
}
```

### Jump Consistent Hashing

When nodes are numbered sequentially (0 through N-1) and you do not need to remove arbitrary nodes from the middle, jump consistent hashing offers a simpler and faster alternative. Google published this algorithm in 2014. It runs in O(ln n) time with O(1) memory and produces near-perfect distribution without virtual nodes or a hash ring data structure. The trade-off is that you can only add or remove nodes at the end of the sequence, removing node 3 out of 10 is not supported.

```go
// jump_hash.go
package consistenthash

// JumpConsistentHash implements Google's jump consistent hash
// Paper: "A Fast, Minimal Memory, Consistent Hash Algorithm"
// O(ln(n)) time, O(1) space
func JumpConsistentHash(key uint64, numBuckets int32) int32 {
    var b int64 = -1
    var j int64 = 0

    for j < int64(numBuckets) {
        b = j
        key = key*2862933555777941757 + 1
        j = int64(float64(b+1) * (float64(int64(1)<<31) / float64((key>>33)+1)))
    }

    return int32(b)
}

// JumpHash is a convenient wrapper for string keys
func JumpHash(key string, numBuckets int32) int32 {
    h := fnv64a(key)
    return JumpConsistentHash(h, numBuckets)
}

func fnv64a(key string) uint64 {
    var hash uint64 = 14695981039346656037
    for i := 0; i < len(key); i++ {
        hash ^= uint64(key[i])
        hash *= 1099511628211
    }
    return hash
}
```

### Bounded Load Consistent Hashing

Even with virtual nodes, consistent hashing can produce hot spots when request patterns are skewed, a few popular keys may all hash to the same physical node. Google's "Consistent Hashing with Bounded Loads" paper addresses this by capping how much load any single node can accept relative to the average. When a node exceeds its bound, the request spills over to the next node on the ring, spreading the load without changing key ownership for non-hot keys.

```go
// bounded_load.go
package consistenthash

import (
    "sync"
    "sync/atomic"
)

// BoundedLoadHashRing implements consistent hashing with bounded loads
// Based on Google's "Consistent Hashing with Bounded Loads" paper
type BoundedLoadHashRing struct {
    mu          sync.RWMutex
    ring        *HashRing
    loads       map[string]*int64 // Current load per node
    totalLoad   int64
    loadFactor  float64 // Load balancing factor (>= 1.0)
}

// NewBoundedLoadHashRing creates a new bounded load hash ring
func NewBoundedLoadHashRing(virtualNodes int, loadFactor float64) *BoundedLoadHashRing {
    if loadFactor < 1.0 {
        loadFactor = 1.25 // Default: 25% overload tolerance
    }
    return &BoundedLoadHashRing{
        ring:       NewHashRing(virtualNodes),
        loads:      make(map[string]*int64),
        loadFactor: loadFactor,
    }
}

// AddNode adds a node to the ring
func (b *BoundedLoadHashRing) AddNode(node string) {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.ring.AddNode(node)
    var zero int64
    b.loads[node] = &zero
}

// RemoveNode removes a node from the ring
func (b *BoundedLoadHashRing) RemoveNode(node string) {
    b.mu.Lock()
    defer b.mu.Unlock()

    if load, ok := b.loads[node]; ok {
        atomic.AddInt64(&b.totalLoad, -atomic.LoadInt64(load))
        delete(b.loads, node)
    }
    b.ring.RemoveNode(node)
}

// GetNode returns a node respecting load bounds
func (b *BoundedLoadHashRing) GetNode(key string) string {
    b.mu.RLock()
    defer b.mu.RUnlock()

    nodeCount := b.ring.NodeCount()
    if nodeCount == 0 {
        return ""
    }

    // Calculate average load and maximum allowed
    avgLoad := float64(atomic.LoadInt64(&b.totalLoad)) / float64(nodeCount)
    maxLoad := int64(b.loadFactor * avgLoad)
    if maxLoad < 1 {
        maxLoad = 1
    }

    // Get candidate nodes in order of preference
    candidates := b.ring.GetNodes(key, nodeCount)

    // Find first node under the load limit
    for _, node := range candidates {
        load := b.loads[node]
        if load != nil && atomic.LoadInt64(load) < maxLoad {
            return node
        }
    }

    // Fallback: return first candidate
    if len(candidates) > 0 {
        return candidates[0]
    }
    return ""
}

// IncrementLoad increases the load count for a node
func (b *BoundedLoadHashRing) IncrementLoad(node string) {
    b.mu.RLock()
    load := b.loads[node]
    b.mu.RUnlock()

    if load != nil {
        atomic.AddInt64(load, 1)
        atomic.AddInt64(&b.totalLoad, 1)
    }
}

// DecrementLoad decreases the load count for a node
func (b *BoundedLoadHashRing) DecrementLoad(node string) {
    b.mu.RLock()
    load := b.loads[node]
    b.mu.RUnlock()

    if load != nil {
        atomic.AddInt64(load, -1)
        atomic.AddInt64(&b.totalLoad, -1)
    }
}
```

### Junior -> FAANG: Understanding Why Consistent Hashing Exists

The core insight to internalize is that `hash(key) % N` has a catastrophic failure mode when N changes. If you have three cache nodes and add a fourth, the modulus jumps from 3 to 4, which changes the result for almost every key. Your cache hit rate drops to near zero while everything rehydrates. This is not hypothetical: it is what happens when a deployment adds or removes a pod in a cache tier.

Consistent hashing solves this by placing both nodes and keys on a circular space and assigning each key to the first node clockwise from it. When you add a node, it only claims keys from the single neighboring node to its left on the ring. When you remove a node, its keys migrate to the single neighboring node to its right. The expected churn is `keys / (N+1)` for an addition, not `keys * N/(N+1)`.

Virtual nodes are the critical production detail. Without them, a ring with five nodes has only five points, and probability alone can give one node 60% of the ring space. Adding 150 virtual nodes per physical node spreads each physical node evenly around the ring, so the expected key share per physical node converges to `1/N` with low variance.

For a first-job interview, be able to sketch the ring on a whiteboard, explain why wraparound is needed (the ring has no end), and explain what virtual nodes buy you. Know that SHA-256 or MD5 is preferred over FNV for consistent hashing because you need uniform distribution across the full uint32 space, not just speed.

Common mistake to avoid: using a fast but poorly-mixing hash like FNV over the full virtual-node string. With a well-mixed hash such as SHA-256, the `host#i` suffix scheme used in the implementation above distributes fine even when hostnames share long prefixes (`cache-shard-01`, `cache-shard-02`), because a single differing byte changes the whole digest. With a weak hash, similar inputs can cluster on the ring.

### Senior @ FAANG: Operational Realities and ADRs for Consistent Hashing

At scale, consistent hashing has operational gotchas that are invisible in a toy implementation. The first is rebalancing lag. When you add a node to a production Cassandra or Dynamo cluster, keys do not teleport to the new node. The system streams data from the prior owner. During this window, the ring says the new node owns a key, but the key has not arrived yet. The cluster must serve reads from the old owner until the migration is complete, which requires either a two-phase handoff (read from both owners and return the newest) or a freeze on writes to migrated key ranges during migration. This is why Cassandra's `nodetool cleanup` is a separate step run after the ring stabilizes.

The second gotcha is the virtual node count trade-off. More virtual nodes means better distribution uniformity but also more memory and a more expensive `AddNode` operation (O(V log V) sort where V is total virtual node count). For a ring with 100 physical nodes and 150 virtual nodes each, you have 15,000 ring entries. The sort is cheap once but becomes notable if you are building a ring that clients rebuild from a gossip state update on every topology change.

ADR framing: if your topology changes infrequently (once per month for a database cluster), the standard virtual-node ring is correct. If your topology changes frequently (auto-scaling a stateless cache tier several times per day), jump consistent hashing deserves consideration: it is O(log N) lookup with O(1) memory and zero virtual nodes, but it only supports append-only node addition and removal from the tail, which is exactly what auto-scaling does.

Bounded-load hashing is the right choice when your access pattern has hot keys (popular social media posts, trending products) that would overwhelm a single node even with perfect ring distribution. The load factor parameter is the primary governance knob: too tight (1.05) and you get frequent spillover under normal variance, which adds routing latency. Too loose (2.0) and the "bound" provides no real protection. A load factor of 1.25 to 1.5 is the standard starting point. Tune it with p99 latency percentiles from the ring's hot node.

Staff-level concern: consistent hashing is a routing policy, not a replication policy. For replication you call `GetNodes(key, replicationFactor)` and write to all replicas. Quorum reads and writes then need a separate protocol (Dynamo's sloppy quorum, Cassandra's consistency level). Make sure your team understands this distinction before building a storage layer on top of a hash ring.

---
