// internal/cluster/hashring.go
package cluster

import (
	"fmt"
	"hash/crc32"
	"slices"
	"sort"
	"sync"
)

const defaultVirtualNodes = 150

type HashRing struct {
	mu           sync.RWMutex
	ring         []uint32
	nodes        map[uint32]string
	virtualNodes int
	sortedHashes []uint32
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

	slices.Sort(h.ring)
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

	slices.Sort(newRing)

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
