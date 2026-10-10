## 65.9 Advanced Interview Questions with Frameworks

### Question 4: Explain Amortized Analysis in a System Design Context

**Interview Question:** "How would you explain amortized analysis to a product manager who's concerned about occasional slow operations in your system?"

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AMORTIZED ANALYSIS EXPLANATION                       │
├─────────────────────────────────────────────────────────────────────────┤
│  1. START WITH ANALOGY                                                  │
│     - "Think of it like refueling a car..."                             │
│     - Most trips: constant time (just drive)                            │
│     - Occasional trip: longer (need gas)                                │
│     - Average trip time: still constant                                 │
│                                                                         │
│  2. EXPLAIN THE TECHNICAL CONCEPT                                       │
│     - Some operations are expensive but rare                            │
│     - Cost is "spread" across many cheap operations                     │
│     - Total cost over n operations ÷ n = amortized cost                 │
│                                                                         │
│  3. GIVE CONCRETE EXAMPLE                                               │
│     - Dynamic array (slice) appends                                     │
│     - Most appends: O(1)                                                │
│     - Resize: O(n) but doubles capacity                                 │
│     - After n appends: ~2n total work = O(1) per append                 │
│                                                                         │
│  4. ADDRESS THEIR CONCERN                                               │
│     - Occasional latency spikes are expected                            │
│     - Overall throughput remains excellent                              │
│     - Strategies to mitigate: pre-allocation, off-peak resizing         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer:**

```go
// Demonstration: Why amortized O(1) matters
package main

import (
    "fmt"
    "time"
)

// SliceGrowthDemo shows amortized analysis in action
func SliceGrowthDemo() {
    // Track append timings
    var timings []time.Duration
    var data []int

    for i := 0; i < 1000000; i++ {
        start := time.Now()
        data = append(data, i)
        elapsed := time.Since(start)
        timings = append(timings, elapsed)
    }

    // Analyze: Most operations are fast, few are slow
    var fast, medium, slow int
    for _, t := range timings {
        switch {
        case t < time.Microsecond:
            fast++
        case t < 100*time.Microsecond:
            medium++
        default:
            slow++
        }
    }

    fmt.Printf("Fast (<1µs):   %d (%.2f%%)\n", fast, float64(fast)/10000)
    fmt.Printf("Medium:        %d (%.2f%%)\n", medium, float64(medium)/10000)
    fmt.Printf("Slow (resize): %d (%.2f%%)\n", slow, float64(slow)/10000)

    // Output shows ~99.9% fast, ~0.1% slow (resize events)
    // But AVERAGE is still O(1) because resizes are rare
}

// For product manager explanation:
// "In our system, 99.99% of write operations complete in under 1ms.
// About 0.01% take 50-100ms because we're expanding our storage.
// But this expansion means we won't need another resize for a while.
// It's like paying a one-time cost that covers many future operations.
// The average response time across all requests is still under 2ms."

// Mathematical proof:
// - Start with capacity 1
// - Resize at: 1, 2, 4, 8, 16, ..., n elements
// - Resize costs: 1, 2, 4, 8, 16, ..., n (copying elements)
// - Total resize cost: 1 + 2 + 4 + ... + n = 2n - 1 ≈ 2n
// - Total operations: n
// - Amortized cost per operation: 2n/n = 2 = O(1)
```

### Question 5: Analyze Time-Space Trade-offs for a Cache Implementation

**Interview Question:** "You're implementing a cache with LRU eviction. Walk me through the complexity trade-offs of different approaches."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│               TIME-SPACE TRADE-OFF ANALYSIS FRAMEWORK                   │
├─────────────────────────────────────────────────────────────────────────┤
│  STEP 1: Identify Operations                                            │
│  ─────────────────────────                                              │
│  - get(key) → returns value or nil                                      │
│  - put(key, value) → stores and may evict                               │
│  - Eviction must remove LEAST recently used item                        │
│                                                                         │
│  STEP 2: Analyze Each Approach                                          │
│  ───────────────────────────                                            │
│                                                                         │
│  Approach A: Array + Linear Search                                      │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ get: O(n) - scan to find key                                   │     │
│  │ put: O(n) - scan for existing, then update/insert              │     │
│  │ evict: O(1) - always at front                                  │     │
│  │ space: O(n) - just the array                                   │     │
│  │ VERDICT: Simple but slow for large caches                      │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  Approach B: HashMap + Doubly Linked List                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ get: O(1) - hash lookup + list move                            │     │
│  │ put: O(1) - hash insert + list prepend                         │     │
│  │ evict: O(1) - remove tail of list                              │     │
│  │ space: O(n) - but 2x memory (hash + list)                      │     │
│  │ VERDICT: Fast but uses more memory                             │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  Approach C: Ordered Map (TreeMap)                                      │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ get: O(log n) - tree lookup                                    │     │
│  │ put: O(log n) - tree insert                                    │     │
│  │ evict: O(log n) - find min timestamp                           │     │
│  │ space: O(n) - tree nodes                                       │     │
│  │ VERDICT: Balanced but not optimal                              │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  STEP 3: Make Recommendation                                            │
│  ─────────────────────────────                                          │
│  - For production caches: Approach B (HashMap + LinkedList)             │
│  - Trade 2x memory for O(1) all operations                              │
│  - Memcached and most in-process LRU caches use this design             │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Implementation with Complexity Analysis:**

```go
package cache

import "container/list"

// LRUCache implements O(1) get and put with LRU eviction
// Space: O(capacity) for map + O(capacity) for list = O(2 * capacity) = O(n)
type LRUCache struct {
    capacity int
    cache    map[int]*list.Element  // O(n) space
    lru      *list.List              // O(n) space
}

type entry struct {
    key   int
    value int
}

// NewLRUCache creates cache with given capacity
// Time: O(1), Space: O(capacity)
func NewLRUCache(capacity int) *LRUCache {
    return &LRUCache{
        capacity: capacity,
        cache:    make(map[int]*list.Element, capacity),
        lru:      list.New(),
    }
}

// Get returns value and marks as recently used
// Time: O(1) - hash lookup + list move (both constant)
func (c *LRUCache) Get(key int) (int, bool) {
    elem, exists := c.cache[key]  // O(1) hash lookup
    if !exists {
        return 0, false
    }

    // Move to front - O(1) for doubly-linked list
    c.lru.MoveToFront(elem)

    return elem.Value.(*entry).value, true
}

// Put inserts or updates value, evicting LRU if at capacity
// Time: O(1) - all operations are constant
func (c *LRUCache) Put(key, value int) {
    // Case 1: Key exists - update and move to front
    if elem, exists := c.cache[key]; exists {
        elem.Value.(*entry).value = value  // O(1)
        c.lru.MoveToFront(elem)            // O(1)
        return
    }

    // Case 2: At capacity - evict LRU (tail of list)
    if len(c.cache) >= c.capacity {
        oldest := c.lru.Back()          // O(1) - access tail
        if oldest != nil {
            delete(c.cache, oldest.Value.(*entry).key)  // O(1) hash delete
            c.lru.Remove(oldest)                        // O(1) list remove
        }
    }

    // Case 3: Insert new entry at front
    elem := c.lru.PushFront(&entry{key, value})  // O(1)
    c.cache[key] = elem                           // O(1)
}

// Complexity Summary:
// ┌──────────────┬──────────┬───────────────────────────────────┐
// │ Operation    │ Time     │ Why                               │
// ├──────────────┼──────────┼───────────────────────────────────┤
// │ Get          │ O(1)     │ Hash lookup + list MoveToFront    │
// │ Put (update) │ O(1)     │ Hash lookup + value update        │
// │ Put (insert) │ O(1)     │ Hash insert + list PushFront      │
// │ Put (evict)  │ O(1)     │ Hash delete + list Remove tail    │
// │ Space        │ O(n)     │ 2n pointers + n key-value pairs   │
// └──────────────┴──────────┴───────────────────────────────────┘
```

### Question 6: Master Theorem and Recurrence Relations

**Interview Question:** "Given a divide-and-conquer algorithm with recurrence T(n) = 3T(n/4) + O(n), what's the time complexity and how did you derive it?"

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MASTER THEOREM FRAMEWORK                             │
├─────────────────────────────────────────────────────────────────────────┤
│  STEP 1: Identify Parameters                                            │
│  ─────────────────────────────                                          │
│  Standard form: T(n) = aT(n/b) + f(n)                                   │
│                                                                         │
│  For T(n) = 3T(n/4) + O(n):                                             │
│  - a = 3 (number of subproblems)                                        │
│  - b = 4 (factor by which n is divided)                                 │
│  - f(n) = n (work at each level outside recursion)                      │
│                                                                         │
│  STEP 2: Calculate Critical Value                                       │
│  ─────────────────────────────────                                      │
│  c_crit = log_b(a) = log_4(3) ≈ 0.79                                    │
│                                                                         │
│  STEP 3: Compare f(n) with n^c_crit                                     │
│  ──────────────────────────────────                                     │
│  f(n) = n = n^1                                                         │
│  n^c_crit = n^0.79                                                      │
│                                                                         │
│  Since 1 > 0.79, f(n) grows FASTER than n^c_crit                        │
│  This is Case 3 of Master Theorem                                       │
│                                                                         │
│  STEP 4: Verify Regularity Condition                                    │
│  ────────────────────────────────────                                   │
│  Need: af(n/b) ≤ cf(n) for some c < 1                                   │
│  3 * (n/4) = 3n/4 ≤ cn where c = 3/4 < 1 ✓                              │
│                                                                         │
│  STEP 5: State Result                                                   │
│  ─────────────────────                                                  │
│  T(n) = Θ(f(n)) = Θ(n)                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer with Code:**

```go
package main

import "fmt"

// DivideConquer demonstrates T(n) = 3T(n/4) + O(n)
// This is common in algorithms like Karatsuba multiplication variants
func DivideConquer(arr []int) int {
    return divideConquerHelper(arr, 0, len(arr)-1)
}

func divideConquerHelper(arr []int, left, right int) int {
    // Base case
    if left >= right {
        if left == right {
            return arr[left]
        }
        return 0
    }

    n := right - left + 1
    quarter := n / 4

    // Three subproblems of size n/4 each
    // T(n) = 3T(n/4) + ...
    result1 := divideConquerHelper(arr, left, left+quarter-1)
    result2 := divideConquerHelper(arr, left+quarter, left+2*quarter-1)
    result3 := divideConquerHelper(arr, left+2*quarter, left+3*quarter-1)

    // O(n) work at this level (linear scan)
    // ... + O(n)
    linearWork := 0
    for i := left; i <= right; i++ {
        linearWork += arr[i]
    }

    return result1 + result2 + result3 + linearWork
}

// Master Theorem Cases Reference:
//
// T(n) = aT(n/b) + f(n)
// Let c_crit = log_b(a)
//
// Case 1: f(n) = O(n^c) where c < c_crit
//         → T(n) = Θ(n^c_crit)
//         Example: T(n) = 2T(n/2) + 1 → Θ(n)
//
// Case 2: f(n) = Θ(n^c_crit * log^k(n))
//         → T(n) = Θ(n^c_crit * log^(k+1)(n))
//         Example: T(n) = 2T(n/2) + n → Θ(n log n)
//
// Case 3: f(n) = Ω(n^c) where c > c_crit, plus regularity
//         → T(n) = Θ(f(n))
//         Example: T(n) = 2T(n/2) + n² → Θ(n²)

// Common Algorithm Recurrences:
// ┌────────────────────┬────────────────────┬──────────────┐
// │ Algorithm          │ Recurrence         │ Complexity   │
// ├────────────────────┼────────────────────┼──────────────┤
// │ Binary Search      │ T(n) = T(n/2) + 1  │ O(log n)     │
// │ Merge Sort         │ T(n) = 2T(n/2) + n │ O(n log n)   │
// │ Karatsuba Multiply │ T(n) = 3T(n/2) + n │ O(n^1.58)    │
// │ Strassen Matrix    │ T(n) = 7T(n/2)+n²  │ O(n^2.81)    │
// │ QuickSelect (avg)  │ T(n) = T(n/2) + n  │ O(n)         │
// └────────────────────┴────────────────────┴──────────────┘
```

### Question 7: Complexity of Recursive Algorithms with Multiple Branches

**Interview Question:** "What's the time complexity of generating all subsets of a set? Walk me through the analysis."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              SUBSET GENERATION COMPLEXITY ANALYSIS                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  APPROACH 1: Counting Subsets                                           │
│  ────────────────────────────                                           │
│  - Set with n elements has 2^n subsets                                  │
│  - Each subset must be generated → Ω(2^n) lower bound                   │
│  - Therefore, ANY algorithm is at least O(2^n)                          │
│                                                                         │
│  APPROACH 2: Recursion Tree Analysis                                    │
│  ─────────────────────────────────                                      │
│                       root                                              │
│                      /    \                                             │
│              include a₁   exclude a₁                                    │
│                 /  \        /   \                                       │
│            inc a₂ exc a₂ inc a₂ exc a₂                                  │
│              ...    ...   ...    ...                                    │
│                                                                         │
│  - Depth: n (one decision per element)                                  │
│  - Branching factor: 2 (include or exclude)                             │
│  - Total nodes: 2^0 + 2^1 + ... + 2^n = 2^(n+1) - 1 ≈ 2^n               │
│                                                                         │
│  APPROACH 3: Work Per Node                                              │
│  ──────────────────────────                                             │
│  - Each leaf: copy current subset O(n) in worst case                    │
│  - 2^n leaves × O(n) copy = O(n × 2^n)                                  │
│                                                                         │
│  FINAL ANSWER:                                                          │
│  Time: O(n × 2^n)                                                       │
│  Space: O(n) recursion depth + O(n × 2^n) for storing all subsets       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Implementation:**

```go
package main

// Subsets generates all subsets of input slice
// Time: O(n × 2^n) - 2^n subsets, each up to n elements to copy
// Space: O(n × 2^n) - storing all subsets
func Subsets(nums []int) [][]int {
    result := [][]int{}
    generateSubsets(nums, 0, []int{}, &result)
    return result
}

func generateSubsets(nums []int, index int, current []int, result *[][]int) {
    // Base case: processed all elements
    if index == len(nums) {
        // Copy current subset - O(len(current)) ≤ O(n)
        subset := make([]int, len(current))
        copy(subset, current)
        *result = append(*result, subset)
        return
    }

    // Branch 1: Exclude current element
    generateSubsets(nums, index+1, current, result)

    // Branch 2: Include current element
    generateSubsets(nums, index+1, append(current, nums[index]), result)
}

// Iterative approach - same complexity but different style
// Time: O(n × 2^n), Space: O(n × 2^n)
func SubsetsIterative(nums []int) [][]int {
    result := [][]int{{}}  // Start with empty subset

    for _, num := range nums {  // O(n) outer iterations
        // For each existing subset, create new subset with num
        newSubsets := [][]int{}
        for _, subset := range result {  // O(2^i) subsets at iteration i
            // Copy and append - O(size of subset)
            newSubset := make([]int, len(subset)+1)
            copy(newSubset, subset)
            newSubset[len(subset)] = num
            newSubsets = append(newSubsets, newSubset)
        }
        result = append(result, newSubsets...)
    }
    // Total work: Σ(i=0 to n) 2^i × i ≈ O(n × 2^n)

    return result
}

// Bit manipulation approach - same complexity, constant factor differences
// Time: O(n × 2^n), Space: O(n × 2^n)
func SubsetsBitmask(nums []int) [][]int {
    n := len(nums)
    totalSubsets := 1 << n  // 2^n
    result := make([][]int, 0, totalSubsets)

    // Iterate through all 2^n possible masks
    for mask := 0; mask < totalSubsets; mask++ {  // O(2^n)
        subset := []int{}
        for i := 0; i < n; i++ {  // O(n)
            if mask&(1<<i) != 0 {
                subset = append(subset, nums[i])
            }
        }
        result = append(result, subset)
    }
    // Total: O(n × 2^n)

    return result
}

// Complexity comparison of exponential algorithms:
// ┌──────────────────┬───────────────┬────────────────────────────┐
// │ Problem          │ Complexity    │ Why                        │
// ├──────────────────┼───────────────┼────────────────────────────┤
// │ All subsets      │ O(n × 2^n)    │ 2^n subsets, copy O(n)     │
// │ All permutations │ O(n × n!)     │ n! permutations, copy O(n) │
// │ Naive Fibonacci  │ O(2^n)        │ Binary tree of depth n     │
// │ TSP brute force  │ O(n! × n)     │ n! routes, each length n   │
// │ N-Queens         │ O(n!)         │ Worst case all placements  │
// └──────────────────┴───────────────┴────────────────────────────┘
```

### Junior → FAANG: Applying Frameworks Under Interview Pressure

The frameworks in this section (amortized analysis explanation, time-space trade-off, Master Theorem, subset complexity) are valuable precisely because they give you a structured answer format when your brain is under stress. Instead of staring at a blank whiteboard, you run the framework: identify parameters, apply the formula, state the result, verify with a regularity check.

For the Master Theorem, commit the three cases to memory with concrete examples. Case 1 is tree-dominated: work at the bottom exceeds work at each level. Case 2 is balanced: work at every level is equal. Case 3 is root-dominated: work at the top level exceeds the recursive work combined. Practice applying the theorem to five or six recurrences until the identification of a, b, and the critical exponent is reflexive.

For the LRU cache design, the combination of a hash map and a doubly-linked list is the canonical O(1) solution. Know it cold, including how the map stores a pointer to the list node so eviction and deletion are O(1) unlinks. This design appears in senior interviews, system design rounds, and practical Go coding challenges.

### Senior @ FAANG: Master Theorem as a Design Tool

Senior engineers use the Master Theorem not just to analyze existing algorithms but to guide design decisions. When a distributed MapReduce job has the recurrence T(n) = kT(n/k) + O(n) where k is the number of workers, the Master Theorem immediately gives O(n log n) total work, which is the same asymptotic class as a serial merge sort. The practical implication is that adding more workers provides constant-factor speedup but does not change the asymptotic complexity. If the problem requires sub-linear total work, a different algorithm is needed, not more workers.

For the LRU cache, the advanced interview question is how to scale this to a distributed cache serving millions of requests per second. The O(1) per-node operations are fine, but the linked list becomes a bottleneck under concurrent access because any modification requires exclusive locking. Redis addresses this with a sampled, approximate LRU that avoids maintaining a strict recency list, accepting a small probability of evicting a recently used item in exchange for cheaper bookkeeping. Understanding this trade-off requires knowing both the theoretical O(1) solution and its practical limitations.

Subset generation at O(n times 2 to the n) is an example of an algorithm that is optimal in theory but impractical beyond small n values. For n=30, the output size alone is 30 times 1 billion elements. Production systems that need to explore combinatorial spaces use branch-and-bound, heuristic search, or approximate methods rather than exhaustive enumeration. A staff engineer is expected to recognize when an exact algorithm is theoretically correct but practically infeasible, and to propose an approximate alternative with quantified accuracy guarantees.

---
