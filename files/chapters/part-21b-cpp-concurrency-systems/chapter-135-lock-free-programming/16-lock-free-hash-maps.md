## Lock-Free Hash Maps

Hash maps are the hardest mainstream lock-free structure. Resize is the killer. Three production designs solve it: Cliff Click's NonBlockingHashMap (2007), the split-ordered list of Shalev-Shavit (2006), and folly's AtomicHashMap (open addressing, fixed capacity).

### Cliff Click's NonBlockingHashMap

Cliff Click designed this for the Azul JVM, then released it for Java's `Cliff Click's NonBlockingHashMap`. The C++ port lives in Junction (Jeff Preshing's library). The structure is a flat array of `(key, value)` slots with three sentinel values per slot.

Three states matter:
- `key == EMPTY, value == EMPTY`: never used.
- `key == K, value == V`: live mapping.
- `key == K, value == TOMBSTONE`: deleted.
- `key == K, value == SENTINEL`: copied to a new table.

Resize is the interesting operation. Instead of stop-the-world, Click introduces a help-from-readers protocol. When the load factor exceeds the threshold, a writer allocates a new table at twice the size and links it from the old table. Every subsequent reader and writer that touches the old table also copies one slot to the new table. The old table's slots are atomically marked as copied (the SENTINEL value) once their content is in the new table.

```cpp
struct Slot {
    std::atomic<uint64_t> key;
    std::atomic<uint64_t> value;
};

constexpr uint64_t EMPTY = 0;
constexpr uint64_t TOMBSTONE = 1;
constexpr uint64_t SENTINEL = 2;

struct Table {
    size_t size;
    std::atomic<size_t> used{0};
    std::atomic<Table*> next{nullptr};  // resize target
    std::atomic<size_t> copy_idx{0};    // resize cursor
    std::atomic<size_t> copy_done{0};
    Slot slots[];
};
```

The slot value can encode "primed" by ORing a high bit. A primed value means a resize copy is in flight for this slot. Readers that see a primed value walk to the next table.

```cpp
constexpr uint64_t PRIME_BIT = 1ULL << 63;

uint64_t* get(Table* t, uint64_t key) {
    while (true) {
        size_t idx = hash(key) & (t->size - 1);
        for (size_t probe = 0; probe < t->size; ++probe) {
            Slot& s = t->slots[(idx + probe) & (t->size - 1)];
            uint64_t k = s.key.load(std::memory_order_acquire);
            if (k == EMPTY) return nullptr;
            if (k == key) {
                uint64_t v = s.value.load(std::memory_order_acquire);
                if (v == TOMBSTONE) return nullptr;
                if (v == SENTINEL) break;  // walk to next table
                if (v & PRIME_BIT) {
                    help_copy_slot(t, (idx + probe) & (t->size - 1));
                    break;
                }
                return reinterpret_cast<uint64_t*>(v);
            }
        }
        Table* nxt = t->next.load(std::memory_order_acquire);
        if (!nxt) return nullptr;
        t = nxt;
    }
}
```

Insertions follow the same probe sequence with CAS to claim an empty slot for the key, then a second CAS to set the value.

```cpp
bool put(Table* t, uint64_t key, uint64_t value) {
    while (true) {
        size_t idx = hash(key) & (t->size - 1);
        for (size_t probe = 0; probe < t->size; ++probe) {
            Slot& s = t->slots[(idx + probe) & (t->size - 1)];
            uint64_t k = s.key.load(std::memory_order_acquire);
            if (k == EMPTY) {
                uint64_t expected = EMPTY;
                if (!s.key.compare_exchange_strong(expected, key,
                        std::memory_order_acq_rel)) {
                    if (expected != key) continue;
                }
                t->used.fetch_add(1, std::memory_order_relaxed);
            }
            if (k != key && k != EMPTY) continue;

            uint64_t v = s.value.load(std::memory_order_acquire);
            if (v == SENTINEL || (v & PRIME_BIT)) break;  // resized
            if (s.value.compare_exchange_strong(v, value,
                    std::memory_order_acq_rel)) {
                if (load_factor_high(t)) start_resize(t);
                return true;
            }
        }
        Table* nxt = t->next.load(std::memory_order_acquire);
        if (!nxt) nxt = start_resize(t);
        t = nxt;
    }
}
```

The cooperative resize is what makes this scale. Every operation that finds a primed slot also copies one or more slots to the new table. The resize completes when `copy_done == size`.

### Junior to FAANG: Why Probing Order Cannot Change Mid-Lookup

Open addressing requires the probe sequence to be deterministic for a key. If the hash function or table size changes mid-lookup, the lookup misses entries that exist. Click's resize protocol solves this by linking tables: a reader probes the old table fully, then checks the next table. Tables form a chain that readers traverse until they find the entry or reach the end.

A junior implementation that picks the latest table at every probe step is broken because resize can complete between probes, the old table is freed, and the reader segfaults.

### Junction Maps

Jeff Preshing's Junction library ports Click's design to C++ with EBR for memory reclamation of old tables. Junction adds three improvements:

**Linear probing with neighborhood limit.** Instead of probing the entire table, Junction caps the probe distance at log2(size) and triggers resize when the cap is exceeded. This bounds lookup latency.

**Compact migration.** Resizes copy slots in cache-line-sized chunks (8 slots at 16 bytes each = 128 bytes). The copying thread takes ownership of an 8-slot chunk via CAS on a per-chunk done flag.

**Two-stage delete.** A delete first marks the value as TOMBSTONE, then a background sweep collapses tombstone runs by re-probing keys. Without the sweep, tombstones accumulate and probe lengths grow.

### Folly's AtomicHashMap (Open Addressing, Fixed Capacity)

Folly took a different design path. AtomicHashMap is fixed-capacity (passed at construction). It uses `AtomicHashArray` as a building block: open addressing with linear probing. When the array fills, it allocates a new sub-map and links it. Lookups walk the chain.

```cpp
template <typename K, typename V>
class AtomicHashArray {
    struct Cell {
        std::atomic<K> key{kEmpty};
        V value;  // not atomic, set after key CAS succeeds
    };
    Cell* cells_;
    size_t capacity_;
    std::atomic<size_t> num_entries_{0};

public:
    bool insert(K key, V value) {
        size_t idx = hash(key) % capacity_;
        for (size_t probe = 0; probe < capacity_; ++probe) {
            size_t i = (idx + probe) % capacity_;
            K expected = kEmpty;
            if (cells_[i].key.compare_exchange_strong(expected, kLocking,
                    std::memory_order_acq_rel)) {
                cells_[i].value = std::move(value);
                cells_[i].key.store(key, std::memory_order_release);
                num_entries_.fetch_add(1, std::memory_order_relaxed);
                return true;
            }
            if (expected == key) return false;  // duplicate
            if (expected == kLocking) {
                while (cells_[i].key.load(std::memory_order_acquire) == kLocking) cpu_relax();
            }
        }
        return false;  // full
    }
};
```

The kLocking sentinel is a transient state during insert. A reader that sees kLocking spins briefly. This is the only place AtomicHashMap is technically not lock-free, but the spin is bounded by a single store from the inserting thread.

### Split-Ordered List (Shalev-Shavit 2006)

A radically different design. Instead of an array of buckets, the structure is a single sorted linked list of all entries. Buckets are pointers into this list. To find key K, start at bucket hash(K) and walk the list. Resize is purely about adding new bucket pointers, never about rearranging the list.

The trick is the sort order. Keys are sorted by the bit-reversed value of their hash. This means doubling the bucket array only requires inserting new bucket pointers between existing ones, never moving entries.

```cpp
struct Node {
    std::atomic<Node*> next;
    uint64_t reversed_hash;  // sort key
    K key;
    V value;
};

class SplitOrderedList {
    std::atomic<Node*> head_;
    std::atomic<Node**> buckets_;
    std::atomic<size_t> bucket_count_;
    std::atomic<size_t> entry_count_;

    Node* get_bucket(size_t idx) {
        Node* b = buckets_.load(std::memory_order_acquire)[idx];
        if (b) return b;
        return initialize_bucket(idx);
    }

    Node* initialize_bucket(size_t idx) {
        size_t parent = idx & (idx - 1);  // clear lowest set bit
        Node* parent_b = parent == idx ? head_.load() : get_bucket(parent);
        Node* dummy = new Node{nullptr, reverse(idx), {}, {}};
        Node* inserted = list_insert(parent_b, dummy);
        buckets_.load()[idx] = inserted;
        return inserted;
    }
};
```

Initialization is recursive: bucket K's parent is K with its lowest set bit cleared. Bucket 5 (binary 101) has parent 4 (binary 100). Bucket 6 (110) has parent 4. The recursion bottoms out at bucket 0, which is `head_` itself.

Resize doubles `bucket_count_` with a single store. Buckets above the old count are lazily initialized on first access. No locking, no copying, no migration protocol.

The downside is the linked list traversal. Lookup is O(1 + load_factor) but with worse cache behavior than an open-addressed array. Java's `ConcurrentSkipListMap` uses a related structure.

### Resize Protocol Comparison

| Design | Resize cost | Read during resize | Memory overhead |
| --- | --- | --- | --- |
| Click NBHM | Cooperative copy, amortized over operations | Walks chain of tables | 2x during resize |
| AtomicHashMap | Allocates new sub-map, no copy | Walks chain of sub-maps | Bounded by chain length |
| Split-ordered | Single store doubles bucket count | No effect | 1x always |
| Stop-the-world rehash (std::unordered_map + mutex) | O(n) blocking | Blocked | 2x during resize |

Split-ordered has the cheapest resize but the slowest lookups. Click's design has the most complex code but the best read performance once resize completes.

### Senior at FAANG: Memory Reclamation for Old Tables

Click's design produces a chain of old tables. Each is reachable until all readers traversing the chain have exited. EBR is the standard reclaimer because pinning is per-operation (the entire `get` runs inside one pin) and traversal can touch many old tables.

Hazard pointers are awkward because each reader needs one slot per table in the chain, and chain length can be unbounded during heavy resize storms.

```cpp
template <typename K, typename V>
class NBHM {
    std::atomic<Table*> root_;
    folly::rcu_domain<>& domain_ = folly::rcu_default_domain();

public:
    bool get(K key, V& out) {
        folly::rcu_reader g;
        Table* t = root_.load(std::memory_order_acquire);
        while (t) {
            if (lookup_in_table(t, key, out)) return true;
            t = t->next.load(std::memory_order_acquire);
        }
        return false;
    }

    void retire_old_table(Table* t) {
        folly::rcu_retire(t, [](Table* p) { delete[] p->slots; delete p; });
    }
};
```

### Cost Numbers

On a 32-thread machine, 50/50 read/write, 1M entries:

| Map | Throughput |
| --- | --- |
| `std::unordered_map` + `std::shared_mutex` | 4-7 Mops |
| `tbb::concurrent_hash_map` | 18-25 Mops |
| Folly `AtomicHashMap` | 30-45 Mops |
| Junction NBHM | 40-65 Mops |
| Split-ordered list | 25-35 Mops |

For read-heavy workloads (95/5), Junction NBHM hits 80-110 Mops because reads do not touch any atomic except the slot itself.

### When to Use Which

Bounded, known capacity, low churn. AtomicHashMap.

Unbounded, write-heavy, must scale to many cores. Junction NBHM.

Read-mostly, must support iteration in sorted order. Split-ordered list (gives sorted iteration as a side effect).

Read-mostly, point lookups only, occasional writes. RCU plus a copy-on-write `std::unordered_map` (writers replace the entire map atomically). This is what nginx and HAProxy do for configuration tables.
