## 78.7 Common Mistakes

### Mistake 1: Memory Leak in Trie (Not Cleaning Up)

Simply clearing the `isEnd` flag when deleting a word leaves every node on its path allocated, so a long-running trie that inserts and deletes grows without bound even while its logical contents stay small. The fix is a recursive helper returning whether the node it examined is now safe to remove, so deletions propagate back up the path but stop the moment a branch still has children or still marks another word's end.

Note that the `GoodTrie` below converts to `[]rune` before recursing, for the reason Section 78.1 covers: children are keyed by rune, and indexing a string yields bytes. The two agree for ASCII and diverge silently for everything else.

```go
// BAD: Deleting word doesn't free memory
type BadTrie struct {
    children map[rune]*BadTrie
    isEnd    bool
}

func (t *BadTrie) Delete(word string) {
    node := t
    for _, ch := range word {
        if node.children[ch] == nil {
            return
        }
        node = node.children[ch]
    }
    node.isEnd = false // Only marks as not end, nodes remain!
}

// GOOD: Properly clean up empty branches
type GoodTrie struct {
    children map[rune]*GoodTrie
    isEnd    bool
}

func (t *GoodTrie) Delete(word string) bool {
    // []rune, not the raw string: children are keyed by rune, and
    // indexing a string yields bytes. See Section 78.1.
    return t.deleteHelper([]rune(word), 0)
}

func (t *GoodTrie) deleteHelper(word []rune, index int) bool {
    if index == len(word) {
        if !t.isEnd {
            return false // Word doesn't exist
        }
        t.isEnd = false
        return len(t.children) == 0 // Can delete this node if no children
    }

    ch := word[index]
    child := t.children[ch]
    if child == nil {
        return false
    }

    shouldDeleteChild := child.deleteHelper(word, index+1)
    if shouldDeleteChild {
        delete(t.children, ch) // Clean up unused branch
    }

    return !t.isEnd && len(t.children) == 0
}
```

### Mistake 2: Off-by-One in Segment Tree Indexing

Segment trees can use either 1-based or 0-based child indexing, but mixing the two conventions within the same implementation corrupts the tree structure silently. In 0-based indexing, node `k` has children at `2k+1` and `2k+2`, while 1-based indexing places them at `2k` and `2k+1`. Consistency across build, query, and update functions is essential.

```go
// BAD: Inconsistent indexing
func badBuild(tree, arr []int, node, start, end int) {
    if start == end {
        tree[node] = arr[start]
        return
    }
    mid := (start + end) / 2
    badBuild(tree, arr, node*2, start, mid)     // Wrong: should be 2*node+1
    badBuild(tree, arr, node*2+1, mid+1, end)   // Wrong: should be 2*node+2
    tree[node] = tree[node*2] + tree[node*2+1]
}

// GOOD: Consistent 0-indexed children
func goodBuild(tree, arr []int, node, start, end int) {
    if start == end {
        tree[node] = arr[start]
        return
    }
    mid := (start + end) / 2
    leftChild := 2*node + 1
    rightChild := 2*node + 2
    goodBuild(tree, arr, leftChild, start, mid)
    goodBuild(tree, arr, rightChild, mid+1, end)
    tree[node] = tree[leftChild] + tree[rightChild]
}
```

### Mistake 3: Forgetting Lazy Propagation Push Down

Lazy propagation defers range updates by storing pending increments at internal nodes, but those deferred values must be pushed to children before any query traverses deeper, otherwise the query reads stale values. The `pushDown` call must appear at the very top of any query or update function, before the range checks, to guarantee all ancestor updates are applied before accessing child subtrees.

```go
// BAD: Query without pushing lazy values
func badRangeQuery(tree, lazy []int, node, start, end, l, r int) int {
    if start > r || end < l {
        return 0
    }
    if l <= start && end <= r {
        return tree[node] // Wrong! Lazy value not applied
    }
    mid := (start + end) / 2
    return badRangeQuery(tree, lazy, 2*node+1, start, mid, l, r) +
           badRangeQuery(tree, lazy, 2*node+2, mid+1, end, l, r)
}

// GOOD: Always push down before query
func goodRangeQuery(tree, lazy []int, node, start, end, l, r int) int {
    pushDown(tree, lazy, node, start, end) // Push lazy values first!

    if start > r || end < l {
        return 0
    }
    if l <= start && end <= r {
        return tree[node]
    }
    mid := (start + end) / 2
    return goodRangeQuery(tree, lazy, 2*node+1, start, mid, l, r) +
           goodRangeQuery(tree, lazy, 2*node+2, mid+1, end, l, r)
}

func pushDown(tree, lazy []int, node, start, end int) {
    if lazy[node] != 0 {
        tree[node] += lazy[node] * (end - start + 1)
        if start != end {
            lazy[2*node+1] += lazy[node]
            lazy[2*node+2] += lazy[node]
        }
        lazy[node] = 0
    }
}
```

### Mistake 4: Fenwick Tree 0-Index Confusion

Fenwick (Binary Indexed) trees rely on the `i & (-i)` operation to isolate the lowest set bit for parent and child traversal, but this expression evaluates to zero when `i` is zero, creating an infinite loop. The tree must be allocated with a size of `n+1` and all external indices must be incremented by one before any internal operation. Wrapping this conversion inside a struct method prevents the bug from surfacing in caller code.

```go
// BAD: Using 0-based indexing
func badFenwickUpdate(tree []int, i, delta int) {
    for i < len(tree) {
        tree[i] += delta
        i += i & (-i) // Wrong! When i=0, this loops forever
    }
}

// GOOD: Fenwick trees must be 1-indexed
func goodFenwickUpdate(tree []int, i, delta int) {
    i++ // Convert to 1-indexed
    for i < len(tree) {
        tree[i] += delta
        i += i & (-i)
    }
}

// Or use wrapper that handles conversion
type FenwickTree struct {
    tree []int
}

func (ft *FenwickTree) Update(i, delta int) {
    i++ // Internal 1-indexing
    for i < len(ft.tree) {
        ft.tree[i] += delta
        i += i & (-i)
    }
}
```

### Mistake 5: Wrong Tree Size Allocation

A segment tree for `n` elements is not a perfect binary tree, so allocating only `2n` nodes is insufficient and causes out-of-bounds writes during construction. The safe rule is `4n`. Alternatively, round `n` up to the next power of two and double that.

The smallest counterexample is worth memorizing, because "2n nodes for n leaves" sounds right and the failure is a panic rather than a wrong answer. At `n = 6`, the recursive build with children at `2k+1` and `2k+2` reaches node index 12, so it needs a slice of length 13 while `2n` is only 12. It writes past the end and panics. The reason is that splitting `[0, 5]` at the midpoint yields subtrees of unequal shape, and the deeper branch pushes indices past the `2n` bound that a perfect tree would respect.

Both stated bounds hold. Sweeping every `n` up to a few thousand, `2*nextPow2(n)` and `4n` are each always sufficient, while `2n` fails for almost every `n` above 5. The `4n` rule is also not as loose as it looks: the true requirement peaks near `3.88n`, so there is no room to trim it to `3n` and nothing to gain from the attempt. Take `4n` and move on.

```go
// BAD: Insufficient tree size
func badSegmentTree(n int) []int {
    // Wrong. At n=6 the build reaches node index 12 and needs
    // length 13, so this panics on a six-element input.
    return make([]int, 2*n)
}

// GOOD: Allocate enough space
func goodSegmentTree(n int) []int {
    // 4*n is sufficient for every n. The true peak requirement is
    // about 3.88*n, so this is a safe bound and not a wasteful one.
    return make([]int, 4*n)
}

// Alternative: tighter, still always sufficient
func exactSegmentTree(n int) []int {
    size := 1
    for size < n {
        size *= 2 // round n up to a power of two
    }
    return make([]int, 2*size)
}
```

### Junior → FAANG: The Five Mistakes as an Interview Checklist

Before submitting your solution in an interview, run through these five mistake categories as a mental checklist. Is the `isEnd` flag set and checked in both Insert and Search? Are child indices consistent (either all 0-indexed or all 1-indexed)? Is `pushDown` called before recursing in every lazy-propagation function? Does every `Get` in the LRU cache call `moveToHead`? For the trie, is the children type appropriate for the input alphabet (array for English, map for Unicode)? A 30-second checklist pass before claiming "done" catches the majority of implementation bugs that would otherwise surface during the interviewer's test cases.

### Senior @ FAANG: Common Mistakes as Code Review Standards and Onboarding Material

At the senior level, these five common mistakes become the basis for code review standards and onboarding materials for engineers joining a team that owns these structures. The "missing isEnd flag" mistake is caught by a correctness test that inserts "apple" and verifies that Search("app") returns false. The "wrong child indices" mistake is caught by a property-based test that builds the tree from arbitrary arrays and verifies all queries against a naive brute-force. The "missing pushDown" mistake is caught by a test that applies a range update and immediately queries the updated range. These tests are not optional in a production codebase: they are required by the code review checklist, and the staff engineer's responsibility is to enforce that requirement. New engineers joining the team are onboarded by implementing one of these structures from scratch, running the existing test suite, and having their implementation reviewed against these five failure modes before the code is merged. This process both tests the engineer's understanding and strengthens the test suite through new edge cases the engineer discovers.
