## 69.3 Open Addressing Implementation

Open addressing stores all entries directly in the backing array rather than in chained lists, improving cache locality at the cost of requiring a lower load factor (typically 0.5) to avoid excessive clustering. Linear probing resolves collisions by scanning sequentially from the home slot. A separate `deleted` flag is needed for tombstone marking so that lookup chains through previously-deleted slots remain intact.

```go
package hashtable

// OpenHashTable implements a hash table with open addressing (linear probing)
type OpenHashTable[K comparable, V any] struct {
    keys       []K
    values     []V
    occupied   []bool
    deleted    []bool
    size       int
    capacity   int
    loadFactor float64
    hashFunc   func(K) uint64
}

// NewOpenHashTable creates a hash table with open addressing
func NewOpenHashTable[K comparable, V any](capacity int, hashFunc func(K) uint64) *OpenHashTable[K, V] {
    if capacity < 1 {
        capacity = 16
    }
    return &OpenHashTable[K, V]{
        keys:       make([]K, capacity),
        values:     make([]V, capacity),
        occupied:   make([]bool, capacity),
        deleted:    make([]bool, capacity),
        capacity:   capacity,
        loadFactor: 0.5, // lower for open addressing
        hashFunc:   hashFunc,
    }
}

// findSlot finds the slot for a key (for insertion or lookup)
func (h *OpenHashTable[K, V]) findSlot(key K) (int, bool) {
    index := int(h.hashFunc(key) % uint64(h.capacity))
    firstDeleted := -1

    for i := 0; i < h.capacity; i++ {
        slot := (index + i) % h.capacity

        if !h.occupied[slot] && !h.deleted[slot] {
            // Empty slot found
            if firstDeleted != -1 {
                return firstDeleted, false
            }
            return slot, false
        }

        if h.deleted[slot] {
            // Track first deleted slot
            if firstDeleted == -1 {
                firstDeleted = slot
            }
            continue
        }

        if h.keys[slot] == key {
            // Key found
            return slot, true
        }
    }

    // Table is full (shouldn't happen with proper load factor)
    if firstDeleted != -1 {
        return firstDeleted, false
    }
    return -1, false
}

// Put adds or updates a key-value pair
func (h *OpenHashTable[K, V]) Put(key K, value V) {
    if float64(h.size)/float64(h.capacity) >= h.loadFactor {
        h.resize()
    }

    slot, found := h.findSlot(key)
    if slot == -1 {
        h.resize()
        slot, found = h.findSlot(key)
    }

    if !found {
        h.size++
    }

    h.keys[slot] = key
    h.values[slot] = value
    h.occupied[slot] = true
    h.deleted[slot] = false
}

// Get retrieves a value by key
func (h *OpenHashTable[K, V]) Get(key K) (V, bool) {
    slot, found := h.findSlot(key)
    if found && h.occupied[slot] && !h.deleted[slot] {
        return h.values[slot], true
    }
    var zero V
    return zero, false
}

// Delete removes a key-value pair
func (h *OpenHashTable[K, V]) Delete(key K) bool {
    slot, found := h.findSlot(key)
    if found && h.occupied[slot] && !h.deleted[slot] {
        h.deleted[slot] = true
        h.size--
        return true
    }
    return false
}

// resize doubles capacity and rehashes
func (h *OpenHashTable[K, V]) resize() {
    oldKeys := h.keys
    oldValues := h.values
    oldOccupied := h.occupied
    oldDeleted := h.deleted
    oldCapacity := h.capacity

    h.capacity *= 2
    h.keys = make([]K, h.capacity)
    h.values = make([]V, h.capacity)
    h.occupied = make([]bool, h.capacity)
    h.deleted = make([]bool, h.capacity)
    h.size = 0

    for i := 0; i < oldCapacity; i++ {
        if oldOccupied[i] && !oldDeleted[i] {
            h.Put(oldKeys[i], oldValues[i])
        }
    }
}

// Size returns the number of entries
func (h *OpenHashTable[K, V]) Size() int {
    return h.size
}
```

### Double Hashing (Better Probing)

Double hashing eliminates the primary clustering problem of linear probing by using a second hash function to determine the probe step size: `position = (h1(key) + i * h2(key)) % capacity`. Because different keys use different step sizes, colliding keys probe entirely distinct sequences, distributing load far more evenly than fixed-step probing.

```go
package hashtable

// DoubleHashTable uses double hashing for collision resolution
type DoubleHashTable[K comparable, V any] struct {
    keys       []K
    values     []V
    occupied   []bool
    deleted    []bool
    size       int
    capacity   int
    hashFunc1  func(K) uint64
    hashFunc2  func(K) uint64
}

// NewDoubleHashTable creates a hash table with double hashing.
// Capacity must be prime so that every step size is coprime with it and
// the probe sequence therefore visits every slot.
func NewDoubleHashTable[K comparable, V any](
    capacity int,
    h1 func(K) uint64,
    h2 func(K) uint64,
) *DoubleHashTable[K, V] {
    if capacity < 3 {
        capacity = 3 // probe() computes capacity-1 as a modulus
    }
    return &DoubleHashTable[K, V]{
        keys:      make([]K, capacity),
        values:    make([]V, capacity),
        occupied:  make([]bool, capacity),
        deleted:   make([]bool, capacity),
        capacity:  capacity,
        hashFunc1: h1,
        hashFunc2: h2,
    }
}

// probe calculates the i-th probe position using double hashing
// position = (h1(key) + i * h2(key)) % capacity
func (h *DoubleHashTable[K, V]) probe(key K, i int) int {
    h1 := h.hashFunc1(key) % uint64(h.capacity)
    h2 := h.hashFunc2(key)%(uint64(h.capacity)-1) + 1 // ensure h2 != 0
    return int((h1 + uint64(i)*h2) % uint64(h.capacity))
}

// findSlot walks the probe sequence exactly once and returns either the slot
// holding key (found=true) or the slot an insert should claim (found=false).
//
// The subtlety: an insert may NOT stop at the first tombstone it sees, because
// the key may already live further along the probe path. We remember the first
// tombstone as a reuse candidate but keep probing until we hit the key or a
// never-occupied slot, which is the only reliable end-of-chain marker.
func (h *DoubleHashTable[K, V]) findSlot(key K) (int, bool) {
    firstTomb := -1

    for i := 0; i < h.capacity; i++ {
        slot := h.probe(key, i)

        if !h.occupied[slot] {
            // Never occupied: the key cannot exist beyond this point.
            if firstTomb != -1 {
                return firstTomb, false
            }
            return slot, false
        }

        if h.deleted[slot] {
            if firstTomb == -1 {
                firstTomb = slot
            }
            continue // keep probing, the key may live further along
        }

        if h.keys[slot] == key {
            return slot, true
        }
    }

    if firstTomb != -1 {
        return firstTomb, false
    }
    return -1, false // table full of live keys
}

// Put adds or updates a key-value pair. Reports false only if the table is full.
func (h *DoubleHashTable[K, V]) Put(key K, value V) bool {
    slot, found := h.findSlot(key)
    if slot == -1 {
        return false
    }

    if !found {
        h.size++ // only a genuinely new key grows the table
    }

    h.keys[slot] = key
    h.values[slot] = value
    h.occupied[slot] = true
    h.deleted[slot] = false
    return true
}

// Get retrieves a value by key
func (h *DoubleHashTable[K, V]) Get(key K) (V, bool) {
    slot, found := h.findSlot(key)
    if found {
        return h.values[slot], true
    }
    var zero V
    return zero, false
}

// Delete tombstones a key, leaving the slot probe-through-able
func (h *DoubleHashTable[K, V]) Delete(key K) bool {
    slot, found := h.findSlot(key)
    if !found {
        return false
    }
    h.deleted[slot] = true
    h.size--
    return true
}

// Size returns the number of live entries
func (h *DoubleHashTable[K, V]) Size() int {
    return h.size
}
```

### Junior -> FAANG: Tombstones and Why Open Addressing Trips People Up

The tombstone (`deleted` flag) is the hardest concept in open addressing, and interviewers use it to separate candidates who memorized "open addressing" from those who truly understand it. The problem: if you delete a key by simply marking its slot as empty, subsequent lookups for keys that probed through that slot will terminate early and report false-negatives. The tombstone marks the slot as "was occupied, now free, but keep probing through me."

There is a second, nastier half to the tombstone rule that trips up even candidates who get the first half right. An insert must not stop at the first tombstone it encounters. If the key already lives further along the probe path, claiming the tombstone stores a *duplicate* of that key in two slots at once. Lookups return whichever copy comes first in the probe order, `size` drifts upward, and deleting the first copy silently resurrects the stale value from the second. Both `findSlot` implementations in this section therefore remember the first tombstone as a reuse candidate but keep probing to a never-occupied slot before committing to it. That is the only slot state proving the key is absent.

The practical consequence of tombstones: as deletions accumulate, tombstone slots pile up and increase average probe length even though the effective load is low. A table churned through many delete-insert cycles can end up with almost no live keys and still probe as if it were full, which is why real implementations periodically rehash to evict tombstones. This is also why open addressing is preferred for workloads with few deletions (read-heavy caches, lookup-only tables) and separate chaining is preferred when deletions are frequent.

Interview tip: when asked to compare chaining vs open addressing, lead with cache performance (open addressing stores everything contiguously, better CPU cache behavior) and tombstone overhead (open addressing degrades under heavy deletion). This level of nuance signals algorithmic maturity.

### Senior @ FAANG: Double Hashing and Probe Sequence Diversity in Production

Double hashing (`position = (h1(key) + i * h2(key)) % capacity`) is theoretically superior to linear probing because each key uses a unique probe sequence, eliminating primary clustering. In practice, it requires the table capacity to be prime to guarantee that every slot is eventually reachable. Linear probing's primary clustering is partially mitigated by Robin Hood hashing (evict the "rich" element with a short probe distance to make room for the "poor" element with a long probe distance), which also reduces variance in probe lengths.

For production Go services, neither implementation here should be used directly. The Go standard library's `map` is already a well-engineered open-addressing hash table, and since Go 1.24 it is a Swiss Tables design: groups of 8 slots, each group fronted by a 64-bit control word packing a 7-bit fingerprint per slot, probed with a quadratic sequence over groups. The group scan uses SWAR arithmetic on that single 64-bit word, meaning ordinary integer operations that test all 8 lanes at once, rather than vector SIMD instructions. The payoff is that a probe usually touches one cache line and performs at most one full key comparison, because the fingerprints filter out non-matching slots first.

Custom open-addressing implementations are appropriate only when you need properties the runtime map does not offer: memory layout control for cache-line alignment, non-standard eviction, or integration with a custom allocator. A staff-level decision is recognizing when that level of optimization is justified by measured benchmarks versus when it is premature complexity.
