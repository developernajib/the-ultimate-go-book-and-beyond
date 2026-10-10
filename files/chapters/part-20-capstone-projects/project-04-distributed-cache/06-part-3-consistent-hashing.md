## Part 3: Consistent Hashing

### Hash Ring Implementation

Consistent hashing solves a critical problem in distributed caches: when you add or remove a node, you want to redistribute as few keys as possible rather than reshuffling everything. The hash ring works by placing each node at multiple positions (called virtual nodes) on a circular number line from 0 to 2^32. When you need to find which node owns a given key, you hash the key and walk clockwise around the ring until you hit the first node position. Using 150 virtual nodes per physical node ensures that keys are distributed evenly, even when the cluster has only a few nodes.

```go
// internal/cluster/hashring.go
package cluster

import (
    "fmt"
    "hash/crc32"
    "sort"
    "sync"
)

const defaultVirtualNodes = 150

type HashRing struct {
    mu            sync.RWMutex
    ring          []uint32
    nodes         map[uint32]string
    virtualNodes  int
    sortedHashes  []uint32
}

func NewHashRing(virtualNodes int) *HashRing {
    if virtualNodes <= 0 {
        virtualNodes = defaultVirtualNodes
    }

    return &HashRing{
        nodes:        make(map[uint32]string),
        virtualNodes: virtualNodes,
        ring:         make([]uint32, 0),
    }
}

func (h *HashRing) AddNode(nodeID string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    for i := 0; i < h.virtualNodes; i++ {
        virtualKey := fmt.Sprintf("%s:%d", nodeID, i)
        hash := h.hash(virtualKey)
        h.nodes[hash] = nodeID
        h.ring = append(h.ring, hash)
    }

    sort.Slice(h.ring, func(i, j int) bool {
        return h.ring[i] < h.ring[j]
    })
    h.sortedHashes = h.ring
}

func (h *HashRing) RemoveNode(nodeID string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    newRing := make([]uint32, 0)

    for i := 0; i < h.virtualNodes; i++ {
        virtualKey := fmt.Sprintf("%s:%d", nodeID, i)
        hash := h.hash(virtualKey)
        delete(h.nodes, hash)
    }

    // Rebuild ring without removed node
    for hash, node := range h.nodes {
        if node != nodeID {
            newRing = append(newRing, hash)
        }
    }

    sort.Slice(newRing, func(i, j int) bool {
        return newRing[i] < newRing[j]
    })

    h.ring = newRing
    h.sortedHashes = newRing
}

func (h *HashRing) GetNode(key string) (string, bool) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if len(h.ring) == 0 {
        return "", false
    }

    hash := h.hash(key)

    // Binary search for the node
    idx := sort.Search(len(h.ring), func(i int) bool {
        return h.ring[i] >= hash
    })

    // Wrap around if necessary
    if idx == len(h.ring) {
        idx = 0
    }

    nodeHash := h.ring[idx]
    return h.nodes[nodeHash], true
}

func (h *HashRing) GetNodes(key string, count int) []string {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if len(h.ring) == 0 {
        return nil
    }

    hash := h.hash(key)

    // Binary search for the first node
    idx := sort.Search(len(h.ring), func(i int) bool {
        return h.ring[i] >= hash
    })

    if idx == len(h.ring) {
        idx = 0
    }

    // Collect unique nodes
    seen := make(map[string]bool)
    nodes := make([]string, 0, count)

    for i := 0; i < len(h.ring) && len(nodes) < count; i++ {
        nodeIdx := (idx + i) % len(h.ring)
        nodeHash := h.ring[nodeIdx]
        nodeID := h.nodes[nodeHash]

        if !seen[nodeID] {
            seen[nodeID] = true
            nodes = append(nodes, nodeID)
        }
    }

    return nodes
}

func (h *HashRing) hash(key string) uint32 {
    return crc32.ChecksumIEEE([]byte(key))
}

func (h *HashRing) NodeCount() int {
    h.mu.RLock()
    defer h.mu.RUnlock()

    unique := make(map[string]bool)
    for _, node := range h.nodes {
        unique[node] = true
    }
    return len(unique)
}
```

---

### Junior → FAANG: Consistent Hashing as a Core Interview Topic

Consistent hashing appears in almost every distributed systems interview. The key insight: with a naive modulo-based distribution (`key_hash % num_nodes`), adding one node requires remapping nearly all keys. With consistent hashing, adding one node moves only `total_keys / (num_nodes + 1)` keys on average, which is the minimum possible.

Virtual nodes (each physical node maps to 150 positions on the ring) ensure even distribution. Without virtual nodes, a small cluster can have uneven key distribution if physical node hashes cluster together. With virtual nodes, the law of large numbers ensures even distribution.

Draw the hash ring in your interview whiteboard: a circle from 0 to 2^32 with nodes placed at hash(node_id) positions. Key lookup is: hash the key, walk clockwise to find the first node. Node removal: keys that were assigned to the removed node are now assigned to the next clockwise node.

### Senior @ FAANG: Consistent Hashing in Production Systems

At senior level, consistent hashing implementation has several production-specific concerns. The hash function choice matters: MD5 is deterministic and well-distributed but slow. xxHash or FNV are faster and sufficient for distribution quality. Murmur3 is the most common choice for production consistent hash implementations.

Key space rebalancing during topology changes must be atomic from the client's perspective. If the client uses an old ring state to route a key that the server has already moved to a new node, the request fails or returns stale data. The coordination mechanism (client observes server topology via a Sentinel or a config service, updates the ring atomically on change) is the hard part of consistent hashing in a distributed system.

Hot spots are the Achilles' heel of consistent hashing. If one key receives 10% of all traffic, the node that owns that key receives 10% of all requests regardless of ring distribution. Mitigation options include: hash key splitting (spread a hot key across multiple shards), read replicas for hot keys, and local application-level caching. Detecting hot spots (via per-key request rate metrics) and routing them appropriately is a production operations concern.

---
