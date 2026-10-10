## 69.2 Hash Table Implementation with Chaining

Separate chaining resolves collisions by storing a linked list at each bucket: multiple keys that map to the same index coexist as chained entries rather than displacing each other. This generic implementation automatically resizes when the load factor exceeds 0.75, doubling capacity and rehashing all entries to maintain O(1) average-case operations across all table sizes.

```go
package hashtable

// Entry represents a key-value pair
type Entry[K comparable, V any] struct {
    Key   K
    Value V
    Next  *Entry[K, V]
}

// HashTable implements a hash table with separate chaining
type HashTable[K comparable, V any] struct {
    buckets    []*Entry[K, V]
    size       int
    capacity   int
    loadFactor float64
    hashFunc   func(K) uint64
}

// NewHashTable creates a new hash table
func NewHashTable[K comparable, V any](capacity int, hashFunc func(K) uint64) *HashTable[K, V] {
    if capacity < 1 {
        capacity = 16
    }
    return &HashTable[K, V]{
        buckets:    make([]*Entry[K, V], capacity),
        capacity:   capacity,
        loadFactor: 0.75,
        hashFunc:   hashFunc,
    }
}

// getBucketIndex returns the bucket index for a key
func (h *HashTable[K, V]) getBucketIndex(key K) int {
    return int(h.hashFunc(key) % uint64(h.capacity))
}

// Put adds or updates a key-value pair
// Time: O(1) average, O(n) worst case
func (h *HashTable[K, V]) Put(key K, value V) {
    // Check if resize needed
    if float64(h.size)/float64(h.capacity) >= h.loadFactor {
        h.resize()
    }

    index := h.getBucketIndex(key)
    entry := h.buckets[index]

    // Search for existing key
    for entry != nil {
        if entry.Key == key {
            entry.Value = value // update existing
            return
        }
        entry = entry.Next
    }

    // Insert new entry at head
    newEntry := &Entry[K, V]{
        Key:   key,
        Value: value,
        Next:  h.buckets[index],
    }
    h.buckets[index] = newEntry
    h.size++
}

// Get retrieves a value by key
// Time: O(1) average, O(n) worst case
func (h *HashTable[K, V]) Get(key K) (V, bool) {
    index := h.getBucketIndex(key)
    entry := h.buckets[index]

    for entry != nil {
        if entry.Key == key {
            return entry.Value, true
        }
        entry = entry.Next
    }

    var zero V
    return zero, false
}

// Delete removes a key-value pair
// Time: O(1) average, O(n) worst case
func (h *HashTable[K, V]) Delete(key K) bool {
    index := h.getBucketIndex(key)
    entry := h.buckets[index]
    var prev *Entry[K, V]

    for entry != nil {
        if entry.Key == key {
            if prev == nil {
                h.buckets[index] = entry.Next
            } else {
                prev.Next = entry.Next
            }
            h.size--
            return true
        }
        prev = entry
        entry = entry.Next
    }

    return false
}

// Contains checks if a key exists
func (h *HashTable[K, V]) Contains(key K) bool {
    _, ok := h.Get(key)
    return ok
}

// Size returns the number of entries
func (h *HashTable[K, V]) Size() int {
    return h.size
}

// resize doubles the capacity and rehashes all entries
func (h *HashTable[K, V]) resize() {
    oldBuckets := h.buckets
    h.capacity *= 2
    h.buckets = make([]*Entry[K, V], h.capacity)
    h.size = 0

    for _, entry := range oldBuckets {
        for entry != nil {
            h.Put(entry.Key, entry.Value)
            entry = entry.Next
        }
    }
}

// Keys returns all keys
func (h *HashTable[K, V]) Keys() []K {
    keys := make([]K, 0, h.size)
    for _, entry := range h.buckets {
        for entry != nil {
            keys = append(keys, entry.Key)
            entry = entry.Next
        }
    }
    return keys
}

// Values returns all values
func (h *HashTable[K, V]) Values() []V {
    values := make([]V, 0, h.size)
    for _, entry := range h.buckets {
        for entry != nil {
            values = append(values, entry.Value)
            entry = entry.Next
        }
    }
    return values
}
```

### Junior -> FAANG: What "Implement a Hash Map from Scratch" Tests

"Implement a hash map from scratch" is a standard coding-screen knowledge probe. The implementation above covers everything you need to pass it: a bucket array, a chained entry struct, a load factor threshold triggering resize, and O(1) amortized Put/Get/Delete. The most common mistakes candidates make in this problem are: forgetting to update the existing value on a duplicate key (line 56-59 in Put), not handling the nil head case in Delete (checking `prev == nil`), and not rehashing all entries during resize (incorrectly copying pointers rather than re-inserting).

Practice explaining the load factor: "When size/capacity exceeds 0.75, lookup chains grow long enough that O(1) average degrades. We double capacity and rehash to restore the invariant. The cost of a resize is O(n) amortized over the n insertions that triggered it, so insertion remains O(1) amortized overall."

### Senior @ FAANG: Evaluating Generic Hash Table Design Choices

The generic `HashTable[K comparable, V any]` using Go's type parameters is idiomatic for Go 1.18+. At the staff level, the review concerns shift from "does it work" to "is it the right abstraction for the team?"

The injected `hashFunc func(K) uint64` parameter is a double-edged design. It is correct for a library that must support arbitrary key types, but it exposes callers to the hash function quality problem: a badly chosen hash function passed by the caller silently degrades performance without any observable error. A production library should validate hash function quality (by running the `AnalyzeCollisions` check during construction in debug builds) or provide a set of well-tested default hash functions per key type.

The resize strategy (double capacity on threshold breach) is the correct amortized choice, but it concentrates cost: the resize is a single O(n) stall that walks every entry, and the old and new bucket arrays coexist for the duration. In this chained design the arrays hold only pointers, so the transient overhead is one extra pointer per old slot rather than a copy of the entries, but a table storing keys and values inline would double its whole footprint at the peak. Either way, one unlucky insertion pays for all the others, which is fine for throughput and bad for tail latency.

Go's runtime map avoids that stall differently than the classic "rehash everything at once" approach. It splits its contents across multiple independent tables, each capped at a maximum size, and selects among them with extendible hashing: the upper bits of the hash index into a directory of tables. When one table fills, only that table splits into two, and the directory doubles only when it has run out of bits to distinguish them. Growth work is therefore proportional to one table, not the whole map. Production systems with constrained memory budgets should still pre-allocate at the expected peak size with `make(map[K]V, expectedSize)`, which skips the intermediate growth steps entirely.
