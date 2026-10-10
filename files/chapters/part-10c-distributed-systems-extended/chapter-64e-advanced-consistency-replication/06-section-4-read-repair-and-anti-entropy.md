## Section 4: Read Repair and Anti-Entropy

### 4.1 Read Repair

Read repair is a background consistency mechanism: when a read coordinator queries multiple replicas and observes divergent values, it asynchronously writes the most recent value back to stale replicas. The following Go implementation simulates a quorum read that detects version mismatches and issues repair writes, illustrating how read repair gradually converges replicas without a dedicated anti-entropy process.

```go
package replication

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type Comparison int

const (
	HappensBefore Comparison = -1
	Concurrent    Comparison = 0
	HappensAfter  Comparison = 1
	Identical     Comparison = 2
)

type VectorClockSnapshot struct {
	NodeID string
	Clocks map[string]uint64
}

type VectorClock struct {
	nodeID string
	clocks map[string]uint64
}

func (vc *VectorClock) Compare(other VectorClockSnapshot) Comparison {
	thisBeforeOther := false
	otherBeforeThis := false
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

// VersionedValue stores a value with its version vector for conflict detection.
type VersionedValue[T any] struct {
	Value   T
	Version VectorClockSnapshot
	NodeID  string
}

// ReplicaSet manages a set of replicas with read repair.
type ReplicaSet[K comparable, V any] struct {
	replicas   []Replica[K, V]
	readQuorum  int
	writeQuorum int
}

// Replica represents a single replica in the set.
type Replica[K comparable, V any] interface {
	Get(ctx context.Context, key K) (*VersionedValue[V], error)
	Put(ctx context.Context, key K, value VersionedValue[V]) error
	NodeID() string
}

func NewReplicaSet[K comparable, V any](replicas []Replica[K, V], r, w int) *ReplicaSet[K, V] {
	return &ReplicaSet[K, V]{
		replicas:    replicas,
		readQuorum:  r,
		writeQuorum: w,
	}
}

// ReadResult holds the result from one replica.
type ReadResult[V any] struct {
	Value  *VersionedValue[V]
	Err    error
	Replica Replica[any, V]
}

// Get performs a quorum read with read repair.
// 1. Read from R replicas concurrently.
// 2. Return the highest-version value to the client.
// 3. Asynchronously write the latest value back to stale replicas (read repair).
func (rs *ReplicaSet[K, V]) Get(ctx context.Context, key K) (*VersionedValue[V], error) {
	results := make(chan struct {
		idx   int
		value *VersionedValue[V]
		err   error
	}, len(rs.replicas))

	// Read from all replicas concurrently.
	for i, r := range rs.replicas {
		go func(idx int, replica Replica[K, V]) {
			val, err := replica.Get(ctx, key)
			results <- struct {
				idx   int
				value *VersionedValue[V]
				err   error
			}{idx, val, err}
		}(i, r)
	}

	// Collect quorum.
	var (
		responses = make([]*VersionedValue[V], len(rs.replicas))
		errCount  = 0
		gotCount  = 0
	)

	for i := 0; i < len(rs.replicas); i++ {
		result := <-results
		if result.err != nil {
			errCount++
		} else {
			responses[result.idx] = result.value
			gotCount++
			if gotCount >= rs.readQuorum {
				break
			}
		}
	}

	if gotCount < rs.readQuorum {
		return nil, fmt.Errorf("read quorum not met: got %d/%d", gotCount, rs.readQuorum)
	}

	// Find the most recent value.
	var latest *VersionedValue[V]
	var latestIdx int
	for i, v := range responses {
		if v == nil {
			continue
		}
		if latest == nil {
			latest = v
			latestIdx = i
			continue
		}
		vc := NewVectorClockFromSnapshot(v.Version)
		if vc.Compare(latest.Version) == HappensAfter {
			latest = v
			latestIdx = i
		}
	}
	_ = latestIdx

	// Asynchronous read repair: update stale replicas.
	if latest != nil {
		go rs.repairStaleReplicas(context.Background(), key, latest, responses)
	}

	return latest, nil
}

// repairStaleReplicas writes the latest value to replicas that have stale data.
func (rs *ReplicaSet[K, V]) repairStaleReplicas(ctx context.Context, key K, latest *VersionedValue[V], responses []*VersionedValue[V]) {
	for i, v := range responses {
		if v == nil {
			continue
		}
		vc := NewVectorClockFromSnapshot(v.Version)
		cmp := vc.Compare(latest.Version)
		if cmp == HappensBefore {
			// Stale replica - repair it.
			_ = rs.replicas[i].Put(ctx, key, *latest)
		}
	}
}

// NewVectorClockFromSnapshot creates a VectorClock from a snapshot for comparison.
func NewVectorClockFromSnapshot(snap VectorClockSnapshot) *VectorClock {
	return &VectorClock{
		nodeID: snap.NodeID,
		clocks: snap.Clocks,
	}
}

// HintedHandoff stores writes for temporarily unreachable replicas.
// When a replica comes back online, the hints are replayed to it.
type HintedHandoff[K comparable, V any] struct {
	mu    sync.Mutex
	hints map[string][]Hint[K, V] // nodeID → hints for that node
	store HintStore[K, V]
}

// Hint is a write that couldn't be applied to a specific replica.
type Hint[K comparable, V any] struct {
	TargetNode string
	Key        K
	Value      VersionedValue[V]
	CreatedAt  time.Time
}

// HintStore persists hints durably.
type HintStore[K comparable, V any] interface {
	Save(hint Hint[K, V]) error
	Load(nodeID string) ([]Hint[K, V], error)
	Delete(nodeID string, key K) error
}

func NewHintedHandoff[K comparable, V any](store HintStore[K, V]) *HintedHandoff[K, V] {
	return &HintedHandoff[K, V]{
		hints: make(map[string][]Hint[K, V]),
		store: store,
	}
}

// StoreHint saves a hint for a write that couldn't be delivered.
func (hh *HintedHandoff[K, V]) StoreHint(targetNode string, key K, value VersionedValue[V]) error {
	hint := Hint[K, V]{
		TargetNode: targetNode,
		Key:        key,
		Value:      value,
		CreatedAt:  time.Now(),
	}
	hh.mu.Lock()
	hh.hints[targetNode] = append(hh.hints[targetNode], hint)
	hh.mu.Unlock()
	return hh.store.Save(hint)
}

// ReplayHints replays all stored hints to a node that has come back online.
func (hh *HintedHandoff[K, V]) ReplayHints(ctx context.Context, nodeID string, replica Replica[K, V]) error {
	hints, err := hh.store.Load(nodeID)
	if err != nil {
		return err
	}

	for _, hint := range hints {
		if err := replica.Put(ctx, hint.Key, hint.Value); err != nil {
			return fmt.Errorf("replay hint for key %v: %w", hint.Key, err)
		}
		_ = hh.store.Delete(nodeID, hint.Key)
	}

	hh.mu.Lock()
	delete(hh.hints, nodeID)
	hh.mu.Unlock()

	return nil
}
```

### 4.2 Anti-Entropy with Merkle Trees

Anti-entropy processes proactively reconcile diverged replicas by comparing Merkle tree hashes of their key ranges and exchanging only the differing subtrees, minimizing data transfer during full synchronization. The following Go implementation builds a Merkle tree over a key-value store, compares trees between two replicas, and identifies the minimal set of keys that need to be synchronized.

```go
package antientropy

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"time"
)

// MerkleTree builds a hash tree over key-value data for efficient diff detection.
// Two nodes can compare their Merkle trees to identify which subtrees differ,
// narrowing the repair to only the divergent ranges. O(log N) diff detection.
type MerkleTree struct {
	root   *merkleNode
	leaves int
}

type merkleNode struct {
	hash  [32]byte
	left  *merkleNode
	right *merkleNode
	key   string // Only for leaf nodes.
}

// MerkleLeaf represents one key-value pair for the Merkle tree.
type MerkleLeaf struct {
	Key   string
	Value []byte
}

// Build constructs a Merkle tree from a sorted list of key-value pairs.
// The tree allows comparing two replicas to find divergent ranges.
func Build(leaves []MerkleLeaf) *MerkleTree {
	if len(leaves) == 0 {
		return &MerkleTree{}
	}
	// Ensure leaves are sorted by key.
	sort.Slice(leaves, func(i, j int) bool {
		return leaves[i].Key < leaves[j].Key
	})

	nodes := make([]*merkleNode, len(leaves))
	for i, leaf := range leaves {
		nodes[i] = &merkleNode{
			hash: hashLeaf(leaf.Key, leaf.Value),
			key:  leaf.Key,
		}
	}

	root := buildTree(nodes)
	return &MerkleTree{root: root, leaves: len(leaves)}
}

func buildTree(nodes []*merkleNode) *merkleNode {
	if len(nodes) == 1 {
		return nodes[0]
	}
	mid := len(nodes) / 2
	left := buildTree(nodes[:mid])
	right := buildTree(nodes[mid:])
	parent := &merkleNode{
		left:  left,
		right: right,
		hash:  hashPair(left.hash, right.hash),
	}
	return parent
}

// RootHash returns the tree's root hash.
// If two Merkle trees have the same root hash, their data is identical.
func (t *MerkleTree) RootHash() [32]byte {
	if t.root == nil {
		return [32]byte{}
	}
	return t.root.hash
}

// Diff returns the keys that differ between this tree and another.
// O(k log N) where k is the number of differing entries.
func (t *MerkleTree) Diff(other *MerkleTree) []string {
	if t.root == nil || other.root == nil {
		return nil
	}
	var diffs []string
	diffNodes(t.root, other.root, &diffs)
	return diffs
}

func diffNodes(a, b *merkleNode, diffs *[]string) {
	if a == nil || b == nil {
		return
	}
	if a.hash == b.hash {
		return // Subtrees are identical.
	}
	if a.left == nil && a.right == nil {
		// Leaf node that differs.
		*diffs = append(*diffs, a.key)
		return
	}
	diffNodes(a.left, b.left, diffs)
	diffNodes(a.right, b.right, diffs)
}

func hashLeaf(key string, value []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte(key))
	h.Write(value)
	var result [32]byte
	copy(result[:], h.Sum(nil))
	return result
}

func hashPair(a, b [32]byte) [32]byte {
	var combined [64]byte
	copy(combined[:32], a[:])
	copy(combined[32:], b[:])
	return sha256.Sum256(combined[:])
}

// AntiEntropyReconciler periodically compares Merkle trees between replicas.
type AntiEntropyReconciler[K comparable, V any] struct {
	localStore   KeyValueStore[K, V]
	peers        []PeerStore[K, V]
	interval     time.Duration
}

// KeyValueStore is a local key-value store that can produce a Merkle tree.
type KeyValueStore[K comparable, V any] interface {
	Scan() []MerkleLeaf // Scan all key-value pairs.
	Get(key string) ([]byte, bool)
	Put(key string, value []byte) error
}

// PeerStore is a remote replica's store.
type PeerStore[K comparable, V any] interface {
	GetMerkleRoot() ([32]byte, error)
	GetMerkleDiff(myRoot [32]byte) ([]string, error)
	GetValues(keys []string) (map[string][]byte, error)
}

func NewAntiEntropyReconciler[K comparable, V any](
	local KeyValueStore[K, V],
	peers []PeerStore[K, V],
	interval time.Duration,
) *AntiEntropyReconciler[K, V] {
	return &AntiEntropyReconciler[K, V]{
		localStore: local,
		peers:      peers,
		interval:   interval,
	}
}

// Run starts the anti-entropy reconciliation loop.
func (r *AntiEntropyReconciler[K, V]) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, peer := range r.peers {
				r.reconcileWithPeer(ctx, peer)
			}
		}
	}
}

func (r *AntiEntropyReconciler[K, V]) reconcileWithPeer(ctx context.Context, peer PeerStore[K, V]) {
	// Build local Merkle tree.
	leaves := r.localStore.Scan()
	localTree := Build(leaves)

	// Get peer's root hash.
	peerRoot, err := peer.GetMerkleRoot()
	if err != nil {
		return
	}

	if localTree.RootHash() == peerRoot {
		return // In sync.
	}

	// Get differing keys.
	diffKeys, err := peer.GetMerkleDiff(localTree.RootHash())
	if err != nil {
		return
	}

	if len(diffKeys) == 0 {
		return
	}

	// Fetch differing values from peer.
	peerValues, err := peer.GetValues(diffKeys)
	if err != nil {
		return
	}

	// Apply peer's values (simplified - production would compare versions).
	for key, value := range peerValues {
		local, ok := r.localStore.Get(key)
		if !ok || !bytesEqual(local, value) {
			_ = r.localStore.Put(key, value)
		}
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// imports
var _ = binary.LittleEndian
var _ = time.Duration(0)
var _ = context.Background
var _ = fmt.Sprintf
```

### Junior → FAANG: Read Repair and Anti-Entropy as Complementary Convergence Mechanisms

Read repair and anti-entropy solve the same problem (replica divergence) through different triggering mechanisms, and understanding the difference is important for storage system interviews.

Read repair is passive: it fires only when a client reads a key. If a key is never read, its replicas can diverge indefinitely. This is fine for hot data (frequently read keys converge quickly) but leaves cold data in an inconsistent state. In a user profile system, a user who has not logged in for six months may have a slightly different profile on different replicas with no read repair having fired in that time.

Anti-entropy via Merkle trees is active: it fires on a schedule regardless of read traffic. The key efficiency insight is the tree structure. Without Merkle trees, comparing two replicas requires transmitting all key-value pairs. With Merkle trees, you compare root hashes first. If they match, the replicas are identical and you are done. If they differ, you recurse into subtrees, narrowing down to exactly which key ranges differ. For a replica set with 10 million keys and 1,000 differing keys, the Merkle tree approach transmits O(1,000 log 10,000,000) hashes for the diff comparison, compared to O(10,000,000) for full comparison.

Hinted handoff is the mechanism that prevents data loss when a replica is temporarily unavailable during a write. The coordinator holds the write as a "hint" and replays it when the target replica comes back online. The TTL on hints is critical: if a replica is down for longer than the hint TTL, you have a period of silent inconsistency that hinted handoff will not cover. This is why Cassandra documentation specifies that hinted handoff is not a replacement for anti-entropy repair.

Interview framing: these mechanisms layer. A system might use hinted handoff for short-term unavailability (minutes), read repair for frequently accessed data, and scheduled anti-entropy for complete eventual convergence. The combination provides a convergence SLA without requiring coordination on every write.

### Senior @ FAANG: Consistency Repair at Scale and Its Operational Cost

At large scale, the "read repair" and "anti-entropy" labels describe problems that have significantly higher operational complexity than the implementation in this section suggests.

Read repair at scale creates write amplification. If a read from R replicas reveals that K of them have stale data, the repair sends K writes to update the stale replicas. In a system with 100 replicas per key (large Cassandra cluster) and a write amplification of 3 (W=3, R=2), a small burst of reads on a hot key can trigger a burst of repair writes that exceeds the cluster's write capacity. Production systems implement read repair as probabilistic (repair with probability P per read rather than always) and throttled to a maximum repair throughput per node.

Merkle tree comparison has correctness subtleties at scale. The implementation in this section builds the Merkle tree over a snapshot of the key-value store. In a live system, the store is being written to while the tree is being built, so two scans of the same store at different times will produce different trees. This can cause the diff algorithm to report spurious differences that do not actually represent inconsistencies. Production anti-entropy processes either build Merkle trees over immutable SSTable files (Cassandra's approach) or use a consistent snapshot mechanism.

For platform architects: the anti-entropy repair frequency is a tunable parameter that balances consistency convergence time against operational overhead. Reducing the repair interval from 10 days to 1 day doubles the anti-entropy write amplification. The right interval depends on your consistency SLA (how stale can a replica be before it causes a user-visible problem) and your cluster's write capacity headroom. Many Cassandra operators learn this the hard way after enabling `nodetool repair` on all tables and degrading write performance by 20% because the repair was consuming too much I/O.

Observability for convergence: a production storage system should expose a metric for "replica divergence ratio" (fraction of keys differing between the primary and each replica at any given time). If this metric is trending up despite read repair and anti-entropy running, it indicates that write throughput is exceeding the repair capacity, and you need to either reduce the repair interval or reduce write throughput.

---
