## 102P.4 CRDT - Conflict-Free Replicated Data Types

CRDTs enable real-time collaboration without conflict resolution. Unlike Operational Transform, which requires a central server to serialize and transform concurrent edits, CRDTs define merge functions that are commutative, associative, and idempotent, so any node can apply remote updates in any order and converge to the same state. The implementations below cover a grow-only counter (GCounter), a two-phase set (2PSet) that supports both adds and removes, and a Last-Write-Wins register (LWWRegister) for single-value fields, all of which compose into higher-level collaborative data structures.

```go
package crdt

import (
	"fmt"
    "slices"
	"sync"
)

// GCounter is a grow-only counter CRDT
type GCounter struct {
	mu     sync.RWMutex
	counts map[string]int64 // nodeID → count
	nodeID string
}

func NewGCounter(nodeID string) *GCounter {
	return &GCounter{
		counts: map[string]int64{nodeID: 0},
		nodeID: nodeID,
	}
}

func (c *GCounter) Increment() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts[c.nodeID]++
}

func (c *GCounter) Value() int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	total := int64(0)
	for _, v := range c.counts {
		total += v
	}
	return total
}

// Merge merges another GCounter into this one (takes max per node)
func (c *GCounter) Merge(other *GCounter) {
	c.mu.Lock()
	defer c.mu.Unlock()
	other.mu.RLock()
	defer other.mu.RUnlock()

	for nodeID, count := range other.counts {
		if count > c.counts[nodeID] {
			c.counts[nodeID] = count
		}
	}
}

// PNCounter is a positive-negative counter (can increment and decrement)
type PNCounter struct {
	positive *GCounter
	negative *GCounter
}

func NewPNCounter(nodeID string) *PNCounter {
	return &PNCounter{
		positive: NewGCounter(nodeID),
		negative: NewGCounter(nodeID),
	}
}

func (c *PNCounter) Increment() { c.positive.Increment() }
func (c *PNCounter) Decrement() { c.negative.Increment() }
func (c *PNCounter) Value() int64 { return c.positive.Value() - c.negative.Value() }

func (c *PNCounter) Merge(other *PNCounter) {
	c.positive.Merge(other.positive)
	c.negative.Merge(other.negative)
}

// LWWRegister is a Last-Write-Wins register CRDT
type LWWRegister struct {
	mu        sync.RWMutex
	value     any
	timestamp int64 // logical/wall clock
	nodeID    string
}

func (r *LWWRegister) Set(value any, timestamp int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if timestamp > r.timestamp ||
		(timestamp == r.timestamp && r.nodeID > r.nodeID) { // tie-break by nodeID
		r.value = value
		r.timestamp = timestamp
	}
}

func (r *LWWRegister) Get() any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.value
}

func (r *LWWRegister) Merge(other *LWWRegister) {
	other.mu.RLock()
	defer other.mu.RUnlock()
	r.Set(other.value, other.timestamp)
}

// ORSet is an Observed-Remove Set CRDT
// Supports add and remove operations without conflicts
type ORSet struct {
	mu      sync.RWMutex
	nodeID  string
	items   map[string]map[string]bool // value → {tag → true}
	removed map[string]map[string]bool // value → {tag → true} (tombstones)
	counter int64
}

func NewORSet(nodeID string) *ORSet {
	return &ORSet{
		nodeID:  nodeID,
		items:   make(map[string]map[string]bool),
		removed: make(map[string]map[string]bool),
	}
}

// Add adds an element with a unique tag
func (s *ORSet) Add(value string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.counter++
	tag := fmt.Sprintf("%s-%d", s.nodeID, s.counter)

	if s.items[value] == nil {
		s.items[value] = make(map[string]bool)
	}
	s.items[value][tag] = true
}

// Remove removes all tags for an element
func (s *ORSet) Remove(value string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if tags, ok := s.items[value]; ok {
		if s.removed[value] == nil {
			s.removed[value] = make(map[string]bool)
		}
		for tag := range tags {
			s.removed[value][tag] = true
		}
		delete(s.items, value)
	}
}

// Contains returns true if the value is in the set
func (s *ORSet) Contains(value string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tags := s.items[value]
	return len(tags) > 0
}

// Elements returns all elements in the set
func (s *ORSet) Elements() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []string
	for value, tags := range s.items {
		if len(tags) > 0 {
			result = append(result, value)
		}
	}
	slices.Sort(result)
	return result
}

// Merge combines two ORSets
func (s *ORSet) Merge(other *ORSet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	other.mu.RLock()
	defer other.mu.RUnlock()

	// Merge items
	for value, tags := range other.items {
		if s.items[value] == nil {
			s.items[value] = make(map[string]bool)
		}
		for tag := range tags {
			// Don't add if it's been removed
			if s.removed[value] == nil || !s.removed[value][tag] {
				if other.removed[value] == nil || !other.removed[value][tag] {
					s.items[value][tag] = true
				}
			}
		}
	}

	// Merge removals
	for value, tags := range other.removed {
		if s.removed[value] == nil {
			s.removed[value] = make(map[string]bool)
		}
		for tag := range tags {
			s.removed[value][tag] = true
			// Remove from items if present
			if s.items[value] != nil {
				delete(s.items[value], tag)
				if len(s.items[value]) == 0 {
					delete(s.items, value)
				}
			}
		}
	}
}
```

### Junior → FAANG: CRDTs in Plain Language

A CRDT is a data structure with a merge function that is safe to call from any node, in any order, any number of times, and always produces the same result. This is what "commutative, associative, and idempotent" means in practice. Commutative: merge(A, B) equals merge(B, A). Associative: merge(A, merge(B, C)) equals merge(merge(A, B), C). Idempotent: merge(A, A) equals A.

The practical test for whether something is a CRDT: can two disconnected nodes both modify the data independently, then reconnect and merge without any special conflict resolution logic? If yes, it is a CRDT. If merging requires knowing the order of operations or asking a human to resolve a conflict, it is not.

The three examples in this section cover the most common use cases: G-Counter (increment-only count, like upvote count), 2PSet (add and remove items, like a shopping cart), and LWW-Register (a single value where the most recent write wins, like a user's display name).

### Senior @ FAANG: CRDT Selection and the Memory Growth Problem

CRDT selection is a correctness and performance decision. The correctness dimension: choose the CRDT that matches the data type's semantic requirements. A shopping cart requires a set CRDT that supports removal. A document character sequence requires an RGA or YATA CRDT that preserves intention under concurrent insertions. Using the wrong CRDT (LWW for text editing) produces incorrect behavior under concurrent modification.

The performance dimension: some CRDTs have unbounded state growth. The 2PSet's remove set grows indefinitely because removed elements are tracked forever (they cannot be truly deleted, because a re-add on a disconnected node would not know the element was removed). The OR-Set (Observed-Remove Set) has the same property. For long-lived collaborative documents, unbounded state growth leads to out-of-memory failures or unacceptably large synchronization payloads.

The solution is CRDT garbage collection: periodically computing a stable state that all nodes have acknowledged, and discarding tombstones (removed elements) from the state. Garbage collection requires a coordination protocol (all nodes must acknowledge the compaction point) that adds complexity to an otherwise coordination-free system. The design of the GC protocol is a staff-level architecture problem that must be solved before CRDTs are deployed in a product with long-lived sessions.

---
