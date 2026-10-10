## 5. Vector Clocks for Conflict Detection

Before we can resolve conflicts we need to detect them. Vector clocks provide a causality-tracking mechanism that is both correct and efficient. A vector clock is essentially a map from node ID to a logical counter. Each node increments its own counter on every local event, and when nodes communicate they merge their clocks by taking the element-wise maximum. This lets you answer a question that regular timestamps cannot: did event A cause event B, or did they happen independently? If two events have concurrent vector clocks (neither dominates the other), you know you have a genuine conflict that requires resolution. If one clock dominates the other, the dominated event happened first and no conflict exists.

```go
// crdt/vectorclock.go
package crdt

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// VectorClock tracks causal ordering across nodes.
type VectorClock struct {
	mu      sync.RWMutex
	clocks  map[string]uint64 // nodeID → logical timestamp
}

// NewVectorClock returns an empty vector clock.
func NewVectorClock() *VectorClock {
	return &VectorClock{clocks: make(map[string]uint64)}
}

// Increment advances the clock for a local node.
func (vc *VectorClock) Increment(nodeID string) {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.clocks[nodeID]++
}

// Merge updates local clock to the element-wise maximum of local and remote.
func (vc *VectorClock) Merge(remote *VectorClock) {
	remote.mu.RLock()
	defer remote.mu.RUnlock()
	vc.mu.Lock()
	defer vc.mu.Unlock()

	for node, ts := range remote.clocks {
		if ts > vc.clocks[node] {
			vc.clocks[node] = ts
		}
	}
}

// Relation describes how two vector clocks relate causally.
type Relation int

const (
	RelationBefore     Relation = iota // vc happened-before other
	RelationAfter                       // vc happened-after other
	RelationConcurrent                  // neither dominates → potential conflict
	RelationEqual                       // identical
)

func (r Relation) String() string {
	switch r {
	case RelationBefore:
		return "before"
	case RelationAfter:
		return "after"
	case RelationConcurrent:
		return "concurrent"
	case RelationEqual:
		return "equal"
	default:
		return "unknown"
	}
}

// Compare returns the causal relation of vc to other.
func (vc *VectorClock) Compare(other *VectorClock) Relation {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	other.mu.RLock()
	defer other.mu.RUnlock()

	lessInSome := false  // vc ≤ other in at least one dimension
	greaterInSome := false // vc ≥ other in at least one dimension

	// Collect all node IDs.
	nodes := make(map[string]struct{})
	for n := range vc.clocks {
		nodes[n] = struct{}{}
	}
	for n := range other.clocks {
		nodes[n] = struct{}{}
	}

	for n := range nodes {
		vcTs := vc.clocks[n]
		otherTs := other.clocks[n]
		if vcTs < otherTs {
			lessInSome = true
		} else if vcTs > otherTs {
			greaterInSome = true
		}
	}

	switch {
	case !lessInSome && !greaterInSome:
		return RelationEqual
	case lessInSome && !greaterInSome:
		return RelationBefore
	case greaterInSome && !lessInSome:
		return RelationAfter
	default:
		return RelationConcurrent
	}
}

// Clone returns a deep copy.
func (vc *VectorClock) Clone() *VectorClock {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	c := NewVectorClock()
	for k, v := range vc.clocks {
		c.clocks[k] = v
	}
	return c
}

// MarshalJSON serializes the clock.
func (vc *VectorClock) MarshalJSON() ([]byte, error) {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	return json.Marshal(vc.clocks)
}

// UnmarshalJSON deserializes the clock.
func (vc *VectorClock) UnmarshalJSON(data []byte) error {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	return json.Unmarshal(data, &vc.clocks)
}

func (vc *VectorClock) String() string {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	parts := make([]string, 0, len(vc.clocks))
	for k, v := range vc.clocks {
		parts = append(parts, fmt.Sprintf("%s:%d", k, v))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
```

---

### Junior -> FAANG: Building Intuition for Vector Clocks

The hardest part of vector clocks for new engineers is the `RelationConcurrent` case. When two vector clocks are concurrent, it means neither event caused the other: they happened independently on different nodes with no communication between them. This is the precise definition of a write conflict in a distributed system. Without vector clocks, you cannot distinguish "B happened after A" from "B happened at the same time as A (concurrently)." Lamport timestamps give total ordering but collapse this distinction.

A concrete worked example: Alice in region us-east-1 updates her profile picture. At the same time, Bob in eu-west-1 updates his profile picture. Both updates are written locally before any cross-region replication happens. When replication runs, both updates arrive at the remote regions with concurrent vector clocks. There is no conflict here because they are updating different users. But if Alice and her partner share an account and both update the profile picture at the same time from different regions, you have a genuine conflict with concurrent clocks, and you need a resolution strategy.

The interview signal: explain that vector clocks tell you *whether* you have a conflict but not *how* to resolve it. Conflict resolution is application-layer logic. Vector clocks are the detection mechanism.

### Senior @ FAANG: Vector Clock Operational Concerns at Scale

**Storage cost of vector clocks grows with node count.** A vector clock stores one counter per node. With 10 nodes (regions or replicas) this is small. With 1000 microservice instances this becomes impractical as a per-record annotation. At FAANG scale, alternatives are used: dotted version vectors (compress the clock for single-writer scenarios), interval tree clocks (support node addition and removal without clock size growth), or hybrid approaches that use vector clocks only for hot-contention entities and fall back to LWW elsewhere.

**Clock garbage collection.** The `VectorClock.clocks` map grows monotonically as nodes appear. Nodes that are decommissioned leave phantom entries in every clock they touched. A production implementation ages out node entries that have not been updated in a configurable window, and coordinates this GC across nodes to prevent premature deletion of an active node's entry.

**Serialization format stability.** The `MarshalJSON` and `UnmarshalJSON` methods use `map[string]uint64`. If you ever need to rename a node ID (region rename, instance replacement), any clock persisted with the old ID is now incompatible with the new node's ID, causing spurious concurrent relations. At platform level, node IDs should be stable identifiers (UUIDs) rather than human-readable names that may change.

**The `Compare` method and lock ordering.** The `Compare` method acquires `vc.mu.RLock()` then `other.mu.RLock()`. If two goroutines call `a.Compare(b)` and `b.Compare(a)` simultaneously, there is no deadlock because both take read locks, and read locks do not block each other. However, if `Merge` is called concurrently (which takes a write lock), the acquire order `vc.mu.Lock()` then reading from `remote.mu.RLock()` must be consistent with `Compare`. Review all methods for consistent lock acquire order before shipping to production.

**Hybrid Logical Clocks as the production upgrade path.** The `VectorClock` above uses logical counters detached from wall time. In practice, operations need both causal ordering and approximate wall-clock timestamps for TTL expiry, user-visible timestamps, and debug logging. Hybrid Logical Clocks (HLC) encode both into a single `(physical_ms, logical)` tuple. A staff-level decision is whether to start with pure vector clocks (simpler, correct) or HLC (slightly more complex, but avoids retrofitting timestamps later). For new systems, HLC is the right default in 2025 and beyond.
