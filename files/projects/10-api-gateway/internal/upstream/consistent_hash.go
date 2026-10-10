// internal/upstream/consistent_hash.go
package upstream

import (
	"hash/crc32"
	"slices"
	"sort"
	"sync"
)

// ConsistentHashRing implements consistent hashing
type ConsistentHashRing struct {
	mu       sync.RWMutex
	replicas int
	keys     []uint32
	ring     map[uint32]any
}

// NewConsistentHashRing creates a new consistent hash ring
func NewConsistentHashRing(replicas int) *ConsistentHashRing {
	return &ConsistentHashRing{
		replicas: replicas,
		ring:     make(map[uint32]any),
	}
}

// Add adds a node to the ring
func (h *ConsistentHashRing) Add(key string, value any) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for i := 0; i < h.replicas; i++ {
		virtualKey := hash(key + string(rune(i)))
		h.keys = append(h.keys, virtualKey)
		h.ring[virtualKey] = value
	}

	slices.Sort(h.keys)
}

// Remove removes a node from the ring
func (h *ConsistentHashRing) Remove(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for i := 0; i < h.replicas; i++ {
		virtualKey := hash(key + string(rune(i)))
		idx := sort.Search(len(h.keys), func(i int) bool {
			return h.keys[i] >= virtualKey
		})

		if idx < len(h.keys) && h.keys[idx] == virtualKey {
			h.keys = append(h.keys[:idx], h.keys[idx+1:]...)
		}

		delete(h.ring, virtualKey)
	}
}

// Get returns the node for the given key
func (h *ConsistentHashRing) Get(key string) (any, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(h.keys) == 0 {
		return nil, false
	}

	hashKey := hash(key)
	idx := sort.Search(len(h.keys), func(i int) bool {
		return h.keys[i] >= hashKey
	})

	if idx == len(h.keys) {
		idx = 0
	}

	return h.ring[h.keys[idx]], true
}

// Clear removes all nodes from the ring
func (h *ConsistentHashRing) Clear() {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.keys = nil
	h.ring = make(map[uint32]any)
}

func hash(key string) uint32 {
	return crc32.ChecksumIEEE([]byte(key))
}
