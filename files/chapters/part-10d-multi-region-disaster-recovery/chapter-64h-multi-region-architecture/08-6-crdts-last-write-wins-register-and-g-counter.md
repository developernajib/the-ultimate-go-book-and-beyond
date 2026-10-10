## 6. CRDTs - Last-Write-Wins Register and G-Counter

CRDTs (Conflict-free Replicated Data Types) are the backbone of eventually consistent multi-region state. The key property of a CRDT is that replicas can be updated independently and concurrently, and they are mathematically guaranteed to converge to the same value once all updates have been exchanged, without requiring any coordination or conflict resolution logic. The `LWWRegister` below stores a single value and always keeps the one with the latest timestamp, using node ID as a deterministic tie-breaker when timestamps are equal. The `GCounter` takes a different approach: each node maintains its own private counter slot, and the total value is the sum of all slots. Merging two G-Counters simply takes the maximum of each slot, which is always safe regardless of the order or number of merges.

```go
// crdt/lww.go
package crdt

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// LWWRegister is a Last-Write-Wins Register.
// Writes with a later wall-clock timestamp always win.
// For production, use Hybrid Logical Clocks (HLC) to avoid clock skew issues.
type LWWRegister[T any] struct {
	mu        sync.RWMutex
	value     T
	timestamp time.Time
	nodeID    string // originating node for tie-breaking
}

// NewLWWRegister creates an empty register owned by nodeID.
func NewLWWRegister[T any](nodeID string) *LWWRegister[T] {
	return &LWWRegister[T]{nodeID: nodeID}
}

// Set updates the register if ts is strictly later than the current timestamp.
func (r *LWWRegister[T]) Set(value T, ts time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ts.After(r.timestamp) {
		r.value = value
		r.timestamp = ts
		return true
	}
	return false
}

// Get returns the current value and timestamp.
func (r *LWWRegister[T]) Get() (T, time.Time) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.value, r.timestamp
}

// Merge applies the remote register state using LWW semantics.
func (r *LWWRegister[T]) Merge(remote *LWWRegister[T]) {
	remote.mu.RLock()
	rv, rts := remote.value, remote.timestamp
	rn := remote.nodeID
	remote.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	if rts.After(r.timestamp) ||
		(rts.Equal(r.timestamp) && rn > r.nodeID) { // tie-break by nodeID lexicographic order
		r.value = rv
		r.timestamp = rts
		r.nodeID = rn
	}
}

// MarshalJSON implements json.Marshaler.
func (r *LWWRegister[T]) MarshalJSON() ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return json.Marshal(struct {
		Value     T         `json:"value"`
		Timestamp time.Time `json:"timestamp"`
		NodeID    string    `json:"node_id"`
	}{r.value, r.timestamp, r.nodeID})
}

// GCounter is a grow-only counter CRDT - each node maintains its own slot.
// The value is the sum of all slots. Never decrement.
type GCounter struct {
	mu     sync.RWMutex
	counts map[string]uint64 // nodeID → count
	nodeID string
}

func NewGCounter(nodeID string) *GCounter {
	return &GCounter{
		counts: map[string]uint64{nodeID: 0},
		nodeID: nodeID,
	}
}

// Increment adds delta to this node's slot.
func (g *GCounter) Increment(delta uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.counts[g.nodeID] += delta
}

// Value returns the total count across all nodes.
func (g *GCounter) Value() uint64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var total uint64
	for _, v := range g.counts {
		total += v
	}
	return total
}

// Merge performs element-wise maximum merge.
func (g *GCounter) Merge(remote *GCounter) {
	remote.mu.RLock()
	defer remote.mu.RUnlock()
	g.mu.Lock()
	defer g.mu.Unlock()
	for node, count := range remote.counts {
		if count > g.counts[node] {
			g.counts[node] = count
		}
	}
}

// MarshalJSON serializes the counter.
func (g *GCounter) MarshalJSON() ([]byte, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return json.Marshal(g.counts)
}

// UnmarshalJSON deserializes into the counter.
func (g *GCounter) UnmarshalJSON(data []byte) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return json.Unmarshal(data, &g.counts)
}

// PNCounter is a positive-negative counter built from two GCounters.
// It supports both increments and decrements.
type PNCounter struct {
	pos *GCounter
	neg *GCounter
}

func NewPNCounter(nodeID string) *PNCounter {
	return &PNCounter{
		pos: NewGCounter(nodeID),
		neg: NewGCounter(nodeID),
	}
}

func (p *PNCounter) Increment(delta uint64) { p.pos.Increment(delta) }
func (p *PNCounter) Decrement(delta uint64) { p.neg.Increment(delta) }
func (p *PNCounter) Value() int64           { return int64(p.pos.Value()) - int64(p.neg.Value()) }

func (p *PNCounter) Merge(remote *PNCounter) {
	p.pos.Merge(remote.pos)
	p.neg.Merge(remote.neg)
}

func (p *PNCounter) String() string {
	return fmt.Sprintf("PNCounter(+%d,-%d)=%d", p.pos.Value(), p.neg.Value(), p.Value())
}
```

---

### Junior -> FAANG: Choosing the Right CRDT for the Job

The hardest CRDT question in interviews is "when would you NOT use a CRDT?" The answer is: when your data has business-layer constraints that CRDTs cannot express. A G-Counter can count up but can never go below zero locally, so it cannot express a stock inventory that must never be oversold. An LWW Register cannot express a merge where both old and new values need to be preserved (append-only log entries). Knowing the limits of CRDTs is as important as knowing when they apply.

The commutativity and idempotency properties are the two key claims to verify when implementing a CRDT. Commutativity: `A.Merge(B)` must equal `B.Merge(A)`. Idempotency: `A.Merge(B).Merge(B)` must equal `A.Merge(B)`. Test both properties explicitly in your unit tests. The `TestGCounterMerge` test in the testing section verifies idempotency directly. Make sure you understand why that property matters (it means duplicate replication messages are safe).

Practice: implement an `ORSet` (Observed-Remove Set) which is a CRDT that supports both add and remove. This is harder than GSet and tests your understanding of the tagged-element model. It appears occasionally in FAANG interviews as a "design a CRDT for a shopping cart" problem.

### Senior @ FAANG: CRDT Selection, Clock Semantics, and Production Trade-offs

**LWW Register and the clock skew problem in production.** The `LWWRegister` uses `time.Time` for timestamps, which is wall-clock time from the operating system. NTP synchronization between machines typically achieves accuracy within a few milliseconds, but can drift to hundreds of milliseconds under load or network issues. When two writes happen within a clock-skew window (say, 100ms apart), the LWW winner is determined by which machine happened to have a slightly faster clock, not by which write semantically came later. For user-visible data, this produces silent data loss that users notice ("I just saved this but it reverted"). Production LWW implementations use Hybrid Logical Clocks (HLC) or Lamport timestamps to eliminate clock skew as a correctness concern.

**The tie-break by node ID lexicographic order.** The `Merge` method breaks timestamp ties by comparing `nodeID` strings lexicographically. This is deterministic but arbitrary: it favors nodes whose IDs sort higher alphabetically. In a production system with meaningful node IDs (us-east-1 vs eu-west-1), this means us-east-1 always wins ties over eu-west-1 alphabetically, which is a hidden geographic bias. A safer approach is to use a random UUID for node identity so the tie-break is neither systematically biased nor human-predictable.

**GCounter slot leak under node churn.** The `GCounter.counts` map accumulates one entry per node ID that has ever incremented the counter. In a Kubernetes environment where pod names contain random suffixes (e.g., `payment-service-7f9b4c-k8xp`), each new pod adds a new entry to every GCounter it touches. Over months of pod churn, counters accumulate thousands of dead slots. A production GCounter defines node identity at a stable level (region or cluster, not pod) so that the map remains bounded.

**PNCounter is not always the right negative-counter CRDT.** The `PNCounter` uses two GCounters to support decrement. This means its total storage is 2N per counter. For high-frequency counters (page views, API call counts), the memory overhead at scale can be significant. An alternative for append-only metrics is to accumulate increments in a GCounter and use a separate log for decrements with idempotent replay, which keeps the hot path simple and defers the negative-accounting to a batch job.

**CRDT complexity as a team capability investment.** CRDTs are mathematically elegant but operationally complex. They require engineers who understand their invariants to participate in on-call rotations and incident responses. At L6+, before adopting CRDTs for a new data type, assess whether your team has this capability and build it if not. Introducing CRDTs without organizational readiness results in incidents that no one on the on-call rotation can diagnose.
