## Lock-Free Skip Lists

Keir Fraser and Tim Harris introduced the production lock-free skip list in Fraser's 2004 PhD thesis. Java's `ConcurrentSkipListMap` is a refined version of this algorithm. The structure provides logarithmic ordered map operations with no central bottleneck.

### The Skip List Recap

A skip list is a tower of sorted linked lists. The bottom list contains every element. Each higher list contains a random subset, with each element promoted to level k+1 with probability 1/2 (or 1/e for tighter bounds). Lookup descends from the top, scanning right while keys are smaller than the target, dropping down a level when the next key would overshoot.

Expected lookup, insert, and delete are O(log n) with high probability. The data structure is amenable to fine-grained concurrency because most operations touch only a logarithmic number of nodes.

### Harris's Marked Pointer Trick (2001)

The fundamental problem with lock-free linked-list deletion: how do you ensure that a node is not concurrently inserted as a successor of a node you are about to remove? Tim Harris's 2001 PODC paper solved it with a two-step deletion using the low bit of the next pointer as a logical-deletion mark.

Step 1: CAS the deleted node's `next` pointer from `(succ, unmarked)` to `(succ, marked)`. Once marked, the node is logically deleted and no thread will insert after it.

Step 2: CAS the predecessor's `next` pointer from `node` to `succ`. Physical removal.

Threads that traverse the list and see a marked next pointer help with the physical removal before continuing.

```cpp
template <typename T>
struct MarkedPtr {
    uintptr_t bits;
    T* ptr() const { return reinterpret_cast<T*>(bits & ~uintptr_t{1}); }
    bool marked() const { return bits & 1; }
    static MarkedPtr make(T* p, bool mark) {
        return {reinterpret_cast<uintptr_t>(p) | (mark ? 1 : 0)};
    }
};
```

The low bit is available because nodes are at least 2-byte aligned (in practice 16 or 32 byte). This is the same trick used in tagged pointers but for boolean state instead of an ABA tag.

### Fraser-Harris Skip List

```cpp
template <typename K, typename V>
class LockFreeSkipList {
    static constexpr int kMaxLevel = 32;

    struct Node {
        K key;
        V value;
        int top_level;
        std::atomic<MarkedPtr<Node>> next[kMaxLevel];
    };

    Node* head_;
    Node* tail_;

    int random_level() {
        int lvl = 1;
        while ((rand() & 1) && lvl < kMaxLevel) ++lvl;
        return lvl;
    }
};
```

`head_` and `tail_` are sentinels. `head_->next[i]` initially points to `tail_` for every level. `tail_->key` is conceptually +infinity.

#### Find with Mark Cleanup

```cpp
bool find(K key, Node* preds[], Node* succs[]) {
    int bottom_level = 0;
retry:
    Node* pred = head_;
    for (int level = kMaxLevel - 1; level >= bottom_level; --level) {
        Node* curr = pred->next[level].load(std::memory_order_acquire).ptr();
        while (true) {
            MarkedPtr<Node> succ_mp = curr->next[level].load(std::memory_order_acquire);
            while (succ_mp.marked()) {
                MarkedPtr<Node> expected = MarkedPtr<Node>::make(curr, false);
                if (!pred->next[level].compare_exchange_strong(expected,
                        MarkedPtr<Node>::make(succ_mp.ptr(), false),
                        std::memory_order_acq_rel)) {
                    goto retry;
                }
                curr = succ_mp.ptr();
                succ_mp = curr->next[level].load(std::memory_order_acquire);
            }
            if (curr->key < key) {
                pred = curr;
                curr = succ_mp.ptr();
            } else {
                break;
            }
        }
        preds[level] = pred;
        succs[level] = curr;
    }
    return succs[bottom_level]->key == key;
}
```

The find procedure does double duty. It locates the position of `key`, and along the way it physically unlinks any logically-deleted nodes it encounters. This is the cooperative cleanup that makes the algorithm self-healing.

#### Insert

```cpp
bool insert(K key, V value) {
    int top = random_level();
    Node* preds[kMaxLevel];
    Node* succs[kMaxLevel];

    while (true) {
        if (find(key, preds, succs)) return false;
        Node* fresh = new Node{key, value, top, {}};
        for (int i = 0; i < top; ++i) {
            fresh->next[i].store(MarkedPtr<Node>::make(succs[i], false),
                std::memory_order_relaxed);
        }
        // Bottom level first - this is the linearization point
        MarkedPtr<Node> expected = MarkedPtr<Node>::make(succs[0], false);
        if (!preds[0]->next[0].compare_exchange_strong(expected,
                MarkedPtr<Node>::make(fresh, false),
                std::memory_order_acq_rel)) {
            delete fresh;
            continue;
        }
        // Higher levels can race with delete - retry per level
        for (int level = 1; level < top; ++level) {
            while (true) {
                MarkedPtr<Node> exp = MarkedPtr<Node>::make(succs[level], false);
                if (preds[level]->next[level].compare_exchange_strong(exp,
                        MarkedPtr<Node>::make(fresh, false),
                        std::memory_order_acq_rel)) break;
                find(key, preds, succs);  // refresh
            }
        }
        return true;
    }
}
```

The bottom-level CAS is the linearization point. After it succeeds, the node is in the list as far as any reader is concerned. Higher levels are link-up optimization, they can be added later without breaking correctness.

A node that has its bottom-level link installed but not its upper-level links is sometimes called partially linked. Concurrent readers can find it via the bottom level. Concurrent inserters that would conflict at higher levels back off and retry.

#### Delete

```cpp
bool remove(K key) {
    Node* preds[kMaxLevel];
    Node* succs[kMaxLevel];

    if (!find(key, preds, succs)) return false;
    Node* victim = succs[0];

    // Mark from top down
    for (int level = victim->top_level - 1; level >= 1; --level) {
        MarkedPtr<Node> mp = victim->next[level].load(std::memory_order_acquire);
        while (!mp.marked()) {
            victim->next[level].compare_exchange_strong(mp,
                MarkedPtr<Node>::make(mp.ptr(), true),
                std::memory_order_acq_rel);
        }
    }

    // Bottom level mark is the linearization point of delete
    MarkedPtr<Node> mp = victim->next[0].load(std::memory_order_acquire);
    while (true) {
        if (mp.marked()) return false;  // someone else won
        if (victim->next[0].compare_exchange_strong(mp,
                MarkedPtr<Node>::make(mp.ptr(), true),
                std::memory_order_acq_rel)) {
            find(key, preds, succs);  // triggers physical unlink
            return true;
        }
    }
}
```

Marks propagate top down. Bottom-level mark is the linearization point. After bottom-level mark succeeds, the next `find(key)` will physically unlink the node at every level.

### Memory Reclamation

Skip lists are particularly hostile to hazard pointers because traversal touches log n nodes per operation, each requiring its own protection slot. Two hazards (current, next) are not enough, you need a chain of hazards to validate the path.

The standard production solution is EBR or RCU. The entire `find`, `insert`, or `remove` operation runs inside one pin. The reclaimer waits for a grace period before freeing any unlinked node.

```cpp
bool insert(K key, V value) {
    folly::rcu_reader g;
    // ... full insert logic above ...
}

bool remove(K key) {
    folly::rcu_reader g;
    // ... full remove logic ...
    if (succeeded) {
        folly::rcu_retire(victim);
    }
    return succeeded;
}
```

### Senior at FAANG: Snapshot Iteration

A common interview escalation: how do you iterate the skip list and get a consistent snapshot? Two approaches.

**RCU iteration.** Hold the pin for the entire iteration. Readers see a moment-in-time view that excludes inserts published after the pin and includes deletes whose marks happened before the pin. This is what `ConcurrentSkipListMap.iterator()` does. The downside is that long iterations stall reclamation.

**Versioned snapshot.** Each node carries a version timestamp. Readers iterate at version V, skipping nodes with version > V (inserted later) and including nodes with delete_version > V (still alive at V). Writers update versions atomically. This decouples iteration from reclamation but adds 16 bytes per node.

```cpp
struct VersionedNode {
    K key;
    V value;
    uint64_t insert_version;
    std::atomic<uint64_t> delete_version{UINT64_MAX};
    int top_level;
    std::atomic<MarkedPtr<VersionedNode>> next[kMaxLevel];
};

class SnapshotIterator {
    uint64_t snapshot_version_;
    VersionedNode* curr_;

    void advance() {
        do {
            curr_ = curr_->next[0].load(std::memory_order_acquire).ptr();
        } while (curr_ &&
                 (curr_->insert_version > snapshot_version_ ||
                  curr_->delete_version.load(std::memory_order_acquire) <= snapshot_version_));
    }
};
```

### Level Promotion Races

What if two threads insert nodes with the same key at different levels simultaneously? The bottom-level CAS serializes them: the first one wins, the second one finds a duplicate via `find` and returns false. No special handling is needed because the bottom level is the canonical truth.

What if insert and remove race? The remove marks bottom-level first to win the linearization point. If a concurrent insert tries to replace this node's predecessor's next pointer, it sees the mark and retries with a refreshed `find`, which excludes the dying node.

### Performance

On 16 threads, balanced lookup/insert/delete, 1M keys:

| Skip list | Throughput |
| --- | --- |
| `std::set` + `std::mutex` | 2-3 Mops |
| `std::set` + `std::shared_mutex` (reads only) | 12-18 Mops |
| Fraser-Harris with EBR | 18-28 Mops |
| Java `ConcurrentSkipListMap` (HotSpot) | 22-32 Mops |

The lock-free skip list is the standard implementation for ordered concurrent maps because no other ordered structure scales as well. Lock-free balanced trees (red-black, AVL) exist but are vastly more complex.

### When Skip Lists Lose

Workloads with strong key locality (sequential inserts) hammer the same cache lines on the lower levels. A B-tree with copy-on-write pages handles this better. Bw-Tree (Microsoft Research) is the production answer for ordered concurrent maps with high locality, used in SQL Server's Hekaton and CockroachDB's Pebble engine.

Skip lists also waste memory on the level pointers (around 12-16 bytes per node beyond the payload). For dense ordered maps with small keys and values, B-trees pack more tightly.
