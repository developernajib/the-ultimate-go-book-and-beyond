## 76.9 Interview Questions

### Question 1: Single Number II (Elements appear 3 times except one)

This classic problem exploits the fact that if every element appears three times, the sum of bits at each position is divisible by three, so any remainder identifies the unique element's bits. The optimized approach uses two variables, `ones` and `twos`, as accumulators that track bits seen once and twice respectively, automatically resetting when a count reaches three.

```go
import "math/bits"

// Given an array where every element appears 3 times except one,
// find the element that appears only once.

func singleNumber(nums []int) int {
    // For each bit position, if the count of set bits is not divisible by 3,
    // that bit belongs to the single number.
    //
    // Loop to bits.UintSize, not to a hardcoded 32. LeetCode's values fit in
    // int32 but may be NEGATIVE, and Go's int is 64-bit, so stopping at 32
    // reads only the lower half of a negative value's two's complement form and
    // rebuilds it as a large positive number: [-467, 793, 793, 793] returns
    // 4294966829 instead of -467.
    result := 0
    for i := 0; i < bits.UintSize; i++ {
        bitSum := 0
        for _, num := range nums {
            bitSum += (num >> i) & 1
        }
        if bitSum%3 != 0 {
            result |= 1 << i
        }
    }
    return result
}

// Alternative: a two-variable state machine.
//
// This version has no width dependency at all, which is the real reason to
// prefer it. It never names a bit position, so it cannot be wrong about how
// many there are, and it handles negative inputs without special care.
func singleNumberOptimized(nums []int) int {
    // ones: bits seen once (mod 3), twos: bits seen twice (mod 3).
    // A bit reaching its third occurrence is cleared from both.
    // Go spells bitwise NOT as unary ^, so ^twos is what C writes as ~twos.
    ones, twos := 0, 0

    for _, num := range nums {
        ones = (ones ^ num) & ^twos
        twos = (twos ^ num) & ^ones
    }

    return ones
}
```

### Question 2: Maximum XOR of Two Numbers in Array

To maximize XOR between two numbers, you want each bit in the result to be 1, which means choosing numbers whose bits differ at as many high-order positions as possible. A binary trie encodes all numbers from their most significant bit downward, allowing a greedy traversal that always attempts to follow the opposite bit path, guaranteeing the highest achievable XOR in O(32n) time.

```go
// Find the maximum XOR of any two numbers in the array

type TrieNode struct {
    children [2]*TrieNode
}

func findMaximumXOR(nums []int) int {
    if len(nums) < 2 {
        return 0
    }

    // Build trie of binary representations
    root := &TrieNode{}

    // Insert number into trie (MSB to LSB)
    insert := func(num int) {
        node := root
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            if node.children[bit] == nil {
                node.children[bit] = &TrieNode{}
            }
            node = node.children[bit]
        }
    }

    // Find max XOR with existing numbers
    findMaxXOR := func(num int) int {
        node := root
        xor := 0
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            // Try to go opposite direction for max XOR
            oppositeBit := 1 - bit
            if node.children[oppositeBit] != nil {
                xor |= 1 << i
                node = node.children[oppositeBit]
            } else {
                node = node.children[bit]
            }
        }
        return xor
    }

    maxXOR := 0
    for i, num := range nums {
        if i > 0 {
            xor := findMaxXOR(num)
            if xor > maxXOR {
                maxXOR = xor
            }
        }
        insert(num)
    }

    return maxXOR
}
```

### Question 3: Bitwise AND of Numbers Range

The bitwise AND of a contiguous range zeroes out every bit that flips anywhere within that range, so only the common prefix shared by both endpoints survives. The right-shift approach strips bits from both ends until they are equal, then restores the shared prefix by shifting left by the count of removed bits.

```go
// Given range [left, right], find bitwise AND of all numbers in range

func rangeBitwiseAnd(left int, right int) int {
    // The result is the common prefix of left and right
    // because any differing bit will have both 0 and 1 in the range

    shift := 0
    for left < right {
        left >>= 1
        right >>= 1
        shift++
    }
    return left << shift
}

// Alternative: Brian Kernighan's approach
func rangeBitwiseAndBK(left int, right int) int {
    for right > left {
        // Clear rightmost set bit of right
        right &= right - 1
    }
    return right
}
```

### Question 4: Reverse Bits

The straightforward bit-by-bit approach shifts bits off `num` one at a time and appends each to `result` from the other direction, completing in exactly 32 iterations. The divide-and-conquer variant achieves the same result in O(log 32) steps by swapping increasingly large bit groups using carefully chosen bitmasks, making it ideal for repeated calls where caching can amortize the constant cost.

```go
// Reverse bits of a 32-bit unsigned integer

func reverseBits(num uint32) uint32 {
    // Method 1: Bit by bit
    var result uint32
    for i := 0; i < 32; i++ {
        result = (result << 1) | (num & 1)
        num >>= 1
    }
    return result
}

// Method 2: Divide and conquer
func reverseBitsFast(num uint32) uint32 {
    // Swap odd and even bits
    num = ((num & 0xAAAAAAAA) >> 1) | ((num & 0x55555555) << 1)
    // Swap consecutive pairs
    num = ((num & 0xCCCCCCCC) >> 2) | ((num & 0x33333333) << 2)
    // Swap nibbles
    num = ((num & 0xF0F0F0F0) >> 4) | ((num & 0x0F0F0F0F) << 4)
    // Swap bytes
    num = ((num & 0xFF00FF00) >> 8) | ((num & 0x00FF00FF) << 8)
    // Swap 2-byte pairs
    num = (num >> 16) | (num << 16)
    return num
}
```

### Question 5: Counting Bits for All Numbers

Both dynamic programming approaches avoid recomputing bit counts from scratch by relating each number to a smaller one already solved. The right-shift recurrence `result[i] = result[i>>1] + (i&1)` uses the fact that shifting right by one is equivalent to removing the least significant bit, while the `i & (i-1)` variant leverages Brian Kernighan's trick to refer to the value with the lowest set bit already cleared.

```go
// For every number from 0 to n, count the number of 1's in binary

func countBits(n int) []int {
    result := make([]int, n+1)

    // DP: result[i] = result[i>>1] + (i&1)
    // i>>1 removes last bit, i&1 checks if last bit is 1
    for i := 1; i <= n; i++ {
        result[i] = result[i>>1] + (i & 1)
    }

    return result
}

// Alternative: Using i & (i-1)
func countBitsAlt(n int) []int {
    result := make([]int, n+1)

    // result[i] = result[i & (i-1)] + 1
    // i & (i-1) clears lowest set bit
    for i := 1; i <= n; i++ {
        result[i] = result[i&(i-1)] + 1
    }

    return result
}
```

### Question 6: Minimum Flips to Make a OR b Equal to c

**Problem**: Given three positive numbers a, b, c, return the minimum number of flips required in some bits of a and b to make (a OR b == c).

```
┌─────────────────────────────────────────────────────────────────┐
│           BIT FLIP DECISION FRAMEWORK                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  For each bit position i, analyze:                              │
│                                                                 │
│  Target c[i] = 0:                                               │
│    • Both a[i] and b[i] must be 0                               │
│    • Flips needed = a[i] + b[i] (count 1s)                      │
│                                                                 │
│  Target c[i] = 1:                                               │
│    • At least one of a[i] or b[i] must be 1                     │
│    • If a[i] | b[i] = 0, need 1 flip                            │
│    • If a[i] | b[i] = 1, need 0 flips                           │
│                                                                 │
│  Example: a=2 (010), b=6 (110), c=5 (101)                       │
│  Bit 0: c=1, a|b=0 → 1 flip                                     │
│  Bit 1: c=0, a|b=1 → 2 flips (both are 1)                       │
│  Bit 2: c=1, a|b=1 → 0 flips                                    │
│  Total: 3 flips                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 1318: Minimum Flips to Make a OR b Equal to c
// Time: O(32) = O(1), Space: O(1)
func minFlips(a int, b int, c int) int {
    flips := 0

    for i := 0; i < 32; i++ {
        bitA := (a >> i) & 1
        bitB := (b >> i) & 1
        bitC := (c >> i) & 1

        if bitC == 0 {
            // Both bits must be 0
            flips += bitA + bitB
        } else {
            // At least one bit must be 1
            if bitA|bitB == 0 {
                flips++
            }
        }
    }

    return flips
}

// Optimized using bit manipulation
func minFlipsOptimized(a int, b int, c int) int {
    // Bits where (a|b) differs from c
    diff := (a | b) ^ c

    // Bits where both a and b are 1, but c is 0
    // These need 2 flips each
    extraFlips := a & b & diff

    return popcount(diff) + popcount(extraFlips)
}

// popcount wraps the standard library. Brian Kernighan's n &= n-1 loop is the
// thing to be able to derive on a whiteboard, and bits.OnesCount is the thing
// to ship: it lowers to a POPCNT instruction where the target supports one.
// Note the uint conversion, which is required because OnesCount takes a uint
// and is also the honest way to say that popcount of a negative int means the
// count over its two's complement representation.
func popcount(n int) int {
    return bits.OnesCount(uint(n))
}
```

**Framework for Explaining**:
1. Identify what each bit in c tells us about required state
2. For c[i]=0, both a and b must have 0 → count existing 1s
3. For c[i]=1, need at least one 1 → check if neither has 1
4. Optimize by recognizing patterns: (a|b)^c finds all different bits

---

### Question 7: Maximum Length of a Concatenated String with Unique Characters

**Problem**: Given an array of strings, find the maximum length of a concatenation with all unique characters. Use bitmask to track character sets.

```
┌─────────────────────────────────────────────────────────────────┐
│           BITMASK CHARACTER SET FRAMEWORK                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Represent each string as a 26-bit integer:                     │
│    "abc" → 00000000000000000000000111 (bits 0,1,2 set)          │
│    "xyz" → 11100000000000000000000000 (bits 23,24,25 set)       │
│                                                                 │
│  Operations:                                                    │
│  • Check overlap: (mask1 & mask2) != 0                          │
│  • Combine sets: mask1 | mask2                                  │
│  • Count chars: popcount(mask)                                  │
│  • Check valid string: popcount(mask) == len(str)               │
│                                                                 │
│  Algorithm (backtracking with bitmask):                         │
│  1. Convert all valid strings to masks                          │
│  2. For each string, try including or excluding                 │
│  3. Include only if no overlap with current mask                │
│  4. Track maximum popcount                                      │
│                                                                 │
│  Why bitmask? O(1) overlap check vs O(26) with sets             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 1239: Maximum Length of Concatenated String with Unique Characters
// Time: O(2^n * 26), Space: O(n)
func maxLength(arr []string) int {
    // Convert strings to masks, filter invalid ones
    masks := make([]int, 0)
    for _, s := range arr {
        mask := stringToMask(s)
        if mask != -1 { // Valid string (no duplicates)
            masks = append(masks, mask)
        }
    }

    maxLen := 0
    var backtrack func(idx, currentMask int)

    backtrack = func(idx, currentMask int) {
        // Update max length
        if count := popcount26(currentMask); count > maxLen {
            maxLen = count
        }

        for i := idx; i < len(masks); i++ {
            // Check for overlap
            if currentMask&masks[i] == 0 {
                // No overlap, include this string
                backtrack(i+1, currentMask|masks[i])
            }
        }
    }

    backtrack(0, 0)
    return maxLen
}

func stringToMask(s string) int {
    mask := 0
    for _, c := range s {
        bit := 1 << (c - 'a')
        if mask&bit != 0 {
            return -1 // Duplicate character
        }
        mask |= bit
    }
    return mask
}

// popcount26 counts characters in a 26-bit alphabet mask.
// Same standard library call as popcount above. The distinct name only records
// that the mask is expected to occupy the low 26 bits.
func popcount26(n int) int {
    return bits.OnesCount(uint(n))
}

// Alternative: Iterative DP approach
func maxLengthDP(arr []string) int {
    // Track all valid combinations as masks
    dp := []int{0} // Start with empty set
    maxLen := 0

    for _, s := range arr {
        mask := stringToMask(s)
        if mask == -1 {
            continue
        }

        // Try combining with all existing combinations
        newCombos := make([]int, 0)
        for _, existing := range dp {
            if existing&mask == 0 {
                combined := existing | mask
                newCombos = append(newCombos, combined)
                if count := popcount26(combined); count > maxLen {
                    maxLen = count
                }
            }
        }
        dp = append(dp, newCombos...)
    }

    return maxLen
}
```

**Interview Tips**:
- Start by explaining the bitmask representation
- Discuss why bitmask is better than HashSet for this problem
- Mention the backtracking vs DP tradeoffs
- Time complexity: O(2^n) in worst case, but pruning helps significantly

---

### Question 8: Find Two Non-overlapping Sub-arrays with Target Sum

**Problem**: Given an array and target, find two non-overlapping subarrays each with sum equal to target. Return minimum sum of their lengths.

```
┌─────────────────────────────────────────────────────────────────┐
│           TWO NON-OVERLAPPING SUBARRAYS FRAMEWORK               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  While not pure bit manipulation, uses similar thinking:        │
│  - Track "best so far" as you scan (like prefix operations)     │
│  - Combine with current window (like combining masks)           │
│                                                                 │
│  Algorithm:                                                     │
│  1. Use sliding window to find all subarrays with target sum    │
│  2. For each position i, track:                                 │
│     - minLeft[i]: minimum length ending at or before i          │
│     - current window length if ends at i                        │
│  3. For each valid window ending at i:                          │
│     - Answer = min(answer, windowLen + minLeft[windowStart-1])  │
│                                                                 │
│  Connection to bits: This "combine two non-overlapping" pattern │
│  appears in many bitmask DP problems (e.g., partition into      │
│  k subsets, parallel job scheduling)                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 1477: Find Two Non-overlapping Sub-arrays Each With Target Sum
// Time: O(n), Space: O(n)
func minSumOfLengths(arr []int, target int) int {
    n := len(arr)
    minLeft := make([]int, n)
    for i := range minLeft {
        minLeft[i] = n + 1 // Impossible length
    }

    result := n + 1
    windowSum := 0
    left := 0
    minSoFar := n + 1

    for right := 0; right < n; right++ {
        windowSum += arr[right]

        // Shrink window if sum exceeds target
        for windowSum > target && left <= right {
            windowSum -= arr[left]
            left++
        }

        if windowSum == target {
            windowLen := right - left + 1

            // Try to combine with best subarray ending before this window
            if left > 0 && minLeft[left-1] < n+1 {
                if windowLen+minLeft[left-1] < result {
                    result = windowLen + minLeft[left-1]
                }
            }

            // Update minimum so far
            if windowLen < minSoFar {
                minSoFar = windowLen
            }
        }

        minLeft[right] = minSoFar
    }

    if result > n {
        return -1
    }
    return result
}
```

---

### Question 9: Bitmask DP for Shortest Path Visiting All Nodes

**Problem**: Find the shortest path that visits every node in an undirected graph. Can revisit nodes and edges.

```
┌─────────────────────────────────────────────────────────────────┐
│           BITMASK BFS FRAMEWORK (TSP VARIANT)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  State: (current_node, visited_mask)                            │
│  • visited_mask: n-bit integer where bit i = 1 if node i visited│
│  • Total states: n * 2^n                                        │
│                                                                 │
│  BFS from all nodes simultaneously:                             │
│  • Start: all (i, 1<<i) with distance 0                         │
│  • Target: any state where mask = (1<<n) - 1 (all bits set)     │
│  • Transitions: (node, mask) → (neighbor, mask | (1<<neighbor)) │
│                                                                 │
│  Why BFS not Dijkstra? All edges have weight 1.                 │
│  Why start from all nodes? Don't know optimal starting point.   │
│                                                                 │
│  Example: n=4, graph = [[1,2,3],[0],[0],[0]]                    │
│  Start: (0,0001), (1,0010), (2,0100), (3,1000)                  │
│  Target: any (*, 1111)                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
import "container/heap"

// LeetCode 847: Shortest Path Visiting All Nodes
// Time: O(n * 2^n), Space: O(n * 2^n)
func shortestPathLength(graph [][]int) int {
    n := len(graph)
    if n == 1 {
        return 0
    }

    // State: (node, visited_mask). Declared locally, so it is independent of
    // the package-level State used by the A* variant below.
    type bfsState struct {
        node int
        mask int
    }

    // Target: all nodes visited
    fullMask := (1 << n) - 1

    // BFS queue and visited set
    queue := make([]bfsState, 0)
    visited := make(map[bfsState]bool)

    // Start BFS from every node
    for i := 0; i < n; i++ {
        state := bfsState{node: i, mask: 1 << i}
        queue = append(queue, state)
        visited[state] = true
    }

    distance := 0
    for len(queue) > 0 {
        size := len(queue)
        for i := 0; i < size; i++ {
            current := queue[0]
            queue = queue[1:]

            // Check if all nodes visited
            if current.mask == fullMask {
                return distance
            }

            // Explore neighbors
            for _, neighbor := range graph[current.node] {
                newMask := current.mask | (1 << neighbor)
                newState := bfsState{node: neighbor, mask: newMask}

                if !visited[newState] {
                    visited[newState] = true
                    queue = append(queue, newState)
                }
            }
        }
        distance++
    }

    return -1 // Should never reach here for connected graph
}

// State is the A* search node. It must be declared at package scope, not inside
// the function, because PriorityQueue below refers to it.
type State struct {
    node     int
    mask     int
    priority int // distance + heuristic
}

// PriorityQueue is a min-heap of *State ordered by priority. container/heap
// supplies the algorithms, but you must supply the five methods: it is an
// interface, not a container. Push/Pop operate on the slice's tail. The heap
// package handles the sifting, so Pop must NOT return the smallest element
// itself, only the last one.
type PriorityQueue []*State

func (pq PriorityQueue) Len() int            { return len(pq) }
func (pq PriorityQueue) Less(i, j int) bool  { return pq[i].priority < pq[j].priority }
func (pq PriorityQueue) Swap(i, j int)       { pq[i], pq[j] = pq[j], pq[i] }
func (pq *PriorityQueue) Push(x any)         { *pq = append(*pq, x.(*State)) }
func (pq *PriorityQueue) Pop() any {
    old := *pq
    n := len(old)
    item := old[n-1]
    old[n-1] = nil // Avoid holding the pointer alive.
    *pq = old[:n-1]
    return item
}

// A* optimization with an admissible heuristic.
//
// The heuristic is the number of still-unvisited nodes. It is admissible
// (never overestimates) because visiting k more nodes needs at least k more
// edges, so A* is guaranteed to return the same answer as the BFS above.
// Whether it is FASTER is a different question and depends on the graph. For
// LeetCode 847's small n, the plain BFS is usually the better answer in an
// interview, and this version mostly demonstrates that you know why the
// heuristic is admissible.
func shortestPathLengthAStar(graph [][]int) int {
    n := len(graph)
    if n == 1 {
        return 0
    }

    fullMask := (1 << n) - 1

    // Priority queue (min-heap)
    pq := &PriorityQueue{}
    heap.Init(pq)

    dist := make(map[[2]int]int)

    // Start from all nodes
    for i := 0; i < n; i++ {
        mask := 1 << i
        heuristic := popcount(fullMask ^ mask) // Unvisited nodes
        heap.Push(pq, &State{node: i, mask: mask, priority: heuristic})
        dist[[2]int{i, mask}] = 0
    }

    for pq.Len() > 0 {
        current := heap.Pop(pq).(*State)

        key := [2]int{current.node, current.mask}
        if d, ok := dist[key]; ok && current.priority-popcount(fullMask^current.mask) > d {
            continue
        }

        if current.mask == fullMask {
            return dist[key]
        }

        for _, neighbor := range graph[current.node] {
            newMask := current.mask | (1 << neighbor)
            newDist := dist[key] + 1
            newKey := [2]int{neighbor, newMask}

            if d, ok := dist[newKey]; !ok || newDist < d {
                dist[newKey] = newDist
                heuristic := popcount(fullMask ^ newMask)
                heap.Push(pq, &State{
                    node:     neighbor,
                    mask:     newMask,
                    priority: newDist + heuristic,
                })
            }
        }
    }

    return -1
}
```

**Key Interview Points**:
1. Explain why we need a bitmask: traditional BFS tracks only which nodes were visited overall, not which set of nodes a given path has covered
2. State space analysis: O(n × 2^n) states
3. Why start from all nodes: the optimal starting point is not known in advance
4. Optimization with A* heuristic (unvisited node count)
5. Connection to TSP: this is essentially TSP with unit edge weights, except that revisiting nodes is allowed, so it is a shortest walk rather than a Hamiltonian path

### Junior -> FAANG: Structuring Your Thinking in Interview Questions

The nine questions in this section represent the full vocabulary of bit manipulation interview problems. Rather than memorizing solutions, internalize the decision tree: "Does the problem involve finding a unique element? Apply XOR. Does it involve subsets of a small set? Use bitmask enumeration. Does it involve visiting all nodes or cities exactly once? Use bitmask BFS or bitmask DP." Practice stating this decision tree out loud before writing code.

For Question 6 (Minimum Flips to Make a OR b Equal to c), the insight "when target bit is 0, both a and b must be 0" is simple but easy to mis-implement. The optimized version using `(a | b) ^ c` to find all differing bits and `a & b & diff` to find double-flip positions is a clean closed-form expression. Derive it on the whiteboard by working through the case table bit by bit before jumping to the formula.

For Question 9 (Shortest Path Visiting All Nodes), explicitly state the state representation before writing any code: "My state is (current node, set of visited nodes), and the set is represented as an n-bit integer." This framing immediately reveals why BFS with visited-set deduplication is correct and why the time complexity is O(n * 2^n).

### Senior @ FAANG: Bar-Raiser Depth on Each Question Category

For each question category, a bar-raiser interviewer at L6 level has follow-up probes that separate strong candidates from exceptional ones.

For XOR problems (Questions 1, 3): "What if elements can appear any number of times, not just once or three times?" The answer requires shifting from XOR tricks to a general bit-frequency counting approach or a hash map. A strong candidate identifies the constraint and states clearly when the XOR trick generalizes (powers of 2) and when it does not.

For bitmask subset problems (Questions 7, 8): "How does your approach scale if the alphabet grows from 26 letters to 128 ASCII characters?" The bitmask approach breaks at 64 bits. The correct response is a bitset backed by a `[]uint64` slice or a direct hash-set approach. A senior candidate proposes the migration path without being prompted.

For bitmask BFS/DP (Question 9): "In a real distributed system, how would you scale this to n=100 nodes?" The bitmask approach is infeasible at n=100 (2^100 states). The correct answer involves approximation algorithms (nearest neighbor heuristic, Christofides algorithm), or relaxing the problem to allow polynomial-time exact solutions by exploiting graph structure (sparse graphs, planar graphs, tree structure). A staff-level candidate knows which graph classes admit polynomial-time exact solutions and can name at least one (trees via tree DP, bipartite graphs via min-cost matching).

For the Maximum XOR trie (Question 2): "How would you maintain the trie dynamically as elements are inserted and deleted?" Deletion from a binary trie requires reference counting or lazy deletion to avoid leaving empty subtrees that corrupt the greedy traversal. This is a production engineering concern that an L6 candidate should raise proactively.
