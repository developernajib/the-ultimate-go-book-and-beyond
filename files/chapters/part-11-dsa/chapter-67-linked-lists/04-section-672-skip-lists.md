## 67.2 Skip Lists

Skip lists are a probabilistic data structure that provides O(log n) search, insertion, and deletion on average. They're used in Redis for sorted sets.

```
┌─────────────────────────────────────────────────────────────────┐
│                       SKIP LIST STRUCTURE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Level 3:  HEAD ────────────────────────────────────► 47 ──► nil│
│             │                                         │         │
│  Level 2:  HEAD ───────────────► 23 ──────────────► 47 ──► nil  │
│             │                    │                   │          │
│  Level 1:  HEAD ────► 7 ──────► 23 ────► 35 ──────► 47 ──► nil  │
│             │        │          │        │          │           │
│  Level 0:  HEAD ──► 7 ──► 12 ──► 23 ──► 35 ──► 42 ──► 47 ──► nil│
│                                                                 │
│  Search for 35:                                                 │
│  1. Start at HEAD Level 3                                       │
│  2. 47 > 35, drop to Level 2                                    │
│  3. 23 < 35, move right                                         │
│  4. 47 > 35, drop to Level 1                                    │
│  5. 35 == 35, found!                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
package skiplist

import (
    "math/rand/v2"
)

const (
    maxLevel    = 16   // maximum number of levels
    probability = 0.5  // probability of going to next level
)

// SkipNode represents a node in the skip list
type SkipNode struct {
    key     int
    value   any
    forward []*SkipNode // forward pointers for each level
}

// SkipList implements a skip list data structure
type SkipList struct {
    head   *SkipNode // header node (sentinel)
    level  int       // current highest level
    length int       // number of elements
}

// NewSkipList creates a new skip list
func NewSkipList() *SkipList {
    head := &SkipNode{
        forward: make([]*SkipNode, maxLevel),
    }
    return &SkipList{
        head:  head,
        level: 0,
    }
}

// randomLevel generates a random level for new node
// Returns a level between 0 and maxLevel-1
// Higher levels are exponentially less likely
func randomLevel() int {
    level := 0
    for level < maxLevel-1 && rand.Float64() < probability {
        level++
    }
    return level
}

// Search returns the value for a key, or nil if not found
// Time: O(log n) average, O(n) worst case
func (sl *SkipList) Search(key int) (any, bool) {
    current := sl.head

    // Start from highest level and work down
    for i := sl.level; i >= 0; i-- {
        // Move forward while key is greater
        for current.forward[i] != nil && current.forward[i].key < key {
            current = current.forward[i]
        }
    }

    // Check if we found the key at level 0
    current = current.forward[0]
    if current != nil && current.key == key {
        return current.value, true
    }

    return nil, false
}

// Insert adds or updates a key-value pair
// Time: O(log n) average, O(n) worst case
func (sl *SkipList) Insert(key int, value any) {
    // Track the rightmost node at each level that points to a node >= key
    update := make([]*SkipNode, maxLevel)
    current := sl.head

    // Find position, recording update nodes at each level
    for i := sl.level; i >= 0; i-- {
        for current.forward[i] != nil && current.forward[i].key < key {
            current = current.forward[i]
        }
        update[i] = current
    }

    // Check if key exists
    current = current.forward[0]
    if current != nil && current.key == key {
        // Update existing value
        current.value = value
        return
    }

    // Create new node with random level
    newLevel := randomLevel()

    // If new level is higher than current, initialize update nodes
    if newLevel > sl.level {
        for i := sl.level + 1; i <= newLevel; i++ {
            update[i] = sl.head
        }
        sl.level = newLevel
    }

    // Create new node
    newNode := &SkipNode{
        key:     key,
        value:   value,
        forward: make([]*SkipNode, newLevel+1),
    }

    // Insert node by updating pointers at each level
    for i := 0; i <= newLevel; i++ {
        newNode.forward[i] = update[i].forward[i]
        update[i].forward[i] = newNode
    }

    sl.length++
}

// Delete removes a key from the skip list
// Time: O(log n) average, O(n) worst case
func (sl *SkipList) Delete(key int) bool {
    update := make([]*SkipNode, maxLevel)
    current := sl.head

    // Find position
    for i := sl.level; i >= 0; i-- {
        for current.forward[i] != nil && current.forward[i].key < key {
            current = current.forward[i]
        }
        update[i] = current
    }

    current = current.forward[0]

    // Key not found
    if current == nil || current.key != key {
        return false
    }

    // Remove node by updating pointers
    for i := 0; i <= sl.level; i++ {
        if update[i].forward[i] != current {
            break
        }
        update[i].forward[i] = current.forward[i]
    }

    // Reduce level if needed
    for sl.level > 0 && sl.head.forward[sl.level] == nil {
        sl.level--
    }

    sl.length--
    return true
}

// Range returns all key-value pairs in range [start, end]
// Time: O(log n + m) where m is the number of elements in range
func (sl *SkipList) Range(start, end int) []KeyValue {
    var result []KeyValue

    current := sl.head

    // Find starting position
    for i := sl.level; i >= 0; i-- {
        for current.forward[i] != nil && current.forward[i].key < start {
            current = current.forward[i]
        }
    }

    // Move to first element >= start
    current = current.forward[0]

    // Collect all elements in range
    for current != nil && current.key <= end {
        result = append(result, KeyValue{Key: current.key, Value: current.value})
        current = current.forward[0]
    }

    return result
}

// KeyValue represents a key-value pair
type KeyValue struct {
    Key   int
    Value any
}

// Length returns the number of elements
func (sl *SkipList) Length() int {
    return sl.length
}

// GetRank returns the rank (1-indexed) of a key, or 0 if absent.
// Time: O(n), Space: O(1)
//
// Rank is a count of elements, so it must be counted on level 0, which is
// the only level holding every element. A tempting but wrong version walks
// down from the top level and adds 1 per hop: a hop at level 3 may skip
// eight nodes, so that version counts hops rather than elements and reports
// ranks that are far too small. See the note on span tracking below for the
// O(log n) fix that Redis uses.
func (sl *SkipList) GetRank(key int) int {
    current := sl.head

    // Descend to the node just before the key.
    for i := sl.level; i >= 0; i-- {
        for current.forward[i] != nil && current.forward[i].key < key {
            current = current.forward[i]
        }
    }

    target := current.forward[0]
    if target == nil || target.key != key {
        return 0 // key not found
    }

    // Count elements on level 0 up to and including the target.
    rank := 1
    for c := sl.head.forward[0]; c != target; c = c.forward[0] {
        rank++
    }
    return rank
}
```

### Junior -> FAANG: Understanding Why Skip Lists Appear in Interviews

Skip lists are rarely implemented from scratch in production Go code, but they appear in interview conversations for two reasons. First, they test probabilistic reasoning: the expected O(log n) bound holds because each level's probability of containing a node is p (typically 0.5 or 0.25), so the expected height is log(1/p)(n). Second, they test whether you understand the alternative to balanced BSTs: skip lists provide the same asymptotic guarantees without rotations, which makes them simpler to implement correctly in concurrent settings.

For a coding interview, the key things to say about skip lists are: (1) O(log n) average for search, insert, and delete, (2) O(n) worst case when the coin flips go badly, (3) O(n) expected space, and (4) Redis uses them for sorted sets because they support efficient range queries.

The space bound is worth getting right, because "O(n log n) space" is a common and wrong answer. A node appears at level 0 always, at level 1 with probability p, at level 2 with probability p squared, and so on, so its expected number of forward pointers is the geometric sum 1/(1-p), which is 2 when p is 0.5. Expected total pointers is therefore about 2n, which is O(n). The log n is the expected *height* of the structure, not a per-element cost.

**Interview entry-point:** If you are asked to "design a leaderboard" or "implement a ranked sorted set," mention skip lists as the data structure behind Redis ZSET, and be prepared to sketch the multi-level structure with the horizontal and vertical traversal pattern.

**Prerequisite gap:** Many junior candidates confuse skip lists with binary search trees. The key difference is that a skip list is a linked structure where you trade pointer memory for probabilistic height, while a BST is a tree structure where balance requires rotations. Skip lists are easier to implement correctly for concurrent access because node insertions do not require rebalancing a tree.

### Senior @ FAANG: Skip Lists in Platform Contexts and Concurrent Design

**When skip lists beat balanced BSTs.** The practical advantage of skip lists over AVL trees or red-black trees in concurrent settings is lock granularity. Rebalancing a BST after insert or delete can require rotating nodes several levels up the tree, which means taking a coarse lock on a large portion of the structure. Skip list updates affect only the forward pointers at the levels the new node occupies, which are independent across levels. This makes fine-grained locking (per-node or per-level) much more natural and has led to production lock-free skip list implementations in Java's `ConcurrentSkipListMap`.

**ADR: native skip list vs. Redis delegation.** For a Go microservice needing a sorted set with range queries, the ADR choice is between implementing a skip list natively, using `github.com/google/btree`, or delegating to Redis ZSET. The native implementation gives lowest latency (no network hop) and full control over eviction policy. The Redis delegation gives persistence, replication, and cluster-level distributed state at the cost of network latency and operational dependency. The btree alternative gives O(log n) deterministic bounds rather than probabilistic bounds, which matters for worst-case latency SLOs.

**Span tracking for O(log n) rank queries.** The `GetRank` implementation above is O(n) because it counts every element on level 0. That is the price of counting elements with pointers that carry no notion of distance. The Redis skip list implementation stores a `span` field alongside each forward pointer, recording how many level-0 nodes that pointer jumps over. Rank then falls out of the search itself: descend as usual, and accumulate the span of every pointer you traverse. The path is O(log n) long, so rank becomes O(log n) with no extra traversal. The cost is that every insert and delete must now maintain span accounting on the levels it touches, including incrementing spans on levels *above* the new node, since a pointer that flies over the new node now spans one more element. The `13-6710-company-case-studies.md` file shows this pattern in the Redis-style ZSet implementation. Implementing span tracking is an L5-level skill: it requires understanding both the insertion algorithm and the span accounting during random-level assignment.

**Maturity model for skip list adoption:**
- Level 1: Understands that skip lists exist and are used in Redis.
- Level 2: Can implement a basic skip list with search, insert, and delete.
- Level 3: Can implement span tracking for O(log n) rank queries and explain the level generation probability trade-off (0.5 vs 0.25).
- Level 4: Can design a concurrent skip list with per-node fine-grained locking or CAS-based lock-free updates, with documented memory ordering guarantees.
