## Section 1: Vector Clocks and Causal Ordering

### 1.1 Vector Clock Implementation

Vector clocks assign a logical timestamp per-node to every event, allowing a distributed system to determine causal ordering and detect concurrent writes without relying on synchronized wall clocks. The following Go implementation defines a `VectorClock` type with merge, increment, and happens-before operations, and demonstrates how to attach and propagate clocks through a multi-node request chain.

```go
package vectorclock

import (
	"fmt"
	"sync"
)

// VectorClock tracks causal relationships between events across nodes.
// Entry VC[i] = n means node i has seen n events from itself.
// A happens-before B if A.VC[i] ≤ B.VC[i] for all i, and ∃j: A.VC[j] < B.VC[j].
type VectorClock struct {
	mu      sync.RWMutex
	clocks  map[string]uint64
	nodeID  string
}

// Comparison result between two vector clocks.
type Comparison int

const (
	HappensBefore    Comparison = -1 // This clock happened before other.
	Concurrent       Comparison = 0  // Events are concurrent (no causal relationship).
	HappensAfter     Comparison = 1  // This clock happened after other.
	Identical        Comparison = 2  // Clocks are identical.
)

// New creates a new vector clock for the given node.
func New(nodeID string) *VectorClock {
	return &VectorClock{
		clocks: map[string]uint64{nodeID: 0},
		nodeID: nodeID,
	}
}

// Tick increments this node's logical clock (call before sending a message).
func (vc *VectorClock) Tick() VectorClockSnapshot {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	vc.clocks[vc.nodeID]++
	return vc.snapshot()
}

// Receive updates the clock upon receiving a message with the sender's clock.
// Implements: VC[i] = max(VC[i], received[i]) for all i, then VC[self]++.
func (vc *VectorClock) Receive(received VectorClockSnapshot) VectorClockSnapshot {
	vc.mu.Lock()
	defer vc.mu.Unlock()

	for nodeID, ts := range received.Clocks {
		if vc.clocks[nodeID] < ts {
			vc.clocks[nodeID] = ts
		}
	}
	vc.clocks[vc.nodeID]++
	return vc.snapshot()
}

// Compare compares this clock with another.
func (vc *VectorClock) Compare(other VectorClockSnapshot) Comparison {
	vc.mu.RLock()
	defer vc.mu.RUnlock()

	thisBeforeOther := false
	otherBeforeThis := false

	// Collect all node IDs.
	allNodes := make(map[string]struct{})
	for id := range vc.clocks {
		allNodes[id] = struct{}{}
	}
	for id := range other.Clocks {
		allNodes[id] = struct{}{}
	}

	for id := range allNodes {
		thisTS := vc.clocks[id]
		otherTS := other.Clocks[id]
		if thisTS < otherTS {
			thisBeforeOther = true
		} else if thisTS > otherTS {
			otherBeforeThis = true
		}
	}

	switch {
	case !thisBeforeOther && !otherBeforeThis:
		return Identical
	case thisBeforeOther && !otherBeforeThis:
		return HappensBefore
	case !thisBeforeOther && otherBeforeThis:
		return HappensAfter
	default:
		return Concurrent
	}
}

func (vc *VectorClock) snapshot() VectorClockSnapshot {
	clocks := make(map[string]uint64, len(vc.clocks))
	for k, v := range vc.clocks {
		clocks[k] = v
	}
	return VectorClockSnapshot{NodeID: vc.nodeID, Clocks: clocks}
}

// Snapshot returns an immutable snapshot of the current clock state.
func (vc *VectorClock) Snapshot() VectorClockSnapshot {
	vc.mu.RLock()
	defer vc.mu.RUnlock()
	return vc.snapshot()
}


// VectorClockSnapshot is an immutable copy of a vector clock at a point in time.
type VectorClockSnapshot struct {
	NodeID string
	Clocks map[string]uint64
}

// String returns a human-readable representation.
func (s VectorClockSnapshot) String() string {
	return fmt.Sprintf("VC{%s: %v}", s.NodeID, s.Clocks)
}

// CausalMessage wraps a message with its causal context.
type CausalMessage[T any] struct {
	ID      string
	Payload T
	Clock   VectorClockSnapshot
}

// CausalDelivery ensures messages are delivered in causal order.
// A message M is delivered only when all messages causally before M
// have already been delivered.
type CausalDelivery[T any] struct {
	mu        sync.Mutex
	nodeID    string
	vc        *VectorClock
	pending   []CausalMessage[T]   // Messages waiting for causal dependencies.
	deliver   func(CausalMessage[T]) // Callback for causally-ready messages.
}

func NewCausalDelivery[T any](nodeID string, deliver func(CausalMessage[T])) *CausalDelivery[T] {
	return &CausalDelivery[T]{
		nodeID:  nodeID,
		vc:      New(nodeID),
		deliver: deliver,
	}
}

// Receive handles an incoming message.
// Messages are buffered until their causal dependencies are satisfied.
func (cd *CausalDelivery[T]) Receive(msg CausalMessage[T]) {
	cd.mu.Lock()
	defer cd.mu.Unlock()

	cd.pending = append(cd.pending, msg)
	cd.deliverReady()
}

// deliverReady delivers all messages whose causal dependencies are satisfied.
func (cd *CausalDelivery[T]) deliverReady() {
	delivered := true
	for delivered {
		delivered = false
		remaining := cd.pending[:0]
		for _, msg := range cd.pending {
			if cd.isReady(msg) {
				cd.vc.Receive(msg.Clock)
				cd.deliver(msg)
				delivered = true
			} else {
				remaining = append(remaining, msg)
			}
		}
		cd.pending = remaining
	}
}

// isReady checks if all causal predecessors of msg have been delivered.
// Ready if: for the sender's node j, VC[j] >= msg.Clock[j]-1 (predecessor delivered),
// and for all other nodes k, VC[k] >= msg.Clock[k] (all concurrent events delivered).
func (cd *CausalDelivery[T]) isReady(msg CausalMessage[T]) bool {
	localVC := cd.vc.Snapshot()
	senderID := msg.Clock.NodeID

	for nodeID, ts := range msg.Clock.Clocks {
		localTS := localVC.Clocks[nodeID]
		if nodeID == senderID {
			// Sender's counter: we need all previous messages from sender.
			if localTS < ts-1 {
				return false
			}
		} else {
			// Other nodes: we need all messages these nodes sent before this one.
			if localTS < ts {
				return false
			}
		}
	}
	return true
}
```

### 1.2 Hybrid Logical Clocks (HLC)

Hybrid Logical Clocks combine the monotonicity of physical clocks with the causality tracking of logical clocks, producing timestamps that are both globally ordered and human-readable. The following Go implementation handles clock skew, enforces the invariant that `hlc.now() >= wall_clock`, and shows how to use HLC timestamps as conflict-free row version numbers in a replicated database.

```go
package hlc

import (
	"sync"
	"time"
)

// HybridLogicalClock combines physical time (NTP) with a logical counter.
// Provides: total ordering, causality, and timestamps within a few ms of real time.
// Used by: CockroachDB, YugabyteDB, TiDB.
//
// Format: (walltime, logical)
// - walltime: physical time in nanoseconds (from NTP-synchronized clock)
// - logical: counter to break ties when walltime is equal
type HybridLogicalClock struct {
	mu      sync.Mutex
	wall    int64  // Nanoseconds since epoch.
	logical uint32 // Logical counter.
}

// Timestamp is an HLC timestamp.
type Timestamp struct {
	Wall    int64  // Physical time (nanoseconds).
	Logical uint32 // Logical counter.
}

// Less returns true if t < other (happens-before).
func (t Timestamp) Less(other Timestamp) bool {
	if t.Wall != other.Wall {
		return t.Wall < other.Wall
	}
	return t.Logical < other.Logical
}

// Now returns a Timestamp for the current time (send event).
// Implements: l' = max(l, pt); if l' == l: c' = c+1, else c' = 0
func (h *HybridLogicalClock) Now() Timestamp {
	h.mu.Lock()
	defer h.mu.Unlock()

	physWall := time.Now().UnixNano()
	if physWall > h.wall {
		h.wall = physWall
		h.logical = 0
	} else {
		h.logical++
	}
	return Timestamp{Wall: h.wall, Logical: h.logical}
}

// Receive updates the HLC upon receiving a message with timestamp m.
// Implements the HLC receive algorithm:
// l' = max(l, m.wall, pt); if l' == l: c' = c+1; if l' == m.wall: c' = max(c, m.c)+1
func (h *HybridLogicalClock) Receive(m Timestamp) Timestamp {
	h.mu.Lock()
	defer h.mu.Unlock()

	physWall := time.Now().UnixNano()

	maxWall := h.wall
	if m.Wall > maxWall {
		maxWall = m.Wall
	}
	if physWall > maxWall {
		maxWall = physWall
	}

	if maxWall == h.wall && maxWall == m.Wall {
		// Both clocks have the same wall time - increment max logical.
		if h.logical > m.Logical {
			h.logical++
		} else {
			h.logical = m.Logical + 1
		}
	} else if maxWall == h.wall {
		h.logical++
	} else if maxWall == m.Wall {
		h.logical = m.Logical + 1
	} else {
		h.logical = 0
	}
	h.wall = maxWall

	return Timestamp{Wall: h.wall, Logical: h.logical}
}

// Delta returns the duration since t was issued.
func (t Timestamp) Delta() time.Duration {
	return time.Duration(time.Now().UnixNano() - t.Wall)
}

// HLCStore uses HLC timestamps for optimistic concurrency control.
// Each write includes its HLC timestamp - concurrent writes are detected
// if their timestamps are concurrent (neither happens-before the other).
type HLCStore[K comparable, V any] struct {
	mu  sync.RWMutex
	hlc *HybridLogicalClock
	data map[K]versionedValue[V]
}

type versionedValue[V any] struct {
	Value     V
	Timestamp Timestamp
	NodeID    string
}

func NewHLCStore[K comparable, V any]() *HLCStore[K, V] {
	return &HLCStore[K, V]{
		hlc:  &HybridLogicalClock{},
		data: make(map[K]versionedValue[V]),
	}
}

// Put writes a value with the current HLC timestamp.
// Returns an error if a concurrent write from another node is detected.
func (s *HLCStore[K, V]) Put(key K, value V, nodeID string) (Timestamp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ts := s.hlc.Now()
	s.data[key] = versionedValue[V]{Value: value, Timestamp: ts, NodeID: nodeID}
	return ts, nil
}

// Get retrieves a value and its timestamp.
func (s *HLCStore[K, V]) Get(key K) (V, Timestamp, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	v, ok := s.data[key]
	if !ok {
		var zero V
		return zero, Timestamp{}, false
	}
	return v.Value, v.Timestamp, true
}
```

### Junior → FAANG: Understanding Vector Clocks and HLCs Through Concrete Failures

Vector clocks are best understood through the failure they prevent rather than their mathematical definition. Without causal ordering, a distributed chat application can display a reply before the message it is replying to, because the reply arrived at the display node faster than the original message. Vector clocks let the display node buffer the reply until the causally prior message is delivered.

The `CausalDelivery` implementation in this section shows the buffering approach concretely. The key is the `isReady` check: for the sender's own counter, we need to have seen `ts - 1` (all prior messages from this sender), and for other nodes, we need to have seen `ts` (all messages those nodes sent before this one). Getting this check wrong is the most common implementation bug. Off-by-one errors here produce reordering that only appears under concurrent message arrival.

For your first job: when you see a system where event ordering matters (feed ranking, audit logs, conflict resolution), ask whether the system uses logical clocks or wall clocks. Wall-clock ordering fails silently under NTP drift (which can be hundreds of milliseconds on busy cloud VMs), and the resulting ordering bugs are very hard to reproduce. Logical clocks are immune to clock drift.

HLCs are the practical compromise: they stay close to wall time (making logs human-readable and indexable by time) while preserving causal ordering. When you see CockroachDB or YugabyteDB in a system design interview, the correct answer for "how does their distributed transaction ordering work" involves HLCs, not TrueTime (that is Spanner's answer).

Practice exercise: draw a three-node message exchange where node A sends a message to B, B processes it and sends a response to C, and C concurrently receives a message from A. Work out the HLC timestamp for each event step by step.

### Senior @ FAANG: Vector Clocks as a Platform Primitive for Causal Consistency

At the platform level, vector clocks and HLCs are infrastructure components, not application-level choices. The decision to embed causal metadata in all cross-service messages (in gRPC headers, in Kafka message metadata, in HTTP request headers) is an architectural commitment that affects every service in the fleet and must be made by a principal engineer or architect, not by individual feature teams.

The operational cost of causal metadata is not zero. A vector clock with N nodes has O(N) size. At 100 services, a vector clock embedded in every inter-service call adds meaningful per-request overhead. The mitigation is one of two approaches: sparse vector clocks (only track nodes in the causal dependency graph of each request), or switching to HLCs (which have constant size: one int64 wall time and one int32 logical counter, regardless of fleet size). The CockroachDB and YugabyteDB choice of HLCs over vector clocks was driven by exactly this tradeoff.

For a platform architect, the key question is: what is the causal consistency scope? Causal consistency within a single service is relatively cheap. Causal consistency across service boundaries requires all services to participate in timestamp propagation, which means a platform-wide library and a governance process to ensure adoption. Causal consistency across data centers adds clock skew uncertainty (bounded by NTP accuracy or hardware atomic clocks for Spanner).

ADR content for a causal metadata system: the payload format (HLC fields, encoding), the propagation contract (which headers are mandatory), the maximum clock skew tolerance (typically 250ms for NTP-synced systems), the action on skew violation (reject the request, log and continue, or accept with degraded guarantees), and the observability story (how you detect when the causal metadata is being dropped by a service that does not implement the library).

Bar-raiser signal at L6: the candidate has thought about causal consistency at the fleet level, not just the single-node level. They can articulate which operations in their design need causal ordering and which do not, and they have a plan for propagating causal context through async message queues (where the synchronous request-response HLC update does not apply).

---
