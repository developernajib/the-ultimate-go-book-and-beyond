## B-Tree and B+ Tree Implementations

The B-tree was invented by Rudolf Bayer and Edward McCreight at Boeing Research Labs in 1970 to address a problem that is still the dominant constraint in storage systems: disk I/O is orders of magnitude slower than RAM access. A binary search tree with N nodes requires O(log₂ N) disk reads. With one million keys, that is twenty disk reads per lookup. A B-tree with branching factor 1000 requires O(log₁₀₀₀ N) reads, for the same million keys, just two. The entire trick is fitting a large node into one disk page.

### B-Tree vs B+ Tree

A pure B-tree stores key-value pairs in both interior and leaf nodes. A B+ tree stores data only in leaf nodes. Interior nodes contain only keys used for routing. PostgreSQL, MySQL InnoDB, SQLite, they all use B+ trees for secondary indexes. The advantages over a B-tree are significant:

- Interior nodes can hold more keys (no value storage), increasing branching factor and decreasing tree height.
- Range scans are efficient: leaves form a doubly-linked list. After finding the start key via root-to-leaf traversal, you walk the leaf chain horizontally.
- Leaf scans are sequential disk reads, which are fast on both spinning disks and SSDs.

### Node Structure

The critical insight is that `ORDER` should be chosen so that a node fits exactly one disk page, typically 4 KB for OS pages or 8 KB/16 KB for database pages. PostgreSQL uses 8 KB pages. InnoDB uses 16 KB.

```cpp
#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <vector>

// ORDER = minimum degree (t in CLRS). A node holds [t-1, 2t-1] keys.
// For a 4KB page with 8-byte keys and 8-byte values: ORDER ~ 170.
// Here we use ORDER=3 for demonstration.
static constexpr int ORDER = 3;
static constexpr int MAX_KEYS = 2 * ORDER - 1;  // 5
static constexpr int MIN_KEYS = ORDER - 1;       // 2

using Key   = int64_t;
using Value = int64_t;

struct BPlusNode {
    bool is_leaf;
    int  num_keys;
    std::array<Key,   MAX_KEYS>     keys;
    std::array<Value, MAX_KEYS>     values;   // used only in leaf nodes
    std::array<BPlusNode*, ORDER*2> children; // used only in internal nodes
    BPlusNode* next_leaf = nullptr;           // leaf chain pointer

    explicit BPlusNode(bool leaf)
        : is_leaf(leaf), num_keys(0)
    {
        children.fill(nullptr);
    }
};
```

### Search: O(log_B N) Disk Reads

B+ tree search traverses interior nodes using binary search to select the correct child pointer, reading exactly one node per tree level until reaching a leaf. With a branching factor B of 100-1000, a tree holding a billion records has at most 3-4 levels, meaning a point lookup requires only 3-4 disk reads, the core reason B+ trees dominate on-disk index implementations in every major database engine.
```cpp
std::optional<Value> search(BPlusNode* root, Key key) {
    BPlusNode* node = root;

    while (!node->is_leaf) {
        // Binary search for the correct child pointer
        int i = 0;
        while (i < node->num_keys && key >= node->keys[i]) {
            ++i;
        }
        node = node->children[i];
    }

    // Now at a leaf node: binary search for the key
    for (int i = 0; i < node->num_keys; ++i) {
        if (node->keys[i] == key) {
            return node->values[i];
        }
    }
    return std::nullopt;
}
```

### Insertion with Node Splitting

When a node overflows (reaches `MAX_KEYS + 1` keys), it splits at the median key. The median is promoted to the parent. This is the fundamental property that keeps the tree balanced.

```cpp
// Split the i-th child of 'parent', which is full.
// After split: parent->children[i] has t-1 keys,
//              parent->children[i+1] (new node) has t-1 keys,
//              parent->keys[i] receives the median.
void split_child(BPlusNode* parent, int i, BPlusNode* child) {
    auto* sibling = new BPlusNode(child->is_leaf);
    sibling->num_keys = ORDER - 1;

    // Copy the upper half of child's keys/values to sibling
    for (int j = 0; j < ORDER - 1; ++j) {
        sibling->keys[j] = child->keys[j + ORDER];
        if (child->is_leaf) {
            sibling->values[j] = child->values[j + ORDER];
        }
    }
    if (!child->is_leaf) {
        for (int j = 0; j < ORDER; ++j) {
            sibling->children[j] = child->children[j + ORDER];
        }
    }

    // In B+ tree: leaf nodes keep the median - internal nodes promote it
    Key median = child->keys[ORDER - 1];
    if (child->is_leaf) {
        child->num_keys = ORDER;         // leaf keeps median
    } else {
        child->num_keys = ORDER - 1;     // internal node loses median
    }

    // Link leaves for range scan
    if (child->is_leaf) {
        sibling->next_leaf = child->next_leaf;
        child->next_leaf   = sibling;
    }

    // Shift parent's children and keys to make room
    for (int j = parent->num_keys; j >= i + 1; --j) {
        parent->children[j + 1] = parent->children[j];
    }
    parent->children[i + 1] = sibling;

    for (int j = parent->num_keys - 1; j >= i; --j) {
        parent->keys[j + 1] = parent->keys[j];
    }
    parent->keys[i] = median;
    ++parent->num_keys;
}

void insert_non_full(BPlusNode* node, Key key, Value value) {
    int i = node->num_keys - 1;

    if (node->is_leaf) {
        // Shift keys right to find insert position
        while (i >= 0 && node->keys[i] > key) {
            node->keys[i + 1]   = node->keys[i];
            node->values[i + 1] = node->values[i];
            --i;
        }
        node->keys[i + 1]   = key;
        node->values[i + 1] = value;
        ++node->num_keys;
    } else {
        // Find the right child
        while (i >= 0 && node->keys[i] > key) --i;
        ++i;

        if (node->children[i]->num_keys == MAX_KEYS) {
            split_child(node, i, node->children[i]);
            if (node->keys[i] <= key) ++i;
        }
        insert_non_full(node->children[i], key, value);
    }
}

class BPlusTree {
    BPlusNode* root_;

public:
    BPlusTree() : root_(new BPlusNode(true)) {}

    void insert(Key key, Value value) {
        if (root_->num_keys == MAX_KEYS) {
            // Root is full: create a new root and split
            auto* new_root = new BPlusNode(false);
            new_root->children[0] = root_;
            split_child(new_root, 0, root_);
            root_ = new_root;
        }
        insert_non_full(root_, key, value);
    }

    std::optional<Value> search(Key key) const {
        return ::search(root_, key);
    }

    // Range scan: [low, high] inclusive
    std::vector<std::pair<Key, Value>> range_scan(Key low, Key high) const {
        std::vector<std::pair<Key, Value>> result;

        // Walk to the leaf containing 'low'
        BPlusNode* node = root_;
        while (!node->is_leaf) {
            int i = 0;
            while (i < node->num_keys && low >= node->keys[i]) ++i;
            node = node->children[i];
        }

        // Walk leaf chain collecting keys in [low, high]
        while (node != nullptr) {
            for (int i = 0; i < node->num_keys; ++i) {
                if (node->keys[i] > high) return result;
                if (node->keys[i] >= low) {
                    result.emplace_back(node->keys[i], node->values[i]);
                }
            }
            node = node->next_leaf;
        }
        return result;
    }
};
```

### Range Scan in Action

Range scans in a B+ tree use a single point lookup to find the first leaf containing the start key, then walk the leaf-level linked list to collect all records up to the end key. This leaf-chaining property means range queries are O(log N + K) where K is the result count, rather than requiring separate lookups for each key, the defining advantage of B+ trees over hash indexes for range and prefix queries.
```cpp
int main() {
    BPlusTree tree;

    for (int i = 1; i <= 20; ++i) {
        tree.insert(i * 10, i * 100);  // keys: 10,20,...,200
    }

    auto result = tree.range_scan(50, 120);
    for (auto& [k, v] : result) {
        std::cout << k << " -> " << v << "\n";
        // 50 -> 500, 60 -> 600, ..., 120 -> 1200
    }

    auto val = tree.search(80);
    assert(val.has_value() && *val == 800);
}
```

### Why ORDER Matters in Production

In a real database, `ORDER` is not 3, it is calculated from the page size:

```
ORDER = floor((page_size - header_size) / (key_size + pointer_size))

For PostgreSQL 8KB pages with 8-byte keys and 6-byte pointers:
ORDER = floor((8192 - 64) / (8 + 6)) = ~578
```

A B+ tree of order 578 covering one billion rows has height = ceil(log₅₇₈(1,000,000,000)) = 2. The root and one level of interior nodes fit in RAM permanently. Almost every lookup is one disk read (the leaf page). This is why PostgreSQL index scans are fast even on huge tables.

PostgreSQL's actual B-tree implementation (`src/backend/access/nbtree/`) adds: WAL logging of every page modification, page-level locking with `LockBuffer()`, page recycling through the free-space map, and the `fillfactor` parameter that controls how full leaf pages are packed at build time to leave room for future inserts.

### Go Comparison

Go's built-in `map` is a hash table, O(1) point lookups but no ordering and no range scans. The `github.com/google/btree` package provides an in-memory B-tree with ordered iteration, and `go.etcd.io/bbolt` is a full B+ tree implementation for on-disk storage used by etcd. bbolt aligns node sizes to OS memory pages and uses `mmap` rather than a buffer pool, a different trade-off that we examine in the buffer pool chapter.

---
