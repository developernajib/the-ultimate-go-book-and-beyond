## Section 3: CRDTs (Conflict-Free Replicated Data Types)

### 3.1 G-Counter (Grow-Only Counter)

A G-Counter is the simplest CRDT: each node maintains its own counter shard, increments only its own shard, and merges by taking the element-wise maximum of all shards to produce the global count. The following Go implementation demonstrates the data structure, the merge operation, and how replica divergence resolves automatically without coordination.

```go
package crdt

import (
	"sync"
)

// GCounter is a grow-only distributed counter.
// Each node maintains its own increment counter.
// Total = sum of all node counters.
// Merge = take max of each node's counter.
// Guarantee: all replicas converge to the same value.
type GCounter struct {
	mu      sync.RWMutex
	nodeID  string
	counts  map[string]uint64
}

func NewGCounter(nodeID string) *GCounter {
	return &GCounter{
		nodeID: nodeID,
		counts: map[string]uint64{nodeID: 0},
	}
}

// Increment adds n to this node's counter.
func (c *GCounter) Increment(n uint64) {
	c.mu.Lock()
	c.counts[c.nodeID] += n
	c.mu.Unlock()
}

// Value returns the current total count (sum of all node counters).
func (c *GCounter) Value() uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var total uint64
	for _, v := range c.counts {
		total += v
	}
	return total
}

// Merge merges another counter's state into this one.
// Implements: for each node, take the maximum of both counters.
func (c *GCounter) Merge(other GCounterState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for nodeID, count := range other.Counts {
		if c.counts[nodeID] < count {
			c.counts[nodeID] = count
		}
	}
}

// State returns a snapshot for replication.
func (c *GCounter) State() GCounterState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	counts := make(map[string]uint64, len(c.counts))
	for k, v := range c.counts {
		counts[k] = v
	}
	return GCounterState{Counts: counts}
}

// GCounterState is the serializable state of a GCounter.
type GCounterState struct {
	Counts map[string]uint64
}

// PNCounter is a positive-negative counter that supports increment and decrement.
// Internally: two GCounters (P for increments, N for decrements).
// Value = P.Value() - N.Value()
type PNCounter struct {
	nodeID string
	p      *GCounter
	n      *GCounter
}

func NewPNCounter(nodeID string) *PNCounter {
	return &PNCounter{
		nodeID: nodeID,
		p:      NewGCounter(nodeID),
		n:      NewGCounter(nodeID),
	}
}

func (c *PNCounter) Increment(n uint64) { c.p.Increment(n) }
func (c *PNCounter) Decrement(n uint64) { c.n.Increment(n) }

func (c *PNCounter) Value() int64 {
	return int64(c.p.Value()) - int64(c.n.Value())
}

func (c *PNCounter) Merge(other PNCounterState) {
	c.p.Merge(other.P)
	c.n.Merge(other.N)
}

// PNCounterState is the serializable state of a PNCounter.
type PNCounterState struct {
	P GCounterState
	N GCounterState
}

func (c *PNCounter) State() PNCounterState {
	return PNCounterState{P: c.p.State(), N: c.n.State()}
}
```

### 3.2 OR-Set (Observed-Remove Set)

The OR-Set CRDT allows elements to be added and removed concurrently across replicas, resolving add/remove conflicts by associating each add operation with a unique tag. The following Go implementation defines the OR-Set structure with add, remove, and merge operations, and shows the canonical concurrent-add-and-remove scenario that simpler set CRDTs handle incorrectly.

```go
package crdt

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

type Timestamp struct {
	Physical int64
	Logical  int
}

func (t Timestamp) Less(other Timestamp) bool {
	if t.Physical != other.Physical {
		return t.Physical < other.Physical
	}
	return t.Logical < other.Logical
}

// ORSet (Observed-Remove Set) is a CRDT set that supports add and remove.
// Unlike simple sets, ORSet correctly handles concurrent add/remove.
// If Node A removes an element and Node B adds it concurrently, after merge: element is present.
// Implemented via unique tags: each Add creates a unique tag - Remove removes specific tags.
type ORSet[T comparable] struct {
	mu      sync.RWMutex
	nodeID  string
	entries map[T]map[string]struct{} // element → set of unique tags
	removed map[T]map[string]struct{} // element → set of removed tags
}

func NewORSet[T comparable](nodeID string) *ORSet[T] {
	return &ORSet[T]{
		nodeID:  nodeID,
		entries: make(map[T]map[string]struct{}),
		removed: make(map[T]map[string]struct{}),
	}
}

// Add adds an element to the set with a unique tag.
func (s *ORSet[T]) Add(element T) string {
	tag := generateTag()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.entries[element] == nil {
		s.entries[element] = make(map[string]struct{})
	}
	s.entries[element][tag] = struct{}{}
	return tag
}

// Remove removes all current tags for element.
// Future concurrent adds (with new tags) will not be removed.
func (s *ORSet[T]) Remove(element T) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if tags, ok := s.entries[element]; ok {
		if s.removed[element] == nil {
			s.removed[element] = make(map[string]struct{})
		}
		for tag := range tags {
			s.removed[element][tag] = struct{}{}
		}
		delete(s.entries, element)
	}
}

// Contains returns true if the element is in the set.
func (s *ORSet[T]) Contains(element T) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tags, ok := s.entries[element]
	return ok && len(tags) > 0
}

// Members returns all current set members.
func (s *ORSet[T]) Members() []T {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var members []T
	for elem, tags := range s.entries {
		if len(tags) > 0 {
			members = append(members, elem)
		}
	}
	return members
}

// Merge merges another ORSet's state into this one.
func (s *ORSet[T]) Merge(other ORSetState[T]) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Add all entries from other that haven't been removed.
	for elem, tags := range other.Entries {
		for tag := range tags {
			// Only add if not in our removed set.
			removedTags := s.removed[elem]
			if _, removed := removedTags[tag]; !removed {
				if s.entries[elem] == nil {
					s.entries[elem] = make(map[string]struct{})
				}
				s.entries[elem][tag] = struct{}{}
			}
		}
	}

	// Apply removes: remove tags from our entries that other has removed.
	for elem, removedTags := range other.Removed {
		if s.removed[elem] == nil {
			s.removed[elem] = make(map[string]struct{})
		}
		for tag := range removedTags {
			s.removed[elem][tag] = struct{}{}
			// Remove from entries.
			if s.entries[elem] != nil {
				delete(s.entries[elem], tag)
			}
		}
	}
}

// State returns a snapshot for replication.
func (s *ORSet[T]) State() ORSetState[T] {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries := make(map[T]map[string]struct{})
	for k, v := range s.entries {
		tags := make(map[string]struct{})
		for tag := range v {
			tags[tag] = struct{}{}
		}
		entries[k] = tags
	}
	removed := make(map[T]map[string]struct{})
	for k, v := range s.removed {
		tags := make(map[string]struct{})
		for tag := range v {
			tags[tag] = struct{}{}
		}
		removed[k] = tags
	}
	return ORSetState[T]{Entries: entries, Removed: removed}
}

// ORSetState is the serializable state of an ORSet.
type ORSetState[T comparable] struct {
	Entries map[T]map[string]struct{}
	Removed map[T]map[string]struct{}
}

func generateTag() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}


// LWW-Register (Last-Write-Wins Register): simplest CRDT.
// Conflicts resolved by timestamp - last writer wins.
type LWWRegister[T any] struct {
	mu        sync.RWMutex
	value     T
	timestamp Timestamp // HLC timestamp
	nodeID    string
}

func NewLWWRegister[T any](nodeID string) *LWWRegister[T] {
	return &LWWRegister[T]{nodeID: nodeID}
}

// Set updates the register if the new timestamp is greater.
func (r *LWWRegister[T]) Set(value T, ts Timestamp) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ts.Less(r.timestamp) {
		return false // Older write - ignore.
	}
	r.value = value
	r.timestamp = ts
	return true
}

// Get returns the current value and its timestamp.
func (r *LWWRegister[T]) Get() (T, Timestamp) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.value, r.timestamp
}

// Merge reconciles two LWW register states.
func (r *LWWRegister[T]) Merge(other LWWRegisterState[T]) {
	r.Set(other.Value, other.Timestamp)
}

// LWWRegisterState is the serializable state of an LWW register.
type LWWRegisterState[T any] struct {
	Value     T
	Timestamp Timestamp
	NodeID    string
}
```

### Junior → FAANG: Learning CRDTs by Starting with the Simplest Type

The G-Counter is the ideal entry point for CRDT intuition. Every node owns a shard of the counter (its own entry in the `counts` map) and only ever increments its own shard. No coordination is needed because there is no conflict: if Node A increments its shard and Node B increments its shard, both can merge by taking the element-wise maximum without any ambiguity about which is "correct." The total count is always the sum of all shards, which is monotonically increasing.

The key insight to carry into interviews: CRDTs achieve conflict freedom by design, not by coordination. The merge function is the mathematical guarantee. For the G-Counter, merge is `max(a, b)` per shard, which is commutative (`max(a,b) = max(b,a)`), associative (`max(max(a,b),c) = max(a,max(b,c))`), and idempotent (`max(a,a) = a`). Any function with all three properties can be used as a CRDT merge, and anything you want to represent as a CRDT must have a state space where such a function exists.

The OR-Set concurrent add/remove scenario is the classic CRDT interview question. The interviewer describes: User A removes item X from their shopping cart. User B (on a different replica) adds item X to their cart. After merge, should X be in the cart? The OR-Set says yes (add wins). That is a product decision baked into the data structure choice. If you need remove-wins, you need a different CRDT.

Common mistake: thinking CRDTs eliminate all coordination. They eliminate coordination for the operations the CRDT models. If you need to enforce a constraint that requires coordination (like "no more than 100 items in the cart" globally), a CRDT cannot help you.

### Senior @ FAANG: CRDT Adoption Decisions and Operational Complexity at Scale

The real-world deployment question for CRDTs is not "can we model our data with a CRDT" but "what are the operational costs of running CRDTs at our scale, and does the benefit of coordination-free operation justify those costs?"

Tombstone accumulation is the most serious operational concern for OR-Sets deployed in long-running systems. Every `Remove` operation adds entries to the `removed` set. Entries in the `removed` set can never be deleted while any replica might still be receiving messages that reference the removed tags. In a collaborative document edited for years, the tombstone set can grow to be many times the size of the live document. Production systems using CRDTs for collaborative editing (Figma, Notion) have all had to build garbage collection mechanisms that require a form of coordination, typically requiring all replicas to be online simultaneously to agree that a tombstone is globally safe to remove. The irony is that the GC protocol for a "coordination-free" CRDT requires coordination.

Delta-CRDTs are a more recent development that addresses the replication bandwidth problem. Instead of sending the full state on every sync (state-based CRDTs), delta-CRDTs send only the changes since the last sync point. This is particularly important for large OR-Sets or RGAs (Replicated Growable Arrays, the CRDT underlying collaborative text editing in Yjs and Automerge) where full state transfer per sync is prohibitive.

For a platform architect, the decision to adopt CRDTs is a database topology decision. CRDTs are most valuable in the multi-master, active-active replication topology where writes can go to any region and conflict resolution must be automatic. If your system uses a primary-replica topology with failover (one writable region at a time), CRDTs provide less benefit and add significant complexity. The correct question to ask before adopting CRDTs is: "Can we solve this problem with a simpler approach, such as assigning ownership of data to a single primary region and routing writes there?"

The LWW-Register is the CRDT that causes the most production incidents when used naively. Its correctness depends on clock ordering: the write with the higher timestamp wins. If two nodes have clock skew exceeding the typical write interval, LWW can silently discard writes. For any CRDT that uses physical timestamps in its merge function, you must have a policy for maximum allowed clock skew and a mechanism to enforce it (NTP with monitoring, or HLC timestamps as used in this section).

---
