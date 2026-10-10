## 67.12 Interview Questions

### Question 1: Design a Browser History

**Problem**: Implement BrowserHistory class that supports back, forward, and visit operations.

```go
// Solution: Doubly linked list for O(1) operations
type HistoryNode struct {
    url  string
    prev *HistoryNode
    next *HistoryNode
}

type BrowserHistory struct {
    current *HistoryNode
}

func Constructor(homepage string) BrowserHistory {
    return BrowserHistory{
        current: &HistoryNode{url: homepage},
    }
}

// Visit clears forward history and adds new page
// Time: O(1)
func (h *BrowserHistory) Visit(url string) {
    newNode := &HistoryNode{
        url:  url,
        prev: h.current,
    }
    h.current.next = newNode
    h.current = newNode
}

// Back moves back at most 'steps' pages
// Time: O(min(steps, history length))
func (h *BrowserHistory) Back(steps int) string {
    for steps > 0 && h.current.prev != nil {
        h.current = h.current.prev
        steps--
    }
    return h.current.url
}

// Forward moves forward at most 'steps' pages
// Time: O(min(steps, forward history length))
func (h *BrowserHistory) Forward(steps int) string {
    for steps > 0 && h.current.next != nil {
        h.current = h.current.next
        steps--
    }
    return h.current.url
}

// Test
func TestBrowserHistory(t *testing.T) {
    bh := Constructor("leetcode.com")
    bh.Visit("google.com")
    bh.Visit("facebook.com")
    bh.Visit("youtube.com")

    if got := bh.Back(1); got != "facebook.com" {
        t.Errorf("Back(1) = %s, want facebook.com", got)
    }

    if got := bh.Back(1); got != "google.com" {
        t.Errorf("Back(1) = %s, want google.com", got)
    }

    if got := bh.Forward(1); got != "facebook.com" {
        t.Errorf("Forward(1) = %s, want facebook.com", got)
    }

    bh.Visit("linkedin.com")  // Clears forward history

    if got := bh.Forward(2); got != "linkedin.com" {
        t.Errorf("Forward(2) = %s, want linkedin.com (no forward)", got)
    }
}
```

**Key Points**:
- Doubly linked list allows O(1) navigation in both directions
- Visiting a new page clears forward history
- Back/Forward are bounded by available history

### Question 2: LFU Cache

**Problem**: Design a Least Frequently Used (LFU) cache. When cache is full, evict the least frequently used key. If there's a tie, evict the least recently used among them.

```go
// Solution: HashMap + Frequency-indexed doubly linked lists
type LFUNode struct {
    key, value int
    freq       int
    prev, next *LFUNode
}

type FrequencyList struct {
    head, tail *LFUNode
    size       int
}

func NewFrequencyList() *FrequencyList {
    head := &LFUNode{}
    tail := &LFUNode{}
    head.next = tail
    tail.prev = head
    return &FrequencyList{head: head, tail: tail}
}

func (f *FrequencyList) AddToHead(node *LFUNode) {
    node.prev = f.head
    node.next = f.head.next
    f.head.next.prev = node
    f.head.next = node
    f.size++
}

func (f *FrequencyList) Remove(node *LFUNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
    f.size--
}

func (f *FrequencyList) RemoveTail() *LFUNode {
    if f.size == 0 {
        return nil
    }
    node := f.tail.prev
    f.Remove(node)
    return node
}

type LFUCache struct {
    capacity int
    minFreq  int
    cache    map[int]*LFUNode
    freqMap  map[int]*FrequencyList
}

func ConstructorLFU(capacity int) LFUCache {
    return LFUCache{
        capacity: capacity,
        cache:    make(map[int]*LFUNode),
        freqMap:  make(map[int]*FrequencyList),
    }
}

// Get retrieves value and updates frequency
// Time: O(1)
func (c *LFUCache) Get(key int) int {
    if node, exists := c.cache[key]; exists {
        c.updateFrequency(node)
        return node.value
    }
    return -1
}

// Put adds or updates key-value pair
// Time: O(1)
func (c *LFUCache) Put(key int, value int) {
    if c.capacity == 0 {
        return
    }

    if node, exists := c.cache[key]; exists {
        node.value = value
        c.updateFrequency(node)
        return
    }

    // Evict if at capacity
    if len(c.cache) >= c.capacity {
        list := c.freqMap[c.minFreq]
        evicted := list.RemoveTail()
        delete(c.cache, evicted.key)
    }

    // Add new node
    node := &LFUNode{key: key, value: value, freq: 1}
    c.cache[key] = node

    if c.freqMap[1] == nil {
        c.freqMap[1] = NewFrequencyList()
    }
    c.freqMap[1].AddToHead(node)
    c.minFreq = 1
}

func (c *LFUCache) updateFrequency(node *LFUNode) {
    freq := node.freq
    c.freqMap[freq].Remove(node)

    // Update minFreq if needed
    if freq == c.minFreq && c.freqMap[freq].size == 0 {
        c.minFreq++
    }

    // Reclaim the emptied bucket. Without this, freqMap grows without bound:
    // it is keyed by frequency, and frequencies climb forever as keys are
    // read, so a single hot key accumulates one dead FrequencyList per Get.
    // That growth tracks total access count, not cache capacity, which is
    // the wrong thing for a fixed-size cache to be proportional to.
    if c.freqMap[freq].size == 0 {
        delete(c.freqMap, freq)
    }

    node.freq++
    if c.freqMap[node.freq] == nil {
        c.freqMap[node.freq] = NewFrequencyList()
    }
    c.freqMap[node.freq].AddToHead(node)
}
```

Note also that `node.freq` is an `int` and only ever increments, so it cannot realistically overflow: a key would need 2^63 accesses. The bucket count is the bound that actually bites, and the `delete` above is what fixes it.

**Key Points**:
- Two-level structure: cache map + frequency-indexed lists
- Each frequency has a doubly linked list for LRU among same frequency
- Track minFreq for O(1) eviction

### Question 3: Clone a Graph

**Problem**: Given a reference to a node in a connected undirected graph, return a deep copy.

```go
// Graph node definition
type GraphNode struct {
    Val       int
    Neighbors []*GraphNode
}

// Solution: DFS with hash map to track cloned nodes
func CloneGraph(node *GraphNode) *GraphNode {
    if node == nil {
        return nil
    }

    cloned := make(map[*GraphNode]*GraphNode)
    return cloneGraphDFS(node, cloned)
}

func cloneGraphDFS(node *GraphNode, cloned map[*GraphNode]*GraphNode) *GraphNode {
    // Return already cloned node
    if clone, exists := cloned[node]; exists {
        return clone
    }

    // Create clone
    clone := &GraphNode{Val: node.Val}
    cloned[node] = clone

    // Clone neighbors
    for _, neighbor := range node.Neighbors {
        clone.Neighbors = append(clone.Neighbors, cloneGraphDFS(neighbor, cloned))
    }

    return clone
}

// BFS Solution
func CloneGraphBFS(node *GraphNode) *GraphNode {
    if node == nil {
        return nil
    }

    cloned := make(map[*GraphNode]*GraphNode)
    cloned[node] = &GraphNode{Val: node.Val}

    queue := []*GraphNode{node}

    for len(queue) > 0 {
        curr := queue[0]
        queue = queue[1:]

        for _, neighbor := range curr.Neighbors {
            if _, exists := cloned[neighbor]; !exists {
                cloned[neighbor] = &GraphNode{Val: neighbor.Val}
                queue = append(queue, neighbor)
            }
            cloned[curr].Neighbors = append(cloned[curr].Neighbors, cloned[neighbor])
        }
    }

    return cloned[node]
}

// Test
func TestCloneGraph(t *testing.T) {
    // Create graph: 1 -- 2
    //               |    |
    //               4 -- 3
    n1 := &GraphNode{Val: 1}
    n2 := &GraphNode{Val: 2}
    n3 := &GraphNode{Val: 3}
    n4 := &GraphNode{Val: 4}

    n1.Neighbors = []*GraphNode{n2, n4}
    n2.Neighbors = []*GraphNode{n1, n3}
    n3.Neighbors = []*GraphNode{n2, n4}
    n4.Neighbors = []*GraphNode{n1, n3}

    clone := CloneGraph(n1)

    // Verify clone is different object
    if clone == n1 {
        t.Error("Clone should be different object")
    }

    // Verify values
    if clone.Val != 1 {
        t.Errorf("Expected val 1, got %d", clone.Val)
    }

    // Verify neighbors
    if len(clone.Neighbors) != 2 {
        t.Errorf("Expected 2 neighbors, got %d", len(clone.Neighbors))
    }
}
```

**Key Points**:
- Use hash map to track original → clone mapping
- Prevents infinite loops in cyclic graphs
- Both DFS and BFS work, DFS is more concise

### Junior -> FAANG: Interview Question Patterns

**Browser History (Question 1):** The doubly linked list is the natural fit because navigation moves in both directions. The critical detail is that visiting a new page clears the forward history. In a linked list implementation, this means setting `current.next = nil` (or rather, assigning a new node that has no forward link). Practice implementing this from scratch in fifteen minutes.

**LFU Cache (Question 2):** This is the hardest of the three and a common L4-to-L5 discriminator. The key insight is that `minFreq` must track the current minimum frequency so eviction is O(1). After incrementing a node's frequency, `minFreq` only needs to be updated if the old frequency equaled `minFreq` and the old frequency list is now empty. Note why `minFreq++` (rather than a rescan) is sufficient: the node that just left `minFreq` moved to exactly `minFreq + 1`, so if it emptied the bucket, the new minimum cannot be anything else. Practice explaining `updateFrequency` step by step before coding it.

**Clone Graph (Question 3):** The hash map that tracks original-to-clone mapping serves two purposes: it prevents infinite loops when the graph has cycles, and it ensures each node is cloned exactly once. The DFS and BFS solutions are equivalent in correctness. The DFS solution is more concise. The BFS solution is easier to reason about for interviewers who prefer iterative thinking. Choose the one you can write faster under pressure.

**First-job preparation habit:** For each question, write the test case before the implementation. For Browser History: `bh.Visit("a"); bh.Visit("b"); bh.Back(1)` should return "a". For LFU Cache: verify that tie-breaking between equal frequencies evicts the least recently used. For Clone Graph: verify that modifying the clone does not affect the original.

### Senior @ FAANG: Deep Design Analysis of Interview Questions

**Browser History as a real system design problem.** A browser's history is not a simple doubly linked list in production. It must handle: serialization to disk (list of URL strings), tab isolation (one list per tab), private browsing (ephemeral list not persisted), and session restoration (deserializing the list on crash recovery). The interview question abstracts these concerns away, but a senior candidate who mentions one or two real-world dimensions after solving the core problem signals system-level awareness.

**LFU Cache: the `minFreq` invariant as a design constraint.** The O(1) guarantee for LFU eviction depends entirely on maintaining `minFreq` correctly across all mutations. The invariant is: after every `Put` or `Get`, `minFreq` equals the smallest frequency of any key currently in the cache. This invariant has three update cases: (1) new key inserted (always frequency 1, so `minFreq = 1`). (2) existing key frequency incremented and old frequency was `minFreq` and old frequency list is now empty (increment `minFreq`). (3) existing key frequency incremented and old frequency was not `minFreq` (no change to `minFreq`). A code review of any LFU implementation should verify all three cases with explicit test coverage. The cheapest way to get that coverage is a differential test: run the real cache and a deliberately naive brute-force LFU (scan every entry, pick min frequency, break ties by an access counter) against the same random operation stream and assert they agree on every call. The brute-force model is obviously correct and obviously too slow, which is exactly what makes it a good oracle. This technique finds tie-break and `minFreq` bugs in minutes that hand-written cases miss for years.

**LFU vs. LRU as an ADR exercise.** The choice between LFU and LRU depends on the access distribution of the workload. LFU is better for workloads with stable hot keys (frequency predicts future access). LRU is better for workloads with recency bias and scan-heavy access (frequency is a poor predictor). A staff-level engineer choosing between LFU and LRU for a production cache should require load testing with a representative workload trace, not theoretical analysis alone. Modern caches like Ristretto combine frequency estimation with recency using a TinyLFU admission filter, which outperforms pure LRU and pure LFU across a wider range of workloads.

**Clone Graph as a concurrency problem.** If the graph being cloned is shared and mutable (other goroutines may be modifying it during the clone), a consistent snapshot requires either a global read lock for the duration of the DFS, or a copy-on-write scheme where the clone operates on a snapshot. A bar raiser will ask: "How would you clone this graph safely if it is being modified concurrently?" This extends the interview question into a concurrency design discussion that separates L5 from L6 candidates.

---
