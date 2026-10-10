## 69.11 Interview Questions

### Question 1: LRU Cache Implementation

**Problem**: Implement an LRU cache with O(1) get and put operations.

```go
// Solution: Hash map + Doubly linked list
type LRUNode struct {
    key, value int
    prev, next *LRUNode
}

type LRUCache struct {
    capacity int
    cache    map[int]*LRUNode
    head     *LRUNode  // Most recently used
    tail     *LRUNode  // Least recently used
}

func Constructor(capacity int) LRUCache {
    head := &LRUNode{}
    tail := &LRUNode{}
    head.next = tail
    tail.prev = head

    return LRUCache{
        capacity: capacity,
        cache:    make(map[int]*LRUNode),
        head:     head,
        tail:     tail,
    }
}

func (c *LRUCache) Get(key int) int {
    node, exists := c.cache[key]
    if !exists {
        return -1
    }

    c.moveToHead(node)
    return node.value
}

func (c *LRUCache) Put(key int, value int) {
    if node, exists := c.cache[key]; exists {
        node.value = value
        c.moveToHead(node)
        return
    }

    // Create new node
    node := &LRUNode{key: key, value: value}
    c.cache[key] = node
    c.addToHead(node)

    // Evict if over capacity
    if len(c.cache) > c.capacity {
        lru := c.tail.prev
        c.removeNode(lru)
        delete(c.cache, lru.key)
    }
}

func (c *LRUCache) addToHead(node *LRUNode) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

func (c *LRUCache) removeNode(node *LRUNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (c *LRUCache) moveToHead(node *LRUNode) {
    c.removeNode(node)
    c.addToHead(node)
}
```

### Question 2: Group Anagrams

**Problem**: Group strings that are anagrams of each other.

```go
import "slices"

// Solution: Use sorted string or character count as key
func groupAnagrams(strs []string) [][]string {
    groups := make(map[string][]string)

    for _, s := range strs {
        // Use sorted string as key
        key := sortString(s)
        groups[key] = append(groups[key], s)
    }

    result := make([][]string, 0, len(groups))
    for _, group := range groups {
        result = append(result, group)
    }

    return result
}

func sortString(s string) string {
    runes := []rune(s)
    slices.Sort(runes) // rune is ordered, so no comparator is needed
    return string(runes)
}

// Alternative: Use character count as key (more efficient)
func groupAnagramsCount(strs []string) [][]string {
    groups := make(map[[26]int][]string)

    for _, s := range strs {
        var count [26]int
        for _, c := range s {
            count[c-'a']++
        }
        groups[count] = append(groups[count], s)
    }

    result := make([][]string, 0, len(groups))
    for _, group := range groups {
        result = append(result, group)
    }

    return result
}
```

### Question 3: Subarray Sum Equals K

**Problem**: Find the number of subarrays that sum to K.

```go
import "testing"

// Solution: Prefix sum with hash map
func subarraySum(nums []int, k int) int {
    count := 0
    prefixSum := 0
    prefixCount := map[int]int{0: 1}  // Base case

    for _, num := range nums {
        prefixSum += num

        // If prefixSum - k exists, we found subarrays
        if c, exists := prefixCount[prefixSum-k]; exists {
            count += c
        }

        prefixCount[prefixSum]++
    }

    return count
}

// Test
func TestSubarraySum(t *testing.T) {
    tests := []struct {
        nums     []int
        k        int
        expected int
    }{
        {[]int{1, 1, 1}, 2, 2},
        {[]int{1, 2, 3}, 3, 2},
        {[]int{1, -1, 0}, 0, 3},
    }

    for _, tt := range tests {
        got := subarraySum(tt.nums, tt.k)
        if got != tt.expected {
            t.Errorf("subarraySum(%v, %d) = %d, want %d",
                tt.nums, tt.k, got, tt.expected)
        }
    }
}
```

### Junior -> FAANG: Interview Question Execution Strategy

For LRU Cache (Q1): the interviewer is looking for three things: correct data structure selection (map + doubly linked list), clean pointer manipulation (no dangling pointers in the linked list operations), and correct eviction logic (delete from map AND remove from list). The most common mistake is deleting from the map but forgetting to remove from the list, or vice versa. Code the `remove` and `addToHead` helpers first, then use them in `Get` and `Put`.

For Group Anagrams (Q2): always offer both approaches (sort-based and count-based key) and explain the tradeoff: sort-based is simpler to code, count-based is O(k) instead of O(k log k) per string but only works for fixed alphabets. Offering the optimized approach before being asked is a positive signal.

For Subarray Sum (Q3): the seed `prefixCount[0] = 1` is the part candidates most often forget. This handles the case where a subarray starting at index 0 has sum exactly equal to k. Practice explaining it: "I seed with zero-count 1 because if the running prefix sum equals k exactly, there is a subarray from the beginning of the array to the current position."

### Senior @ FAANG: Bar-Raiser Follow-Ups on These Questions

After a candidate solves LRU Cache, a bar-raiser interviewer asks one or more of: "How would you make this thread-safe without serializing all operations?" (shard the cache), "What happens if the cache is suddenly flooded with new keys that evict all existing entries?" (cache thrashing, mitigated by admission policies like TinyLFU), or "How would you persist this cache across restarts?" (append-only log, snapshots, or embedding a key-value store).

After Group Anagrams, the follow-up is usually: "What if the strings are Unicode with characters outside the ASCII range?" (the `[26]int` key breaks, switch to a `map[rune]int` serialized to a string, or a sorted rune slice), or "What if the input is too large to fit in memory?" (streaming group-by with an external sort or distributed map-reduce).

After Subarray Sum, the bar-raiser asks: "What if values can be floating-point?" (floating-point equality in map lookups is unreliable due to precision errors, the problem becomes much harder and requires tolerance-based bucketing rather than exact equality). These follow-ups separate candidates who solved the problem from candidates who understand the problem.

---
