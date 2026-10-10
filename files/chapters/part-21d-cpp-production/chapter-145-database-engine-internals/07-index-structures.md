## Index Structures: Hash, Skip List, Trie, R-Tree

B+ trees are the default index structure, but they are not always the right choice. Selecting the wrong index structure costs orders of magnitude in performance. This section covers four additional structures: hash indexes for exact-match lookups, skip lists for ordered in-memory storage, tries for string-key workloads, and R-trees for spatial queries.

### Hash Index

A hash index maps a key to its location via a hash function. Point lookups are O(1) average. Range scans are impossible, hashing destroys key ordering. PostgreSQL supports hash indexes (`CREATE INDEX USING hash`), though B-tree is the default because its range scan capability makes it more generally useful.

**Extendible hashing** allows the hash table to grow without a full rehash. It splits individual buckets by doubling the local depth of just that bucket, sharing an array of directory pointers:

```cpp
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

static constexpr size_t BUCKET_CAPACITY = 4;

template <typename K, typename V>
class ExtendibleHashTable {
    struct Bucket {
        int                         local_depth = 1;
        std::vector<std::pair<K,V>> entries;

        bool is_full() const { return entries.size() >= BUCKET_CAPACITY; }

        std::optional<V> find(const K& key) const {
            for (auto& [k, v] : entries) {
                if (k == key) return v;
            }
            return std::nullopt;
        }

        bool insert(const K& key, const V& value) {
            for (auto& [k, v] : entries) {
                if (k == key) { v = value; return true; }
            }
            if (is_full()) return false;
            entries.emplace_back(key, value);
            return true;
        }
    };

    int                                  global_depth_ = 1;
    std::vector<std::shared_ptr<Bucket>> directory_;  // 2^global_depth entries
    std::hash<K>                         hasher_;

    size_t bucket_index(const K& key) const {
        size_t hash = hasher_(key);
        size_t mask = (1ULL << global_depth_) - 1;
        return hash & mask;
    }

    void split(size_t idx) {
        auto old_bucket = directory_[idx];
        int  new_depth  = old_bucket->local_depth + 1;

        if (new_depth > global_depth_) {
            // Double the directory
            size_t old_size = directory_.size();
            directory_.resize(old_size * 2);
            for (size_t i = 0; i < old_size; ++i) {
                directory_[old_size + i] = directory_[i];
            }
            ++global_depth_;
        }

        auto new_bucket = std::make_shared<Bucket>();
        new_bucket->local_depth = new_depth;
        old_bucket->local_depth = new_depth;

        // Rehash existing entries between old and new buckets
        auto old_entries = old_bucket->entries;
        old_bucket->entries.clear();

        size_t new_mask = (1ULL << new_depth) - 1;
        size_t split_bit = 1ULL << (new_depth - 1);

        // Update directory pointers
        for (size_t i = 0; i < directory_.size(); ++i) {
            if (directory_[i] == old_bucket) {
                if (i & split_bit) directory_[i] = new_bucket;
            }
        }

        // Redistribute entries
        for (auto& [k, v] : old_entries) {
            size_t h   = hasher_(k) & new_mask;
            size_t dst = h & (directory_.size() - 1);
            directory_[dst]->insert(k, v);
        }
    }

public:
    ExtendibleHashTable() {
        directory_.resize(2);
        directory_[0] = std::make_shared<Bucket>();
        directory_[1] = std::make_shared<Bucket>();
    }

    void insert(const K& key, const V& value) {
        size_t idx    = bucket_index(key);
        auto&  bucket = directory_[idx];
        if (!bucket->insert(key, value)) {
            split(idx);
            insert(key, value);  // retry after split
        }
    }

    std::optional<V> find(const K& key) const {
        return directory_[bucket_index(key)]->find(key);
    }
};
```

### Skip List

A skip list is a probabilistic data structure that provides O(log N) average-case for insert, find, and delete, with a sorted iteration order. It is simpler to implement than a balanced BST (no rotations) and naturally supports concurrent access with fine-grained locking or lock-free CAS.

LevelDB and RocksDB use a skip list for the memtable. Redis uses a skip list for its sorted sets (`ZADD`, `ZRANGE`).

```cpp
#include <climits>
#include <random>

static constexpr int MAX_LEVEL = 16;
static constexpr float SKIP_P  = 0.5f;

template <typename K, typename V>
class SkipList {
    struct Node {
        K                         key;
        V                         value;
        std::vector<Node*>        forward;  // forward[i] = next node at level i

        Node(const K& k, const V& v, int level)
            : key(k), value(v), forward(level + 1, nullptr) {}
    };

    Node*                   head_;     // sentinel header node
    int                     level_ = 0;
    size_t                  size_  = 0;
    std::mt19937            rng_{std::random_device{}()};

    int random_level() {
        int lvl = 0;
        std::uniform_real_distribution<float> dist(0.0f, 1.0f);
        while (dist(rng_) < SKIP_P && lvl < MAX_LEVEL) ++lvl;
        return lvl;
    }

public:
    SkipList() {
        // Sentinel: key is minimum possible value
        head_ = new Node(std::numeric_limits<K>::min(), V{}, MAX_LEVEL);
    }

    ~SkipList() {
        Node* cur = head_;
        while (cur) {
            Node* next = cur->forward[0];
            delete cur;
            cur = next;
        }
    }

    void insert(const K& key, const V& value) {
        std::vector<Node*> update(MAX_LEVEL + 1);
        Node* cur = head_;

        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key) {
                cur = cur->forward[i];
            }
            update[i] = cur;
        }
        cur = cur->forward[0];

        if (cur && cur->key == key) {
            cur->value = value;  // update existing
            return;
        }

        int new_level = random_level();
        if (new_level > level_) {
            for (int i = level_ + 1; i <= new_level; ++i) {
                update[i] = head_;
            }
            level_ = new_level;
        }

        Node* new_node = new Node(key, value, new_level);
        for (int i = 0; i <= new_level; ++i) {
            new_node->forward[i]    = update[i]->forward[i];
            update[i]->forward[i]  = new_node;
        }
        ++size_;
    }

    std::optional<V> find(const K& key) const {
        Node* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key) {
                cur = cur->forward[i];
            }
        }
        cur = cur->forward[0];
        if (cur && cur->key == key) return cur->value;
        return std::nullopt;
    }

    bool erase(const K& key) {
        std::vector<Node*> update(MAX_LEVEL + 1);
        Node* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < key)
                cur = cur->forward[i];
            update[i] = cur;
        }
        cur = cur->forward[0];
        if (!cur || cur->key != key) return false;

        for (int i = 0; i <= level_; ++i) {
            if (update[i]->forward[i] != cur) break;
            update[i]->forward[i] = cur->forward[i];
        }
        delete cur;
        --size_;
        return true;
    }

    // Range scan: collect all [low, high] key-value pairs in sorted order
    std::vector<std::pair<K,V>> range_scan(const K& low, const K& high) const {
        std::vector<std::pair<K,V>> result;
        Node* cur = head_;
        for (int i = level_; i >= 0; --i) {
            while (cur->forward[i] && cur->forward[i]->key < low)
                cur = cur->forward[i];
        }
        cur = cur->forward[0];
        while (cur && cur->key <= high) {
            result.emplace_back(cur->key, cur->value);
            cur = cur->forward[0];
        }
        return result;
    }

    size_t size() const { return size_; }
};
```

### Trie and ART (Adaptive Radix Tree)

A trie (prefix tree) indexes string keys character-by-character. Every prefix of a key corresponds to a path from root to a node. This enables prefix scans (`WHERE name LIKE 'Jo%'`) in O(prefix_length) time, independent of the number of keys.

The main weakness of naive tries is memory: a node with one character-per-level has 256 children (one per byte), almost all null. The **Adaptive Radix Tree (ART)**, published by Leis et al. In 2013 and used in HyPer and the Linux kernel's IP routing table, uses four node types sized to the actual fanout:

```cpp
enum class ArtNodeType { Node4, Node16, Node48, Node256 };

// Node4: stores up to 4 children - linear search (SIMD on 4 bytes is free)
struct ArtNode4 {
    ArtNodeType type = ArtNodeType::Node4;
    uint8_t     num_children = 0;
    uint8_t     keys[4];
    void*       children[4];  // ArtNode* or leaf pointer
};

// Node16: up to 16 children - SIMD comparison with _mm_cmpeq_epi8
struct ArtNode16 {
    ArtNodeType type = ArtNodeType::Node16;
    uint8_t     num_children = 0;
    uint8_t     keys[16];
    void*       children[16];
};

// Node48: up to 48 children - 256-byte index array maps byte → slot
struct ArtNode48 {
    ArtNodeType type = ArtNodeType::Node48;
    uint8_t     num_children = 0;
    uint8_t     index[256];  // index[byte] = slot in children[], 0xFF = absent
    void*       children[48];
};

// Node256: full 256-way branching - O(1) child lookup
struct ArtNode256 {
    ArtNodeType type = ArtNodeType::Node256;
    uint16_t    num_children = 0;
    void*       children[256];  // children[byte] = ArtNode* or leaf
};
```

ART adapts node types dynamically: a Node4 grows to Node16 when it has 4 children. Node16 to Node48 at 16 children. Node48 to Node256 at 48 children. This achieves near-optimal memory usage while maintaining O(key_length) lookup.

### R-Tree: Spatial Indexing

An R-tree indexes multi-dimensional data by grouping nearby objects into Minimum Bounding Rectangles (MBRs). Used by PostGIS, SQLite's SpatiaLite, and any GIS system.

```cpp
struct MBR {
    double min_x, min_y, max_x, max_y;

    bool contains(double x, double y) const {
        return x >= min_x && x <= max_x && y >= min_y && y <= max_y;
    }

    bool overlaps(const MBR& other) const {
        return !(other.min_x > max_x || other.max_x < min_x ||
                 other.min_y > max_y || other.max_y < min_y);
    }

    double area() const {
        return (max_x - min_x) * (max_y - min_y);
    }

    MBR merge(const MBR& other) const {
        return {std::min(min_x, other.min_x), std::min(min_y, other.min_y),
                std::max(max_x, other.max_x), std::max(max_y, other.max_y)};
    }
};

struct RTreeNode {
    MBR                      mbr;
    bool                     is_leaf;
    int                      record_id = -1;      // leaf: ID of stored record
    std::vector<RTreeNode*>  children;
};

// R-tree search: find all nodes whose MBR overlaps the query rectangle
void rtree_search(RTreeNode* node, const MBR& query,
                  std::vector<int>& results)
{
    if (!node->mbr.overlaps(query)) return;

    if (node->is_leaf) {
        results.push_back(node->record_id);
        return;
    }
    for (RTreeNode* child : node->children) {
        rtree_search(child, query, results);
    }
}
```

R-tree insertion uses the "minimum area enlargement" heuristic: when inserting a new MBR, choose the subtree whose containing MBR needs the smallest enlargement to accommodate it. Node overflow triggers a split (quadratic or linear split algorithm).

### Choosing the Right Index Structure

| Workload | Best Structure | Why |
|---|---|---|
| Point lookup only | Hash index | O(1) average |
| Range scan, sorted order | B+ tree | Sorted leaves, log_B depth |
| In-memory ordered structure | Skip list | Simple, concurrent |
| String prefix queries | Trie / ART | O(key_len) regardless of N |
| Spatial / geo queries | R-tree | MBR overlap, 2D range |
| Time-series, append-only | LSM tree | Sequential writes |

### Go Comparison

`github.com/google/btree` provides an in-memory B-tree with generics support. For skip lists, there is no standard library equivalent, most Go projects implement them inline (CockroachDB's interval tree is skip-list-based). The ART has a pure-Go implementation at `github.com/plar/go-adaptive-radix-tree`. For spatial queries in Go, `github.com/tidwall/rtree` provides an R-tree. Redis's sorted set, accessible from Go via `go-redis`, uses a skip list internally for O(log N) range operations.

---
