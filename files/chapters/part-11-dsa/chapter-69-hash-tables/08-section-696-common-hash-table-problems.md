## 69.6 Common Hash Table Problems

### Two Sum

The classic Two Sum problem demonstrates the hash-map complement pattern: for each number, compute the value needed to reach the target and look it up in a map that records previously seen numbers and their indices. A single O(n) pass replaces the O(n²) brute-force approach because each element is both a query and an insertion.

```go
import "slices"

// TwoSum finds indices of two numbers that add up to target
// LeetCode 1: Two Sum
// Time: O(n), Space: O(n)
func TwoSum(nums []int, target int) []int {
    seen := make(map[int]int) // value -> index

    for i, num := range nums {
        complement := target - num
        if j, ok := seen[complement]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }

    return nil
}

// TwoSumSorted for sorted array (two pointers is better)
// LeetCode 167: Two Sum II
func TwoSumSorted(numbers []int, target int) []int {
    left, right := 0, len(numbers)-1

    for left < right {
        sum := numbers[left] + numbers[right]
        if sum == target {
            return []int{left + 1, right + 1} // 1-indexed
        } else if sum < target {
            left++
        } else {
            right--
        }
    }

    return nil
}

// ThreeSum finds all triplets that sum to zero
// LeetCode 15: 3Sum
// Time: O(n^2), Space: O(1) excluding output
func ThreeSum(nums []int) [][]int {
    slices.Sort(nums)
    result := [][]int{}
    n := len(nums)

    for i := 0; i < n-2; i++ {
        // Skip duplicates
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Two pointers for remaining sum
        left, right := i+1, n-1
        target := -nums[i]

        for left < right {
            sum := nums[left] + nums[right]
            if sum == target {
                result = append(result, []int{nums[i], nums[left], nums[right]})

                // Skip duplicates
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            } else if sum < target {
                left++
            } else {
                right--
            }
        }
    }

    return result
}

// FourSum finds all quadruplets that sum to target
// LeetCode 18: 4Sum
// Time: O(n^3), Space: O(1) excluding output
func FourSum(nums []int, target int) [][]int {
    slices.Sort(nums)
    return kSum(nums, target, 4, 0)
}

func kSum(nums []int, target int, k int, start int) [][]int {
    result := [][]int{}
    n := len(nums)

    if k == 2 {
        // Two-pointer approach
        left, right := start, n-1
        for left < right {
            sum := nums[left] + nums[right]
            if sum == target {
                result = append(result, []int{nums[left], nums[right]})
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            } else if sum < target {
                left++
            } else {
                right--
            }
        }
    } else {
        for i := start; i < n-k+1; i++ {
            if i > start && nums[i] == nums[i-1] {
                continue
            }

            subResult := kSum(nums, target-nums[i], k-1, i+1)
            for _, subset := range subResult {
                result = append(result, append([]int{nums[i]}, subset...))
            }
        }
    }

    return result
}
```

### Group Anagrams

Grouping anagrams requires a key that is identical for all permutations of the same character set. The sort-based key produces an O(n·k·log k) solution, while the character-count array key reduces this to O(n·k) (at the cost of constraining input to a fixed alphabet) by using a fixed-size `[26]int` array as the map key.

```go
import "slices"

// GroupAnagrams groups strings that are anagrams
// LeetCode 49: Group Anagrams
// Time: O(n * k log k) where k is max string length
// Space: O(n * k)
func GroupAnagrams(strs []string) [][]string {
    groups := make(map[string][]string)

    for _, str := range strs {
        // Create key by sorting characters
        sorted := sortString(str)
        groups[sorted] = append(groups[sorted], str)
    }

    result := make([][]string, 0, len(groups))
    for _, group := range groups {
        result = append(result, group)
    }

    return result
}

func sortString(s string) string {
    runes := []rune(s)
    slices.Sort(runes) // rune is an ordered type, so no comparator needed
    return string(runes)
}

// GroupAnagramsOptimized uses character count as key
// Time: O(n * k) where k is max string length
func GroupAnagramsOptimized(strs []string) [][]string {
    groups := make(map[[26]int][]string)

    for _, str := range strs {
        var count [26]int
        for _, ch := range str {
            count[ch-'a']++
        }
        groups[count] = append(groups[count], str)
    }

    result := make([][]string, 0, len(groups))
    for _, group := range groups {
        result = append(result, group)
    }

    return result
}
```

### Valid Anagram

Anagram validation can be reduced to verifying that both strings produce the same character frequency table. Incrementing counts for one string and decrementing for the other in a single pass allows early termination as soon as any count drops below zero, making this approach both O(n) in time and O(1) in space when the alphabet is fixed.

```go
// IsAnagram checks if two strings are anagrams
// LeetCode 242: Valid Anagram
// Time: O(n), Space: O(1) for lowercase English letters
func IsAnagram(s string, t string) bool {
    if len(s) != len(t) {
        return false
    }

    count := make(map[rune]int)

    for _, ch := range s {
        count[ch]++
    }

    for _, ch := range t {
        count[ch]--
        if count[ch] < 0 {
            return false
        }
    }

    return true
}

// IsAnagramArray uses array for O(1) space (ASCII)
func IsAnagramArray(s string, t string) bool {
    if len(s) != len(t) {
        return false
    }

    var count [26]int

    for i := 0; i < len(s); i++ {
        count[s[i]-'a']++
        count[t[i]-'a']--
    }

    for _, c := range count {
        if c != 0 {
            return false
        }
    }

    return true
}
```

### Subarray Sum Equals K

Counting subarrays with a target sum uses the prefix sum identity: a subarray `nums[j..i]` sums to `k` when `prefix[i] - prefix[j] = k`, i.e., when `prefix[i] - k` has been seen before. Storing prefix sum frequencies in a map and seeding it with `{0: 1}` correctly accounts for subarrays that start at index 0.

```go
// SubarraySum counts subarrays with sum equal to k
// LeetCode 560: Subarray Sum Equals K
// Time: O(n), Space: O(n)
func SubarraySum(nums []int, k int) int {
    // Map: prefix sum -> count
    prefixCount := make(map[int]int)
    prefixCount[0] = 1 // empty prefix

    count := 0
    prefixSum := 0

    for _, num := range nums {
        prefixSum += num

        // If prefixSum - k exists, we found a subarray
        if c, ok := prefixCount[prefixSum-k]; ok {
            count += c
        }

        prefixCount[prefixSum]++
    }

    return count
}

// LongestSubarrayWithSumK finds the longest subarray with given sum
func LongestSubarrayWithSumK(nums []int, k int) int {
    // Map: prefix sum -> first index
    prefixIndex := make(map[int]int)
    prefixIndex[0] = -1

    maxLen := 0
    prefixSum := 0

    for i, num := range nums {
        prefixSum += num

        if j, ok := prefixIndex[prefixSum-k]; ok {
            if i-j > maxLen {
                maxLen = i - j
            }
        }

        // Only store first occurrence
        if _, ok := prefixIndex[prefixSum]; !ok {
            prefixIndex[prefixSum] = i
        }
    }

    return maxLen
}
```

### Longest Consecutive Sequence

Finding the longest consecutive sequence in O(n) time requires identifying sequence start points without sorting. Loading all numbers into a hash set and then only initiating a count from values with no left neighbor (`num-1` absent) ensures each number is visited at most twice across all sequences, yielding linear overall time.

```go
// LongestConsecutive finds the longest consecutive sequence
// LeetCode 128: Longest Consecutive Sequence
// Time: O(n), Space: O(n)
func LongestConsecutive(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    // Build a set
    numSet := make(map[int]bool)
    for _, num := range nums {
        numSet[num] = true
    }

    maxLength := 0

    for num := range numSet {
        // Only start from the beginning of a sequence
        if !numSet[num-1] {
            currentNum := num
            length := 1

            for numSet[currentNum+1] {
                currentNum++
                length++
            }

            if length > maxLength {
                maxLength = length
            }
        }
    }

    return maxLength
}
```

### Top K Frequent Elements

Finding the k most frequent elements can be solved in O(n) by using bucket sort: after counting frequencies with a map, place each number into a bucket indexed by its frequency. Scanning buckets from the highest index downward collects the top-k elements without sorting, beating the O(n log n) sort-based approach.

```go
import "container/heap"

// TopKFrequent returns the k most frequent elements
// LeetCode 347: Top K Frequent Elements
// Time: O(n), Space: O(n) using bucket sort
func TopKFrequent(nums []int, k int) []int {
    // Count frequencies
    freq := make(map[int]int)
    for _, num := range nums {
        freq[num]++
    }

    // Bucket sort: bucket[i] contains numbers with frequency i
    n := len(nums)
    buckets := make([][]int, n+1)
    for num, count := range freq {
        buckets[count] = append(buckets[count], num)
    }

    // Collect top k from highest frequency buckets
    result := make([]int, 0, k)
    for i := n; i >= 0 && len(result) < k; i-- {
        result = append(result, buckets[i]...)
    }

    return result[:k]
}

// TopKFrequentHeap uses min heap
// Time: O(n log k), Space: O(n)

type Item struct {
    num   int
    count int
}

type MinHeap []Item

func (h MinHeap) Len() int           { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i].count < h[j].count }
func (h MinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(Item)) }
func (h *MinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func TopKFrequentHeap(nums []int, k int) []int {
    freq := make(map[int]int)
    for _, num := range nums {
        freq[num]++
    }

    h := &MinHeap{}
    heap.Init(h)

    for num, count := range freq {
        heap.Push(h, Item{num, count})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(Item).num
    }

    return result
}
```

### Contains Duplicate

Duplicate detection with a hash set reduces an O(n²) comparison problem to a single O(n) pass: each element is checked against the set before insertion, returning immediately on the first repeat. The nearby-duplicate variants extend this by maintaining a sliding window of recent values, bounding the search space to a fixed range of indices or values.

```go
// ContainsDuplicate checks if array has any duplicates
// LeetCode 217: Contains Duplicate
// Time: O(n), Space: O(n)
func ContainsDuplicate(nums []int) bool {
    seen := make(map[int]bool)

    for _, num := range nums {
        if seen[num] {
            return true
        }
        seen[num] = true
    }

    return false
}

// ContainsNearbyDuplicate checks for duplicates within distance k
// LeetCode 219: Contains Duplicate II
// Time: O(n), Space: O(min(n, k))
func ContainsNearbyDuplicate(nums []int, k int) bool {
    window := make(map[int]bool)

    for i, num := range nums {
        if window[num] {
            return true
        }

        window[num] = true

        // Maintain window of size k
        if i >= k {
            delete(window, nums[i-k])
        }
    }

    return false
}

// ContainsNearbyAlmostDuplicate checks for nums[i] and nums[j] where:
// abs(nums[i] - nums[j]) <= t and abs(i - j) <= k
// LeetCode 220: Contains Duplicate III
// Time: O(n), Space: O(min(n, k))
func ContainsNearbyAlmostDuplicate(nums []int, indexDiff int, valueDiff int) bool {
    if indexDiff <= 0 || valueDiff < 0 {
        return false
    }

    // Bucket sort approach
    // Bucket size is valueDiff + 1
    buckets := make(map[int64]int64)
    width := int64(valueDiff) + 1

    getBucket := func(num int64) int64 {
        if num >= 0 {
            return num / width
        }
        return (num+1)/width - 1
    }

    for i, num := range nums {
        n := int64(num)
        bucket := getBucket(n)

        // Check same bucket
        if _, ok := buckets[bucket]; ok {
            return true
        }

        // Check adjacent buckets
        if prev, ok := buckets[bucket-1]; ok && n-prev <= int64(valueDiff) {
            return true
        }
        if next, ok := buckets[bucket+1]; ok && next-n <= int64(valueDiff) {
            return true
        }

        buckets[bucket] = n

        // Maintain window
        if i >= indexDiff {
            delete(buckets, getBucket(int64(nums[i-indexDiff])))
        }
    }

    return false
}
```

### LRU Cache

An LRU cache combines a hash map with a doubly linked list to achieve O(1) get and put operations. The map provides instant node lookup, while the linked list maintains access order. Most-recently-used nodes are spliced to the head on every access, and the tail node is evicted when the cache exceeds capacity.

```go
// LRUCache implementation using hash map and doubly linked list
// LeetCode 146: LRU Cache
type LRUCache struct {
    capacity int
    cache    map[int]*Node
    head     *Node // most recently used
    tail     *Node // least recently used
}

type Node struct {
    key, value int
    prev, next *Node
}

func Constructor(capacity int) LRUCache {
    head := &Node{}
    tail := &Node{}
    head.next = tail
    tail.prev = head

    return LRUCache{
        capacity: capacity,
        cache:    make(map[int]*Node),
        head:     head,
        tail:     tail,
    }
}

func (c *LRUCache) remove(node *Node) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (c *LRUCache) addToHead(node *Node) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

func (c *LRUCache) moveToHead(node *Node) {
    c.remove(node)
    c.addToHead(node)
}

func (c *LRUCache) Get(key int) int {
    if node, ok := c.cache[key]; ok {
        c.moveToHead(node)
        return node.value
    }
    return -1
}

func (c *LRUCache) Put(key int, value int) {
    if node, ok := c.cache[key]; ok {
        node.value = value
        c.moveToHead(node)
        return
    }

    newNode := &Node{key: key, value: value}
    c.cache[key] = newNode
    c.addToHead(newNode)

    if len(c.cache) > c.capacity {
        // Remove least recently used
        lru := c.tail.prev
        c.remove(lru)
        delete(c.cache, lru.key)
    }
}
```

### Junior -> FAANG: Mastering the Core Problem Patterns

These six problem families (two-sum, anagram grouping, subarray sum, consecutive sequence, top-k frequent, LRU cache) account for the majority of hash-table interview questions. The mental model for each:

Two-sum: "I need X, I have Y, so I need X-Y. Have I seen X-Y before?" Store seen values in a map.

Anagram grouping: "I need a canonical key that is identical for all permutations." Sort the string (O(k log k)) or use a character count array as a key (O(k)).

Subarray sum: "I need `sum[i..j] == k`, which means `prefix[j] - prefix[i] == k`, which means `prefix[j] - k == prefix[i]`." Seed the map with `{0: 1}` to handle subarrays starting at index 0.

Top-k frequent: Counting is O(n) with a map. Selecting the top k is O(n) with bucket sort or O(n log k) with a min-heap. The bucket sort approach is the "wow" answer in interviews.

LRU cache: Map provides O(1) node lookup. Doubly linked list provides O(1) node removal and front-insertion. Combining them is the classic composite data structure interview question. Practice coding it from memory in under 15 minutes.

### Senior @ FAANG: LRU Cache Design at Production Scale

The `LRUCache` implementation above is correct for a single-goroutine context. In production, an LRU cache serving a high-traffic service requires several additional properties that interviewers probe in system design rounds.

Thread safety: wrapping the entire cache in a single `sync.Mutex` is correct but creates a serialization bottleneck. Note that an `RWMutex` does not rescue you here, because `Get` mutates the recency list and therefore needs the write lock too. That surprises people: a read-only cache lookup is a write to an LRU. A sharded LRU partitions the key space across N independent caches, each with its own mutex, so contention drops roughly in proportion to N when keys spread evenly, though a hot key still serializes on its shard. The tradeoff is that global eviction becomes approximate, since each shard maintains its own LRU order and evicts its own tail regardless of global recency.

Cache stampede mitigation: when a popular key expires, all goroutines that try to fetch it simultaneously miss the cache and hit the backend together, creating a thundering herd. The standard fix is a `singleflight.Group` (from `golang.org/x/sync/singleflight`) that deduplicates concurrent requests for the same key, ensuring only one goroutine fetches from the backend while others wait for the result.

Metrics and observability: a production cache must expose hit rate, miss rate, eviction rate, and current size as metrics. An unexpectedly low hit rate on a workload you believed had strong locality is a signal that the capacity is too small, the TTL is too short, or the key space is too large and the cache is thrashing. Pick the target from the workload rather than from a round number, since a 60% hit rate can be excellent for one access pattern and alarming for another. Without instrumentation, you cannot distinguish these failure modes at all.
