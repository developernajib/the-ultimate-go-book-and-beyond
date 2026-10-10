## 70.8 Company Case Studies

### MongoDB: B-Tree Index Implementation

MongoDB uses B-trees for efficient index lookups:

```go
// MongoDB-style B-tree index for database queries
package btree

import (
    "bytes"
    "sync"
)

const (
    minDegree = 64  // Optimized for disk page size
)

// BTreeNode represents a B-tree node
type BTreeNode struct {
    keys     []IndexKey
    children []*BTreeNode
    isLeaf   bool
    n        int  // Current number of keys
}

type IndexKey struct {
    Key      []byte
    Value    []byte  // Pointer to document
    DocID    string
}

// BTree implements MongoDB-style index
type BTree struct {
    root   *BTreeNode
    degree int
    mu     sync.RWMutex
}

// Search finds a key in the B-tree
// Time: O(log n) with disk-optimized branching factor
func (t *BTree) Search(key []byte) (*IndexKey, bool) {
    t.mu.RLock()
    defer t.mu.RUnlock()
    return t.searchNode(t.root, key)
}

func (t *BTree) searchNode(node *BTreeNode, key []byte) (*IndexKey, bool) {
    if node == nil {
        return nil, false
    }

    // Binary search within node
    i := t.findKeyIndex(node, key)

    if i < node.n && bytesEqual(node.keys[i].Key, key) {
        return &node.keys[i], true
    }

    if node.isLeaf {
        return nil, false
    }

    return t.searchNode(node.children[i], key)
}

// RangeQuery returns all keys in range [start, end]
func (t *BTree) RangeQuery(start, end []byte) []IndexKey {
    t.mu.RLock()
    defer t.mu.RUnlock()

    var result []IndexKey
    t.rangeSearch(t.root, start, end, &result)
    return result
}

func (t *BTree) rangeSearch(node *BTreeNode, start, end []byte, result *[]IndexKey) {
    if node == nil {
        return
    }

    i := 0
    for i < node.n && bytesCompare(node.keys[i].Key, start) < 0 {
        i++
    }

    for i < node.n && bytesCompare(node.keys[i].Key, end) <= 0 {
        if !node.isLeaf {
            t.rangeSearch(node.children[i], start, end, result)
        }
        *result = append(*result, node.keys[i])
        i++
    }

    if !node.isLeaf {
        t.rangeSearch(node.children[i], start, end, result)
    }
}

func (t *BTree) findKeyIndex(node *BTreeNode, key []byte) int {
    lo, hi := 0, node.n
    for lo < hi {
        mid := (lo + hi) / 2
        if bytesCompare(node.keys[mid].Key, key) < 0 {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}

// Byte-slice ordering comes straight from the standard library. bytes.Compare
// returns -1, 0, or +1 under the same lexicographic rule a hand-rolled loop
// would implement, and it is assembly-optimized on the platforms that matter.
// Reimplementing it by hand is how you end up with a comparator that ends in
// `return len(a) - len(b)`, which is a subtraction masquerading as a comparison.
// That habit is harmless for lengths and genuinely unsafe for arbitrary
// integers, where `a - b` overflows and flips the sign. Reach for bytes.Compare
// and cmp.Compare rather than writing the subtraction.

func bytesEqual(a, b []byte) bool {
    return bytes.Equal(a, b)
}

func bytesCompare(a, b []byte) int {
    return bytes.Compare(a, b)
}
```

### Git: Merkle Tree for Content Addressing

Git really does store your repository as trees: commits point to tree objects, which point to blobs and further trees, and content addressing via hashes makes the whole structure a Merkle tree:

```go
// Git-style merkle tree for content-addressed storage
package git

import (
    "crypto/sha1"
    "encoding/hex"
    "sort"
)

// TreeEntry represents a file or directory in git
type TreeEntry struct {
    Mode string  // "100644" for file, "040000" for directory
    Name string
    Hash string
}

// GitTree represents a directory
type GitTree struct {
    Entries []TreeEntry
    hash    string
}

// ComputeHash hashes this tree's entries, illustrating the Merkle property:
// a node's hash covers its children's hashes, so any change anywhere below
// propagates upward.
//
// This is Git-shaped, not Git-exact. Real Git prefixes the object with a
// header ("tree <byte-length>\x00") before hashing, so these digests will not
// match `git hash-object`. Real Git also does not use plain SHA-1: it uses
// SHA-1DC, a hardened variant that detects the SHAttered collision attack, and
// newer repositories can opt into SHA-256 entirely. Never pick bare SHA-1 for
// a new content-addressed system. Use SHA-256 or BLAKE3.
func (t *GitTree) ComputeHash() string {
    if t.hash != "" {
        return t.hash
    }

    // Sort entries by name (git requirement)
    sort.Slice(t.Entries, func(i, j int) bool {
        return t.Entries[i].Name < t.Entries[j].Name
    })

    h := sha1.New()
    for _, entry := range t.Entries {
        h.Write([]byte(entry.Mode + " " + entry.Name + "\x00"))
        hashBytes, _ := hex.DecodeString(entry.Hash)
        h.Write(hashBytes)
    }

    t.hash = hex.EncodeToString(h.Sum(nil))
    return t.hash
}

// CommitTree represents a complete commit tree
type CommitTree struct {
    root     *GitTree
    objects  map[string]any  // Object store
}

// Diff finds differences between two trees
func (c *CommitTree) Diff(other *CommitTree) []DiffEntry {
    var diffs []DiffEntry
    c.diffTrees(c.root, other.root, "", &diffs)
    return diffs
}

type DiffEntry struct {
    Path   string
    Type   string  // "added", "deleted", "modified"
    OldHash string
    NewHash string
}

// diffTrees compares the entries of ONE directory level. It reports a changed
// subdirectory as a single "modified" entry rather than descending into it,
// because a TreeEntry stores only a child's hash and resolving that hash back
// into a GitTree requires the object store (the unused `objects` map above).
// A complete implementation looks up e1.Hash and e2.Hash, and recurses when
// both resolve to trees. See the critique below for the short-circuit that
// makes such a recursion fast.
func (c *CommitTree) diffTrees(t1, t2 *GitTree, path string, diffs *[]DiffEntry) {
    // Equal hashes mean identical subtrees: the whole comparison is skippable.
    // This is the entire point of a Merkle tree.
    if t1 != nil && t2 != nil && t1.ComputeHash() == t2.ComputeHash() {
        return
    }

    m1 := makeEntryMap(t1)
    m2 := makeEntryMap(t2)

    // Find deleted and modified
    for name, e1 := range m1 {
        fullPath := path + "/" + name
        if e2, exists := m2[name]; exists {
            if e1.Hash != e2.Hash {
                *diffs = append(*diffs, DiffEntry{
                    Path:    fullPath,
                    Type:    "modified",
                    OldHash: e1.Hash,
                    NewHash: e2.Hash,
                })
            }
        } else {
            *diffs = append(*diffs, DiffEntry{
                Path:    fullPath,
                Type:    "deleted",
                OldHash: e1.Hash,
            })
        }
    }

    // Find added
    for name, e2 := range m2 {
        if _, exists := m1[name]; !exists {
            *diffs = append(*diffs, DiffEntry{
                Path:    path + "/" + name,
                Type:    "added",
                NewHash: e2.Hash,
            })
        }
    }
}

func makeEntryMap(t *GitTree) map[string]TreeEntry {
    m := make(map[string]TreeEntry)
    if t != nil {
        for _, e := range t.Entries {
            m[e.Name] = e
        }
    }
    return m
}
```

### Junior -> FAANG: Learning from Production Tree Applications

The MongoDB B-tree index and Git Merkle tree examples show that the tree algorithms from interview problems are not toy exercises. They are the foundations of systems you use daily.

From the MongoDB B-tree: notice that the search is binary search within each node (`findKeyIndex`) rather than linear scan. This is because B-tree nodes hold many keys (minDegree = 64, so up to 127 keys per node), and binary search reduces the in-node search from O(degree) to O(log degree). The range query (`rangeSearch`) uses the BST ordering property to prune subtrees below the lower bound, exactly as in RangeSumBST but generalized to byte-string keys.

From the Git Merkle tree: the `Diff` function is a two-tree comparison that builds hash maps of each tree's entries, then finds additions, deletions, and modifications in O(n) time (where n is the number of files). This is exactly the set-difference pattern from chapter 69, applied to tree nodes. The SHA-1 hash of a tree entry is computed bottom-up (postorder): file hashes first, then directory hashes that incorporate child hashes.

### Senior @ FAANG: Production-Level Critique and Extension

The MongoDB B-tree implementation has a critical production gap: no write operations (insert, split, merge). B-tree insert requires splitting full nodes before descending (proactive split) or after the fact (reactive split). The split operation is the most complex part of a B-tree: a full node with 2t-1 keys is split into two nodes with t-1 keys each, and the median key is promoted to the parent. Implementing splits correctly under concurrent access, where multiple goroutines may be descending the tree simultaneously, requires careful locking: the standard approach is crabbing (lock the child before releasing the parent, verify the child will not need splitting, then release the parent lock).

The Git Merkle tree code carries the single most important optimization in the design, and it is worth understanding why one comparison replaces an unbounded amount of work. If `t1.ComputeHash() == t2.ComputeHash()`, the two subtrees are identical all the way down, because a tree's hash is computed from its children's hashes. One 20-byte comparison prunes an entire directory subtree. That is what makes `git status` fast in a repository with hundreds of thousands of files: nearly every directory hashes equal and is dismissed instantly, and the work becomes proportional to what changed rather than to what exists. The same property is why Cassandra's anti-entropy repair and IPFS can compare replicas over a network by exchanging a handful of hashes instead of streaming entire datasets.

Note also what the code above does *not* do: it compares one directory level and reports a changed subdirectory as a single "modified" entry rather than recursing into it. Descending requires resolving a `TreeEntry.Hash` back into a `GitTree` through the object store, which is exactly what the unused `objects` map is for. Read that as a reminder that a struct field with no readers is usually an unfinished feature rather than dead weight.

At the staff level, the design question for any tree-based storage system is: "What is the rebalancing strategy under concurrent writes, and what latency guarantees does it provide?" B-trees use node splitting during writes, which is O(log n) amortized but can cause cascading splits up to the root in degenerate cases. LSM trees (used in LevelDB, RocksDB, and Go's `pebble`) avoid in-place balancing entirely by writing new data sequentially to a log and compacting periodically, trading random-write performance for sequential-write throughput. The choice between B-tree and LSM-tree is a fundamental storage ADR decision.

---
