## 78.9 Interview Pitfalls

### Pitfall 1: Confusing Word End vs Prefix in Tries

**Incident Report**: A candidate's trie search returned true for "app" when only "apple" had been inserted. They checked that the path existed, not that it ended a word. Reaching a node only proves the string is a prefix of something inserted, which is what `StartsWith` asks and not what `Search` asks. The `isEnd` flag is the only thing distinguishing the two questions.

```go
// ❌ WRONG: Not checking word boundary
type TrieBad struct {
    children [26]*TrieBad
    // Missing isEnd flag!
}

func (t *TrieBad) Search(word string) bool {
    node := t
    for _, c := range word {
        idx := c - 'a'
        if node.children[idx] == nil {
            return false
        }
        node = node.children[idx]
    }
    return true  // BUG: Returns true for prefixes!
}

// ✅ CORRECT: Track word endings
type TrieGood struct {
    children [26]*TrieGood
    isEnd    bool  // Marks complete word
}

func (t *TrieGood) Insert(word string) {
    node := t
    for _, c := range word {
        idx := c - 'a'
        if node.children[idx] == nil {
            node.children[idx] = &TrieGood{}
        }
        node = node.children[idx]
    }
    node.isEnd = true  // Mark word boundary
}

func (t *TrieGood) Search(word string) bool {
    node := t
    for _, c := range word {
        idx := c - 'a'
        if node.children[idx] == nil {
            return false
        }
        node = node.children[idx]
    }
    return node.isEnd  // Only true if complete word
}
```

### Pitfall 2: Segment Tree Wrong Child Indices

**Incident Report**: A candidate's segment tree gave wrong query results because they mixed the two child-index conventions. They are genuinely different: with the root at 0, children are at `2*i+1` and `2*i+2`, while with the root at 1 they are at `2*i` and `2*i+1`. Using the 1-indexed formulas from a 0-indexed root is the classic error.

The failure mode is worth understanding, because it is not the one people expect. With the root at node 0, `2*node` is also 0, so the root's "left child" is the root itself. You might expect infinite recursion, and it does not happen: the recursion terminates on the *range* `[start, end]`, which shrinks every call regardless of what the node index does. What you get instead is aliasing. Node 0 is written twice, once as the root and once as its own left subtree, and the second write clobbers the first.

Build this tree over `[1, 2, 3, 4]` and query it. The full range returns 10, which is correct. Query `[0, 1]` and it returns 10, when the answer is 3. Query `[0, 0]` and it returns 10, when the answer is 1. The one query most people reach for first is the one that still works, and every narrower query is silently wrong. This is the argument for property-based testing against a brute-force reference over *random* subranges, rather than checking the total and declaring victory.

```go
// ❌ WRONG: Mixed 0-indexed and 1-indexed
type SegTreeBad struct {
    tree []int
}

func (st *SegTreeBad) build(arr []int, node, start, end int) {
    if start == end {
        st.tree[node] = arr[start]
        return
    }
    mid := (start + end) / 2
    // BUG: Wrong child indices for 0-indexed
    st.build(arr, 2*node, start, mid)      // Should be 2*node+1
    st.build(arr, 2*node+1, mid+1, end)    // Should be 2*node+2
    st.tree[node] = st.tree[2*node] + st.tree[2*node+1]
}

// ✅ CORRECT: Consistent 0-indexing
type SegTreeGood struct {
    tree []int
    n    int
}

func NewSegTree(arr []int) *SegTreeGood {
    n := len(arr)
    st := &SegTreeGood{
        tree: make([]int, 4*n),  // 4n is safe upper bound
        n:    n,
    }
    st.build(arr, 0, 0, n-1)
    return st
}

func (st *SegTreeGood) build(arr []int, node, start, end int) {
    if start == end {
        st.tree[node] = arr[start]
        return
    }
    mid := start + (end-start)/2
    leftChild := 2*node + 1   // Consistent 0-indexed
    rightChild := 2*node + 2
    st.build(arr, leftChild, start, mid)
    st.build(arr, rightChild, mid+1, end)
    st.tree[node] = st.tree[leftChild] + st.tree[rightChild]
}
```

### Pitfall 3: Fenwick Tree Off-by-One

**Incident Report**: A candidate's Fenwick tree hung because they indexed it from 0. This is not a style preference. The traversal `i += i & (-i)` advances by the lowest set bit, and 0 has no set bit, so `0 & -0` is 0 and the index never moves. Index 0 is not merely unused in a Fenwick tree, it is unusable, which is why the array is sized `n+1` and every external index is shifted by one on the way in.

```go
// ❌ WRONG: 0-indexed Fenwick tree
type FenwickBad struct {
    tree []int
}

func (f *FenwickBad) Update(i, delta int) {
    for i < len(f.tree) {
        f.tree[i] += delta
        i += i & (-i)  // BUG: When i=0, i & (-i) = 0, infinite loop!
    }
}

// ✅ CORRECT: 1-indexed Fenwick tree
type FenwickGood struct {
    tree []int
}

func NewFenwick(n int) *FenwickGood {
    return &FenwickGood{tree: make([]int, n+1)}  // Index 0 unused
}

func (f *FenwickGood) Update(i, delta int) {
    i++  // Convert to 1-indexed
    for i < len(f.tree) {
        f.tree[i] += delta
        i += i & (-i)  // Works correctly for i >= 1
    }
}

func (f *FenwickGood) PrefixSum(i int) int {
    i++  // Convert to 1-indexed
    sum := 0
    for i > 0 {
        sum += f.tree[i]
        i -= i & (-i)
    }
    return sum
}

func (f *FenwickGood) RangeSum(left, right int) int {
    if left == 0 {
        return f.PrefixSum(right)
    }
    return f.PrefixSum(right) - f.PrefixSum(left-1)
}
```

### Pitfall 4: LRU Cache Not Updating on Get

**Incident Report**: A candidate's LRU cache returned correct values but never updated recency on `Get`, so the list ordered entries by *insertion* time rather than by access time. Every value it returned was right, and it evicted the wrong entries. This is the pitfall most likely to pass a naive test, because correctness of `Get` and correctness of eviction order are separate properties and only the first one is obvious.

```go
// ❌ WRONG: Get doesn't update position
type LRUBad struct {
    cache    map[int]*Node
    head     *Node
    tail     *Node
    capacity int
}

func (l *LRUBad) Get(key int) int {
    if node, ok := l.cache[key]; ok {
        return node.value  // BUG: Doesn't update recency!
    }
    return -1
}

// ✅ CORRECT: Get moves node to front
type LRUGood struct {
    cache    map[int]*DLLNode
    head     *DLLNode  // Dummy head
    tail     *DLLNode  // Dummy tail
    capacity int
}

type DLLNode struct {
    key, value int
    prev, next *DLLNode
}

func (l *LRUGood) Get(key int) int {
    if node, ok := l.cache[key]; ok {
        l.moveToHead(node)  // Update recency!
        return node.value
    }
    return -1
}

func (l *LRUGood) moveToHead(node *DLLNode) {
    l.removeNode(node)
    l.addToHead(node)
}

func (l *LRUGood) removeNode(node *DLLNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (l *LRUGood) addToHead(node *DLLNode) {
    node.prev = l.head
    node.next = l.head.next
    l.head.next.prev = node
    l.head.next = node
}
```

### Pitfall 5: Trie Memory Explosion with Unicode

**Incident Report**: An engineer's autocomplete trie used far more memory than expected because every node carried a fixed 26-pointer array, including the leaves, which have no children at all. Section 78.1 measures this: on a realistic word list the array trie costs roughly 1.3x the map trie, and on dense input the gap widens rather than closing, because leaves dominate the node count and each one pays 208 bytes for slots it never fills. The array buys speed, roughly 1.7x on lookups, and it costs memory. Choose it deliberately, and never on the assumption that a fixed array must be the compact option.

```go
// ❌ WRONG: Fixed array wastes memory
type TrieArrayBad struct {
    children [26]*TrieArrayBad  // 26 pointers even for leaf nodes!
    isEnd    bool
}
// For 100K words, most nodes have 1-2 children but allocate 26 pointers

// ✅ CORRECT: Use map for sparse children
type TrieMapGood struct {
    children map[rune]*TrieMapGood
    isEnd    bool
}

func NewTrieNode() *TrieMapGood {
    return &TrieMapGood{children: make(map[rune]*TrieMapGood)}
}

func (t *TrieMapGood) Insert(word string) {
    node := t
    for _, c := range word {  // Works with Unicode!
        if node.children[c] == nil {
            node.children[c] = NewTrieNode()
        }
        node = node.children[c]
    }
    node.isEnd = true
}

// Even better for production: compressed trie (radix tree)
type RadixNode struct {
    children map[string]*RadixNode  // Store string edges, not single chars
    isEnd    bool
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Missing isEnd flag | Prefixes match as words | Always track word boundaries |
| Wrong child indices | Incorrect query results | Be consistent: 0 or 1 indexed |
| Fenwick 0-index | Infinite loop | Fenwick trees are 1-indexed |
| LRU no update on Get | Wrong eviction order | Move to front on every access |
| Array trie memory | OOM for large datasets | Use maps for sparse children |
| Lazy propagation forgotten | Wrong range updates | Always propagate before query |

---

### Junior → FAANG: Using the Pitfall Table as a Pre-Submission Review

The pitfall table is a 30-second code review you perform before telling the interviewer your solution is complete. For every problem in this chapter, scan the "Prevention" column and verify each point against your code. If you implemented a trie, did you add `node.isEnd = true` in Insert and check `node.isEnd` in Search? If you implemented a segment tree, are all child index calculations consistent? If you implemented a Fenwick tree, does every external index get incremented by 1 before the loop? If you implemented an LRU cache, does every Get call move the node to the front? This takes 30 seconds and prevents the most common class of interview-ending bugs.

### Senior @ FAANG: Pitfalls as Root Cause Categories for Production Incidents

At the senior level, each pitfall maps to a class of production incident. Missing `isEnd` is a correctness bug that returns wrong results silently, which is worse than a crash because it may go undetected in production until a customer reports an incorrect outcome. Wrong segment tree child indices cause incorrect aggregations that corrupt analytics dashboards or billing calculations, again silently. Fenwick 0-index bugs cause infinite loops that manifest as latency spikes and timeouts, which are immediately visible in monitoring but hard to diagnose without knowing the root cause. LRU cache Get without update causes cache thrashing, where frequently accessed items are repeatedly evicted, degrading cache hit rate and increasing backend load. Each of these incident classes has a different detection mechanism: unit tests catch the first two, load tests and latency monitoring catch the third, and cache hit rate dashboards catch the fourth. A staff engineer owning a system that uses any of these structures is responsible for ensuring all four detection mechanisms are in place before the system goes to production. The pitfall table is the checklist for designing those detection mechanisms.
